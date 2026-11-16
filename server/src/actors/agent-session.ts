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
 * Windlass has a second question, which it does not put itself: whether to start an MCP server the
 * project's own configuration names (server-question.ts). The sandbox layer asks Windlass what waits
 * before the turn's prompt goes, and the question is put to the user in the same place and settled by
 * the same `answer()`. A tool call's question comes first: a server's steps aside for it and is put
 * again afterwards. What became of it is a line in the timeline; Windlass has no event for it.
 *
 * An approval is remembered for the user beyond the sandbox Windlass keeps it in (server-approvals.ts):
 * the user's `user` actor holds it, for the session's project and exactly that definition. Before a
 * server's question is put, the session asks there, and a remembered approval starts the server
 * without the question, with one line that says so. What Windlass says of the project's servers is
 * kept with the session (`meta.servers`), for the side panel, where an approval is seen, given and
 * taken back (`servers`, `approveServer`, `forgetServer`).
 *
 * A sandbox nobody uses is suspended, and after longer removed (config.idleSuspendMs, idleDestroyMs),
 * by the actor's own durable schedule (`c.schedule`): it holds while the actor sleeps and across a
 * restart, and wakes the actor when it is due. The check never touches a turn in progress or one being
 * accepted, and a prompt waits for a suspend or removal under way, then resumes or recreates the sandbox.
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
 *   publish_blocked, github_gone, github_denied, publish_failed, bad_message   `publish()` (contract.ts)
 *   bad_server          `approveServer()`, `forgetServer()`: their input
 *   server_gone, server_changed   `approveServer()`: the session knows no such server, or it does not wait with that definition
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
	MAX_PUBLISH_BODY_CHARS,
	MAX_PUBLISH_TITLE_CHARS,
	MAX_RUNNING_SESSIONS,
	type PendingQuestion,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type PullRequestInfo,
	type SandboxProfileId,
	type SessionServers,
	type SessionSnapshot,
	type SessionStatus,
	type SessionSummary,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type WindlassEvent,
	type WorkspaceFile,
} from "../contract.js";
import { githubApp } from "../github/app.js";
import { PullProblem, type StoredRepository, branchFor, cloneRepository, hasUnpushedWork, publishWork, refreshPull } from "../github/publish.js";
import { GithubProblem, type StoredConnection } from "../github/repos.js";
import { getLayer } from "../layer.js";
import { EFFORTS, platformModels } from "../platform-info.js";
import type { RunTurnResult, SandboxHandle, SandboxLayer, TurnAnswer, TurnControl, TurnQuestion, TurnServer, TurnServerQuestion } from "../sandbox/api.js";
import { type KnownServer, type ServerApproval, knownServers, projectOf, sameServers, serversView } from "../server-approvals.js";
import {
	SERVER_START,
	type ServerQuestionContext,
	forgettingWords,
	serverApprovedNote,
	serverExpiredNote,
	serverForgottenNote,
	serverNotNowNote,
	serverPanelApprovedNote,
	serverPanelWords,
	serverQuestionWords,
	serverRecalledNote,
	serverUnansweredNote,
} from "../server-question.js";
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
/** How long a turn waits for the `user` actor to say whether a server's approval is remembered, before it asks the user instead. */
const RECALL_WAIT_MS = 10_000;

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
	/**
	 * When the last turn ended, or the workspace was last read through the sandbox: what the idle times
	 * count from. Absent in sessions made before it; `updatedAt` stands in.
	 */
	lastUsedAt?: number;
	/** The idle check the durable schedule holds: its id, and when it fires. */
	idleCheck?: { id: string; at: number } | null;
	/** Set when the session was launched on a repository of the user's GitHub connection (`repoUrl` is its address). */
	repo?: StoredRepository | null;
	/** The branch the platform pushes the session's work to: named when it first pushes, and kept. */
	publishBranch?: string;
	/** The commit the platform last pushed to that branch. */
	pushedHead?: string | null;
	/** The session's pull request, as GitHub last described it. */
	pull?: PullRequestInfo | null;
	/**
	 * The copy of Windlass's session that is kept outside the sandbox, where sessions live in the sandbox
	 * and a bucket is configured (sandbox/backup.ts): which Windlass session it is of, the archive's size
	 * and hash, which a restore is checked against, and the turn it was saved after. Null or absent: none.
	 */
	backup?: { windlassSessionId: string; size: number; sha256: string; at: number; turn: number } | null;
	/** The last turn that may have changed Windlass's session. The copy is behind while its `turn` is lower. */
	memoryTurn?: number;
	/** Set once the session's data was too large to copy and the timeline said so: nothing is packed again while the limit is no higher. */
	backupStopped?: { size: number; limit: number } | null;
	/** Windlass's memory was restored into a new sandbox, and it has not yet been told that the workspace is a fresh one. */
	freshWorkspace?: boolean;
	/**
	 * The MCP servers the project's configuration names, as Windlass last described them to a turn of this
	 * session (server-approvals.ts). Absent or empty: it named none, or no turn has asked yet.
	 */
	servers?: KnownServer[];
	/** When `servers`, or what is remembered of their approvals through this session, last changed. */
	serversChangedAt?: number;
}

/** A question put to the user: the copy the clients see, and the ways to settle the layer's promise. */
interface Asked {
	pending: PendingQuestion;
	/** Declines it for the platform when nobody answers. Unset while a server's question stands aside. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Each settles the promise the layer waits on; only the first call of either does anything. */
	answer(answer: TurnAnswer): void;
	decline(note?: string): void;
	/** A question about a project's server only: shows it, the first time and again after it stood aside, with a new time to answer in. */
	put?(): void;
	/** A question about a project's server only: the definition it is about. */
	server?: { name: string; fingerprint: string };
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
	/**
	 * Questions about the project's servers that are open and not shown: one that stepped aside for a
	 * tool call's question, or one that came while another was shown. Put again, oldest first, when
	 * `question` is free.
	 */
	aside: Asked[];
	/**
	 * The definitions (`<name>:<fingerprint>`) this turn had Windlass start from the user's remembered
	 * approval, without putting the question, each with that approval: the line about it says so.
	 */
	recalled: Map<string, ServerApproval>;
	/** True once the turn is being stopped: no question is put any more. */
	stopping: boolean;
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
	/** A suspend or removal of the idle sandbox under way; a prompt or a read of the workspace waits for it. */
	idling: Promise<void> | null;
	/** The copy of the workspace taken when the last turn ended; undefined until it is read from SQLite. */
	workspace: WorkspaceCopy | null | undefined;
	/** The tail of the queue that sets the idle check, so two of them cannot cross. */
	arming: Promise<void>;
	/** True while the platform commits and pushes the workspace: no turn starts under it, and no second push. */
	publishing: boolean;
	/** When GitHub was last asked about the session's pull request. */
	pullCheckedAt: number;
	/** Whether the workspace has commits GitHub lacks, as last read from the sandbox, and what it was read for. */
	unpushed: { key: string; value: boolean | null } | null;
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
	schedule: { at(timestamp: number, action: string, ...args: unknown[]): Promise<string>; cancel(id: string): Promise<boolean> };
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
		...(meta.repo ? { repository: repositoryOf(meta.repo), pullRequest: meta.pull ?? null } : {}),
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		status: meta.status,
		turns: meta.turns,
		lastOutcome: meta.lastOutcome,
		sandbox: meta.sandbox,
		...(meta.servers && meta.servers.length > 0 ? { servers: { count: meta.servers.length, changedAt: meta.serversChangedAt ?? meta.updatedAt } } : {}),
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
		await dropWorkspace(c);
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
		if (meta.windlassSessionId && layer.sandboxes.sessionsLiveInSandbox) {
			// Windlass's own session went with the old sandbox. Its copy is put into the new one before anything
			// else happens there; without one, asking for the session would only fail the turn.
			if (!(await restoreBackup(c, meta, turn, handle, layer))) {
				meta.windlassSessionId = null;
				meta.backup = null;
				note(c, turn, "info", "The agent's memory of the conversation went with the old sandbox, so it starts this turn without it.");
			}
		}
	}

	// A repository of the user's GitHub connection is cloned with a token of the platform's own (below).
	if (meta.repo && !meta.cloned && !signal.aborted && !(await cloneConnected(c, meta, turn, handle, signal))) return handle;
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

