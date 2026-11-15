/**
 * `agentSession`, key [uid, sessionId]: one agent, its sandbox, its timeline and its turns.
 *
 * Stored in SQLite: one row with the session's settings and state (`meta`), and the timeline, one row
 * per item, numbered by a dense `seq`. In memory only: the turn in progress, the items not written
 * yet, and the streaming deltas a client that connects mid-turn still needs (`pending`).
 *
 * Actions interleave at every `await`, so the rules are:
 *   - `meta`, the `seq` counter and "is a turn running" live in memory and change in synchronous steps;
 *   - every write to SQLite goes through one queue (`serial`), so rows land in the order they were made
 *     and a snapshot reads a timeline no write is in the middle of.
 *
 * A turn in progress can be talked to. Windlass may ask a question (a tool call that needs approval):
 * the question lives on the turn's own record in memory and nowhere else, so it cannot outlast the
 * turn, a sleep or a restart; `answer()` settles it, as does the platform when nobody answers in time.
 * `prompt()` during a turn steers it, and `stopCall()` stops one running tool call.
 *
 * Codes of the UserErrors the contract's actions throw, besides those of auth.ts:
 *   session_not_found   the session was deleted, or never properly created
 *   empty_prompt, prompt_too_long, bad_effort, bad_model   `prompt()`: its input
 *   chatgpt_required    `prompt()`: the user has no ChatGPT sign-in
 *   too_many_running    `prompt()`: MAX_RUNNING_SESSIONS of the user's sessions are busy
 *   turn_running        `prompt()`: a turn is in progress and cannot take the message now
 *   bad_answer, note_too_long   `answer()`: its input
 *   no_question         `answer()`: that question is not pending (any more)
 *   bad_choice          `answer()`: the question does not offer that choice
 *   bad_call            `stopCall()`: its input
 *   no_turn             `stopCall()`: no turn is running
 *   sandbox_error, internal_error   a failure of the sandbox layer, with or without a sentence for the user
 */

import { randomBytes } from "node:crypto";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, describeError, isSandboxUserError, maySubscribe, requireService, requireUser } from "../auth.js";
import { config } from "../config.js";
import {
	type LiveDelta,
	MAX_NOTE_CHARS,
	MAX_PROMPT_CHARS,
	MAX_RUNNING_SESSIONS,
	type PendingQuestion,
	type PromptInput,
	type SandboxProfileId,
	type SessionSnapshot,
	type SessionStatus,
	type SessionSummary,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type WindlassEvent,
	type WorkspaceFile,
} from "../contract.js";
import { getLayer } from "../layer.js";
import { EFFORTS, platformModels } from "../platform-info.js";
import type { RunTurnResult, SandboxHandle, SandboxLayer, TurnAnswer, TurnControl, TurnQuestion } from "../sandbox/api.js";
import { grantIsValid, type SessionCreateInput, userActor } from "./internal.js";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

const CLONE_TIMEOUT_MS = 3 * 60 * 1000;
/** How long one turn may run before the platform stops it. WLP_TURN_TIMEOUT_MS overrides it. */
const TURN_TIMEOUT_MS = Number(process.env.WLP_TURN_TIMEOUT_MS) > 0 ? Number(process.env.WLP_TURN_TIMEOUT_MS) : 45 * 60 * 1000;
const GIT_TIMEOUT_MS = 30 * 1000;
const MAX_DIFF_CHARS = 400_000;
/** Timeline rows per INSERT statement. */
const WRITE_BATCH = 100;
/** Items wait at most this long before they are written, or until this many have gathered. */
const FLUSH_DELAY_MS = 100;
const FLUSH_AT = 200;
/** The most streaming deltas kept for late joiners; the oldest go first. */
const MAX_PENDING = 5_000;
/** How long a positive ChatGPT sign-in check is trusted before a prompt asks again. */
const SIGNED_IN_FRESH_MS = 5 * 60 * 1000;
/** How long shutdown waits for a stopped turn to wind down. */
const STOP_WAIT_MS = 12_000;
/** How long the end of a turn, or shutdown, waits for the `user` actor to take the new summary. */
const REPORT_WAIT_MS = 5_000;

const DELTA_TYPES = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]);
const WINDLASS_OUTCOMES: readonly TurnOutcome[] = ["succeeded", "unresolved", "failed", "stopped", "interrupted"];

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface SessionMeta {
	uid: string;
	sessionId: string;
	demo: boolean;
	title: string;
	titleIsDefault: boolean;
	profile: SandboxProfileId;
	model: string;
	repoUrl: string | null;
	createdAt: number;
	updatedAt: number;
	status: SessionStatus;
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** The sandbox this session was given, kept when it turns out to be gone so the next turn can say so. */
	sandboxId: string | null;
	sandbox: "none" | "running" | "paused";
	/** Whether `repoUrl` has been cloned into the current sandbox. */
	cloned: boolean;
	windlassSessionId: string | null;
	turnStartedAt: number | null;
}

/** A question put to the user: the copy the clients see, and the ways to settle the layer's promise. */
interface Asked {
	pending: PendingQuestion;
	/** Declines it for the platform when nobody answers. */
	timer: ReturnType<typeof setTimeout>;
	/** Each settles the promise the layer waits on; only the first call of either does anything. */
	answer(answer: TurnAnswer): void;
	decline(note?: string): void;
}

interface ActiveTurn {
	number: number;
	effort: string | null;
	controller: AbortController;
	done: Promise<void>;
	/** The layer's handle for steering the turn and stopping one call; null until Windlass has started it. */
	control: TurnControl | null;
	/** The question the turn waits on. It is held here and nowhere else: when the turn goes, so does it. */
	question: Asked | null;
	/** The questions of this turn whose promise the layer may still be waiting on. */
	unsettled: Set<Asked>;
	/** True once the turn is being closed: nothing of it can be steered, stopped or answered any more. */
	closed: boolean;
}

