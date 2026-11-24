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
 *   volume     wlp-session-data-<uid>-<sandboxId>  the same for one docker-hardened sandbox, its own, labelled
 *                                                 with the user and `dev.windlass-platform.sandbox=<sandboxId>`
 *   container  wlp-session-<sandboxId>            one per agent session; the workspace is /workspace
 *
 * On E2B a session's sandbox is a microVM made from the template `windlass-platform-sandbox`, which is
 * built from the same image. Its id is E2B's; its metadata (`wlp_deployment`, `wlp_uid`, `wlp_session`,
 * `wlp_profile`) is how a deployment's sandboxes are listed, counted and removed together. Windlass's
 * data directory is on the microVM's own disk there: no volume, and nothing shared between sessions.
 *
 * The runner's optional Claude login volume is local to its machine. A user's ChatGPT sign-in is kept, encrypted, in that
 * user's `user` actor, which is the one place that reads it and refreshes it (server/src/signin/), and
 * a turn is handed a short-lived access token (see `Windlass.runTurn`). `ChatgptLogins` and
 * `AccessTokens` below are the same for every provider: signin/facade.ts implements them. How much time
 * a token has left when it is handed over, when a turn's token is replaced and how long one is reused
 * are three durations that belong together: handoff.ts has them and says why.
 */

import type { SnapshotSelection, SnapshotSource } from "./snapshot-key.js";

import type { AcpContext, AcpUpdate, EgressMode, HostedSize, HostedSizeOption, SessionMode, ModelList, RepositoryCheck, SandboxProfile, SandboxProfileId, TurnUsage, WindlassEvent } from "../contract.js";
import type { Redactor } from "../repo-secrets.js";
import type { HarnessId } from "./harness.js";
import type { ProjectChecks } from "../windlass-config.js";

// ---------------------------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------------------------

