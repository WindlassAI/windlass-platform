/**
 * Running Windlass in a sandbox. One turn is one process that speaks the Agent Client Protocol:
 *
 *   docker exec -i -w /workspace -e WINDLASS_WAKE=off -e WINDLASS_ACP_LOG=warn [-e WINDLASS_ACP_SCRIPT=<file>] \
 *     wlp-session-<id> wlp-run exec <tag> windlass acp
 *
 * driven over its stdin and stdout as the `windlass` command line drives its own engine (Windlass's
 * docs/acp.md, "The command line is an ACP client"):
 *
 *   initialize                         every engine event is asked for as `_windlass/event`, no standard updates
 *   session/new | _windlass/resolve + session/resume
 *                                      model, effort, the profile's approval mode, whether anyone can answer
 *   session/prompt                     answered when the turn ends, with how it ended
 *     <- _windlass/event               passed on unchanged, in order
 *     <- session/request_permission    a tool call's approval question, put to `onQuestion`
 *     -> _windlass/steer               a message into the running turn (`TurnControl.steer`)
 *     -> _windlass/cancel_call         one running tool call stopped (`TurnControl.cancelCall`)
 *     -> session/cancel                the turn stopped (`signal`)
 *   session/close, stdin closed        the process lets go of the session and exits
 *
 * No prompt text is ever on a command line. The process lives for one turn, so nothing has to be kept
 * between turns and a server that restarts loses nothing but the turn it was running.
 */

import type { WindlassEvent } from "../contract.js";
import type { RunTurnInput, RunTurnResult, SandboxHandle, ScriptedModel, TurnAnswer, TurnControl, TurnQuestion, Windlass } from "./api.js";
import { AcpConnection, AcpError, LineSplitter, MethodNotFound } from "./acp.js";
import { demoScript } from "./demo.js";
import { IMAGE, WORKSPACE, docker, helperFlags, randomId, runHelper, tmpName } from "./docker.js";
import { findProfile } from "./profiles.js";
import { DockerSandboxHandle, type ProcessEnd, type SandboxProcess } from "./sandboxes.js";

/** Windlass's own default first. `--models` needs a signed-in account, so this list stands in. */
export const BUILTIN_MODELS = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"];

/** The key of Windlass's extensions in `_meta` and in an error's `data`, and the prefix of its methods. */
const NS = "windlass";
const EXT = {
	event: `_${NS}/event`,
	steer: `_${NS}/steer`,
	cancelCall: `_${NS}/cancel_call`,
	resolve: `_${NS}/resolve`,
};
const PROTOCOL_VERSION = 1;

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const STDERR_TAIL = 4000;
const STDERR_KEPT = 64 * 1024;

/** How long the engine may take to start and answer `initialize` (the command line's own limit). */
export const START_TIMEOUT_MS = 20_000;
/** How long opening a session may take: with a real model the account's models are read first. */
const OPEN_TIMEOUT_MS = 90_000;
/** How long an engine whose client went away may hold its sessions: its shutdown limit (5 s) and a margin. */
const WINDING_DOWN_MS = 6000;
/** After a cancel, how long a pending question waits for the engine's interrupt before it is answered `cancelled` anyway. */
const CANCEL_ANSWER_MS = 1000;
/** After a cancel, how long the turn may take to end (a command gets 3 s between SIGTERM and SIGKILL) before signals are sent. */
const CANCEL_WAIT_MS = 6000;
/** How long `session/close` may take. */
const CLOSE_TIMEOUT_MS = 5000;
/** How long the process may take to exit once its stdin is closed, before it is signalled. */
const EXIT_WAIT_MS = 3000;
/** What `session/close` and the exit get instead, once a cancel has gone unanswered. */
const FORCED_WAIT_MS = 1500;
/** After the turn's end, how long a message admitted too late to be part of it may take to start its own execution. */
const FOLLOW_UP_MS = 3000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]).finally(() => clearTimeout(timer));
}

export interface DockerWindlassOptions {
	/** The command that serves ACP on stdio inside the sandbox. Default `windlass acp`; another one stands in for it in the layer's own checks. */
	engineCommand?: string[];
	/** How long the engine may take to answer `initialize`. Default `START_TIMEOUT_MS`. */
	startTimeoutMs?: number;
}

export class DockerWindlass implements Windlass {
	private versionCache: { imageId: string; version: string } | null = null;

	constructor(private readonly options: DockerWindlassOptions = {}) {}

