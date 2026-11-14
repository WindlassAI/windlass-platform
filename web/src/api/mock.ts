/**
 * The mock `PlatformClient`: the whole backend in memory, with no network.
 *
 * It serves a user with a handful of sessions in different states, the six sandbox profiles, and
 * plays the recorded `windlass --json` runs in fixtures/windlass-events/ as turns with their real
 * timing. Events are split the way contract.ts describes: durable events and `notice`,
 * `workspace.changes`, `cli.summary` are stored as timeline items; `text.delta`, `reasoning.delta`,
 * `tool.input.delta` and `tool.progress` are broadcast as deltas and kept in `pending` only until the
 * next durable event. `stop()` interrupts a turn the way Windlass winds one down.
 *
 * Interactive turns: a prompt about the network plays the ACP approval recording up to its question
 * and waits (`question`, status "waiting"); `answer()` carries on with the approved or the declined
 * recording, and a question nobody answers is declined by the platform after `questionTimeoutMs`.
 * A prompt sent while a turn runs steers it, and `stopCall()` stops one running call.
 *
 * The world is rebuilt from the token on every page load, so the seeded sessions keep their IDs
 * across a reload and sessions created by hand do not survive one.
 */
import {
	MAX_PROMPT_CHARS,
	MAX_RUNNING_SESSIONS,
	MAX_TITLE_CHARS,
	type AuthResult,
	type ChatgptStatus,
	type CreateSessionInput,
	type LiveDelta,
	type LoginStart,
	type PendingQuestion,
	type PlatformInfo,
	type PromptInput,
	type SandboxProfile,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type UserProfile,
	type WindlassEvent,
	type WorkspaceFile,
	MAX_NOTE_CHARS,
} from "@contract";
import { PlatformError, type PlatformClient, type SessionApi, type SessionFeed, type UserApi, type UserFeed } from "./client";
import { isDurable, isLive, schedule, splitRuns, turnEnded, withSummary } from "./feed";
import { fixture } from "./fixtures";

export interface MockOptions {
	/** Multiplies every wait: 1 is real time, 0 makes everything happen at once (still asynchronously). */
	pace?: number;
	now?: () => number;
	/** The address of the app, for the mock sign-in page. */
	origin?: string;
	/** How long a question waits before the platform declines it. Shorter than the real one by default. */
	questionTimeoutMs?: number;
}

export interface MockClient extends PlatformClient {
	/** Drops every live feed for `ms`, then reconnects them, as a network interruption would. */
	simulateDrop(ms: number): void;
	/**
	 * Makes the next `answer()` go wrong, for looking at the error by hand: "elsewhere" answers the
	 * question as another tab would have, then refuses with `no_question`; "error" fails as a request
	 * that never reached the server would, and leaves the question waiting.
	 */
	mockNextAnswer(kind: "elsewhere" | "error"): void;
}

/** The mock's question timeout: long enough to answer, short enough to watch the platform decline. */
export const MOCK_QUESTION_TIMEOUT_MS = 3 * 60_000;

// ---------------------------------------------------------------------------------------------
// What the mock serves
// ---------------------------------------------------------------------------------------------

const HOSTED_REASON = "A hosted VM cannot share the user's sign-in volume, so Windlass would have to accept a short-lived token handed in from outside, which it does not do yet.";

