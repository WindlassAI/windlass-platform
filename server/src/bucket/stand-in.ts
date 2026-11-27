/**
 * `ObjectStore` without a bucket: objects in memory, or as files in a directory, for the tests and for
 * the fake sandbox layer (sandbox-fake.ts). Never for a deployment: a directory is one machine's.
 *
 * Its links are of its own making (`wlp-stand-in://...`), and nothing but `use` here understands them.
 * They are held to what a real store's links are held to, so code that mixes them up fails here as it
 * would there: one object, one method, a time limit, and for an upload exactly the size it was signed
 * for. `use` answers with the HTTP status a store would give: 200, 403 for a link that is forged, of
 * the other method, expired or of another size, 404 for an object that is not there.
 *
 * With a directory an object is the file `<dir>/<key>`, written whole (a temporary file renamed into
 * place): a test reads, damages or removes it there to play a store that lost or spoiled an object.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type GetOptions,
	type PutOptions,
	type ObjectStore,
	ObjectStoreError,
	type SignedLink,
	checkKey,
} from "./store.js";

const SCHEME = "wlp-stand-in:";

export class StandInObjectStore implements ObjectStore {
	private readonly objects = new Map<string, Buffer>();
	private readonly types = new Map<string, string>();
	private readonly dir: string | null;
	private readonly now: () => number;
	/** Signs this store's links: one made by another store, or made up, opens nothing here. */
	private readonly secret: Buffer;

	constructor(options: { dir?: string; now?: () => number; secret?: Buffer } = {}) {
		this.secret = options.secret ?? randomBytes(32);
		this.dir = options.dir ?? null;
		this.now = options.now ?? Date.now;
		if (this.dir !== null) mkdirSync(this.dir, { recursive: true });
	}

	async linkToPut(key: string, options: PutOptions): Promise<SignedLink> {
		if (!Number.isSafeInteger(options.size) || options.size < 0) throw new ObjectStoreError("invalid upload size");
		return this.link("PUT", key, options.ttlMs, options.size, options.contentType);
	}

	async linkToGet(key: string, options: GetOptions): Promise<SignedLink> {
		return this.link("GET", key, options.ttlMs, null, options.contentType, options.disposition);
	}

	async readStart(key: string, bytes: number): Promise<Uint8Array | null> {
		if (!Number.isSafeInteger(bytes) || bytes < 1) throw new ObjectStoreError("invalid range size");
		return this.read(checkKey(key))?.subarray(0, bytes) ?? null;
	}

	async size(key: string): Promise<number | null> {
		return this.read(checkKey(key))?.length ?? null;
	}

	async remove(key: string): Promise<void> {
		checkKey(key);
		this.types.delete(key);
		if (this.dir === null) this.objects.delete(key);
		else rmSync(join(this.dir, key), { force: true });
	}

	/** What a sandbox does with a link: uploads `body` with it, or downloads. The status is a store's own. */
	use(url: string, method: "PUT", body: Uint8Array, headers?: HeadersInit): { status: number };
	use(url: string, method: "GET"): { status: number; body?: Buffer; headers?: Headers };
	use(
		url: string,
		method: "PUT" | "GET",
		body?: Uint8Array,
		headers?: HeadersInit,
	): { status: number; body?: Buffer; headers?: Headers } {
		let link: URL;
		try {
			link = new URL(url);
		} catch {
			return { status: 403 };
		}
		const key = decodeURIComponent(link.pathname.replace(/^\/+/, ""));
		const expires = Number(link.searchParams.get("expires"));
		const size = link.searchParams.get("size");
		const signature = Buffer.from(link.searchParams.get("signature") ?? "", "hex");
		const type = link.searchParams.get("type") ?? "";
		const disposition = link.searchParams.get("disposition") ?? "";
		const expected = this.sign(link.searchParams.get("method") ?? "", key, expires, size, type, disposition);
		if (link.protocol !== SCHEME || signature.length !== expected.length || !timingSafeEqual(signature, expected))
			return { status: 403 };
		if (link.searchParams.get("method") !== method || !(this.now() < expires)) return { status: 403 };
		if (method === "PUT") {
			if (body === undefined || String(body.length) !== size) return { status: 403 };
			const sent = new Headers(headers).get("content-type") ?? "";
			if (type && sent !== type) return { status: 403 };
			this.types.set(key, sent);
			this.write(key, Buffer.from(body));
			return { status: 200 };
		}
		const found = this.read(key);
		return found === null
			? { status: 404 }
			: {
					status: 200,
					body: found,
					headers: new Headers({
						"content-type": type || this.types.get(key) || "application/octet-stream",
						...(disposition ? { "content-disposition": disposition } : {}),
					}),
				};
	}

	private link(
		method: "PUT" | "GET",
		key: string,
		ttlMs: number,
		size: number | null,
		type = "",
		disposition = "",
	): SignedLink {
		checkKey(key);
		const expiresAt = this.now() + Math.max(1000, Math.round(ttlMs));
		const query = new URLSearchParams({
			method,
			type,
			disposition,
			expires: String(expiresAt),
			...(size === null ? {} : { size: String(size) }),
			signature: this.sign(method, key, expiresAt, size === null ? null : String(size), type, disposition).toString(
				"hex",
			),
		});
		return { url: `${SCHEME}//bucket/${key}?${query.toString()}`, expiresAt };
	}

	private sign(
		method: string,
		key: string,
		expires: number,
		size: string | null,
		type: string,
		disposition: string,
	): Buffer {
		return createHmac("sha256", this.secret)
			.update([method, key, String(expires), size ?? "", type, disposition].join("\n"))
			.digest();
	}

	private read(key: string): Buffer | null {
		if (this.dir === null) return this.objects.get(key) ?? null;
		const file = join(this.dir, key);
		return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
	}

	private write(key: string, bytes: Buffer): void {
		if (this.dir === null) {
			this.objects.set(key, bytes);
			return;
		}
		const file = join(this.dir, key);
		mkdirSync(dirname(file), { recursive: true });
		const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(temporary, bytes);
		renameSync(temporary, file);
	}
}

/** Shared only by the fake provider and its platform-side attachment ledger. */
let deployment: { dir: string; store: StandInObjectStore } | undefined;
export function fakeBucket(): StandInObjectStore | null {
	const dir = process.env.WLP_FAKE_BACKUP_DIR?.trim();
	if (!dir) return null;
	if (deployment?.dir !== dir) {
		const seed = process.env.WLP_FAKE_BUCKET_SIGNING_SECRET;
		deployment = { dir, store: new StandInObjectStore({ dir, secret: seed ? Buffer.from(seed, "hex") : undefined }) };
	}
	return deployment.store;
}
