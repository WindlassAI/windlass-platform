/**
 * Running Windlass in a sandbox, whatever provider the sandbox is from: this file knows a sandbox only
 * as a `TurnSandbox` (provider.ts). One turn is one process that speaks the Agent Client Protocol,
 * started under wlp-run in the sandbox's workspace with
 *
 *   WINDLASS_WAKE=off WINDLASS_ACP_LOG=warn
 *   WINDLASS_ACP_SCRIPT=/tmp/.wlp-script-<random>.json                                        a scripted (demo) turn
 *   WINDLASS_ACCESS_TOKEN_FILE=<session-private path>/access-token-<id>.json       any other turn
 *   wlp-run exec <tag> windlass acp
 *
 * (windlass.ts shows the `docker exec` this is on Docker, e2b/sandboxes.ts the command it is on E2B.)
 *
 * A turn that is not scripted runs on its user's ChatGPT sign-in, which is never in the sandbox: the
 * turn is handed the user's current access token in that file (token-file.ts says where, how and for
 * how long), written before the process starts (`TurnSandbox.writeSecretFile`: the token on standard
 * input, the file renamed into place), replaced the same way when the token in it has ten minutes left,
 * and removed when the turn ends. A scripted turn gets no token.
 *
 * While a turn runs, the sandbox is held (`TurnSandbox.holdForTurn`): a provider whose sandboxes stop by
 * themselves when nobody vouches for them keeps this one running until the turn has ended.
 *
 * A turn of a session on a repository with saved secrets is handed them (`RunTurnInput.secrets`):
 * those meant for Windlass go into the process's environment without being on a command line
 * (`StartOptions.secretEnv`), and every saved value is taken out of whatever the engine sends before
 * any of it is looked at (`AcpConnection`'s `clean`), out of the pieces of streaming text a value is
 * split over (`streamed`), and out of the end of standard error and a failure's sentence. Which of
 * them no command may get, and which credential-looking ones sandboxed commands get all the same, is
 * said by name when the session is opened (`withholdEnv`, `passEnv`).
 *
 * Each turn checks its engine's initialize response for host tools before opening a session.
 *
 * The process is driven over its stdin and stdout as the `windlass` command line drives its own engine (Windlass's
 * docs/acp.md, "The command line is an ACP client"):
 *
 *   initialize                         every engine event is asked for as `_windlass/event`, no standard updates
 *   session/new | _windlass/resolve + session/resume
 *                                      model, effort, the profile's approval mode, whether anyone can answer,
 *                                      a home of the session's own for
 *                                      sandboxed commands, the two lists of variable names, and the
 *                                      user's checks as required checks
 *   _windlass/mcp                      the servers the project's configuration names that wait for approval,
 *                                      each put to `onServerQuestion` before the prompt goes
 *     -> _windlass/mcp_approve         a server the user said to start; it starts at once
 *   session/prompt                     answered when the turn ends, with how it ended
 *     <- _windlass/event               passed on unchanged, in order
 *     <- session/request_permission    a tool call's approval question, put to `onQuestion`
 *     <- _windlass/host_call           a call of one of the platform's own tools, answered by its callback
 *     <- _windlass/mcp_changed         a server came to wait, started or failed while the turn runs
 *     -> _windlass/steer               a message into the running turn (`TurnControl.steer`)
 *     -> _windlass/cancel_call         one running tool call stopped (`TurnControl.cancelCall`)
 *     -> session/cancel                the turn stopped (`signal`)
 *   session/close, stdin closed        the process lets go of the session and exits
 *
 * No prompt text is ever on a command line. The process lives for one turn, so nothing has to be kept
 * between turns and a server that restarts loses nothing but the turn it was running.
 *
 * A project's MCP servers are asked about as Windlass's own command line asks (its docs/acp.md, "A
 * question about a project's hook, language server or MCP server put before a message is sent"): what
 * waits is read before the prompt, the prompt goes after the answers, and the turn starts with what the
 * user allowed. A server approved then is running, and in the model's list of tools, at the turn's
 * first step. One that Windlass reports later (`_windlass/mcp_changed`) is asked about while the turn
 * runs: approved, it starts at once, its tools can be called at once, and the model is told of them at
 * its next step. Windlass remembers the approval itself, in its data directory in the sandbox, and
 * from then on starts the server without reporting it as waiting. What it says of the project's
 * servers at each of these moments is handed on as it comes (`onServers`), for whoever shows them.
 *
 * Windlass starts by itself the servers the configuration file of its own user names, and the layer
 * writes the MCP servers of the session's user (`RunTurnInput.servers`) into that file in the sandbox
 * for a turn (windlass-config.ts). They go in once the engine has said what it can do and before a
 * session is opened, which is when it reads its configuration, and are taken out again when the
 * turn has ended. What the file holds besides is kept. What an earlier turn left there, because its server stopped under it,
 * is taken out first, by the layer's own list of what it wrote: a sandbox that exists has the user's
 * servers as they are now from its next turn, and a deleted one does not go on starting.
 *
 * The opener supplies the user's required checks on every turn. The engine's evidence identifies their origin.
 *
 * The platform's own tools (agent-publish.ts: `publish`, `report`, `push`, `fetch_base`) are
 * declared to the engine when the session is opened (`hostTools`), those the turn has a callback for
 * (`RunTurnInput.onPublish`, ...). A call arrives as the engine's
 * request `_windlass/host_call` on this turn's connection, which lives with the turn's engine process:
 * it is answered for this turn's session, while the turn runs, for a tool the turn declared, and with
 * what the tool's callback resolves with. One that arrives once the turn is over, or names another
 * session or a tool the turn did not declare, is answered with an error the model reads and reaches
 * no callback. A call Windlass gives up on (it stopped it, or its time ran out: `tool.settled`), and
 * every call when the turn ends, has its callback's signal aborted. The tools are declared so that
 * Windlass never asks about them: no question about one reaches the permission handler.
 *
 * A call of a tool of one of the user's own servers whose user said that its tools run without
 * asking (`TurnPersonalServer.unasked`) has the engine's question about it answered here, with
 * "once", and `onUnasked` is told. Which call that is is known from the engine's `tool.called`
 * event of an `mcp_call`, which names the server and the tool, for a server this turn wrote into the file with
 * the setting on and which the engine holds to be its user's own; and the question has to be about
 * using exactly that tool (`approval.needs`), asked by the session and not by a subagent. Nothing
 * is read from the question's sentence. Each call is answered once and Windlass remembers nothing,
 * so the answer does not depend on what Windlass makes of earlier approvals once content it does
 * not trust is in the conversation, and the server's results stay content it does not trust.
 *
 * When a turn fails, what the failure means is read from the stable code Windlass gives it, not from
 * the words of its message: the code on the error the engine answered with (`data.windlass.code`,
 * Windlass's docs/acp.md, "Errors") and, where there is no such error, the one on the provider error of
 * the model call that failed (`step.failed`, `error.error.code`). `Turn.told` turns the codes about a
 * handed-in token into what the user should read (handoff.ts has the mapping); every other failure
 * stays as Windlass reported it.
 */

