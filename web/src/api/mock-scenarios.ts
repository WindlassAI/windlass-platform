/** Recorded turns and prompt selection. The mock client owns playback state and timers. */
import type { WindlassEvent } from "@contract";
import { splitRuns, withSummary } from "./feed";
import { fixture } from "./fixtures";

export interface WorkspaceChange {
	status: string;
	diff: string;
}

/** The rest of a turn that stops at a question: one recording per kind of answer. */
export interface QuestionScript {
	approved: WindlassEvent[];
	declined: WindlassEvent[];
	/** Set when a subagent asks: the first line of its task. */
	subagent?: string;
}

/** A server the project's configuration names, as a prompt's words choose it. */
export interface MockServer {
	name: string;
	/** Stands for Windlass's mark of the definition: an approval is for it. */
	fingerprint: string;
	argv: string[];
	/** Variables the definition reads that are not set in the sandbox. */
	unset: string[];
	/** Reported while the turn runs, instead of before its prompt goes. */
	late: boolean;
}

export interface Script {
	/** For a turn with a question: everything up to and including its `approval.requested`. */
	events: WindlassEvent[];
	question?: QuestionScript;
	/** The project's server that waits for the user's approval in this turn. */
	server?: MockServer;
	/** Slows the recording down (2 plays it at half speed). */
	stretch?: number;
	workspace?: Record<string, WorkspaceChange>;
	/** The platform could not run the turn at all: no Windlass events, an "error" outcome with this message. */
	platformFailure?: string;
	/** With `platformFailure`: the sandbox's machine could not be reached, so the turn fails before its sandbox is opened. */
	unreachable?: boolean;
}

const run = (name: string, index = 0): WindlassEvent[] => splitRuns(fixture(name))[index] ?? [];

/** Internal replay marker consumed before events reach a client. */
export const MOCK_HOST_CALL = "mock.host_call";

/** A call of the platform's `push` or `fetch_base` in a scripted turn. `changed`: the files the turn changed by then, which the platform commits. */
interface MockHostCall {
	tool: "push" | "fetch_base";
	input: Record<string, unknown>;
	changed?: string[];
}

/** Mark synthetic platform tool calls so sessions without a repository can skip them. */
function withHostCalls(events: WindlassEvent[], calls: MockHostCall[]): WindlassEvent[] {
	const last = events.findLastIndex((event) => event.type === "step.started");
	const usage = { inputTokens: 9300, cachedInputTokens: 9100, outputTokens: 28, reasoningTokens: 0 };
	const added = calls.flatMap((call, index): WindlassEvent[] => {
		const messageId = `h${index + 1}`;
		const callId = `call_${call.tool}`;
		const host = { messageId, callId, host: true };
		return [
			{ type: "step.started", v: 1, seq: 0, data: { ...host, attempt: 1, model: "gpt-test" } },
			{ type: "tool.called", v: 1, seq: 0, data: { ...host, name: call.tool, input: JSON.stringify(call.input), providerData: null } },
			{ type: "tool.started", v: 1, seq: 0, data: { ...host, effect: "read" } },
			{ type: MOCK_HOST_CALL, data: { ...host, tool: call.tool, branch: call.input.branch ?? null, changed: call.changed ?? [] } },
			{ type: "step.ended", v: 1, seq: 0, data: { ...host, finish: "tool_calls", usage } },
		];
	});
	const out = [...events.slice(0, last), ...added, ...events.slice(last)];
	// The turn's summary counts the added steps.
	return out.map((event) => (event.type === "cli.summary" && typeof event.steps === "number" ? { ...event, steps: event.steps + calls.length } : event));
}

export const isHostEvent = (event: WindlassEvent): boolean => event.type === MOCK_HOST_CALL || (event.data ?? {}).host === true;

const ADD_TS_DIFF = `diff --git a/src/add.ts b/src/add.ts
index 3b1f0c2..9d2e7aa 100644
--- a/src/add.ts
+++ b/src/add.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number) {
-  return a - b
+  return a + b
 }
`;

const CHECKS_DIFF = `diff --git a/add.ts b/add.ts
index 1c9a0f4..5e8b7d1 100644
--- a/add.ts
+++ b/add.ts
@@ -1 +1 @@
-export const add = (a: number, b: number) => a - b
+export const add = (a: number, b: number) => a + b
`;

const TEST_DIFF = `diff --git a/a.test.ts b/a.test.ts
index 77c41de..0b9f3a2 100644
--- a/a.test.ts
+++ b/a.test.ts
@@ -1,7 +1,7 @@
 import { expect, test } from "bun:test"
 import { add } from "./add.ts"

 test("adds two numbers", () => {
-  expect(add(1, 1)).toBe(3)
+  expect(add(1, 1)).toBe(2)
 })

@@ -14,6 +14,10 @@ test("adds negative numbers", () => {
   expect(add(-1, -1)).toBe(-2)
 })

+test("adds zero", () => {
+  expect(add(0, 0)).toBe(0)
+})
+
 test("is commutative", () => {
   expect(add(2, 3)).toBe(add(3, 2))
 })
`;

