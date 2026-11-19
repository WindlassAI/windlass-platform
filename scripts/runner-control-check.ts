/**
 * What the types of the control socket's module cannot show: input from the other side that is not a
 * frame is refused without throwing, every refusal the actor makes is one a runner can read, a newer
 * server's refusal still shows its sentence, and the rule for a second runner with one key.
 *
 *   cd server && npx tsx ../scripts/runner-control-check.ts
 */
import {
	LIVE_MS, MAX_CONTROL_FRAME_BYTES, MIN_RUNNER_VERSION, parseConnectionRefusal, parsePairStatus, parseRunnerFrame, parseServerFrame, refuse, secondHello, versionAtLeast,
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

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exitCode = failures ? 1 : 0;
