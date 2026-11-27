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
import { HARNESS_IDS, type HarnessId, type WindlassEvent } from "../server/src/contract.js";
import type { ExecOptions, ExecResult, SandboxHandle, ScriptedModel } from "../server/src/sandbox/api.js";
import {
	BACKUP_ENV,
	LINK_TTL_MS,
	SandboxSessionBackups,
	findCommand,
	packScript,
	restoreScript,
	sessionFilesEnv,
} from "../server/src/sandbox/backup.js";
import { capabilitiesOf } from "../server/src/sandbox/harnesses.js";
import { WINDLASS_SESSION_FILES, sessionFilesOf } from "../server/src/sandbox/session-files.js";
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
	const copyKey = "sessions/u2/s_1.tgz";
	expect(
		`${name}: a copy inside the store gives the other key the same bytes, and a copy of nothing is false`,
		(await store.copy(key, copyKey)) === true &&
			store.use((await store.linkToGet(copyKey, { ttlMs: 60_000 })).url, "GET").body?.equals(body) === true &&
			(await store.copy("sessions/u1/none.tgz", "sessions/u2/none.tgz")) === false &&
			(await store.size("sessions/u2/none.tgz")) === null,
	);
	const copyRefused = await store.copy(key, "sessions/../other").then(
		() => "copied",
		(error: unknown) => (error instanceof ObjectStoreError ? "refused" : "another error"),
	);
	expect(`${name}: a copy to a key that would leave its place is refused`, copyRefused === "refused");
	await store.remove(copyKey);
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
	answers.push(() => new Response("<CopyObjectResult><ETag>x</ETag></CopyObjectResult>", { status: 200 }));
	const copied = await asked.copy("sessions/u1/s_1.tgz", "sessions/u2/s_2.tgz").catch(() => "threw");
	const copyAsk = seen.at(-1);
	expect(
		"copy() is a signed PUT of the destination naming its source in the bucket, with no body",
		copied === true &&
			copyAsk?.method === "PUT" &&
			copyAsk.url === "https://examplebucket.s3.amazonaws.com/sessions/u2/s_2.tgz" &&
			copyAsk.headers["x-amz-copy-source"] === "/examplebucket/sessions/u1/s_1.tgz" &&
			/SignedHeaders=host;x-amz-content-sha256;x-amz-copy-source;x-amz-date,/.test(copyAsk.headers.authorization),
		`${copyAsk?.method} ${copyAsk?.url}`,
	);
	answers.push(() => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
	answers.push(
		() => new Response(`<Error><Code>InternalError</Code><Key>${example.accessKeyId}</Key></Error>`, { status: 200 }),
	);
	answers.push(() => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }));
	const missing = await asked.copy("a", "b");
	const late = await asked.copy("a", "b").then(
		() => "copied",
		(error: unknown) => (error instanceof ObjectStoreError ? error.message : String(error)),
	);
	const noBucket = await asked.copy("a", "b").then(
		() => "copied",
		(error: unknown) => (error instanceof ObjectStoreError ? error.message : String(error)),
	);
	expect(
		"a copy of nothing is false; a copy that fails in a 200 answer, or in a missing bucket, is an error told by its code alone",
		missing === false &&
			late === "the bucket answered 200 (InternalError) to COPY" &&
			noBucket === "the bucket answered 404 (NoSuchBucket) to COPY",
		`${missing}; ${late}; ${noBucket}`,
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
	const windlass = { harness: "windlass", sessionId: "ses_abc123" } as const;
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
	const saved = await backups.save(honest, owner, windlass);
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
	const restored = await backups.restore(honest, owner, { size: 10, sha256: sha256(archive), at: 0 }, windlass);
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
			(await backups.restore(honest, owner, { size: 10, sha256: sha256(archive), at: 0 }, windlass)).outcome ===
				"missing",
	);

	const other = { uid: "user-2", sessionId: "s_fedcba9876543210" };
	const sourced = await backups.save(honest, owner, windlass);
	const copied = await backups.copy(owner, other);
	const copyOfNothing = await backups.copy({ uid: "user-1", sessionId: "s_none" }, other);
	const badCopy = await backups.copy(owner, { uid: "../x", sessionId: "s_1" }).then(
		() => "copied",
		() => "refused",
	);
	expect(
		"a session's copy is copied to another session's name in the store; a copy of nothing is false; a name that could not be a key is refused",
		sourced.outcome === "saved" &&
			copied &&
			(await store.size("staging/sessions/user-2/s_fedcba9876543210.tgz")) === 10 &&
			!copyOfNothing &&
			badCopy === "refused",
	);
	await backups.remove(owner);
	await backups.remove(other);
	// The save above is not one the checks below count.
	honest.asked.splice(4);

	const answers = async (stdout: Record<string, string>, extra: Partial<ExecResult> = {}) => {
		const sandbox = new ScriptedSandbox(step => ({ stdout: stdout[step] ?? "", ...extra }));
		return { save: await backups.save(sandbox, owner, windlass), sandbox };
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
	const echoed = await backups.save(echo, owner, windlass);
	const broken = new ScriptedSandbox(() => {
		throw new Error("the command was: curl wlp-stand-in://bucket/secret-link");
	});
	const thrown = await backups.save(broken, owner, windlass);
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
			windlass,
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
	const before = honest.asked.length;
	const notCopied = await backups.save(honest, owner, { harness: "claude", sessionId: "ses_abc123" });
	const foreignId = await backups.save(honest, owner, { harness: "windlass", sessionId: "0b5e-not-windlass" });
	const notRestored = await backups.restore(
		honest,
		owner,
		{ size: 10, sha256: hash, at: 0 },
		{
			harness: "codex",
			sessionId: "ses_abc123",
		},
	);
	expect(
		"an agent whose sessions are not copied, or an id that is not the agent's own, reaches no sandbox",
		notCopied.outcome === "failed" &&
			foreignId.outcome === "failed" &&
			notRestored.outcome === "failed" &&
			honest.asked.length === before,
	);
	honest.asked.splice(before);
	const unusable = await backups.restore(honest, owner, { size: 10, sha256: "not a hash", at: 0 }, windlass);
	const badName = await backups.save(honest, { uid: "../other", sessionId: "s_1" }, windlass);
	expect(
		"a record that is not one, or an owner whose name could not be a key, reaches no sandbox and no store",
		unusable.outcome === "failed" && badName.outcome === "failed" && honest.asked.length === 4,
	);
}