	async version(): Promise<string | null> {
		const image = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
		if (image.code !== 0) return null;
		const imageId = image.stdout.trim();
		if (this.versionCache?.imageId === imageId) return this.versionCache.version;
		const helper = tmpName();
		const result = await runHelper(helperFlags(helper, "none"), helper, ["windlass", "--version"], { timeoutMs: 60_000 });
		// "Windlass 0.1.0 (linux-arm64)"
		const match = /^\S+\s+(\S+)/.exec(result.stdout.trim());
		if (result.code !== 0 || match === null) return null;
		this.versionCache = { imageId, version: match[1]! };
		return match[1]!;
	}

	async models(): Promise<string[]> {
		return [...BUILTIN_MODELS];
	}

	demoScript(prompt: string, turn: number): ScriptedModel {
		return demoScript(prompt, turn);
	}

	async runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		if (!(sandbox instanceof DockerSandboxHandle)) throw new Error("runTurn needs a sandbox from this layer's connect()");
		if (input.windlassSessionId !== undefined && !SESSION_ID.test(input.windlassSessionId)) throw new Error(`invalid Windlass session id: ${input.windlassSessionId}`);
		if (input.signal?.aborted) return { exitCode: null, aborted: true, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: null };
		return new Turn(sandbox, input, this.options).run();
	}
}

type Failure = { reason: string; message: string };
type Outcome = "succeeded" | "unresolved" | "failed" | "stopped" | "interrupted";

interface Usage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
}

/**
 * What the command line's `cli.summary` line says about a turn, added up from its events the same way
 * (Windlass's packages/cli/src/renderer.ts, `JsonSink`): steps, the summary requests of compactions,
 * token use, and the time from `execution.started` to the event that ended it.
 */
class Tally {
	private startedAt: number | null = null;
	private steps = 0;
	private summaryCalls = 0;
	private usage: Usage | null = null;
	/** The execution at work, by its id. */
	running: string | null = null;
	/** The execution that ended last, and how its event says it ended. */
	last: { executionId: string; sessionId: string; outcome: Outcome; message: string | null; time: number } | null = null;

	note(event: WindlassEvent): void {
		const data = (event.data ?? {}) as Record<string, unknown>;
		const time = typeof event.time === "number" ? event.time : Date.now();
		switch (event.type) {
			case "execution.started":
			case "execution.resumed":
				this.startedAt ??= time;
				this.running = typeof data.executionId === "string" ? data.executionId : "";
				return;
			case "step.started":
				this.steps += 1;
				return;
			case "compaction.failed":
				this.summaryCalls += typeof data.calls === "number" ? data.calls : 0;
				return;
			case "compaction.ended":
				this.summaryCalls += typeof data.calls === "number" ? data.calls : 0;
				return this.add(data.usage);
			case "step.ended":
			case "step.failed":
			case "step.refused":
				return this.add(data.usage);
			case "execution.succeeded":
			case "execution.failed":
			case "execution.interrupted": {
				const verification = data.verification as { status?: unknown } | undefined;
				const outcome: Outcome =
					event.type === "execution.succeeded" ? (verification?.status === "unresolved" ? "unresolved" : "succeeded") : event.type === "execution.failed" ? (data.cause === "approval" ? "stopped" : "failed") : "interrupted";
				this.running = null;
				this.last = {
					executionId: typeof data.executionId === "string" ? data.executionId : "",
					sessionId: typeof event.sessionId === "string" ? event.sessionId : "",
					outcome,
					message: typeof data.message === "string" ? data.message : null,
					time,
				};
				return;
			}
		}
	}

	/** The summary event, with `outcome` in place of the event's own when the prompt's answer gave one. */
	summary(outcome: Outcome | null): WindlassEvent | null {
		const last = this.last;
		if (last === null) return null;
		const usage = this.usage;
		return {
			type: "cli.summary",
			sessionId: last.sessionId,
			executionId: last.executionId,
			outcome: outcome ?? last.outcome,
			steps: this.steps,
			summaryCalls: this.summaryCalls,
			requests: this.steps + this.summaryCalls,
			durationMs: this.startedAt === null ? 0 : Math.max(0, last.time - this.startedAt),
			usage,
			cachedShare: usage === null || usage.inputTokens === 0 ? null : Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000,
		};
	}

	private add(raw: unknown): void {
		if (typeof raw !== "object" || raw === null) return;
		const usage = raw as Partial<Usage>;
		const number = (value: unknown) => (typeof value === "number" ? value : 0);
		const sum = this.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
		this.usage = {
			inputTokens: sum.inputTokens + number(usage.inputTokens),
			cachedInputTokens: sum.cachedInputTokens + number(usage.cachedInputTokens),
			outputTokens: sum.outputTokens + number(usage.outputTokens),
			reasoningTokens: sum.reasoningTokens + number(usage.reasoningTokens),
		};
	}
}

