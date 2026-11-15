/**
 * The contract between the server's actors and the web app. Types and constants only: this file
 * imports nothing, so the web app can import it without pulling in server code.
 *
 * Three actors, and one HTTP route:
 *
 *   GET /platform/info                    public facts about this deployment, from any server
 *   login         key [attemptId]         one sign-in attempt (ChatGPT, or the demo user)
 *   user          key [uid]               a user's profile and the index of their sessions
 *   agentSession  key [uid, sessionId]    one agent: its sandbox, its timeline, its runs
 *
 * The route and `login` take no credentials. `user` and `agentSession` require the connection
 * parameter `{ token }` (an AuthToken from `login`), and the token's uid must equal key[0].
 */

// ---------------------------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------------------------

/**
 * Where a session's files and commands live. Two profiles work today, both on local Docker; the
 * rest are listed so the picker can say what each would need.
 */
export type SandboxProfileId =
	| "docker-windlass-sandbox"
	| "docker-hardened"
	| "e2b"
	| "daytona"
	| "firecracker"
	| "agentos";

export interface SandboxProfile {
	id: SandboxProfileId;
	/** Short display name, e.g. "Docker + Windlass sandbox". */
	name: string;
	/** One sentence: what this choice means. */
	summary: string;
	/** What isolates the agent, outermost layer first. Short phrases. */
	layers: string[];
	/** The `--approval` mode Windlass runs with in this profile. */
	approval: "auto" | "full";
	/** Whether commands the agent runs can reach the network. */
	commandNetwork: boolean;
	/**
	 * Whether commands the agent runs can read the session's access token: the short-lived token of the
	 * user's ChatGPT sign-in that each turn is handed. It lasts about an hour, and whoever reads it
	 * cannot renew it. The sign-in itself, which is what renews tokens, is never in a sandbox: no
	 * command can read it in any profile.
	 */
	commandsCanReadAccessToken: boolean;
	available: boolean;
	/** Why it cannot be chosen yet. Set when `available` is false. */
	unavailableReason?: string;
}

// ---------------------------------------------------------------------------------------------
// Platform information (HTTP, `GET PLATFORM_INFO_PATH`; once the `platform` actor)
// ---------------------------------------------------------------------------------------------

export interface PlatformInfo {
	/** True when the server runs with WLP_DEMO=1: the demo sign-in is offered and its model is scripted. */
	demoEnabled: boolean;
	/** The Windlass version inside the sandbox image, e.g. "0.1.1+0f5192c3ea". */
	windlassVersion: string | null;
	profiles: SandboxProfile[];
	/** Models a session may be started with; the first is the default. */
	models: string[];
	/** Reasoning efforts a prompt may ask for. */
	efforts: string[];
}

/** @deprecated The `platform` actor is gone: the information is served over HTTP (PLATFORM_INFO_PATH). */
export interface PlatformActions {
	info(): Promise<PlatformInfo>;
}

// ---------------------------------------------------------------------------------------------
// login actor
// ---------------------------------------------------------------------------------------------

/** Opaque to the web app: stored and sent back as the `token` connection parameter. */
export type AuthToken = string;

export interface UserProfile {
	uid: string;
	/** The ChatGPT account's email, when OpenAI gave one. Null for the demo user. */
	email: string | null;
	/** A demo user has no ChatGPT sign-in: its sessions run a scripted model. */
	demo: boolean;
}

export interface AuthResult {
	token: AuthToken;
	profile: UserProfile;
}

export interface LoginStart {
	/** The OpenAI address to open in a new tab. */
	url: string;
	/** The loopback address the browser ends on, e.g. "http://127.0.0.1:1455/auth/callback". */
	redirectPrefix: string;
	/** When this attempt stops being accepted, ms since the epoch. */
	expiresAt: number;
}

export interface LoginActions {
	/** Begins "Sign in with ChatGPT". Calling it again restarts the attempt. */
	start(): Promise<LoginStart>;
	/**
	 * Finishes the attempt from the full address of the page the browser ended on. Throws a UserError
	 * with a message fit to show (wrong address, expired attempt, OpenAI refused).
	 */
	finish(pastedUrl: string): Promise<AuthResult>;
	/** Signs in as a fresh demo user. Throws when the server has no demo mode. */
	demo(): Promise<AuthResult>;
}

// ---------------------------------------------------------------------------------------------
// user actor
// ---------------------------------------------------------------------------------------------

export type SessionStatus =
	/** Nothing running; ready for a prompt. */
	| "idle"
	/** A prompt was accepted; the sandbox is being created or started. */
	| "starting"
	/** Windlass is working on a prompt. */
	| "running"
	/** A turn is running and Windlass waits for the user's answer to a question (`SessionSnapshot.question`). */
	| "waiting"
	/** A stop was asked for and Windlass is winding down. */
	| "stopping";