export const MOCK_PROFILES: SandboxProfile[] = [
	{
		id: "docker-windlass-sandbox",
		name: "Docker + Windlass sandbox",
		summary: "A container of its own, and every command the agent runs is sandboxed again by Windlass: no network, and the sign-in is out of its reach.",
		layers: ["Docker container (non-root, no capabilities, resource limits)", "Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace, credentials hidden)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadLogin: false,
		available: true,
	},
	{
		id: "docker-hardened",
		name: "Docker, hardened",
		summary: "A container under Docker's default seccomp and AppArmor profiles; commands run directly in it, with network, and can read the sign-in kept there.",
		layers: ["Docker container (default seccomp and AppArmor, non-root, no capabilities, resource limits)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadLogin: true,
		available: true,
	},
	{
		id: "e2b",
		name: "E2B",
		summary: "A Firecracker microVM hosted by E2B.",
		layers: ["E2B microVM"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason: HOSTED_REASON,
	},
	{
		id: "daytona",
		name: "Daytona",
		summary: "A workspace hosted by Daytona.",
		layers: ["Daytona workspace"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason: HOSTED_REASON.replace("VM", "workspace"),
	},
	{
		id: "firecracker",
		name: "Firecracker microVM",
		summary: "A microVM per session on this host.",
		layers: ["Firecracker microVM (KVM)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason: "It needs a host with KVM and a guest agent to run commands in the VM, and this deployment has neither.",
	},
	{
		id: "agentos",
		name: "agentOS",
		summary: "Rivet's agentOS, where the agent's tools run through a remote execution interface.",
		layers: ["agentOS runtime"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason: "agentOS cannot run the Windlass executable, and Windlass's tools would have to work through agentOS's remote execution interface, which they do not.",
	},
];

const MODELS = ["gpt-6.1-sol", "gpt-6-luna"];
const EFFORTS = ["low", "medium", "high"];
const REDIRECT_PREFIX = "http://127.0.0.1:1455/auth/callback";

interface WorkspaceChange {
	status: string;
	diff: string;
}

/** The rest of a turn that stops at a question: one recording per kind of answer. */
interface QuestionScript {
	approved: WindlassEvent[];
	declined: WindlassEvent[];
	/** Set when a subagent asks: the first line of its task. */
	subagent?: string;
}

interface Script {
	/** For a turn with a question: everything up to and including its `approval.requested`. */
	events: WindlassEvent[];
	question?: QuestionScript;
	/** Slows the recording down (2 plays it at half speed). */
	stretch?: number;
	workspace?: Record<string, WorkspaceChange>;
	/** The platform could not run the turn at all: no Windlass events, an "error" outcome with this message. */
	platformFailure?: string;
}

const run = (name: string, index = 0): WindlassEvent[] => splitRuns(fixture(name))[index] ?? [];

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

/**
 * The ACP approval recordings as a question script: the shared start up to the question, then the
 * approved or declined rest. The two runs have their own message IDs; the declined rest is given the
 * approved run's, since it continues the same call. The second message steered in while a command ran
 * is the recorder's, not the user's: it is left out, and the user's own steers are added by `prompt()`.
 */
function questionScript(subagent?: string): Script {
	const approved = withSummary(fixture("acp-approval-approved"));
	const declined = withSummary(fixture("acp-approval-denied"));
	const asked = (events: WindlassEvent[]) => events.findIndex((event) => event.type === "approval.requested");
	const messageOf = (events: WindlassEvent[]) => String((events[asked(events)]?.data ?? {}).messageId);
	const from = messageOf(declined);
	const to = messageOf(approved);
	const rest = (events: WindlassEvent[], rename: boolean) =>
		events
			.slice(asked(events) + 1)
			.filter((event) => !event.type.startsWith("inbox."))
			.map((event) => {
				if (!rename || event.data?.messageId !== from) return event;
				return { ...event, data: { ...event.data, messageId: to } };
			});
	return { events: approved.slice(0, asked(approved) + 1), question: { approved: rest(approved, false), declined: rest(declined, true), subagent }, stretch: 1.4 };
}

const SCRIPTS = {
	fix: { events: run("demo-find-and-fix-a-failing-test"), workspace: { "src/add.ts": { status: " M", diff: ADD_TS_DIFF } } },
	parallel: { events: run("demo-two-parallel-tool-calls") },
	checks: { events: run("demo-the-checks-fail-the-model-fixes-the-code-and-they-pass"), workspace: { "add.ts": { status: " M", diff: CHECKS_DIFF } } },
	steps: { events: run("demo-several-steps-in-one-turn"), workspace: { "a.test.ts": { status: " M", diff: TEST_DIFF } } },
	build: { events: run("demo-a-long-build-command") },
	answer: { events: run("demo-two-turns-in-one-session", 0) },
	answerAgain: { events: run("demo-two-turns-in-one-session", 1) },
	sandboxed: { events: run("real-scripted-bwrap"), workspace: { "made.txt": { status: "??", diff: MADE_DIFF } } },
	refused: { events: run("real-scripted-hardened") },
	usageLimit: { events: run("demo-a-non-retryable-error-usage-limit") },
	signedOut: { events: run("demo-a-non-retryable-error-authentication") },
	cancelled: { events: run("demo-cancel-while-one-tool-is-running") },
	network: questionScript(),
	subagentNetwork: questionScript("Check what the API's health endpoint returns"),
	crash: { events: [], platformFailure: "The sandbox stopped responding and the turn was abandoned. Nothing it had written was lost; send the prompt again to carry on." },
} satisfies Record<string, Script>;

type ScriptName = keyof typeof SCRIPTS;

/** What an unrecognised prompt plays, in turn. */
const ROTATION: ScriptName[] = ["fix", "parallel", "checks", "steps", "build", "answer"];

function chooseScript(text: string, rotation: number): ScriptName {
	const words = text.toLowerCase();
	if (/usage|limit|quota/.test(words)) return "usageLimit";
	if (/sign.?in|signed out|auth/.test(words)) return "signedOut";
	if (/crash/.test(words)) return "crash";
	if (/\b(network|fetch|download|curl|https?|headers?|website|url)\b/.test(words)) return /subagent/.test(words) ? "subagentNetwork" : "network";
	if (/refus|approv|unattended|without the sandbox/.test(words)) return "refused";
	if (/sandbox/.test(words)) return "sandboxed";
	if (/build|slow|long|stop|cancel/.test(words)) return "build";
	if (/parallel|both files/.test(words)) return "parallel";
	if (/check/.test(words)) return "checks";
	if (/\d\s*[+*-]\s*\d/.test(words)) return "answer";
	return ROTATION[rotation % ROTATION.length] ?? "fix";
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface RunningCall {
	messageId: string;
	callId: string;
	startedAt: number | null;
	progress: string;
}

interface Run {
	turn: number;
	startedAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	stopping: boolean;
	executionId: string | null;
	openStep: string | null;
	steps: number;
	usage: TurnUsage | null;
	text: Map<string, string>;
	calls: Map<string, RunningCall>;
	/** The steps being played and the index of the next one, so that playing can skip ahead. */
	plan: Step[];
	next: number;
	/** Steers enqueued and not yet delivered: their Windlass message IDs. */
	steers: string[];
	/** Calls the user stopped: what the recording still has of them is not played. */
	cancelled: Set<string>;
	/** Set after a call was stopped: what the model says next instead of what the recording says. */
	replaceText: string | null;
}

interface MockSession {
	summary: SessionSummary;
	/** The title was given by hand, so the first prompt does not replace it. */
	titled: boolean;
	windlassSessionId: string | null;
	windlassSeq: number;
	timeline: TimelineItem[];
	pending: LiveDelta[];
	seq: number;
	feeds: Set<SessionFeed>;
	run: Run | null;
	files: Map<string, WorkspaceChange>;
	pauseTimer: ReturnType<typeof setTimeout> | null;
	question: PendingQuestion | null;
	/** Declines the question when nobody answers it. */
	questionTimer: ReturnType<typeof setTimeout> | null;
	/** Carries the turn on once the question is answered. */
	resume: ((choice: string, note: string | null) => void) | null;
}

interface World {
	profile: UserProfile;
	sessions: Map<string, MockSession>;
	feeds: Set<UserFeed>;
	rotation: number;
}

interface Step {
	/** Milliseconds after the previous step. */
	wait: number;
	run: () => void;
	/** The call this step settles (`messageId/callId`), for skipping ahead when it is stopped. */
	settles?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function createMockClient(options: MockOptions = {}): MockClient {
	const pace = options.pace ?? 1;
	const questionTimeout = options.questionTimeoutMs ?? MOCK_QUESTION_TIMEOUT_MS;
	let nextAnswer: "elsewhere" | "error" | null = null;
	const realNow = options.now ?? (() => Date.now());
	const origin = options.origin ?? (typeof location === "undefined" ? "http://localhost:5173" : location.origin);
	/** Set while history is being written in the past (the seeded sessions). */
	let clock: number | null = null;
	const now = () => clock ?? realNow();

	const worlds = new Map<string, World>();
	const attempt: { state: string; expiresAt: number } = { state: "", expiresAt: 0 };
	let disposed = false;
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const later = (ms: number, action: () => void): ReturnType<typeof setTimeout> => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (!disposed) action();
		}, ms * pace);
		timers.add(timer);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | null) => {
		if (timer === null) return;
		clearTimeout(timer);
		timers.delete(timer);
	};
	/** The time a request takes. */
	const latency = (ms = 140) => new Promise<void>((resolve) => later(ms, resolve));

	// ---- identity -------------------------------------------------------------------------------

	const tokenFor = (profile: UserProfile) => `mock:${profile.demo ? "demo" : "chatgpt"}:${profile.uid}:${profile.email ?? ""}`;

	function worldOf(auth: AuthResult): World {
		const [scheme, kind, uid, email] = auth.token.split(":");
		if (scheme !== "mock" || !uid || uid !== auth.profile.uid || (kind !== "demo" && kind !== "chatgpt")) {
			throw new PlatformError("unauthorized", "This sign-in is no longer accepted. Sign in again.");
		}
		let world = worlds.get(uid);
		if (!world) {
			world = { profile: { uid, email: email || null, demo: kind === "demo" }, sessions: new Map(), feeds: new Set(), rotation: 0 };
			worlds.set(uid, world);
			seed(world);
		}
		return world;
	}

	// ---- sessions -------------------------------------------------------------------------------

	const profileOf = (session: MockSession): SandboxProfile => MOCK_PROFILES.find((profile) => profile.id === session.summary.profile) ?? (MOCK_PROFILES[0] as SandboxProfile);

	const listOf = (world: World): SessionSummary[] => [...world.sessions.values()].map((session) => session.summary).sort((a, b) => b.createdAt - a.createdAt);

	function setSummary(world: World, session: MockSession, patch: Partial<SessionSummary>): void {
		session.summary = { ...session.summary, ...patch };
		for (const feed of session.feeds) feed.onSummary(session.summary);
		const list = listOf(world);
		for (const feed of world.feeds) feed.onSessions(list);
	}

	function addSession(world: World, input: { id: string; title: string; titled: boolean; profile: SessionSummary["profile"]; model: string; repoUrl: string | null }): MockSession {
		const at = now();
		const session: MockSession = {
			summary: { id: input.id, title: input.title, profile: input.profile, model: input.model, repoUrl: input.repoUrl, createdAt: at, updatedAt: at, status: "idle", turns: 0, lastOutcome: null, sandbox: "none" },
			titled: input.titled,
			windlassSessionId: null,
			windlassSeq: 0,
			timeline: [],
			pending: [],
			seq: 0,
			feeds: new Set(),
			run: null,
			files: new Map(),
			pauseTimer: null,
			question: null,
			questionTimer: null,
			resume: null,
		};
		world.sessions.set(input.id, session);
		return session;
	}

	function store(session: MockSession, item: DistributiveOmit<TimelineItem, "seq" | "at">): void {
		const stored = { ...item, seq: ++session.seq, at: now() } as TimelineItem;
		session.timeline.push(stored);
		for (const feed of session.feeds) feed.onItem(stored);
	}

	/** One event of `windlass --json`, stored or broadcast as contract.ts says. */
	function emit(session: MockSession, turn: number, event: WindlassEvent): void {
		track(session, event);
		if (isLive(event)) {
			const delta: LiveDelta = { turn, event };
			session.pending.push(delta);
			for (const feed of session.feeds) feed.onDelta(delta);
			return;
		}
		// `pending` is the streaming output since the last durable event.
		if (isDurable(event)) session.pending = [];
		store(session, { turn, kind: "windlass", event });
	}

	function track(session: MockSession, event: WindlassEvent): void {
		const state = session.run;
		if (!state) return;
		const data = (event.data ?? event) as Record<string, unknown>;
		const messageId = typeof data.messageId === "string" ? data.messageId : "";
		const key = `${messageId}/${typeof data.callId === "string" ? data.callId : ""}`;
		switch (event.type) {
			case "execution.started":
				state.executionId = String(data.executionId);
				break;
			case "step.started":
				state.openStep = messageId;
				state.steps += 1;
				break;
			case "step.ended":
			case "step.failed": {
				state.openStep = null;
				const usage = data.usage as TurnUsage | null;
				if (usage) state.usage = addUsage(state.usage, usage);
				break;
			}
			case "text.delta":
				state.text.set(messageId, (state.text.get(messageId) ?? "") + String(data.text));
				break;
			case "text.ended":
				state.text.delete(messageId);
				break;
			case "tool.called":
				state.calls.set(key, { messageId, callId: String(data.callId), startedAt: null, progress: "" });
				break;
			case "tool.started": {
				const call = state.calls.get(key);
				if (call) call.startedAt = now();
				break;
			}
			case "tool.progress": {
				const call = state.calls.get(key);
				if (call) call.progress = String(data.text);
				break;
			}
			case "tool.settled":
				state.calls.delete(key);
				break;
		}
	}

	/** A recorded event as this session's Windlass would have written it now. */
	function restamp(session: MockSession, turn: number, event: WindlassEvent, prompt: string): WindlassEvent {
		const copy = structuredClone(event);
		copy.sessionId = session.windlassSessionId ?? undefined;
		const data = (copy.data ?? copy) as Record<string, unknown>;
		if (typeof data.messageId === "string") data.messageId = stampId(turn, data.messageId);
		if (isDurable(copy)) {
			copy.seq = ++session.windlassSeq;
			copy.time = now();
		}
		if (copy.type === "inbox.enqueued" && data.origin === null) data.content = [{ type: "text", text: prompt }];
		if (copy.type === "step.started") data.model = session.summary.model;
		return copy;
	}

	/** Everything a turn does, as timed steps. The same plan is run at once for history and on timers for a live turn. */
	function plan(world: World, session: MockSession, input: PromptInput, script: Script): Step[] {
		const turn = session.summary.turns + 1;
		const steps: Step[] = [];
		const first = session.windlassSessionId === null;

		steps.push({
			wait: 0,
			run: () => {
				const model = input.model ?? session.summary.model;
				session.run = { turn, startedAt: now(), timer: null, stopping: false, executionId: null, openStep: null, steps: 0, usage: null, text: new Map(), calls: new Map(), plan: [], next: 0, steers: [], cancelled: new Set(), replaceText: null };
				cancel(session.pauseTimer);
				session.pauseTimer = null;
				store(session, { turn, kind: "user", text: input.text, model, effort: input.effort ?? null });
				const title = !session.titled && session.summary.turns === 0 ? openingWords(input.text) : session.summary.title;
				setSummary(world, session, { status: "starting", model, title, updatedAt: now() });
			},
		});
		if (session.summary.sandbox === "none") {
			steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: `Creating sandbox: ${profileOf(session).name}` }) });
			if (session.summary.repoUrl !== null) {
				const repoUrl = session.summary.repoUrl;
				steps.push({ wait: 900, run: () => store(session, { turn, kind: "platform", level: "info", text: `Cloning ${repoUrl}` }) });
			}
		} else if (session.summary.sandbox === "paused") {
			steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: "Resuming the paused sandbox" }) });
		}
		steps.push({
			wait: 700,
			run: () => {
				if (first && script.platformFailure === undefined) session.windlassSessionId = `ses_${hex(24)}`;
				setSummary(world, session, { status: "running", sandbox: "running" });
			},
		});

		if (script.platformFailure !== undefined) {
			const message = script.platformFailure;
			steps.push({ wait: 2600, run: () => store(session, { turn, kind: "platform", level: "error", text: "The sandbox stopped answering." }) });
			steps.push({ wait: 400, run: () => finish(world, session, { outcome: "error", exitCode: null, steps: null, usage: null, cachedShare: null, message }) });
			return steps;
		}

		// Windlass writes `session.created` and freezes its prompt once per session, not once per run.
		const events = script.events.filter((event) => first || (event.type !== "session.created" && event.type !== "baseline.set"));
		steps.push(...eventSteps(world, session, turn, events, input, script));
		return steps;
	}

	/** Recorded events as timed steps: emitted as they are, with the turn's end and its question. */
	function eventSteps(world: World, session: MockSession, turn: number, events: WindlassEvent[], input: PromptInput, script: Script): Step[] {
		const stretch = script.stretch ?? 1;
		const offsets = schedule(events);
		return events.map((event, index): Step => {
			const wait = ((offsets[index] ?? 0) - (offsets[index - 1] ?? 0)) * stretch;
			const data = (event.data ?? event) as Record<string, unknown>;
			const key = `${stampId(turn, String(data.messageId))}/${String(data.callId)}`;
			if (event.type === "cli.summary") {
				return {
					wait,
					run: () => {
						emit(session, turn, restamp(session, turn, event, input.text));
						const ended = turnEnded(event, { seq: 0, at: 0, turn });
						for (const [path, change] of Object.entries(script.workspace ?? {})) session.files.set(path, change);
						finish(world, session, { outcome: ended.outcome, exitCode: ended.exitCode, steps: ended.steps, usage: ended.usage, cachedShare: ended.cachedShare, message: null, durationMs: clock === null ? undefined : ended.durationMs });
					},
				};
			}
			if (event.type === "approval.requested" && script.question) {
				const rest = script.question;
				return {
					wait,
					run: () => {
						const stamped = restamp(session, turn, event, input.text);
						emit(session, turn, stamped);
						ask(world, session, turn, stamped, input, script, rest);
					},
				};
			}
			return {
				wait,
				settles: event.type === "tool.settled" ? key : undefined,
				run: () => {
					const state = session.run;
					// What the recording still has of a call the user stopped did not happen.
					if (state?.cancelled.has(key) && (event.type === "tool.progress" || event.type === "tool.settled")) return;
					// Steered messages reach the model where a step begins.
					if (event.type === "step.started") deliverSteers(session, turn);
					if (state?.replaceText != null && event.type === "text.delta") return;
					const stamped = restamp(session, turn, event, input.text);
					if (state?.replaceText != null && event.type === "text.ended") {
						(stamped.data as Record<string, unknown>).text = state.replaceText;
						state.replaceText = null;
					}
					emit(session, turn, stamped);
				},
			};
		});
	}

	/** A Windlass event written now, by this session's Windlass. */
	function windlassEvent(session: MockSession, type: string, data: Record<string, unknown>): WindlassEvent {
		return { type, v: 1, data, sessionId: session.windlassSessionId ?? undefined, seq: ++session.windlassSeq, time: now() };
	}

	function deliverSteers(session: MockSession, turn: number): void {
		const state = session.run;
		if (!state) return;
		for (const messageId of state.steers.splice(0)) emit(session, turn, windlassEvent(session, "inbox.delivered", { messageId }));
	}

	function broadcastQuestion(session: MockSession): void {
		for (const feed of session.feeds) feed.onQuestion(session.question);
	}

	/** The turn reached its question: it waits for an answer, or for the platform to decline. */
	function ask(world: World, session: MockSession, turn: number, requested: WindlassEvent, input: PromptInput, script: Script, rest: QuestionScript): void {
		const data = (requested.data ?? {}) as Record<string, unknown>;
		const asked = (data.question ?? {}) as { title?: string; subject?: string; details?: string[]; choices?: Array<{ id: string; label: string; approve: boolean; remembers: string | null; grants?: unknown[] }> };
		const choices = asked.choices ?? [];
		const askedAt = now();
		session.question = {
			id: `q_${hex(16)}`,
			turn,
			messageId: String(data.messageId),
			callId: String(data.callId),
			title: asked.title ?? "",
			subject: asked.subject ?? "",
			details: asked.details ?? [],
			choices: choices.map(({ id, label, approve, remembers }) => ({ id, label, approve, remembers })),
			subagent: rest.subagent ?? null,
			askedAt,
			expiresAt: askedAt + questionTimeout,
		};
		broadcastQuestion(session);
		setSummary(world, session, { status: "waiting", updatedAt: now() });

		session.resume = (choiceId, note) => {
			const choice = choices.find((candidate) => candidate.id === choiceId);
			const approve = choice?.approve === true;
			const events = (approve ? rest.approved : rest.declined).map((event) => {
				if (event.type === "approval.answered") return { ...event, data: { ...event.data, choice: choiceId, approve, note, grants: (choice?.grants ?? []).map((grant) => ({ ...(grant as object), seq: session.windlassSeq + 1 })) } };
				if (event.type === "tool.settled" && !approve && event.data?.messageId === data.messageId && event.data?.callId === data.callId) {
					const output = note === null ? "Not run: the user declined this call." : `Not run: the user declined this call. Their note: ${note}`;
					return { ...event, data: { ...event.data, output } };
				}
				return event;
			});
			play(session, eventSteps(world, session, turn, events, input, script));
		};
		// History is written in the past; the timer is real time from now.
		session.questionTimer = later(Math.max(0, askedAt + questionTimeout - realNow()), () => {
			const question = session.question;
			if (!question) return;
			store(session, {
				turn,
				kind: "platform",
				level: "warn",
				text: `Nobody answered within ${minutes(questionTimeout)}, so the platform declined the call.`,
				code: "question_expired",
				call: { messageId: question.messageId, callId: question.callId },
			});
			settle(world, session, question.choices.find((choice) => !choice.approve)?.id ?? "deny", null);
		});
	}

	/** The question is answered: it goes, and the turn carries on. */
	function settle(world: World, session: MockSession, choice: string, note: string | null): void {
		const resume = session.resume;
		withdraw(session);
		if (!resume || !session.run) return;
		setSummary(world, session, { status: "running", updatedAt: now() });
		resume(choice, note);
	}

	/** The question goes without an answer (or before its answer is played). */
	function withdraw(session: MockSession): void {
		cancel(session.questionTimer);
		session.questionTimer = null;
		session.resume = null;
		if (session.question === null) return;
		session.question = null;
		broadcastQuestion(session);
	}

	function finish(
		world: World,
		session: MockSession,
		end: { outcome: TurnOutcome; exitCode: number | null; steps: number | null; usage: TurnUsage | null; cachedShare: number | null; message: string | null; durationMs?: number },
	): void {
		const state = session.run;
		if (!state) return;
		withdraw(session);
		session.run = null;
		session.pending = [];
		store(session, {
			turn: state.turn,
			kind: "turn.ended",
			outcome: end.outcome,
			exitCode: end.exitCode,
			steps: end.steps,
			durationMs: end.durationMs ?? now() - state.startedAt,
			usage: end.usage,
			cachedShare: end.cachedShare,
			message: end.message,
		});
		setSummary(world, session, { status: "idle", turns: state.turn, lastOutcome: end.outcome, updatedAt: now() });
		// An idle sandbox is paused after a while; its files stay.
		if (clock === null) {
			session.pauseTimer = later(90_000, () => {
				if (session.run === null && session.summary.sandbox === "running") setSummary(world, session, { sandbox: "paused" });
			});
		}
	}

	function play(session: MockSession, steps: Step[], index = 0): void {
		const state = session.run;
		const step = steps[index];
		if (!step || (index > 0 && (!state || state.stopping))) return;
		const proceed = () => {
			step.run();
			if (session.run) {
				session.run.plan = steps;
				session.run.next = index + 1;
			}
			play(session, steps, index + 1);
		};
		if (index === 0) proceed();
		else if (session.run) session.run.timer = later(step.wait, proceed);
	}

	/** Runs a whole turn at once, as history that began at `at`. */
	function playInstantly(steps: Step[], at: number): void {
		let time = at;
		for (const step of steps) {
			time += step.wait;
			clock = time;
			step.run();
		}
		clock = null;
	}

	/** Winds a running turn down the way Windlass does when the user stops it. */
	function interrupt(world: World, session: MockSession): void {
		const state = session.run;
		if (!state || state.stopping) return;
		state.stopping = true;
		cancel(state.timer);
		// A question still waiting is withdrawn: nobody can answer it any more.
		withdraw(session);
		setSummary(world, session, { status: "stopping" });
		const turn = state.turn;
		const windlass = (type: string, data: Record<string, unknown>): WindlassEvent => windlassEvent(session, type, data);

		if (state.executionId === null) {
			// Windlass had not started: there is nothing of its own to wind down.
			state.timer = later(300, () => {
				store(session, { turn, kind: "platform", level: "info", text: "Stopped before Windlass started." });
				finish(world, session, { outcome: "interrupted", exitCode: null, steps: null, usage: null, cachedShare: null, message: null });
			});
			return;
		}

		const executionId = state.executionId;
		const steps: Step[] = [{ wait: 120, run: () => emit(session, turn, windlass("execution.interrupt_requested", { executionId, reason: "user" })) }];
		// The visible part of an unfinished answer is kept.
		for (const [messageId, text] of state.text) steps.push({ wait: 40, run: () => emit(session, turn, windlass("text.ended", { messageId, text, providerData: null })) });
		for (const call of state.calls.values()) {
			steps.push({
				wait: 380,
				run: () => {
					const seconds = call.startedAt === null ? 0 : Math.max(1, Math.round((now() - call.startedAt) / 1000));
					const output = call.startedAt === null ? "Not run: the user stopped the response before this call started." : `Stopped by the user after ${seconds} s. Output so far:\n${call.progress}`;
					emit(session, turn, windlass("tool.settled", { messageId: call.messageId, callId: call.callId, outcome: call.startedAt === null ? "not_started" : "error", output, truncation: null, attachments: [], display: null }));
				},
			});
		}
		if (state.openStep !== null) {
			const messageId = state.openStep;
			steps.push({ wait: 40, run: () => emit(session, turn, windlass("step.failed", { messageId, error: { kind: "interrupted", reason: "user" }, usage: null })) });
		}
		steps.push({
			wait: 40,
			run: () => emit(session, turn, windlass("synthetic.appended", { messageId: `msg_t${turn}_s1`, origin: "interrupt", content: [{ type: "text", text: "The user stopped the previous response before it finished." }] })),
		});
		steps.push({ wait: 40, run: () => emit(session, turn, windlass("execution.interrupted", { executionId, reason: "user" })) });
		steps.push({
			wait: 60,
			run: () => {
				const usage = state.usage;
				const cachedShare = usage && usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000 : null;
				emit(session, turn, { type: "cli.summary", sessionId: session.windlassSessionId ?? undefined, executionId, outcome: "interrupted", steps: state.steps, summaryCalls: 0, requests: state.steps, durationMs: now() - state.startedAt, usage, cachedShare });
				finish(world, session, { outcome: "interrupted", exitCode: 130, steps: state.steps, usage, cachedShare, message: null });
			},
		});
		const runNext = (index: number) => {
			const step = steps[index];
			if (!step) return;
			state.timer = later(step.wait, () => {
				step.run();
				runNext(index + 1);
			});
		};
		runNext(0);
	}

	/** Stops one running call the way Windlass does: the request, then the call settles, and the turn goes on. */
	function stopOneCall(session: MockSession, messageId: string, callId: string): { stopped: boolean; message: string | null } {
		const state = session.run;
		if (!state || state.stopping) throw new PlatformError("user", "No turn is running.");
		const key = `${messageId}/${callId}`;
		const call = state.calls.get(key);
		if (!call) return { stopped: false, message: "That call is no longer running." };
		if (call.startedAt === null) return { stopped: false, message: "That call has not started, so there is nothing to stop yet." };
		if (state.cancelled.has(key)) return { stopped: false, message: "This call is already being stopped." };
		state.cancelled.add(key);
		const turn = state.turn;
		cancel(state.timer);
		emit(session, turn, windlassEvent(session, "tool.cancel_requested", { messageId, callId }));
		const startedAt = call.startedAt;
		state.timer = later(450, () => {
			if (session.run !== state || state.stopping) return;
			const seconds = Math.max(1, Math.round((now() - startedAt) / 1000));
			const output = `${call.progress === "" ? "" : `${call.progress}\n`}[Stopped by the user after ${seconds} s]`;
			emit(session, turn, windlassEvent(session, "tool.settled", { messageId, callId, outcome: "error", output, truncation: null, attachments: [], display: { exitCode: null, signal: "SIGTERM", timedOut: false, interrupted: "user", durationMs: now() - startedAt } }));
			state.replaceText = "You stopped that command before it finished, so I don't have its result. Tell me if you want me to run it again or try something else.";
			// Skip what the recording still had of the call.
			const settledAt = state.plan.findIndex((step, index) => index >= state.next && step.settles === key);
			play(session, state.plan, settledAt >= 0 ? settledAt + 1 : state.next);
		});
		return { stopped: true, message: null };
	}

	// ---- the seeded sessions --------------------------------------------------------------------

	function seed(world: World): void {
		const start = realNow();
		const history = (id: string, title: string, profile: SessionSummary["profile"], ago: number, turns: Array<{ text: string; script: ScriptName; effort?: string }>, extra: { repoUrl?: string; sandbox?: SessionSummary["sandbox"]; model?: string } = {}): MockSession => {
			clock = start - ago;
			const session = addSession(world, { id, title, titled: true, profile, model: extra.model ?? (MODELS[0] as string), repoUrl: extra.repoUrl ?? null });
			let at = start - ago;
			for (const turn of turns) {
				const steps = plan(world, session, { text: turn.text, effort: turn.effort }, SCRIPTS[turn.script]);
				playInstantly(steps, at);
				at = (session.timeline.at(-1)?.at ?? at) + 40_000;
			}
			clock = null;
			if (session.pauseTimer !== null) cancel(session.pauseTimer);
			session.summary = { ...session.summary, sandbox: extra.sandbox ?? (turns.length === 0 ? "none" : "paused") };
			return session;
		};

		history("scratch", "New agent", "docker-windlass-sandbox", 5 * 24 * HOUR, []).titled = false;
		history("deps", "Upgrade the dependencies", "docker-hardened", 3 * 24 * HOUR, [{ text: "Upgrade the dependencies to their latest minor versions and crash if anything breaks.", script: "crash" }], { sandbox: "none", repoUrl: "https://github.com/acme/harbor.git" });
		history("suite", "Run the whole test suite", "docker-windlass-sandbox", 2 * 24 * HOUR, [{ text: "Run the whole test suite and fix the failing test.", script: "cancelled", effort: "medium" }]);
		history("changelog", "Tidy the changelog", "docker-windlass-sandbox", 26 * HOUR, [{ text: "Tidy the changelog for the release.", script: "usageLimit" }], { model: MODELS[1] });
		history("checks", "Make add() pass its checks", "docker-windlass-sandbox", 21 * HOUR, [{ text: "Fix the failing test.", script: "checks", effort: "high" }]);
		history("unattended", "Run a command with nobody to approve it", "docker-hardened", 3 * HOUR, [{ text: "check the sandbox", script: "refused" }]);
		history("probe", "Check what the sandbox allows", "docker-windlass-sandbox", 2 * HOUR, [{ text: "check the sandbox", script: "sandboxed" }]);
		history(
			"add-test",
			"Fix the failing add test",
			"docker-windlass-sandbox",
			38 * MINUTE,
			[
				{ text: "The add test is failing. Find out why and fix it.", script: "fix", effort: "low" },
				{ text: "What is 1 + 1, to be sure?", script: "answer" },
			],
			{ sandbox: "running" },
		);

		// One agent waits on a question when the user arrives: it asked half a minute ago.
		const asking = history("headers", "Check the site's response headers", "docker-windlass-sandbox", 14 * MINUTE, [{ text: "What is 1 + 1, to be sure?", script: "answer" }], { sandbox: "running" });
		playInstantly(plan(world, asking, { text: "Fetch the response headers of example.com and tell me what server it runs.", effort: "low" }, SCRIPTS.network), start - 30_000);
		clock = null;

		// One agent is at work when the user arrives: a second turn, a long build, played slowly.
		const building = history("harbor-build", "Check the release build", "docker-windlass-sandbox", 6 * MINUTE, [{ text: "Fix the failing test.", script: "steps" }], { sandbox: "running", repoUrl: "https://github.com/acme/harbor.git" });
		play(building, plan(world, building, { text: "Run the full build and the tests, and tell me if they pass.", effort: "medium" }, { ...SCRIPTS.build, stretch: 7 }));
	}

	// ---- the interface --------------------------------------------------------------------------

	function userApi(auth: AuthResult): UserApi {
		const world = () => worldOf(auth);
		return {
			async me() {
				await latency();
				return world().profile;
			},
			async chatgpt(): Promise<ChatgptStatus> {
				await latency(220);
				const { profile } = world();
				return profile.demo ? { connected: false, email: null, accessExpiresAt: null } : { connected: true, email: profile.email, accessExpiresAt: now() + 52 * MINUTE };
			},
			async listSessions() {
				await latency();
				return listOf(world());
			},
			async createSession(input: CreateSessionInput) {
				await latency(260);
				const profile = MOCK_PROFILES.find((candidate) => candidate.id === input.profile);
				if (!profile) throw new PlatformError("user", "There is no such sandbox.");
				if (!profile.available) throw new PlatformError("user", `${profile.name} cannot be used yet. ${profile.unavailableReason ?? ""}`.trim());
				if (input.model !== undefined && !MODELS.includes(input.model)) throw new PlatformError("user", `There is no model called ${input.model}.`);
				const repoUrl = input.repoUrl?.trim() || null;
				if (repoUrl !== null && !/^https:\/\/\S+$/.test(repoUrl)) throw new PlatformError("user", "The repository must be an https address.");
				const title = input.title?.trim() ?? "";
				if (title.length > MAX_TITLE_CHARS) throw new PlatformError("user", `A title can be at most ${MAX_TITLE_CHARS} characters.`);
				const session = addSession(world(), { id: hex(10), title: title || "New agent", titled: title !== "", profile: profile.id, model: input.model ?? (MODELS[0] as string), repoUrl });
				setSummary(world(), session, {});
				return session.summary;
			},
			async renameSession(id: string, title: string) {
				await latency();
				const session = world().sessions.get(id);
				if (!session) throw new PlatformError("not_found", "That agent no longer exists.");
				const trimmed = title.trim();
				if (trimmed === "") throw new PlatformError("user", "A title cannot be empty.");
				if (trimmed.length > MAX_TITLE_CHARS) throw new PlatformError("user", `A title can be at most ${MAX_TITLE_CHARS} characters.`);
				session.titled = true;
				setSummary(world(), session, { title: trimmed });
				return session.summary;
			},
			async deleteSession(id: string) {
				await latency(300);
				const session = world().sessions.get(id);
				if (!session) return;
				cancel(session.run?.timer ?? null);
				cancel(session.pauseTimer);
				withdraw(session);
				session.run = null;
				world().sessions.delete(id);
				for (const feed of session.feeds) feed.onConnection("failed", new PlatformError("not_found", "This agent was deleted."));
				session.feeds.clear();
				const list = listOf(world());
				for (const feed of world().feeds) feed.onSessions(list);
			},
			watch(feed: UserFeed) {
				let closed = false;
				feed.onConnection?.("connecting");
				later(120, () => {
					if (closed) return;
					try {
						const current = world();
						current.feeds.add(feed);
						feed.onConnection?.("connected");
						feed.onSessions(listOf(current));
					} catch (error) {
						feed.onConnection?.("failed", asPlatformError(error));
					}
				});
				return () => {
					closed = true;
					worlds.get(auth.profile.uid)?.feeds.delete(feed);
				};
			},
		};
	}

	const snapshotOf = (session: MockSession): SessionSnapshot => ({
		summary: session.summary,
		profile: profileOf(session),
		windlassSessionId: session.windlassSessionId,
		timeline: [...session.timeline],
		pending: [...session.pending],
		question: session.question,
	});

	function sessionApi(auth: AuthResult, id: string): SessionApi {
		const find = (): { world: World; session: MockSession } => {
			const world = worldOf(auth);
			const session = world.sessions.get(id);
			if (!session) throw new PlatformError("not_found", "There is no agent at this address.");
			return { world, session };
		};
		return {
			open(feed: SessionFeed) {
				let closed = false;
				feed.onConnection("connecting");
				later(160, () => {
					if (closed) return;
					try {
						const { session } = find();
						session.feeds.add(feed);
						feed.onConnection("connected");
						feed.onSnapshot(snapshotOf(session));
					} catch (error) {
						feed.onConnection("failed", asPlatformError(error));
					}
				});
				return () => {
					closed = true;
					worlds.get(auth.profile.uid)?.sessions.get(id)?.feeds.delete(feed);
				};
			},
			resync() {
				later(60, () => {
					const session = worlds.get(auth.profile.uid)?.sessions.get(id);
					if (session) for (const feed of session.feeds) feed.onSnapshot(snapshotOf(session));
				});
			},
			async prompt(input: PromptInput) {
				await latency(180);
				const { world, session } = find();
				const text = input.text.trim();
				if (text === "") throw new PlatformError("user", "Write something for the agent to do.");
				if (text.length > MAX_PROMPT_CHARS) throw new PlatformError("user", `A prompt can be at most ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.`);
				const status = session.summary.status;
				if (status === "starting") throw new PlatformError("user", "The agent is still starting. Send this again once it is working.", { reason: "turn_running" });
				if (status === "stopping") throw new PlatformError("user", "The turn is stopping. Send this again once it has stopped.", { reason: "turn_running" });
				if ((status === "running" || status === "waiting") && session.run) {
					// A message to a running turn steers it: stored as a steer, delivered at the next step.
					const turn = session.run.turn;
					store(session, { turn, kind: "user", text, model: session.summary.model, effort: null, steer: true });
					const messageId = `msg_${hex(24)}`;
					emit(session, turn, windlassEvent(session, "inbox.enqueued", { messageId, origin: null, delivery: "steer", content: [{ type: "text", text }] }));
					session.run.steers.push(messageId);
					setSummary(world, session, { updatedAt: now() });
					return { turn, steered: true };
				}
				const running = [...world.sessions.values()].filter((other) => other.summary.status !== "idle").length;
				if (running >= MAX_RUNNING_SESSIONS) throw new PlatformError("user", `${MAX_RUNNING_SESSIONS} of your agents are already working. Wait for one to finish, or stop one.`);
				if (input.model !== undefined && !MODELS.includes(input.model)) throw new PlatformError("user", `There is no model called ${input.model}.`);
				const name = chooseScript(text, world.rotation);
				if (ROTATION[world.rotation % ROTATION.length] === name) world.rotation += 1;
				// A second plain answer in one session uses the recording's second run.
				const script = name === "answer" && session.windlassSessionId !== null ? SCRIPTS.answerAgain : SCRIPTS[name];
				const turn = session.summary.turns + 1;
				play(session, plan(world, session, { ...input, text }, script));
				return { turn, steered: false };
			},
			async answer(input: { questionId: string; choice: string; note?: string }) {
				await latency(220);
				const { world, session } = find();
				const forced = nextAnswer;
				nextAnswer = null;
				if (forced === "error") throw new PlatformError("network", "The server did not answer, so your answer was not sent. Try again.");
				const question = session.question;
				if (forced === "elsewhere" && question) settle(world, session, question.choices.find((choice) => choice.approve)?.id ?? "once", null);
				if (!session.question || session.question.id !== input.questionId) {
					throw new PlatformError("user", forced === "elsewhere" ? "This question was already answered in another tab." : "This question is no longer waiting for an answer: it was answered elsewhere, it expired, or the turn was stopped.", { reason: "no_question" });
				}
				if (!session.question.choices.some((choice) => choice.id === input.choice)) throw new PlatformError("user", "That is not one of the question's answers.");
				const note = input.note?.trim() ?? "";
				if (note.length > MAX_NOTE_CHARS) throw new PlatformError("user", `A note can be at most ${MAX_NOTE_CHARS} characters.`);
				settle(world, session, input.choice, note === "" ? null : note);
			},
			async stopCall(input: { messageId: string; callId: string }) {
				await latency(120);
				const { session } = find();
				return stopOneCall(session, input.messageId, input.callId);
			},
			async stop() {
				await latency(90);
				const { world, session } = find();
				interrupt(world, session);
			},
			async changes(): Promise<WorkspaceFile[]> {
				await latency(200);
				const { session } = find();
				return [...session.files.entries()].map(([path, change]) => ({ path, status: change.status })).sort((a, b) => a.path.localeCompare(b.path));
			},
			async diff() {
				await latency(320);
				const { session } = find();
				return [...session.files.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, change]) => change.diff)
					.join("");
			},
		};
	}

	return {
		kind: "mock",
		endpoint: null,
		async info(): Promise<PlatformInfo> {
			await latency(120);
			return { demoEnabled: true, windlassVersion: "0.1.0", profiles: MOCK_PROFILES, models: MODELS, efforts: EFFORTS };
		},
		login: {
			async start(): Promise<LoginStart> {
				await latency(400);
				attempt.state = hex(16);
				attempt.expiresAt = now() + 10 * MINUTE;
				const query = new URLSearchParams({ mock: "1", state: attempt.state, redirect_uri: REDIRECT_PREFIX });
				return { url: `${origin}/mock/authorize?${query}`, redirectPrefix: REDIRECT_PREFIX, expiresAt: attempt.expiresAt };
			},
			async finish(pastedUrl: string): Promise<AuthResult> {
				await latency(700);
				if (attempt.state === "") throw new PlatformError("user", "This sign-in attempt is not known. Start again.");
				if (now() > attempt.expiresAt) throw new PlatformError("user", "This sign-in attempt has expired. Start again.");
				const pasted = pastedUrl.trim();
				if (!pasted.startsWith(REDIRECT_PREFIX)) throw new PlatformError("user", `That is not the address the sign-in ends on. It starts with ${REDIRECT_PREFIX}.`);
				let params: URLSearchParams;
				try {
					params = new URL(pasted).searchParams;
				} catch {
					throw new PlatformError("user", "That is not a whole address. Copy everything in the address bar.");
				}
				const refused = params.get("error");
				if (refused !== null) throw new PlatformError("user", `OpenAI did not approve the sign-in (${refused}).`);
				if (!params.get("code")) throw new PlatformError("user", "That address has no sign-in code in it. Copy the whole address, including everything after the question mark.");
				if (params.get("state") !== attempt.state) throw new PlatformError("user", "That address belongs to another sign-in attempt. Start again.");
				attempt.state = "";
				const profile: UserProfile = { uid: "u_ada", email: "ada@example.com", demo: false };
				return { token: tokenFor(profile), profile };
			},
			async demo(): Promise<AuthResult> {
				await latency(500);
				const profile: UserProfile = { uid: `demo_${hex(8)}`, email: null, demo: true };
				return { token: tokenFor(profile), profile };
			},
		},
		user: userApi,
		session: sessionApi,
		dispose() {
			disposed = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
		mockNextAnswer(kind) {
			nextAnswer = kind;
		},
		simulateDrop(ms: number) {
			for (const world of worlds.values()) {
				for (const feed of world.feeds) feed.onConnection?.("reconnecting");
				for (const session of world.sessions.values()) for (const feed of session.feeds) feed.onConnection("reconnecting");
			}
			setTimeout(() => {
				for (const world of worlds.values()) {
					for (const feed of world.feeds) {
						feed.onConnection?.("connected");
						feed.onSessions(listOf(world));
					}
					for (const session of world.sessions.values()) {
						for (const feed of session.feeds) {
							feed.onConnection("connected");
							feed.onSnapshot(snapshotOf(session));
						}
					}
				}
			}, ms);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function asPlatformError(error: unknown): PlatformError {
	return error instanceof PlatformError ? error : new PlatformError("internal", "Something went wrong.", { cause: error });
}

function addUsage(a: TurnUsage | null, b: TurnUsage): TurnUsage {
	if (!a) return { ...b };
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
	};
}

function hex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, length);
}

/** The demo recordings reuse "a1", "u1" in every run; real message IDs are unique in a session. */
function stampId(turn: number, messageId: string): string {
	return messageId.startsWith("msg_") ? messageId : `msg_t${turn}_${messageId}`;
}

/** 180000 → "3 minutes". */
function minutes(ms: number): string {
	const value = Math.round(ms / 60_000);
	if (value >= 1) return `${value} ${value === 1 ? "minute" : "minutes"}`;
	const seconds = Math.round(ms / 1000);
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** A title from a prompt's opening words. */
export function openingWords(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	if (line.length <= 56) return line || "New agent";
	const cut = line.slice(0, 56);
	const space = cut.lastIndexOf(" ");
	return `${space > 24 ? cut.slice(0, space) : cut}…`;
}