// ---------------------------------------------------------------------------------------------
// The copy of Windlass's session outside the sandbox
// ---------------------------------------------------------------------------------------------

function megabytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * Puts the copy of Windlass's session into the sandbox that was just made in place of a lost one. True
 * when the agent can go on in that session: the timeline then says so, and how far the copy reaches
 * when it is behind. False when there is no copy of that session or it could not be restored: the
 * caller starts a new Windlass session. It takes no abort signal: a restore that is cut off would leave
 * a sandbox nobody restores again, and it is a matter of seconds. Never throws.
 */
/**
 * Put before the user's prompt, for Windlass alone, on the first turn it takes after its memory was
 * restored into a new sandbox. It remembers the files it made, and the new workspace has none of them:
 * unless it is told, it acts on what is no longer there. Only then: a sandbox that was paused has its
 * files, and a Windlass session that starts anew remembers none. The timeline keeps the prompt as the
 * user wrote it, and has its own line about the restore.
 */
const FRESH_WORKSPACE =
	"[A note from the platform, not from the user: the sandbox you were working in has been replaced by a new one. Your memory of this conversation was carried over, but the workspace was not: it is a fresh one. A repository that was cloned has been cloned again, with whatever of your work had been pushed to its branch; anything else you created or changed earlier is not in it. Look at what is there before you rely on earlier work.]\n\n";

async function restoreBackup(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, layer: SandboxLayer): Promise<boolean> {
	const backups = layer.backups;
	const saved = meta.backup;
	const session = meta.windlassSessionId;
	// Without a bucket nothing was ever copied, and nothing is said of it.
	if (!backups || !session) return false;
	if (!saved || saved.windlassSessionId !== session) {
		console.log(`[wlp] backup.none session=${meta.sessionId} turn=${turn}: ${saved ? "the copy is of an earlier Windlass session" : "no copy of the session was saved"}`);
		return false;
	}
	try {
		const restored = await backups.restore(sandbox, { uid: meta.uid, sessionId: meta.sessionId }, saved, session);
		if (restored.outcome !== "restored") {
			console.warn(`[wlp] backup.restore_failed session=${meta.sessionId} turn=${turn}: ${restored.outcome === "missing" ? "the bucket has no copy of the session" : restored.reason}`);
			return false;
		}
		console.log(`[wlp] backup.restored session=${meta.sessionId} turn=${turn} bytes=${saved.size} ms=${restored.ms} saved_after_turn=${saved.turn}`);
	} catch (error) {
		c.log.warn({ msg: "could not restore the copy of Windlass's session", session: meta.sessionId, error: describeError(error) });
		return false;
	}
	// What came back was small enough to copy: it is copied again from this turn on.
	meta.backupStopped = null;
	meta.freshWorkspace = true;
	// A turn whose copy could not be saved, or was too large to keep, is not in what came back.
	const missed = (meta.memoryTurn ?? saved.turn) > saved.turn ? Math.max(1, turn - 1 - saved.turn) : 0;
	if (missed === 0) note(c, turn, "info", "Restored the agent's memory of the conversation into the new sandbox.");
	else note(c, turn, "warn", `Restored the agent's memory of the conversation into the new sandbox, without the last ${missed === 1 ? "turn: no copy of it" : `${missed} turns: no copy of them`} could be saved.`);
	return true;
}

/**
 * Copies Windlass's session out of the sandbox when a turn has ended: the turn's process is gone, so
 * nothing has the files open. The session's record of the copy is what a later restore is checked
 * against. A save that fails is not tried again by itself: the next turn's save copies the whole
 * session again, and trying later would mean starting a sandbox that was suspended to cost nothing.
 * The user is told nothing then; it matters only if the sandbox is lost before a save works, and the
 * restore says so. A session too large to copy is said once. Never throws.
 */
async function saveBackup(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, layer: SandboxLayer): Promise<void> {
	const backups = layer.backups;
	const session = meta.windlassSessionId;
	if (!backups || !layer.sandboxes.sessionsLiveInSandbox || !session) return;
	// Until a copy is saved below, the one there is, if any, is behind this turn.
	meta.memoryTurn = turn;
	// A session that is going away needs no copy, and an actor that is stopping has no time for one.
	if (c.vars.stopping || c.vars.destroying) return;
	const stopped = meta.backupStopped;
	// Windlass's log only grows: what was too large is not packed again to find that out.
	if (stopped && backups.maxBytes <= stopped.limit) return;
	try {
		const saved = await backups.save(sandbox, { uid: meta.uid, sessionId: meta.sessionId });
		if (saved.outcome === "saved") {
			meta.backup = { windlassSessionId: session, ...saved.backup, turn };
			meta.backupStopped = null;
			console.log(`[wlp] backup.saved session=${meta.sessionId} turn=${turn} bytes=${saved.backup.size} ms=${saved.ms}`);
		} else if (saved.outcome === "too_large") {
			console.log(`[wlp] backup.too_large session=${meta.sessionId} turn=${turn} bytes=${saved.size} limit=${saved.limit}`);
			const earlier = meta.backup?.windlassSessionId === session;
			if (!stopped) {
				note(
					c,
					turn,
					"warn",
					`The agent's memory of the conversation has grown to ${megabytes(saved.size)}, and the platform keeps a copy of at most ${megabytes(saved.limit)}, so it is no longer copied out of the sandbox. If this sandbox is lost, the agent ${earlier ? "will not remember the conversation from here on" : "starts without its memory of the conversation"}.`,
				);
			}
			meta.backupStopped = { size: saved.size, limit: saved.limit };
		} else if (saved.outcome === "failed") {
			console.warn(`[wlp] backup.save_failed session=${meta.sessionId} turn=${turn}: ${saved.reason}`);
		}
	} catch (error) {
		c.log.warn({ msg: "could not copy Windlass's session out of the sandbox", session: meta.sessionId, error: describeError(error) });
	}
}

/** The sessions whose copy was removed already, so that a delete asks the bucket once. */
const backupRemoved = new WeakSet<SessionMeta>();

/**
 * Removes the session's copy from the bucket, for a session that is deleted. Asked whether or not the
 * session recorded a copy: a save that was cut off may have left one. Tried three times; an object
 * that is still there after that is named in the log, for whoever looks after the bucket. Never throws.
 */
