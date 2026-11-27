/**
 * `ObjectStore` on the S3 protocol. It uses presigned PUT and GET, and server-side HEAD, ranged GET
 * and DELETE of one object, all signed
 * with AWS Signature Version 4. No SDK: the signature is a few HMACs (node:crypto), and a server must
 * not grow a dependency for it. Changing the provider is changing the settings (config.ts,
 * "The bucket").
 *
 * The secret access key is used to sign and for nothing else. It is in no URL (a signed link carries
 * the key's id and a signature, as the protocol has it), in no error and in no log; it is held in a
 * private field, so printing the store prints none of its settings.
 *
 * What a link to upload is good for: the method, the object and the `Content-Length` are signed, so a
 * link made for 1 MiB uploads 1 MiB to that key or nothing. The body itself is not signed
 * (`UNSIGNED-PAYLOAD`): whoever is given the link is trusted with the content of that one object.
 */

import { createHash, createHmac } from "node:crypto";
import {
	type GetOptions,
	type PutOptions,
	type ObjectStore,
	ObjectStoreError,
	type SignedLink,
	checkKey,
} from "./store.js";

export interface S3Settings {
	/** The store's S3 endpoint, without the bucket: `https://<account>.r2.cloudflarestorage.com`, `https://s3.eu-central-1.amazonaws.com`. */
	endpoint: string;
	/** The region the signature names: `auto` on R2, the bucket's region on AWS. */
	region: string;
	bucket: string;
	accessKeyId: string;
	/** A secret. */
	secretAccessKey: string;
	/** Where the bucket's name goes: in the path (`<endpoint>/<bucket>/<key>`; R2, MinIO, AWS) or in the host (`<bucket>.<endpoint>/<key>`; AWS, and stores that have no path style). */
	style: "path" | "virtual";
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** A link's life is signed in seconds, at least one and at most seven days. */
const MAX_LINK_SECONDS = 7 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hmac = (key: Buffer | string, text: string) => createHmac("sha256", key).update(text).digest();
/** RFC 3986: everything but letters, digits, `-`, `.`, `_` and `~` is percent-encoded, as the signature's rules want it. */
const encode = (text: string) =>
	encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export class S3ObjectStore implements ObjectStore {
	readonly #settings: S3Settings;
	readonly #origin: string;
	readonly #host: string;
	/** What comes before the key in every path: the endpoint's own path, and the bucket in path style. */
	readonly #base: string;
	readonly #now: () => number;
	readonly #fetch: typeof fetch;

	constructor(settings: S3Settings, options: { now?: () => number; fetch?: typeof fetch } = {}) {
		for (const name of ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"] as const) {
			if (typeof settings[name] !== "string" || settings[name].trim() === "")
				throw new Error(`the S3 object store needs ${name}`);
		}
		let url: URL;
		try {
			url = new URL(settings.endpoint);
		} catch {
			// The value is not repeated: an endpoint may carry an account's id.
			throw new Error("the S3 endpoint is not a URL");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:")
			throw new Error("the S3 endpoint must be an http or https URL");
		if (url.username !== "" || url.password !== "" || url.search !== "")
			throw new Error("the S3 endpoint must be an address only: no user, password or query");
		this.#settings = { ...settings };
		// A dashboard may show the endpoint with the bucket behind it; the bucket is named by its own setting.
		let path = url.pathname.replace(/\/+$/, "");
		if (path === `/${settings.bucket}`) path = "";
		const virtual = settings.style === "virtual";
		this.#host = virtual ? `${settings.bucket}.${url.host}` : url.host;
		this.#origin = `${url.protocol}//${this.#host}`;
		this.#base = virtual ? path : `${path}/${encode(settings.bucket)}`;
		this.#now = options.now ?? Date.now;
		this.#fetch = options.fetch ?? fetch;
	}

	async linkToPut(key: string, options: PutOptions): Promise<SignedLink> {
		if (!Number.isSafeInteger(options.size) || options.size < 0) throw new ObjectStoreError("invalid upload size");
		return this.presign("PUT", key, options.ttlMs, {
			"content-length": String(options.size),
			...(options.contentType ? { "content-type": options.contentType } : {}),
		});
	}

	async linkToGet(key: string, options: GetOptions): Promise<SignedLink> {
		const query: Record<string, string> = {};
		if (options.contentType) query["response-content-type"] = options.contentType;
		if (options.disposition) query["response-content-disposition"] = options.disposition;
		return this.presign("GET", key, options.ttlMs, {}, query);
	}

	async readStart(key: string, bytes: number): Promise<Uint8Array | null> {
		if (!Number.isSafeInteger(bytes) || bytes < 1) throw new ObjectStoreError("invalid range size");
		const response = await this.request("GET", key, { range: `bytes=0-${bytes - 1}` });
		if (response.status !== 206 || !response.body) {
			await response.body?.cancel();
			if (response.status === 404) return null;
			throw new ObjectStoreError("the bucket did not return the requested range", response.status);
		}
		const reader = response.body.getReader();
		const prefix = new Uint8Array(bytes);
		let length = 0;
		try {
			while (length < bytes) {
				const chunk = await reader.read();
				if (chunk.done) break;
				const part = chunk.value.subarray(0, bytes - length);
				prefix.set(part, length);
				length += part.length;
			}
		} finally {
			await reader.cancel();
		}
		return prefix.subarray(0, length);
	}

	async size(key: string): Promise<number | null> {
		const response = await this.request("HEAD", key);
		if (response.status === 404) return null;
		if (!response.ok) throw await this.refused("HEAD", response);
		const length = Number(response.headers.get("content-length") ?? NaN);
		if (!Number.isSafeInteger(length) || length < 0)
			throw new ObjectStoreError("the bucket answered HEAD without the object's size", response.status);
		return length;
	}

	async remove(key: string): Promise<void> {
		const response = await this.request("DELETE", key);
		// S3 answers 204 whether or not there was an object; some stores answer 404 for one that is gone.
		if (!response.ok && response.status !== 404) throw await this.refused("DELETE", response);
		await response.arrayBuffer().catch(() => undefined);
	}

	private path(key: string): string {
		return `${this.#base}/${checkKey(key).split("/").map(encode).join("/")}`;
	}

	private signingKey(date: string): Buffer {
		const { secretAccessKey, region } = this.#settings;
		return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"), "aws4_request");
	}

	/** `20261115T101500Z` and its date. */
	private stamp(): { amzDate: string; date: string } {
		const amzDate = new Date(this.#now())
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}Z$/, "Z");
		return { amzDate, date: amzDate.slice(0, 8) };
	}

	/** A URL with the signature in its query. `headers` are signed beside the host: whoever uses the link has to send them as they are. */
	private presign(
		method: "GET" | "PUT",
		key: string,
		ttlMs: number,
		headers: Record<string, string>,
		overrides: Record<string, string> = {},
	): SignedLink {
		const seconds = Math.min(MAX_LINK_SECONDS, Math.max(1, Math.round(ttlMs / 1000)));
		const { amzDate, date } = this.stamp();
		const scope = `${date}/${this.#settings.region}/s3/aws4_request`;
		const signed: Record<string, string> = { host: this.#host, ...headers };
		const names = Object.keys(signed).sort();
		const query = [
			...Object.entries(overrides),
			["X-Amz-Algorithm", ALGORITHM],
			["X-Amz-Credential", `${this.#settings.accessKeyId}/${scope}`],
			["X-Amz-Date", amzDate],
			["X-Amz-Expires", String(seconds)],
			["X-Amz-SignedHeaders", names.join(";")],
		]
			.map(([name, value]) => `${encode(name)}=${encode(value)}`)
			.sort()
			.join("&");
		const path = this.path(key);
		const canonical = [
			method,
			path,
			query,
			names.map(name => `${name}:${signed[name]}\n`).join(""),
			names.join(";"),
			"UNSIGNED-PAYLOAD",
		].join("\n");
		const signature = hmac(this.signingKey(date), [ALGORITHM, amzDate, scope, sha256(canonical)].join("\n")).toString(
			"hex",
		);
		return {
			url: `${this.#origin}${path}?${query}&X-Amz-Signature=${signature}`,
			expiresAt: this.#now() + seconds * 1000,
		};
	}

	/** A request of the server's own, with the signature in its `Authorization` header and no body. */
	private async request(
		method: "HEAD" | "DELETE" | "GET",
		key: string,
		extra: Record<string, string> = {},
	): Promise<Response> {
		const { amzDate, date } = this.stamp();
		const scope = `${date}/${this.#settings.region}/s3/aws4_request`;
		const path = this.path(key);
		const headers: Record<string, string> = {
			...extra,
			host: this.#host,
			"x-amz-content-sha256": EMPTY_SHA256,
			"x-amz-date": amzDate,
		};
		const names = Object.keys(headers).sort();
		const canonical = [
			method,
			path,
			"",
			names.map(name => `${name}:${headers[name]}\n`).join(""),
			names.join(";"),
			EMPTY_SHA256,
		].join("\n");
		const signature = hmac(this.signingKey(date), [ALGORITHM, amzDate, scope, sha256(canonical)].join("\n")).toString(
			"hex",
		);
		try {
			return await this.#fetch(`${this.#origin}${path}`, {
				method,
				headers: {
					...extra,
					"x-amz-content-sha256": EMPTY_SHA256,
					"x-amz-date": amzDate,
					authorization: `${ALGORITHM} Credential=${this.#settings.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				redirect: "error",
			});
		} catch (error) {
			throw new ObjectStoreError(`the bucket could not be reached for ${method} (${networkReason(error)})`);
		}
	}

	/**
	 * What a refusal becomes. Only the status and the store's error code (`AccessDenied`,
	 * `SignatureDoesNotMatch`, ...) are taken from the answer: the rest of an S3 error names the key's
	 * id and the string that was signed.
	 */
	private async refused(method: string, response: Response): Promise<ObjectStoreError> {
		const body = method === "HEAD" ? "" : await response.text().catch(() => "");
		const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(body)?.[1];
		return new ObjectStoreError(
			`the bucket answered ${response.status}${code === undefined ? "" : ` (${code})`} to ${method}`,
			response.status,
		);
	}
}

/** The kind of a network failure, never its text: Node's message for one names the host. */
function networkReason(error: unknown): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
		return "no answer in time";
	const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
	return typeof cause?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : "network error";
}