const MADE_DIFF = `diff --git a/made.txt b/made.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/made.txt
@@ -0,0 +1 @@
+hello
`;

function backoffRecorder() {
	const events: WindlassEvent[] = [];
	const startedAt = 1794666100000;
	let time = startedAt;
	let seq = 0;
	let step = 0;
	let call = 0;
	const stored = (type: string, data: Record<string, unknown>, after: number) => {
		time += after;
		events.push({ type, v: 1, seq: ++seq, data, sessionId: "ses_demo", time });
	};
	const message = () => `a${step}`;
	const begin = (after = 200) => {
		step++;
		call = 0;
		stored("step.started", { messageId: message(), attempt: 1, model: "gpt-test" }, after);
	};
	const end = (finish: "tool_calls" | "stop" = "tool_calls") => stored("step.ended", { messageId: message(), finish, usage: { inputTokens: 4000 + step * 900, cachedInputTokens: 3200 + step * 850, outputTokens: 60, reasoningTokens: 12 } }, 60);
	const say = (text: string, after = 500) => stored("text.ended", { messageId: message(), text, providerData: null }, after);
	const think = (text: string) => stored("reasoning.ended", { messageId: message(), text, providerData: null }, 700);
	const tool = (name: string, input: Record<string, unknown>, effect: string, result: { output: string; display?: Record<string, unknown> | null; outcome?: string; ms?: number; progress?: string[] }) => {
		call++;
		const ids = { messageId: message(), callId: `call_${call}` };
		stored("tool.called", { ...ids, name, input: JSON.stringify(input), providerData: null }, 140);
		stored("tool.started", { ...ids, effect }, 40);
		const ms = result.ms ?? 220;
		const lines = result.progress ?? [];
		lines.forEach((_, index) => {
			time += Math.round(ms / (lines.length + 1));
			events.push({ type: "tool.progress", sessionId: "ses_demo", ...ids, text: lines.slice(0, index + 1).join("\n"), time });
		});
		stored("tool.settled", { ...ids, outcome: result.outcome ?? "success", output: result.output, truncation: null, attachments: [], display: result.display ?? null }, lines.length > 0 ? Math.round(ms / (lines.length + 1)) : ms);
	};
	const shell = (command: string, output: string, exitCode: number, ms: number, progress?: string[]) => tool("shell", { command }, "exec", { output, outcome: exitCode === 0 ? "success" : "error", display: { exitCode, signal: null, timedOut: false, interrupted: null, durationMs: ms }, ms, progress });
	const read = (path: string, lines: number) => tool("read", { path }, "read", { output: `1\t// ${path}\n…`, display: { path, offset: 1, lines, totalLines: lines } });
	const edit = (path: string, diff: string) => tool("edit", { path, old_string: "…", new_string: "…" }, "write", { output: `Edited ${path}: replaced 1 occurrence.`, display: { path, replacements: 1, diff } });

	function finish() {
		stored("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } }, 40);
		events.push({ type: "cli.summary", sessionId: "ses_demo", executionId: "exe_1", outcome: "succeeded", steps: step, summaryCalls: 0, requests: step, durationMs: time - startedAt, usage: { inputTokens: 58_000, cachedInputTokens: 51_200, outputTokens: 1480, reasoningTokens: 220 }, cachedShare: 0.883 });
		return events;
	}
	return { stored, begin, end, think, say, tool, read, edit, shell, finish };
}

/** An extended transcript for the retry-backoff demo. */
function backoffRun(): WindlassEvent[] {
	const { stored, begin, end, think, say, tool, read, edit, shell, finish } = backoffRecorder();
	stored("session.created", { cwd: "/repo", title: null, lineage: null, settings: { model: "gpt-test", reasoningEffort: "medium" } }, 0);
	stored("inbox.enqueued", { messageId: "u1", origin: null, delivery: "steer", content: [{ type: "text", text: "" }] }, 0);
	stored("execution.started", { executionId: "exe_1" }, 40);
	stored("inbox.delivered", { messageId: "u1" }, 80);

	begin();
	think("**Mapping the retry path**\n\nThe client retries in two places: the HTTP wrapper and the queue's consumer. I should read both before changing the delay.");
	say("I'll look at how the client retries requests before changing anything.");
	tool("glob", { pattern: "src/**/*.ts" }, "read", { output: "src/client/http.ts\nsrc/client/retry.ts\nsrc/client/retry.test.ts\nsrc/queue/consumer.ts", display: { files: 14 } });
	tool("grep", { pattern: "retry|backoff", path: "src" }, "read", { output: "src/client/http.ts:41:  return retry(() => send(request), policy)\nsrc/client/retry.ts:12:export function backoff(attempt: number) {", display: { matches: 9, files: 4, engine: "ripgrep" } });
	read("src/client/http.ts", 182);
	read("src/client/retry.ts", 64);
	end();

	begin();
	read("src/client/retry.test.ts", 120);
	read("src/queue/consumer.ts", 96);
	tool("grep", { pattern: "maxDelay", path: "src" }, "read", { output: "", display: { matches: 0, files: 0, engine: "ripgrep" } });
	read("package.json", 41);
	end();

	begin();
	say("The delay doubles with no ceiling, and the jitter is added after the point where a cap would apply. Capping it at 30 s and moving the jitter inside the cap.");
	edit("src/client/retry.ts", "--- a/src/client/retry.ts\n+++ b/src/client/retry.ts\n@@ -10,7 +10,9 @@\n+const MAX_DELAY_MS = 30_000\n+\n export function backoff(attempt: number) {\n-  const delay = BASE_MS * 2 ** attempt\n-  return delay + jitter()\n+  const delay = Math.min(BASE_MS * 2 ** attempt, MAX_DELAY_MS)\n+  return Math.min(delay + jitter(), MAX_DELAY_MS)\n }");
	edit("src/client/http.ts", "--- a/src/client/http.ts\n+++ b/src/client/http.ts\n@@ -39,3 +39,3 @@\n-  return retry(() => send(request), policy)\n+  return retry(() => send(request), { ...policy, maxDelayMs: 30_000 })\n");
	end();

	begin();
	shell("bun test src/client", "bun test v1.4.0\n\nsrc/client/retry.test.ts:\n✓ retry > gives up after five attempts\n✗ retry > waits longer each time [0.40ms]\n  error: expect(received).toBe(expected)\n  Expected: 64000\n  Received: 30000\n\n 11 pass\n 1 fail\n[Exit code 1]", 1, 2400);
	end();

	begin();
	say("One test expected the old, uncapped delay after six attempts. Updating it to the cap.");
	edit("src/client/retry.test.ts", "--- a/src/client/retry.test.ts\n+++ b/src/client/retry.test.ts\n@@ -22,5 +22,5 @@\n test(\"waits longer each time\", () => {\n-  expect(backoff(6)).toBe(64000)\n+  expect(backoff(6)).toBe(30000)\n })");
	shell("bun test src/client", "bun test v1.4.0\n\nsrc/client/retry.test.ts:\n✓ retry > gives up after five attempts\n✓ retry > waits longer each time\n\n 12 pass\n 0 fail", 0, 2100);
	end();

	begin();
	shell("bun run lint", "$ eslint src\n✔ No problems found", 0, 3100);
	shell("bun run typecheck", "$ tsc --noEmit", 0, 4200);
	end();

	begin();
	say("Now the full build and the whole suite.");
	const suite = ["$ tsc -p tsconfig.build.json", "$ bun build src/index.ts --outdir dist", "  dist/index.js  418.21 KB", "$ bun test", "bun test v1.4.0", ...["client/http", "client/retry", "queue/consumer", "queue/producer", "store/cache", "store/disk", "api/routes", "api/auth", "jobs/sweep", "jobs/export"].map((name, index) => `src/${name}.test.ts: ${[18, 12, 41, 27, 52, 33, 43, 21, 9, 16][index]} pass`), "", " 272 pass", " 0 fail", "Ran 272 tests across 10 files. [118.40s]"];
	shell("bun run build && bun test", suite.join("\n"), 0, 150_000, suite);
	end();

	begin();
	say("The delay is capped now, and everything passes.\n\n- **`src/client/retry.ts`**: `backoff()` stops at `MAX_DELAY_MS` (30 s), and the jitter stays inside the cap.\n- **`src/client/http.ts`**: the HTTP client passes the cap to `retry()`.\n- **`src/client/retry.test.ts`**: the test that expected 64 s after six attempts now expects the cap.\n\n`bun run lint`, `bun run typecheck`, the build and all 272 tests pass.", 900);
	end("stop");

	return finish();
}

function approvalRecording(name: string) {
	const events = withSummary(fixture(name));
	const question = events.findIndex(event => event.type === "approval.requested");
	return {
		messageId: String(events[question]?.data?.messageId),
		start: events.slice(0, question + 1),
		// Steering from the recording is replaced by messages sent during replay.
		rest: events.slice(question + 1).filter(event => !event.type.startsWith("inbox.")),
	};
}

function questionScript(subagent?: string): Script {
	const approved = approvalRecording("acp-approval-approved");
	const declined = approvalRecording("acp-approval-denied");
	// Both continuations answer the question from the approved recording.
	const denied = declined.rest.map(event => event.data?.messageId === declined.messageId
		? { ...event, data: { ...event.data, messageId: approved.messageId } }
		: event);
	return { events: approved.start, question: { approved: approved.rest, declined: denied, subagent }, stretch: 1.4 };
}

export const SCRIPTS = {
	fix: { events: run("demo-find-and-fix-a-failing-test"), workspace: { "src/add.ts": { status: " M", diff: ADD_TS_DIFF } } },
	parallel: { events: run("demo-two-parallel-tool-calls") },
	checks: { events: run("demo-the-checks-fail-the-model-fixes-the-code-and-they-pass"), workspace: { "add.ts": { status: " M", diff: CHECKS_DIFF } } },
	steps: { events: run("demo-several-steps-in-one-turn"), workspace: { "a.test.ts": { status: " M", diff: TEST_DIFF } } },
	build: { events: run("demo-a-long-build-command") },
	backoff: { events: backoffRun(), workspace: { "src/client/retry.ts": { status: " M", diff: "" }, "src/client/http.ts": { status: " M", diff: "" }, "src/client/retry.test.ts": { status: " M", diff: "" } } },
	answer: { events: run("demo-two-turns-in-one-session", 0) },
	answerAgain: { events: run("demo-two-turns-in-one-session", 1) },
	sandboxed: { events: run("real-scripted-bwrap"), workspace: { "made.txt": { status: "??", diff: MADE_DIFF } } },
	refused: { events: run("real-scripted-hardened") },
	usageLimit: { events: run("demo-a-non-retryable-error-usage-limit") },
	signedOut: { events: run("demo-a-non-retryable-error-authentication") },
	cancelled: { events: run("demo-cancel-while-one-tool-is-running") },
	network: questionScript(),
	subagentNetwork: questionScript("Check what the API's health endpoint returns"),
	// Four subagents: one finishes, one fails, the user stops one, and one runs in the background. Played slowly enough to watch them run.
	subagents: { events: run("acp-subagents"), stretch: 3 },
	crash: { events: [], platformFailure: "The sandbox stopped responding and the turn was abandoned. Nothing it had written was lost; send the prompt again to carry on." },
	// The fix, then the base fetched and the branch pushed by the agent: the platform commits the changed file, so nothing is left to push.
	agentPush: { events: withHostCalls(run("demo-find-and-fix-a-failing-test"), [{ tool: "fetch_base", input: {} }, { tool: "push", input: { message: "Make add() add" }, changed: ["src/add.ts"] }]) },
	// The fix, then a push to the repository's default branch, which is refused: the change stays in the workspace.
	agentPushRefused: { events: withHostCalls(run("demo-find-and-fix-a-failing-test"), [{ tool: "push", input: { branch: "main", message: "Make add() add" } }]), workspace: { "src/add.ts": { status: " M", diff: ADD_TS_DIFF } } },
} satisfies Record<string, Script>;

export type ScriptName = keyof typeof SCRIPTS;

/** What an unrecognised prompt plays, in turn. */
export const ROTATION: ScriptName[] = ["fix", "parallel", "checks", "steps", "build", "answer"];

export function chooseScript(text: string, rotation: number): ScriptName {
	const words = text.toLowerCase();
	if (/usage|limit|quota/.test(words)) return "usageLimit";
	if (/sign.?in|signed out|auth/.test(words)) return "signedOut";
	if (/crash/.test(words)) return "crash";
	if (/\bpush\b/.test(words)) return /\b(main|default branch)\b/.test(words) ? "agentPushRefused" : "agentPush";
	if (/\b(network|fetch|download|curl|https?|headers?|website|url)\b/.test(words)) return /subagent/.test(words) ? "subagentNetwork" : "network";
	if (/subagent/.test(words)) return "subagents";
	if (/backoff/.test(words)) return "backoff";
	if (/refus|approv|unattended|without the sandbox/.test(words)) return "refused";
	if (/sandbox/.test(words)) return "sandboxed";
	if (/build|slow|long|stop|cancel/.test(words)) return "build";
	if (/parallel|both files/.test(words)) return "parallel";
	if (/check/.test(words)) return "checks";
	if (/\d\s*[+*-]\s*\d/.test(words)) return "answer";
	return ROTATION[rotation % ROTATION.length] ?? "fix";
}

/** The server a prompt's words say the project names: "mcp", with "variable" for one that cannot start and "late" for one reported mid-turn. */
export function chooseServer(text: string): MockServer | null {
	const words = text.toLowerCase();
	if (!/\bmcp\b/.test(words)) return null;
	const unset = /\bvariables?\b/.test(words) ? ["HARBOR_TOKEN"] : [];
	return { name: "harbor", fingerprint: unset.length > 0 ? "748df09716dce52c" : "81498df752b8ef7d", argv: ["python3", "tools/harbor_mcp.py"], unset, late: /\blate\b/.test(words) };
}
