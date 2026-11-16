/**
 * The check of the copies of Windlass's session data (server/src/sandbox/backup.ts) against the real
 * services: a real E2B microVM uploads to a real bucket through a signed link, a second microVM
 * downloads it, and a scripted turn there continues the first one's Windlass session.
 *
 *   cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-backup-check.ts
 *
 * It needs the bucket's settings in the environment as scripts/backup-check.ts does (WLP_BUCKET_*, or
 * the R2_* names), and the template (sandbox/e2b/build.sh). What it does, with one sandbox at a time:
 *
 *   1. creates a sandbox through the provider and looks for the tools the scripts use;
 *   2. runs one scripted (demo) turn: Windlass's real engine and a real tool call with a scripted
 *      model, so no model is called, no sign-in is needed and no token exists anywhere in this script;
 *   3. saves Windlass's session: the microVM packs it and uploads it to the bucket by itself. Twice, to
 *      have two timings;
 *   4. destroys the sandbox, which is the loss;
 *   5. creates a second sandbox, restores the copy into it, and runs a second scripted turn that names
 *      the first one's Windlass session;
 *   6. destroys that one too, and removes the object.
 *
 * Limits on itself, as scripts/e2b-check.ts has them: it refuses to start without E2B_API_KEY or a
 * bucket; it stops at a hard time limit (four minutes); whatever happens, `finally` kills every
 * sandbox that carries this run's own deployment label and removes this run's one object, which is
 * under a prefix of its own; should the process be killed, the sandbox's own timeout pauses it within
 * three minutes and the first line printed says how to remove it. It ends with how many seconds its
 * sandboxes ran and what that costs by E2B's published prices (an estimate, a tenth of a cent).
 *
 * Nothing it prints holds a setting of the bucket or a link.
 *
 * Exit code 0 when every check passed, 1 when one failed, 2 without a key or a bucket, 3 at the limit.
 */

import { S3ObjectStore, type S3Settings } from "../server/src/bucket/s3.js";
import { backupConfig } from "../server/src/config.js";
import type { WindlassEvent } from "../server/src/contract.js";
import type { AccessTokens, ChatgptLogins, SandboxHandle, ScriptedModel } from "../server/src/sandbox/api.js";
import { SandboxSessionBackups } from "../server/src/sandbox/backup.js";
import { cleanupDeployment } from "../server/src/sandbox/e2b/cleanup.js";
import { readE2bSettings } from "../server/src/sandbox/e2b/config.js";
import { describeUsage } from "../server/src/sandbox/e2b/pricing.js";
import { DATA_DIR, randomId } from "../server/src/sandbox/provider.js";

const LIMIT_MS = 4 * 60_000;
const startedAt = Date.now();
let passes = 0;
let failures = 0;

const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, " | ");
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
function expect(name: string, ok: boolean, detail = ""): boolean {
	if (ok) passes += 1;
	else failures += 1;
	console.log(ok ? `PASS  ${name}${detail ? `  (${oneLine(detail)})` : ""}` : `FAIL  ${name}  ${oneLine(detail) || "condition not met"}`);
	return ok;
}
function info(text: string): void {
	console.log(`INFO  ${oneLine(text)}`);
}

type Response = ScriptedModel["responses"][number];
const say = (text: string): Response => [{ type: "text", text }, { type: "finish", reason: "stop" }];
const shell = (callId: string, command: string): Response => [{ type: "tool_call", callId, name: "shell", input: { command } }, { type: "finish", reason: "tool_calls" }];

/** The bucket's settings: the server's own variables, or the R2_* names a credentials file may use. */
function bucketSettings(): S3Settings | null {
	const own = backupConfig().bucket;
	if (own !== null) return own;
	const read = (name: string) => (process.env[name] ?? "").trim();
	const settings: S3Settings = { endpoint: read("R2_ENDPOINT"), region: "auto", bucket: read("R2_BUCKET"), accessKeyId: read("R2_ACCESS_KEY_ID"), secretAccessKey: read("R2_SECRET_ACCESS_KEY"), style: "path" };
	return settings.endpoint === "" || settings.bucket === "" || settings.accessKeyId === "" || settings.secretAccessKey === "" ? null : settings;
}