import { REVIEW_TOOL } from "../factory/reviewer-task.js";
import { FETCH_BASE_TOOL, PUBLISH_TOOL, PUSH_TOOL, REPORT_TOOL, callArguments, platformTools } from "../agent-publish.js";
import { config } from "../config.js";
import { reportedModelUsage } from "../usage.js";
import type { TurnUsage, WindlassEvent } from "../contract.js";
import { isReservedServerName } from "../personal-servers.js";
import { NO_REDACTION, type Redactor } from "../repo-secrets.js";
import { windlassChecks } from "../repository-checks.js";
import { type ConfigServer, type PlatformConfig, PLATFORM_SERVERS_FILE, WINDLASS_CONFIG_FILE, platformConfig, projectChecks } from "../windlass-config.js";
import type { AccessTokens, RunTurnInput, RunTurnResult, SandboxHandle, ScriptedModel, TurnAnswer, TurnChecks, TurnControl, TurnPublishRequest, TurnQuestion, TurnServer, TurnServerOutcome, TurnServerQuestion, TurnUnaskedCall, Windlass } from "./api.js";
import { AcpConnection, AcpError, LineSplitter, MethodNotFound } from "./acp.js";
import { demoScript } from "./demo.js";
import { ACCESS_TOKEN_FILE_ENV, type Failure, handedInFailure, handedInProblem, tokenRanOut, tokenSourceFailure } from "./handoff.js";
import { sweepSessionProcesses, type ProcessEnd, type SandboxProcess, type TurnSandbox, isTurnSandbox, randomId } from "./provider.js";
import { TokenFile, TokenFileError, type TokenFileOptions } from "./token-file.js";

export function turnHostTools(input: RunTurnInput) {
	const tools = new Map<string, (call: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>>();
	if (input.onPlan) {
		tools.set("file_plan", input.onPlan);
		return tools;
	}
	if (input.onReview) {
		tools.set(REVIEW_TOOL, input.onReview);
		return tools;
	}
	if (input.onPublish) tools.set(PUBLISH_TOOL, input.onPublish);
	else if (input.onReport) tools.set(REPORT_TOOL, input.onReport);
	if (input.onPush && input.onFetchBase) {
		tools.set(PUSH_TOOL, input.onPush);
		tools.set(FETCH_BASE_TOOL, input.onFetchBase);
	}
	return tools;
}

export function sessionOpenParams(cwd: string, meta: Record<string, unknown>) {
	return { cwd, mcpServers: [], _meta: { windlass: meta } };
}

export function turnAgentMeta(restrictedAgent: string | null, clearPlanner?: boolean): { agent?: string; children?: false } {
	// The agent definition refuses delegation. children controls only questions from a child.
	if (restrictedAgent) return { agent: restrictedAgent, children: false };
	return clearPlanner ? { agent: "none" } : {};
}

export function hostToolsMeta(tools: ReturnType<typeof turnHostTools>, screenshots?: boolean) {
	return { hostTools: platformTools({ plan: tools.has("file_plan"), publish: tools.has(PUBLISH_TOOL), report: tools.has(REPORT_TOOL), push: tools.has(PUSH_TOOL), review: tools.has(REVIEW_TOOL), screenshots }, config.questionTimeoutMs) };
}

/** The key of Windlass's extensions in `_meta` and in an error's `data`, and the prefix of its methods. */
const NS = "windlass";
const EXT = {
	event: `_${NS}/event`,
	steer: `_${NS}/steer`,
	cancelCall: `_${NS}/cancel_call`,
	resolve: `_${NS}/resolve`,
	mcp: `_${NS}/mcp`,
	mcpChanged: `_${NS}/mcp_changed`,
	mcpApprove: `_${NS}/mcp_approve`,
	hostCall: `_${NS}/host_call`,
};
const PROTOCOL_VERSION = 1;
/** What `initialize` is sent with: every engine event is asked for as `_windlass/event`, and no standard updates. */
const INITIALIZE = { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "windlass-platform", title: "Windlass Platform", version: "0" }, clientCapabilities: { _meta: { [NS]: { events: true, updates: false } } } };

/**
 * What a session's sandboxed commands find at the home directory's path: a home of the session's own
 * (Windlass's docs/safety.md, "The session's home"), in which the home's entries are read-only and
 * what a command makes beside them is kept for the session. Tools that write under the home without
 * being told to (a build tool's settings, a package manager's cache) then work in Windlass's
 * sandbox. The home in a sandbox is nobody's to keep, which is what the setting is for.
 *
 * It is said in every profile, since it applies to the commands Windlass sandboxes and to no other:
 *
 *   approval "auto"   every command is sandboxed where bubblewrap works (the profiles that promise
 *                     Windlass's sandbox, and E2B before its check where the probe passes)
 *   approval "full"   commands run directly in the sandbox machine, with its real home, until content
 *                     from the web or an MCP server is in the conversation. From then on Windlass
 *                     sandboxes them again where it can (`e2b-open`), and a tool that wrote under
 *                     the home until then would fail on a read-only one
 *   no bubblewrap     (`docker-hardened`, and E2B where the probe fails) Windlass sandboxes nothing,
 *                     so no command gets the home, and the model and the user are told nothing of it
 */
const SANDBOX_HOME = "session";

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
/** How long Windlass may take to say which servers wait, and to take an approval. */
const SERVERS_TIMEOUT_MS = 20_000;
/**
 * After an approval, how long the layer waits for the server to have started or failed before it
 * reports "starting". A server that needs nothing takes a tenth of a second; Windlass itself gives one
 * 30 s (`startupTimeoutSeconds`) and holds the turn's first step 1.5 s for it.
 */
const SERVER_START_WAIT_MS = 5000;
/** How long reading a server's definition, and asking which variables are set, may take. */
const DEFINITION_TIMEOUT_MS = 10_000;

/** What the agent is told when the platform's own handling of a call of one of its tools failed. */
const CALL_NOT_HANDLED = "The platform could not handle this call. Tell the user; do not try another way to do it.";

/** The events whose text arrives in pieces, as the session passes them on to browsers while a turn runs. */
const STREAMED = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]).finally(() => clearTimeout(timer));
}

export interface TurnOptions {
	/** The command that serves ACP on stdio inside the sandbox. Default `windlass acp`; another one stands in for it in the layer's own checks. */
	engineCommand?: string[];
	/** How long the engine may take to answer `initialize`. Default `START_TIMEOUT_MS`. */
	startTimeoutMs?: number;
	/** The schedule of a turn's access token file and where its log lines go; the layer's own checks shorten the one and read the other. */
	tokenFile?: TokenFileOptions;
}

/**
 * What the turn code has to be told about the Windlasses of a deployment, and cannot see from a
 * sandbox: the provider knows where its image is and who fetches the tokens.
 */
export interface WindlassHost {
	/** `Windlass.version()`: the version in the image sandboxes are made from, or null. */
	version(): Promise<string | null>;
	/** `Windlass.problem()`. */
	problem(): Promise<string | null>;
}

/** `Windlass` on any provider's sandboxes. A provider passes its `WindlassHost` (windlass.ts for Docker, e2b/windlass.ts for E2B). */
export class SandboxWindlass implements Windlass {
	/** `tokens`: where a turn that is not scripted gets its user's access token. */
	constructor(
		private readonly tokens: AccessTokens,
		private readonly host: WindlassHost,
		private readonly options: TurnOptions = {},
	) {}

	version(): Promise<string | null> {
		return this.host.version();
	}

	problem(): Promise<string | null> {
		return this.host.problem();
	}

	demoScript(prompt: string, turn: number): ScriptedModel {
		return demoScript(prompt, turn);
	}

	async runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		if (!isTurnSandbox(sandbox)) throw new Error("runTurn needs a sandbox from this layer's connect()");
		if (input.windlassSessionId !== undefined && !SESSION_ID.test(input.windlassSessionId)) throw new Error(`invalid Windlass session id: ${input.windlassSessionId}`);
		if (input.signal?.aborted) return { exitCode: null, aborted: true, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: null };
		return new Turn(sandbox, input, this.options, this.tokens).run();
	}
}