interface SessionVars {
	/** Null for an actor that `user` did not create: it rejects everything and removes itself. */
	meta: SessionMeta | null;
	nextSeq: number;
	/** Timeline items not yet in SQLite, in `seq` order. */
	unwritten: TimelineItem[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	/** True while a write of the waiting items is queued and has not started. */
	flushQueued: boolean;
	/** The tail of the write queue. */
	serial: Promise<unknown>;
	pending: LiveDelta[];
	turn: ActiveTurn | null;
	/** True while `prompt` is deciding, so a second prompt cannot slip in between its awaits. */
	accepting: boolean;
	destroying: boolean;
	/** True once the actor is going to sleep or being destroyed. */
	stopping: boolean;
	reporting: Promise<void> | null;
	reportAgain: boolean;
	signedInUntil: number;
}

/** What the helpers below need of an actor context; every hook's and action's `c` fits. */
interface Ctx {
	vars: SessionVars;
	db: RawAccess;
	key: string[];
	log: { info(entry: unknown): void; warn(entry: unknown): void; error(entry: unknown): void };
	broadcast(name: string, ...args: unknown[]): void;
	// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
	client(): any;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
}

type NewItem =
	| Omit<Extract<TimelineItem, { kind: "user" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "platform" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "windlass" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "turn.ended" }>, "seq" | "at">;

/** A failure of a turn whose message is fit to show as it is. */
class TurnProblem extends Error {}

function summaryOf(meta: SessionMeta): SessionSummary {
	return {
		id: meta.sessionId,
		title: meta.title,
		profile: meta.profile,
		model: meta.model,
		repoUrl: meta.repoUrl,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		status: meta.status,
		turns: meta.turns,
		lastOutcome: meta.lastOutcome,
		sandbox: meta.sandbox,
	};
}

function liveMeta(c: Ctx): SessionMeta {
	const meta = c.vars.meta;
	if (!meta || c.vars.destroying) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	return meta;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** Runs `job` after every job queued before it, whether those succeeded or not. */
function serial<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.serial.then(job, job);
	c.vars.serial = run.catch(() => undefined);
	return run;
}

/** Writes the waiting items, a batch per statement. Only ever called from inside the queue. */
async function writeItems(c: Ctx): Promise<void> {
	const waiting = c.vars.unwritten;
	while (waiting.length > 0) {
		const batch = waiting.slice(0, WRITE_BATCH);
		await c.db.execute(
			`INSERT OR REPLACE INTO timeline (seq, turn, kind, at, item) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
			...batch.flatMap((item) => [item.seq, item.turn, item.kind, item.at, JSON.stringify(item)]),
		);
		// Items made meanwhile were added behind the batch.
		waiting.splice(0, batch.length);
	}
}

/** Brings SQLite up to date with memory: the waiting items and the meta row. Never throws. */
function persist(c: Ctx): Promise<void> {
	if (c.vars.flushTimer) {
		clearTimeout(c.vars.flushTimer);
		c.vars.flushTimer = null;
	}
	return serial(c, async () => {
		await writeItems(c);
		if (c.vars.meta) await c.db.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(c.vars.meta));
	}).catch((error) => {
		// The items stay in `unwritten`, so the next write tries again and snapshots still show them.
		c.log.error({ msg: "could not write the session to SQLite", error: describeError(error) });
	});
}

function queueWrite(c: Ctx): void {
	if (c.vars.flushQueued) return;
	c.vars.flushQueued = true;
	void serial(c, async () => {
		c.vars.flushQueued = false;
		await writeItems(c);
	}).catch((error) => {
		c.log.error({ msg: "could not write the timeline to SQLite", error: describeError(error) });
	});
}

/** A turn can produce thousands of items: they are written in batches, shortly after they are made. */
function scheduleWrite(c: Ctx): void {
	if (c.vars.flushQueued) return;
	if (c.vars.unwritten.length >= FLUSH_AT) {
		queueWrite(c);
		return;
	}
	if (c.vars.flushTimer) return;
	c.vars.flushTimer = setTimeout(() => {
		c.vars.flushTimer = null;
		queueWrite(c);
	}, FLUSH_DELAY_MS);
}

/** Adds an item to the timeline: numbers it, announces it, and queues it for SQLite. Synchronous. */
function append(c: Ctx, item: NewItem): TimelineItem {
	const full = { ...item, seq: c.vars.nextSeq, at: Date.now() } as TimelineItem;
	c.vars.nextSeq += 1;
	c.vars.unwritten.push(full);
	c.broadcast("item", full);
	scheduleWrite(c);
	return full;
}

function note(
	c: Ctx,
	turn: number,
	level: "info" | "warn" | "error",
	text: string,
	mark: { code: "question_expired"; call: { messageId: string; callId: string } } | null = null,
): void {
	append(c, { turn, kind: "platform", level, text, ...(mark ?? {}) });
}

// ---------------------------------------------------------------------------------------------
// Announcing
// ---------------------------------------------------------------------------------------------

/** Sends summaries to the `user` actor until the newest one has been sent. */
async function reportLoop(c: Ctx): Promise<void> {
	// Yields first, so that `report` has stored this promise before the loop can possibly end.
	await Promise.resolve();
	try {
		while (c.vars.reportAgain && c.vars.meta) {
			c.vars.reportAgain = false;
			try {
				await userActor(c, c.vars.meta.uid).internalSessionChanged(summaryOf(c.vars.meta));
			} catch (error) {
				c.log.warn({ msg: "could not report the session's summary to its user", error: describeError(error) });
			}
		}
	} finally {
		// In the same step as the loop's last check: a `report` that comes later starts a new loop.
		c.vars.reporting = null;
	}
}

/** Sends the newest summary to the `user` actor; calls that arrive meanwhile collapse into one more. */
function report(c: Ctx): Promise<void> {
	c.vars.reportAgain = true;
	if (c.vars.reporting) return c.vars.reporting;
	const loop = reportLoop(c);
	c.vars.reporting = loop;
	// The report is short; holding the actor awake for it keeps the user's list from going stale.
	// During shutdown nothing new can be held awake: `onSleep` waits for the report itself.
	if (!c.vars.stopping) void c.keepAwake(loop);
	return loop;
}

/** Tells connected clients and the `user` actor that the summary changed. */
function publish(c: Ctx): void {
	const meta = c.vars.meta;
	if (!meta) return;
	c.broadcast("summary", summaryOf(meta));
	void report(c);
}

function noteSandbox(c: Ctx, meta: SessionMeta, state: SessionMeta["sandbox"]): void {
	if (meta.sandbox === state) return;
	meta.sandbox = state;
	publish(c);
	void persist(c);
}

// ---------------------------------------------------------------------------------------------
// The streaming state kept for clients that connect mid-turn
// ---------------------------------------------------------------------------------------------

function keepDelta(vars: SessionVars, delta: LiveDelta): void {
	vars.pending.push(delta);
	if (vars.pending.length > MAX_PENDING) vars.pending.splice(0, vars.pending.length - MAX_PENDING + 500);
}

/**
 * Drops the deltas a durable event makes redundant: the event carries what they were building up to.
 * `text.ended` replaces the message's text deltas, `reasoning.ended` its reasoning deltas, `tool.called`
 * a call's input deltas, `tool.settled` a call's progress, and the end of a step everything of its message.
 */
function settleDeltas(vars: SessionVars, durable: WindlassEvent): void {
	if (vars.pending.length === 0) return;
	const data = durable.data ?? {};
	const messageId = data.messageId;
	const callId = data.callId;
	let redundant: (event: WindlassEvent) => boolean;
	switch (durable.type) {
		case "text.ended":
			redundant = (event) => event.type === "text.delta" && event.messageId === messageId;
			break;
		case "reasoning.ended":
			redundant = (event) => event.type === "reasoning.delta" && event.messageId === messageId;
			break;
		case "tool.called":
			redundant = (event) => event.type === "tool.input.delta" && event.messageId === messageId && event.callId === callId;
			break;
		case "tool.settled":
			redundant = (event) => (event.type === "tool.progress" || event.type === "tool.input.delta") && event.messageId === messageId && event.callId === callId;
			break;
		case "step.ended":
		case "step.failed":
			redundant = (event) => event.messageId === messageId;
			break;
		case "execution.succeeded":
		case "execution.failed":
		case "execution.interrupted":
			redundant = () => true;
			break;
		default:
			return;
	}
	vars.pending = vars.pending.filter((delta) => !redundant(delta.event));
}

function onWindlassEvent(c: Ctx, meta: SessionMeta, turn: number, event: WindlassEvent): void {
	if (typeof event !== "object" || event === null || typeof event.type !== "string") return;
	if (typeof event.sessionId === "string" && event.sessionId !== "" && meta.windlassSessionId !== event.sessionId) {
		// Remembered at once: if this turn is lost, the next one can still continue Windlass's session.
		meta.windlassSessionId = event.sessionId;
	}
	if (DELTA_TYPES.has(event.type)) {
		const delta: LiveDelta = { turn, event };
		keepDelta(c.vars, delta);
		c.broadcast("delta", delta);
		return;
	}
	settleDeltas(c.vars, event);
	append(c, { turn, kind: "windlass", event });
}

// ---------------------------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------------------------

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Clones into the workspace. A new sandbox's workspace holds an empty repository and nothing else, which
 * the clone replaces; if anything else is there, the clone goes into a directory of its own.
 */
function cloneCommand(repoUrl: string): string {
	const url = shellQuote(repoUrl);
	const name = (repoUrl.replace(/\/+$/, "").split("/").pop() ?? "repo").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
	return [
		"set -e",
		"export GIT_TERMINAL_PROMPT=0",
		`if [ -z "$(ls -A | grep -v '^\\.git$' || true)" ]; then`,
		"  rm -rf .git",
		`  git clone --quiet -- ${url} .`,
		"else",
		`  git clone --quiet -- ${url} ${shellQuote(name)}`,
		"fi",
	].join("\n");
}

/** `git status`, without taking a lock an agent's own git command could trip over. */
const STATUS_COMMAND = "git --no-optional-locks status --porcelain=v1 -z --untracked-files=all";

/**
 * `git diff` against the last commit with new files included. The equivalent of `git add -N .` is done
 * on a copy of the index, so the workspace's own index is left as the agent has it.
 */
const DIFF_COMMAND = [
	"set -e",
	"tmp=$(mktemp)",
	`trap 'rm -f "$tmp" "$tmp.lock"' EXIT`,
	"index=$(git rev-parse --git-path index)",
	`if [ -f "$index" ]; then cp "$index" "$tmp"; else rm -f "$tmp"; fi`,
	`export GIT_INDEX_FILE="$tmp"`,
	"git add -N . >/dev/null 2>&1 || true",
	// Without a commit there is nothing to compare with but the empty tree.
	"if git rev-parse -q --verify HEAD >/dev/null; then base=HEAD; else base=4b825dc642cb6eb9a060e54bf8d69288fbee4904; fi",
	`git --no-pager diff --no-color --no-ext-diff "$base" | head -c ${MAX_DIFF_CHARS}`,
].join("\n");

function parseStatus(output: string): WorkspaceFile[] {
	const files: WorkspaceFile[] = [];
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (field.length < 4) continue;
		const status = field.slice(0, 2);
		files.push({ path: field.slice(3), status });
		// A rename or copy is followed by the path it came from.
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	return files;
}

function tail(text: string, lines = 6, chars = 800): string {
	const kept = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.slice(-lines)
		.join("\n");
	return kept.length > chars ? kept.slice(-chars) : kept;
}

/** Connects to the session's sandbox for a turn, creating it (and cloning the repository) when needed. */
async function openSandbox(c: Ctx, meta: SessionMeta, turn: number, signal: AbortSignal, layer: SandboxLayer): Promise<SandboxHandle> {
	let handle = meta.sandboxId ? await layer.sandboxes.connect(meta.sandboxId) : undefined;
	if (handle) {
		if (meta.sandbox === "paused") note(c, turn, "info", "Resuming sandbox");
		noteSandbox(c, meta, "running");
	} else {
		if (meta.sandboxId) {
			note(c, turn, "warn", "The sandbox this agent was working in no longer exists, so the files it had there are gone. Starting again in a new sandbox.");
			meta.sandbox = "none";
			meta.cloned = false;
		}
		note(c, turn, "info", "Creating sandbox");
		const id = await layer.sandboxes.create({ uid: meta.uid, sessionId: meta.sessionId, profile: meta.profile });
		console.log(`[wlp] sandbox.created id=${id} session=${meta.sessionId}`);
		meta.sandboxId = id;
		meta.sandbox = "running";
		publish(c);
		await persist(c);
		if (c.vars.destroying) {
			// The session was deleted while its sandbox was being made.
			await layer.sandboxes.destroy(id);
			throw new TurnProblem("The agent was deleted.");
		}
		handle = await layer.sandboxes.connect(id);
		if (!handle) throw new TurnProblem("The new sandbox disappeared right after it was created.");
	}

	if (meta.repoUrl && !meta.cloned && !signal.aborted) {
		note(c, turn, "info", `Cloning ${meta.repoUrl}`);
		const cloned = await handle.run(cloneCommand(meta.repoUrl), { timeoutMs: CLONE_TIMEOUT_MS, signal });
		if (cloned.aborted || signal.aborted) return handle;
		if (cloned.timedOut) throw new TurnProblem(`Cloning ${meta.repoUrl} took longer than ${CLONE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
		if (cloned.exitCode !== 0) {
			const why = tail(cloned.stderr || cloned.stdout, 4, 500);
			throw new TurnProblem(`Cloning ${meta.repoUrl} failed${why ? `: ${why}` : ` (exit code ${cloned.exitCode}).`}`);
		}
		meta.cloned = true;
		void persist(c);
	}
	return handle;
}

/** Asks the sandbox layer what state the sandbox is really in. */
async function refreshSandbox(c: Ctx, meta: SessionMeta): Promise<void> {
	if (!meta.sandboxId) return;
	try {
		const { sandboxes } = await getLayer();
		noteSandbox(c, meta, await sandboxes.state(meta.sandboxId));
	} catch (error) {
		c.log.warn({ msg: "could not read the sandbox's state", error: describeError(error) });
	}
}

// ---------------------------------------------------------------------------------------------
// A turn's question
// ---------------------------------------------------------------------------------------------

function duration(ms: number): string {
	if (ms >= 60_000) {
		const minutes = Math.round(ms / 60_000);
		return minutes === 1 ? "1 minute" : `${minutes} minutes`;
	}
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** What the sandbox layer hands over is typed, but it is another module's word: nothing is assumed of it. */
function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/**
 * Takes the turn's pending question away: clients are told, and a session that was waiting counts as
 * running again. Synchronous, so of two callers exactly one gets the question. The caller settles the
 * layer's promise and publishes the summary.
 */
function takeQuestion(c: Ctx, meta: SessionMeta, active: ActiveTurn): Asked | null {
	const asked = active.question;
	if (!asked) return null;
	active.question = null;
	clearTimeout(asked.timer);
	if (meta.status === "waiting") meta.status = "running";
	c.broadcast("question", null);
	return asked;
}

/**
 * The layer's `onQuestion`: makes the question visible, turns the session to `waiting`, and returns
 * the promise that `answer()`, the timeout, a stop or the turn's end settles.
 */
function askQuestion(c: Ctx, meta: SessionMeta, active: ActiveTurn, question: TurnQuestion, withdrawn: AbortSignal): Promise<TurnAnswer> {
	const choices = (Array.isArray(question?.choices) ? question.choices : []).map((choice) => ({
		id: str(choice?.id),
		label: str(choice?.label) || str(choice?.id),
		approve: choice?.approve === true,
		remembers: typeof choice?.remembers === "string" && choice.remembers !== "" ? choice.remembers : null,
	}));
	// "deny" is Windlass's own id for it; a rejection declines a question that has no such choice.
	const refusal = choices.find((choice) => choice.id === "deny" && !choice.approve) ?? choices.find((choice) => !choice.approve);
	const declined = (why?: string): Promise<TurnAnswer> =>
		refusal ? Promise.resolve({ choice: refusal.id, note: why }) : Promise.reject(new Error(why ?? "the question was declined"));
	const title = str(question?.title) || "Allow this tool call?";

	if (active.closed || active.controller.signal.aborted || withdrawn.aborted) return declined();
	if (active.question) {
		// Windlass asks one question at a time, and the contract shows one. A second one is not left to hang.
		note(c, active.number, "warn", `Windlass asked "${title}" while another question was waiting for an answer, so it was declined.`);
		return declined("Another question was waiting for the user's answer, so the platform declined this call. Ask again if it is still needed.");
	}

	const now = Date.now();
	const pending: PendingQuestion = {
		id: `q_${randomBytes(8).toString("hex")}`,
		turn: active.number,
		messageId: str(question.messageId),
		callId: str(question.callId),
		title,
		subject: str(question.subject),
		details: Array.isArray(question.details) ? question.details.map(str) : [],
		choices,
		subagent: typeof question.subagent === "string" && question.subagent !== "" ? question.subagent : null,
		askedAt: now,
		expiresAt: now + config.questionTimeoutMs,
	};
	return new Promise<TurnAnswer>((resolve, reject) => {
		const settled = (): void => {
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
		};
		const asked: Asked = {
			pending,
			timer: setTimeout(() => {
				// Nobody answered: the turn must not wait for ever, and the model should know why it was refused.
				if (active.question !== asked) return;
				takeQuestion(c, meta, active);
				note(c, active.number, "warn", `Nobody answered "${pending.title}" within ${duration(config.questionTimeoutMs)}, so it was declined.`, {
					code: "question_expired",
					call: { messageId: pending.messageId, callId: pending.callId },
				});
				publish(c);
				void persist(c);
				asked.decline(`Nobody answered within ${duration(config.questionTimeoutMs)}, so the platform declined this call for the user.`);
			}, config.questionTimeoutMs),
			answer: (answer) => {
				settled();
				resolve(answer);
			},
			decline: (why) => {
				settled();
				if (refusal) resolve({ choice: refusal.id, note: why });
				else reject(new Error(why ?? "the question was withdrawn"));
			},
		};
		// Windlass withdrew the question: the turn was stopped. What the promise does now is ignored.
		function onWithdrawn(): void {
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			asked.decline();
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		active.question = asked;
		if (meta.status === "running") meta.status = "waiting";
		c.broadcast("question", pending);
		publish(c);
		void persist(c);
	});
}

/** Stops the turn. The question it may be waiting on goes first: nobody can answer a turn that is ending. */
function abortTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	if (takeQuestion(c, meta, active)) {
		publish(c);
		void persist(c);
	}
	active.controller.abort();
}

/** Closes the turn to steering, stopping one call and answering, and leaves no question behind. Never throws. */
function sealTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	active.closed = true;
	active.control = null;
	try {
		takeQuestion(c, meta, active);
		for (const asked of [...active.unsettled]) asked.decline();
	} catch (error) {
		active.question = null;
		c.log.error({ msg: "could not withdraw the turn's question", error: describeError(error) });
	}
}

// ---------------------------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------------------------

function usageOf(value: unknown): TurnUsage | null {
	if (typeof value !== "object" || value === null) return null;
	const { inputTokens, cachedInputTokens, outputTokens, reasoningTokens } = value as Record<string, unknown>;
	if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
	return {
		inputTokens,
		cachedInputTokens: typeof cachedInputTokens === "number" ? cachedInputTokens : 0,
		outputTokens,
		reasoningTokens: typeof reasoningTokens === "number" ? reasoningTokens : 0,
	};
}

/** Why Windlass produced no result, from its exit code (see its user guide, "Exit codes") and stderr. */
function failureMessage(result: RunTurnResult): string {
	const said = tail(result.stderrTail ?? "");
	let what: string;
	if (result.timedOut) what = "Windlass ran past the time limit and was stopped";
	else if (result.exitCode === null) what = "Windlass was killed before it finished";
	else if (result.exitCode === 2) what = "Windlass refused to start (exit code 2: an option, the model or the session was not accepted)";
	else if (result.exitCode === 0) what = "Windlass ended without reporting a result";
	else what = `Windlass ended without a result (exit code ${result.exitCode})`;
	return said ? `${what}:\n${said}` : `${what}.`;
}

function titleFrom(prompt: string): string {
	const text = prompt.replace(/\s+/g, " ").trim();
	let title = "";
	for (const word of text.split(" ").slice(0, 8)) {
		const next = title === "" ? word : `${title} ${word}`;
		if (next.length > 60) break;
		title = next;
	}
	if (title === "") title = text.slice(0, 60);
	return title.length < text.length ? `${title}…` : title;
}

/** Runs one accepted turn to its `turn.ended`. Never rejects. */
async function runTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, text: string): Promise<void> {
	const startedAt = Date.now();
	const turn = active.number;
	const effort = active.effort;
	const signal = active.controller.signal;
	const resumed = meta.windlassSessionId;
	let result: RunTurnResult | null = null;
	let problem: string | null = null;
	let events = 0;
	let open = true;
	// A turn that never ends would hold its sandbox, and one of the user's running slots, for ever.
	const limit = setTimeout(() => {
		if (!open) return;
		note(c, turn, "warn", `This turn ran for ${duration(TURN_TIMEOUT_MS)}, which is the limit, so it was stopped.`);
		abortTurn(c, meta, active);
	}, TURN_TIMEOUT_MS);

	try {
		await persist(c);
		const layer = await getLayer();
		const sandbox = await openSandbox(c, meta, turn, signal, layer);
		if (!signal.aborted) {
			if (meta.status === "starting") {
				meta.status = "running";
				publish(c);
				void persist(c);
			}
			result = await layer.windlass.runTurn(sandbox, {
				prompt: text,
				windlassSessionId: resumed ?? undefined,
				model: meta.model,
				effort: effort ?? undefined,
				script: meta.demo ? layer.windlass.demoScript(text, turn) : undefined,
				signal,
				onEvent: (event) => {
					if (!open) return;
					events += 1;
					try {
						onWindlassEvent(c, meta, turn, event);
					} catch (error) {
						c.log.error({ msg: "could not record a Windlass event", error: describeError(error) });
					}
				},
				// Always given: a session is attended, by whoever has it open now or opens it in time.
				onQuestion: (question, withdrawn) => askQuestion(c, meta, active, question, withdrawn),
				onControl: (control) => {
					if (open) active.control = control;
				},
			});
		}
	} catch (error) {
		if (!signal.aborted) {
			problem = error instanceof TurnProblem || isSandboxUserError(error) ? error.message : `The sandbox failed: ${describeError(error)}`;
			if (error instanceof TurnProblem) c.log.warn({ msg: "turn failed", session: meta.sessionId, turn, error: error.message });
			else c.log.error({ msg: "turn failed", session: meta.sessionId, turn, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		}
	}
	open = false;
	clearTimeout(limit);
	// From here on the turn takes no message, no answer and no stop of a call, and has no question.
	sealTurn(c, meta, active);

	try {
		const summary = result?.summary ?? null;
		let outcome: TurnOutcome;
		let message: string | null = null;
		if (result?.aborted || (!result && signal.aborted)) {
			outcome = "interrupted";
		} else if (result) {
			const failure = result.failure ?? null;
			// Windlass's own sentence about it; the layer may hand it over without a capital.
			const said = failure ? str(failure.message).trim().replace(/^[a-z]/, (letter) => letter.toUpperCase()) : "";
			const reported = summary?.outcome as TurnOutcome | undefined;
			if (failure?.reason === "auth_required") {
				// No sign-in, one that could not be refreshed, or an access token the provider rejected: the remedy is the same.
				outcome = "error";
				message = "ChatGPT did not accept the saved sign-in. Sign in with ChatGPT again, then send the prompt once more.";
				// The next prompt asks the sandbox layer about the sign-in instead of trusting an earlier answer.
				c.vars.signedInUntil = 0;
			} else if (failure?.reason === "session_not_found") {
				outcome = "error";
				meta.windlassSessionId = null;
				message = `${said || "Windlass no longer has the session this agent was working in."}\nThe next prompt starts a new Windlass session; the files in the workspace are still there.`;
			} else if (reported !== undefined && WINDLASS_OUTCOMES.includes(reported)) {
				// Windlass's own outcome stands. If the turn failed, its events in the timeline say how.
				outcome = reported;
				// Unless the platform failed it: the turn's access token ran out and could not be replaced. Windlass's
				// events say that in words meant for whoever hands the token in; the sandbox layer's sentence is for the user.
				if (failure?.reason === "token_unavailable" && said) message = said;
			} else if (failure) {
				outcome = "error";
				const stderr = tail(result.stderrTail ?? "");
				message = said || failureMessage(result);
				if (said && stderr && !said.includes(stderr)) message = `${said}\n${stderr}`;
			} else {
				outcome = "error";
				message = failureMessage(result);
				if (result.exitCode === 2 && resumed && events === 0) {
					// Most likely Windlass no longer has the session we asked it to continue.
					meta.windlassSessionId = null;
					message += "\nThe next prompt starts a new Windlass session.";
				}
			}
		} else {
			outcome = "error";
			message = problem ?? "The turn could not be run.";
		}
		if (result?.windlassSessionId && outcome !== "error") meta.windlassSessionId = result.windlassSessionId;

		c.vars.pending = [];
		append(c, {
			turn,
			kind: "turn.ended",
			outcome,
			exitCode: result?.exitCode ?? null,
			steps: typeof summary?.steps === "number" ? summary.steps : null,
			durationMs: typeof summary?.durationMs === "number" ? summary.durationMs : Date.now() - startedAt,
			usage: usageOf(summary?.usage),
			cachedShare: typeof summary?.cachedShare === "number" ? summary.cachedShare : null,
			message,
		});
		meta.status = "idle";
		meta.lastOutcome = outcome;
		meta.updatedAt = Date.now();
		meta.turnStartedAt = null;
		c.vars.turn = null;
		publish(c);
		if (outcome === "error") await refreshSandbox(c, meta);
		await persist(c);
		await within(c.vars.reporting, REPORT_WAIT_MS);
	} catch (error) {
		// Whatever went wrong while closing the turn, the session must not stay "running".
		c.log.error({ msg: "could not close the turn cleanly", error: describeError(error) });
		meta.status = "idle";
		meta.turnStartedAt = null;
		c.vars.turn = null;
		c.vars.pending = [];
		publish(c);
		await persist(c);
	}
}

/** Waits for `promise`, but no longer than `ms`. Never rejects. */
async function within(promise: Promise<unknown> | null, ms: number): Promise<void> {
	if (!promise) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.catch(() => undefined),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
}

/** Stops the turn in progress, if any, and waits (a bounded time) until it has closed itself. */
async function stopTurn(c: Ctx): Promise<void> {
	const turn = c.vars.turn;
	if (!turn) return;
	if (c.vars.meta) abortTurn(c, c.vars.meta, turn);
	else turn.controller.abort();
	await within(turn.done, STOP_WAIT_MS);
}

/**
 * `prompt()` while a turn is in progress: the message goes into that turn. It takes no new turn, no
 * running slot and no title, and it is stored only once Windlass has admitted it.
 */
async function steerTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn | null, message: string): Promise<{ turn: number; steered: boolean }> {
	const control = active?.control;
	const stopping = meta.status === "stopping" || active?.controller.signal.aborted === true || active?.closed === true;
	if (!active || !control || stopping || (meta.status !== "running" && meta.status !== "waiting")) {
		const state = stopping ? "is being stopped" : "is still starting";
		throw new UserError(`The turn ${state} and cannot take a message right now. Try again in a moment.`, { code: "turn_running" });
	}
	try {
		await control.steer(message);
	} catch (error) {
		c.log.warn({ msg: "a running turn did not take a steered message", session: meta.sessionId, turn: active.number, error: describeError(error) });
		const why = isSandboxUserError(error) ? ` ${error.message}` : "";
		throw new UserError(`The running turn could not take the message.${why} Try again in a moment.`, { code: "turn_running" });
	}
	if (active.closed) {
		// The turn ended while Windlass was taking the message; nothing can be added to a closed turn.
		throw new UserError("The turn ended just as the message arrived. Try again in a moment.", { code: "turn_running" });
	}
	append(c, { turn: active.number, kind: "user", text: message, model: meta.model, effort: active.effort, steer: true });
	meta.updatedAt = Date.now();
	publish(c);
	return { turn: active.number, steered: true };
}

// ---------------------------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------------------------

export const agentSession = actor({
	options: {
		name: "Agent session",
		icon: "robot",
		// `changes`, `diff` and the internal destroy wait on the sandbox; a turn itself runs in the
		// background under `keepAwake` and is not bound by this.
		actionTimeout: 120_000,
		// Shutdown stops the turn, closes it in the timeline and pauses the sandbox.
		sleepGracePeriod: 25_000,
	},

	db: db({
		onMigrate: async (db) => {
			await db.execute("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
			await db.execute(`
				CREATE TABLE IF NOT EXISTS timeline (
					seq INTEGER PRIMARY KEY,
					turn INTEGER NOT NULL,
					kind TEXT NOT NULL,
					at INTEGER NOT NULL,
					item TEXT NOT NULL
				)
			`);
		},
	}),

	// Only `user` may create a session: its input carries a grant signed for exactly this key. An actor
	// made any other way (anyone can call getOrCreate) stays without a meta row and removes itself in
	// `onWake`. Throwing here would make the engine retry the start in a loop.
	onCreate: async (c, input: SessionCreateInput | undefined) => {
		try {
			if (!input || !grantIsValid(input.grant, c.key)) return;
			const meta: SessionMeta = {
				uid: c.key[0],
				sessionId: c.key[1],
				demo: input.demo === true,
				title: String(input.title),
				titleIsDefault: input.titleIsDefault === true,
				profile: input.profile,
				model: String(input.model),
				repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : null,
				createdAt: input.createdAt,
				updatedAt: input.createdAt,
				status: "idle",
				turns: 0,
				lastOutcome: null,
				sandboxId: null,
				sandbox: "none",
				cloned: false,
				windlassSessionId: null,
				turnStartedAt: null,
			};
			await c.db.execute("INSERT OR REPLACE INTO meta (id, data) VALUES (1, ?)", JSON.stringify(meta));
		} catch (error) {
			c.log.error({ msg: "could not initialise the session", error: describeError(error) });
		}
	},

	createVars: async (c): Promise<SessionVars> => {
		const [row] = await c.db.execute<{ data: string }>("SELECT data FROM meta WHERE id = 1");
		const [last] = await c.db.execute<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM timeline");
		return {
			meta: row ? (JSON.parse(row.data) as SessionMeta) : null,
			nextSeq: (last?.seq ?? 0) + 1,
			unwritten: [],
			flushTimer: null,
			flushQueued: false,
			serial: Promise.resolve(),
			pending: [],
			turn: null,
			accepting: false,
			destroying: false,
			stopping: false,
			reporting: null,
			reportAgain: false,
			signedInUntil: 0,
		};
	},

	onWake: async (c) => {
		const meta = c.vars.meta;
		if (!meta) {
			c.destroy();
			return;
		}
		// The signal taken here is the actor's own; the one on an action's context stops firing once
		// the action has returned.
		c.abortSignal.addEventListener(
			"abort",
			() => {
				if (c.vars.turn) abortTurn(c, meta, c.vars.turn);
			},
			{ once: true },
		);

		if (meta.status !== "idle") {
			// The process that ran this turn is gone, and the turn with it; so is a question it was waiting on.
			const turn = meta.turns;
			note(c, turn, "warn", "The server stopped while this turn was running, so the turn was cut short.");
			append(c, {
				turn,
				kind: "turn.ended",
				outcome: "interrupted",
				exitCode: null,
				steps: null,
				durationMs: meta.turnStartedAt ? Math.max(0, Date.now() - meta.turnStartedAt) : 0,
				usage: null,
				cachedShare: null,
				message: null,
			});
			meta.status = "idle";
			meta.lastOutcome = "interrupted";
			meta.updatedAt = Date.now();
			meta.turnStartedAt = null;
			await persist(c);
			publish(c);
		}
		// The sandbox may have been paused, removed or left running while the actor was away.
		void c.keepAwake(refreshSandbox(c, meta));
	},

	onSleep: async (c) => {
		c.vars.stopping = true;
		const meta = c.vars.meta;
		if (!meta) return;
		await stopTurn(c);
		if (meta.sandboxId && meta.sandbox === "running") {
			try {
				const { sandboxes } = await getLayer();
				await sandboxes.suspend(meta.sandboxId);
				meta.sandbox = "paused";
				publish(c);
			} catch (error) {
				c.log.error({ msg: "could not pause the sandbox", error: describeError(error) });
			}
		}
		await persist(c);
		await within(c.vars.reporting, REPORT_WAIT_MS);
	},

	onDestroy: async (c) => {
		c.vars.stopping = true;
		c.vars.destroying = true;
		const meta = c.vars.meta;
		if (!meta) return;
		await stopTurn(c);
		if (c.vars.flushTimer) clearTimeout(c.vars.flushTimer);
		if (!meta.sandboxId) return;
		try {
			const { sandboxes } = await getLayer();
			await sandboxes.destroy(meta.sandboxId);
			console.log(`[wlp] sandbox.destroyed id=${meta.sandboxId} session=${meta.sessionId}`);
		} catch (error) {
			c.log.error({ msg: "could not destroy the sandbox", sandbox: meta.sandboxId, error: describeError(error) });
		}
	},

	events: {
		item: event<TimelineItem>({ canSubscribe: (c) => maySubscribe(c) }),
		delta: event<LiveDelta>({ canSubscribe: (c) => maySubscribe(c) }),
		summary: event<SessionSummary>({ canSubscribe: (c) => maySubscribe(c) }),
		question: event<PendingQuestion | null>({ canSubscribe: (c) => maySubscribe(c) }),
	},

	onBeforeConnect: (c, params: unknown) => {
		assertOrigin(c);
		authenticate(c.key, params);
		if (!c.vars.meta) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	},

	actions: {
		snapshot: async (c): Promise<SessionSnapshot> => {
			requireUser(c);
			const meta = liveMeta(c);
			try {
				const { sandboxes } = await getLayer();
				const profile = sandboxes.profile(meta.profile);
				return await serial(c, async () => {
					await writeItems(c).catch((error) => c.log.error({ msg: "could not write the timeline", error: describeError(error) }));
					const rows = await c.db.execute<{ item: string }>("SELECT item FROM timeline ORDER BY seq");
					// No write can run between the read above and here, so what SQLite did not return is
					// exactly what still waits in memory.
					const timeline = rows.map((row) => JSON.parse(row.item) as TimelineItem);
					const last = timeline.length > 0 ? timeline[timeline.length - 1].seq : 0;
					for (const item of c.vars.unwritten) if (item.seq > last) timeline.push(item);
					return {
						summary: summaryOf(meta),
						profile,
						windlassSessionId: meta.windlassSessionId,
						timeline,
						pending: [...c.vars.pending],
						question: c.vars.turn?.question?.pending ?? null,
					};
				});
			} catch (error) {
				throw clientError(c.log, error, "The agent's timeline could not be read.");
			}
		},

		prompt: async (c, input: PromptInput): Promise<{ turn: number; steered: boolean }> => {
			requireUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.text !== "string" || input.text.trim() === "") {
				throw new UserError("Write what the agent should do.", { code: "empty_prompt" });
			}
			const text = input.text.trim();
			if (text.length > MAX_PROMPT_CHARS) {
				throw new UserError(`The prompt is ${text.length} characters long; the limit is ${MAX_PROMPT_CHARS}.`, { code: "prompt_too_long" });
			}
			// A turn in progress takes the message itself; `model` and `effort` are for a turn that starts.
			if (c.vars.turn || c.vars.accepting) return await steerTurn(c, meta, c.vars.turn, text);

			const effort = input.effort === undefined || input.effort === null || input.effort === "" ? null : input.effort;
			if (effort !== null && !EFFORTS.includes(effort)) {
				throw new UserError(`The effort must be one of: ${EFFORTS.join(", ")}`, { code: "bad_effort" });
			}

			// Nothing was awaited since the check above, so this prompt is the only one past it.
			c.vars.accepting = true;
			let claimed = false;
			try {
				let model = meta.model;
				if (input.model !== undefined && input.model !== null && input.model !== "") {
					const models = await platformModels();
					if (typeof input.model !== "string" || !models.includes(input.model)) {
						throw new UserError(`That model is not offered. Choose one of: ${models.join(", ")}`, { code: "bad_model" });
					}
					model = input.model;
				}

				if (!meta.demo && Date.now() >= c.vars.signedInUntil) {
					const { logins } = await getLayer();
					if (!(await logins.status(meta.uid))) {
						throw new UserError("Sign in with ChatGPT first: this agent needs your account to run.", { code: "chatgpt_required" });
					}
					c.vars.signedInUntil = Date.now() + SIGNED_IN_FRESH_MS;
				}

				const claim = await userActor(c, meta.uid).internalAcquireRun(meta.sessionId);
				if (!claim.known || c.vars.destroying) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
				if (!claim.ok) {
					throw new UserError(`You already have ${MAX_RUNNING_SESSIONS} agents working. Wait for one to finish, or stop one.`, { code: "too_many_running" });
				}
				claimed = true;

				// Accepted. From here to the return nothing is awaited.
				const turn = meta.turns + 1;
				const now = Date.now();
				meta.turns = turn;
				meta.model = model;
				meta.status = "starting";
				meta.updatedAt = now;
				meta.turnStartedAt = now;
				if (meta.titleIsDefault) {
					meta.title = titleFrom(text);
					meta.titleIsDefault = false;
				}
				append(c, { turn, kind: "user", text, model, effort });
				publish(c);

				const active: ActiveTurn = { number: turn, effort, controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), closed: false };
				c.vars.turn = active;
				active.done = c.keepAwake(runTurn(c, meta, active, text));
				return { turn, steered: false };
			} catch (error) {
				if (!c.vars.turn && meta.status !== "idle") {
					meta.status = "idle";
					meta.turnStartedAt = null;
				}
				// Hands back the place among the user's running sessions, if one was taken.
				if (claimed) publish(c);
				else if (!(error instanceof UserError)) void report(c);
				throw clientError(c.log, error, "The prompt could not be started. Try again.");
			} finally {
				c.vars.accepting = false;
			}
		},

		stop: (c): void => {
			requireUser(c);
			const meta = liveMeta(c);
			const turn = c.vars.turn;
			if (!turn) return;
			// A question the turn waits on is withdrawn with it: from here an answer finds nothing to answer.
			const withdrawn = takeQuestion(c, meta, turn);
			if (meta.status !== "stopping") {
				meta.status = "stopping";
				publish(c);
				void persist(c);
			} else if (withdrawn) {
				publish(c);
			}
			turn.controller.abort();
		},

		// Synchronous from the check to the settling, so of two answers sent at once exactly one finds
		// the question pending.
		answer: (c, input: { questionId: string; choice: string; note?: string }): void => {
			requireUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.questionId !== "string" || typeof input.choice !== "string") {
				throw new UserError("Choose one of the question's answers.", { code: "bad_answer" });
			}
			if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
				throw new UserError("The note must be text.", { code: "bad_answer" });
			}
			const note = typeof input.note === "string" ? input.note.trim() : "";
			if (note.length > MAX_NOTE_CHARS) {
				throw new UserError(`The note is ${note.length} characters long; the limit is ${MAX_NOTE_CHARS}.`, { code: "note_too_long" });
			}
			const active = c.vars.turn;
			const asked = active?.question;
			if (!active || !asked || asked.pending.id !== input.questionId) {
				throw new UserError("That question is not waiting for an answer any more.", { code: "no_question" });
			}
			const choice = asked.pending.choices.find((candidate) => candidate.id === input.choice);
			if (!choice) {
				throw new UserError(`That is not one of the question's answers. Choose one of: ${asked.pending.choices.map((candidate) => candidate.label).join(", ")}`, { code: "bad_choice" });
			}
			takeQuestion(c, meta, active);
			publish(c);
			void persist(c);
			asked.answer({ choice: choice.id, note: note === "" ? undefined : note });
		},

		stopCall: async (c, input: { messageId: string; callId: string }): Promise<{ stopped: boolean; message: string | null }> => {
			requireUser(c);
			liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.messageId !== "string" || input.messageId === "" || typeof input.callId !== "string" || input.callId === "") {
				throw new UserError("Say which tool call to stop.", { code: "bad_call" });
			}
			const active = c.vars.turn;
			const control = active?.control;
			if (!active || !control || active.closed) {
				throw new UserError("No turn is running, so there is no tool call to stop.", { code: "no_turn" });
			}
			try {
				const result = await control.cancelCall(input.messageId, input.callId);
				return { stopped: result?.stopped === true, message: typeof result?.message === "string" && result.message !== "" ? result.message : null };
			} catch (error) {
				if (active.closed) throw new UserError("The turn ended before the tool call could be stopped.", { code: "no_turn" });
				throw clientError(c.log, error, "The tool call could not be stopped. Try again.");
			}
		},

		changes: async (c): Promise<WorkspaceFile[]> => {
			requireUser(c);
			const meta = liveMeta(c);
			if (!meta.sandboxId) return [];
			try {
				const { sandboxes } = await getLayer();
				const sandbox = await sandboxes.connect(meta.sandboxId);
				if (!sandbox) {
					noteSandbox(c, meta, "none");
					return [];
				}
				noteSandbox(c, meta, "running");
				const status = await sandbox.run(STATUS_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
				if (status.exitCode !== 0) {
					c.log.warn({ msg: "git status failed in the sandbox", exitCode: status.exitCode, stderr: tail(status.stderr, 3, 300) });
					return [];
				}
				return parseStatus(status.stdout);
			} catch (error) {
				throw clientError(c.log, error, "The workspace's changes could not be read.");
			}
		},

		diff: async (c): Promise<string> => {
			requireUser(c);
			const meta = liveMeta(c);
			if (!meta.sandboxId) return "";
			try {
				const { sandboxes } = await getLayer();
				const sandbox = await sandboxes.connect(meta.sandboxId);
				if (!sandbox) {
					noteSandbox(c, meta, "none");
					return "";
				}
				noteSandbox(c, meta, "running");
				const diff = await sandbox.run(DIFF_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
				if (diff.exitCode !== 0 && diff.stdout === "") {
					c.log.warn({ msg: "git diff failed in the sandbox", exitCode: diff.exitCode, stderr: tail(diff.stderr, 3, 300) });
					return "";
				}
				return diff.stdout.length > MAX_DIFF_CHARS ? diff.stdout.slice(0, MAX_DIFF_CHARS) : diff.stdout;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's diff could not be read.");
			}
		},

		// --- called by `user` only ---------------------------------------------------------------

		internalSummary: (c): SessionSummary => {
			requireService(c);
			return summaryOf(liveMeta(c));
		},

		internalRename: async (c, title: string): Promise<SessionSummary> => {
			requireService(c);
			const meta = liveMeta(c);
			meta.title = String(title);
			meta.titleIsDefault = false;
			// The caller is the `user` actor, which takes the summary from the return value.
			c.broadcast("summary", summaryOf(meta));
			await persist(c);
			return summaryOf(meta);
		},

		internalDestroy: async (c): Promise<void> => {
			requireService(c);
			c.vars.destroying = true;
			const meta = c.vars.meta;
			if (meta) {
				// Done here as well as in `onDestroy`, so that the caller's delete resolves only once the
				// sandbox is gone; `onDestroy` finds nothing left to do.
				await stopTurn(c);
				if (meta.sandboxId) {
					try {
						const { sandboxes } = await getLayer();
						await sandboxes.destroy(meta.sandboxId);
						console.log(`[wlp] sandbox.destroyed id=${meta.sandboxId} session=${meta.sessionId}`);
						meta.sandboxId = null;
						meta.sandbox = "none";
					} catch (error) {
						c.log.error({ msg: "could not destroy the sandbox", sandbox: meta.sandboxId, error: describeError(error) });
					}
				}
			}
			c.destroy();
		},
	},
});