/** One turn: the process, the connection, and everything that has to be told apart while it runs. */
class Turn {
	private readonly approval: "auto" | "full";
	private process: SandboxProcess | null = null;
	private readonly peer: AcpConnection;
	private processEnd: ProcessEnd | null = null;
	private stderr = "";
	private readonly notes: string[] = [];

	/** The session this turn works in, once it is known: events of any other are not this turn's. */
	private session: string | null = null;
	/** Events that arrived before `session/new` named the session. */
	private early: Array<{ sessionId: string; event: WindlassEvent }> = [];
	private sessionSeen: string | null = null;
	private readonly tally = new Tally();
	private summary: WindlassEvent | null = null;
	/** Nothing more is passed to `onEvent`: the summary was the last. */
	private sealed = false;

	private failure: Failure | null = null;
	private promptSent = false;
	/** The prompt was answered, with a result or an error. */
	private promptSettled = false;
	/** How the prompt's answer says its execution ended. */
	private promptEnding: { executionId: string | null; outcome: Outcome | null } | null = null;
	private steersInFlight = 0;
	/** Messages steered in that Windlass admitted and has not delivered to the model yet. */
	private readonly undelivered = new Set<string>();
	private readonly delivered = new Set<string>();
	private followUpTimer: ReturnType<typeof setTimeout> | undefined;

	/** The turn's work is over, or was cut off: `control` rejects from here on. */
	private over = false;
	private resolveOver: () => void = () => {};
	private readonly whenOver = new Promise<void>((resolve) => (this.resolveOver = resolve));

	private abortRequested = false;
	private resolveAborted: () => void = () => {};
	private readonly whenAborted = new Promise<"aborted">((resolve) => (this.resolveAborted = () => resolve("aborted")));
	/** `session/cancel` was sent. */
	private cancelSent = false;
	private cancelTimer: ReturnType<typeof setTimeout> | undefined;
	/** The cancel did not end the turn in time: it is cut off. */
	private forced = false;
	/** The process had to be signalled: it has no exit code of its own. */
	private signalled = false;
	/** Resolves once the engine has recorded the interrupt (or a moment after the cancel): pending questions are answered `cancelled` then. */
	private resolveInterrupted: () => void = () => {};
	private readonly whenInterrupted = new Promise<void>((resolve) => (this.resolveInterrupted = resolve));
	private readonly questions = new Set<AbortController>();
	/** One question at a time: the next waits for the one before it. */
	private questionLine: Promise<void> = Promise.resolve();

	constructor(
		private readonly sandbox: DockerSandboxHandle,
		private readonly input: RunTurnInput,
		private readonly options: DockerWindlassOptions,
	) {
		this.approval = findProfile(sandbox.profile).approval;
		this.peer = new AcpConnection((line) => this.process?.write(`${line}\n`) ?? false, { notification: (method, params) => this.notification(method, params), request: (method, params) => this.request(method, params) }, NS);
	}

	async run(): Promise<RunTurnResult> {
		const { sandbox, input } = this;
		const scriptPath = input.script === undefined ? null : `/tmp/.wlp-script-${randomId(6)}.json`;
		const onAbort = () => this.abort();
		try {
			if (await this.prepare(scriptPath)) {
				const lines = new LineSplitter((line) => this.peer.receive(line));
				const run = sandbox.start(this.options.engineCommand ?? ["windlass", "acp"], {
					env: {
						// A server that lives for one turn must not start other sessions' wake-up turns, as the command line's one-prompt runs do not.
						WINDLASS_WAKE: "off",
						// Only warnings and errors on stderr: that is what `stderrTail` is for.
						WINDLASS_ACP_LOG: "warn",
						...(scriptPath === null ? {} : { WINDLASS_ACP_SCRIPT: scriptPath }),
					},
					onStdout: (chunk) => lines.push(chunk),
					onStderr: (chunk) => (this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT)),
				});
				this.process = run;
				void run.ended.then((end) => {
					lines.flush();
					this.processEnd = end;
					this.peer.end(end.error !== null ? end.error.message : `the engine process ${describeEnd(end)}`);
					this.resolveInterrupted();
					this.finish();
				});
				input.signal?.addEventListener("abort", onAbort, { once: true });
				if (input.signal?.aborted) this.abort();

				await this.converse();
				await this.end();
			}
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
			clearTimeout(this.cancelTimer);
			clearTimeout(this.followUpTimer);
			const run = this.process;
			if (run !== null) {
				// Whatever happened above, nothing of the turn stays behind in the sandbox. A process that ended on its own
				// after an orderly close has nothing left to wait for; one whose client was cut off may still be shutting down inside.
				if (!run.hasEnded) await this.stopProcess(true);
				const left = await sandbox.sweep(run.tag, { waitMs: this.orderly() ? 0 : WINDING_DOWN_MS, files: scriptPath === null ? [] : [scriptPath] }).catch(() => 0);
				if (left > 0) this.notes.push(`[platform] ${left} process(es) of the turn could not be stopped`);
			} else if (scriptPath !== null) {
				await docker(["exec", sandbox.container, "rm", "-f", scriptPath], { timeoutMs: 10_000 }).catch(() => undefined);
			}
		}