// ---------------------------------------------------------------------------------------------
// The agents' session files, and Windlass's copy as it was before they were described per agent
// ---------------------------------------------------------------------------------------------

// Frozen copies of backup.ts's Windlass scripts before #133, for the check that Windlass's copy is unchanged.
const BEFORE_HELD = "^(sessions/[^/]+\\.db(-wal)?|blobs/[0-9a-f][0-9a-f]/[^/]+|memory/.+\\.(md|json|jsonl))$";
const BEFORE_PACK = [
	"set -euo pipefail",
	"umask 077",
	'cd "$WLP_BACKUP_DATA"',
	"rm -f /tmp/.wlp-backup-*",
	'list="$WLP_BACKUP_PACK.list"',
	"{",
	"  if [ -d sessions ]; then find sessions -maxdepth 1 -type f \\( -name '*.db' -o -name '*.db-wal' \\) -print0; fi",
	"  if [ -d blobs ]; then find blobs -mindepth 2 -maxdepth 2 -type f -path 'blobs/[0-9a-f][0-9a-f]/*' ! -name '.*' -print0; fi",
	"  if [ -d memory ]; then find memory -type f \\( -name '*.md' -o -name '*.json' -o -name '*.jsonl' \\) ! -name '.*' -print0; fi",
	'} | LC_ALL=C sort -z > "$list"',
	'if ! grep -qz "^sessions/" "$list"; then rm -f "$list"; echo empty; exit 0; fi',
	'raw=$(xargs -0 -r stat -c %s < "$list" | awk \'{ sum += $1 } END { printf "%.0f", sum }\')',
	'if [ "$raw" -gt $((WLP_BACKUP_MAX * 10)) ]; then rm -f "$list"; echo "too_large $raw"; exit 0; fi',
	'tar --null --no-recursion -T "$list" -cf - | gzip -n > "$WLP_BACKUP_PACK"',
	'rm -f "$list"',
	'size=$(stat -c %s "$WLP_BACKUP_PACK")',
	'if [ "$size" -gt "$WLP_BACKUP_MAX" ]; then rm -f "$WLP_BACKUP_PACK"; echo "too_large $size"; exit 0; fi',
	'echo "packed $size $(sha256sum < "$WLP_BACKUP_PACK" | cut -d" " -f1)"',
].join("\n");
const BEFORE_RESTORE = [
	"set -u",
	"umask 077",
	`trap 'rm -f -- "$WLP_BACKUP_PACK"' EXIT`,
	`code=$(curl -q -s -K - -o "$WLP_BACKUP_PACK" -w '%{http_code}' --connect-timeout 15 --max-time "$WLP_BACKUP_SECONDS" --retry 2 --retry-delay 1 --retry-max-time "$WLP_BACKUP_SECONDS" 2>/dev/null) || { echo "curl $?"; exit 0; }`,
	'if [ "$code" != 200 ]; then echo "http $code"; exit 0; fi',
	'size=$(stat -c %s "$WLP_BACKUP_PACK")',
	'if [ "$size" != "$WLP_BACKUP_SIZE" ]; then echo "size $size"; exit 0; fi',
	'hash=$(sha256sum < "$WLP_BACKUP_PACK" | cut -d" " -f1)',
	'if [ "$hash" != "$WLP_BACKUP_SHA256" ]; then echo "hash $hash"; exit 0; fi',
	`names=$(tar -tzf "$WLP_BACKUP_PACK" 2>/dev/null) || { echo unpack; exit 0; }`,
	`if printf '%s\\n' "$names" | grep -qvE '${BEFORE_HELD}'; then echo contents; exit 0; fi`,
	'mkdir -p "$WLP_BACKUP_DATA" && tar -xzf "$WLP_BACKUP_PACK" -C "$WLP_BACKUP_DATA" --no-same-owner --no-same-permissions 2>/dev/null || { echo unpack; exit 0; }',
	'if [ ! -f "$WLP_BACKUP_DATA/sessions/$WLP_BACKUP_SESSION.db" ]; then echo no_session; exit 0; fi',
	"echo restored",
].join("\n");

