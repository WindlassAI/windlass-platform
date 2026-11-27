/**
 * Checks of the bucket seam (server/src/bucket/) and of the copies of Windlass's session data that are
 * kept through it (server/src/sandbox/backup.ts). Run with:
 *
 *   cd server && npx tsx ../scripts/backup-check.ts               no network, no Docker: the stand-in, the
 *                                                                 signer against AWS's published example,
 *                                                                 and the backups on a scripted sandbox
 *   cd server && npx tsx ../scripts/backup-check.ts --bucket      and the S3 store against a real bucket
 *   cd server && npx tsx ../scripts/backup-check.ts --bucket --docker
 *                                                                 and the real scripts in real containers
 *                                                                 of the sandbox image, with a real
 *                                                                 Windlass, through that bucket
 *
 * `--bucket` needs the bucket's settings in the environment: the server's own (WLP_BUCKET_ENDPOINT,
 * WLP_BUCKET_NAME, WLP_BUCKET_ACCESS_KEY_ID, WLP_BUCKET_SECRET_ACCESS_KEY; config.ts), or, when those
 * are not set, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. Everything it writes
 * is under a prefix of this run's own (`wlp-check-<random>/`), is removed in `finally`, and the run
 * ends by listing that prefix to show nothing is left. It sends a few dozen small requests.
 *
 * `--docker` runs scripted (demo) turns: Windlass's real engine and real tool calls with a scripted
 * model, so no model is called, no sign-in is needed and no token exists. Each sandbox is a container
 * with a data volume of its own, so a second one is what a sandbox that replaces a lost one is on E2B:
 * a disk that has never seen the session. The containers and volumes carry the label
 * dev.windlass-platform=1 and are removed at the end.
 *
 * Nothing this prints holds a setting of the bucket, a link or a signature: its last check reads its
 * own output for them.
 */

import { imageId } from "./check-image.js";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { bucketSettings } from "./check-bucket.js";
import { S3ObjectStore, type S3Settings } from "../server/src/bucket/s3.js";
import { StandInObjectStore } from "../server/src/bucket/stand-in.js";
import { ObjectStoreError, type ObjectStore } from "../server/src/bucket/store.js";
import { backupConfig } from "../server/src/config.js";
import type { WindlassEvent } from "../server/src/contract.js";
import type { ExecOptions, ExecResult, SandboxHandle, ScriptedModel } from "../server/src/sandbox/api.js";
import { BACKUP_ENV, LINK_TTL_MS, SandboxSessionBackups } from "../server/src/sandbox/backup.js";
import { DATA_DIR, randomId } from "../server/src/sandbox/provider.js";
import { sleep } from "./check-wait.js";
import { Report } from "./check-report.js";

const withBucket = process.argv.includes("--bucket");
const withDocker = process.argv.includes("--docker");
const run = randomId(4);
const tally = new Report({ print: say });
const { expect } = tally;
/** Everything printed, for the last check. */
let printed = "";
/** What must never be printed: the bucket's settings, and every link this run was handed. */
const secrets: string[] = [];