async function main(): Promise<number> {
	const apiKey = (process.env.E2B_API_KEY ?? "").trim();
	const bucket = bucketSettings();
	if (apiKey === "" || bucket === null) {
		console.error(`e2b-backup-check: ${apiKey === "" ? "E2B_API_KEY is not set" : "no bucket is configured (WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME, WLP_BUCKET_ACCESS_KEY_ID, WLP_BUCKET_SECRET_ACCESS_KEY)"}, so nothing was done.`);
		return 2;
	}
	const run = randomId(4);
	// A label no other sandbox has, and a prefix no other object has: everything this run makes, and nothing else, is found by them.
	const deployment = `backup-check-${run}`;
	const settings = { ...readE2bSettings(), deployment, maxRunning: 1, pause: true, windlassSandbox: false, openProfile: false };
	console.log(`e2b-backup-check: template "${settings.template}", deployment label "${deployment}", time limit ${LIMIT_MS / 1000} s.`);
	console.log(`e2b-backup-check: should this process be killed, its sandbox is paused by its own timeout within ${Math.round(settings.turnLeaseMs / 1000)} s; remove it with: npx tsx ../scripts/e2b-cleanup.ts --deployment ${deployment} --kill`);

	const store = new S3ObjectStore(bucket);
	const backups = new SandboxSessionBackups(store, { maxBytes: 16 * 1024 * 1024, prefix: `wlp-check-${run}/` });
	const owner = { uid: "e2b-backup-check", sessionId: `s_${run}` };
	const key = backups.keyOf(owner);

	// E2B's SDK is loaded here and not before: without a key nothing of it is needed.
	const { createE2bSdkClient } = await import("../server/src/sandbox/e2b/sdk.js");
	const { createE2bSandboxLayer } = await import("../server/src/sandbox/e2b/index.js");
	const client = createE2bSdkClient(apiKey);
	// No sign-in and no token exist here: every turn is scripted, and a turn that asked for a token would fail the check.
	const tokens: AccessTokens = {
		current: async () => {
			throw new Error("this check hands out no access token: its turns are scripted");
		},
	};
	const layer = createE2bSandboxLayer({ logins: {} as ChatgptLogins, tokens, backups }, { client, settings, log: (line) => console.log(`      ${line}`) });

	/** How long this run's sandboxes ran, added up: what E2B bills by. */
	const usage = { ms: 0, since: null as number | null, cpuCount: 0, memoryMB: 0 };
	const runs = () => (usage.since = Date.now());
	const stops = () => {
		if (usage.since !== null) usage.ms += Date.now() - usage.since;
		usage.since = null;
	};

	let timedOut = false;
	let giveUp: () => void = () => {};
	const limit = new Promise<"limit">((resolve) => (giveUp = () => resolve("limit")));
	const timer = setTimeout(() => {
		timedOut = true;
		giveUp();
	}, LIMIT_MS);

	const turn = async (handle: SandboxHandle, prompt: string, script: ScriptedModel, windlassSessionId?: string) => {
		const events: WindlassEvent[] = [];
		const began = Date.now();
		const result = await layer.windlass.runTurn(handle, { prompt, script, windlassSessionId, onEvent: (event) => events.push(event), onQuestion: async (question) => ({ choice: question.choices.find((choice) => choice.approve)?.id ?? question.choices[0]?.id ?? "" }) });
		const seqs = events.flatMap((event) => (typeof event.seq === "number" ? [event.seq] : []));
		return { result, ms: Date.now() - began, outcome: (result.summary as { outcome?: string } | null)?.outcome, first: Math.min(...seqs), last: Math.max(...seqs), created: events.some((event) => event.type === "session.created") };
	};
	const open = async (session: string) => {
		const began = Date.now();
		const id = await layer.sandboxes.create({ uid: owner.uid, sessionId: session, profile: "e2b" });
		runs();
		const info = await client.info(id);
		usage.cpuCount = info?.cpuCount ?? usage.cpuCount;
		usage.memoryMB = info?.memoryMB ?? usage.memoryMB;
		const handle = await layer.sandboxes.connect(id);
		if (handle === undefined) throw new Error("the new sandbox could not be connected to");
		return { id, handle, ms: Date.now() - began };
	};
	const files = async (handle: SandboxHandle) => (await handle.run(`cd ${DATA_DIR} && find . -mindepth 1 -type f -not -path './snapshots/*' -printf '%P\\n' | LC_ALL=C sort`)).stdout.trim().split("\n").filter((line) => line !== "");

	const work = async (): Promise<void> => {
		console.log("\n== the first sandbox");
		const first = await open(`backup-check-${run}-1`);
		expect("a sandbox is created from the template", true, `${first.id} in ${first.ms} ms`);
		const tools = await first.handle.run("for tool in curl tar gzip sha256sum find sort xargs awk stat; do command -v \"$tool\" >/dev/null || echo \"$tool\"; done; curl --version | head -1 | cut -d' ' -f1-2");
		const lacking = tools.stdout.trim().split("\n").slice(0, -1);
		expect("the template has every tool the scripts use", lacking.length === 0, lacking.length === 0 ? (tools.stdout.trim().split("\n").pop() ?? "") : `missing: ${lacking.join(", ")}. The template has to be rebuilt with them (sandbox/e2b/build.sh)`);
		if (lacking.length > 0 || timedOut) return;
		const one = await turn(first.handle, "Write a small script and run it", { responses: [shell("write", "printf 'echo from-the-script\\n' > hello.sh && sh hello.sh"), say("Done. The word is heron.")] });
		const session = one.result.windlassSessionId ?? "";
		expect("a scripted turn runs: Windlass's engine and a real tool call", one.outcome === "succeeded" && /^ses_/.test(session) && one.result.failure === null, `${one.outcome} in ${one.ms} ms, seq ${one.first}..${one.last}; ${one.result.failure?.message ?? ""}`);
		info(`Windlass's data directory after the turn (snapshots/ left out): ${(await files(first.handle)).join(", ")}`);
		if (session === "" || timedOut) return;

		const saved = await backups.save(first.handle, owner);
		const size = await store.size(key);
		expect("the microVM packs Windlass's session and uploads it to the real bucket through a signed link", saved.outcome === "saved" && size === saved.backup.size, saved.outcome === "saved" ? `${saved.backup.size} bytes in ${saved.ms} ms` : JSON.stringify(saved));
		if (saved.outcome !== "saved" || timedOut) return;
		const again = await backups.save(first.handle, owner);
		expect("a second save replaces the object, and the same files make the same archive", again.outcome === "saved" && again.backup.sha256 === saved.backup.sha256, again.outcome === "saved" ? `${again.ms} ms` : JSON.stringify(again));
		const left = await first.handle.run("ls /tmp/.wlp-backup-* 2>/dev/null | wc -l");
		expect("the save leaves no archive behind in the sandbox", left.stdout.trim() === "0", left.stdout.trim());

		console.log("\n== the loss");
		await layer.sandboxes.destroy(first.id);
		stops();
		expect("the first sandbox is gone, and Windlass's session with it", (await layer.sandboxes.state(first.id)) === "none");
		if (timedOut) return;

		console.log("\n== the second sandbox");
		const second = await open(`backup-check-${run}-2`);
		expect("a second sandbox is created, with nothing of the session on its disk", (await files(second.handle)).length === 0, `${second.id} in ${second.ms} ms`);
		const restored = await backups.restore(second.handle, owner, saved.backup, session);
		const arrived = await files(second.handle);
		expect("the microVM downloads the copy through a signed link, checks it and unpacks it", restored.outcome === "restored" && arrived.join(",") === `sessions/${session}.db`, `${restored.outcome === "restored" ? `${restored.ms} ms` : JSON.stringify(restored)}; ${arrived.join(", ")}`);
		if (restored.outcome !== "restored" || timedOut) return;
		const two = await turn(second.handle, "What was the word?", { responses: [shell("look", "ls -a"), say("heron")] }, session);
		expect(
			"a scripted turn in the second sandbox continues the same Windlass session: its log goes on where the first one's ended",
			two.outcome === "succeeded" && two.result.windlassSessionId === session && two.result.failure === null && two.first === one.last + 1 && !two.created,
			`${two.outcome} in ${two.ms} ms, session ${two.result.windlassSessionId}, seq ${two.first}..${two.last} after ${one.first}..${one.last}; ${two.result.failure?.message ?? ""}`,
		);
		const after = await backups.save(second.handle, owner);
		expect("and its end is saved in turn", after.outcome === "saved" && after.backup.sha256 !== saved.backup.sha256, after.outcome === "saved" ? `${after.backup.size} bytes in ${after.ms} ms` : JSON.stringify(after));
		info(`timings: save ${saved.ms} ms, ${again.outcome === "saved" ? again.ms : "?"} ms and ${after.outcome === "saved" ? after.ms : "?"} ms; restore ${restored.ms} ms; the archive is ${saved.backup.size} bytes after one turn`);
		await layer.sandboxes.destroy(second.id);
		stops();
	};

	try {
		const outcome = await Promise.race([work(), limit]);
		if (outcome === "limit") expect("the check finished within its time limit", false, `stopped after ${LIMIT_MS / 1000} s; its sandbox is removed below`);
	} catch (error) {
		expect("the check ran without an unexpected error", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	} finally {
		clearTimeout(timer);
		stops();
		console.log("\n== cleanup");
		try {
			const report = await cleanupDeployment(client, deployment, { kill: true });
			for (const line of report.lines) console.log(`      ${line}`);
			expect("nothing of this run is left at E2B", report.failed.length === 0 && (await client.list({ metadata: { wlp_deployment: deployment } })).length === 0, report.failed.map((item) => `${item.sandboxId}: ${item.reason}`).join("; "));
		} catch (error) {
			expect("nothing of this run is left at E2B", false, `the cleanup itself failed (${messageOf(error)}). Run: npx tsx ../scripts/e2b-cleanup.ts --deployment ${deployment} --kill`);
		}
		const removed = await backups.remove(owner).then(
			async () => (await store.size(key)) === null,
			() => false,
		);
		expect("nothing of this run is left in the bucket", removed);
		console.log(`\ne2b-backup-check: the sandboxes ran ${describeUsage(usage.ms / 1000, usage.cpuCount, usage.memoryMB)}. The check itself took ${Math.round((Date.now() - startedAt) / 1000)} s.`);
		console.log("e2b-backup-check: that is an estimate from E2B's published prices and this script's own clock; the account's usage page has what was billed.");
	}
	console.log(`\n${passes} passed, ${failures} failed`);
	return timedOut ? 3 : failures === 0 ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(`e2b-backup-check: ${messageOf(error)}`);
		process.exit(1);
	},
);