/** A `curl` for the restore scripts: whatever the link, it "downloads" `$WLP_CHECK_ARCHIVE` and answers 200. */
const FAKE_CURL = [
	"#!/bin/sh",
	'out=""',
	'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done',
	"cat > /dev/null",
	'cp "$WLP_CHECK_ARCHIVE" "$out" && printf 200',
].join("\n");

/** Runs a script with bash as a sandbox would, in a directory of its own instead of /tmp. */
function bash(script: string, env: Record<string, string>, scratch: string, stdin = ""): string {
	const local = script.replaceAll("rm -f /tmp/.wlp-backup-*", `rm -f ${scratch}/.wlp-backup-*`);
	const result = spawnSync("bash", ["-c", local], {
		env: { PATH: `${join(scratch, "bin")}:${process.env.PATH ?? ""}`, ...env },
		input: stdin,
		encoding: "utf8",
	});
	return `${result.stdout.trim().split("\n").pop() ?? ""}|${result.status}`;
}

/** Every file under `dir`, as relative paths, sorted. */
function tree(dir: string): string {
	const found = spawnSync("sh", ["-c", 'cd "$1" && find . -type f | LC_ALL=C sort', "sh", dir], { encoding: "utf8" });
	return found.stdout.trim().replace(/\n/g, ",");
}

