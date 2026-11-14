/**
 * The sandbox layer's interface: what the actors call, and what `server/src/sandbox/` implements.
 *
 * Everything that knows about Docker, about the sandbox image, and about how the `windlass` binary is
 * invoked lives behind this file. The actors know none of it.
 *
 * Names of Docker resources (all carry the label `dev.windlass-platform=1` so they can be listed and
 * removed together):
 *
 *   image      windlass-platform-sandbox:latest   built by sandbox/build.sh
 *   volume     wlp-user-<uid>                     a user's Windlass data directory: the ChatGPT sign-in,
 *                                                 Windlass's own session logs and memory
 *   volume     wlp-login-<attemptId>              a sign-in attempt's data directory, until it is adopted
 *   container  wlp-session-<sandboxId>            one per agent session; the workspace is /workspace
 */

import type { SandboxProfile, SandboxProfileId, WindlassEvent } from "../contract.js";

// ---------------------------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------------------------

export interface ExecOptions {
	/** Defaults to the sandbox's workspace. */
	cwd?: string;
	env?: Record<string, string>;
	/** Written to the command's standard input, which is then closed. Without it, stdin is empty. */
	stdin?: string;
	timeoutMs?: number;
	/**
	 * Aborting stops the command inside the sandbox, not only the local client: the process group gets
	 * SIGTERM, then SIGKILL after a grace period, and `exec` resolves with `aborted: true`.
	 */
	signal?: AbortSignal;
	/** Standard output as it arrives. Chunks may split lines and multi-byte characters are kept whole. */
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface ExecResult {
	/** Null when the command was killed. */
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	/** Everything written to standard output, capped; `onStdout` sees it all. */
	stdout: string;
	stderr: string;
}

/**
 * A running sandbox: commands with standard input, separate stderr and an abort that reaches the
 * process inside, and text files. (Rivet's `@rivet-dev/sandbox-adapter` has a similar `Sandbox`, but
 * its Docker provider can mount no volume and cannot relax the security options Windlass's own
 * sandbox needs, so this layer drives Docker itself.)
 */
export interface SandboxHandle {
	readonly id: string;
	/** The workspace directory inside the sandbox: "/workspace". */
	readonly cwd: string;
	readonly profile: SandboxProfileId;
	run(command: string, options?: ExecOptions): Promise<ExecResult>;
	readTextFile(path: string): Promise<string>;
	writeTextFile(path: string, content: string): Promise<void>;
}

export interface CreateSandboxInput {
	uid: string;
	sessionId: string;
	profile: SandboxProfileId;
}

export interface Sandboxes {
	/** Every profile, available or not, in the order the picker shows them. */
	profiles(): SandboxProfile[];
	profile(id: SandboxProfileId): SandboxProfile;
	/** Creates and starts a sandbox with an empty git repository in its workspace. Returns its id. */
	create(input: CreateSandboxInput): Promise<string>;
	/** Starts the sandbox if it is paused. Undefined when it no longer exists. */
	connect(id: string): Promise<SandboxHandle | undefined>;
	/** "none" when it does not exist. */
	state(id: string): Promise<"none" | "running" | "paused">;
	/** Pauses it: nothing runs, files stay. A no-op when already paused or gone. */
	suspend(id: string): Promise<void>;
	/** Removes it with its files. A no-op when already gone. */
	destroy(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Running Windlass in a sandbox
// ---------------------------------------------------------------------------------------------

/** A tool call that needs the user's approval before it runs, as Windlass asks it. */
export interface TurnQuestion {
	/** The call it is about, as `approval.requested` and `tool.called` name it. */
	messageId: string;
	callId: string;
	title: string;
	/** The command, path or tool, verbatim. */
	subject: string;
	details: string[];
	choices: Array<{ id: string; label: string; approve: boolean; remembers: string | null }>;
	/** Set when a subagent asked: the first line of its task. */
	subagent: string | null;
}

export interface TurnAnswer {
	/** The id of one of the question's choices. */
	choice: string;
	/** Goes to the model with the result. */
	note?: string;
}

/** A handle on a turn in progress. Its methods reject once the turn has ended. */
export interface TurnControl {
	/** Sends a message into the running turn; the model reads it at its next step. Resolves once Windlass admitted it. */
	steer(text: string): Promise<void>;
	/** Stops one running tool call; the turn goes on. `stopped: false` with Windlass's reason when it could not be asked to stop. */
	cancelCall(messageId: string, callId: string): Promise<{ stopped: boolean; message: string | null }>;
}

export interface RunTurnInput {
	prompt: string;
	/** Windlass's own session to continue (`session/resume`); omitted for the first turn. */
	windlassSessionId?: string;
	model?: string;
	effort?: string;
	/**
	 * Demo mode: the model's responses, in WINDLASS_ACP_SCRIPT form. No model is called and no sign-in
	 * is needed; tool calls in the script really run in the sandbox.
	 */
	script?: ScriptedModel;
	signal?: AbortSignal;
	/**
	 * Every event of the turn, in order: Windlass's own events exactly as `windlass --json` prints them,
	 * and after the last of them one `cli.summary`-shaped event the layer makes itself (`type`,
	 * `sessionId`, `executionId`, `outcome`, `steps`, `summaryCalls`, `requests`, `durationMs`, `usage`,
	 * `cachedShare`), adding up every execution of the turn (a message steered in at the very end
	 * starts a second one).
	 */
	onEvent: (event: WindlassEvent) => void;
	/**
	 * Called when a tool call needs the user's approval; the turn waits for the promise. Resolve with
	 * the chosen option. `signal` aborts when Windlass withdraws the question (the turn was stopped):
	 * whatever the promise does afterwards is ignored. A rejection declines the call. Without this
	 * callback nobody can answer: Windlass is told so, and a call that would ask is refused at once.
	 */
	onQuestion?: (question: TurnQuestion, signal: AbortSignal) => Promise<TurnAnswer>;
	/** Called once, when the turn has started and can be steered. */
	onControl?: (control: TurnControl) => void;
}

export interface RunTurnResult {
	/** The exit code of the Windlass process that served the turn: 0 after any orderly end, whatever the turn's outcome; null when it was killed. */
	exitCode: number | null;
	aborted: boolean;
	timedOut: boolean;
	/** The `ses_...` id seen on the events, if any arrived. */
	windlassSessionId: string | null;
	/** The summary event the layer made (see `onEvent`); null when the turn ended before Windlass reported how. */
	summary: WindlassEvent | null;
	/** The end of standard error, for an error message. */
	stderrTail: string;
	/**
	 * Set when the turn could not be run or broke off for a reason Windlass named, with its sentence:
	 * `auth_required` (no usable ChatGPT sign-in), `session_not_found` (the session to continue is
	 * gone), `session_in_use` (another process holds it), `execution_failed` (the turn failed; the
	 * events say how), `engine` (the process could not be started or died), or another reason Windlass
	 * names (`invalid_request`, `unknown_model`, `unknown_effort`, ...). Null otherwise, and null when
	 * `aborted` is true.
	 */
	failure: { reason: string; message: string } | null;
}

/** `{ "responses": [[item, ...], ...] }`: one list per model call. */
export interface ScriptedModel {
	responses: Array<Array<Record<string, unknown>>>;
}

export interface Windlass {
	/** The binary's version in the image, e.g. "0.1.0"; null when the image is missing. */
	version(): Promise<string | null>;
	/** The models `--model` accepts, the default first. Falls back to a built-in list. */
	models(): Promise<string[]>;
	/**
	 * Runs one prompt to its end with the profile's approval mode. It speaks the Agent Client Protocol
	 * to a `windlass acp` process that lives for this one turn (see fixtures/acp-probe/), so the turn
	 * can ask questions and be steered; aborting `signal` cancels the turn through the protocol first.
	 */
	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult>;
	/**
	 * A scripted model for a demo turn: a short, varied scenario of real tool calls (write a file, run
	 * it, read it back, fix something) that suits the prompt's words where it can. `turn` starts at 1.
	 */
	demoScript(prompt: string, turn: number): ScriptedModel;
}

// ---------------------------------------------------------------------------------------------
// Sign in with ChatGPT, done by Windlass itself (`windlass login start|finish|status`)
// ---------------------------------------------------------------------------------------------

export interface ChatgptAccount {
	/** OpenAI's stable account identifier. */
	sub: string;
	email: string | null;
	/** When the saved access token expires, ms since the epoch. */
	accessExpiresAt: number | null;
}

/** Thrown for a failure the user can act on; `message` is fit to show. */
export class SandboxUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUserError";
	}
}

export interface ChatgptLogins {
	/** Begins a sign-in in a fresh data volume for this attempt and returns the address to open. */
	start(attemptId: string): Promise<{ url: string; redirectPrefix: string }>;
	/**
	 * Finishes the attempt from the pasted address and returns the account that signed in. Throws
	 * SandboxUserError when the address is not the one expected, the attempt is unknown or OpenAI
	 * refuses the exchange.
	 */
	finish(attemptId: string, pastedUrl: string): Promise<ChatgptAccount>;
	/** Moves the attempt's sign-in into the user's data volume, replacing an earlier one, and removes the attempt. */
	adopt(attemptId: string, uid: string): Promise<void>;
	/** Removes an unfinished attempt. A no-op when it is gone. */
	discard(attemptId: string): Promise<void>;
	/** The sign-in saved in the user's data volume, or null. */
	status(uid: string): Promise<ChatgptAccount | null>;
	/** Forgets the user's saved sign-in. */
	logout(uid: string): Promise<void>;
	/** Makes sure the user's data volume exists (a demo user has one with no sign-in in it). */
	ensureUserVolume(uid: string): Promise<void>;
}

/** What `server/src/sandbox/index.ts` exports as `createSandboxLayer()`. */
export interface SandboxLayer {
	sandboxes: Sandboxes;
	windlass: Windlass;
	logins: ChatgptLogins;
}
