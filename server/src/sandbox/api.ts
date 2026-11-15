/**
 * The sandbox layer's interface: what the actors call, and what `server/src/sandbox/` implements.
 *
 * Everything that knows about Docker, about E2B, about the sandbox image, and about how the `windlass`
 * binary is invoked lives behind this file. The actors know none of it.
 *
 * Sessions' sandboxes come from one provider per deployment (WLP_SANDBOX): local Docker containers, or
 * E2B microVMs (server/src/sandbox/e2b/), which every server machine of a deployment can reach. What a
 * provider owes the code that runs a turn is in server/src/sandbox/provider.ts.
 *
 * Names of Docker resources (all carry the label `dev.windlass-platform=1` so they can be listed and
 * removed together):
 *
 *   image      windlass-platform-sandbox:latest   built by sandbox/build.sh
 *   volume     wlp-user-<uid>                     Windlass's data directory in that user's sessions: its session
 *                                                 logs and memory, and while a turn runs the access token file of
 *                                                 that turn. No sign-in
 *   container  wlp-session-<sandboxId>            one per agent session; the workspace is /workspace
 *
 * On E2B a session's sandbox is a microVM made from the template `windlass-platform-sandbox`, which is
 * built from the same image. Its id is E2B's; its metadata (`wlp_deployment`, `wlp_uid`, `wlp_session`,
 * `wlp_profile`) is how a deployment's sandboxes are listed, counted and removed together. Windlass's
 * data directory is on the microVM's own disk there: no volume, and nothing shared between sessions.
 *
 * No sandbox holds a sign-in, and no provider stores one. A user's sign-in is kept, encrypted, in that
 * user's `user` actor, which is the one place that reads it and refreshes it (server/src/signin/), and
 * a turn is handed a short-lived access token (see `Windlass.runTurn`). `ChatgptLogins` and
 * `AccessTokens` below are the same for every provider: signin/facade.ts implements them. How much time
 * a token has left when it is handed over, when a turn's token is replaced and how long one is reused
 * are three durations that belong together: handoff.ts has them and says why.
 *
 * (A machine that ran the first version may still have volumes `wlp-auth-<uid>`, each a user's sign-in.
 * The Docker layer takes one into the user's actor the first time that user is touched, and removes it.)
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
 * sandbox needs, and a turn needs more of a sandbox than it offers (provider.ts), so this layer
 * drives Docker and E2B itself.)
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
	/**
	 * Whether Windlass's data directory, and with it Windlass's own sessions, is on the sandbox's own disk
	 * and goes when the sandbox does. False on Docker, where it is a volume of the user's that outlives
	 * every sandbox. True on E2B: a sandbox made in place of one that is gone has no Windlass session to
	 * continue, so a turn that names one (`RunTurnInput.windlassSessionId`) ends with `session_not_found`.
	 * Whoever replaces a lost sandbox can read this and start a new Windlass session at once.
	 */
	readonly sessionsLiveInSandbox: boolean;
	/** Every profile, available or not, in the order the picker shows them. */
	profiles(): SandboxProfile[];
	profile(id: SandboxProfileId): SandboxProfile;
	/**
	 * Creates and starts a sandbox with an empty git repository in its workspace. Returns its id.
	 * Throws SandboxUserError, with a sentence fit to show, when the profile is not available here, and on
	 * E2B when the deployment already runs as many sandboxes at once as it may (WLP_E2B_MAX_RUNNING):
	 * trying again later may work.
	 */
	create(input: CreateSandboxInput): Promise<string>;
	/**
	 * Starts the sandbox if it is paused. Undefined when it no longer exists. On E2B, starting a paused
	 * sandbox counts against the same limit as `create`, and throws the same SandboxUserError when the
	 * limit is reached; a sandbox that runs stops by itself a few minutes after the last `connect` unless
	 * a turn runs in it (e2b/sandboxes.ts, "The dead-man switch"), so `state` may say "paused" of a
	 * sandbox nobody suspended.
	 */
	connect(id: string): Promise<SandboxHandle | undefined>;
	/** "none" when it does not exist. */
	state(id: string): Promise<"none" | "running" | "paused">;
	/**
	 * Pauses it: nothing runs, files stay. A no-op when already paused or gone. A turn still running is
	 * cut off, and the access token file it was handed is removed: stop the turn first.
	 */
	suspend(id: string): Promise<void>;
	/**
	 * Removes it with its files. A no-op when already gone. On Docker the user's data volume stays, and an
	 * access token file a turn left in it for this sandbox is removed when the sandbox was running. On
	 * E2B Windlass's data directory goes with the sandbox.
	 */
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
	 * is needed, so the turn is handed no access token; tool calls in the script really run in the sandbox.
	 * Without it the turn runs on the ChatGPT sign-in of the sandbox's user (see `Windlass.runTurn`).
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
	 * Set when the turn could not be run or broke off, with a sentence about it. Reasons Windlass names,
	 * with its own sentence: `session_not_found` (the session to continue is gone), `session_in_use`
	 * (another process holds it), `execution_failed` (the turn failed; the events say how),
	 * `invalid_request`, `unknown_model`, `unknown_effort`, ... Reasons of this layer:
	 *
	 *   `auth_required`      the user has to sign in with ChatGPT (again): there is no sign-in (also when
	 *                        it was forgotten while the turn ran), it expired or was withdrawn (it could
	 *                        not be refreshed), or the provider rejected its access token. In a scripted
	 *                        turn it is the script's own `auth` failure, with Windlass's sentence.
	 *                        Otherwise the sentence is this layer's and fit to show
	 *   `token_unavailable`  the platform could not get the turn an access token, could not replace one
	 *                        before it expired, or Windlass could not read the file it was handed, for a
	 *                        reason that is not the user's sign-in (the sign-in service could not be
	 *                        reached, ...): sending the prompt again may work
	 *
	 * Which of these a failure of the sign-in is, the layer reads from the stable code Windlass gives
	 * it (`handed_in_expired`, `signed_out`, `network_error`, ...; handoff.ts, "Windlass's codes"), not
	 * from the words of a message. A failure whose code is not about the sign-in handed to the turn
	 * keeps Windlass's reason and sentence: a `network_error` stays the connection problem it is.
	 * Further reasons of this layer:
	 *
	 *   `windlass_outdated`  the image's Windlass cannot fetch a token as the platform asks for it: it has
	 *                        no `windlass login token`, or that command has no `--valid-for`. The sentence
	 *                        says which, and to rebuild the image from a newer one (`Windlass.problem()`
	 *                        says the same). Or only this sandbox is behind, made from an older image than
	 *                        the one in use: its Windlass reads no handed-in token, and the sentence says
	 *                        to start a new agent
	 *   `engine`             the process could not be started or died
	 *
	 * Null otherwise, and null when `aborted` is true.
	 */
	failure: { reason: string; message: string } | null;
}