/** How a turn ended. The first five are Windlass's own outcomes (`cli.summary.outcome`). */
export type TurnOutcome =
	| "succeeded"
	| "unresolved"
	| "failed"
	| "stopped"
	| "interrupted"
	/** The platform could not run the turn at all (sandbox failure, Windlass crashed). */
	| "error";

export interface SessionSummary {
	id: string;
	title: string;
	profile: SandboxProfileId;
	model: string;
	/** A git repository cloned into the workspace when the sandbox was created, if any. */
	repoUrl: string | null;
	createdAt: number;
	/** Last prompt or turn end. */
	updatedAt: number;
	status: SessionStatus;
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** Whether the sandbox exists and whether it is running or paused. */
	sandbox: "none" | "running" | "paused";
}

export interface CreateSessionInput {
	/** Defaults to "New agent"; replaced by the first prompt's opening words when left unset. */
	title?: string;
	profile: SandboxProfileId;
	/** Defaults to the platform's first model. */
	model?: string;
	/** An https git address to clone into the workspace. */
	repoUrl?: string;
}

export interface ChatgptStatus {
	connected: boolean;
	email: string | null;
	/** When the saved sign-in's access token expires, ms since the epoch. The platform refreshes it when a turn needs a token within twenty minutes of that, or after. */
	accessExpiresAt: number | null;
}

export interface UserActions {
	me(): Promise<UserProfile>;
	chatgpt(): Promise<ChatgptStatus>;
	listSessions(): Promise<SessionSummary[]>;
	createSession(input: CreateSessionInput): Promise<SessionSummary>;
	renameSession(id: string, title: string): Promise<SessionSummary>;
	/** Destroys the session's actor and its sandbox. */
	deleteSession(id: string): Promise<void>;
}

export interface UserEvents {
	/** The full list, newest first, after any change to it. */
	sessions: SessionSummary[];
}

// ---------------------------------------------------------------------------------------------
// agentSession actor
// ---------------------------------------------------------------------------------------------

/**
 * One of Windlass's own events, passed through untouched: the same JSON `windlass --json` prints. Durable events carry `v`, `data`, `seq`
 * and `time`; ephemeral ones (`text.delta`, `reasoning.delta`, `tool.input.delta`, `tool.progress`,
 * `notice`, `workspace.changes`, `cli.summary`) carry their fields at the top level and no `seq`.
 * See fixtures/windlass-events/ and Windlass's docs/event-log.md.
 */
export interface WindlassEvent {
	type: string;
	sessionId?: string;
	v?: number;
	seq?: number;
	time?: number;
	data?: Record<string, unknown>;
	[field: string]: unknown;
}

/** `cli.summary`: the line Windlass prints after each turn. */
export interface TurnUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
}

/**
 * An entry of a session's timeline. `seq` is the platform's own numbering, dense and increasing
 * within a session, and has nothing to do with a Windlass event's `seq`.
 */
export type TimelineItem =
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "user";
			text: string;
			model: string;
			effort: string | null;
			/**
			 * True for a message sent while the turn was already running: it does not start a turn, the
			 * model reads it at its next step. Absent or false for the prompt that started the turn.
			 */
			steer?: boolean;
	  }
	/** Something the platform did around a turn: "Creating sandbox", "Cloning repository". */
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "platform";
			level: "info" | "warn" | "error";
			text: string;
			/**
			 * Set on the line that says the platform declined a question because nobody answered in time
			 * ("question_expired"), with the call the question was about. Windlass's own `approval.answered`
			 * for that call follows, with choice "deny": this is how a client tells it from the user's choice.
			 */
			code?: "question_expired";
			call?: { messageId: string; callId: string };
	  }
	/** A durable Windlass event, or one of the stored ephemeral ones (`notice`, `workspace.changes`, `cli.summary`). */
	| { seq: number; at: number; turn: number; kind: "windlass"; event: WindlassEvent }
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "turn.ended";
			outcome: TurnOutcome;
			/** Windlass's exit code, null when it never ran or was killed. */
			exitCode: number | null;
			steps: number | null;
			durationMs: number;
			usage: TurnUsage | null;
			/** Share of input tokens read from the prompt cache, 0..1. */
			cachedShare: number | null;
			/** Set for "error": what went wrong, fit to show. */
			message: string | null;
	  };

/** Streaming output that is broadcast but never stored: `text.delta`, `reasoning.delta`, `tool.input.delta`, `tool.progress`. */
export interface LiveDelta {
	turn: number;
	event: WindlassEvent;
}

/** One answer a question offers. */
export interface QuestionChoice {
	/** Windlass's own id: "once", "session", "project" or "deny". */
	id: string;
	label: string;
	/** Whether choosing it lets the call run. */
	approve: boolean;
	/** What choosing it remembers, in words ("network for sandboxed commands, for the rest of this session"); null when nothing. */
	remembers: string | null;
}

/**
 * A question Windlass is waiting on: a tool call needs the user's approval before it runs. At most
 * one is pending per session. The same question is in the timeline as Windlass's `approval.requested`
 * event, and its answer as `approval.answered`; this is the live copy with what the platform adds.
 */