function say(line: string): void {
	printed += `${line}\n`;
	console.log(line);
}
function info(text: string): void {
	say(`INFO  ${text.trim().replace(/\s*\n\s*/g, " | ")}`);
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	say(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		tally.failures += 1;
		say(`FAIL  ${name}: unexpected error  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	}
}
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------------------------

async function standIn(name: string, make: (now: () => number) => StandInObjectStore): Promise<void> {
	let clock = 1_000_000;
	const store = make(() => clock);
	const key = "sessions/u1/s_1.tgz";
	const body = Buffer.from("eleven byte");
	expect(`${name}: an object that was never written has no size`, (await store.size(key)) === null);
	const put = await store.linkToPut(key, { size: body.length, ttlMs: 60_000 });
	expect(
		`${name}: a link to upload takes exactly the bytes it was made for`,
		store.use(put.url, "PUT", Buffer.from("twelve bytes")).status === 403 &&
			(await store.size(key)) === null &&
			store.use(put.url, "PUT", body).status === 200 &&
			(await store.size(key)) === body.length,
	);
	expect(`${name}: a link to upload downloads nothing`, store.use(put.url, "GET").status === 403);
	const get = await store.linkToGet(key, { ttlMs: 60_000 });
	const fetched = store.use(get.url, "GET");
	expect(
		`${name}: a link to download gives the object back, and uploads nothing`,
		fetched.status === 200 && fetched.body?.equals(body) === true && store.use(get.url, "PUT", body).status === 403,
	);
	expect(
		`${name}: a link reaches one key`,
		store.use(get.url.replace("s_1.tgz", "s_2.tgz"), "GET").status === 403 &&
			store.use(get.url.replace(/signature=[0-9a-f]{8}/, "signature=00000000"), "GET").status === 403,
	);
	expect(
		`${name}: a ranged read returns just the requested prefix`,
		Buffer.from((await store.readStart(key, 3))!).equals(body.subarray(0, 3)) &&
			(await store.readStart("missing", 33)) === null,
	);
	const other = make(() => clock);
	expect(`${name}: a link of another store opens nothing`, other.use(get.url, "GET").status === 403);
	clock += 60_001;
	expect(
		`${name}: a link stops working when its time is up`,
		store.use(get.url, "GET").status === 403 &&
			store.use(put.url, "PUT", body).status === 403 &&
			get.expiresAt === 1_060_000,
	);
	await store.remove(key);
	const again = await store.linkToGet(key, { ttlMs: 60_000 });
	expect(
		`${name}: a removed object is gone, removing it again is no error, and a download of it answers 404`,
		(await store.size(key)) === null &&
			(await store.remove(key).then(() => true)) &&
			store.use(again.url, "GET").status === 404,
	);
	const refused = await store.linkToGet("sessions/../other", { ttlMs: 1 }).then(
		() => "signed",
		(error: unknown) => (error instanceof ObjectStoreError ? "refused" : "another error"),
	);
	expect(`${name}: a key that would leave its place is refused`, refused === "refused");
}

// ---------------------------------------------------------------------------------------------
// The signer, with no network
// ---------------------------------------------------------------------------------------------

async function signer(): Promise<void> {
	// The example of AWS's own documentation ("Authenticating Requests: Using Query Parameters"), whose key pair is published there.
	const example: S3Settings = {
		endpoint: "https://s3.amazonaws.com",
		region: "us-east-1",
		bucket: "examplebucket",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		style: "virtual",
	};
	const at = Date.UTC(2013, 4, 24, 0, 0, 0);
	const store = new S3ObjectStore(example, { now: () => at });
	const link = await store.linkToGet("test.txt", { ttlMs: 86_400_000 });
	expect(
		"a link to download is the presigned URL of AWS's published example, to the signature",
		link.url ===
			"https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404" &&
			link.expiresAt === at + 86_400_000,
		link.url.replace(/X-Amz-Signature=.*/, "X-Amz-Signature=..."),
	);
	const put = await store.linkToPut("sessions/u1/s_1.tgz", { size: 1234, ttlMs: 5 * 60_000 });
	const url = new URL(put.url);
	expect(
		"a link to upload signs the size, lasts as long as it was asked to, and holds the key's id but not its secret",
		url.searchParams.get("X-Amz-SignedHeaders") === "content-length;host" &&
			url.searchParams.get("X-Amz-Expires") === "300" &&
			url.pathname === "/sessions/u1/s_1.tgz" &&
			!put.url.includes(example.secretAccessKey) &&
			!put.url.includes(encodeURIComponent(example.secretAccessKey)),
		`${url.pathname}, signed headers ${url.searchParams.get("X-Amz-SignedHeaders")}`,
	);
	const other = await store.linkToPut("sessions/u1/s_1.tgz", { size: 1235, ttlMs: 5 * 60_000 });
	expect(
		"another size is another signature",
		new URL(other.url).searchParams.get("X-Amz-Signature") !== url.searchParams.get("X-Amz-Signature"),
	);

	const path = new S3ObjectStore(
		{ ...example, endpoint: "https://account.example.com/examplebucket/", style: "path" },
		{ now: () => at },
	);
	const pathLink = new URL((await path.linkToGet("a/b.tgz", { ttlMs: 60_000 })).url);
	expect(
		"in path style the bucket is in the path, once, also when the endpoint was given with it",
		pathLink.host === "account.example.com" && pathLink.pathname === "/examplebucket/a/b.tgz",
		`${pathLink.host}${pathLink.pathname}`,
	);

	// The server's own requests, on a `fetch` that answers as a store does when it refuses.
	const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
	const answers: Array<() => Response | Promise<Response>> = [];
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers as Record<string, string> });
		const next = answers.shift();
		if (next === undefined) throw new Error("no answer prepared");
		return next();
	}) as typeof fetch;
	const asked = new S3ObjectStore(example, { now: () => at, fetch: fake });
	answers.push(() => new Response(null, { status: 200, headers: { "content-length": "4321" } }));
	expect(
		"size() is a signed HEAD of the object, with nothing in its address but the key",
		(await asked.size("test.txt")) === 4321 &&
			seen[0].method === "HEAD" &&
			seen[0].url === "https://examplebucket.s3.amazonaws.com/test.txt" &&
			/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(
				seen[0].headers.authorization,
			),
	);
	answers.push(() => new Response(null, { status: 404 }));
	expect("an object that is not there has no size", (await asked.size("test.txt")) === null);
	const leaky = `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message><AWSAccessKeyId>${example.accessKeyId}</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 ${example.secretAccessKey}</StringToSign></Error>`;
	answers.push(() => new Response(leaky, { status: 403 }));
	const refused = await asked.remove("test.txt").then(
		() => "removed",
		(error: unknown) =>
			error instanceof ObjectStoreError ? `${error.status}: ${error.message}` : `another error: ${String(error)}`,
	);
	expect(
		"a refusal is told by its status and the store's code, and by nothing else the store wrote",
		refused === "403: the bucket answered 403 (SignatureDoesNotMatch) to DELETE",
		refused,
	);
	answers.push(() => {
		throw Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(
				new Error(`getaddrinfo ENOTFOUND examplebucket.s3.amazonaws.com ${example.secretAccessKey}`),
				{ code: "ENOTFOUND" },
			),
		});
	});
	const unreachable = await asked.size("test.txt").then(
		() => "answered",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	expect(
		"a store that cannot be reached is told by the kind of failure, without its address",
		unreachable === "the bucket could not be reached for HEAD (ENOTFOUND)",
		unreachable,
	);
	answers.push(() => new Response(null, { status: 204 }));
	expect(
		"remove() is a signed DELETE",
		(await asked.remove("test.txt").then(() => true)) && seen.at(-1)?.method === "DELETE",
	);
	const shown = `${inspect(asked, { depth: 5, showHidden: true })} ${JSON.stringify(asked)} ${String(asked)}`;
	expect(
		"printing the store shows none of its settings",
		!shown.includes(example.secretAccessKey) &&
			!shown.includes(example.accessKeyId) &&
			!shown.includes("examplebucket"),
		shown.slice(0, 80),
	);
	const bad = [
		() => new S3ObjectStore({ ...example, endpoint: "not a url with a secret" }),
		() => new S3ObjectStore({ ...example, endpoint: "https://user:password@example.com" }),
		() => new S3ObjectStore({ ...example, secretAccessKey: " " }),
	].map(make => {
		try {
			make();
			return "made";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
	expect(
		"settings that cannot work are refused without being repeated",
		bad.every(message => message !== "made" && !/not a url with a secret|user:password|example\.com/.test(message)),
		bad.join("; "),
	);

	const env = {
		WLP_BUCKET_ENDPOINT: "https://account.example.com",
		WLP_BUCKET_NAME: "b",
		WLP_BUCKET_ACCESS_KEY_ID: "id",
		WLP_BUCKET_SECRET_ACCESS_KEY: "secret",
	};
	const none = backupConfig({});
	const some = backupConfig({ WLP_BUCKET_ENDPOINT: env.WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME: "b" });
	const all = backupConfig({ ...env, WLP_BUCKET_PREFIX: "/staging/", WLP_BACKUP_MAX_BYTES: "1000" });
	expect(
		"the settings: with none the feature is off, with some it is off and the missing ones are named, with all it is on",
		none.bucket === null &&
			none.missing.length === 0 &&
			none.maxBytes === 64 * 1024 * 1024 &&
			some.bucket === null &&
			some.missing.join(",") === "WLP_BUCKET_ACCESS_KEY_ID,WLP_BUCKET_SECRET_ACCESS_KEY" &&
			all.bucket?.region === "auto" &&
			all.bucket.style === "path" &&
			all.prefix === "staging/" &&
			all.maxBytes === 1000,
		`${some.missing.join(", ")}; prefix "${all.prefix}"`,
	);
}

// ---------------------------------------------------------------------------------------------
// The backups, on a sandbox that answers as it is told
// ---------------------------------------------------------------------------------------------

/** A sandbox whose answers are a test's; what it was asked is kept. */
class ScriptedSandbox implements SandboxHandle {
	readonly id = "scripted";
	readonly cwd = "/workspace";
	readonly profile = "e2b" as const;
	readonly asked: Array<{ command: string; options: ExecOptions }> = [];
	constructor(
		private readonly answer: (step: string, options: ExecOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>>,
	) {}
	async run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		this.asked.push({ command, options });
		return {
			exitCode: 0,
			timedOut: false,
			aborted: false,
			stdout: "",
			stderr: "",
			...(await this.answer(options.env?.[BACKUP_ENV.step] ?? "", options)),
		};
	}
	async readTextFile(): Promise<string> {
		throw new Error("not a file system");
	}
	async writeTextFile(): Promise<void> {
		throw new Error("not a file system");
	}
}

async function scripted(): Promise<void> {
	const owner = { uid: "user-1", sessionId: "s_0123456789abcdef" };
	const hash = sha256("an archive");
	const store = new StandInObjectStore();
	const backups = new SandboxSessionBackups(store, { maxBytes: 1000, prefix: "staging/" });
	const key = "staging/sessions/user-1/s_0123456789abcdef.tgz";
	const linkOf = (options: ExecOptions) => /^url = "(.*)"\n$/.exec(options.stdin ?? "")?.[1] ?? "";

	// A sandbox that does what the scripts do: its archive is ten bytes.
	const archive = Buffer.from("0123456789");
	const honest = new ScriptedSandbox((step, options) => {
		if (step === "pack") return { stdout: `packed ${archive.length} ${sha256(archive)}\n` };
		if (step === "upload") return { stdout: `some noise\nhttp ${store.use(linkOf(options), "PUT", archive).status}\n` };
		const fetched = store.use(linkOf(options), "GET");
		return { stdout: fetched.status === 200 ? "restored\n" : `http ${fetched.status}\n` };
	});
	const saved = await backups.save(honest, owner);
	expect(
		"a save packs, signs a link for exactly that size, has the sandbox upload, and reports what was saved",
		saved.outcome === "saved" &&
			saved.backup.size === 10 &&
			saved.backup.sha256 === sha256(archive) &&
			(await store.size(key)) === 10,
		JSON.stringify(saved),
	);
	const upload = honest.asked[1];
	const everything = honest.asked.map(asked => `${asked.command} ${JSON.stringify(asked.options.env)}`).join(" ");
	expect(
		"the link reaches the sandbox on standard input only: it is on no command line and in no environment",
		linkOf(upload.options).startsWith("wlp-stand-in://") &&
			!everything.includes("wlp-stand-in") &&
			honest.asked[0].options.stdin === undefined &&
			upload.options.env?.[BACKUP_ENV.size] === "10" &&
			honest.asked[0].options.env?.[BACKUP_ENV.max] === "1000",
	);
	const restored = await backups.restore(honest, owner, { size: 10, sha256: sha256(archive), at: 0 }, "ses_abc123");
	const restoreEnv = honest.asked[2].options.env ?? {};
	expect(
		"a restore signs a link to download and tells the sandbox the size, the hash and the session to look for",
		restored.outcome === "restored" &&
			restoreEnv[BACKUP_ENV.size] === "10" &&
			restoreEnv[BACKUP_ENV.sha256] === sha256(archive) &&
			restoreEnv[BACKUP_ENV.session] === "ses_abc123" &&
			restoreEnv[BACKUP_ENV.data] === DATA_DIR,
		JSON.stringify(restored),
	);
	await backups.remove(owner);
	expect(
		"remove takes the object away, and a restore then finds no copy",
		(await store.size(key)) === null &&
			(await backups.restore(honest, owner, { size: 10, sha256: sha256(archive), at: 0 }, "ses_abc123")).outcome ===
				"missing",
	);

	const answers = async (stdout: Record<string, string>, extra: Partial<ExecResult> = {}) => {
		const sandbox = new ScriptedSandbox(step => ({ stdout: stdout[step] ?? "", ...extra }));
		return { save: await backups.save(sandbox, owner), sandbox };
	};
	const empty = await answers({ pack: "empty\n" });
	expect(
		"a sandbox in which Windlass has no session yet has nothing to copy, and is asked nothing more",
		empty.save.outcome === "empty" && empty.sandbox.asked.length === 1,
	);
	const large = await answers({ pack: "too_large 2000\n" });
	const lying = await answers({ pack: `packed 2000 ${hash}\n` });
	expect(
		"over the limit nothing is uploaded: no link is signed, whatever the sandbox says of its archive",
		large.save.outcome === "too_large" &&
			large.save.size === 2000 &&
			large.save.limit === 1000 &&
			large.sandbox.asked.length === 1 &&
			lying.save.outcome === "too_large" &&
			lying.sandbox.asked.length === 1,
		JSON.stringify(large.save),
	);
	const claimed = await answers({ pack: `packed 10 ${hash}\n`, upload: "http 200\n" });
	expect(
		"an upload the sandbox only claims is not recorded: the store is asked",
		claimed.save.outcome === "failed" && /the bucket has no such object/.test(claimed.save.reason),
		JSON.stringify(claimed.save),
	);
	const refusedUpload = await answers({ pack: `packed 10 ${hash}\n`, upload: "http 403\n" });
	const noAnswer = await answers({ pack: `packed 10 ${hash}\n`, upload: "curl 28\n" });
	expect(
		"an upload the store refused, or that got no answer, is a failed save that says which",
		refusedUpload.save.outcome === "failed" &&
			refusedUpload.save.reason.includes("http 403") &&
			noAnswer.save.outcome === "failed" &&
			noAnswer.save.reason.includes("curl 28"),
	);
	// What a broken sandbox might print: the link itself. Nothing of it may come back.
	const echo = new ScriptedSandbox((step, options) =>
		step === "pack"
			? { stdout: `packed 10 ${hash}\n` }
			: { stdout: `curl: (6) could not resolve ${linkOf(options)}\n`, stderr: linkOf(options), exitCode: 6 },
	);
	const echoed = await backups.save(echo, owner);
	const broken = new ScriptedSandbox(() => {
		throw new Error("the command was: curl wlp-stand-in://bucket/secret-link");
	});
	const thrown = await backups.save(broken, owner);
	const slow = await answers({ pack: "" }, { timedOut: true, exitCode: null });
	expect(
		"a step that prints something else, cannot be run or takes too long is a failed save, and what the sandbox printed is not repeated",
		echoed.outcome === "failed" &&
			thrown.outcome === "failed" &&
			slow.save.outcome === "failed" &&
			![echoed, thrown, slow.save].some(result => JSON.stringify(result).includes("wlp-stand-in")) &&
			/no answer/.test(echoed.reason) &&
			/could not be run/.test(thrown.reason) &&
			/took longer/.test(slow.save.reason),
		`${echoed.outcome === "failed" ? echoed.reason : ""}; ${thrown.outcome === "failed" ? thrown.reason : ""}; ${slow.save.outcome === "failed" ? slow.save.reason : ""}`,
	);
	const said = async (answer: string) => {
		const result = await backups.restore(
			new ScriptedSandbox(() => ({ stdout: `${answer}\n` })),
			owner,
			{ size: 10, sha256: hash, at: 0 },
			"ses_abc123",
		);
		return result.outcome === "failed" ? result.reason : result.outcome;
	};
	expect(
		"a restore that the sandbox turned down says why: not the copy that was saved, a file that does not belong, no such session",
		/not the copy this session saved/.test(await said("size 11")) &&
			/not the copy this session saved/.test(await said(`hash ${sha256("x")}`)) &&
			/a file a copy never holds/.test(await said("contents")) &&
			/does not hold the Windlass session/.test(await said("no_session")) &&
			(await said("http 404")) === "missing" &&
			/http 500/.test(await said("http 500")),
	);
	const unusable = await backups.restore(honest, owner, { size: 10, sha256: "not a hash", at: 0 }, "ses_abc123");
	const badName = await backups.save(honest, { uid: "../other", sessionId: "s_1" });
	expect(
		"a record that is not one, or an owner whose name could not be a key, reaches no sandbox and no store",
		unusable.outcome === "failed" && badName.outcome === "failed" && honest.asked.length === 4,
	);
}

// ---------------------------------------------------------------------------------------------
// A real bucket
// ---------------------------------------------------------------------------------------------

/** What a sandbox does with a link, done here: curl, the link on its standard input. Returns the HTTP status. */
function curl(url: string, args: string[]): string {
	secrets.push(url);
	const result = spawnSync("curl", ["-q", "-s", "-K", "-", "-w", "%{http_code}", "--max-time", "60", ...args], {
		input: `url = "${url}"\n`,
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.slice(-3) : `curl ${result.status}`;
}

/**
 * The keys under a prefix, by S3's ListObjectsV2. Not part of the seam, which never lists: only this
 * check does, to show that it left nothing behind. Signed here, the same way as the store signs.
 */
async function listKeys(settings: S3Settings, prefix: string): Promise<string[]> {
	const url = new URL(settings.endpoint);
	const encode = (text: string) =>
		encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	const hmac = (key: Buffer | string, text: string) => createHmac("sha256", key).update(text).digest();
	const amzDate = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	const date = amzDate.slice(0, 8);
	const scope = `${date}/${settings.region}/s3/aws4_request`;
	const empty = sha256("");
	const query = `list-type=2&prefix=${encode(prefix)}`;
	const path = `/${encode(settings.bucket)}`;
	const canonical = [
		"GET",
		path,
		query,
		`host:${url.host}\nx-amz-content-sha256:${empty}\nx-amz-date:${amzDate}\n`,
		"host;x-amz-content-sha256;x-amz-date",
		empty,
	].join("\n");
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${settings.secretAccessKey}`, date), settings.region), "s3"),
		"aws4_request",
	);
	const signature = hmac(signingKey, ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n")).toString(
		"hex",
	);
	const response = await fetch(`${url.origin}${path}?${query}`, {
		headers: {
			"x-amz-content-sha256": empty,
			"x-amz-date": amzDate,
			authorization: `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
		},
	});
	if (!response.ok) throw new Error(`the bucket answered ${response.status} to the listing`);
	return [...(await response.text()).matchAll(/<Key>([^<]*)<\/Key>/g)].map(match => match[1]);
}

async function realBucket(settings: S3Settings, store: ObjectStore, prefix: string, dir: string): Promise<void> {
	const key = `${prefix}sessions/check/s_1.tgz`;
	const file = join(dir, "object.bin");
	const fetched = join(dir, "fetched.bin");
	const body = randomBytes(2048);
	writeFileSync(file, body);
	expect("an object that was never written has no size", (await store.size(key)) === null);
	let began = Date.now();
	const put = await store.linkToPut(key, { size: body.length, ttlMs: LINK_TTL_MS });
	const uploaded = curl(put.url, ["-T", file, "-o", "/dev/null"]);
	expect(
		"curl uploads through a signed link, and the store then knows the object's size",
		uploaded === "200" && (await store.size(key)) === body.length,
		`HTTP ${uploaded}, ${Date.now() - began} ms for the link, the upload and the HEAD`,
	);
	writeFileSync(file, Buffer.concat([body, Buffer.from("x")]));
	const larger = curl(put.url, ["-T", file, "-o", "/dev/null"]);
	writeFileSync(file, body.subarray(0, 100));
	const smaller = curl(put.url, ["-T", file, "-o", "/dev/null"]);
	expect(
		"the link uploads exactly the size it was signed for: a byte more, or fewer bytes, are refused and the object stays",
		larger === "403" && smaller === "403" && (await store.size(key)) === body.length,
		`HTTP ${larger} and ${smaller}`,
	);
	const withPut = curl(put.url, ["-o", "/dev/null"]);
	began = Date.now();
	const get = await store.linkToGet(key, { ttlMs: LINK_TTL_MS });
	const downloaded = curl(get.url, ["-o", fetched]);
	expect(
		"curl downloads through a signed link, and gets the bytes that were uploaded",
		downloaded === "200" && readFileSync(fetched).equals(body),
		`HTTP ${downloaded}, ${Date.now() - began} ms`,
	);
	writeFileSync(file, body);
	const withGet = curl(get.url, ["-T", file, "-o", "/dev/null"]);
	const elsewhere = curl(get.url.replace("s_1.tgz", "s_2.tgz"), ["-o", "/dev/null"]);
	const removal = curl(get.url, ["-X", "DELETE", "-o", "/dev/null"]);
	expect(
		"a link is good for one method and one object: no download with an upload's, no upload or removal with a download's, no other key",
		withPut === "403" &&
			withGet === "403" &&
			elsewhere === "403" &&
			removal === "403" &&
			(await store.size(key)) === body.length,
		`HTTP ${withPut}, ${withGet}, ${elsewhere}, ${removal}`,
	);
	const short = await store.linkToGet(key, { ttlMs: 1000 });
	await sleep(2500);
	const late = curl(short.url, ["-o", "/dev/null"]);
	expect(
		"a link stops working when its time is up",
		late === "403",
		`HTTP ${late} two and a half seconds after a link that lasts one`,
	);
	// The same upload again replaces the object: one object per session, however many turns.
	const second = randomBytes(700);
	writeFileSync(file, second);
	const replaced = curl((await store.linkToPut(key, { size: second.length, ttlMs: LINK_TTL_MS })).url, [
		"-T",
		file,
		"-o",
		"/dev/null",
	]);
	expect(
		"an upload to the same key replaces the object",
		replaced === "200" && (await store.size(key)) === second.length && (await listKeys(settings, prefix)).length === 1,
	);
	await store.remove(key);
	const gone = curl(get.url, ["-o", "/dev/null"]);
	expect(
		"a removed object is gone, a download of it answers 404, and removing it again is no error",
		(await store.size(key)) === null && gone === "404" && (await store.remove(key).then(() => true)),
		`HTTP ${gone}`,
	);
	const wrong = new S3ObjectStore({ ...settings, secretAccessKey: `${settings.secretAccessKey.slice(0, -4)}0000` });
	const refused = await wrong.size(key).then(
		() => "answered",
		(error: unknown) => (error instanceof ObjectStoreError ? error.message : `another error`),
	);
	expect(
		"a wrong secret is refused by the store, and the error says so without it",
		/^the bucket answered 403/.test(refused),
		refused,
	);
}

// ---------------------------------------------------------------------------------------------
// Real containers, a real Windlass, the real bucket
// ---------------------------------------------------------------------------------------------

type Response_ = ScriptedModel["responses"][number];
const answer = (text: string): Response_ => [
	{ type: "text", text },
	{ type: "finish", reason: "stop" },
];
const shell = (callId: string, command: string): Response_ => [
	{ type: "tool_call", callId, name: "shell", input: { command } },
	{ type: "finish", reason: "tool_calls" },
];

async function realSandboxes(settings: S3Settings, store: ObjectStore, prefix: string): Promise<void> {
	const { createSandboxLayer } = await import("../server/src/sandbox/index.js");
	const { docker } = await import("../server/src/sandbox/docker.js");
	// No sign-in exists here and no turn asks for a token: every turn is scripted.
	const layer = createSandboxLayer({ image: await imageId(), signIns: "memory", tokenNetwork: "none" });
	const backups = new SandboxSessionBackups(store, { maxBytes: 8 * 1024 * 1024, prefix });
	const uids: string[] = [];
	const ids: string[] = [];
	/** A container with a data volume of its own: a disk that has seen no session, as a new microVM's. */
	const sandbox = async (name: string) => {
		const uid = `backup-check-${run}-${name}`;
		uids.push(uid);
		await layer.logins.ensureUserVolume(uid);
		const id = await layer.sandboxes.create({
			uid,
			sessionId: `backup-check-${run}`,
			profile: "docker-windlass-sandbox",
		});
		ids.push(id);
		const handle = await layer.sandboxes.connect(id);
		if (handle === undefined) throw new Error("the new sandbox could not be connected to");
		return handle;
	};
	const turn = async (handle: SandboxHandle, prompt: string, script: ScriptedModel, windlassSessionId?: string) => {
		const events: WindlassEvent[] = [];
		const result = await layer.windlass.runTurn(handle, {
			prompt,
			script,
			windlassSessionId,
			onEvent: event => events.push(event),
			onQuestion: async question => ({ choice: question.choices.find(choice => choice.approve)?.id ?? "" }),
		});
		const seqs = events.flatMap(event => (typeof event.seq === "number" ? [event.seq] : []));
		return {
			result,
			events,
			outcome: (result.summary as { outcome?: string } | null)?.outcome,
			first: Math.min(...seqs),
			last: Math.max(...seqs),
			types: events.map(event => event.type),
		};
	};
	const files = async (handle: SandboxHandle) =>
		(
			await handle.run(
				`cd ${DATA_DIR} && find . -mindepth 1 -type f -not -path './snapshots/*' -printf '%P\\n' | LC_ALL=C sort`,
			)
		).stdout
			.trim()
			.split("\n")
			.filter(line => line !== "");
	const owner = { uid: "check", sessionId: `s_${run}` };
	const key = backups.keyOf(owner);

	try {
		const first = await sandbox("a");
		const tools = await first.run(
			"command -v curl tar gzip sha256sum find sort xargs awk stat | wc -l; curl --version | head -1 | cut -d' ' -f1-2",
		);
		expect(
			"the image has what the scripts use",
			tools.stdout.trim().startsWith("9"),
			tools.stdout.trim().replace("\n", ", "),
		);
		const before = await backups.save(first, owner);
		expect(
			"before Windlass has a session there is nothing to copy, and nothing is uploaded",
			before.outcome === "empty" && (await store.size(key)) === null,
			JSON.stringify(before),
		);

		const one = await turn(first, "Write a small script and run it", {
			responses: [
				shell("write", "printf 'echo from-the-script\\n' > hello.sh && sh hello.sh"),
				answer("Done. The word is heron."),
			],
		});
		const session = one.result.windlassSessionId ?? "";
		expect(
			"a scripted turn runs in the first sandbox",
			one.outcome === "succeeded" && /^ses_/.test(session),
			`${one.outcome}, ${session}, seq ${one.first}..${one.last}`,
		);
		// What must never leave a sandbox, put where the scripts would find it if they took too much.
		await first.run(
			`cd ${DATA_DIR} && mkdir -p wake memory/user spill blobs/ab && echo decoy > wake/wake.db && echo decoy > access-token-decoy.json && echo decoy > auth.json && echo decoy > host-id && echo decoy > sessions/${session}.db-shm && echo decoy > index.db && echo decoy > spill/output-1.txt && echo decoy > memory/user/.lock && printf 'note\\n' > memory/user/m_1.md && printf 'image/png\\nPNG' > blobs/ab/${"ab".repeat(32)} && echo decoy > blobs/ab/.tmp-1`,
		);
		const there = await files(first);
		info(`Windlass's data directory after one turn (snapshots/ left out): ${there.join(", ")}`);
		const saved = await backups.save(first, owner);
		const size = await store.size(key);
		expect(
			"the sandbox packs Windlass's session and uploads it to the bucket by itself",
			saved.outcome === "saved" && size === saved.backup.size,
			saved.outcome === "saved" ? `${saved.backup.size} bytes in ${saved.ms} ms` : JSON.stringify(saved),
		);
		const left = await first.run("ls /tmp/.wlp-backup-* 2>/dev/null | wc -l; ps -eo args= | grep -c '[c]url'");
		expect(
			"the save leaves no archive and no process behind in the sandbox",
			left.stdout.trim().split(/\s+/).join(" ") === "0 0",
			left.stdout.trim(),
		);
		if (saved.outcome !== "saved") return;

		const tiny = new SandboxSessionBackups(store, { maxBytes: 2000, prefix });
		const over = await tiny.save(first, owner);
		expect(
			"over the limit nothing is uploaded, and the earlier copy is left as it is",
			over.outcome === "too_large" && over.size > 2000 && (await store.size(key)) === saved.backup.size,
			JSON.stringify(over),
		);

		// The second sandbox: another disk, on which Windlass has never run.
		const second = await sandbox("b");
		const wrongHash = await backups.restore(
			second,
			owner,
			{ ...saved.backup, sha256: sha256("another archive") },
			session,
		);
		expect(
			"a copy whose hash is not the one the session recorded is not unpacked",
			wrongHash.outcome === "failed" &&
				/not the copy this session saved/.test(wrongHash.reason) &&
				(await files(second)).length === 0,
			JSON.stringify(wrongHash),
		);
		const wrongSession = await backups.restore(await sandbox("c"), owner, saved.backup, "ses_0000000000000000");
		expect(
			"a copy that does not hold the Windlass session is a failed restore",
			wrongSession.outcome === "failed" && /does not hold the Windlass session/.test(wrongSession.reason),
			JSON.stringify(wrongSession),
		);
		const restored = await backups.restore(second, owner, saved.backup, session);
		const arrived = await files(second);
		expect(
			"the second sandbox downloads the copy and unpacks it",
			restored.outcome === "restored",
			restored.outcome === "restored" ? `${restored.ms} ms` : JSON.stringify(restored),
		);
		expect(
			"what arrived is the session's database, the media and the notes, and nothing else: no token file, no sign-in, no wake-ups, no lock",
			arrived.join(",") === [`blobs/ab/${"ab".repeat(32)}`, "memory/user/m_1.md", `sessions/${session}.db`].join(","),
			arrived.join(", "),
		);
		const modes = await second.run(
			`cd ${DATA_DIR} && stat -c '%a %U' sessions/${session}.db memory/user/m_1.md | sort -u`,
		);
		expect(
			"the files belong to the agent and are closed to others",
			modes.stdout.trim() === "600 agent",
			modes.stdout.trim(),
		);
		const two = await turn(
			second,
			"What was the word?",
			{ responses: [shell("look", "ls"), answer("heron")] },
			session,
		);
		expect(
			"a turn in the second sandbox continues the same Windlass session: its log goes on where the first one's ended",
			two.outcome === "succeeded" &&
				two.result.windlassSessionId === session &&
				two.result.failure === null &&
				two.first === one.last + 1 &&
				!two.types.includes("session.created"),
			`${two.outcome}, session ${two.result.windlassSessionId}, seq ${two.first}..${two.last} after ${one.first}..${one.last}; ${two.result.failure?.message ?? ""}`,
		);

		// A turn whose engine is killed leaves its last appends in the write-ahead log: the copy has to carry it.
		const cut = turn(second, "Sleep a while", { responses: [shell("nap", "sleep 30"), answer("Slept.")] }, session);
		await sleep(6000);
		await second.run("pkill -9 -f 'windlass acp'");
		const killed = await cut;
		const wal = (await files(second)).filter(name => name.endsWith(".db-wal") || name.endsWith(".db-shm"));
		expect(
			"an engine that is killed in the middle of a turn leaves a write-ahead log beside the database",
			killed.result.failure?.reason === "engine" && wal.includes(`sessions/${session}.db-wal`),
			`${killed.result.failure?.reason}; ${wal.join(", ")}`,
		);
		const again = await backups.save(second, owner);
		if (again.outcome !== "saved") {
			expect("the session is saved again, with its write-ahead log", false, JSON.stringify(again));
			return;
		}
		const third = await sandbox("d");
		const back = await backups.restore(third, owner, again.backup, session);
		const carried = await files(third);
		const three = await turn(third, "And now?", { responses: [answer("Still here.")] }, session);
		expect(
			"restored with its write-ahead log, the session has what the killed turn wrote: Windlass repairs that turn and goes on after it",
			back.outcome === "restored" &&
				carried.includes(`sessions/${session}.db-wal`) &&
				!carried.some(name => name.endsWith("-shm") || name.endsWith("-lock") || name.endsWith("-holder")) &&
				three.outcome === "succeeded" &&
				three.result.windlassSessionId === session &&
				three.first > killed.last,
			`${carried.filter(name => name.startsWith("sessions/")).join(", ")}; the killed turn reached seq ${killed.last}, the next one runs ${three.first}..${three.last} (${three.types.slice(0, 4).join(", ")}, ...)`,
		);
		info(
			`save: ${saved.ms} ms for ${saved.backup.size} bytes, then ${again.ms} ms for ${again.backup.size} bytes; restore: ${restored.outcome === "restored" ? restored.ms : "?"} ms and ${back.outcome === "restored" ? back.ms : "?"} ms (local containers, the real bucket)`,
		);

		// An archive that holds a file a copy never holds, put where the session's copy is.
		const dir = mkdtempSync(join(tmpdir(), "wlp-backup-check-"));
		try {
			spawnSync("sh", [
				"-c",
				`cd "$1" && mkdir -p sessions && echo x > sessions/${session}.db && echo '{}' > auth.json && tar -czf bad.tgz sessions auth.json`,
				"sh",
				dir,
			]);
			const bad = readFileSync(join(dir, "bad.tgz"));
			const put = await store.linkToPut(key, { size: bad.length, ttlMs: LINK_TTL_MS });
			const sent = curl(put.url, ["-T", join(dir, "bad.tgz"), "-o", "/dev/null"]);
			const fourth = await sandbox("e");
			const refused = await backups.restore(fourth, owner, { size: bad.length, sha256: sha256(bad), at: 0 }, session);
			expect(
				"an archive that holds anything but what a copy holds is not unpacked at all",
				sent === "200" &&
					refused.outcome === "failed" &&
					/a file a copy never holds/.test(refused.reason) &&
					(await files(fourth)).length === 0,
				JSON.stringify(refused),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		await backups.remove(owner);
		expect(
			"remove takes the session's object out of the bucket",
			(await store.size(key)) === null && (await listKeys(settings, prefix)).length === 0,
		);
	} finally {
		await backups.remove(owner).catch(() => undefined);
		for (const id of ids) await layer.sandboxes.destroy(id).catch(() => undefined);
		const stuck: string[] = [];
		for (const uid of uids) if ((await docker(["volume", "rm", "-f", `wlp-user-${uid}`])).code !== 0) stuck.push(uid);
		const containers = await docker([
			"ps",
			"-a",
			"--filter",
			"label=dev.windlass-platform=1",
			"--format",
			"{{.Names}}",
		]);
		const mine = containers.stdout.split("\n").filter(name => ids.some(id => name.includes(id)));
		expect(
			"the containers and volumes of this check are removed",
			stuck.length === 0 && mine.length === 0,
			`${ids.length} containers, ${uids.length} volumes${stuck.length + mine.length > 0 ? `; left: ${[...stuck, ...mine].join(", ")}` : ""}`,
		);
	}
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
	await section("the stand-in for a bucket", async () => {
		await standIn("in memory", now => new StandInObjectStore({ now }));
		const dir = mkdtempSync(join(tmpdir(), "wlp-backup-check-"));
		try {
			await standIn("in a directory", now => new StandInObjectStore({ dir, now }));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	await section("the S3 store, without a network", signer);
	await section("the backups, on a scripted sandbox", scripted);

	const settings = withBucket ? bucketSettings() : null;
	if (withBucket && settings === null) {
		tally.failures += 1;
		say(
			"\nFAIL  --bucket: no bucket is configured. Set WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME, WLP_BUCKET_ACCESS_KEY_ID and WLP_BUCKET_SECRET_ACCESS_KEY (or the R2_* names).",
		);
	}
	if (settings === null) {
		say(
			`\n== a real bucket\n      skipped: run with --bucket and the bucket's settings in the environment${withDocker ? " (--docker needs it too)" : ""}`,
		);
	} else {
		secrets.push(settings.secretAccessKey, settings.accessKeyId, settings.bucket, new URL(settings.endpoint).host);
		const store = new S3ObjectStore(settings);
		const prefix = `wlp-check-${run}/`;
		const dir = mkdtempSync(join(tmpdir(), "wlp-backup-check-"));
		try {
			await section("a real bucket", () => realBucket(settings, store, prefix, dir));
			if (withDocker)
				await section("real containers, a real Windlass, the real bucket", () =>
					realSandboxes(settings, store, prefix),
				);
			else say("\n== real containers, a real Windlass, the real bucket\n      skipped: run with --docker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			say("\n== cleanup");
			try {
				const left = await listKeys(settings, prefix);
				for (const key of left) await store.remove(key);
				const after = await listKeys(settings, prefix);
				const all = await listKeys(settings, "");
				expect(
					"nothing of this run is left in the bucket",
					after.length === 0,
					`${left.length} object(s) had to be removed here; the bucket now holds ${all.length} object(s) in all`,
				);
			} catch (error) {
				expect(
					"nothing of this run is left in the bucket",
					false,
					`the listing failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	const leaked = secrets.filter(secret => secret.length >= 6 && printed.includes(secret));
	const signatures = /X-Amz-Signature=[0-9a-f]{16}|wlp-stand-in:\/\/\S+signature=/.test(
		printed.replace(/X-Amz-Signature=\.\.\./g, ""),
	);
	expect(
		"nothing printed here holds a setting of the bucket, a link or a signature",
		leaked.length === 0 && !signatures,
		`${leaked.length} value(s) found${signatures ? ", and a signature" : ""}`,
	);
	return tally.summary();
}

main().then(
	code => process.exit(code),
	(error: unknown) => {
		console.error(`backup-check: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