/** `{ "responses": [[item, ...], ...] }`: one list per model call. */
export interface ScriptedModel {
	responses: Array<Array<Record<string, unknown>>>;
}

export interface Windlass {
	/**
	 * The binary's version in the image, e.g. "0.1.1+0f5192c3ea"; null when the image is missing. On E2B
	 * it is the version in the template, which is known once a sandbox was made from it (or from
	 * WLP_E2B_WINDLASS_VERSION): null until then, since asking would mean starting a sandbox.
	 */
	version(): Promise<string | null>;
	/**
	 * What keeps this layer from running turns on a ChatGPT sign-in, in a sentence that says what to do
	 * about it: the image is missing, or its Windlass is too old to hand a session an access token. The
	 * platform needs `windlass login token --valid-for`: a Windlass without `login token` is too old,
	 * and so is one that has the command but not its `--valid-for` option; the sentence says which.
	 * Null when nothing does. Demo turns need neither a sign-in nor that command. The server prints it
	 * when it starts; a turn that fails for it has `windlass_outdated`.
	 */
	problem(): Promise<string | null>;
	/** The models `--model` accepts, the default first. Falls back to a built-in list. */
	models(): Promise<string[]>;
	/**
	 * Runs one prompt to its end with the profile's approval mode. It speaks the Agent Client Protocol
	 * to a `windlass acp` process that lives for this one turn (see fixtures/acp-probe/), so the turn
	 * can ask questions and be steered; aborting `signal` cancels the turn through the protocol first.
	 *
	 * A turn without `script` runs on the ChatGPT sign-in of the sandbox's user, which the sandbox never
	 * sees. Before Windlass starts, the user's current access token (`AccessTokens.current`: good for at
	 * least twenty minutes more) is written to a file in Windlass's data directory in the sandbox, as
	 * `{"accessToken": ..., "expiresAt": ...}`, readable by its owner only and moved into place whole;
	 * Windlass is started with WINDLASS_ACCESS_TOKEN_FILE naming it and reads it at every model call.
	 * While the turn runs, the file is replaced with a new token when the one in it has ten minutes
	 * left: `AccessTokens.current` is asked then, and since it hands out no token with less than twenty,
	 * its answer is another token whenever that moment comes. A replacement that fails is logged and
	 * tried again, and by itself never ends the turn. The file is removed when the turn ends. It is one
	 * file per sandbox, so per session: a user's sessions share the data volume, and each turn writes,
	 * replaces and removes only its own session's file.
	 *
	 * Where a command the agent runs can read the file (`SandboxProfile.commandsCanReadAccessToken`) and
	 * prints the token, it is taken out of what the engine sends before that becomes an event: no event
	 * and no `stderrTail` holds a token as it was handed in.
	 *
	 * When Windlass cannot use the token (it ran out, its file is gone, or the provider rejected it),
	 * Windlass ends the turn, and `failure` says what that means for the user: see `RunTurnResult.failure`.
	 */
	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult>;
	/**
	 * A scripted model for a demo turn: a short, varied scenario of real tool calls (write a file, run
	 * it, read it back, fix something) that suits the prompt's words where it can. `turn` starts at 1.
	 */
	demoScript(prompt: string, turn: number): ScriptedModel;
}