export interface PendingQuestion {
	/** Identifies this question in `answer()`. */
	id: string;
	turn: number;
	/** The call it is about, as `approval.requested` and `tool.called` name it. */
	messageId: string;
	callId: string;
	/** The question, e.g. "Allow network access for this command?". */
	title: string;
	/** The command, path or tool it is about, verbatim. */
	subject: string;
	/** What the user should know before answering, one sentence each. */
	details: string[];
	choices: QuestionChoice[];
	/** Set when a subagent asked: the first line of its task. */
	subagent: string | null;
	askedAt: number;
	/** When the platform declines by itself because nobody answered, ms since the epoch. */
	expiresAt: number;
}

export interface SessionSnapshot {
	summary: SessionSummary;
	profile: SandboxProfile;
	/** Windlass's own session ID (`ses_...`), once the first turn created it. */
	windlassSessionId: string | null;
	/** The whole stored timeline, oldest first. */
	timeline: TimelineItem[];
	/**
	 * The streaming state of the turn in progress, so that a client that connects in the middle of a
	 * turn sees the text written before it connected: the deltas, in order, whose durable event has
	 * not arrived yet. A delta is dropped when the event that supersedes it is stored (`text.ended`,
	 * `reasoning.ended`, `tool.called`, `tool.settled`, the step's end), so a call still running beside
	 * a finished one keeps its progress. Empty when nothing is running.
	 */
	pending: LiveDelta[];
	/** The question the turn in progress waits on, if any. */
	question: PendingQuestion | null;
}

export interface PromptInput {
	text: string;
	/** Switches the session's model from this turn on. */
	model?: string;
	effort?: string;
}

export interface WorkspaceFile {
	/** Relative to the workspace root. */
	path: string;
	/** Git's two-letter status, e.g. " M", "??", "A ". */
	status: string;
}

export interface AgentSessionActions {
	snapshot(): Promise<SessionSnapshot>;
	/**
	 * Starts a turn and returns as soon as it is accepted; the work arrives as events. While a turn is
	 * running it steers that turn instead: the message is stored as a `user` item with `steer: true`,
	 * the model reads it at its next step, and `steered` is true (`model` and `effort` are ignored
	 * then). Throws a UserError when the text is empty, when the user must sign in to ChatGPT first,
	 * or when a running turn cannot take the message (code `turn_running`: it is starting or stopping).
	 */
	prompt(input: PromptInput): Promise<{ turn: number; steered: boolean }>;
	/**
	 * Answers the pending question with one of its choices. `note` goes to the model with the result
	 * (why it was declined, what to do instead). Throws a UserError with code `no_question` when that
	 * question is no longer pending (answered elsewhere, expired, or the turn was stopped), `bad_choice`
	 * when the question does not offer that choice, and `note_too_long` past `MAX_NOTE_CHARS`.
	 */
	answer(input: { questionId: string; choice: string; note?: string }): Promise<void>;
	/**
	 * Stops one running tool call and nothing else: the call settles with what it had done and a line
	 * saying the user stopped it, and the turn goes on. Throws a UserError with code `no_turn` when no turn is running;
	 * resolves with `stopped: false` and Windlass's reason when the call could not be asked to stop.
	 */
	stopCall(input: { messageId: string; callId: string }): Promise<{ stopped: boolean; message: string | null }>;
	/** Stops the turn in progress. Resolves when the stop was asked for, not when it took effect. */
	stop(): Promise<void>;
	/** Files that differ from the last commit in the workspace (empty without a sandbox). */
	changes(): Promise<WorkspaceFile[]>;
	/** `git diff` of the workspace against the last commit, capped at 400 kB. */
	diff(): Promise<string>;
}

export interface AgentSessionEvents {
	/** A stored timeline entry, in `seq` order. */
	item: TimelineItem;
	/** Streaming output of the turn in progress. */
	delta: LiveDelta;
	/** The session's summary, after any change to it. */
	summary: SessionSummary;
	/** The pending question, when one is asked; null when it was settled (answered, expired, withdrawn). */
	question: PendingQuestion | null;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Where the server's Rivet endpoint listens in development. */
export const DEFAULT_ENDPOINT = "http://localhost:6420";
/**
 * Where the server's own HTTP routes listen in development. Every server serves them; with several
 * servers the web app is pointed at whatever spreads requests over them.
 */
export const DEFAULT_PLATFORM_URL = "http://localhost:6440";
/** `GET` on the platform's HTTP address: this deployment's `PlatformInfo`, as JSON. */
export const PLATFORM_INFO_PATH = "/platform/info";

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_TITLE_CHARS = 80;
/** The note sent with an answer to a question. */
export const MAX_NOTE_CHARS = 2_000;
/** How long a question waits for an answer before the platform declines it. */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
/** Sessions of one user that may run a turn at the same time. */
export const MAX_RUNNING_SESSIONS = 3;