		const end = this.processEnd;
		// The turn counts as aborted when the abort is what ended it, not when it came after the turn's own end.
		const ownEnding = this.summary !== null && this.summary.outcome !== "interrupted";
		const aborted = this.abortRequested && !(ownEnding && !this.forced);
		const said = [...this.notes, this.stderr.trimEnd()];
		if (this.peer.notJson.length > 0) said.push(`[stdout, not protocol messages]\n${this.peer.notJson.join("\n")}`);
		const stderrTail = said.filter((part) => part !== "").join("\n");
		return {
			exitCode: end === null || end.signal !== null || this.signalled ? null : end.code,
			aborted,
			timedOut: false,
			windlassSessionId: this.sessionSeen,
			summary: this.summary,
			stderrTail: stderrTail.slice(-STDERR_TAIL),
			failure: aborted ? null : this.failure,
		};
	}

	/** What has to be so before the engine starts. False, with `failure` set, when the sandbox cannot be used. */
	private async prepare(scriptPath: string | null): Promise<boolean> {
		try {
			// One turn at a time per sandbox: a Windlass still running here is left over from a turn whose server or
			// client went away, and it would hold the session ("in use by another windlass process").
			const [leftovers] = await Promise.all([this.sandbox.stopLeftovers("windlass"), scriptPath === null ? undefined : this.sandbox.writeTextFile(scriptPath, JSON.stringify(this.input.script))]);
			if (leftovers > 0) this.notes.push(`[platform] stopped ${leftovers} Windlass run(s) left over in this sandbox before starting the turn`);
			return true;
		} catch (error) {
			this.failure = { reason: "engine", message: `the engine could not be started in the sandbox: ${error instanceof Error ? error.message : String(error)}` };
			return false;
		}
	}

	private get startTimeoutMs(): number {
		return this.options.startTimeoutMs ?? START_TIMEOUT_MS;
	}

	/** Whether the process ended on its own after an orderly close: then nothing of it can still be shutting down inside the sandbox. */
	private orderly(): boolean {
		return this.processEnd !== null && this.processEnd.signal === null && this.processEnd.error === null && !this.signalled;
	}

	// ---- the conversation ----

	/** From `initialize` to the turn's end. Sets `failure` instead of throwing. */
	private async converse(): Promise<void> {
		const { input, peer } = this;
		try {
			const init = await this.unlessAborted(
				peer.request<{ agentCapabilities?: { _meta?: Record<string, unknown> } }>(
					"initialize",
					{ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "windlass-platform", title: "Windlass Platform", version: "0" }, clientCapabilities: { _meta: { [NS]: { events: true, updates: false } } } },
					{ timeoutMs: this.startTimeoutMs },
				),
			);
			if (init === "aborted") return;
			const offered = init.agentCapabilities?._meta?.[NS] as { notifications?: unknown } | undefined;
			if (!Array.isArray(offered?.notifications) || !offered.notifications.includes(EXT.event)) {
				this.failure = { reason: "engine", message: `the engine process does not send Windlass's events (${EXT.event}); it may be another version` };
				return;
			}
		} catch (error) {
			this.failure = { reason: "engine", message: await this.startFailure(error) };
			return;
		}

		try {
			const opened = await this.unlessAborted(this.open());
			if (opened === "aborted" || this.abortRequested) return;
		} catch (error) {
			this.failure = this.failureOf(error);
			return;
		}

		this.promptSent = true;
		void peer.request<{ stopReason?: unknown; _meta?: Record<string, unknown> }>("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text: input.prompt }] }).then(
			(result) => {
				const turn = result?._meta?.[NS] as { executionId?: unknown; outcome?: unknown } | undefined;
				const outcome = typeof turn?.outcome === "string" && ["succeeded", "unresolved", "failed", "interrupted"].includes(turn.outcome) ? (turn.outcome as Outcome) : result?.stopReason === "cancelled" ? "interrupted" : null;
				this.promptEnding = { executionId: typeof turn?.executionId === "string" ? turn.executionId : null, outcome };
				this.promptSettled = true;
				this.check();
			},
			(error: unknown) => {
				// A connection that ended is told by the process's end; a session closed under the prompt is this turn's own doing.
				if (!(error instanceof AcpError && (error.reason === "closed" || error.code === -32800))) this.failure ??= this.failureOf(error, "execution_failed");
				this.promptSettled = true;
				this.check();
			},
		);
		if (input.onControl !== undefined) {
			try {
				input.onControl(this.control());
			} catch {
				// A listener's failure must not stop the turn.
			}
		}
		await this.whenOver;
	}

	/** `session/new`, or the session to continue: named with `_windlass/resolve`, opened with `session/resume`. */
	private async open(): Promise<void> {
		const { input, peer } = this;
		const meta = {
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.effort === undefined ? {} : { effort: input.effort }),
			approval: this.approval,
			// Whether anyone can answer a question. Without someone, a call that would ask is refused at once and the model is told.
			attended: input.onQuestion !== undefined,
			unattended: "deny",
		};
		if (input.windlassSessionId === undefined) {
			const made = await peer.request<{ sessionId?: unknown }>("session/new", { cwd: WORKSPACE, mcpServers: [], _meta: { [NS]: meta } }, { timeoutMs: OPEN_TIMEOUT_MS });
			if (typeof made?.sessionId !== "string") throw new AcpError("the engine opened a session without naming it", 0, null);
			this.adopt(made.sessionId);
			return;
		}
		const named = await peer.request<{ sessionId?: unknown; cwd?: unknown }>(EXT.resolve, { cwd: WORKSPACE, session: input.windlassSessionId }, { timeoutMs: OPEN_TIMEOUT_MS });
		const sessionId = typeof named?.sessionId === "string" ? named.sessionId : input.windlassSessionId;
		const cwd = typeof named?.cwd === "string" ? named.cwd : WORKSPACE;
		// Before the answer: what the open itself appends (a crashed turn's recovery) arrives ahead of it.
		this.adopt(sessionId);
		const deadline = Date.now() + WINDING_DOWN_MS;
		let told = false;
		for (;;) {
			try {
				// `archived: true` as the command line's --session: a session is opened whether or not it was archived.
				await peer.request("session/resume", { sessionId, cwd, mcpServers: [], _meta: { [NS]: { ...meta, archived: true } } }, { timeoutMs: OPEN_TIMEOUT_MS });
				return;
			} catch (error) {
				// Right after a turn was cut off, its engine may still be letting go of the session: that is waited for, as
				// the command line does. A session held by anything else is refused at once.
				if (!(error instanceof AcpError) || error.reason !== "session_in_use" || error.holderPid === null || this.abortRequested) throw error;
				if (Date.now() > deadline || !(await this.windingDown(error.holderPid))) throw error;
				if (!told) this.notes.push(`[platform] the session was still held by the engine of an earlier turn (pid ${error.holderPid}); waited for it to shut down`);
				told = true;
				await sleep(200);
			}
		}
	}

	/** Whether `pid` in the sandbox is an engine (`windlass acp`): one that is not this turn's can only be an earlier turn's, on its way out. */
	private async windingDown(pid: number): Promise<boolean> {
		const result = await docker(["exec", this.sandbox.container, "sh", "-c", 'tr "\\0" "\\n" < "/proc/$1/cmdline" | tail -n 1', "sh", String(pid)], { timeoutMs: 10_000 }).catch(() => null);
		return result !== null && result.code === 0 && result.stdout.trim() === "acp";
	}

	private adopt(sessionId: string): void {
		this.session = sessionId;
		const early = this.early;
		this.early = [];
		for (const item of early) if (item.sessionId === sessionId) this.event(item.event);
	}

	private control(): TurnControl {
		const ended = () => new Error("the turn has ended");
		return {
			steer: async (text) => {
				if (this.over) throw ended();
				if (this.cancelSent) throw new Error("the turn is being stopped");
				this.steersInFlight += 1;
				try {
					const admitted = await this.peer.request<{ messageId?: unknown }>(EXT.steer, { sessionId: this.session, prompt: [{ type: "text", text }] });
					if (typeof admitted?.messageId === "string" && !this.delivered.has(admitted.messageId)) this.undelivered.add(admitted.messageId);
				} catch (error) {
					throw this.over ? ended() : new Error(error instanceof Error ? error.message : String(error));
				} finally {
					this.steersInFlight -= 1;
					this.check();
				}
			},
			cancelCall: async (messageId, callId) => {
				if (this.over) throw ended();
				try {
					const result = await this.peer.request<{ stopped?: unknown; message?: unknown }>(EXT.cancelCall, { sessionId: this.session, callId, messageId });
					return { stopped: result?.stopped === true, message: typeof result?.message === "string" ? result.message : null };
				} catch (error) {
					throw this.over ? ended() : new Error(error instanceof Error ? error.message : String(error));
				}
			},
		};
	}

	// ---- what the engine sends ----

	private notification(method: string, params: Record<string, unknown>): void {
		if (method !== EXT.event) return;
		const event = params.event as WindlassEvent | undefined;
		if (typeof params.sessionId !== "string" || typeof event !== "object" || event === null || typeof event.type !== "string") return;
		// History a load would replay: never part of this turn.
		if (params.replay === true) return;
		if (this.session === null) this.early.push({ sessionId: params.sessionId, event });
		else if (params.sessionId === this.session) this.event(event);
	}

	private event(event: WindlassEvent): void {
		if (this.sealed) return;
		if (this.sessionSeen === null && typeof event.sessionId === "string") this.sessionSeen = event.sessionId;
		this.tally.note(event);
		const data = (event.data ?? {}) as Record<string, unknown>;
		if ((event.type === "inbox.delivered" || event.type === "inbox.cancelled") && typeof data.messageId === "string") {
			this.delivered.add(data.messageId);
			this.undelivered.delete(data.messageId);
		}
		// The engine has withdrawn what was pending: a question may be answered `cancelled` now.
		if (event.type === "execution.interrupt_requested") this.resolveInterrupted();
		try {
			this.input.onEvent(event);
		} catch {
			// A listener's failure must not stop the turn.
		}
		this.check();
	}

	private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (method === "session/request_permission") return this.permission(params);
		// The client's file system and terminal: Windlass's tools run inside the agent and never ask for them.
		throw new MethodNotFound(method);
	}

	/**
	 * A tool call's approval question. Anything else the engine asks this way (the hand-edit question of
	 * an undo, which this layer never starts) is declined.
	 */
	private async permission(params: Record<string, unknown>): Promise<unknown> {
		const cancelled = { outcome: { outcome: "cancelled" } };
		const question = questionOf(params);
		const ask = this.input.onQuestion;
		if (question === null || ask === undefined || params.sessionId !== this.session) return cancelled;
		const controller = new AbortController();
		const withdrawn = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
		this.questions.add(controller);
		const before = this.questionLine;
		let done = () => {};
		this.questionLine = new Promise<void>((resolve) => (done = resolve));
		try {
			if (this.cancelSent || this.over) controller.abort();
			await Promise.race([before, withdrawn]);
			let answer: TurnAnswer | null = null;
			if (!controller.signal.aborted) {
				answer = await Promise.race([
					Promise.resolve()
						.then(() => ask(question, controller.signal))
						.catch(() => null),
					withdrawn,
				]);
			}
			if (controller.signal.aborted) {
				// Answered once the engine has withdrawn the question: sooner, the answer could overtake the cancel
				// inside the engine and be recorded as the user's refusal.
				await this.whenInterrupted;
				return cancelled;
			}
			// A rejection, or a choice the question does not offer: declined, which is what a cancelled request means to Windlass.
			if (answer === null || typeof answer !== "object" || !question.choices.some((choice) => choice.id === answer.choice)) return cancelled;
			const note = typeof answer.note === "string" ? answer.note.trim() : "";
			return { outcome: { outcome: "selected", optionId: answer.choice }, ...(note === "" ? {} : { _meta: { [NS]: { note } } }) };
		} finally {
			this.questions.delete(controller);
			done();
		}
	}

	// ---- how the turn ends ----

	/**
	 * The turn is over when its prompt was answered, nothing steered in is still on its way, and no
	 * execution runs. A message Windlass admitted a moment after the execution ended starts another one
	 * (it is the same to Windlass as a prompt sent while idle): that one is this turn's too, and is
	 * waited for, so no message the user was told had been taken is cut off.
	 */
	private check(): void {
		if (this.over || !this.promptSettled || this.steersInFlight > 0 || this.tally.running !== null) return;
		const endedWell = this.tally.last !== null && (this.tally.last.outcome === "succeeded" || this.tally.last.outcome === "unresolved");
		if (this.undelivered.size > 0 && endedWell && !this.cancelSent) {
			// Its `execution.started` is on its way. Should it not come, the message stays in Windlass's inbox for the next turn.
			this.followUpTimer ??= setTimeout(() => {
				this.followUpTimer = undefined;
				if (this.tally.running === null && this.steersInFlight === 0) this.finish();
			}, FOLLOW_UP_MS);
			return;
		}
		this.finish();
	}

	private finish(): void {
		if (this.over) return;
		this.over = true;
		clearTimeout(this.cancelTimer);
		clearTimeout(this.followUpTimer);
		for (const question of this.questions) question.abort();
		// Without a cancel there is no interrupt to wait for before a question left open is answered.
		if (!this.cancelSent) this.resolveInterrupted();
		this.resolveOver();
	}

	/** The abort signal fired. */
	private abort(): void {
		// Once the turn's work is over there is nothing left to stop: it ended as it ended.
		if (this.abortRequested || this.over) return;
		this.abortRequested = true;
		this.resolveAborted();
		// With the prompt sent there is a turn to cancel; before that, `converse` gives up where it is.
		if (this.promptSent) this.cancel();
	}

	/** `session/cancel`: the turn is interrupted, a pending question is withdrawn, and the prompt is answered `cancelled`. */
	private cancel(): void {
		if (this.cancelSent || this.over) return;
		this.cancelSent = true;
		this.peer.notify("session/cancel", { sessionId: this.session });
		// The question's signal aborts at once, so whoever shows it can close it; its answer follows the engine's interrupt.
		for (const question of this.questions) question.abort();
		setTimeout(() => this.resolveInterrupted(), CANCEL_ANSWER_MS).unref();
		this.cancelTimer = setTimeout(() => {
			this.forced = true;
			this.finish();
		}, CANCEL_WAIT_MS);
		this.check();
	}

	private unlessAborted<T>(work: Promise<T>): Promise<T | "aborted"> {
		// The work is not waited for after an abort; its failure then is nobody's.
		work.catch(() => undefined);
		return Promise.race([work, this.whenAborted]);
	}

	/** The summary, the session let go of, and the process gone. */
	private async end(): Promise<void> {
		this.finish();
		const cutOff = this.tally.running !== null;
		// A turn that was cut off is closed first: what the engine records of that still belongs before the summary.
		if (cutOff) await this.closeSession();
		this.seal();
		if (!cutOff) await this.closeSession();
		await this.stopProcess(false);
	}

	private seal(): void {
		if (this.sealed) return;
		const last = this.tally.last;
		// With an execution still at work the turn was cut off before Windlass said how it ended: no summary then.
		if (last !== null && this.tally.running === null) {
			// How the prompt's answer says its execution ended; an execution a late message started has only its own event.
			const answered = this.promptEnding !== null && (this.promptEnding.executionId === null || this.promptEnding.executionId === last.executionId) ? this.promptEnding.outcome : null;
			const summary = this.tally.summary(answered);
			if (summary !== null) {
				this.summary = summary;
				try {
					this.input.onEvent(summary);
				} catch {
					// A listener's failure must not stop the turn.
				}
			}
			// A failed execution the prompt's answer did not report (the one a late message started).
			if (last.outcome === "failed" && this.failure === null) this.failure = { reason: "execution_failed", message: last.message ?? "the turn failed" };
		}
		this.sealed = true;
		if (this.failure === null && this.processEnd !== null && !this.abortRequested && this.summary === null) {
			this.failure = { reason: "engine", message: `the engine process ${describeEnd(this.processEnd)} in the middle of the turn${this.lastWords()}` };
		}
	}

	private closed = false;
	private async closeSession(): Promise<void> {
		if (this.closed || this.session === null || this.peer.closed || this.process === null || this.process.hasEnded) return;
		this.closed = true;
		// It cancels what still runs, waits for it, and frees the session: the next turn's process can open it at once.
		// An engine that did not answer the cancel is not given long to answer this either.
		await this.peer.request("session/close", { sessionId: this.session }, { timeoutMs: this.forced ? FORCED_WAIT_MS : CLOSE_TIMEOUT_MS }).catch(() => undefined);
	}

	/**
	 * Ends the process: its stdin is closed, which makes it shut down and exit by itself; one that does
	 * not is signalled, as a stopped turn always was (SIGINT to Windlass, SIGTERM and then SIGKILL to
	 * everything the run started). `now`: nothing is waited for first.
	 */
	private async stopProcess(now: boolean): Promise<void> {
		const run = this.process;
		if (run === null || run.hasEnded) return;
		run.closeStdin();
		if (!now && (await within(run.ended, this.forced ? FORCED_WAIT_MS : EXIT_WAIT_MS))) return;
		this.signalled = true;
		await run.signal("INT", "leader");
		if (await within(run.ended, 3000)) return;
		await run.signal("TERM", "all");
		if (await within(run.ended, 2000)) return;
		await run.signal("KILL", "all");
		if (await within(run.ended, 3000)) return;
		run.killClient();
		await within(run.ended, 2000);
	}

	// ---- failures ----

	/** A refusal of the engine as `RunTurnResult.failure`: Windlass's reason and its own sentence. */
	private failureOf(error: unknown, fallback = "engine"): Failure {
		if (!(error instanceof AcpError)) return { reason: "engine", message: error instanceof Error ? error.message : String(error) };
		// The engine is gone, or did not answer: its last words say more than "closed".
		if (error.reason === "closed" || error.reason === "timeout") return { reason: "engine", message: `${error.message}${this.lastWords()}` };
		// ACP's own codes carry no reason of Windlass's.
		const reason = error.reason ?? (error.code === -32002 ? "session_not_found" : error.code === -32000 ? "auth_required" : error.code === -32602 ? "invalid_request" : fallback);
		return { reason, message: error.message };
	}

	/** Why the engine did not get as far as answering `initialize`, in the command line's words. */
	private async startFailure(error: unknown): Promise<string> {
		// The connection closes a moment before the process is reaped: an exit is the better explanation.
		if (this.processEnd === null && this.process !== null) await within(this.process.ended, 1000);
		const end = this.processEnd;
		if (end !== null) {
			if (end.error !== null) return end.error.message;
			const said = lastWords(this.stderr);
			return said === null ? `the engine process ${describeEnd(end)} before it was ready` : `the engine could not start: ${said} (its process ${describeEnd(end)})`;
		}
		if (error instanceof AcpError && error.reason === "timeout") {
			const ms = this.startTimeoutMs;
			return `the engine process did not start within ${ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))} s; giving up`;
		}
		return `the engine process did not answer as expected: ${error instanceof Error ? error.message : String(error)}`;
	}

	private lastWords(): string {
		const said = lastWords(this.stderr);
		return said === null ? "" : ` (${said})`;
	}
}