async function removeBackup(c: Ctx, meta: SessionMeta): Promise<void> {
	if (backupRemoved.has(meta)) return;
	try {
		const layer = await getLayer();
		if (!layer.backups || !layer.sandboxes.sessionsLiveInSandbox) return;
		for (let attempt = 1; ; attempt += 1) {
			try {
				await layer.backups.remove({ uid: meta.uid, sessionId: meta.sessionId });
				backupRemoved.add(meta);
				meta.backup = null;
				console.log(`[wlp] backup.removed session=${meta.sessionId}`);
				return;
			} catch (error) {
				if (attempt >= 3) throw error;
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		}
	} catch (error) {
		console.error(`[wlp] backup.remove_failed uid=${meta.uid} session=${meta.sessionId}: the copy of this deleted session's Windlass data may still be in the bucket (${describeError(error)})`);
	}
}

/**
 * Reading the workspace through the sandbox starts a paused one, so it counts as using it: the idle
 * times start again, and a check is set for the sandbox that now runs.
 */
function markUsed(c: Ctx, meta: SessionMeta): void {
	if (c.vars.turn) return;
	meta.lastUsedAt = Date.now();
	void c.keepAwake(armIdle(c, meta));
}

/** The changed files of the workspace and their diff, as they were when it was last read. */
interface WorkspaceCopy {
	files: WorkspaceFile[];
	diff: string;
}

/** Null when git could not say. */
async function readFiles(c: Ctx, sandbox: SandboxHandle): Promise<WorkspaceFile[] | null> {
	const status = await sandbox.run(STATUS_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
	if (status.exitCode !== 0) {
		c.log.warn({ msg: "git status failed in the sandbox", exitCode: status.exitCode, stderr: tail(status.stderr, 3, 300) });
		return null;
	}
	return parseStatus(status.stdout);
}

/** Null when git could not say. */
async function readDiff(c: Ctx, sandbox: SandboxHandle): Promise<string | null> {
	const diff = await sandbox.run(DIFF_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
	if (diff.exitCode !== 0 && diff.stdout === "") {
		c.log.warn({ msg: "git diff failed in the sandbox", exitCode: diff.exitCode, stderr: tail(diff.stderr, 3, 300) });
		return null;
	}
	return diff.stdout.length > MAX_DIFF_CHARS ? diff.stdout.slice(0, MAX_DIFF_CHARS) : diff.stdout;
}

/** Reads the workspace from a running sandbox and keeps the copy. Null, and no copy kept, when it could not be read. Never throws. */
async function copyWorkspace(c: Ctx, sandbox: SandboxHandle): Promise<WorkspaceCopy | null> {
	try {
		const files = await readFiles(c, sandbox);
		const diff = files === null ? null : await readDiff(c, sandbox);
		if (files === null || diff === null) return null;
		const copy: WorkspaceCopy = { files, diff };
		await c.db.execute("INSERT OR REPLACE INTO workspace (id, files, diff) VALUES (1, ?, ?)", JSON.stringify(files), diff);
		c.vars.workspace = copy;
		return copy;
	} catch (error) {
		c.log.warn({ msg: "could not copy the workspace's changes", error: describeError(error) });
		return null;
	}
}

async function savedWorkspace(c: Ctx): Promise<WorkspaceCopy | null> {
	if (c.vars.workspace !== undefined) return c.vars.workspace;
	const [row] = await c.db.execute<{ files: string; diff: string }>("SELECT files, diff FROM workspace WHERE id = 1");
	c.vars.workspace = row ? { files: JSON.parse(row.files) as WorkspaceFile[], diff: row.diff } : null;
	return c.vars.workspace;
}

/** Forgets the copy: the workspace it was taken from is gone, or changed without a new copy. Never throws. */
async function dropWorkspace(c: Ctx): Promise<void> {
	c.vars.workspace = null;
	await c.db.execute("DELETE FROM workspace").catch((error: unknown) => {
		c.log.warn({ msg: "could not forget the copy of the workspace", error: describeError(error) });
	});
}

/**
 * What `changes` and `diff` answer from: null without a sandbox. Only a turn changes the workspace, so
 * between turns the copy taken when the last one ended is exact, and answering from it starts no paused
 * sandbox: looking at a session costs nothing. During a turn, and where there is no copy (a session from
 * before the copies, or a turn that ended without one), the sandbox itself is read.
 */
async function workspaceView(c: Ctx, meta: SessionMeta): Promise<WorkspaceCopy | { sandbox: SandboxHandle } | null> {
	if (c.vars.idling) await c.vars.idling.catch(() => undefined);
	if (!meta.sandboxId) return null;
	if (!c.vars.turn) {
		const saved = await savedWorkspace(c);
		if (saved) return saved;
	}
	const { sandboxes } = await getLayer();
	const sandbox = await sandboxes.connect(meta.sandboxId);
	if (!sandbox) {
		noteSandbox(c, meta, "none");
		return null;
	}
	noteSandbox(c, meta, "running");
	if (c.vars.turn) return { sandbox };
	markUsed(c, meta);
	return (await copyWorkspace(c, sandbox)) ?? { sandbox };
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
// A repository of the user's GitHub connection: its clone, and the pull request
// ---------------------------------------------------------------------------------------------

/** How long GitHub's word on the pull request's state is taken before it is asked again. */
const PULL_FRESH_MS = 20_000;

/** What clients see of the repository: all of it but the installation, which is the platform's own matter. */
function repositoryOf(repo: StoredRepository): NonNullable<SessionSummary["repository"]> {
	return { provider: repo.provider, id: repo.id, owner: repo.owner, name: repo.name, branch: repo.branch, private: repo.private, url: repo.url };
}

/** The user's GitHub connection as their actor has it now: asked each time, so a connection that was removed stops working at once. */
function githubConnection(c: Ctx, meta: SessionMeta): Promise<StoredConnection | null> {
	return userActor(c, meta.uid).internalGithubConnection();
}

/**
 * Clones the session's repository into the sandbox that was just made, with a token GitHub issued for
 * reading that one repository; it is given to the one `git clone` and revoked after it (github/git.ts).
 * False when the turn was stopped meanwhile. Throws a TurnProblem that says what is in the way.
 */
async function cloneConnected(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, signal: AbortSignal): Promise<boolean> {
	const repo = meta.repo;
	if (!repo) return true;
	const app = githubApp();
	if (!app) throw new TurnProblem(`This agent was launched on ${repo.owner}/${repo.name} through your GitHub connection, and this deployment has no GitHub App any more to clone it with.`);
	// A sandbox made in place of a lost one: what the platform pushed is all that is left of the work, so
	// the workspace goes back on the session's branch as GitHub has it, and not on the branch it started from.
	const work = meta.pushedHead && meta.publishBranch ? meta.publishBranch : undefined;
	note(c, turn, "info", `Cloning ${repo.owner}/${repo.name} at ${work ?? repo.branch}`);
	try {
		const cloned = await cloneRepository(app, await githubConnection(c, meta), repo, sandbox, signal, work);
		if (!cloned || signal.aborted) return false;
		if (cloned.work) {
			// Whatever was pushed to the branch since, by anyone, is in the workspace now: it is what the next push starts from.
			meta.pushedHead = cloned.work;
		} else if (cloned.workGone) {
			meta.pushedHead = null;
			note(c, turn, "warn", `${work} is no longer at GitHub, so the workspace starts from ${repo.branch} again. Work that was only on that branch is not in it.`);
		}
		c.vars.unpushed = null;
	} catch (error) {
		if (error instanceof GithubProblem) throw new TurnProblem(error.message);
		throw error;
	}
	meta.cloned = true;
	void persist(c);
	return true;
}

/** Shortens `text` to about `limit` characters, at the end of a paragraph or a sentence where there is one. */
function brief(text: string, limit: number): string {
	const clean = text.replace(/\r/g, "").trim();
	if (clean.length <= limit) return clean;
	const cut = clean.slice(0, limit);
	const paragraph = cut.lastIndexOf("\n\n");
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
	if (paragraph > limit / 3) return cut.slice(0, paragraph).trim();
	if (sentence > limit / 3) return cut.slice(0, sentence + 1).trim();
	return `${cut.slice(0, cut.lastIndexOf(" ") > limit / 2 ? cut.lastIndexOf(" ") : limit).trim()}…`;
}

/**
 * A message to start from. The title is the session's for the first push and the latest prompt's
 * opening words after it; the body is the agent's last answer, kept short, or the changed files.
 */
async function draftMessage(c: Ctx, meta: SessionMeta, files: WorkspaceFile[] | null): Promise<PublishMessage> {
	const rows = await serial(c, async () => {
		await writeItems(c).catch(() => undefined);
		return c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE kind IN ('windlass', 'user') ORDER BY seq DESC LIMIT 400");
	}).catch(() => []);
	let answer = "";
	let prompt = "";
	for (const row of rows) {
		const item = JSON.parse(row.item) as TimelineItem;
		if (answer === "" && item.kind === "windlass" && item.event.type === "text.ended") answer = str(item.event.data?.text).trim();
		if (prompt === "" && item.kind === "user" && item.steer !== true) prompt = item.text;
		if (answer !== "" && prompt !== "") break;
	}
	// Until there is a pull request the title is the session's: a push whose pull request GitHub refused is no reason for another.
	const first = !meta.pull;
	const title = (first || prompt === "" ? meta.title : titleFrom(prompt)).replace(/…$/, "").trim().slice(0, MAX_PUBLISH_TITLE_CHARS);
	let body = brief(answer, 600);
	if (body === "" && files && files.length > 0) {
		const listed = files.slice(0, 10).map((file) => `- ${file.path}`);
		if (files.length > listed.length) listed.push(`- and ${files.length - listed.length} more`);
		body = `Changed files:\n${listed.join("\n")}`;
	}
	return { title: title === "" ? "Changes from Windlass" : title, body };
}

/** Why nothing can be pushed right now, or null. */
function publishBlocked(c: Ctx, meta: SessionMeta): string | null {
	if (!githubApp()) return "This deployment has no GitHub App any more, so the platform cannot push.";
	if (c.vars.turn || c.vars.accepting || meta.status !== "idle") return "Wait for the turn to end: the platform does not push while the agent is working.";
	if (c.vars.publishing) return "A push is under way.";
	if (!meta.sandboxId) return "The sandbox is created on the first prompt. Until then there is nothing to push.";
	return null;
}

/**
 * Whether the workspace has something GitHub does not. The files that differ from the last commit are
 * known from the copy taken when the last turn ended. Commits of the agent's own are known to git
 * only, which is asked when the sandbox is running anyway and never by starting one; the answer is
 * kept until a turn or a push changes it.
 */
async function unpushedWork(c: Ctx, meta: SessionMeta, repo: StoredRepository, files: WorkspaceFile[] | null): Promise<boolean | null> {
	if (c.vars.turn || !meta.sandboxId) return null;
	if (files && files.length > 0) return true;
	const key = `${meta.turns}:${meta.pushedHead ?? ""}:${meta.sandboxId}`;
	if (c.vars.unpushed?.key === key) return c.vars.unpushed.value;
	let value: boolean | null = null;
	try {
		const { sandboxes } = await getLayer();
		if (!c.vars.idling && (await sandboxes.state(meta.sandboxId)) === "running") {
			const sandbox = await sandboxes.connect(meta.sandboxId);
			if (sandbox && !c.vars.turn) value = await hasUnpushedWork(sandbox, repo.branch, meta.pushedHead ?? null);
		}
	} catch (error) {
		c.log.warn({ msg: "could not read whether the workspace has commits to push", error: describeError(error) });
	}
	if (value !== null) c.vars.unpushed = { key, value };
	return value;
}

async function publishStateOf(c: Ctx, meta: SessionMeta): Promise<PublishState> {
	const repo = meta.repo;
	if (!repo) return { repository: null, pullRequest: null, branch: "", changes: null, draft: { title: "", body: "" }, blocked: null };
	const files = c.vars.turn ? null : ((await savedWorkspace(c))?.files ?? null);
	const [changes, draft] = await Promise.all([unpushedWork(c, meta, repo, files), draftMessage(c, meta, files)]);
	return { repository: repositoryOf(repo), pullRequest: meta.pull ?? null, branch: meta.publishBranch ?? branchFor(meta.title, meta.sessionId), changes, draft, blocked: publishBlocked(c, meta) };
}

/** Asks GitHub what became of the pull request, at most every few seconds; a change goes to every client with the summary. */
async function checkPull(c: Ctx, meta: SessionMeta): Promise<void> {
	const app = githubApp();
	const { repo, pull } = meta;
	if (!app || !repo || !pull || Date.now() - c.vars.pullCheckedAt < PULL_FRESH_MS) return;
	c.vars.pullCheckedAt = Date.now();
	const current = await refreshPull(app, await githubConnection(c, meta), repo, pull);
	if (meta.pull !== pull || (current.state === pull.state && current.title === pull.title)) return;
	meta.pull = current;
	publish(c);
	void persist(c);
}

/** A push's line in the timeline: what went where, in the words of the other platform notes. */
function publishedLine(repo: StoredRepository, pull: PullRequestInfo, opened: boolean, files: number | null): string {
	const what = files === null ? "the work" : files === 0 ? "the agent's commits" : files === 1 ? "1 file" : `${files} files`;
	if (opened) return `Opened pull request #${pull.number} in ${repo.owner}/${repo.name} from ${pull.branch}${files === null ? "" : `, with ${what}`}.`;
	return `Pushed ${what} to ${pull.branch}; pull request #${pull.number} is updated.`;
}

/** Commits, pushes and opens the pull request, for `publish()`. The caller has checked that nothing is in the way. */
async function publishSession(c: Ctx, meta: SessionMeta, repo: StoredRepository, message: PublishMessage): Promise<PublishResult> {
	const app = githubApp();
	if (!app || !meta.sandboxId) throw new UserError(publishBlocked(c, meta) ?? "There is nothing to push yet.", { code: "publish_blocked" });
	// A suspend or removal of the idle sandbox finishes first, as before a prompt.
	if (c.vars.idling) await c.vars.idling.catch(() => undefined);
	const { sandboxes } = await getLayer();
	const sandbox = meta.sandboxId ? await sandboxes.connect(meta.sandboxId) : undefined;
	if (!sandbox) {
		noteSandbox(c, meta, "none");
		throw new UserError("The sandbox with this agent's files is gone, so there is nothing to push. The next prompt starts a new one from the repository.", { code: "publish_blocked" });
	}
	noteSandbox(c, meta, "running");
	// Pushing uses the sandbox: the idle times count from here, and again from when it is done.
	markUsed(c, meta);
	const branch = meta.publishBranch ?? branchFor(meta.title, meta.sessionId);
	meta.publishBranch = branch;
	try {
		const published = await publishWork({ app, connection: await githubConnection(c, meta), repository: repo, sandbox, sessionId: meta.sessionId, branch, pull: meta.pull ?? null, pushed: meta.pushedHead ?? null, message });
		meta.pull = published.pull;
		if (published.head) meta.pushedHead = published.head;
		meta.updatedAt = Date.now();
		c.vars.pullCheckedAt = Date.now();
		note(c, meta.turns, "info", publishedLine(repo, published.pull, published.opened, published.committedFiles));
		console.log(`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${published.pull.number} opened=${published.opened}`);
		return { state: await afterPublish(c, meta, sandbox), opened: published.opened };
	} catch (error) {
		// The push went through and the pull request did not: what is at GitHub is remembered, so the next try only opens it.
		if (error instanceof PullProblem && error.head) meta.pushedHead = error.head;
		await afterPublish(c, meta, sandbox).catch(() => undefined);
		if (error instanceof GithubProblem) {
			console.warn(`[wlp] github.publish_failed session=${meta.sessionId} repository=${repo.id}: ${error.code}`);
			throw new UserError(error.message, { code: error.code === "github_gone" || error.code === "github_denied" ? error.code : "publish_failed" });
		}
		throw error;
	}
}

/** After a push, or one that failed half way: the commit changed what differs from the last commit, so the copy is taken again. */
async function afterPublish(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<PublishState> {
	c.vars.unpushed = null;
	if (!c.vars.turn && !((await copyWorkspace(c, sandbox)) ?? null)) await dropWorkspace(c);
	markUsed(c, meta);
	publish(c);
	await persist(c);
	return publishStateOf(c, meta);
}

/** The message of a push as the client sent it, checked. */
function cleanMessage(input: unknown): PublishMessage {
	const message = (typeof input === "object" && input !== null ? (input as { message?: unknown }).message : null) as { title?: unknown; body?: unknown } | null;
	if (typeof message !== "object" || message === null || typeof message.title !== "string" || (message.body !== undefined && message.body !== null && typeof message.body !== "string")) {
		throw new UserError("Give the commit a title.", { code: "bad_message" });
	}
	const title = message.title.replace(/\s+/g, " ").trim();
	const body = typeof message.body === "string" ? message.body.replace(/\r/g, "").trim() : "";
	if (title === "") throw new UserError("Give the commit a title.", { code: "bad_message" });
	if (title.length > MAX_PUBLISH_TITLE_CHARS) throw new UserError(`The title is ${title.length} characters long; the limit is ${MAX_PUBLISH_TITLE_CHARS}.`, { code: "bad_message" });
	if (body.length > MAX_PUBLISH_BODY_CHARS) throw new UserError(`The description is ${body.length} characters long; the limit is ${MAX_PUBLISH_BODY_CHARS}.`, { code: "bad_message" });
	return { title, body };
}

// ---------------------------------------------------------------------------------------------
// A turn's question
// ---------------------------------------------------------------------------------------------

function duration(ms: number): string {
	const plural = (count: number, unit: string) => (count === 1 ? `1 ${unit}` : `${count} ${unit}s`);
	if (ms >= 2 * 86_400_000 || (ms >= 86_400_000 && ms % 86_400_000 === 0)) return plural(Math.round(ms / 86_400_000), "day");
	if (ms >= 2 * 3_600_000 || (ms >= 3_600_000 && ms % 3_600_000 === 0)) return plural(Math.round(ms / 3_600_000), "hour");
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
	// A server's question that stood aside is put again, unless the turn is on its way out.
	if (!active.closed && !active.stopping) active.aside.shift()?.put?.();
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
	if (active.question?.put) {
		// A tool call's question comes first, as in Windlass's own interfaces: the call waits on it and the turn
		// with it, while a server only stays stopped. The server's question steps aside and is put again after this one.
		const aside = active.question;
		clearTimeout(aside.timer);
		aside.timer = undefined;
		active.question = null;
		active.aside.unshift(aside);
		if (meta.status === "waiting") meta.status = "running";
	} else if (active.question) {
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

/**
 * The user's approvals of projects' servers, kept beyond the sandbox Windlass keeps its own in: they
 * are in the user's `user` actor (server-approvals.ts), which every session of the user reaches from
 * whichever server it runs on. `approved` is asked before the question is put, and an approval of
 * exactly that definition for this session's project starts the server without asking; `remember` is
 * told when the user approves and Windlass took it. Like Windlass's own record, it does not outlast a
 * change of the definition, and it runs out 30 days after the user approved.
 */
const serverApprovals = {
	/** The approvals remembered for this session's project that have not run out, the newest first. */
	of(c: Ctx, meta: SessionMeta): Promise<ServerApproval[]> {
		return userActor(c, meta.uid).internalServerApprovals(projectOf(meta).key);
	},
	async approved(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<ServerApproval | null> {
		if (question.name === "" || question.fingerprint === "") return null;
		const approvals = await serverApprovals.of(c, meta);
		return approvals.find((approval) => approval.name === question.name && approval.fingerprint === question.fingerprint) ?? null;
	},
	async remember(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<void> {
		const project = projectOf(meta);
		await userActor(c, meta.uid).internalServerApprove({ project: project.key, label: project.label, name: question.name, fingerprint: question.fingerprint });
	},
	async forget(c: Ctx, meta: SessionMeta, name: string): Promise<number> {
		return (await userActor(c, meta.uid).internalServerForget({ project: projectOf(meta).key, name })).forgotten;
	},
};

const serverKey = (question: Pick<TurnServerQuestion, "name" | "fingerprint">) => `${question.name}:${question.fingerprint}`;

/** `promise`'s value, or null when it fails or takes longer than `ms`. */
function orNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}

/** Says that what the session knows of its project's servers, or of their approvals, changed: clients ask `servers()` again. */
function serversChanged(c: Ctx, meta: SessionMeta): void {
	meta.serversChangedAt = Math.max(Date.now(), (meta.serversChangedAt ?? 0) + 1);
	publish(c);
	void persist(c);
}

/** The layer's `onServers`: keeps what Windlass says of the project's servers, for the side panel. */
function knowServers(c: Ctx, meta: SessionMeta, said: TurnServer[]): void {
	const known = meta.servers ?? [];
	const next = knownServers(known, Array.isArray(said) ? said : [], Date.now());
	if (sameServers(known, next)) return;
	meta.servers = next;
	serversChanged(c, meta);
}

/** Keeps the user's yes for the session's project. A failure costs one more question in another session, and is logged. */
function rememberServer(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<void> {
	const work = serverApprovals.remember(c, meta, question).then(
		() => serversChanged(c, meta),
		(error: unknown) => c.log.warn({ msg: "could not remember the approval of a project's MCP server", session: meta.sessionId, server: question.name, error: describeError(error) }),
	);
	return c.vars.stopping ? work : c.keepAwake(work);
}

/** When the user approved, in the words of a line: "3 days ago". */
function ago(ms: number): string {
	return ms < 60_000 ? "a moment ago" : `${duration(ms)} ago`;
}

/** The session's servers as the side panel shows them: what the session kept, and what the user's record says of each. */
async function sessionServers(c: Ctx, meta: SessionMeta): Promise<SessionServers> {
	const known = meta.servers ?? [];
	const { sandboxes } = await getLayer();
	// A session whose project names no server asks nobody.
	const approvals = known.length === 0 ? [] : await serverApprovals.of(c, meta);
	const project = projectOf(meta);
	const context: ServerQuestionContext = { profile: sandboxes.profile(meta.profile), demo: meta.demo, dataInSandbox: sandboxes.sessionsLiveInSandbox, project };
	return serversView(project, known, approvals, forgettingWords(context), (server) => serverPanelWords(server, context));
}

/**
 * The layer's `onServerQuestion`: puts the question about a server the project's configuration names,
 * and returns the promise that `answer()`, the timeout, a stop or the turn's end settles: true to
 * start it. One asked before the prompt went (`holdsTurn`) turns the session to `waiting`, as a tool
 * call's does; one asked while the turn runs leaves it running. While a tool call's question is shown,
 * this one waits behind it. Where the user's approval of exactly this definition is remembered for the
 * session's project, nothing is put: the answer is yes, and the turn's line says why.
 */
async function askServer(c: Ctx, meta: SessionMeta, active: ActiveTurn, context: ServerQuestionContext, given: TurnServerQuestion, withdrawn: AbortSignal): Promise<boolean> {
	const gone = () => active.closed || active.stopping || active.controller.signal.aborted || withdrawn.aborted;
	const argv = Array.isArray(given?.argv) ? given.argv.map(str) : null;
	const question: TurnServerQuestion = {
		name: str(given?.name),
		fingerprint: str(given?.fingerprint),
		argv,
		url: argv === null ? str(given?.url) : null,
		file: typeof given?.file === "string" && given.file !== "" ? given.file : null,
		unset: Array.isArray(given?.unset) ? given.unset.map(str) : [],
		holdsTurn: given?.holdsTurn === true,
	};
	if (gone()) return false;
	// The user's own record first. Should it not answer in time, the user is asked, which is never wrong.
	const recalled = await orNull(serverApprovals.approved(c, meta, question), RECALL_WAIT_MS);
	if (gone()) return false;
	if (recalled) {
		active.recalled.set(serverKey(question), recalled);
		return true;
	}

	const words = serverQuestionWords(question, context);
	const now = Date.now();
	return new Promise<boolean>((resolve) => {
		let done = false;
		let shown = false;
		const settle = (start: boolean): void => {
			if (done) return;
			done = true;
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
			const at = active.aside.indexOf(asked);
			if (at >= 0) active.aside.splice(at, 1);
			clearTimeout(asked.timer);
			resolve(start);
		};
		const asked: Asked = {
			pending: {
				id: `q_${randomBytes(8).toString("hex")}`,
				turn: active.number,
				messageId: "",
				callId: "",
				title: words.title,
				subject: words.subject,
				details: words.details,
				choices: words.choices,
				subagent: null,
				askedAt: now,
				expiresAt: now + config.questionTimeoutMs,
				server: { name: question.name, file: question.file, remote: argv === null, unset: question.unset, holdsTurn: question.holdsTurn },
			},
			timer: undefined,
			server: { name: question.name, fingerprint: question.fingerprint },
			answer: (answer) => {
				if (done) return;
				const start = answer.choice === SERVER_START;
				// A yes gets its line, and is remembered, when Windlass has said what became of the server (`onServerApproved`).
				if (!start) note(c, active.number, "info", serverNotNowNote(question));
				settle(start);
			},
			decline: () => settle(false),
			put: () => {
				// Put again after it stood aside, it has the whole time to be answered in once more.
				if (shown) asked.pending = { ...asked.pending, expiresAt: Date.now() + config.questionTimeoutMs };
				shown = true;
				asked.timer = setTimeout(() => {
					// Nobody answered: "not now", and the turn goes on without the server.
					if (active.question !== asked) return;
					takeQuestion(c, meta, active);
					note(c, active.number, "warn", serverExpiredNote(question, duration(config.questionTimeoutMs)));
					publish(c);
					void persist(c);
					settle(false);
				}, Math.max(0, asked.pending.expiresAt - Date.now()));
				active.question = asked;
				if (question.holdsTurn && meta.status === "running") meta.status = "waiting";
				c.broadcast("question", asked.pending);
				publish(c);
				void persist(c);
			},
		};
		// The layer withdrew the question: the turn was stopped, or ended under a question put while it ran.
		function onWithdrawn(): void {
			if (done) return;
			if (!active.stopping && !active.controller.signal.aborted) note(c, active.number, "info", serverUnansweredNote(question));
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			settle(false);
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		if (active.question) active.aside.push(asked);
		else asked.put?.();
	});
}

/** Stops the turn. The question it may be waiting on goes first: nobody can answer a turn that is ending. */
function abortTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	active.stopping = true;
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
// An idle sandbox
// ---------------------------------------------------------------------------------------------

/** How long a check that failed, or found a prompt being accepted, waits before it looks again. */
const IDLE_RETRY_MS = 60_000;

function lastUsed(meta: SessionMeta): number {
	return meta.lastUsedAt ?? meta.updatedAt;
}

/** When the sandbox is next due: to be suspended while it runs, to be removed while it exists. Null when there is none. */
function idleDue(meta: SessionMeta): number | null {
	if (!meta.sandboxId) return null;
	return lastUsed(meta) + (meta.sandbox === "running" ? config.idleSuspendMs : config.idleDestroyMs);
}

/**
 * Sets the durable schedule to look at the session when its sandbox is next due, not before `notBefore`.
 * A check already set for that moment is kept; one set for another is replaced. Queued, so two calls
 * cannot both schedule; never rejects.
 */
function armIdle(c: Ctx, meta: SessionMeta, notBefore = 0): Promise<void> {
	const run = c.vars.arming.then(async () => {
		if (c.vars.destroying || c.vars.meta !== meta) return;
		const due = idleDue(meta);
		const at = due === null ? null : Math.max(due, notBefore);
		const current = meta.idleCheck ?? null;
		if (current?.at === at || (current === null && at === null)) return;
		meta.idleCheck = at === null ? null : { id: await c.schedule.at(at, "internalIdle"), at };
		// Written before the old one is cancelled: a crash in between leaves the old one, which still works.
		await persist(c);
		if (current) await c.schedule.cancel(current.id).catch(() => false);
	});
	c.vars.arming = run.catch((error) => {
		c.log.warn({ msg: "could not schedule the idle check of the sandbox", error: describeError(error) });
	});
	return c.vars.arming;
}

/** The durable schedule's visit: suspends or removes the sandbox when it is due, then sets the next visit. */
async function idleCheck(c: Ctx, meta: SessionMeta): Promise<void> {
	// A turn in progress, or one waiting on the user's answer, is never cut off: its end sets the next check.
	if (c.vars.turn || meta.status !== "idle") {
		console.log(`[wlp] sandbox.idle_kept session=${meta.sessionId} status=${meta.status}`);
		return;
	}
	// A prompt being accepted may fail before it starts a turn, and then nothing would set one.
	if (c.vars.accepting || c.vars.idling) {
		await armIdle(c, meta, Date.now() + IDLE_RETRY_MS);
		return;
	}
	const id = meta.sandboxId;
	const since = lastUsed(meta);
	const now = Date.now();
	const remove = id !== null && now >= since + config.idleDestroyMs;
	const suspend = id !== null && !remove && meta.sandbox === "running" && now >= since + config.idleSuspendMs;
	let retry = 0;
	if (id && (remove || suspend)) {
		// Set in the same step as the checks above: from here a prompt waits for it.
		const work = (async () => {
			const { sandboxes } = await getLayer();
			if (remove) {
				await sandboxes.destroy(id);
				console.log(`[wlp] sandbox.idle_removed id=${id} session=${meta.sessionId}`);
				meta.sandboxId = null;
				meta.sandbox = "none";
				meta.cloned = false;
				await dropWorkspace(c);
				note(c, meta.turns, "info", `Removed the sandbox and its files after ${duration(config.idleDestroyMs)} without use; the next prompt starts a new one.`);
			} else {
				const state = await sandboxes.state(id);
				if (state === "running") {
					await sandboxes.suspend(id);
					console.log(`[wlp] sandbox.idle_suspended id=${id} session=${meta.sessionId}`);
					meta.sandbox = "paused";
					note(c, meta.turns, "info", `Suspended the sandbox after ${duration(config.idleSuspendMs)} without use; the next prompt resumes it.`);
				} else {
					// Paused by a sleep, or gone: nothing to suspend, and nothing to say.
					meta.sandbox = state;
				}
			}
			publish(c);
			await persist(c);
		})();
		c.vars.idling = work;
		try {
			await work;
		} catch (error) {
			c.log.error({ msg: remove ? "could not remove the idle sandbox" : "could not suspend the idle sandbox", sandbox: id, error: describeError(error) });
			retry = Date.now() + IDLE_RETRY_MS;
		} finally {
			c.vars.idling = null;
		}
	}
	await armIdle(c, meta, retry);
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
	let resumed = meta.windlassSessionId;
	let layer: SandboxLayer | null = null;
	let result: RunTurnResult | null = null;
	let problem: string | null = null;
	let events = 0;
	let open = true;
	let used: SandboxHandle | null = null;
	// A turn that never ends would hold its sandbox, and one of the user's running slots, for ever.
	const limit = setTimeout(() => {
		if (!open) return;
		note(c, turn, "warn", `This turn ran for ${duration(TURN_TIMEOUT_MS)}, which is the limit, so it was stopped.`);
		abortTurn(c, meta, active);
	}, TURN_TIMEOUT_MS);

	try {
		await persist(c);
		layer = await getLayer();
		const sandbox = await openSandbox(c, meta, turn, signal, layer);
		used = sandbox;
		// Read after the sandbox is open: a sandbox made in place of a lost one has the session only when its copy was restored.
		resumed = meta.windlassSessionId;
		if (!signal.aborted) {
			if (meta.status === "starting") {
				meta.status = "running";
				publish(c);
				void persist(c);
			}
			// Told once: with the first prompt Windlass takes in the new sandbox.
			const fresh = meta.freshWorkspace === true;
			// What the question about a project's server has to say depends on where this session runs.
			const servers: ServerQuestionContext = { profile: layer.sandboxes.profile(meta.profile), demo: meta.demo, dataInSandbox: layer.sandboxes.sessionsLiveInSandbox, project: projectOf(meta) };
			result = await layer.windlass.runTurn(sandbox, {
				prompt: fresh ? FRESH_WORKSPACE + text : text,
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
				// The project's own MCP servers, which Windlass leaves stopped until the user says otherwise.
				onServerQuestion: (question, withdrawn) => askServer(c, meta, active, servers, question, withdrawn),
				onServerApproved: (question, outcome) => {
					const named = { name: str(question?.name), fingerprint: str(question?.fingerprint) };
					const recalled = active.recalled.get(serverKey(named));
					const said = recalled ? serverRecalledNote(question, outcome, ago(Date.now() - recalled.approvedAt)) : serverApprovedNote(question, outcome);
					note(c, turn, said.level, said.text);
					// The user's yes is kept once Windlass took it: a definition that had changed, or an approval that
					// never reached Windlass, is not one. Using a remembered approval does not renew it.
					if (!recalled && (outcome.state === "running" || outcome.state === "starting" || outcome.state === "failed")) void rememberServer(c, meta, named);
				},
				onServers: (said) => {
					if (open) knowServers(c, meta, said);
				},
				onControl: (control) => {
					if (open) active.control = control;
				},
			});
			// Windlass took the prompt if it said anything at all; a turn that never reached it is told again.
			if (fresh && events > 0) meta.freshWorkspace = false;
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

		// The turn may have changed the workspace: a new copy, taken before the turn is reported as ended so
		// that whoever asks then gets it. Without one (the actor is stopping, or git failed) the old copy is
		// wrong, and the next read goes to the sandbox.
		if (used) {
			// Windlass's session is copied out of the sandbox meanwhile, when Windlass ran: both only read.
			const saving = result && layer ? saveBackup(c, meta, turn, used, layer) : undefined;
			const copied = c.vars.stopping || c.vars.destroying ? null : await copyWorkspace(c, used);
			if (!copied) await dropWorkspace(c);
			await saving;
		}

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
		meta.lastUsedAt = meta.updatedAt;
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
		meta.lastUsedAt = Date.now();
		meta.turnStartedAt = null;
		c.vars.turn = null;
		c.vars.pending = [];
		publish(c);
		await persist(c);
	}
	// The idle times count from here.
	await armIdle(c, meta);
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
			await db.execute("CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), files TEXT NOT NULL, diff TEXT NOT NULL)");
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
				repo: typeof input.repo === "object" && input.repo !== null ? input.repo : null,
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
			idling: null,
			workspace: undefined,
			arming: Promise.resolve(),
			publishing: false,
			pullCheckedAt: 0,
			unpushed: null,
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
				// RivetKit may have let go of the actor's state by the time the signal fires, and reading
				// `c.vars` then throws "Actor stopping". Thrown from a listener, that is an uncaught
				// error, which ends the whole server and every other session on it. A turn still
				// running then is stopped by `onSleep`.
				try {
					if (c.vars.turn) abortTurn(c, meta, c.vars.turn);
				} catch (error) {
					console.warn(`[wlp] session=${meta.sessionId}: the actor was already stopping when its abort signal fired (${describeError(error)})`);
				}
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
			meta.lastUsedAt = meta.updatedAt;
			meta.turnStartedAt = null;
			// What that turn wrote to Windlass's session was not copied out of the sandbox: the copy is behind it.
			if (meta.backup) meta.memoryTurn = turn;
			await persist(c);
			publish(c);
		}
		// The sandbox may have been paused, removed or left running while the actor was away. A session
		// from before the idle checks, or one whose check was lost, gets one here.
		void c.keepAwake(refreshSandbox(c, meta).then(() => armIdle(c, meta)));
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
		// A paused sandbox is due for removal later: the schedule wakes the actor for it.
		await within(armIdle(c, meta), REPORT_WAIT_MS);
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
		if (meta.sandboxId) {
			try {
				const { sandboxes } = await getLayer();
				await sandboxes.destroy(meta.sandboxId);
				console.log(`[wlp] sandbox.destroyed id=${meta.sandboxId} session=${meta.sessionId}`);
			} catch (error) {
				c.log.error({ msg: "could not destroy the sandbox", sandbox: meta.sandboxId, error: describeError(error) });
			}
		}
		// After the sandbox, which is what uploads: nothing can put the copy back once it is removed.
		await removeBackup(c, meta);
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
			// The platform is committing and pushing the workspace: the agent does not start under it.
			if (c.vars.publishing) throw new UserError("The platform is pushing this agent's work to GitHub. Send the prompt again in a moment.", { code: "turn_running" });

			const effort = input.effort === undefined || input.effort === null || input.effort === "" ? null : input.effort;
			if (effort !== null && !EFFORTS.includes(effort)) {
				throw new UserError(`The effort must be one of: ${EFFORTS.join(", ")}`, { code: "bad_effort" });
			}

			// Nothing was awaited since the check above, so this prompt is the only one past it.
			c.vars.accepting = true;
			let claimed = false;
			try {
				// A suspend or removal of the idle sandbox finishes first; the turn then resumes or recreates it.
				if (c.vars.idling) await c.vars.idling.catch(() => undefined);
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

				const active: ActiveTurn = { number: turn, effort, controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), aside: [], recalled: new Map(), stopping: false, closed: false };
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
			turn.stopping = true;
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
			// A server's question that stands aside for a tool call's is still open: whoever saw it may answer it.
			const asked = active?.question?.pending.id === input.questionId ? active.question : active?.aside.find((candidate) => candidate.pending.id === input.questionId);
			if (!active || !asked || active.stopping || active.closed) {
				throw new UserError("That question is not waiting for an answer any more.", { code: "no_question" });
			}
			const choice = asked.pending.choices.find((candidate) => candidate.id === input.choice);
			if (!choice) {
				throw new UserError(`That is not one of the question's answers. Choose one of: ${asked.pending.choices.map((candidate) => candidate.label).join(", ")}`, { code: "bad_choice" });
			}
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
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
			try {
				const view = await workspaceView(c, meta);
				if (view === null) return [];
				return "sandbox" in view ? ((await readFiles(c, view.sandbox)) ?? []) : view.files;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's changes could not be read.");
			}
		},

		diff: async (c): Promise<string> => {
			requireUser(c);
			const meta = liveMeta(c);
			try {
				const view = await workspaceView(c, meta);
				if (view === null) return "";
				return "sandbox" in view ? ((await readDiff(c, view.sandbox)) ?? "") : view.diff;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's diff could not be read.");
			}
		},

		publishState: async (c): Promise<PublishState> => {
			requireUser(c);
			const meta = liveMeta(c);
			try {
				await checkPull(c, meta);
				return await publishStateOf(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The pull request's state could not be read.");
			}
		},

		publish: async (c, input: { message: PublishMessage }): Promise<PublishResult> => {
			requireUser(c);
			const meta = liveMeta(c);
			const message = cleanMessage(input);
			const repo = meta.repo;
			if (!repo) throw new UserError("This agent does not work on a repository of your GitHub connection, so there is nowhere to push.", { code: "publish_blocked" });
			const blocked = publishBlocked(c, meta);
			if (blocked) throw new UserError(blocked, { code: "publish_blocked" });
			// Nothing was awaited since the check: this push is the only one past it.
			c.vars.publishing = true;
			try {
				return await c.keepAwake(publishSession(c, meta, repo, message));
			} catch (error) {
				throw clientError(c.log, error, "The work could not be pushed. Try again.");
			} finally {
				c.vars.publishing = false;
			}
		},

		servers: async (c): Promise<SessionServers> => {
			requireUser(c);
			const meta = liveMeta(c);
			try {
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The project's MCP servers could not be read.");
			}
		},

		approveServer: async (c, input: { name: string; fingerprint: string }): Promise<SessionServers> => {
			requireUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.name !== "string" || input.name === "" || typeof input.fingerprint !== "string" || input.fingerprint === "") {
				throw new UserError("Say which server to approve, and which definition of it.", { code: "bad_server" });
			}
			const server = (meta.servers ?? []).find((candidate) => candidate.name === input.name);
			if (!server) throw new UserError("This session's project no longer names an MCP server of that name.", { code: "server_gone" });
			// The approval is of the definition the user was shown: one the session has since seen change, start or go is not it.
			if (server.state !== "waiting" || server.fingerprint !== input.fingerprint) {
				throw new UserError(`The MCP server "${server.name}" no longer waits with the definition shown here. Read the list again and look at it once more.`, { code: "server_changed" });
			}
			try {
				const active = c.vars.turn;
				// A question about exactly this definition is open: this answers it, and the server starts now.
				const asked = active && !active.stopping && !active.closed ? [active.question, ...active.aside].find((candidate) => candidate?.server?.name === server.name && candidate.server.fingerprint === input.fingerprint) : undefined;
				if (active && asked) {
					if (active.question === asked) {
						takeQuestion(c, meta, active);
						publish(c);
						void persist(c);
					}
					asked.answer({ choice: SERVER_START });
				} else {
					// No Windlass runs between turns, and one that runs has asked about this definition already: the
					// approval is kept, and the next turn's Windlass is told of it before its prompt goes.
					await serverApprovals.remember(c, meta, { name: server.name, fingerprint: input.fingerprint });
					note(c, meta.turns, "info", serverPanelApprovedNote(server));
					serversChanged(c, meta);
				}
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be remembered. Try again.");
			}
		},

		forgetServer: async (c, input: { name: string }): Promise<SessionServers> => {
			requireUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.name !== "string" || input.name === "" || input.name.length > 200) {
				throw new UserError("Say which server's approval to forget.", { code: "bad_server" });
			}
			try {
				const forgotten = await serverApprovals.forget(c, meta, input.name);
				if (forgotten > 0) {
					const { sandboxes } = await getLayer();
					note(c, meta.turns, "info", serverForgottenNote({ name: input.name }, { dataInSandbox: sandboxes.sessionsLiveInSandbox }));
					serversChanged(c, meta);
				}
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be forgotten. Try again.");
			}
		},

		// --- called by the actor's own schedule only ------------------------------------------------

		internalIdle: async (c): Promise<void> => {
			// RivetKit sets `scheduledFire` on the context of a call its schedule makes; a client cannot.
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			if (!meta || c.vars.destroying) return;
			// A check that was replaced by a later one, and whose cancel did not reach it, does nothing.
			if (meta.idleCheck && meta.idleCheck.id !== c.scheduledFire.id) return;
			try {
				await idleCheck(c, meta);
			} catch (error) {
				c.log.error({ msg: "the idle check of the sandbox failed", error: describeError(error) });
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
				// The copy of Windlass's session goes with the session, once the sandbox that uploads it is gone.
				await removeBackup(c, meta);
			}
			c.destroy();
		},
	},
});
