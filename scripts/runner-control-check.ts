/**
 * What the types of the control socket's module cannot show: input from the other side that is not a
 * frame is refused without throwing, every refusal the actor makes is one a runner can read, a newer
 * server's refusal still shows its sentence, and the rule for a second runner with one key.
 *
 *   cd server && npx tsx ../scripts/runner-control-check.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { mock } from "node:test";
import { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import type { Executor } from "../runner/src/docker-executor.js";
import {
	REFUSED_RETRY_MS, type ServerFrame, LIVE_MS, MAX_CONTROL_FRAME_BYTES, MIN_RUNNER_VERSION, parseConnectionRefusal, parsePairStatus, parseRunnerFrame, parseServerFrame, refuse, secondHello, versionAtLeast,
} from "../server/src/runner/control.js";

let failures = 0;
function expect(name: string, ok: boolean): void {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
}
const never = (parse: (data: unknown) => unknown, inputs: unknown[]) => inputs.every((input) => {
	try { return parse(input) === null; } catch { return false; }
});

const signature = "A".repeat(86);
const hello = { kind: "hello", runnerVersion: "0.1.0", epoch: "e0123456789", time: Date.now(), signature };
const junk: unknown[] = [
	undefined, null, 7, {}, [], "", "{", "null", "[]", '"hello"', Buffer.from("{}"),
	JSON.stringify({ ...hello, extra: 1 }),
	JSON.stringify({ ...hello, runnerVersion: "1.2" }),
	JSON.stringify({ ...hello, signature: "short" }),
	JSON.stringify({ ...hello, time: -1 }),
	`{"__proto__":{"kind":"hello"},"kind":"heartbeat"}`,
	JSON.stringify({ kind: "report", docker: { ok: true }, commandSandbox: { ok: false, reason: "no\nnewlines" }, freeDiskBytes: null, sandboxes: [] }),
	JSON.stringify({ kind: "report", docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: 1, sandboxes: Array.from({ length: 101 }, (_, n) => ({ id: `b${n}`, sessionId: "s_1", state: "running", usedAt: 1 })) }),
	JSON.stringify({ kind: "removed", sandbox: "" }),
	JSON.stringify({ kind: "heartbeat", pad: "x".repeat(MAX_CONTROL_FRAME_BYTES) }),
	"[".repeat(100_000),
];
expect("a runner's frame that is not one is null, and nothing throws", never(parseRunnerFrame, junk));
expect("the same for the server's frames", never(parseServerFrame, [...junk, JSON.stringify({ kind: "attach", sessionId: "../x", ticket: "t" }), JSON.stringify({ kind: "welcome", idleSuspendMs: -5 })]));
expect("and for the HTTP answers", never(parsePairStatus, [...junk, { state: "approved", uid: "u_1", machineId: "m_short", githubLogin: null }]) && never(parseConnectionRefusal, [...junk, { reason: "clock" }]));

expect("a hello and a report pass", parseRunnerFrame(JSON.stringify(hello))?.kind === "hello"
	&& parseRunnerFrame(JSON.stringify({ kind: "report", docker: { ok: false, reason: "permission denied" }, commandSandbox: { ok: true }, freeDiskBytes: 12, sandboxes: [{ id: "m_0123456789abcdef-0123456789ab", sessionId: "s_0123456789abcdef", state: "paused", usedAt: 5 }] }))?.kind === "report");
const plainReport = { kind: "report", docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: 12, sandboxes: [] };
const harness = { id: "claude", adapter: "claude-agent-acp 0.109.0", image: "sha256:fixture", signIn: "none" };
expect("the server accepts each Claude sign-in state and refuses extra login fields or an unknown harness",
	["token", "none", "unknown"].every(signIn => parseRunnerFrame(JSON.stringify({ ...plainReport, harnesses: [{ ...harness, signIn }] }))?.kind === "report")
	&& [ { ...harness, signIn: "other" }, { ...harness, secret: "fixture" }, { ...harness, id: "other" } ].every(invalid =>
		parseRunnerFrame(JSON.stringify({ ...plainReport, harnesses: [invalid] })) === null));
const requestId = "f".repeat(32);
const url = "https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture";
const started = { kind: "harnessLogin.result", requestId, result: { url, expiresAt: Date.now() + 600_000 } };
for (const [operation, args] of [["start", {}], ["finish", { code: "fixture#state" }], ["cancel", {}]] as const) {
	const frame = { kind: "harnessLogin." + operation, requestId, ...args };
	expect("control delivers the pairing's login " + operation, parseServerFrame(JSON.stringify(frame))?.kind === frame.kind);
}
expect("control accepts only the public results of login", [started.result, { signedIn: true }, { cancelled: true }, { error: "Login failed." }]
	.every(result => parseRunnerFrame(JSON.stringify({ ...started, result }))?.kind === started.kind));
expect("control rejects an unsafe URL, extra login data, unbounded or multiline code and invalid request ids",
	[{ url: url.replace("claude.com", "claude.com.invalid"), expiresAt: 1 }, { url: url.replace("//", "//user@"), expiresAt: 1 },
	 { url: url + "&code_verifier=private", expiresAt: 1 }, { url: url + "a".repeat(8192), expiresAt: 1 }, { ...started.result, token: "fixture" }, { signedIn: false }].every(result =>
		parseRunnerFrame(JSON.stringify({ ...started, result })) === null)
	&& ["a".repeat(2049), "one\ntwo", "bad\r", "bad\u001b", ""].every(code => !parseServerFrame(JSON.stringify({ kind: "harnessLogin.finish", requestId, code })))
	&& !parseServerFrame(JSON.stringify({ kind: "harnessLogin.start", requestId: "a".repeat(128) })));
const capped = parseRunnerFrame(JSON.stringify({ ...plainReport, maxRunning: 2, maxSandboxes: 5 }));
expect("a report carries the caps its owner set, and a report with no caps also passes",
	capped?.kind === "report" && capped.maxRunning === 2 && capped.maxSandboxes === 5 && parseRunnerFrame(JSON.stringify(plainReport))?.kind === "report");
expect("a cap that is no positive whole number is not one", never(parseRunnerFrame, [0, -1, 1.5, "3", null].map((cap) => JSON.stringify({ ...plainReport, maxRunning: cap }))));
const refusals = [refuse("outdated", { runnerVersion: "0.0.9" }), refuse("removed", { removeSandboxes: true }), refuse("removed"), refuse("key-in-use"), refuse("unknown"), refuse("bad-frame")];
expect("every refusal the actor makes is one a runner reads as made", refusals.every((r) => JSON.stringify(parseServerFrame(JSON.stringify(r))) === JSON.stringify(r)));
const newer = parseServerFrame(JSON.stringify({ kind: "refused", reason: "suspended", until: 5, message: "Your account is suspended." }));
expect("a refusal of a newer server is read as \"other\" with its sentence", newer?.kind === "refused" && newer.reason === "other" && newer.message === "Your account is suspended.");

expect("a newer runner is served, an older one is not", versionAtLeast("0.10.0", "0.9.9") && versionAtLeast(MIN_RUNNER_VERSION, MIN_RUNNER_VERSION) && !versionAtLeast("0.0.9", "0.1.0") && !versionAtLeast("1.0", "0.1.0"));
const now = 1_000_000;
expect("the first runner is accepted", secondHello(null, { epoch: "a" }, now) === "accept");
expect("the same runner process replaces its socket without a record", secondHello({ epoch: "a", heardAt: now - 1 }, { epoch: "a" }, now) === "replace");
expect("another process while the first is live is refused", secondHello({ epoch: "a", heardAt: now - LIVE_MS }, { epoch: "b" }, now) === "refuse");
expect("another process after the first went quiet replaces it", secondHello({ epoch: "a", heardAt: now - LIVE_MS - 1 }, { epoch: "b" }, now) === "replace");

// Drive the real runner loop through HTTP answers and WebSocket events in memory.
const sockets: CheckSocket[] = [];
class CheckSocket extends EventTarget {
	readyState = 1;
	sent: { kind: string; sandbox?: string }[] = [];
	constructor() { super(); sockets.push(this); }
	send(text: string) {
		const { kind, sandbox } = JSON.parse(text);
		this.sent.push({ kind, sandbox });
	}
	frame(frame: ServerFrame) {
		assert.equal(this.readyState, 1);
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}
	close(code = 1000) {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
}
async function until(test: () => boolean) {
	const end = performance.now() + 5000;
	while (!test()) {
		assert.ok(performance.now() < end, "The runner did not handle the test event.");
		await wait(5);
	}
}

const dir = mkdtempSync(join(tmpdir(), "runner-control-check-"));
process.env.WLP_RUNNER_STATE_DIR = dir;
// The runner's bundle defines these; loading its source directly needs them first.
Object.assign(globalThis, { SANDBOX_IMAGE: "sha256:" + "0".repeat(64), SHOTS_IMAGE_PIN: "" });
const { control } = await import("../runner/src/control.js");
const { RunnerError } = await import("../runner/src/state.js");
const failedSandbox = "mm_0123456789abcdef-0123456789ab";
const auditRows = (): { operation: string; sandbox: string | null; outcome: string }[] =>
	readdirSync(dir).flatMap(file => readFileSync(join(dir, file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
const key = generateKeyPairSync("ed25519").privateKey;
const lease = (validForMs?: number) => Response.json({ endpoint: null, namespace: "default",
	token: validForMs === undefined ? null : { token: "fixture", validForMs, expiresAt: Date.now() + validForMs } });
const answer = (status: number, body: unknown = {}) => Response.json(body, { status });

async function withControl(answers: Response[], exercise: (runner: {
	status: string[]; online(socketIndex?: number): Promise<CheckSocket>; expireLease(): void; now(): number; requests(): number;
}) => Promise<void>) {
	const abort = new AbortController();
	const status: string[] = [];
	const realNow = Date.now, realFetch = globalThis.fetch, realSocket = globalThis.WebSocket;
	let clock = realNow(), requests = 0;
	sockets.length = 0;
	globalThis.WebSocket = CheckSocket as unknown as typeof WebSocket;
	Date.now = () => clock;
	globalThis.fetch = async () => answers[requests++] ?? answer(503);
	const owner = {
		identity: { uid: "u_check", machineId: "m_0123456789abcdef" },
		serial: async <T>(work: () => Promise<T>) => work(),
		welcome: async () => {}, report: () => plainReport,
		requestedRemoval: async (id: string) => { if (id === failedSandbox) throw new RunnerError("Docker could not remove the sandbox."); },
		suspendAll: async () => {},
	} as unknown as Executor;
	const done = control(owner, key, "https://runner-check.invalid", abort.signal, s => status.push(s), undefined);
	try {
		const test = exercise({ status, requests: () => requests, now: () => clock, expireLease: () => { clock += 2000; },
			async online(socketIndex = 0) {
				await until(() => sockets.length > socketIndex);
				const socket = sockets[socketIndex];
				socket.frame({ kind: "challenge", nonce: "a".repeat(43) });
				await until(() => socket.sent.some(f => f.kind === "hello"));
				socket.frame({ kind: "welcome", idleSuspendMs: 60_000 });
				await until(() => socket.sent.some(f => f.kind === "report"));
				return socket;
			} }).finally(() => abort.abort());
		const [loop, checks] = await Promise.allSettled([done, test]);
		if (loop.status === "rejected") throw loop.reason;
		if (checks.status === "rejected") throw checks.reason;
	} finally {
		Date.now = realNow; globalThis.fetch = realFetch; globalThis.WebSocket = realSocket;
	}
}

async function checkControl(name: string, run: () => Promise<void>) {
	try { await run(); expect(name, true); }
	catch (error) { expect(name, false); console.error(error instanceof Error ? error.message : "Runner check failed."); }
}
try {
	await checkControl("an idle stop reports the paused sandbox immediately", async () => {
		const machineId = "m_0123456789abcdef";
		Object.assign(globalThis, { SANDBOX_IMAGE: "sha256:" + "0".repeat(64) });
		const { Executor } = await import("../runner/src/docker-executor.js");
		const owner = new Executor({ uid: "u_owner", machineId }, {});
		const raw = "0123456789ab", id = `m${machineId}-${raw}`;
		owner.boxes.set(id, { raw, sessionId: "s_idle", state: "running", profile: "docker-hardened", usedAt: 0, busy: 0, workspaceChecked: true });
		owner.discover = async () => {};
		let stopped = false;
		owner.provider.suspend = async () => { stopped = true; };
		owner.provider.state = async () => stopped ? "paused" : "running";
		const reports: string[] = [];
		owner.publishReport = () => reports.push(owner.report().sandboxes[0]!.state);
		const cleanup = mock.method(DockerSandboxHandle.prototype, "removeFiles", async () => {});
		try {
			await owner.idle(1, () => false);
			assert.ok(stopped);
			assert.deepEqual(reports, ["paused"]);
		} finally { cleanup.mock.restore(); }
	});
	await checkControl("a failed renewal preserves the control and session sockets and retries on the next attach", async () => {
		const errors = [answer(429), answer(403, { reason: "removed", removeSandboxes: true }), answer(410, { reason: "unknown" }),
			answer(403, { reason: "clock", serverTime: Date.now() + 60_000 })];
		await withControl([lease(1000), ...errors, lease()], async r => {
			const ws = await r.online();
			ws.frame({ kind: "attach", sessionId: "s_live", ticket: "first" });
			await until(() => sockets[1]?.sent.some(f => f.kind === "hello") === true);
			r.expireLease();
			for (const error of errors) {
				const before = auditRows().length;
				ws.frame({ kind: "attach", sessionId: "s_new", ticket: "retry" });
				await until(() => auditRows().slice(before).some(row => row.operation === "attach" && row.outcome === "HTTP " + error.status));
				assert.equal(ws.readyState, 1, "Renewal closed the control socket.");
				assert.equal(sockets[1].readyState, 1, "Renewal closed the live session.");
				assert.equal(sockets.length, 2, "The failed attach opened a session socket.");
			}
			ws.frame({ kind: "attach", sessionId: "s_new", ticket: "fresh" });
			await until(() => sockets[2]?.sent.some(f => f.kind === "hello") === true);
			assert.equal(r.requests(), 1 + errors.length + 1);
			assert.equal(r.status.at(-1), "Online");
		});
		for (const refusal of [answer(403, { reason: "unknown" }), answer(410, { reason: "removed", removeSandboxes: false })]) {
			await withControl([lease(1000), refusal], async r => {
				const ws = await r.online();
				r.expireLease();
				ws.frame({ kind: "attach", sessionId: "s_new", ticket: "refused" });
				await until(() => ws.readyState === 3);
				assert.equal(sockets.length, 1);
			});
		}
	});
	await checkControl("failed pending sign-in cleanup is audited once and the runner reconnects with its session open", async () => {
		const { PageLogin } = await import("../runner/src/page-login.js");
		let pending: InstanceType<typeof PageLogin> | undefined;
		const failure = "Could not remove the Claude setup container.";
		const request = mock.method(PageLogin.prototype, "request", async function (this: InstanceType<typeof PageLogin>) {
			pending = this;
			return started.result;
		});
		const close = mock.method(PageLogin.prototype, "close", async function (this: InstanceType<typeof PageLogin>) {
			if (this === pending) {
				pending = undefined;
				throw new RunnerError(failure);
			}
		});
		try {
			await withControl([lease(), lease()], async r => {
				const ws = await r.online();
				ws.frame({ kind: "attach", sessionId: "s_live", ticket: "first" });
				await until(() => sockets[1]?.sent.some(f => f.kind === "hello") === true);
				const session = sockets[1];
				ws.frame({ kind: "harnessLogin.start", requestId });
				await until(() => ws.sent.some(f => f.kind === "harnessLogin.result"));
				assert.ok(pending);
				const before = auditRows().length;
				ws.close();
				await r.online(2);
				assert.equal(session.readyState, 1, "Disconnect stopped the live session.");
				const failures = auditRows().slice(before).filter(row => row.operation === "control" && row.outcome.includes(failure));
				assert.equal(failures.length, 1);
				assert.match(failures[0].outcome, /pending Claude sign-in/);
			});
		} finally { close.mock.restore(); request.mock.restore(); }
	});
	await checkControl("a failed removal is audited and left unacknowledged on the live control socket", async () => {
		await withControl([lease()], async r => {
			const ws = await r.online();
			ws.frame({ kind: "remove", sandbox: failedSandbox });
			await until(() => ws.readyState !== 1 || auditRows().some(row =>
				row.operation === "remove" && row.sandbox === failedSandbox && row.outcome === "Docker could not remove the sandbox."));
			assert.equal(ws.readyState, 1, "Removal closed the control socket.");
			const other = "mm_0123456789abcdef-111111111111";
			ws.frame({ kind: "remove", sandbox: other });
			await until(() => ws.sent.some(f => f.kind === "removed"));
			assert.deepEqual(ws.sent.filter(f => f.kind === "removed").map(f => f.sandbox), [other]);
			assert.equal(r.requests(), 1);
		});
	});
	await checkControl("status and log give the ten-minute retry time for HTTP and socket refusals", async () => {
		for (const code of [429, 1008, 4321]) {
			await withControl([code === 429 ? answer(code) : lease()], async r => {
				const reason = code === 429 ? "HTTP 429" : "socket close " + code;
				if (code !== 429) (await r.online()).close(code);
				await until(() => r.status.some(line => line.includes(reason)));
				const line = r.status.at(-1)!;
				assert.match(line, /try again in ten minutes/);
				assert.ok(line.includes(new Date(r.now() + REFUSED_RETRY_MS).toUTCString()));
				assert.ok(auditRows().some(row => row.operation === "control" && row.outcome === line));
			});
		}
	});
} finally {
	for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
	rmdirSync(dir);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exitCode = failures ? 1 : 0;