export interface ExecOptions {
	/** Run as the unprivileged transport user, outside the workspace. */
	gitUser?: true;
	/** Defaults to the sandbox's workspace. */
	cwd?: string;
	env?: Record<string, string>;
	/**
	 * More of the command's environment, whose values are secrets: they reach the command as `env` does
	 * and are on no command line on the way, neither on the server nor in the sandbox. On Docker, where
	 * `env` is written into the arguments of `docker exec`, these are only named there and taken from
	 * the client's own environment; on E2B both go in the request that starts the command.
	 */
	secretEnv?: Record<string, string>;
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
/** A runner's own measure of making a sandbox, in milliseconds (protocol.ts `connect`). */
export interface RunnerStartTimes {
	spare?: true;
	/** Checking the images, and pulling one when `pulled`. */
	image: number;
	pulled?: true;
	/** Creating and starting the container, the workspace and the probes. */
	create: number;
}

/**
 * The points of a turn's start a harness tells (`RunTurnInput.onStartMark`), in order: the agent's
 * process is about to start, it answered `initialize`, the prompt went, its first output came. `relay`
 * comes before `process`, with how long the turn's model relay lease took to open.
 */
export type StartMark = "relay" | "process" | "initialized" | "prompted" | "output";

/** The runner knows which policy refused a request. The session adds the machine name and available action. */
export type ProxyBlockedHost = Pick<import("../contract.js").BlockedHost, "host" | "port" | "firstAt" | "lastAt" | "count"> & {
	reason: Exclude<import("../contract.js").BlockedHost["reason"], "unlisted">;
};

export interface SandboxHandle {
	readonly id: string;
	/** The workspace directory inside the sandbox: "/workspace". */
	readonly cwd: string;
	/** On a personal machine, the connected runner's permission to use its browser. */
	readonly runnerScreenshots?: boolean;
	readonly snapshot?: SnapshotSource;
	/**
	 * The image the sandbox was made from, as its place names it: the Docker image id, E2B's template build, a
	 * runner's image id to a server that named `environment-image`. What a prepared environment records. Absent where the place does not say.
	 */
	readonly image?: string;
	readonly profile: SandboxProfileId;
	/**
	 * Docker: this sandbox's Windlass data directory is a volume of its own (SESSION_VOLUME_PROFILES),
	 * which goes with it, as its container mounts it. Absent where the data is the user's shared volume,
	 * on E2B (`Sandboxes.sessionsLiveInSandbox` says that), and from a runner that does not say.
	 */
	readonly ownData?: boolean;
	/**
	 * What the provider had to do to this sandbox on this connect, for the turn's timeline (E2B: it did not
	 * answer and was started again from its disk). Absent when nothing out of the way happened.
	 */
	readonly notice?: string;
	/**
	 * With `notice`: the sandbox had stopped answering and its memory was used up when it did, as the
	 * provider's metrics or the guest's own counters said (E2B). What a work item asks its person about.
	 */
	readonly outOfMemory?: OutOfMemory;
	/**
	 * The sandbox's own OOM kill count and memory limit in MiB, read at turn start and end. E2B reads the
	 * guest's /proc/vmstat; a machine runner reads its session container's cgroup. Null when unavailable.
	 */
	memoryEvents?(): Promise<{ oomKills: number; totalMiB: number } | null>;
	/** The most memory the provider sampled the sandbox using since `sinceMs`, when it came near its total (E2B's metrics). */
	memoryPeak?(sinceMs: number): Promise<OutOfMemory | null>;
	/**
	 * What a runner said of making this sandbox, on the first connect after its create, to a server that
	 * named `start-times` (StartTimes.image, pulled, runnerCreate). Absent elsewhere.
	 */
	readonly runnerStart?: RunnerStartTimes;
	/** Recipe this workspace was prepared for, until the session records its clone. */
	readonly readyKey?: string;
	readonly readySetup?: import("../runner/spare-recipe.js").SpareSetup;
	run(command: string, options?: ExecOptions): Promise<ExecResult>;
	readTextFile(path: string): Promise<string>;
	writeTextFile(path: string, content: string): Promise<void>;
	/**
	 * The hosts commands in the sandbox looked up and could not reach since it was made, each once, in
	 * the order first asked: on E2B out of `open`, what its lookup stub wrote (e2b/network.ts, `DNS_STUB`),
	 * without the hosts it may reach and those `skip` names (the ones the caller has seen already), so
	 * that many it has seen do not use up the limit and hide one it has not. Absent where nothing records them.
	 */
	blockedHosts?(skip?: Iterable<string>): Promise<string[]>;
	/** A restricted runner proxy. The first read opens the turn, subsequent reads repeat its cumulative counts. */
	blockedNetwork?(turn: number, retained: Pick<ProxyBlockedHost, "host" | "port">[]): Promise<{ broker: string; hosts: ProxyBlockedHost[]; overflow: number }>;
	/**
	 * Docker only: install the mirror a clone staged at `/tmp/wlp-transport-<stage>.mirror` in this
	 * sandbox's slot, from a helper container outside the sandbox, and remove the stage. True when the
	 * slot holds it. `partial` only seeds an empty slot.
	 */
	saveMirror?(stage: string, partial: boolean): Promise<boolean>;
}

/** What a connect is told besides the sandbox's id. */
export interface ConnectOptions {
	/**
	 * The hosts the session's repositories allow besides the deployment's (repository-network.ts): on E2B
	 * with WLP_E2B_NETWORK=restricted, the sandbox's network is set to both at every connect. Ignored elsewhere.
	 */
	network?: readonly string[];
	/** Docker: whether a hardened sandbox's Windlass data is its own (a runner's `session-volumes`); see DockerSandboxes.connect. */
	ownData?: boolean;
}

export interface CreateSandboxInput {
	/** Evaluated only for a machine advertising ready sandboxes. */
	spareRecipe?: (ready: number) => Promise<import("../runner/spare-recipe.js").SpareRecipe | undefined>;
	/** As `ConnectOptions.network`, from the first command in the sandbox. */
	network?: readonly string[];
	/** Machine slot units requested by an approved subtask. Omitted for a standard sandbox. */
	size?: number;
	/** Hosted only, where the layer offers sizes (`Sandboxes.sizes`): the sandbox's size. Left out: the smallest. */
	hostedSize?: HostedSize;
	fromSnapshot?: SnapshotSelection;
	/** Immutable GitHub repository ID for a transport-owned Docker mirror. */
	mirrorRepo?: string;
	/** Machine-only. The default harness uses the ordinary Windlass image. */
	harness?: Exclude<HarnessId, "windlass">;
	/** An item's reviewer keeps Windlass data inside its own sandbox, including approval records. */
	privateData?: boolean;
	/** Request the browser image when creating this work item sandbox. */
	screenshots?: boolean;
	uid: string;
	sessionId: string;
	profile: SandboxProfileId;
}

/** A sandbox that ran out of memory: how much it used of how much, in MiB, and its size. */
export interface OutOfMemory {
	usedMiB: number;
	totalMiB: number;
	size?: HostedSize;
	/** The next size the deployment offers, set by the session: what a work item offers to go on in. */
	larger?: HostedSize;
}

/** A sandbox as its provider lists it for a user. */
export interface ListedSandbox {
	id: string;
	/** The session it was made for, as `CreateSandboxInput.sessionId` named it. */
	sessionId: string;
	state: "running" | "paused";
}

/** What a second of a running sandbox costs, by an estimate. */
export interface SandboxPrice {
	/** US dollars per second. */
	usdPerSecond: number;
	/** What the price is of, for a sentence: "1 vCPU and 1,024 MiB of memory at E2B's published prices". */
	basis: string;
}

export interface Sandboxes {
	/**
	 * How long a sandbox goes on running by itself after it was last connected to, while no turn and no
	 * long command runs in it, before the provider stops it: on E2B the sandbox's own idle timeout.
	 * Null where a sandbox runs until it is suspended (Docker). The usage meter reads it to know until
	 * when a sandbox it finds stopped can have run (usage.ts, `stoppedBy`).
	 */
	readonly idleStopMs: number | null;
	/**
	 * What a second of a running sandbox is estimated to cost at the provider, for the usage page. Null
	 * where running one is not billed by the second (Docker).
	 */
	price(): SandboxPrice | null;
	/**
	 * The sizes a sandbox can be made in, smallest first, each with its estimated price. Absent where
	 * every sandbox has one size (Docker, machines: a machine's slot is its runner's, `--slot-memory`).
	 */
	sizes?(): HostedSizeOption[];
	/**
	 * The user's sandboxes as the provider has them now, running and paused, whichever server made
	 * them: what the count of the sandboxes a user keeps is held against (usage.ts, `reconcile`).
	 */
	list(uid: string): Promise<ListedSandbox[]>;
	/**
	 * The users that have sandboxes of this deployment at the provider: whose actors the server asks, every 30
	 * minutes, to remove the ones whose session is gone (user.ts `reconcileKept`). Hosted layers only.
	 */
	owners?(): Promise<string[]>;
	/**
	 * Whether Windlass's data directory, and with it Windlass's own sessions, is on the sandbox's own disk
	 * and goes when the sandbox does. False on Docker, where it is a volume of the user's that outlives
	 * every sandbox. True on E2B: a sandbox made in place of one that is gone has no Windlass session to
	 * continue, so a turn that names one (`RunTurnInput.windlassSessionId`) ends with `session_not_found`.
	 * Whoever replaces a lost sandbox can read this and, before the turn, put the session's copy back
	 * (`SandboxLayer.backups`) or, where there is none, start a new Windlass session at once.
	 */
	readonly sessionsLiveInSandbox: boolean;
	/**
	 * Where the sessions do not live in the sandbox: whether a sandbox made now with `profile` would have a
	 * data directory of its own, which goes with it as on E2B (Docker's hardened profile, whose commands
	 * could otherwise read the user's other sessions). A guess, for words said before there is a sandbox:
	 * what a sandbox that exists has is what its handle said (`SandboxHandle.ownData`). Absent: never.
	 * Never throws.
	 */
	privateSessionData?(profile: SandboxProfileId): Promise<boolean>;
	/**
	 * Docker: removes the sandboxes' own data volumes whose container is gone, which a create cut off
	 * between the volume and `docker run`, or a removal cut off after the container, leaves. One younger
	 * than `minAgeMs` (10 minutes) may belong to a create still under way and stays. Returns how many went.
	 */
	sweepDataVolumes?(minAgeMs?: number): Promise<number>;
	/**
	 * Windlass's model relay of a provider that runs one itself (hosted Docker, docs/model-relay.md), when
	 * the server starts: whether its sandboxes use it (the image's Windlass is 0.6.0 or later), and the
	 * forwarders and token files a server that died left removed. Returns the line the server logs.
	 */
	prepareModelRelay?(): Promise<string>;
	/**
	 * What this provider's sandboxes may reach, where the deployment sets it: on E2B, WLP_E2B_NETWORK
	 * (e2b/network.ts). Absent where the provider has no such setting (Docker).
	 */
	egress?(): EgressMode;
	/**
	 * The hosts every sandbox of this provider may reach by the deployment's own settings: on E2B the
	 * model API, the git host, the bucket and WLP_E2B_NETWORK_ALLOW (e2b/network.ts), empty in `open`.
	 * Absent where the provider has no list of hosts (Docker).
	 */
	allowedHosts?(): readonly string[];
	/**
	 * Lets a running sandbox reach `hosts` besides the deployment's (a session's repository's network
	 * list, repository-network.ts), at once. Only for a sandbox a turn of this server holds (`holdFor`):
	 * the change never starts a sandbox or pushes its timeout out, so it costs nothing a meter does not
	 * count. False otherwise: the hosts are handed to its next `connect` instead. Absent where the
	 * provider has no list of hosts.
	 */
	setNetwork?(id: string, hosts: readonly string[]): Promise<boolean>;
	/** Every profile, available or not, in the order the picker shows them. */
	profiles(): SandboxProfile[];
	profile(id: SandboxProfileId): SandboxProfile;
	/**
	 * Creates and starts a sandbox with an empty git repository or a matching post-setup snapshot in its workspace. Returns its id.
	 * Throws SandboxUserError, with a sentence fit to show, when the profile is not available here, and on
	 * E2B when the deployment already runs as many sandboxes at once as it may (WLP_E2B_MAX_RUNNING):
	 * trying again later may work.
	 */
	create(input: CreateSandboxInput): Promise<string>;
	hasSnapshot?(uid: string, repo: string): Promise<boolean>;
	saveSnapshot?(id: string, source: SnapshotSource): Promise<boolean>;
	dropSnapshots?(uid: string, repo?: string): Promise<void>;
	sweepSnapshots?(retained: (uid: string) => Promise<ReadonlySet<string> | null>): Promise<void>;
	/**
	 * Starts the sandbox if it is paused. Undefined when it no longer exists. On E2B, starting a paused
	 * sandbox counts against the same limit as `create`, and throws the same SandboxUserError when the
	 * limit is reached; a sandbox that runs stops by itself a few minutes after the last `connect` unless
	 * a turn runs in it (e2b/sandboxes.ts, "The dead-man switch"), so `state` may say "paused" of a
	 * sandbox nobody suspended.
	 */
	connect(id: string, options?: ConnectOptions): Promise<SandboxHandle | undefined>;
	/** "none" when it does not exist. */
	state(id: string): Promise<"none" | "running" | "paused">;
	/**
	 * Pauses it: nothing runs, files stay. A no-op when already paused or gone. A turn still running is
	 * cut off, and the access token file it was handed is removed: stop the turn first.
	 */
	suspend(id: string): Promise<void>;
	/**
	 * Removes it with its files. A no-op when already gone. On Docker the user's data volume stays, and an
	 * access token file a turn left in it for this sandbox is removed when the sandbox was running; a data
	 * volume of the sandbox's own goes, even where its container was already gone. On E2B Windlass's data
	 * directory goes with the sandbox.
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

/**
 * An MCP server the project's own configuration names (`.windlass/config.json` in the workspace), which
 * Windlass does not start until the user approves exactly this definition of it: opening a repository
 * must not run a command the repository chose (Windlass's docs/mcp.md, "A server in the project's file").
 */
export interface TurnServerQuestion {
	/** The server's name in the configuration. */
	name: string;
	/** Windlass's mark for exactly this definition: an approval is for it, and a changed definition has another. */
	fingerprint: string;
	/** What approving starts: the command and each of its arguments, one string each. Null for a server reached at an address. */
	argv: string[] | null;
	/** The address of a server that is reached and not started. Null for a command. */
	url: string | null;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	/**
	 * The variables its definition reads (`${NAME}` in `env` or `headers`) that are not set where Windlass
	 * runs: with any, Windlass does not start the server, approved or not. Empty when it reads none, when
	 * all are set, and when the definition could not be read to tell.
	 */
	unset: string[];
	/**
	 * Of the variables its definition reads, those the turn was handed as secrets (`RunTurnInput.secrets`):
	 * approving gives the server their values, or sends them to its address. Absent or empty when it reads none.
	 */
	secrets?: string[];
	/**
	 * True when the question is put before the turn's prompt goes to Windlass: the turn waits for the
	 * answer and then starts with what was allowed. False for a server Windlass reports while the turn
	 * is already running: the turn goes on meanwhile, and the question is withdrawn when it ends.
	 */
	holdsTurn: boolean;
}

/**
 * A server of the session, as Windlass describes it at one moment of a turn (`_windlass/mcp`,
 * `_windlass/mcp_changed`): one the project's configuration names, or one of the user's own that the
 * turn was handed (`RunTurnInput.servers`). A server a file leaves out (`enabled: false`) is not
 * among them, and neither is anything else that only the configuration file of the sandbox's user
 * defines: the platform's own server, or one something in the sandbox wrote there.
 */
export interface TurnServer {
	name: string;
	/** "user": one of the user's own, which the turn was handed. "project": the project's configuration names it, or changes it. */
	origin: "project" | "user";
	/**
	 * "waiting": not started, it waits for the user's approval. "starting", "running", "failed": what
	 * became of one that may start. "stopped": anything else Windlass says of it.
	 */
	state: "running" | "starting" | "waiting" | "failed" | "stopped";
	/** The command and each of its arguments; null for a server reached at an address. */
	argv: string[] | null;
	/** The address of a server that is reached and not started; null for a command. */
	url: string | null;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	/** How many tools it offers, once it runs. */
	tools: number | null;
	/** Why it could not start, in Windlass's words. */
	error: string | null;
	/** Windlass's mark for the definition, which it gives only while the server waits; null otherwise. */
	fingerprint: string | null;
}

/** What became of a server the user said to start. */
export type TurnServerOutcome =
	/** It runs, with this many tools. */
	| { state: "running"; tools: number }
	/** Windlass took the approval and the server had not finished starting when the layer stopped waiting for it. */
	| { state: "starting" }
	/** Windlass took the approval and could not start the server; `reason` is Windlass's own sentence. It tries again by itself. */
	| { state: "failed"; reason: string }
	/** Nothing was approved: the definition had changed since the question. Windlass asks about the new one. */
	| { state: "changed" }
	/** The approval did not reach Windlass, or it refused the request; `reason` says why. */
	| { state: "refused"; reason: string };

/** An MCP server of the session's user, as a turn is handed it: see `RunTurnInput.servers`. */
export interface TurnPersonalServer {
	/** Its key in Windlass's configuration. */
	name: string;
	/** Its definition, as Windlass's configuration takes one (personal-servers.ts, `cleanServerDefinition`). */
	definition: Record<string, unknown>;
	/** Its tools run without asking (`PersonalServer.unasked`): the layer answers Windlass's question about a call of one itself, see `RunTurnInput.onUnasked`. */
	unasked?: boolean;
}

/** A call of a tool of one of the user's own servers that the layer let run without asking: see `RunTurnInput.onUnasked`. */
export interface TurnUnaskedCall {
	/** The call, as `tool.called` and `approval.requested` name it. */
	messageId: string;
	callId: string;
	/** The server, by its name in `RunTurnInput.servers`, and the tool as that server names it. */
	server: string;
	tool: string;
}

/** What a turn is handed of its repository's secrets: see `RunTurnInput.secrets`. */
export interface TurnSecrets {
	env: Record<string, string>;
	/** Names in `env` that no command the agent runs is to be given (Windlass's `withholdEnv`). */
	withholdEnv: string[];
	/** Names in `env` that look like credentials and that sandboxed commands are to be given all the same (Windlass's `passEnv`). */
	passEnv: string[];
	redactor: Redactor;
}

/**
 * A call of one of the platform's own tools (agent-publish.ts) that the layer declared for this turn,
 * as Windlass's engine sent it to the platform (`_windlass/host_call`).
 */
export interface TurnPublishRequest {
	/** The call, as the turn's events name it (`tool.called`): Windlass's `toolCallId` is `<messageId>/<callId>`. */
	messageId: string;
	callId: string;
	/**
	 * The tool's arguments as the model wrote them, checked by Windlass against the declaration's schema,
	 * which asks for little: of any length, and to be trusted with nothing. The turn's saved secrets
	 * were taken out of the request they came in.
	 */
	arguments: Record<string, unknown>;
	/**
	 * "mcp": the call came over the platform's MCP server (platform-tools.ts), whose endpoint is inside the
	 * container, so any process there may have made it, not only the agent. Absent: a Windlass host call.
	 */
	via?: "mcp";
}

/** A handle on a turn in progress. Its methods reject once the turn has ended. */
export interface TurnControl {
	/** Sends a message into the running turn; the model reads it at its next step. Resolves once Windlass admitted it. */
	steer(text: string): Promise<void>;
	/** Stops one running tool call; the turn goes on. `stopped: false` with Windlass's reason when it could not be asked to stop. */
	cancelCall(messageId: string, callId: string): Promise<{ stopped: boolean; message: string | null }>;
}

/**
 * What a running turn needs to take up its process again on a server that restarted while a machine's
 * runner kept the process running (runner/journal.ts). Plain JSON, stored with the timeline: it holds
 * no secret, only what the timeline and the turn's own protocol state already have. `harness` says
 * whose `state` it is: a harness takes up only its own.
 */
export interface TurnCheckpoint {
	harness: string;
	/** The runner's id of the process (`SandboxProcess.runnerProcess`) and its wlp-run tag. */
	process: string;
	tag: string;
	state: Record<string, unknown>;
}

export interface RunTurnInput {
	/**
	 * Told once the turn can say what it would need to be taken up again (`TurnCheckpoint`): `read`
	 * answers that now, synchronously, or null when it cannot be taken up from here (not prompted yet,
	 * stopping, or a provider that cannot keep a process across a restart). A harness that cannot take
	 * up a process never calls it.
	 */
	onCheckpoint?: (read: () => TurnCheckpoint | null) => void;
	/** Take up the process this checkpoint names instead of starting one: the turn goes on where it was. */
	reattach?: TurnCheckpoint;
	/** When the platform stops the turn, ms since the epoch: Windlass's shell calls may not ask for a timeout beyond it (windlass-config.ts `TURN_TIME_HOOK`). */
	endsAt?: number;
	/** Told at each point of the turn's start (StartMark); `ms` with `relay`. A listener's failure does not stop the turn. */
	onStartMark?: (mark: StartMark, ms?: number) => void;
	/** Selection captured when the prompt was accepted. Absent uses the harness or profile default. */
	mode?: string;
	/** The agent's own plan mode for this turn (`HarnessCapabilities.planMode`). */
	planMode?: boolean;
	/** Efforts already observed on other models in this session. */
	harnessModels?: ModelList | null;
	onEffortFallback?: (fallback: string | null) => void;
	/** The effective ACP mode and choices on open. fallbackFrom names a requested mode the agent no longer offers. */
	onAcpModes?: (mode: string, offered: SessionMode[], fallbackFrom?: string) => void;
	/** A note for the timeline from the platform's side of the ACP link, such as a refused permission request. */
	onAcpNote?: (text: string) => void;
	/**
	 * A work item's turn, which nobody watches: the requested `mode` must be offered (no fallback to the
	 * agent's current one), and a permission the agent still asks for is allowed once, as Windlass's
	 * approval "full" would run it, instead of rejected. Machine harnesses run only in the hardened container.
	 */
	unattended?: boolean;
	prompt: string;
	/**
	 * Where outside text in `prompt` came from, each source in the person's words (factory/untrusted.ts).
	 * Windlass 0.6.0 and later take them with the prompt (`_meta["windlass/untrusted"]`, joined and cut to
	 * 200 characters): the session is tainted before the turn's first step. A Windlass that does not list
	 * the marker gets the prompt as before, and `onUntrustedUnmarked` is told. Absent or empty: the prompt is
	 * the person's and the platform's own.
	 */
	untrusted?: string[];
	onUntrustedUnmarked?: () => void;
	/**
	 * A turn that resumes after a restart or a machine away (`windlassSessionId` set, `prompt` a short
	 * "carry on"): what goes instead when the agent's saved session cannot be continued after all (Windlass
	 * no longer has it, or an ACP adapter cannot load it), so that the agent is given the whole task. Its
	 * own outside sources go with it, as `untrusted` does with `prompt`. `RunTurnResult.resumed` is false then.
	 */
	fresh?: { prompt: string; untrusted?: string[] };
	/**
	 * The layer stops answering for `TurnPersonalServer.unasked` once the engine reports the session
	 * tainted (`taint.noticed`), also part way through the turn: from then on such a call's question goes
	 * to `onQuestion` like any other. For a turn nobody watches, where Windlass's asking again after taint
	 * is the only stop on a call that sends out what came in.
	 */
	unaskedUntilTainted?: boolean;
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
	 * The secrets of the session's repository for this turn (repo-secrets.ts). `env` is put into
	 * Windlass's own environment, by `ExecOptions.secretEnv`'s way: Windlass fills `${NAME}` in the
	 * definitions of the project's MCP servers from it, and passes it on to the commands it runs by
	 * scope. `withholdEnv` and `passEnv` name the exceptions for commands. `redactor` knows every saved
	 * value of the repository, also those Windlass is not handed (the setup command had them, and may
	 * have left them in a file): each is taken out of everything the turn hands back, which is every
	 * event, question, description of a server, `stderrTail` and `failure`. A value that streaming
	 * output splits over two pieces is held back until it is whole. Nothing of this is kept by the
	 * layer when the turn has ended.
	 */
	secrets?: TurnSecrets;
	/**
	 * The MCP servers of the session's user (personal-servers.ts), for this turn: the layer writes them
	 * into Windlass's own configuration file in the sandbox before the turn's Windlass opens its
	 * session, beside whatever that file holds, and takes them out again when the turn has ended
	 * (windlass-config.ts). Windlass starts a server of its user's own configuration without asking.
	 * A sandbox that has turns already gets the list as it is now: a server its user deleted since
	 * is gone from the file, also where an earlier turn was cut off before it could take its own out.
	 * `onServers` is told of them beside the project's, with what Windlass says of each. A name the
	 * platform keeps for its own server is left out. Where the file in the sandbox cannot be read as
	 * Windlass's configuration, nothing is written and the turn runs without them.
	 */
	servers?: TurnPersonalServer[];
	/**
	 * The checks the session's user saved for its repository (repository-checks.ts), for this turn.
	 * Windlass takes these as required checks each time the session opens. An agent whose capabilities say
	 * `checks: "platform"` has them run by the platform when its prompt ends (platform-checks.ts).
	 */
	checks?: RepositoryCheck[];
	/** A checks-only builder turn runs all saved platform checks, even on an unchanged tree. */
	forceChecks?: boolean;
	/**
	 * For `checks: "platform"`: what the platform's run of the checks came to, as the events Windlass records
	 * of its own gate (for `VerificationLog`), each with the timeline's note where there is one.
	 */
	onChecks?: (event: WindlassEvent, note?: import("./platform-checks.js").ChecksNote) => void;
	/**
	 * Called when the layer has answered Windlass's question about a tool call itself, with "once",
	 * because the call is of a tool of one of the user's own servers whose tools run without asking
	 * (`TurnPersonalServer.unasked`): `onQuestion` never sees that question. It comes after the
	 * call's `approval.requested` was handed to `onEvent` and before its `approval.answered`, so
	 * whoever keeps a record can say who allowed the call. The layer answers only what is all of
	 * this, each by a field of Windlass's own and none by the words of the question: a call of the
	 * session itself, not of a subagent; reported by the engine as an `mcp_call` of that server
	 * (`tool.called`); of a server this turn wrote into Windlass's configuration with the setting
	 * on, which the engine holds to be its user's own (`_windlass/mcp`: one a project's file names
	 * or changes is the project's); and a question about using that tool and nothing else
	 * (`approval.needs`). Every such call is answered by itself and nothing is remembered in
	 * Windlass, so content it does not trust arriving in the conversation changes nothing: Windlass
	 * asks again from then on, in every profile, and is answered again.
	 */
	onUnasked?: (call: TurnUnaskedCall) => void;
	/**
	 * Every event of the turn, in order: Windlass's own events exactly as `windlass --json` prints them,
	 * and after the last of them one `cli.summary`-shaped event the layer makes itself (`type`,
	 * `sessionId`, `executionId`, `outcome`, `steps`, `summaryCalls`, `requests`, `durationMs`, `usage`,
	 * `cachedShare`), adding up every execution of the turn (a message steered in at the very end
	 * starts a second one).
	 */
	onEvent?: (event: WindlassEvent) => void;
	/** A base ACP update with saved values redacted. */
	onAcpUpdate?: (update: AcpUpdate) => void;
	/**
	 * Called when a tool call needs the user's approval; the turn waits for the promise. Resolve with
	 * the chosen option. `signal` aborts when Windlass withdraws the question (the turn was stopped):
	 * whatever the promise does afterwards is ignored. A rejection declines the call. Without this
	 * callback nobody can answer: Windlass is told so, and a call that would ask is refused at once.
	 */
	onQuestion?: (question: TurnQuestion, signal: AbortSignal) => Promise<TurnAnswer>;
	/**
	 * Called for each server the project's configuration names that waits for the user's approval, one
	 * at a time. Resolve with true to have Windlass start it (`_windlass/mcp_approve`), with false to
	 * leave it stopped; a rejection leaves it stopped. `signal` aborts when the question is withdrawn
	 * (the turn was stopped, or ended): whatever the promise does afterwards is ignored.
	 *
	 * Windlass is asked what waits before the prompt is sent, as its own command line does, so that the
	 * turn starts with what the user allowed (`holdsTurn`), and tells of a server that comes to wait
	 * while the turn runs. Each definition is asked about once per turn. Windlass remembers an approval
	 * itself, in its data directory, for 30 days, and does not report a server it may start by that
	 * record as waiting; a server left stopped is asked about again by the next turn. Whoever is asked
	 * may answer from a record of their own without putting the question to anyone (the session does,
	 * server-approvals.ts). Without this callback nobody is asked and such a server stays stopped.
	 */
	onServerQuestion?: (question: TurnServerQuestion, signal: AbortSignal) => Promise<boolean>;
	/** Called after `onServerQuestion` resolved with true, once it is known what became of the server. */
	onServerApproved?: (question: TurnServerQuestion, outcome: TurnServerOutcome) => void;
	/**
	 * Called with the project's servers, and the user's own that the turn was handed (`servers`), each
	 * time Windlass says what they are: with its answer about what waits, before the prompt goes, and
	 * whenever one starts, fails or comes to wait while the turn runs. It is the whole list each time, and comes before the question about a server in it
	 * that waits. Nothing is said when the turn ends: a server lives with the turn's Windlass process.
	 */
	onServers?: (servers: TurnServer[]) => void;
	/** Called once, when the turn has started and can be steered. */
	onControl?: (control: TurnControl) => void;
	/**
	 * The platform's own tools (agent-publish.ts), each given for a turn whose agent is to have it. The
	 * layer declares each tool with a callback at session open. Each callback handles calls its turn's
	 * engine sends while the turn runs, and resolves with what the agent is to be told, in full: the
	 * layer makes it the call's result. The call waits for it, and with it the turn. `signal` aborts
	 * when the call ended before the answer (Windlass stopped it, or its time ran out) or the turn did:
	 * what the promise does afterwards is ignored, and a rejection tells the agent that the request
	 * could not be handled. Each tool is declared so that Windlass never asks about its calls, and
	 * `onQuestion` never sees them: what is done is the callback's to decide.
	 *
	 * `onPublish`: the agent asks the platform to publish the session's work; it may ask the user first.
	 */
	onPublish?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	/** A work item's agent files its report; returns what the agent is told. Not given with `onPublish`. */
	onPlan?: RunTurnInput["onReport"];
	/** With `onPlan`: a cross-repo feature's planning turn, whose `file_plan` takes the plan's repositories too. */
	crossRepoPlan?: boolean;
	planner?: boolean;
	/** Resume an item's conversation as a builder after it ran with the planner agent. */
	clearPlanner?: boolean;
	onReport?: (request: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;
	/** A work item's builder asks its person a question (`ask_person`); returns what the agent is told, at once. Given only with `onReport`. */
	onAsk?: (request: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;
	onReview?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	reportScreenshots?: boolean;
	/** The agent pushes the session's branch (`push`). Given with `onFetchBase`. */
	onPush?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	/** The agent has the session's base branch fetched into the workspace (`fetch_base`). Given with `onPush`. */
	onFetchBase?: (request: TurnPublishRequest, signal: AbortSignal) => Promise<string>;
	/**
	 * The most model steps the turn may take (`_meta["windlass/maxSteps"]` on its prompt); a turn at the limit ends. Left out: Windlass's own.
	 * For `steps: "platform"`, the most tool calls, counted by the platform (platform-steps.ts).
	 */
	maxSteps?: number;
	/**
	 * An ACP agent's turn ends when the agent sends nothing for this long while no call of its own is running and
	 * nobody is being asked (acp-harness.ts). Left out: `ACP_IDLE_MS`.
	 */
	idleMs?: number;
}

/** What a turn's Windlass had for checks when its session was opened, as far as the layer saw. */
export interface TurnChecks {
	/** What the repository's own configuration file said about checks then (windlass-config.ts, `projectChecks`); null when it is not there or says nothing. */
	project: ProjectChecks | null;
}

export interface RunTurnResult {
	acp?: {
		stopReason: string | null; usage: AcpContext | null; models: ModelList | null;
		/** The turn's tokens from the `session/prompt` answer; null where the agent reported none. */
		tokens?: TurnUsage | null;
		/** The Claude 5h window at the turn's first usage update; `usage.fiveHourUsedPct` is its last. */
		fiveHourAtStart?: number;
		/** The tool calls the agent started in the turn (platform-steps.ts). */
		steps?: number;
		/** Set when the platform stopped the turn at this many tool calls (`maxSteps`). */
		stepLimit?: number;
		/** How the platform's checks ended the turn (platform-checks.ts): "unresolved" when checks did not pass. */
		checks?: string | null;
	};
	/** Whether the ACP session could be continued when a previous id was supplied. */
	resumed?: boolean;
	/** The exit code of the Windlass process that served the turn: 0 after any orderly end, whatever the turn's outcome; null when it was killed. */
	exitCode: number | null;
	aborted: boolean;
	timedOut: boolean;
	/** The harness’s conversation id when one has been opened. */
	windlassSessionId: string | null;
	/** The summary event the layer made (see `onEvent`); null when the turn ended before Windlass reported how. */
	summary: WindlassEvent | null;
	/** The end of standard error, for an error message. */
	stderrTail: string;
	/**
	 * Set when the turn could not be run or broke off, with a sentence about it. Reasons Windlass names,
	 * with its own sentence: `session_not_found` (the session to continue is gone), `session_in_use`
	 * (another process holds it), `unreadable_session` (the session holds a record this Windlass does
	 * not read, as when a later one has worked in it), `execution_failed` (the turn failed; the events
	 * say how), `invalid_request`, `unknown_model`, `unknown_effort`, ... Reasons of this layer:
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
	 *   `host_tools_required` the sandbox's Windlass cannot provide the platform's tools
	 *   `harness_signed_out` the harness needs its machine login
	 *   `engine`             the process could not be started or died
	 *
	 * Null otherwise, and null when `aborted` is true.
	 */
	failure: { reason: string; message: string; resetsAt?: number; window?: import("../contract.js").UsageWindow } | null;
	/** What Windlass had for checks in this turn. Absent when the turn ended before its configuration was dealt with. */
	checks?: TurnChecks;
}

/** `{ "responses": [[item, ...], ...] }`: one list per model call. */
export interface ScriptedModel {
	responses: Array<Array<Record<string, unknown>>>;
}

export interface Windlass {
	/**
	 * The binary's version in the image, e.g. "0.4.0"; null when the image is missing. On E2B
	 * it is the version in the template, which is known once a sandbox was made from it (or from
	 * WLP_E2B_WINDLASS_VERSION): null until then, since asking would mean starting a sandbox.
	 */
	version(): Promise<string | null>;
	/**
	 * Why the configured Windlass cannot run, or null when it is ready.
	 */
	problem(): Promise<string | null>;
	/**
	 * Runs one prompt to its end with the selected approval mode. It speaks the Agent Client Protocol
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
	/** OpenAI's subject for the account within this OAuth app. */
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
 * The layer refused to start a sandbox because the deployment runs as many as it may at once
 * (`limit`, WLP_E2B_MAX_RUNNING). A sentence for a person like any `SandboxUserError`, and for the
 * factory a wait, not a failure: a work item's turn waits for a sandbox and is tried again
 * (factory/budget.ts `PlaceNow.deploymentFull`). Known by its class, never by its words.
 */
export class DeploymentFull extends SandboxUserError {
	constructor(
		readonly limit: number,
		message: string,
	) {
		super(message);
		this.name = "DeploymentFull";
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

// ---------------------------------------------------------------------------------------------
// A copy of Windlass's session data, kept outside the sandbox
// ---------------------------------------------------------------------------------------------

/** One agent session, as the copy of its Windlass data is named by. */
export interface BackupOwner {
	uid: string;
	sessionId: string;
}

/** What was saved: for the session's own record, and what a restore is checked against. */
export interface SavedBackup {
	/** The archive's size in bytes. */
	size: number;
	/** The archive's SHA-256, in hex. */
	sha256: string;
	/** When it was saved, ms since the epoch. */
	at: number;
}

export type BackupSaveResult =
	| { outcome: "saved"; backup: SavedBackup; ms: number }
	/** Windlass has no session in this sandbox yet: there is nothing to copy. */
	| { outcome: "empty" }
	/** The archive would be larger than `limit` bytes: nothing was saved, and an earlier copy is left as it is. */
	| { outcome: "too_large"; size: number; limit: number }
	/** `reason` is for a log: it holds no link and nothing the sandbox printed. An earlier copy may be left as it was or not. */
	| { outcome: "failed"; reason: string };

export type BackupRestoreResult =
	| { outcome: "restored"; ms: number }
	/** The store has no copy for this session. */
	| { outcome: "missing" }
	/** The copy could not be fetched, is not the one that was saved, or does not hold the Windlass session. `reason` is for a log. */
	| { outcome: "failed"; reason: string };

/**
 * Where Windlass's sessions live in the sandbox (`Sandboxes.sessionsLiveInSandbox`), a copy of them
 * can be kept outside it: one object per agent session in a bucket (server/src/bucket/), replaced
 * after every turn and put back into the sandbox that takes the place of a lost one, so that the
 * agent goes on in the same Windlass session there (sandbox/backup.ts says what is copied and how).
 *
 * The sandbox uploads and downloads by itself, through a link this layer signs for it: the bytes
 * never pass through the server. Both calls must be made while no turn runs in the sandbox: between
 * turns nothing has Windlass's files open, and only then is a copy of them whole.
 */
export interface SessionBackups {
	/** The largest archive that is kept, in bytes. */
	readonly maxBytes: number;
	/** Packs Windlass's session data in the sandbox and has the sandbox upload it, replacing the session's earlier copy. Never throws. */
	save(sandbox: SandboxHandle, owner: BackupOwner): Promise<BackupSaveResult>;
	/**
	 * Has a new sandbox download the session's copy and unpack it into Windlass's data directory, when
	 * it is the copy `saved` describes (its size and hash are checked in the sandbox before anything is
	 * unpacked) and holds `windlassSessionId`. Never throws.
	 */
	restore(sandbox: SandboxHandle, owner: BackupOwner, saved: SavedBackup, windlassSessionId: string): Promise<BackupRestoreResult>;
	/** Removes the session's copy. A no-op when there is none. Throws when the store could not be told. */
	remove(owner: BackupOwner): Promise<void>;
	/** The name of the session's object in the bucket, for a log. */
	keyOf(owner: BackupOwner): string;
}

/** What `server/src/sandbox/index.ts` exports as `createSandboxLayer()`. */
export interface SandboxLayer {
	/** Present only on the layer backed by this machine's runner. */
	machine?: { name: string };
	sandboxes: Sandboxes;
	windlass: Windlass;
	logins: ChatgptLogins;
	tokens: AccessTokens;
	/**
	 * Null or absent where there is nothing to copy (Docker: Windlass's data is on a volume that outlives
	 * every sandbox) or nowhere to copy it to (no bucket is configured): a session whose sandbox is lost
	 * then starts a new Windlass session.
	 */
	backups?: SessionBackups | null;
}