// ---------------------------------------------------------------------------------------------
// Sign in with ChatGPT, done by Windlass itself (`windlass login start|finish|status|token`)
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

/**
 * The sign-in steps, for the actors. None of them keeps anything in the sandbox layer or on the server
 * it runs on: an attempt is a sealed blob its `login` actor stores between `start` and `finish`, and a
 * user's sign-in lives in that user's `user` actor. So every step can be served by any server.
 *
 * A sealed attempt (`attempt` below) is what Windlass saved of the sign-in so far, encrypted with a
 * key that is derived from the server's secret and bound to the attempt's id (signin/seal.ts): it is
 * of no use for another attempt, and unreadable to whoever stores it.
 */
export interface ChatgptLogins {
	/** Begins a sign-in and returns the address to open, and the pending attempt, sealed, to hand to `finish`. */
	start(attemptId: string): Promise<{ url: string; redirectPrefix: string; attempt: string }>;
	/**
	 * Finishes the attempt from the pasted address and returns the account that signed in, and the
	 * finished attempt, sealed, to hand to `adopt`. Throws SandboxUserError when the address is not the
	 * one expected, the attempt is unknown (the blob is not this attempt's) or OpenAI refuses the
	 * exchange. An attempt that is finished already is finished again by the address that finished it,
	 * without a second exchange, and by no other.
	 */
	finish(attemptId: string, attempt: string, pastedUrl: string): Promise<{ account: ChatgptAccount; attempt: string }>;
	/**
	 * Hands the finished attempt's sign-in to the user's actor, sealed for that user, where it replaces
	 * an earlier one. The provider's place for the user's sessions is made too (`ensureUserVolume`).
	 * Tokens of the earlier sign-in are not handed out again. Throws SandboxUserError when the attempt
	 * is not finished.
	 */
	adopt(attemptId: string, attempt: string, uid: string): Promise<void>;
	/** The sign-in the user's actor holds: who signed in and when the saved access token expires. Null when there is none. */
	status(uid: string): Promise<ChatgptAccount | null>;
	/**
	 * Forgets the user's sign-in: it is removed from the user's actor, no token of it is handed out
	 * again, and the provider removes the token files of turns still running. An access token already
	 * read stays valid until it expires, within the hour.
	 */
	logout(uid: string): Promise<void>;
	/**
	 * Makes sure the provider's place for Windlass's own data of the user's sessions exists (on Docker:
	 * the volume wlp-user-<uid>). It never holds a sign-in, and it is all a demo user has.
	 */
	ensureUserVolume(uid: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Access tokens: the one place that reads a sign-in and refreshes it
// ---------------------------------------------------------------------------------------------

/** A ChatGPT access token: good for about an hour, and of no use for getting another. */
export interface AccessToken {
	/** A secret: never logged, never part of an error message or an event. */
	accessToken: string;
	/** When it expires, ms since the epoch. */
	expiresAt: number;
}

export interface AccessTokens {
	/**
	 * The user's current access token, good for at least twenty minutes more. It is what
	 * `windlass login token --json --valid-for 20m` prints where the sign-in is saved: the saved token
	 * when that has twenty minutes left, and otherwise a new one, for which the sign-in is refreshed
	 * first (only that needs the network, and it rotates the sign-in's refresh token). One request per
	 * user runs at a time, and an answer is reused for as long as asking again would give the same token:
	 * while it has more than twenty minutes left, which for a new token is forty minutes, or until the
	 * sign-in changes (`adopt`, `logout`). So a user's sessions that start within those forty minutes
	 * share one token, and one user's sign-in is refreshed at most every forty minutes.
	 *
	 * Twenty minutes is what is asked for, not a promise of the service's: should it issue tokens that
	 * last less, the token is returned as it is, with its real `expiresAt`, and reused until half of
	 * what it had left is gone. That is logged once per user and is never an error.
	 *
	 * Throws SandboxUserError, with a sentence that tells the user to sign in with ChatGPT, when the user
	 * has no sign-in or OpenAI no longer accepts it; any other error means the token could not be had
	 * this time (no network, the Windlass that fetches tokens is too old: it has no `windlass login
	 * token --valid-for`, ...). No error message contains a token.
	 *
	 * It is a call to the user's `user` actor, from whichever server asks: the actor is where "one
	 * request per user at a time" and the reuse hold for every server at once, and it saves a refreshed
	 * sign-in before it answers. The token travels back encrypted for the request that asked.
	 */
	current(uid: string): Promise<AccessToken>;
}

/** What `server/src/sandbox/index.ts` exports as `createSandboxLayer()`. */
export interface SandboxLayer {
	sandboxes: Sandboxes;
	windlass: Windlass;
	logins: ChatgptLogins;
	tokens: AccessTokens;
}