type Outcome = "succeeded" | "unresolved" | "failed" | "stopped" | "interrupted";

const callKey = (messageId: unknown, callId: unknown) => `${String(messageId)}\n${String(callId)}`;

/**
 * A call of an MCP server's tool, from Windlass's `tool.called` event of an `mcp_call`: the server,
 * the tool as that server names it, and the arguments; null for any other call. Windlass takes the
 * tool's name with or without the server's in front, and asks about the call as `<server>/<tool>`.
 */
function mcpCall(name: unknown, input: unknown): { server: string; tool: string } | null {
	if (name !== "mcp_call") return null;
	let call: unknown = input;
	if (typeof input === "string") {
		try {
			call = JSON.parse(input);
		} catch {
			return null;
		}
	}
	if (typeof call !== "object" || call === null || Array.isArray(call)) return null;
	const { server, tool } = call as { server?: unknown; tool?: unknown };
	if (typeof server !== "string" || typeof tool !== "string") return null;
	return { server, tool: tool.startsWith(`${server}/`) ? tool.slice(server.length + 1) : tool };
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
	private usage: TurnUsage | null = null;
	/** The execution at work, by its id. */
	running: string | null = null;
	/** The execution that ended last, and how its event says it ended. */
	last: { executionId: string; sessionId: string; outcome: Outcome; message: string | null; time: number } | null = null;

	note(event: WindlassEvent): void {
		const data = (event.data ?? {}) as Record<string, unknown>;
		const time = typeof event.time === "number" ? event.time : Date.now();
		const usage = reportedModelUsage(event);
		if (usage) {
			const total = this.usage ??= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
			total.inputTokens += usage.inputTokens;
			total.outputTokens += usage.outputTokens;
			total.cachedInputTokens += usage.cachedInputTokens;
			total.reasoningTokens += usage.reasoningTokens;
		}
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
			case "compaction.ended":
				this.summaryCalls += typeof data.calls === "number" ? data.calls : 0;
				return;
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

}

/** One turn: the process, the connection, and everything that has to be told apart while it runs. */
class Turn {
	private readonly approval: "ask" | "auto" | "full";
	private readonly reviewerAgent: string | null;
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

	/** The project's servers as Windlass last described them. */
	private servers: ServerState[] = [];
	/** The definitions this turn has asked about, or is about to: `<name>:<fingerprint>`. Each is asked about once. */
	private readonly serversAsked = new Set<string>();
	/** The questions about servers that are open: one at a time, and each withdrawn when the turn is stopped or ends. */
	private readonly serverQuestions = new Set<AbortController>();
	private serverLine: Promise<void> = Promise.resolve();
	/** Woken when Windlass says its servers changed. */
	private readonly serverWaiters = new Set<() => void>();
	/** What the engine was started with, for asking the sandbox what the engine can see. */
	private engineEnv: Record<string, string> = {};
	/** The names of the secrets the engine was started with: its environment has them, and their values are not kept here. */
	private engineSecrets = new Set<string>();
	/** Takes the repository's saved secrets out of what the engine sends (`RunTurnInput.secrets`). */
	private readonly redactor: Redactor;
	/** The platform's tools this turn declares, by name, each with its callback. */
	private hostTools = new Map<string, (call: TurnPublishRequest, signal: AbortSignal) => Promise<string> | string>();
	/** True while this turn has servers of its own in that file: they are taken out when it ends. */
	private configWritten = false;
	/** What Windlass had for checks when its session was opened; null until the file was dealt with. */
	private checks: TurnChecks | null = null;
	/** The names of the user's own servers this turn wrote there: what `onServers` is told of beside the project's. */
	private personal = new Set<string>();
	/** Of those, the ones whose tools run without asking. */
	private unasked = new Set<string>();
	/** The calls of the platform's tools that are being answered, by `<messageId>\n<callId>`: aborted when the engine settles one, or the turn ends. */
	private readonly hostCalls = new Map<string, AbortController>();
	/** The calls of a tool of a server in `unasked` the engine reported and has not settled. */
	private readonly unaskedCalls = new Map<string, TurnUnaskedCall>();
	/** The end of a piece of streaming text that may be the beginning of a saved value, per stream, until the next piece shows whether it is. */
	private readonly heldBack = new Map<string, string>();

	/** The access token file of a turn that is not scripted. */
	private readonly tokenFile: TokenFile | null;
	/** Windlass's code for `failure`, when the error it came from carried one (`data.windlass.code`). */
	private failureCode: string | null = null;
	private stepFailureCode: string | null = null;

	constructor(
		private readonly sandbox: TurnSandbox,
		private readonly input: RunTurnInput,
		private readonly options: TurnOptions,
		private readonly tokens: AccessTokens,
	) {
		// A scripted turn calls no model: it is handed no token.
		this.tokenFile = input.script === undefined ? new TokenFile(sandbox, tokens, options.tokenFile) : null;
		const mode = input.mode ?? sandbox.approval;
		if (mode !== "ask" && mode !== sandbox.approval) throw new Error("This sandbox profile does not offer that approval mode.");
		this.approval = mode;
		// A project definition takes precedence over a named user agent. Choose the name after checkout, on every open.
		this.reviewerAgent = (input.onReview || input.planner) ? `wlp-review-${randomId(16)}` : null;
		this.redactor = input.secrets?.redactor ?? NO_REDACTION;
		this.peer = new AcpConnection(
			(line) => this.process?.write(`${line}\n`) ?? false,
			{ notification: (method, params) => this.notification(method, params), request: (method, params) => this.request(method, params) },
			NS,
			(value) => this.redactor.deep(value),
		);
	}

	async run(): Promise<RunTurnResult> {
		const { sandbox, input } = this;
		const scriptPath = input.script === undefined ? null : `/tmp/.wlp-script-${randomId(6)}.json`;
		const tokenFile = this.tokenFile;
		const configHome = this.reviewerAgent && `/tmp/${this.reviewerAgent}`;
		const agentFile = configHome && `${configHome}/windlass/agents/${this.reviewerAgent}.md`;
		// What the turn leaves in the sandbox besides its processes.
		const files = [...(scriptPath === null ? [] : [scriptPath]), ...(tokenFile === null ? [] : tokenFile.files), ...(agentFile ? [agentFile] : [])];
		const onAbort = () => this.abort();
		/** Ends the hold on the sandbox; null while there is none. */
		let release: (() => Promise<void>) | null = null;
		try {
			// From the start: getting the token can take a while (a refresh), and a stop must not wait for it.
			input.signal?.addEventListener("abort", onAbort, { once: true });
			if (input.signal?.aborted) this.abort();
			// Before anything is started in it: from here to the end of `finally` the provider keeps the sandbox running.
			release = await sandbox.holdForTurn().catch((error: unknown) => {
				this.failure = { reason: "engine", message: `the sandbox could not be kept running for the turn: ${error instanceof Error ? error.message : String(error)}` };
				return null;
			});
			if (release !== null && (await this.prepare(scriptPath, agentFile)) && !this.abortRequested) {
				// A token a command printed is taken out before the message is read: it reaches no event.
				const lines = new LineSplitter((line) => this.peer.receive(tokenFile === null ? line : tokenFile.scrub(line)));
				const env = {
					// A server that lives for one turn must not start other sessions' wake-up turns, as the command line's one-prompt runs do not.
					WINDLASS_WAKE: "off",
					// A base setup may have written a user config with auto-start MCP servers.
					...(configHome ? { XDG_CONFIG_HOME: configHome } : {}),
					// Only warnings and errors on stderr: that is what `stderrTail` is for.
					WINDLASS_ACP_LOG: "warn",
					...(scriptPath === null ? {} : { WINDLASS_ACP_SCRIPT: scriptPath }),
					// The file Windlass reads its access token from at every model call; it never looks for a saved sign-in then.
					...(tokenFile === null ? {} : { [ACCESS_TOKEN_FILE_ENV]: tokenFile.path }),
				};
				// The repository's secrets that Windlass may have, for the MCP servers that name them: never one of the turn's own variables.
				const secretEnv = Object.fromEntries(Object.entries(input.secrets?.env ?? {}).filter(([name]) => !(name in env)));
				const run = sandbox.start(this.options.engineCommand ?? ["windlass", "acp"], {
					env,
					secretEnv,
					onStdout: (chunk) => lines.push(chunk),
					onStderr: (chunk) => (this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT)),
				});
				this.process = run;
				this.engineEnv = { ...env, WLP_RUN_TAG: run.tag };
				this.engineSecrets = new Set(Object.keys(secretEnv));
				void run.ended.then((end) => {
					lines.flush();
					this.processEnd = end;
					this.peer.end(end.error !== null ? end.error.message : `the engine process ${describeEnd(end)}`);
					this.resolveInterrupted();
					this.finish();
				});

				await this.converse();
				await this.end();
			}
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
			clearTimeout(this.cancelTimer);
			clearTimeout(this.followUpTimer);
			const run = this.process;
			if (run !== null && !run.hasEnded) await this.stopProcess(true);
			// No more replacements, and none in the middle of being written, before the token file is removed.
			await tokenFile?.stop();
			if (run !== null) {
				// Whatever happened above, nothing of the turn stays behind in the sandbox. A process that ended on its own
				// after an orderly close has nothing left to wait for; one whose client was cut off may still be shutting down inside.
				const left = await sandbox.sweep(run.tag, { waitMs: this.orderly() ? 0 : WINDING_DOWN_MS, files }).catch(() => 0);
				if (left > 0) this.notes.push(`[platform] ${left} process(es) of the turn could not be stopped`);
			} else {
				await sandbox.removeFiles(files);
			}
			// With the engine gone: the servers it was handed for this turn are not left for the next.
			await this.withdrawServers();
			await release?.().catch(() => undefined);
		}

		const end = this.processEnd;
		// The turn counts as aborted when the abort is what ended it, not when it came after the turn's own end.
		const ownEnding = this.summary !== null && this.summary.outcome !== "interrupted";
		const aborted = this.abortRequested && !(ownEnding && !this.forced);
		const said = [...this.notes, this.stderr.trimEnd()];
		if (this.peer.notJson.length > 0) said.push(`[stdout, not protocol messages]\n${this.peer.notJson.join("\n")}`);
		const scrub = (text: string) => this.redactor.text(tokenFile === null ? text : tokenFile.scrub(text));
		const stderrTail = said.filter((part) => part !== "").join("\n");
		// A failure's sentence may quote the engine's last words: what the engine printed is scrubbed there as it is in the tail.
		const failure = aborted ? null : await this.told(this.failure);
		return {
			exitCode: end === null || end.signal !== null || this.signalled ? null : end.code,
			aborted,
			timedOut: false,
			windlassSessionId: this.sessionSeen,
			summary: this.summary,
			stderrTail: scrub(stderrTail).slice(-STDERR_TAIL),
			failure: failure === null ? failure : { reason: failure.reason, message: scrub(failure.message) },
			...(this.checks === null ? {} : { checks: this.checks }),
		};
	}

	/**
	 * The failure as the user should read it. Windlass's refusal of a handed-in token is an
	 * `auth_required` (or the failure of an execution a late message started) whose sentence is for
	 * whoever handed the token in: it names the variable and says to hand in a new one. What that means
	 * for the user depends on what Windlass found in the file, which its code says, and on why the
	 * platform left the file so.
	 *
	 * The code is the one on the error the engine answered with and, where there is no such error (the
	 * execution a late message started), the one on the provider error of the model call that failed;
	 * Windlass gives both the same. A code that is not about a handed-in token (`network_error`, a
	 * provider's own) leaves the failure as Windlass reported it.
	 */
	private async told(failure: Failure | null): Promise<Failure | null> {
		const tokenFile = this.tokenFile;
		if (failure === null || tokenFile === null) return failure;
		const code = this.failureCode ?? this.stepFailureCode;
		const problem = code === null ? null : handedInProblem(code);
		if (problem === null) return failure;
		let state = tokenFile.state;
		if (state.problem === null && (problem === "undelivered" || tokenRanOut(problem, state))) {
			// The file gave no token, or the token in it ran out, though no replacement of this turn's had failed.
			// Whether that is the user's sign-in is the token source's to say, so it is asked now: forgetting a
			// sign-in (`logout`) removes the token files of running turns, and then it reports that there is none;
			// when it has a token, or cannot get one for another reason, the platform was the one that fell short.
			const problemNow = await this.tokens.current(this.sandbox.uid).then(
				() => null,
				(error: unknown) => error,
			);
			state = { ...state, problem: problemNow };
		}
		return handedInFailure(problem, state);
	}

	/** What has to be so before the engine starts. False, with `failure` set, when the sandbox cannot be used. */
	private async prepare(scriptPath: string | null, agentFile: string | null): Promise<boolean> {
		// One turn at a time per sandbox: a Windlass still running here is left over from a turn whose server or
		// client went away, and it would hold the session ("in use by another windlass process").
		const stopping = this.sandbox.stopLeftovers("windlass").then(count => {
			if (count > 0) this.notes.push(`[platform] stopped ${count} Windlass run(s) left over in this sandbox before starting the turn`);
		});
		if (this.tokenFile !== null) {
			// Finish both cleanup steps before starting any file writer or requesting a token.
			try {
				await stopping;
				await sweepSessionProcesses(this.sandbox, this.tokenFile.path);
				if (this.abortRequested) return false;
			} catch (error) {
				this.failure = { reason: "engine", message: `the engine could not be started in the sandbox: ${error instanceof Error ? error.message : String(error)}` };
				return false;
			}
		}
		// A scripted turn can prepare its files while the previous Windlass is stopping.
		const [stopped, script, agent, token] = await Promise.allSettled([
			stopping,
			scriptPath === null ? undefined : this.sandbox.writeTextFile(scriptPath, JSON.stringify(this.input.script)),
			agentFile === null ? undefined : this.sandbox.writeTextFile(agentFile, [
				"---", `name: ${this.reviewerAgent}`, this.input.planner ? "description: Read the repository and plan the feature." : "description: Reviews this pull request independently.",
				this.input.planner ? "disallowed-tools: write, edit, shell, subagent" : "disallowed-tools: subagent", "---", this.input.planner ? "Read the repository and file the requested artifact." : "Review the change yourself.", "",
			].join("\n")),
			// The user's access token, in its file before the engine looks for it. An abort does not wait for it.
			this.tokenFile === null ? undefined : this.unlessAborted(this.tokenFile.start()),
		]);
		// The sandbox itself does not work (it is not running, a file cannot be written): that is not about anyone's sign-in.
		const setupError = [stopped, script, agent].find(result => result.status === "rejected");
		const broken = setupError?.status === "rejected" ? setupError.reason : token.status === "rejected" && token.reason instanceof TokenFileError ? token.reason : null;
		if (broken !== null) {
			this.failure = { reason: "engine", message: `the engine could not be started in the sandbox: ${broken instanceof Error ? broken.message : String(broken)}` };
			return false;
		}
		if (token.status === "rejected") {
			// No sign-in, one that is no longer accepted, or a token that could not be had this time.
			this.failure = tokenSourceFailure(token.reason);
			return false;
		}
		return true;
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
			const init = await this.unlessAborted(peer.request<Initialized>("initialize", INITIALIZE, { timeoutMs: this.startTimeoutMs }));
			if (init === "aborted") return;
			const offered = init.agentCapabilities?._meta?.[NS] as { notifications?: unknown } | undefined;
			if (!Array.isArray(offered?.notifications) || !offered.notifications.includes(EXT.event)) {
				this.failure = { reason: "engine", message: `the engine process does not send Windlass's events (${EXT.event}); it may be another version` };
				return;
			}
			const openKeys = openKeysIn(init);
			if (!openKeys.includes("hostTools")) {
				this.failure = { reason: "host_tools_required", message: "The sandbox needs Windlass 0.4.0 or later for host tools." };
				return;
			}
			if ((input.onReview || input.planner) && ["agent", "children", "requiredChecks"].some(key => !openKeys.includes(key))) {
				this.failure = { reason: "engine", message: "This Windlass cannot open a restricted reviewer session with file_review." };
				return;
			}
			this.hostTools = turnHostTools(input);
		} catch (error) {
			this.failure = { reason: "engine", message: await this.startFailure(error) };
			return;
		}

		// Before a session is opened: the engine reads its configuration then, and starts what its user's own file names.
		if ((await this.unlessAborted(this.writeServers())) === "aborted" || this.abortRequested) return;

		try {
			const opened = await this.unlessAborted(this.open());
			if (opened === "aborted" || this.abortRequested) return;
		} catch (error) {
			this.refused(error, "engine");
			return;
		}

		// The project's servers that wait for the user's approval, before the prompt goes: the turn starts with what was allowed.
		const asked = await this.unlessAborted(this.askAboutServers());
		if (asked === "aborted" || this.abortRequested || this.peer.closed) return;

		this.promptSent = true;
		const prompt = { sessionId: this.session, prompt: [{ type: "text", text: input.prompt }], ...(input.maxSteps === undefined ? {} : { _meta: { "windlass/maxSteps": input.maxSteps } }) };
		void peer.request<{ stopReason?: unknown; _meta?: Record<string, unknown> }>("session/prompt", prompt).then(
			(result) => {
				const turn = result?._meta?.[NS] as { executionId?: unknown; outcome?: unknown } | undefined;
				const outcome = typeof turn?.outcome === "string" && ["succeeded", "unresolved", "failed", "interrupted"].includes(turn.outcome) ? (turn.outcome as Outcome) : result?.stopReason === "cancelled" ? "interrupted" : null;
				this.promptEnding = { executionId: typeof turn?.executionId === "string" ? turn.executionId : null, outcome };
				this.promptSettled = true;
				this.check();
			},
			(error: unknown) => {
				// A connection that ended is told by the process's end; a session closed under the prompt is this turn's own doing.
				if (!(error instanceof AcpError && (error.reason === "closed" || error.code === -32800))) this.refused(error, "execution_failed");
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
			...turnAgentMeta(this.reviewerAgent, input.clearPlanner),
			// Whether anyone can answer a question. Without someone, a call that would ask is refused at once and the model is told.
			attended: input.onQuestion !== undefined,
			unattended: "deny",
			sandboxHome: SANDBOX_HOME,
			// Reviewer commands use the image's read-only ~/.config/pnpm, while the engine uses its private config.
			withholdEnv: [...(input.secrets?.withholdEnv ?? []), ...(this.reviewerAgent ? ["XDG_CONFIG_HOME"] : [])],
			passEnv: input.secrets?.passEnv ?? [],
			requiredChecks: windlassChecks(input.checks ?? []),
			...hostToolsMeta(this.hostTools, input.reportScreenshots),
		};
		if (input.windlassSessionId === undefined) {
			const made = await peer.request<{ sessionId?: unknown }>("session/new", sessionOpenParams(this.sandbox.cwd, meta), { timeoutMs: OPEN_TIMEOUT_MS });
			if (typeof made?.sessionId !== "string") throw new AcpError("the engine opened a session without naming it", 0, null);
			this.adopt(made.sessionId);
			return;
		}
		const named = await peer.request<{ sessionId?: unknown; cwd?: unknown }>(EXT.resolve, { cwd: this.sandbox.cwd, session: input.windlassSessionId }, { timeoutMs: OPEN_TIMEOUT_MS });
		const sessionId = typeof named?.sessionId === "string" ? named.sessionId : input.windlassSessionId;
		const cwd = typeof named?.cwd === "string" ? named.cwd : this.sandbox.cwd;
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
		const result = await this.sandbox.ask(["sh", "-c", 'tr "\\0" "\\n" < "/proc/$1/cmdline" | tail -n 1', "sh", String(pid)], { timeoutMs: 10_000 });
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
		if (method === "session/update" && this.session !== null && params.sessionId === this.session && !this.sealed) {
			const update = params.update as { sessionUpdate?: unknown; title?: unknown } | null;
			if (update?.sessionUpdate === "session_info_update" && typeof update.title === "string") {
				this.input.onAcpUpdate?.({ sessionUpdate: "session_info_update", title: update.title });
			}
			return;
		}
		if (method === EXT.mcpChanged) {
			if (params.sessionId === this.session) this.serversSaid(params);
			return;
		}
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
		// Why the model call the turn is at failed, as Windlass names it: a code, when it has one.
		if (event.type === "step.started") this.stepFailureCode = null;
		if (event.type === "step.failed") {
			const provider = (data.error as { error?: { code?: unknown } } | undefined)?.error;
			this.stepFailureCode = typeof provider?.code === "string" && provider.code !== "" ? provider.code : null;
		}
		// The engine has withdrawn what was pending: a question may be answered `cancelled` now.
		if (event.type === "execution.interrupt_requested") this.resolveInterrupted();
		const out = this.streamed(event);
		try {
			if (out !== null) this.input.onEvent?.(out);
		} catch {
			// A listener's failure must not stop the turn.
		}
		// Windlass gave up on a call of the platform's (stopped, or out of time): nobody waits for its answer.
		if (event.type === "tool.settled") this.hostCalls.get(callKey(data.messageId, data.callId))?.abort();
		this.callingUnasked(event);
		this.check();
	}

	// ---- the servers the platform hands the engine: the user's own ----

	/**
	 * Windlass's configuration file in the sandbox, the layer's list of what it wrote there, and the
	 * configuration file of the project the session works in, in one question: each as it is, null
	 * for one that is not there. Null when the sandbox did not answer, or Windlass's own file is
	 * something the platform does not replace (a directory, a file it cannot read).
	 */
	private async readConfiguration(): Promise<{ config: string | null; written: string | null; project: string | null } | null> {
		const mark = `wlp-${randomId(12)}`;
		const script = 'mark=$1; shift; for file in "$@"; do if [ ! -e "$file" ]; then echo absent; elif [ -f "$file" ] && [ -r "$file" ]; then echo file; cat -- "$file"; else echo other; fi; printf "\\n%s\\n" "$mark"; done';
		// The session's directory is the workspace, which is where Windlass looks for a project's file first.
		const said = await this.sandbox.ask(["sh", "-c", script, "sh", mark, WINDLASS_CONFIG_FILE, PLATFORM_SERVERS_FILE, `${this.sandbox.cwd}/.windlass/config.json`], { timeoutMs: DEFINITION_TIMEOUT_MS });
		if (said === null || said.code !== 0) return null;
		const parts = said.stdout.split(`\n${mark}\n`);
		if (parts.length < 4) return null;
		const read = (part: string): string | null | undefined => {
			const end = part.indexOf("\n");
			const kind = end === -1 ? part : part.slice(0, end);
			return kind === "absent" ? null : kind === "file" ? part.slice(end + 1) : undefined;
		};
		const config = read(parts[0] as string);
		if (config === undefined) return null;
		// A list that is not a file counts as none: only what it names is ever taken out. So does a project's file that is not one.
		return { config, written: read(parts[1] as string) ?? null, project: read(parts[2] as string) ?? null };
	}

	/** Makes the file and the list in the sandbox what `next` says. The list first: it may name more than the file holds, never less. */
	private async storeConfiguration(next: PlatformConfig, had: { written: string | null }): Promise<void> {
		if (next.written !== null) await this.sandbox.writeTextFile(PLATFORM_SERVERS_FILE, next.written);
		if (next.changed) await this.sandbox.writeTextFile(WINDLASS_CONFIG_FILE, next.config);
		if (next.written === null && had.written !== null) await this.sandbox.removeFiles([PLATFORM_SERVERS_FILE]);
	}

	/** Writes the user's MCP servers and reads the project's check settings before opening the session. */
	private async writeServers(): Promise<void> {
		// The platform's own name is not a user's to have, whatever was saved.
		const personal: ConfigServer[] = (this.input.servers ?? []).filter((server) => !isReservedServerName(server.name)).map(({ name, definition }) => ({ name, definition }));
		const missed = personal.length > 0 ? "your own MCP servers were not started" : "";
		this.checks = { project: null };
		try {
			const had = await this.readConfiguration();
			if (had === null) {
				if (missed !== "") this.notes.push(`[platform] Windlass's configuration file in the sandbox could not be read, so ${missed}`);
				return;
			}
			this.checks = { project: projectChecks(had.project) };
			const next = platformConfig(had.config, had.written, personal);
			if (next === null) {
				if (missed !== "") this.notes.push(`[platform] Windlass's configuration file in the sandbox could not be read as one, so ${missed}`);
				return;
			}
			await this.storeConfiguration(next, had);
			this.configWritten = next.written !== null;
			this.personal = new Set(personal.map((server) => server.name));
			this.unasked = new Set((this.input.servers ?? []).filter((server) => server.unasked === true && this.personal.has(server.name)).map((server) => server.name));
		} catch (error) {
			if (missed !== "") this.notes.push(`[platform] Windlass's configuration file in the sandbox could not be written (${error instanceof Error ? error.message : String(error)}), so ${missed}`);
		}
	}

	/** Removes this turn's personal servers from Windlass's configuration. Never throws. */
	private async withdrawServers(): Promise<void> {
		if (!this.configWritten) return;
		this.configWritten = false;
		try {
			const had = await this.readConfiguration();
			const next = had === null ? null : platformConfig(had.config, had.written, []);
			if (had !== null && next !== null) await this.storeConfiguration(next, had);
		} catch {
			// The sandbox is gone, or stopped: the next turn takes out what this one left.
		}
	}

	/**
	 * What the engine says of a call of a tool of a server whose tools run without asking. `tool.called`
	 * names the server and the tool: the call is kept while the engine holds that server to be its
	 * user's own, which a server of that name the project's file names or changes is not.
	 * `tool.settled` ends it.
	 */
	private callingUnasked(event: WindlassEvent): void {
		if (this.unasked.size === 0 || (event.type !== "tool.called" && event.type !== "tool.settled")) return;
		const data = (event.data ?? {}) as Record<string, unknown>;
		if (typeof data.messageId !== "string" || typeof data.callId !== "string") return;
		const key = callKey(data.messageId, data.callId);
		if (event.type === "tool.settled") {
			this.unaskedCalls.delete(key);
			return;
		}
		const call = mcpCall(data.name, data.input);
		if (call === null || !this.unasked.has(call.server) || !this.servers.some((server) => server.name === call.server && server.origin === "user")) return;
		this.unaskedCalls.set(key, { messageId: data.messageId, callId: data.callId, server: call.server, tool: call.tool });
	}

	/**
	 * The event as it is handed on. Every saved value that is whole in it was taken out when it arrived.
	 * Streaming text comes in pieces, and a value can be split over two: the end of a piece that may be
	 * the beginning of a value is held back and put before the next piece of the same stream, where it
	 * is replaced when it turns out to be one. Null when all of a piece is held back. The durable event
	 * that follows a stream carries its whole text, so what is still held back then is dropped.
	 */
	private streamed(event: WindlassEvent): WindlassEvent | null {
		const redactor = this.redactor;
		if (!redactor.active) return event;
		const field = event.type === "tool.input.delta" ? "input" : "text";
		const piece = STREAMED.has(event.type) ? event[field] : undefined;
		if (typeof piece === "string") {
			const key = `${typeof event.messageId === "string" ? event.messageId : ""}\n${typeof event.callId === "string" ? event.callId : ""}\n${event.type}`;
			const whole = redactor.text((this.heldBack.get(key) ?? "") + piece);
			const held = redactor.held(whole);
			if (held === 0) this.heldBack.delete(key);
			else this.heldBack.set(key, whole.slice(whole.length - held));
			if (held === whole.length) return null;
			return { ...event, [field]: held === 0 ? whole : whole.slice(0, whole.length - held) };
		}
		const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as { messageId?: unknown; callId?: unknown };
		if (typeof data.messageId === "string" && this.heldBack.size > 0) {
			const streams = `${data.messageId}\n${typeof data.callId === "string" ? data.callId : ""}\n`;
			for (const key of [...this.heldBack.keys()]) if (key.startsWith(streams)) this.heldBack.delete(key);
		}
		return event;
	}

	private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (method === "session/request_permission") return this.permission(params);
		if (method === EXT.hostCall) return this.hostCall(params);
		// The client's file system and terminal: Windlass's tools run inside the agent and never ask for them.
		throw new MethodNotFound(method);
	}

	/**
	 * A call of one of the platform's own tools, as the engine sends it. It is this turn's when it is
	 * for this turn's session, while the turn runs, and of a tool the turn declared; then the tool's
	 * callback decides and does what is to be done, and its answer is the call's result. Anything else
	 * is answered with an error the model reads, and reaches no callback: a call that comes once the
	 * turn is over has no turn to belong to. Never rejects.
	 */
	private async hostCall(params: Record<string, unknown>): Promise<unknown> {
		const refused = (output: string) => ({ status: "error", output });
		const run = typeof params.name === "string" ? this.hostTools.get(params.name) : undefined;
		if (params.sessionId !== this.session || this.over || this.cancelSent) return refused("The turn this call was made in has ended, so the platform did nothing with it.");
		if (run === undefined) return refused("This session has no such tool of the platform's.");
		// Windlass names a call `<messageId>/<callId>`, as the turn's events name it apart.
		const id = typeof params.toolCallId === "string" ? params.toolCallId : "";
		const at = id.indexOf("/");
		const call: TurnPublishRequest = { messageId: at > 0 ? id.slice(0, at) : "", callId: at > 0 ? id.slice(at + 1) : id, arguments: callArguments(params.input) };
		const key = callKey(call.messageId, call.callId);
		const controller = new AbortController();
		this.hostCalls.get(key)?.abort();
		this.hostCalls.set(key, controller);
		try {
			const text = await run(call, controller.signal);
			return { status: "success", output: typeof text === "string" && text !== "" ? text : CALL_NOT_HANDLED };
		} catch {
			return refused(CALL_NOT_HANDLED);
		} finally {
			if (this.hostCalls.get(key) === controller) this.hostCalls.delete(key);
		}
	}

	/**
	 * A tool call's approval question. Anything else the engine asks this way (the hand-edit question of
	 * an undo, which this layer never starts) is declined.
	 */
	private async permission(params: Record<string, unknown>): Promise<unknown> {
		const cancelled = { outcome: { outcome: "cancelled" } };
		const question = questionOf(params);
		const ask = this.input.onQuestion;
		if (question !== null && params.sessionId === this.session && !this.cancelSent && !this.over) {
			const key = callKey(question.messageId, question.callId);
			// A call of a tool of one of the user's own servers whose tools run without asking: answered for the user
			// where the question is the session's own and about using exactly that tool, and whoever keeps a record is told.
			const unasked = this.unaskedCalls.get(key);
			const allowed = unasked !== undefined && question.subagent === null && toolAsked(params) === `${unasked.server}/${unasked.tool}`;
			if (allowed) {
				const allow = question.choices.find((choice) => choice.approve && choice.remembers === null) ?? question.choices.find((choice) => choice.approve);
				if (allow !== undefined) {
					try {
						this.input.onUnasked?.(unasked);
					} catch {
						// A listener's failure must not stop the turn.
					}
					return { outcome: { outcome: "selected", optionId: allow.id } };
				}
			}
		}
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

	// ---- the project's MCP servers ----

	/**
	 * Before the prompt: Windlass is asked which servers wait (`_windlass/mcp` reads the configuration as
	 * it is now), and each is put to the user. An answer can bring the next question (a definition that
	 * changed under its own question waits anew), so this returns when none is left. A Windlass that
	 * cannot say leaves the turn as it was before the platform asked: such servers stay stopped.
	 */
	private async askAboutServers(): Promise<void> {
		// Also asked for the servers whose tools run without asking: whose a server is, by the engine's word, decides whether a call is acted on.
		if (this.input.onServerQuestion === undefined && this.input.onServers === undefined && this.unasked.size === 0) return;
		try {
			await this.peer.request(EXT.mcp, { sessionId: this.session }, { timeoutMs: SERVERS_TIMEOUT_MS, onResult: (list) => this.serversSaid(list) });
		} catch (error) {
			if (!(error instanceof AcpError && error.reason === "closed")) {
				this.notes.push(`[platform] Windlass did not say which MCP servers of the project wait for approval (${error instanceof Error ? error.message : String(error)}); none was asked about`);
			}
			return;
		}
		for (let line: Promise<void> | null = null; line !== this.serverLine; ) {
			line = this.serverLine;
			await line;
		}
	}

	/**
	 * What Windlass says of the session's servers: the answer to `_windlass/mcp` and to an approval, and
	 * `_windlass/mcp_changed`. A definition that waits and was not asked about in this turn joins the line
	 * of questions; whoever waits for a server to start is woken.
	 */
	private serversSaid(raw: unknown): void {
		const servers = serversOf(raw);
		if (servers === null) return;
		this.servers = servers;
		for (const wake of [...this.serverWaiters]) wake();
		if (this.over) return;
		try {
			this.input.onServers?.(servers.flatMap((server) => describeServer(server, this.personal)));
		} catch {
			// A listener's failure must not stop the turn.
		}
		if (this.input.onServerQuestion === undefined) return;
		for (const server of servers) {
			if (server.state !== "awaiting_approval" || server.fingerprint === null) continue;
			const key = `${server.name}:${server.fingerprint}`;
			if (this.serversAsked.has(key)) continue;
			this.serversAsked.add(key);
			this.serverLine = this.serverLine.then(() => this.askServer(server)).catch(() => undefined);
		}
	}

	/** Puts one server's question, and has Windlass start the server on a yes. Never throws. */
	private async askServer(server: ServerState): Promise<void> {
		const ask = this.input.onServerQuestion;
		const gone = () => this.over || this.abortRequested || this.cancelSent || this.peer.closed;
		if (ask === undefined || gone() || !this.stillWaits(server)) return;
		const controller = new AbortController();
		const withdrawn = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
		this.serverQuestions.add(controller);
		try {
			const reads = await Promise.race([this.variablesOf(server), withdrawn]);
			// Meanwhile the turn may have ended, or the definition changed: then this one is no longer the question.
			if (reads === null || gone() || !this.stillWaits(server)) return;
			const question: TurnServerQuestion = {
				name: server.name,
				fingerprint: server.fingerprint ?? "",
				argv: server.argv,
				url: server.argv === null ? server.target : null,
				file: server.file,
				unset: reads.unset,
				secrets: reads.secrets,
				holdsTurn: !this.promptSent,
			};
			const start = await Promise.race([
				Promise.resolve()
					.then(() => ask(question, controller.signal))
					.catch(() => false),
				withdrawn,
			]);
			if (controller.signal.aborted || start !== true) return;
			const outcome = await this.approveServer(question);
			try {
				this.input.onServerApproved?.(question, outcome);
			} catch {
				// A listener's failure must not stop the turn.
			}
		} finally {
			this.serverQuestions.delete(controller);
		}
	}

	/** Whether Windlass still says that exactly this definition waits. */
	private stillWaits(server: ServerState): boolean {
		return this.servers.some((now) => now.name === server.name && now.state === "awaiting_approval" && now.fingerprint === server.fingerprint);
	}

	/** `_windlass/mcp_approve`, and what became of the server: Windlass starts it at once and says so (`_windlass/mcp_changed` comes before the answer). */
	private async approveServer(question: TurnServerQuestion): Promise<TurnServerOutcome> {
		let answer: { approved?: unknown } | null;
		try {
			answer = await this.peer.request<{ approved?: unknown } | null>(EXT.mcpApprove, { sessionId: this.session, name: question.name, fingerprint: question.fingerprint }, { timeoutMs: SERVERS_TIMEOUT_MS, onResult: (list) => this.serversSaid(list) });
		} catch (error) {
			return { state: "refused", reason: error instanceof Error ? error.message : String(error) };
		}
		// No such server waited: the definition changed after the question was put.
		if (answer?.approved !== true) return { state: "changed" };
		const deadline = Date.now() + SERVER_START_WAIT_MS;
		for (;;) {
			const now = this.servers.find((server) => server.name === question.name);
			if (now?.state === "running") return { state: "running", tools: now.tools ?? 0 };
			if (now?.state === "failed" || now?.state === "stopped") return { state: "failed", reason: now.error ?? "Windlass gave no reason" };
			const left = deadline - Date.now();
			if (left <= 0 || this.over || this.peer.closed) return { state: "starting" };
			await this.serversChange(left);
		}
	}

	/** Resolves when Windlass next says its servers changed, the turn is over, or `ms` have passed. */
	private serversChange(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.serverWaiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.serverWaiters.add(done);
			void this.whenOver.then(done);
		});
	}

	/**
	 * The variables a server's definition reads: those that are not set where the engine runs, and those
	 * the engine was handed as secrets of the repository. Windlass puts `${NAME}` in a definition's `env`
	 * and `headers` in place from its own environment when the server starts, and does not start a
	 * server that names one that is not set. Which names a definition reads is in the file Windlass says
	 * defines it. Whether each is set is known for what the engine was started with, and asked of the
	 * sandbox for the rest (its own environment; no value is sent along to ask), so the user can be
	 * told before they answer. Both empty when the file cannot be read as Windlass reads it: the
	 * server's failure then says it, in Windlass's words.
	 */
	private async variablesOf(server: ServerState): Promise<{ unset: string[]; secrets: string[] }> {
		const none = { unset: [], secrets: [] };
		try {
			if (server.file === null || !server.file.startsWith("/")) return none;
			const file = await this.sandbox.ask(["cat", "--", server.file], { timeoutMs: DEFINITION_TIMEOUT_MS });
			if (file === null || file.code !== 0) return none;
			const names = variablesRead(file.stdout, server.name);
			const secrets = names.filter((name) => this.engineSecrets.has(name));
			const others = names.filter((name) => !this.engineSecrets.has(name) && !(name in this.engineEnv));
			if (others.length === 0) return { unset: [], secrets };
			const said = await this.sandbox.ask(["sh", "-c", 'for name in "$@"; do printenv "$name" >/dev/null || echo "$name"; done', "sh", ...others], { timeoutMs: DEFINITION_TIMEOUT_MS });
			if (said === null || said.code !== 0) return { unset: [], secrets };
			const unset = new Set(said.stdout.split("\n").map((line) => line.trim()));
			return { unset: others.filter((name) => unset.has(name)), secrets };
		} catch {
			return none;
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
		for (const question of this.serverQuestions) question.abort();
		for (const call of this.hostCalls.values()) call.abort();
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
		// A question about a server is the platform's own to withdraw: Windlass waits for nothing there.
		for (const question of this.serverQuestions) question.abort();
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
		// An approval on its way to Windlass is reported before the turn is: its question was withdrawn above, so this is short.
		await within(this.serverLine, SERVERS_TIMEOUT_MS);
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
					this.input.onEvent?.(summary);
				} catch {
					// A listener's failure must not stop the turn.
				}
			}
			// A failed execution the prompt's answer did not report (the one a late message started).
			if (last.outcome === "failed" && this.failure === null) this.failure = { reason: "execution_failed", message: last.message ?? "the turn failed" };
		}
		this.sealed = true;
		if (this.failure === null && this.processEnd !== null && !this.abortRequested && this.summary === null) {
			// A process the sandbox layer ended itself carries its sentence (a machine removed, its runner restarted): that is what a person can act on.
			const end = this.processEnd;
			this.failure = { reason: "engine", message: end.error !== null ? end.error.message : `the engine process ${describeEnd(end)} in the middle of the turn${this.lastWords()}` };
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

	/** Makes a refusal of the engine the turn's failure, unless it has one, and keeps Windlass's code for it when the error carries one. */
	private refused(error: unknown, fallback = "engine"): void {
		if (this.failure !== null) return;
		this.failure = this.failureOf(error, fallback);
		this.failureCode = error instanceof AcpError ? error.failureCode : null;
	}

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

type Initialized = { agentCapabilities?: { _meta?: Record<string, unknown> } };

/** The keys of `_meta.windlass` an engine reads when a session is opened, from its answer to `initialize`; none when it lists none. */
function openKeysIn(init: Initialized): string[] {
	const listed = (init.agentCapabilities?._meta?.[NS] as { openMeta?: unknown } | undefined)?.openMeta;
	return Array.isArray(listed) ? listed.filter((key): key is string => typeof key === "string") : [];
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

/**
 * The tool a permission request asks about, when using it is all the question is about: the one
 * need of `_meta.windlass.approval.needs`, `{ kind: "tool", tool }`, which for an MCP server's tool
 * is `<server>/<tool>`. Null for a question about anything else, or about more.
 */
function toolAsked(params: Record<string, unknown>): string | null {
	const meta = (params._meta as Record<string, unknown> | undefined)?.[NS] as { approval?: { needs?: unknown } } | undefined;
	const needs = meta?.approval?.needs;
	if (!Array.isArray(needs) || needs.length !== 1) return null;
	const need = needs[0] as { kind?: unknown; tool?: unknown } | null;
	return need?.kind === "tool" && typeof need.tool === "string" ? need.tool : null;
}

/** One MCP server of the session as `_windlass/mcp` describes it (Windlass's docs/acp.md, "The session's features"). */
interface ServerState {
	name: string;
	/** "running", "starting", "failed", "awaiting_approval", "disabled", "stopped" or "not_started". */
	state: string;
	/** The command and its arguments; null for a server reached at an address. */
	argv: string[] | null;
	/** The command with its arguments, or the address. */
	target: string | null;
	tools: number | null;
	error: string | null;
	file: string | null;
	/** Of the definition that waits (`question.fingerprint`); null when none does. */
	fingerprint: string | null;
	/** "user": only the user's own configuration defines it. "project": the project's file names or changes it. Null when Windlass did not say. */
	origin: string | null;
}

/**
 * A server as the layer's callers are told of it (`RunTurnInput.onServers`): the project's own, and
 * the user's own that this turn wrote into the configuration (`personal`, by name). One a file
 * switches off is left out, as Windlass leaves it out. Anything else that only the configuration file
 * of the sandbox's user defines is neither: the platform's own server, or one something in the
 * sandbox wrote there.
 */
function describeServer(server: ServerState, personal: ReadonlySet<string>): TurnServer[] {
	if (server.state === "disabled" || (server.origin === "user" && !personal.has(server.name))) return [];
	const state = server.state === "awaiting_approval" ? "waiting" : server.state === "running" || server.state === "starting" || server.state === "failed" ? server.state : "stopped";
	return [{ name: server.name, origin: server.origin === "user" ? "user" : "project", state, argv: server.argv, url: server.argv === null ? server.target : null, file: server.file, tools: server.tools, error: server.error, fingerprint: server.fingerprint }];
}

/** The servers in an answer to `_windlass/mcp` or `_windlass/mcp_approve`, or in `_windlass/mcp_changed`; null when it has none. */
function serversOf(raw: unknown): ServerState[] | null {
	const servers = (raw as { servers?: unknown } | null | undefined)?.servers;
	if (!Array.isArray(servers)) return null;
	return servers.flatMap((item: unknown) => {
		const server = item as { name?: unknown; state?: unknown; argv?: unknown; target?: unknown; tools?: unknown; error?: unknown; file?: unknown; origin?: unknown; question?: { fingerprint?: unknown } | null };
		if (typeof server?.name !== "string" || typeof server.state !== "string") return [];
		return [
			{
				name: server.name,
				state: server.state,
				argv: Array.isArray(server.argv) && server.argv.every((argument): argument is string => typeof argument === "string") ? server.argv : null,
				target: typeof server.target === "string" ? server.target : null,
				tools: typeof server.tools === "number" ? server.tools : null,
				error: typeof server.error === "string" && server.error !== "" ? server.error : null,
				file: typeof server.file === "string" && server.file !== "" ? server.file : null,
				fingerprint: typeof server.question?.fingerprint === "string" && server.question.fingerprint !== "" ? server.question.fingerprint : null,
				origin: typeof server.origin === "string" ? server.origin : null,
			},
		];
	});
}

/** `${NAME}` in a value of a server's definition: Windlass's own pattern (its packages/core/src/mcp/config.ts). */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The variables the definition of `name` in a configuration file reads: every `${NAME}` in the values
 * of its `env` and `headers`, in order of first appearance. The file is the repository's own, so
 * nothing is assumed of it: anything that is not the shape Windlass reads gives no names.
 */
export function variablesRead(text: string, name: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const object = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
	const servers = object(object(object(parsed)?.mcp)?.servers);
	const definition = servers !== null && Object.hasOwn(servers, name) ? object(servers[name]) : null;
	if (definition === null) return [];
	const names: string[] = [];
	for (const key of ["env", "headers"]) {
		for (const value of Object.values(object(definition[key]) ?? {})) {
			if (typeof value !== "string") continue;
			for (const match of value.matchAll(VARIABLE)) if (!names.includes(match[1])) names.push(match[1]);
		}
	}
	return names;
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