async function sessionFiles(): Promise<void> {
	const table = (["windlass", ...HARNESS_IDS.filter(id => id !== "windlass")] as HarnessId[]).map(id => ({
		id,
		backups: capabilitiesOf(id).backups,
		files: sessionFilesOf(id),
	}));
	expect(
		"an agent has a description of its session files exactly when its record says its sessions are copied",
		table.every(row => row.backups === (row.files !== null)),
		table.map(row => `${row.id}: ${row.backups ? "copied" : "not copied"}`).join(", "),
	);
	expect(
		"only Windlass's sessions are copied for now",
		table
			.filter(row => row.backups)
			.map(row => row.id)
			.join(",") === "windlass",
	);
	const hostile = [
		"",
		"ses_",
		"ses_a/b",
		"ses_*",
		"ses_a b",
		"ses_$(id)",
		"ses_a;b",
		"../ses_a",
		"ses_a\nses_b",
		"-ses_a",
	];
	for (const row of table) {
		const files = row.files;
		if (files === null) continue;
		expect(
			`${row.id}: its id pattern takes no id a glob, a regex or a shell would read as more than a name`,
			hostile.every(id => !new RegExp(files.id).test(id)),
		);
		expect(
			`${row.id}: its patterns hold no space, and every rule searches a plain folder`,
			![files.present, files.held, files.proof].some(pattern => /\s/.test(pattern)) &&
				files.copied.every(rule => findCommand(rule).startsWith(`if [ -d ${rule.under} ]`)),
		);
	}
	expect(
		"a rule that would search outside the data directory, or pass a find option, is refused",
		["..", "a/../..", "-delete", "/etc", "a b"].every(under => {
			try {
				findCommand({ under });
				return false;
			} catch {
				return true;
			}
		}),
	);
	const idRule = findCommand({ under: "projects", minDepth: 2, maxDepth: 2, names: ["<id>.jsonl"] });
	expect(
		"an <id> in a rule's pattern is the checked session id from the environment, never text in the script",
		idRule ===
			`if [ -d projects ]; then find projects -mindepth 2 -maxdepth 2 -type f -name "$${BACKUP_ENV.session}".jsonl -print0; fi`,
		idRule,
	);

	// Windlass, as it was.
	const windlass = WINDLASS_SESSION_FILES;
	const pack = packScript(windlass);
	const beforeFinds = BEFORE_PACK.split("\n").filter(line => line.includes("find "));
	const nowFinds = pack.split("\n").filter(line => line.includes("find "));
	expect(
		"Windlass: the files listed for a copy are the ones listed before, to the character",
		nowFinds.join("\n") === beforeFinds.join("\n") && nowFinds.length === 3,
		nowFinds.join(" | "),
	);
	const session = "ses_abc123";
	const env = sessionFilesEnv({ harness: "windlass", sessionId: session })?.env ?? {};
	expect(
		"Windlass: the root, the names a restore takes and the proof are the ones of before",
		windlass.root === DATA_DIR &&
			env[BACKUP_ENV.data] === DATA_DIR &&
			env[BACKUP_ENV.held] === BEFORE_HELD &&
			env[BACKUP_ENV.proof] === `sessions/${session}.db` &&
			env[BACKUP_ENV.present] === "^sessions/" &&
			sessionFilesEnv({ sessionId: session })?.files === windlass,
		JSON.stringify(env),
	);
	expect(
		"an id that is not the agent's own, or an agent whose sessions are not copied, gets no description",
		sessionFilesEnv({ harness: "windlass", sessionId: "not-a-windlass-id" }) === null &&
			sessionFilesEnv({ harness: "windlass", sessionId: "ses_a/../b" }) === null &&
			table.filter(row => !row.backups).every(row => sessionFilesEnv({ harness: row.id, sessionId: session }) === null),
	);

	// The scripts themselves, before and now, on the same files with this machine's bash, find, tar and gzip.
	const scratch = mkdtempSync(join(tmpdir(), "wlp-backup-files-"));
	try {
		spawnSync("mkdir", ["-p", join(scratch, "bin")]);
		writeFileSync(join(scratch, "bin", "curl"), FAKE_CURL, { mode: 0o755 });
		const data = join(scratch, "data");
		const layouts: Record<string, string> = {
			"no data at all": "mkdir -p data",
			"only what is never copied": `mkdir -p data/sessions data/wake && echo x > data/sessions/${session}.db-shm && echo x > data/wake/wake.db && echo x > data/auth.json`,
			"a whole directory": [
				"mkdir -p data/sessions/sub data/blobs/ab data/blobs/zz data/blobs/ab/deeper data/memory/user/deep data/wake data/snapshots/h data/spill data/approvals",
				`echo db > data/sessions/${session}.db && echo wal > data/sessions/${session}.db-wal && echo shm > data/sessions/${session}.db-shm`,
				"echo x > data/sessions/ses_other.db && echo x > data/sessions/.hidden.db && echo x > data/sessions/ses_x.db-lock && echo x > data/sessions/ses_x.db-holder && echo x > data/sessions/sub/nested.db",
				"echo png > data/blobs/ab/0123 && echo x > data/blobs/ab/.tmp-1 && echo x > data/blobs/zz/nothex && echo x > data/blobs/ab/deeper/f && echo x > data/blobs/top",
				"echo n > data/memory/user/m_1.md && echo j > data/memory/user/deep/a.json && echo l > data/memory/b.jsonl && echo x > data/memory/user/.lock && echo x > data/memory/user/.h.md && echo x > data/memory/user/notes.txt",
				"echo x > data/wake/wake.db && echo x > data/index.db && echo x > data/access-token-1.json && echo x > data/auth.json && echo x > data/host-id && echo x > data/snapshots/h/HEAD && echo x > data/spill/o.txt && echo x > data/approvals/a.json",
			].join(" && "),
		};
		for (const [name, layout] of Object.entries(layouts)) {
			spawnSync("sh", ["-c", `rm -rf data && ${layout}`], { cwd: scratch });
			const answers: string[] = [];
			const archives: Buffer[] = [];
			for (const script of [BEFORE_PACK, pack]) {
				const archive = join(scratch, `.wlp-backup-${archives.length}.tgz`);
				answers.push(
					bash(
						script,
						{ ...env, [BACKUP_ENV.data]: data, [BACKUP_ENV.pack]: archive, [BACKUP_ENV.max]: "1000000" },
						scratch,
					),
				);
				archives.push(answers.at(-1)?.startsWith("packed") ? readFileSync(archive) : Buffer.alloc(0));
			}
			expect(
				`Windlass, ${name}: the pack script answers as before, with the same archive to the byte`,
				answers[0] === answers[1] && archives[0].equals(archives[1]),
				`${answers[0]} / ${answers[1]}`,
			);
		}
		const tooLarge = [BEFORE_PACK, pack].map(script =>
			bash(
				script,
				{
					...env,
					[BACKUP_ENV.data]: data,
					[BACKUP_ENV.pack]: join(scratch, ".wlp-backup-big.tgz"),
					[BACKUP_ENV.max]: "10",
				},
				scratch,
			),
		);
		expect(
			"Windlass: over the limit, as before",
			tooLarge[0] === tooLarge[1] && tooLarge[0].startsWith("too_large"),
			tooLarge.join(" / "),
		);
		const refused = bash(
			pack,
			{
				...env,
				[BACKUP_ENV.data]: data,
				[BACKUP_ENV.session]: "ses_$(id)",
				[BACKUP_ENV.pack]: join(scratch, ".wlp-backup-x.tgz"),
				[BACKUP_ENV.max]: "1000000",
			},
			scratch,
		);
		expect(
			"the pack script itself refuses a session id that is not the agent's, before it lists anything",
			refused === "|2",
			refused,
		);

		// Restores of archives made here: what each script answers, and what each leaves in a fresh directory.
		const made: Record<string, string> = {
			"a copy": `mkdir -p sessions blobs/ab memory/u && echo db > sessions/${session}.db && echo w > sessions/${session}.db-wal && echo p > blobs/ab/0123 && echo n > memory/u/m.md && find sessions blobs memory -type f | tar -czf "$1" --no-recursion -T -`,
			"a copy with a sign-in in it": `mkdir -p sessions && echo db > sessions/${session}.db && echo x > auth.json && tar -czf "$1" --no-recursion sessions/${session}.db auth.json`,
			"a copy of another session":
				'mkdir -p sessions && echo db > sessions/ses_other.db && tar -czf "$1" sessions/ses_other.db',
			"a copy with a lock in it": `mkdir -p sessions && echo db > sessions/${session}.db && echo x > sessions/${session}.db-lock && tar -czf "$1" --no-recursion sessions/${session}.db sessions/${session}.db-lock`,
			"a copy of several sessions": `mkdir -p sessions && echo db > sessions/${session}.db && echo db > sessions/ses_sub.db && tar -czf "$1" --no-recursion sessions/${session}.db sessions/ses_sub.db`,
			"a copy with a folder entry": `mkdir -p sessions && echo db > sessions/${session}.db && tar -czf "$1" sessions`,
			"not an archive": 'echo nonsense > "$1"',
		};
		for (const [name, recipe] of Object.entries(made)) {
			const work = mkdtempSync(join(scratch, "make-"));
			const archive = join(scratch, "fetched.tgz");
			spawnSync("sh", ["-c", recipe, "sh", archive], { cwd: work });
			const bytes = readFileSync(archive);
			const results = [BEFORE_RESTORE, restoreScript(windlass)].map((script, index) => {
				const into = join(scratch, `restored-${index}`);
				rmSync(into, { recursive: true, force: true });
				const answer = bash(
					script,
					{
						...env,
						[BACKUP_ENV.data]: into,
						[BACKUP_ENV.pack]: join(scratch, `.wlp-backup-r${index}.tgz`),
						[BACKUP_ENV.size]: String(bytes.length),
						[BACKUP_ENV.sha256]: sha256(bytes),
						[BACKUP_ENV.seconds]: "5",
						WLP_CHECK_ARCHIVE: archive,
					},
					scratch,
					'url = "https://example.invalid/x"\n',
				);
				return `${answer} [${tree(into)}]`;
			});
			expect(
				`Windlass, ${name}: the restore script answers as before and unpacks the same files`,
				results[0] === results[1],
				results.join(" / "),
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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
	const agent = (sessionId: string) => ({ harness: "windlass", sessionId }) as const;

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
		// Before there is a session there is no id: Windlass's copy names none, so any of its pattern does.
		const before = await backups.save(first, owner, agent("ses_none"));
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
		const saved = await backups.save(first, owner, agent(session));
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
		const over = await tiny.save(first, owner, agent(session));
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
			agent(session),
		);
		expect(
			"a copy whose hash is not the one the session recorded is not unpacked",
			wrongHash.outcome === "failed" &&
				/not the copy this session saved/.test(wrongHash.reason) &&
				(await files(second)).length === 0,
			JSON.stringify(wrongHash),
		);
		const wrongSession = await backups.restore(await sandbox("c"), owner, saved.backup, agent("ses_0000000000000000"));
		expect(
			"a copy that does not hold the Windlass session is a failed restore",
			wrongSession.outcome === "failed" && /does not hold the Windlass session/.test(wrongSession.reason),
			JSON.stringify(wrongSession),
		);
		const restored = await backups.restore(second, owner, saved.backup, agent(session));
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
		const again = await backups.save(second, owner, agent(session));
		if (again.outcome !== "saved") {
			expect("the session is saved again, with its write-ahead log", false, JSON.stringify(again));
			return;
		}
		const third = await sandbox("d");
		const back = await backups.restore(third, owner, again.backup, agent(session));
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
			const refused = await backups.restore(
				fourth,
				owner,
				{ size: bad.length, sha256: sha256(bad), at: 0 },
				agent(session),
			);
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
	await section("the agents' session files, and Windlass's copy as before", sessionFiles);

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