/** The approval question of a permission request (`_meta.windlass.approval`), or null when it is not one. */
function questionOf(params: Record<string, unknown>): TurnQuestion | null {
	const meta = (params._meta as Record<string, unknown> | undefined)?.[NS] as Record<string, unknown> | undefined;
	const approval = meta?.approval as Record<string, unknown> | undefined;
	if (typeof approval !== "object" || approval === null) return null;
	const question = approval.question as { title?: unknown; subject?: unknown; details?: unknown; choices?: unknown } | undefined;
	if (typeof approval.messageId !== "string" || typeof approval.callId !== "string" || typeof question?.title !== "string" || !Array.isArray(question.choices)) return null;
	const choices = question.choices.flatMap((raw: unknown) => {
		const choice = raw as { id?: unknown; label?: unknown; approve?: unknown; remembers?: unknown };
		if (typeof choice?.id !== "string") return [];
		return [{ id: choice.id, label: typeof choice.label === "string" ? choice.label : choice.id, approve: choice.approve === true, remembers: typeof choice.remembers === "string" ? choice.remembers : null }];
	});
	// A subagent's question names it: `{ sessionId, title, spawnId, toolCallId }`, the title being the first line of its task.
	const subagent = approval.subagent as { title?: unknown; sessionId?: unknown } | string | undefined;
	const label = typeof subagent === "string" ? subagent : typeof subagent?.title === "string" ? subagent.title : typeof subagent?.sessionId === "string" ? subagent.sessionId : null;
	return {
		messageId: approval.messageId,
		callId: approval.callId,
		title: question.title,
		subject: typeof question.subject === "string" ? question.subject : "",
		details: Array.isArray(question.details) ? question.details.filter((detail): detail is string => typeof detail === "string") : [],
		choices,
		subagent: label === null || label.trim() === "" ? null : label.trim(),
	};
}

function describeEnd(end: ProcessEnd): string {
	return end.signal !== null ? `was killed (${end.signal})` : `exited with code ${end.code}`;
}

/**
 * Why an engine process died, from the end of what it wrote to stderr: its own last warning or error,
 * or the message of an uncaught error, never a stack frame or a source excerpt (the command line's rule).
 */
function lastWords(stderr: string): string | null {
	const lines = stderr
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "");
	const findLast = (test: (line: string) => boolean) => [...lines].reverse().find(test);
	const own = findLast((line) => /^\S+ acp (error|warn): /.test(line));
	if (own !== undefined) return own.replace(/^\S+ acp \w+: /, "");
	const thrown = findLast((line) => /^(error|[A-Z]\w*Error|[A-Z]\w*Exception)(\[\w+\])?: \S/.test(line));
	if (thrown !== undefined) return thrown.replace(/^error: /, "");
	const plain = findLast((line) => !/^Bun v\d/.test(line) && !/^\s*\d+ \| /.test(line) && !/^\s+at /.test(line) && !/^\s*\^\s*$/.test(line));
	return plain === undefined ? null : plain.trim().slice(0, 500);
}
