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

/** Whose machine runs the sandbox. A session keeps its place for its whole life. */
export type SandboxPlace = { kind: "hosted" } | { kind: "machine"; machineId: string };

/** The kind of sandbox a session uses. Each place says which profiles it offers. */
export type SandboxProfileId =
	| "docker-windlass-sandbox"
	| "docker-hardened"
	| "e2b"
	| "e2b-open"
	| "daytona"
	| "firecracker"
	| "agentos";

export type EgressMode = "open" | "restricted" | "none";

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
	commandNetworkText?: string;
	/** Runner-confirmed credential isolation for Claude sessions using this profile. */
	claudeRelay?: true;
	/** Hosted ACP agents can reach the Settings-key relay from this profile. */
	platformKeys?: true;
	/**
	 * Whether commands the agent runs can read the turn's token file: the short-lived access token of the
	 * user's ChatGPT sign-in that each turn is handed, or with the model relay (`modelRelay`) only a
	 * placeholder for the turn, which still makes model requests through the relay while the turn runs. It
	 * lasts about an hour, and whoever reads it cannot renew it. The sign-in itself, which is what renews
	 * tokens, is never in a sandbox: no command can read it in any profile. Rules about what a command can do
	 * in the agent's name read this; whether the access token itself is readable is `accessTokenReadable`.
	 */
	commandsCanReadAccessToken: boolean;
	/**
	 * Whether commands can read the access token itself: false with the model relay, where the token file
	 * holds only a placeholder and the token never enters the sandbox. Absent: as `commandsCanReadAccessToken`.
	 */
	accessTokenReadable?: boolean;
	/**
	 * Windlass's turns in this sandbox send their model requests through the platform's model relay
	 * (docs/model-relay.md): the token file holds a placeholder for the turn, and the access token never
	 * enters the sandbox. Absent: the token file holds the access token itself.
	 */
	modelRelay?: true;
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
	/** The Windlass version inside the sandbox image, e.g. "0.4.0". */
	windlassVersion: string | null;
	profiles: SandboxProfile[];
	/**
	 * What this deployment's hosted sandboxes may reach (E2B, WLP_E2B_NETWORK), when it is not `open`:
	 * `restricted`, only the model API, GitHub and the hosts the operator allows; `none`, only the model
	 * API, and no repositories. Absent: as before network modes.
	 */
	hostedEgress?: "restricted" | "none";
	/**
	 * The hosted sandbox sizes this deployment offers (E2B, `WLP_E2B_SIZES`), smallest first. Absent where
	 * hosted sandboxes have one size (Docker): nothing of sizes is shown then.
	 */
	hostedSizes?: HostedSizeOption[];
	/**
	 * Set when this deployment has a GitHub App: users can connect GitHub, launch agents on their own
	 * repositories and open pull requests. Absent or null when it has none: the web app then shows
	 * nothing of it.
	 */
	github?: GithubInfo | null;
	/**
	 * Set when users of this deployment may run agents on machines of their own (WLP_MACHINES=1). Absent
	 * when not: the web app then shows nothing of it, and /machines is not found.
	 */
	machines?: MachinesInfo;
	/**
	 * Set when users of this deployment may file work items (WLP_ITEMS=1). Absent when not: the web app
	 * then shows nothing of them, and the item and API token actions are refused with `items_off`.
	 * `reviewer` says whether a second agent reviews each handed-over change (WLP_FACTORY_REVIEWER=on),
	 * so that the Factory page can say there is none before any item exists. `screenshots` false: the
	 * deployment turned screenshots off for every work item (WLP_FACTORY_SCREENSHOTS=off), whatever a
	 * repository's setting says.
	 */
	items?: { reviewer: boolean; orchestrate?: boolean; screenshots?: boolean };
	/** Set when the deployment takes payment for plans (WLP_BILLING_PROVIDER). Absent: no plans, the deployment's own limits, and nothing of billing shown. */
	billing?: { plans: PlanInfo[] };
}

/**
 * What the Machines page needs of the deployment. The install command it shows, with `runnerImage`
 * and `platformUrl` put in (the runner's state, its key among it, is in the `windlass-runner` volume):
 *
 *   docker run -d --name windlass-runner --restart unless-stopped \
 *     --log-driver json-file --log-opt max-size=16m --log-opt max-file=3 \
 *     -v /var/run/docker.sock:/var/run/docker.sock \
 *     -v windlass-runner:/var/lib/windlass-runner \
 *     <runnerImage> --platform <platformUrl> [--name "Build host"]
 *
 * For rootless Docker the socket to mount is `$XDG_RUNTIME_DIR/docker.sock`. To update, the same
 * command after `docker rm -f windlass-runner`: the volume keeps the key, so the machine stays paired across updates within a protocol. The first upgrade to signed connections requires a new pairing.
 * The runner prints its pairing code in `docker logs windlass-runner`.
 */
export interface MachinesInfo {
	platformFingerprint?: string;
	/**
	 * The oldest runner release this deployment serves in its current protocol mode. A machine whose runner is older is
	 * refused until it is updated (`MachineWarning` "outdated"); a newer one is served.
	 */
	minRunnerVersion: string;
	/** The runner image to install, pinned by digest; null while none is published, and the page says it cannot be installed yet. */
	runnerImage: string | null;
	/** Harnesses built into this exact published image, from its capabilities command. */
	runnerHarnesses?: Array<Exclude<HarnessId, "windlass">>;
	/** The platform's address as a runner on another machine reaches it: `--platform` in the install command. */
	platformUrl: string;
}

// ---------------------------------------------------------------------------------------------
// The models a user may choose (`UserActions.models`)
// ---------------------------------------------------------------------------------------------

/** One model, and the reasoning efforts it accepts: none for a model that takes no effort. */
export interface ModelChoice {
	id: string;
	/** What the provider calls it, where that is not its id. */
	name: string | null;
	efforts: string[];
}

/**
 * The models a user may start a session on or switch a turn to, and the efforts each accepts
 * (docs/architecture.md, "Models"). They are no fact of the deployment: they are what the user's ChatGPT plan
 * offers, as Windlass lists them with that user's sign-in, kept in the user's actor for about an hour.
 */
export interface ModelList {
	/**
	 * Whose list this is. "account": the user's plan's, as it was read at `fetchedAt`. Anything else is
	 * either the harness's own config options ("harness") or a fixed stand-in: "demo", the demo's scripted model
	 * answers under any of its names; "signed-out", there is no ChatGPT sign-in to list with;
	 * "unavailable", the plan's list could not be read and none is kept from before.
	 */
	source: "account" | "harness" | "demo" | "signed-out" | "unavailable";
	models: ModelChoice[];
	/** The model a session starts on where nothing else says: one of `models`. */
	defaultModel: string;
	/** When the plan's list was read, ms since the epoch; null for the stand-in. */
	fetchedAt: number | null;
}

/** What the web app needs to know of the deployment's GitHub App. */
export interface GithubInfo {
	/** The app's name on GitHub, as its address has it: `https://github.com/apps/<slug>`. */
	slug: string;
	/** Where GitHub is: "https://github.com". */
	url: string;
}

/** @deprecated The `platform` actor is gone: the information is served over HTTP (PLATFORM_INFO_PATH). */
export interface PlatformActions {
	info(): Promise<PlatformInfo>;
}

// ---------------------------------------------------------------------------------------------
// The browser's connection to the actors (HTTP, `GET PLATFORM_CONNECTION_PATH`)
// ---------------------------------------------------------------------------------------------

/** A token of the Rivet engine's for browsers: good for a while, and for reaching this deployment's actors only. */
export interface ConnectionToken {
	token: string;
	/** When the engine stops accepting it, ms since the epoch, by the engine's clock. */
	expiresAt: number;
	/**
	 * How long it is good for, counted from this answer. A browser's clock may be wrong by more than a
	 * token lasts, so the web app counts from when the answer arrived and never compares `expiresAt`
	 * with its own clock.
	 */
	validForMs: number;
}

/** What a browser needs to reach the actors. */
export interface PlatformConnection {
	/**
	 * The Rivet endpoint browsers connect to, or null when the server was not told one (development):
	 * the web app then uses the one it was built with, or DEFAULT_ENDPOINT.
	 */
	endpoint: string | null;
	/** The namespace the actors live in. */
	namespace: string;
	/** Null when the engine asks for no token: the local engine of a development server. */
	token: ConnectionToken | null;
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
	| "stopping"
	/**
	 * The turn is not over but nothing runs it: its server restarted, or its machine went away
	 * (`SessionSummary.paused` says which). It resumes by itself; a message sent meanwhile is held for it.
	 */
	| "paused";

/** How a turn ended. The first five are Windlass's own outcomes (`cli.summary.outcome`). */
export type TurnOutcome =
	| "succeeded"
	| "unresolved"
	| "failed"
	| "stopped"
	| "interrupted"
	/** The platform could not run the turn at all (sandbox failure, Windlass crashed). */
	| "error";

export type HarnessId = "windlass" | "claude" | "opencode" | "codex";

/** One of the platform's tools, by the name the agent calls it (server/src/platform-tools.ts, `PlatformTool`). */
export type PlatformToolName = "publish" | "report" | "request_secret" | "ask_person" | "push" | "fetch_base" | "file_review" | "file_plan" | "file_plan_review";

/**
 * What a session's agent can do, as the screens need it: a read-only part of its agent's capability record
 * (server/src/sandbox/harnesses.ts, `HarnessCapabilities`, each field as documented there). The screens decide
 * by these, never by the agent's name, so an agent added later needs no screen edited.
 */
export interface SessionCapabilities {
	/** Stopping one tool call of a running turn; without it, only the turn. */
	cancelCall: boolean;
	/** What its turns report of their use: token counts per model call ("tokens"), or how full the context is and each turn's tokens where it reports them ("context"). */
	usage: "tokens" | "context" | "none";
	/** Whether the user's saved checks run before a turn is called done: by the agent's engine ("required"), by the platform between the agent's prompts ("platform"), or not ("none": CI decides). */
	checks: "required" | "platform" | "none";
	/** Whether saved secrets are handed to the agent, with named variables withheld from commands or passed to them. */
	envLists: boolean;
	/** The platform's tools it can be given. Without "publish", the person publishes from the side panel. */
	platformTools: readonly PlatformToolName[];
	/** Screenshots with a builder's report. */
	reportScreenshots: boolean;
	/** Where the models a prompt may name come from: the account's plan, or the agent's own list (pickers drawn only where it offers a choice). */
	models: "account" | "harness";
	/** A plan mode of the agent's own, chosen per prompt (`PromptInput.planMode`). */
	planMode: boolean;
	/** Whether a project's own MCP servers wait for the person's approval in the side panel. */
	projectServerApproval: boolean;
}

export interface SessionMode {
	id: string;
	name: string;
	/** ACP agents may omit the description. */
	description: string | null;
}

/** A machine's prompt-free ACP options. Efforts are the choices available for each model. */
export interface HarnessOptions {
	models: ModelChoice[];
	defaultModel: string;
	modes: SessionMode[];
	checkedAt: number;
}

/** Launch choices for the pinned Claude adapter. Once opened, the session reports its actual list. */
export const CLAUDE_LAUNCH_MODES: readonly SessionMode[] = [
	{ id: "default", name: "Manual", description: "Ask before using tools." },
	{ id: "acceptEdits", name: "Accept edits", description: "Allow file edits." },
	{ id: "plan", name: "Plan", description: "Plan the work before editing." },
	{ id: "auto", name: "Auto", description: "Automatically assess tool permissions." },
	{ id: "bypassPermissions", name: "Bypass permissions", description: "Run tools without permission prompts." },
];

/**
 * How long each part of one turn's start took, in milliseconds, from the turn's start (after any wait for
 * a free slot on a machine) to the agent's first output (docs/architecture.md, "Start times"). A part that did not happen
 * in that turn is left out: `image` and `setup` only for a new sandbox, `relay` only where Windlass's model
 * relay is used, `runner*` only from a runner that reports them.
 */
export interface StartTimes {
	turn: number;
	/** When the turn started. */
	at: number;
	harness: HarnessId;
	place: "hosted" | "machine" | "e2b";
	/** A sandbox was made for this turn (false: an existing one was connected or resumed). */
	newSandbox: boolean;
	/** Waiting for a free slot on the machine, before the start. */
	waited?: number;
	/** The runner's image check, and pull when `pulled`. */
	image?: number;
	pulled?: boolean;
	/** Making and starting the container, or resuming it, as the server saw it (on a machine: with the runner's round trips and image check). */
	sandbox?: number;
	/** The part of `sandbox` the runner spent creating the container itself. */
	runnerCreate?: number;
	spare?: true;
	/** Cloning, the repository's setup command, a restored memory or prepared image. */
	setup?: number;
	/** The platform's own work between the sandbox being ready and the agent's process starting: leftover processes, the token file. */
	prepare?: number;
	/** Windlass's model relay for this turn: the relay container when it was not running, and the turn's forwarder. Part of `prepare`. */
	relay?: number;
	/** From starting the agent's process until it answered ACP `initialize`. */
	agent?: number;
	/** session/new or resume, and the mode and model choices, until the prompt was sent. */
	session?: number;
	/** From the prompt being sent to the agent's first output (text, thinking or a tool call). */
	firstOutput?: number;
	/** From the turn's start to the first output. */
	total?: number;
}

export interface SessionSummary {
	/** The mode selected for the next prompt. */
	mode: string;
	/** For Claude, the machine's reported choices until the session reports its own. Empty for item sessions. */
	availableModes: SessionMode[];
	harness?: HarnessId;
	/** What its agent can do (`SessionCapabilities`): the screens draw by these, not by `harness`. */
	capabilities: SessionCapabilities;
	harnessModels?: ModelList | null;
	id: string;
	title: string;
	place: SandboxPlace;
	profile: SandboxProfileId;
	/** Hosted, where the deployment offers sizes: the size of its sandboxes. */
	hostedSize?: HostedSize;
	model: string;
	/** A git repository cloned into the workspace when the sandbox was created, if any. */
	repoUrl: string | null;
	/**
	 * Set when the session was launched on a repository of the user's GitHub connection, picked in the
	 * launch form: what it was launched on. `repoUrl` is then that repository's address. Absent or null
	 * for a session with no repository or with a pasted address.
	 */
	repository?: SessionRepository | null;
	/** The pull request the platform opened for the session's work, once there is one. */
	pullRequest?: PullRequestInfo | null;
	/**
	 * For a session with `repository`: whether the agent may have the platform publish the session's
	 * work without the user being asked each time. False: every request of the agent's is put to the
	 * user as a question (`PendingQuestion.publish`). It is the session's own setting: chosen when it is
	 * launched, changed in its side panel (`setPublishUnasked`), and turned on by answering such a
	 * question with "Allow for this session". It can be on only in a profile where Windlass sandboxes
	 * every command the agent runs (`approval` "auto", and neither `commandNetwork` nor
	 * `commandsCanReadAccessToken`): elsewhere a command could ask in the agent's name, so every request
	 * is asked about, and the question does not offer "session".
	 */
	publishUnasked?: boolean;
	createdAt: number;
	/** Last prompt or turn end. */
	updatedAt: number;
	status: SessionStatus;
	/**
	 * With status "paused": why, since when, and how many messages are held for the resumed turn.
	 * `machine`: the machine went offline (or its runner restarted) mid-turn, and the turn resumes when it is back.
	 */
	paused?: { reason: "restart" | "machine"; since: number; held: number };
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** The last few turns' start times, oldest first (StartTimes). */
	startTimes?: StartTimes[];
	/** Whether the sandbox exists and whether it is running or paused. */
	sandbox: "none" | "running" | "paused";
	/**
	 * Set once Windlass has told the session of MCP servers: those its project's configuration names,
	 * and its user's own (`PersonalServer`). How many, and when what the session knows of them last
	 * changed (a server started, failed, came to wait, an approval was remembered or forgotten here). A
	 * client asks `servers()` again when `changedAt` moves. Absent for a session that has none.
	 */
	servers?: { count: number; changedAt: number };
	/**
	 * Set for the session of a work item: the item it works for (`ItemSummary`). Its prompts come from the item; a person may still read it.
	 * `signIn`: how its machine agent was signed in when the item was filed, where that decides how the item counts its tokens (Claude Code and Codex).
	 */
	item?: { id: string; role?: "builder" | "reviewer"; planCritic?: true; reviewer?: { id: string; status: SessionStatus }; signIn?: "api-key" | "chatgpt" | "subscription" };
	/** Set for a session that only builds a prepared environment (environments.ts): it is not listed, and is deleted when done. */
	environmentBuild?: true;
	/** Set when the session's sandbox started from a validated environment: the commit setup and the checks ran at, and when they passed. */
	environment?: { commit: string; validatedAt: number; checks: number };
}

/** The user index keeps one builder per item. Its reviewer is reachable from the item and counts toward its usage. */
export function listedSessions(sessions: SessionSummary[]): SessionSummary[] {
	const reviewers = new Map(sessions.flatMap(s => s.item?.role === "reviewer" && !s.item.planCritic ? [[s.item.id, { id: s.id, status: s.status }] as const] : []));
	return sessions.filter(s => s.item?.role !== "reviewer" && !s.environmentBuild).map(session => {
		const reviewer = session.item && reviewers.get(session.item.id);
		return session.item && reviewer ? { ...session, item: { ...session.item, reviewer } } : session;
	});
}

export interface CreateSessionInput {
	/** Machine sandbox size in slots. A personal session defaults to one. */
	size?: 1 | 2 | 4;
	/** Hosted only, where `PlatformInfo.hostedSizes` offers it: the sandbox's size. Left out: the repository's saved size, else small. */
	hostedSize?: HostedSize;
	/** Windlass defaults to the profile approval. Claude prefers auto when offered. */
	mode?: string;
	harness?: HarnessId;
	/** Defaults to "New agent"; replaced by the first prompt's opening words when left unset. */
	title?: string;
	/** Left out: run on the hosted layer. */
	place?: SandboxPlace;
	profile: SandboxProfileId;
	/** An account model or a model offered by the machine's harness. Omit to use its default. */
	model?: string;
	/** An https git address to clone into the workspace. */
	repoUrl?: string;
	/**
	 * A repository of the user's GitHub connection to launch on, by GitHub's id for it (`GithubRepository.id`),
	 * and the branch to start from (default: the repository's default branch). Not together with `repoUrl`.
	 */
	repository?: { id: GithubId; branch?: string };
	/**
	 * With `repository`: the setup command to save for that repository before the session is made
	 * (`RepositorySetup`), in place of what was saved; "" saves none. Left out, what is saved stays.
	 */
	setupCommand?: string;
	/** With `repository`: `SessionSummary.publishUnasked` to start with. Left out: the agent's requests to publish are asked about. Refused (`bad_input`) for a profile it cannot be on in. */
	publishUnasked?: boolean;
	/** The key of this submission (`IdempotencyKey`): the same key again answers with the session the first attempt made, for as long as that session exists. */
	idempotencyKey?: IdempotencyKey;
}

/**
 * The key of one submission, named and shaped as the Agent Client Protocol's `idempotencyKey` is.
 * Whoever submits makes it, a random UUID, once for each submission, and sends the same key with
 * every attempt of that submission: when no answer came, when the answer was a failure to reach the
 * server, and when the user sends again what was refused, unchanged. The server takes a key at most
 * once and answers a repeat with what the first attempt was answered, so a message that reaches it
 * twice is one message (docs/architecture.md, "A message sent twice").
 *
 * A string of 1 to MAX_IDEMPOTENCY_KEY_CHARS characters. Left out, or null: no key, and every call
 * is a submission of its own. Anything else is refused with the code `bad_idempotency_key` and is
 * never read as no key. A key that comes again with other content is refused with
 * `idempotency_key_reused`, and stays the key of what it came with first. An attempt that was
 * refused leaves its key unused: the same key is then a new try.
 */
export type IdempotencyKey = string;

export interface ChatgptStatus {
	connected: boolean;
	email: string | null;
	/** When the saved sign-in's access token expires, ms since the epoch. The platform refreshes it when a turn needs a token within twenty minutes of that, or after. */
	accessExpiresAt: number | null;
}

// --- GitHub ----------------------------------------------------------------------------------

/** Account, installation and repository IDs are numbers through MAX_SAFE_INTEGER, then decimal strings. */
export type GithubId = number | string;

/** An account the GitHub App is installed on, which the connected GitHub user can reach. */
export interface GithubAccount {
	/** The installation's id at GitHub. */
	installationId: GithubId;
	/** The account's name: a user's or an organization's login. */
	login: string;
	kind: "user" | "organization";
	/** Where the installation's repositories are chosen, at GitHub. */
	manageUrl: string;
}

export interface GithubConnection {
	/** The GitHub user who connected. */
	login: string;
	accounts: GithubAccount[];
	connectedAt: number;
}

export interface GithubStatus {
	/** Null when GitHub is not connected. */
	connection: GithubConnection | null;
}

/**
 * The Linear integration: an issue in a mapped team that gains the `windlass` label, or is assigned to the
 * Windlass app user, is filed as a work item on the team's repository. Windlass posts item progress on the issue.
 * `UserActions.linear` and the actions after it are the Settings page's.
 */
export type LinearStatus =
	/** The deployment has no Linear OAuth client or signing secret (server env): Settings shows nothing to connect. */
	| { state: "off" }
	| { state: "disconnected" }
	| { state: "connected"; connection: LinearConnection };

export interface LinearConnection {
	workspace: { id: string; name: string; urlKey: string };
	/** The Linear user who connected. An issue they created is theirs: it files as a started item, as one of the owner's own GitHub issues does. */
	user: { id: string; name: string };
	/** The Windlass app user an issue is assigned to. Null when Linear did not report one. */
	appUser: { id: string; name: string } | null;
	connectedAt: number;
}

/** A team of the connected workspace and the repository it files to; null: its issues are ignored. */
export interface LinearTeam {
	id: string;
	/** The prefix of its issues' identifiers ("ENG"). */
	key: string;
	name: string;
	mapping: LinearMapping | null;
}

/** One team files to one repository of the owner's GitHub connection. */
export interface LinearMapping {
	teamId: string;
	repository: { id: GithubId; owner: string; name: string };
	savedAt: number;
}

export interface LinearTeamList {
	teams: LinearTeam[];
}

/** A repository the connection covers and the connected GitHub user can open. */
export interface GithubRepository {
	/** GitHub's id for it: what `CreateSessionInput.repository` names. */
	id: GithubId;
	owner: string;
	name: string;
	private: boolean;
	defaultBranch: string;
	/** False when the connected user may read it and not push: an agent can work on it, but no pull request can be opened. */
	canPush: boolean;
	/** When it was last pushed to, ms since the epoch; null when GitHub did not say. */
	pushedAt: number | null;
}

export interface GithubRepositoryList {
	repositories: GithubRepository[];
	/** True when more match than are listed: a longer search finds them. */
	more: boolean;
	/** True when GitHub was too slow for every account to be listed and every repository checked in the time a list has: some may be missing. */
	incomplete: boolean;
}

export interface GithubBranchList {
	/** Branch names, the default branch first. */
	branches: string[];
	defaultBranch: string;
	/** True when the repository has more branches than are listed. */
	more: boolean;
}

/** What a session was launched on, when it was picked from the user's GitHub connection. */
export interface SessionRepository {
	provider: "github";
	/** GitHub's id for the repository. */
	id: GithubId;
	owner: string;
	name: string;
	/** The branch the agent started from, and the base of the session's pull request. */
	branch: string;
	private: boolean;
	/** The repository's page: "https://github.com/owner/name". */
	url: string;
}

/** The pull request of a session, as GitHub last described it to the platform. */
export interface PullRequestInfo {
	number: number;
	/** Its page at GitHub. */
	url: string;
	state: "open" | "draft" | "merged" | "closed";
	title: string;
	/** The branch the session's work is on. */
	branch: string;
	/** The branch it asks to be merged into. */
	base: string;
	/** When the platform last pushed to it, ms since the epoch. */
	pushedAt: number;
	/**
	 * What the section the platform keeps in its description said when it was last written, in a few
	 * words (`Verified`; docs/github-and-repositories.md, "What a pull request shows was verified"): "2 checks passed",
	 * "1 of 2 checks failing", "nothing verified", with "1 thing to look at" where the section lists
	 * observations.
	 */
	verified: string;
}

/** The message of the commit the platform makes, and of the pull request when it opens one. */
export interface PublishMessage {
	title: string;
	body: string;
	/**
	 * The commit's whole message, when it is not the title and the body: a request of the agent's names
	 * the commit's message apart from the pull request's title and description. `publish()` takes none.
	 */
	commit?: string;
}

/** What the side panel shows about getting a session's work out. */
export interface PublishState {
	/** Null when the session does not work on a repository of the user's GitHub connection. */
	repository: SessionRepository | null;
	pullRequest: PullRequestInfo | null;
	/** The branch the work goes to: named for the session, and kept once something was pushed. */
	branch: string;
	/**
	 * Whether there is something to push: files that differ from the last commit, or commits GitHub
	 * does not have. Null when that is not known without starting the session's sandbox.
	 */
	changes: boolean | null;
	/** A message to start from: the session's title, and the last answer or the changed files. */
	draft: PublishMessage;
	/** Why nothing can be pushed right now, in a sentence; null when it can. */
	blocked: string | null;
	/** The commit the platform last pushed to `branch`, by the panel or for the agent; null when nothing was pushed. With no pull request open, "Open pull request" opens one from it. */
	pushed: string | null;
}

export interface PublishResult {
	state: PublishState;
	/** True when this call opened the pull request; false when it pushed to one that was open already. */
	opened: boolean;
}

/**
 * A repository's setup command: a shell command its user saved for a repository of their GitHub
 * connection. The platform runs it once in each new sandbox of a session on that repository, after
 * the clone and before the agent's first turn there: in the repository's directory, as the sandbox's
 * user, with the sandbox's network, and outside the sandbox Windlass puts around the agent's own
 * commands. It is the user's and nobody else's: nothing in a repository can set or change it.
 */
export interface RepositorySetup {
	/** The command as it is saved; "" when none is. */
	command: string;
	/** When it was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
	/** How long a run may take before the platform stops it. */
	timeoutMs: number;
}

/**
 * One of the checks a user saved for a repository of their GitHub connection: a command that tells
 * whether the code is right, which Windlass runs before it calls a turn done and sends the agent back
 * with when it fails (docs/github-and-repositories.md, "A repository's checks"). The first four fields are Windlass's own
 * (`checks[]` in its configuration), with its limits.
 */
export interface RepositoryCheck {
	/** Letters, digits, "_", "." and "-", starting with a letter or digit; no two of a list alike. */
	name: string;
	/** Run with `bash -c` in the repository's directory. */
	command: string;
	/** How long it may run, 1 to MAX_CHECK_TIMEOUT_SECONDS; absent: Windlass's own default (120). */
	timeoutSeconds?: number;
	/** Glob patterns of changed files that make it run; absent: any change does. */
	when?: string[];
	/**
	 * True: the end of what it printed goes into a pull request's description also when it passed. The
	 * platform's own field, handed to Windlass as `outputTail: "always"`.
	 */
	showOutput?: boolean;
}

/** `repositoryChecks`, and what saving answers with. */
export interface RepositoryChecks {
	/** In the order they run. */
	checks: RepositoryCheck[];
	/** When the list was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
}

// --- A repository's prepared environments (environments.ts) ---------------------------------

/** Where an environment is kept: "hosted", or the id of one of the user's machines. */
export type EnvironmentPlace = string;
export type EnvironmentState = "building" | "ready" | "failed" | "stale";
/** What started a build. "first_use": a session started cold where the repository has none. */
export type EnvironmentTrigger = "schedule" | "push" | "rebuild" | "change" | "first_use" | "image";
/** Why the sandbox could not run a check (factory/check-environment.ts); "code": it ran and failed on the base's code. */
export type EnvironmentFailureKind = "package_manager" | "network" | "not_found" | "code" | "setup" | "clone" | "save";

/** One saved check as a build ran it. */
export interface EnvironmentCheckResult {
	name: string;
	status: CheckStatus;
	exitCode: number | null;
	durationMs: number;
	/** The check-environment.ts kind of a failure the sandbox caused; null for a pass or a failure of the code. */
	environment: "package_manager" | "network" | "not_found" | null;
}

/** One build of an environment, as the record keeps it. */
export interface EnvironmentBuild {
	trigger: EnvironmentTrigger;
	startedAt: number;
	/** When setup and the checks finished; null while it runs. For the ready part, when it was validated. */
	finishedAt: number | null;
	/** The base commit setup ran at; "" until the clone. */
	commit: string;
	/** The image the sandbox was made from, as the place says it; "" where it does not (an older runner). */
	image: string;
	/** Digests of the setup command and of the checks as they were when the build started. */
	setupHash: string;
	checksHash: string;
	profile: string;
	/** Hosted, where the deployment offers sizes: the size it was built in. Its image starts only sandboxes of this size. */
	hostedSize?: HostedSize;
	checks: EnvironmentCheckResult[];
	/** Why it did not pass; null when it did or while it runs. */
	failure: { kind: EnvironmentFailureKind; check: string | null; line: string; excerpt: string } | null;
	/** A prepared image was saved. A passing setup under the minimum time keeps none: sessions then start cold, quickly. */
	snapshot: boolean;
	/**
	 * Checks that ran and failed on the base commit's code (main is red), not for the sandbox: they do not keep the
	 * environment from being promoted, and are shown with it. Absent or empty when none did.
	 */
	codeFailures?: string[];
}

/** One place's environment of a repository. */
export interface RepositoryEnvironment {
	place: EnvironmentPlace;
	/** "This platform", or the machine's name. */
	placeName: string;
	state: EnvironmentState;
	/** The last build that passed: the one sessions start from while it is current. */
	ready: EnvironmentBuild | null;
	/** The latest build, when it is newer than `ready`. */
	attempt: EnvironmentBuild | null;
	/** Why it is stale, or why a build is waiting ("daily sandbox time is used up"); null otherwise. */
	note: string | null;
	/** When the next build is due, ms since the epoch; null when none is. */
	nextAt: number | null;
}

/** How often a repository's environments are rebuilt on a schedule: 0 is off, 24 nightly. */
export type EnvironmentSchedule = 0 | 6 | 12 | 24;
export const ENVIRONMENT_SCHEDULES: readonly EnvironmentSchedule[] = [24, 12, 6, 0];

export interface RepositoryEnvironments {
	/** Whether the deployment keeps prepared sandboxes at all, and why not when it does not. */
	available: boolean;
	unavailableReason: string | null;
	schedule: EnvironmentSchedule;
	/** Whether `schedule` was chosen, or is the default (nightly with a setup command, off without). */
	scheduleChosen: boolean;
	environments: RepositoryEnvironment[];
	/** Places a Rebuild may name that have no environment yet. */
	places: { place: EnvironmentPlace; placeName: string }[];
}

// --- A repository's network list -------------------------------------------------------------

/**
 * A named set of hosts that WLP_E2B_NETWORK_ALLOW and a repository's network list can allow with one
 * entry ("@npm", "@playwright"), shown as a checkbox in the repository's settings. Exact names only:
 * a wildcard cannot be pinned in a sandbox's /etc/hosts. Each list is the hosts the tool's own code or
 * documentation names for its downloads, with the hosts a download is redirected to (docs/operating.md,
 * "E2B", "Network", says where each comes from).
 */
export interface NetworkPreset {
	id: string;
	/** In words, for the repository's settings: "Playwright browsers". */
	name: string;
	/** What it is for, in a few words. */
	about: string;
	hosts: readonly string[];
}

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
	{ id: "@npm", name: "npm registry", about: "npm, pnpm, Yarn and Bun packages", hosts: ["registry.npmjs.org", "registry.yarnpkg.com"] },
	{ id: "@pypi", name: "PyPI", about: "pip, uv and Poetry packages", hosts: ["pypi.org", "files.pythonhosted.org"] },
	{ id: "@github", name: "GitHub downloads", about: "Release assets, raw files and archives", hosts: ["github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com"] },
	{ id: "@crates", name: "crates.io", about: "Cargo packages", hosts: ["crates.io", "index.crates.io", "static.crates.io"] },
	{ id: "@go", name: "Go module proxy", about: "Go modules and their checksums", hosts: ["proxy.golang.org", "sum.golang.org"] },
	{ id: "@node", name: "nodejs.org", about: "Node.js downloads, and the headers node-gyp builds native addons with", hosts: ["nodejs.org"] },
	{ id: "@playwright", name: "Playwright browsers", about: "What playwright install downloads. On x86_64 its Chromium download redirects to Google Cloud Storage, which is not in this preset: add @gcs for it", hosts: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"] },
	{ id: "@gcs", name: "Google Cloud Storage", about: "Reaches every public Google Cloud Storage bucket, anyone's, not only the one a download needs. Playwright's Chromium for x86_64 comes from it", hosts: ["storage.googleapis.com"] },
	{ id: "@prisma", name: "Prisma engines", about: "The engines Prisma downloads when it is installed", hosts: ["binaries.prisma.sh"] },
	{ id: "@debian", name: "Debian packages", about: "Debian's apt sources", hosts: ["deb.debian.org", "security.debian.org"] },
	{ id: "@ubuntu", name: "Ubuntu packages", about: "Ubuntu's apt sources; the sandbox runs Ubuntu", hosts: ["archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com"] },
];

/**
 * Hosts that serve far more than what a download needs, with the sentence said wherever someone can
 * allow one: on the timeline's line about it, beside a request, and beside a proposal.
 */
export const WIDE_HOSTS: Readonly<Record<string, string>> = {
	"storage.googleapis.com": "storage.googleapis.com serves every public Google Cloud Storage bucket, anyone's: allowed, it lets a command send to or fetch from any of them, not only the one a download needs.",
};

/**
 * A host a command in one of the repository's hosted sandboxes looked up and could not reach, kept for
 * the repository until it is allowed or dismissed: a request, which only the person who changes the
 * repository's settings can grant. Nobody is asked when one is filed.
 */
export interface NetworkRequest {
	host: string;
	/** When a command last asked for it, ms since the epoch. */
	at: number;
	/** The session whose sandbox it was looked up in; null when that is not known. */
	sessionId: string | null;
}

/**
 * The hosts a repository's hosted sandboxes may reach besides the platform's own and the deployment's
 * (docs/github-and-repositories.md, "A repository's network"): exact host names and presets, saved for
 * the repository by GitHub's id, like its setup command. They apply where the deployment runs hosted
 * sandboxes on E2B with WLP_E2B_NETWORK=restricted, from the next command of every hosted session on
 * the repository: a sandbox is changed at once when a host is allowed from its session while a turn runs in it.
 */
export interface RepositoryNetwork {
	/** What is saved: preset ids ("@playwright") and exact host names, in the order they were added. */
	entries: string[];
	/** The hosts they come to, sorted, each once. */
	hosts: string[];
	/** When the list was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
	/** Hosts its sessions' commands asked for and could not reach, the newest first. */
	requests: NetworkRequest[];
	/** The presets that can be chosen. */
	presets: NetworkPreset[];
	/**
	 * What the deployment's hosted sandboxes reach whatever the list says: `mode` is WLP_E2B_NETWORK, and
	 * `hosts` the model API, the git host, the bucket and the deployment's own list (empty in `open`).
	 * Null where hosted sandboxes are not on E2B: the list then applies nowhere on this deployment.
	 */
	hosted: { mode: EgressMode; hosts: string[] } | null;
	/** How many hosts the list may come to here (MAX_REPOSITORY_HOSTS, less where the deployment's own list leaves less room). */
	limit: number;
}

/** A host or a preset found in a repository's files (`scanRepositoryNetwork`): a proposal, never applied by itself. */
export interface NetworkProposal {
	/** A preset id or an exact host name: what allowing it saves. */
	entry: string;
	/** For a preset, its hosts; for a host, that host. */
	hosts: string[];
	/** Where it was found, in words, at most five: "package.json scripts.postinstall", ".github/workflows/ci.yml line 31". */
	sources: string[];
}

/** What a scan of a repository's files found. */
export interface NetworkScan {
	/** Not yet reachable from its sandboxes: presets first, then hosts by name. */
	proposals: NetworkProposal[];
	/** The commit that was read, and the branch it is the head of. */
	commit: string | null;
	branch: string | null;
	/** How many files were read. */
	files: number;
	/** True when GitHub's list of files was cut short, or more files matched than are read: something may be missing. */
	incomplete: boolean;
}

/** What `allowHost` did. */
export interface HostAllowed {
	network: RepositoryNetwork;
	/** True when the session's sandbox was changed at once, which happens only while a turn holds it; false when it applies from the next turn. */
	applied: boolean;
}

/** How one check ended, in Windlass's words (`CheckEvidence.status`). */
export type CheckStatus = "passed" | "failed" | "timed_out" | "could_not_start" | "interrupted";

/** A check that ran, as Windlass recorded it (`checks.finished`) and as the platform accounts for it. */
export interface VerifiedCheck {
	name: string;
	command: string;
	/**
	 * "user": one of the checks the session's user saved for the repository, handed to Windlass for
	 * that turn. "repository": from the repository's own `.windlass/config.json`, which Windlass
	 * runs alongside the user's required checks.
	 */
	whose: "user" | "repository";
	/** True when Windlass ran it as a required check: the repository's file could neither replace it nor switch it off. Only a check of the user's is one. */
	required?: boolean;
	status: CheckStatus;
	exitCode: number | null;
	durationMs: number;
	/** How many times in its turn the agent was sent back with this check failing. */
	sentBack: number;
	/** True when Windlass did not run it again in that run: it had passed earlier in the session, and no file it covers changed since. */
	carried?: boolean;
	/** The end of what it printed, at most CHECK_OUTPUT_CHARS: kept for one that did not pass, and for one whose user asked (`RepositoryCheck.showOutput`; of the repository's own, its file's `outputTail`). */
	output?: string;
	/**
	 * Set for a check that was not started (`could_not_start` with no exit code), with the reason why its command could not be
	 * started, in Windlass's words (the evidence's `startError`), "" where it gave none. Such a check
	 * says nothing about the code, and the agent was not sent back for it.
	 */
	startError?: string;
}

/**
 * What a session's work rests on after a turn, from what Windlass recorded of its verification gate:
 * on the turn's closing item in the timeline, and what a pull request's description is given.
 *
 * `state` is how the gate ended in `turn`:
 *
 *   passed          every check that applied passed
 *   unresolved      checks did not pass and the turn ended anyway (`unresolved` says why)
 *   not_needed      checks are set and none was needed: the turn changed nothing they cover
 *                   (`unneeded` records why)
 *   none_set        no check is set, neither by the user nor by the repository's file
 *   off             the repository's file turns verification off
 *   no_sandbox      Windlass could not run checks in this sandbox, and said so; required checks
 *                   are then in `run`, each as one that could not be started
 *   not_in_force    the user has checks, Windlass reported none in force, and nothing says why
 *   stopped         the turn was stopped, or cut off, before the gate decided
 *   failed          the turn failed before the gate decided
 */
export type Verified = ({
	state: "not_needed";
	/**
	 * For "not_needed", why no check was needed (the ending's `reason`):
	 *
	 *   turn_unchanged    the turn changed no file
	 *   state_unchanged   the turn changed files, and they are again as they were in the state Windlass
	 *                     measures changes from
	 *   not_covered       files differ from that state, and no check covers any of them
	 *
	 * and, for the last two, which state that is (the ending's `since`): "run", the one `run` passed
	 * on, give or take files no check covers; "start", what the session started from, which no check
	 * has verified; null where Windlass does not say, or names a run the platform no longer holds.
	 */
	unneeded: { reason: "turn_unchanged" | "state_unchanged" | "not_covered"; on: "run" | "start" | null };
} | {
	state: "passed" | "unresolved" | "none_set" | "off" | "no_sandbox" | "not_in_force" | "stopped" | "failed";
	unneeded?: never;
}) & {
	turn: number;
	/**
	 * For "unresolved": why the turn was let end, and for "acknowledged" what the agent gave as its
	 * reason. "not_started": no check that did not pass was started (`VerifiedCheck.startError`), so
	 * the turn ended at once and the agent was not sent back. "environment": every check that failed did so because the
	 * sandbox could not run it (factory/check-environment.ts), so the agent was not sent back either.
	 */
	unresolved?: { reason: "acknowledged" | "max_rounds" | "report_mode" | "not_started" | "environment"; said: string | null };

	/**
	 * The checks that did not pass in a run of `turn` whose result does not stand: the agent then put
	 * the files back, and the turn ended with no check needed (`unneeded`). They are not `run`'s.
	 */
	putBack?: VerifiedCheck[];
	/**
	 * The session's last run of checks that finished, with the turn it was in, when, and where in
	 * Windlass's log (`seq`, of its `checks.finished`);
	 * null when none has. After a turn that ended on a state verified earlier (`unneeded`) it is the
	 * run that state rests on, or null.
	 */
	run: { turn: number; at: number; seq: number; checks: VerifiedCheck[] } | null;
	/** The user's checks, as saved when `turn` started, that are neither among `run`'s nor among `putBack`. */
	unrun: Array<{ name: string; command: string }>;
	/** True when the user's checks were required ones in `turn` and the repository's file said something about checks or verification: that held for the repository's own checks, and not for the user's. */
	overruled?: boolean;
	/** True when Windlass recorded another state of the workspace after `run` finished than the one the checks ran on. */
	changedAfter: boolean;
}

/**
 * Something in a pull request's changes that a reviewer would want to look at, as an observation
 * (docs/github-and-repositories.md, "What a pull request shows was verified", says exactly what each one looks for):
 *
 *   tests_removed    test files deleted, or renamed to a path that is not a test's
 *   tests_skipped    tests newly skipped or disabled in test files
 *   checks_changed   the repository's check configuration, or what a check's command runs, changed
 *   exit_ignored     a check's command, or what it runs, came to ignore an exit status
 *
 * That files changed after the checks last ran is one more, known from Windlass's record and not
 * from the changes: `Verified.changedAfter`.
 */
export interface VerifiedFlag {
	kind: "tests_removed" | "tests_skipped" | "checks_changed" | "exit_ignored" | "agent_instructions_changed" | "outside_scope";
	/** What it was seen in: paths, at most a few. */
	where: string[];
}

/**
 * Who a repository's secret is handed to (docs/github-and-repositories.md, "A repository's secrets"). Every secret goes to the
 * repository's setup command. Beyond that:
 *
 *   "setup"   the MCP servers the repository names, and not the commands the agent runs
 *   "agent"   the MCP servers, and the commands the agent runs as well
 *
 * Where Windlass sandboxes the agent's commands, that is what each of them gets. Where it does not,
 * a scope can come to less; `SecretReach` says what.
 * A secret of the account (`AccountSecret`) has the same two, without the setup command.
 */
export type SecretScope = "setup" | "agent";

/**
 * What a secret reaches in a session whose sandbox has a given profile. Windlass decides what its
 * commands and the MCP servers see: an MCP server gets the variables its definition names from
 * Windlass's own environment, and a command gets that environment by a rule (a command Windlass
 * sandboxes: every variable except those whose names look like credentials; one it does not sandbox:
 * all of them), which whoever opens the session corrects by name. Where commands are sandboxed that
 * makes a scope exact. Where they are not, a variable withheld from a command can still be read by
 * it, so a secret that is not for the commands stays out of Windlass's environment and MCP servers
 * go without it.
 */
export interface SecretReach {
	/** Whether the MCP servers the repository names can be given it (`${NAME}` in their definitions). */
	servers: boolean;
	commands: "yes" | "no";
	/** Set when that is less than the scope says, or needs a word: a sentence fit to show under the secret. */
	note: string | null;
}

/** A secret as it is listed: never with its value, which is not sent to a client once it is saved. */
export interface RepositorySecret {
	/** The environment variable it is handed over as. */
	name: string;
	scope: SecretScope;
	/** When its value or scope was last changed, ms since the epoch. */
	updatedAt: number;
	/** What it reaches in the sandbox the list was asked for: its profile, and the Windlass in it. */
	reach: SecretReach;
	/** True when the user's account has a secret of this name too (`AccountSecret`): in this repository's sessions this one is used in its place. */
	account?: boolean;
}

/** The secrets a user saved for one repository of their GitHub connection, by name. */
export interface RepositorySecrets {
	secrets: RepositorySecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

// --- A repository's page ---------------------------------------------------------------------

/**
 * What a new session on a repository starts with, where its user said so (docs/github-and-repositories.md, "A repository's
 * page"): the launch form starts from them when that repository is picked, and its user can still
 * choose otherwise for one session. Kept as they were saved: a default may come to name a sandbox
 * this deployment no longer offers or a model its user's account no longer does, and such a one is
 * not used.
 */
export interface RepositoryAutonomy {
	autoApprovePlans?: boolean;
	autoMergeSingles?: boolean;
	waitForCiOnEachPart?: boolean;
}

export type DefaultPlace = "hosted" | "any-machine" | { machine: string };

/** One placement policy. A repository without a place inherits the account's whole policy. */
export interface ItemPlaceDefaults {
	place?: DefaultPlace | null;
	placeFallback?: "wait" | "hosted" | null;
	harness?: HarnessId | null;
	machineProfile?: SandboxProfileId | null;
	/** The machine agent's model and effort, by id; null runs its default. Plan-first subtasks on that agent start with them. */
	machineModel?: string | null;
	machineEffort?: string | null;
}

export interface RepositoryDefaults extends RepositoryAutonomy, ItemPlaceDefaults {
	/** Allow item agents to file screenshots for this repository. Defaults to false. */
	screenshots: boolean;
	/** The sandbox profile, by its id; null when none is saved. */
	profile: SandboxProfileId | null;
	/** The model; null when none is saved. */
	model: string | null;
	/** The hosted sandbox size of the repository's agents and work items; null when none is saved (agents small, work items standard). */
	hostedSize?: HostedSize | null;
	/** When either was last saved, ms since the epoch; null when neither is. */
	updatedAt: number | null;
}

/** The user's remembered approval of an MCP server a repository names, as the repository's page lists it. */
export interface RepositoryApproval {
	/** The server's name in the repository's configuration. */
	name: string;
	/** When the user last approved a definition of it, and until when that approval holds, ms since the epoch. */
	approvedAt: number;
	expiresAt: number;
	/** How many definitions of it are approved: more than one when its definition changed and was approved again. Forgetting forgets them all. */
	definitions: number;
}

/**
 * What the user's actor keeps for one repository of a GitHub connection, by GitHub's id for it: what
 * the repository's page shows beside the setup command and the secrets, which are read by their own
 * actions. Nothing here is asked of GitHub, and nothing here is a secret's value.
 */
export interface RepositoryView {
	/** GitHub's id for the repository. */
	id: GithubId;
	/**
	 * "owner/name" as the user's sessions on it, or what was saved for it, last had it; null when
	 * nothing names it. GitHub is not asked: `githubRepository` says what it is called now.
	 */
	name: string | null;
	defaults: RepositoryDefaults;
	/** The remembered approvals that have not run out, the newest first. */
	approvals: RepositoryApproval[];
	/** What forgetting an approval does and does not do on this deployment, in a sentence or two. */
	forgetting: string;
	/** What else is saved for it: whether a setup command is, how many secrets, how many checks, and how many entries its network list has. */
	saved: { setup: boolean; secrets: number; checks: number; network: number };
}

/** A repository the user's actor keeps something for: a setup command, a secret, a default or a remembered approval. */
export interface SavedRepository {
	id: GithubId;
	/** As `RepositoryView.name`. */
	name: string | null;
}

// --- The account's settings ------------------------------------------------------------------

/**
 * What a new session starts with where neither the launch form nor the chosen repository says so
 * (docs/github-and-repositories.md, "Account settings"): a sandbox profile and a model, the user's own, whatever the
 * repository. Kept as they were saved, as a repository's are: one that names a sandbox this
 * deployment no longer offers, or a model the account no longer does, is not used, and whoever reads
 * it says so.
 */
export type AccountDefaults = Omit<RepositoryDefaults, keyof RepositoryAutonomy | "screenshots" | "hostedSize">;

/**
 * Where the user's newest agent was started, with which agent and in which mode, as the server
 * remembered it when that agent was made (account-defaults.ts). Not a saved default: every agent the
 * user starts replaces it, a work item's sessions never do, and it outlives the agent it came from.
 * The start composer starts where it runs, the agent and the mode from it where nothing is chosen; a
 * machine that cannot be used now, or an agent it does not offer, leaves the composer on this
 * platform with Windlass, and it says so. Forgotten (`forgetLastStart`), they start on the platform's.
 */
export interface LastStart {
	place: SandboxPlace;
	harness: HarnessId;
	/** The mode the agent started in: one of that agent's own. */
	mode: string;
	/** When, ms since the epoch. */
	startedAt: number;
}

/**
 * An MCP server of the user's own: Windlass starts it, or reaches it, in every session of theirs,
 * whatever the repository. It is never read from a repository. `definition` is what Windlass's own
 * configuration takes for one server (its docs/mcp.md, "The keys"): `command` with `args`, `cwd` and
 * `env`, or `url` with `headers`, and `tools`, `timeoutSeconds`, `startupTimeoutSeconds`, `untrusted`,
 * `enabled`, `protocol`.
 */
export interface PersonalServer {
	/** Its key in Windlass's configuration: what the model calls it by. */
	name: string;
	definition: Record<string, unknown>;
	/** True when it is reached at an address and nothing is started. */
	remote: boolean;
	/** What starts it, or where it is reached, in one line: the command with its arguments, or the address. */
	subject: string;
	/** False when its definition says `enabled: false`: Windlass then leaves it out. */
	enabled: boolean;
	/**
	 * True when its tools run without asking: where Windlass asks before a call of one, the platform
	 * answers for the user, each call once, and the session's timeline says so. Off unless its user
	 * said so. It says nothing of what the server returns, which Windlass goes on not trusting unless
	 * the definition says `untrusted: false`.
	 */
	unasked: boolean;
	/**
	 * The variables its definition reads (`${NAME}` in `env` or `headers`), in order, each with whether
	 * an account secret of that name is saved. Windlass does not start a server that reads a variable
	 * which is not set.
	 */
	reads: Array<{ name: string; saved: boolean }>;
	/** When it was last saved, ms since the epoch. */
	updatedAt: number;
}

/**
 * What a personal server can reach where it runs, said for one sandbox this deployment can run, in
 * the words of the question about a project's MCP server (`PendingQuestion.server`): Windlass starts a
 * server of its user's own configuration without asking, so this is said before one is saved.
 */
export interface PersonalServerReach {
	profile: SandboxProfileId;
	/** The profile's display name. */
	name: string;
	/** For a server that is started by a command. */
	command: string;
	/** For a server that is reached at an address. */
	address: string;
}

/** The account's settings, as their page shows them. No value of a secret is among them: `accountSecrets` lists those. */
export interface AccountSettings {
	defaults: AccountDefaults;
	/** Where the user's newest agent was started, its agent and its mode (`LastStart`); null before the first, or once forgotten. */
	lastStart: LastStart | null;
	/** By name. */
	servers: PersonalServer[];
	/** One entry for each sandbox this deployment can run. */
	serverReach: PersonalServerReach[];
	/** How many servers and account secrets a user may keep, and how long a server's definition may be as JSON, in bytes. */
	limits: { servers: number; definitionBytes: number; secrets: number };
}

/**
 * A secret of the account, as it is listed: never with its value. It is handed to MCP servers, the
 * user's own and a project's that reads `${NAME}`, and never to a repository's setup command.
 */
export interface AccountSecret {
	/** The environment variable a server's definition reads it as. */
	name: string;
	/** A repository's secret's scopes, without the setup command: "setup" is MCP servers only, "agent" the agent's commands as well. */
	scope: SecretScope;
	/** When its value or scope was last changed, ms since the epoch. */
	updatedAt: number;
	/** What it reaches in the sandbox the list was asked for. */
	reach: SecretReach;
	/**
	 * The repositories ("owner/name", or GitHub's number for one nothing names) that have a secret of
	 * their own under this name: in a session on one of them the repository's secret is used, with its
	 * value and its scope, and this one is not.
	 */
	repositories: string[];
}

export const MODEL_CHECKS_PER_MINUTE = 12;
export const MODEL_PROVIDERS = ["openai", "anthropic", "google", "openrouter"] as const;
export type ModelProvider = typeof MODEL_PROVIDERS[number];

export function isModelProvider(value: unknown): value is ModelProvider {
	return (MODEL_PROVIDERS as readonly unknown[]).includes(value);
}

const MODEL_KEY_SHAPES: Record<ModelProvider, RegExp> = {
	openai: /^sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{16,512}|[A-Za-z0-9]{16,512})$/,
	anthropic: /^sk-ant-[A-Za-z0-9_-]{16,600}$/,
	google: /^(?:AIza[A-Za-z0-9_-]{35}|AQ\.[A-Za-z0-9_.-]{16,1024})$/,
	openrouter: /^sk-or-v1-[A-Za-z0-9]{16,512}$/,
};

export function validModelKey(provider: ModelProvider, key: unknown): key is string {
	return typeof key === "string" && MODEL_KEY_SHAPES[provider].test(key);
}

export interface ModelProviderStatus {
	provider: ModelProvider;
	last4: string;
	addedAt: number;
	checkedAt: number | null;
	ok: boolean;
	models?: string[];
}

/** A failed check leaves the key saved and returns a message safe to display. */
export type ModelProviderCheck = ModelProviderStatus & { message?: string };

export interface AccountSecrets {
	secrets: AccountSecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

// --- Usage -----------------------------------------------------------------------------------

/**
 * A user's sandbox time today and the sandboxes they keep, in numbers (docs/architecture.md, "Usage and limits").
 *
 * Sandbox time is the time a hosted sandbox runs: from when it is created or resumed, for a turn or
 * to read the workspace, until it is suspended, removed or stops by itself. A sandbox that is paused
 * uses none. A day is a UTC day. While a sandbox runs, its session holds a few minutes of the day's
 * allowance at a time, and what it does not use of a hold comes back when the sandbox stops.
 */
export interface UsageNumbers {
	/** The server's clock when this was read, ms since the epoch. */
	at: number;
	/** The UTC day the numbers are for, "2026-11-17". */
	day: string;
	/** When that day ends and the allowance is whole again: the next midnight UTC, ms since the epoch. */
	resetsAt: number;
	/** The sandbox time a user may use in one day, in seconds; null when the deployment sets no limit. */
	allowanceSeconds: number | null;
	/** Seconds counted today: what sandboxes that have stopped ran. */
	usedSeconds: number;
	/** Seconds held by sandboxes that run now. They count as used until each sandbox stops and its real time is counted. */
	heldSeconds: number;
	/** What is left of today's allowance for a turn that starts now, never below 0; null without a limit. */
	leftSeconds: number | null;
	/** The least that must be left for a turn to start, or for a paused sandbox to be started to read its workspace. */
	startSeconds: number;
	/** How many sandboxes the user keeps, running or paused, and the most they may keep; `limit` is null without one. */
	sandboxes: { kept: number; limit: number | null };
	/** The calendar month's hosted minutes, where the account has a monthly allowance (a plan, or the operator's `hostedMinutes`). Absent: only the day counts. */
	hosted?: HostedMonth;
}

/**
 * A UTC calendar month of hosted minutes. A hosted minute is one minute of a standard sandbox (2 vCPU, 4 GiB): a small
 * one counts half, a large one twice (billing/meter.ts). Runs on the user's own machines are never in it. All in
 * weighted seconds, so that nothing is rounded before it is shown.
 */
export interface HostedMonth {
	/** "2026-11". */
	month: string;
	/** End of the hosted allowance period, ms since the epoch. */
	resetsAt: number;
	/** What the plan includes. */
	includedSeconds: number;
	/** The most that may be used: the included minutes, and on a plan with overage the minutes the spend cap pays for. */
	limitSeconds: number;
	/** Counted this month, weighted. */
	usedSeconds: number;
	/** Held by sandboxes that run now, weighted. */
	heldSeconds: number;
	/** What is left of `limitSeconds`, never below 0. */
	leftSeconds: number;
	/** Subscription cadence for Pro. */
	period?: BillingPeriod;
	/** The plan these are of, where the deployment has billing; absent where the operator set the allowance. */
	plan?: PlanId;
}

/** A plan of the deployment's billing (billing/plans.ts). Team and Enterprise are planned, not offered. */
export type PlanId = "free" | "pro";
export type BillingPeriod = "month" | "year";

/** What a plan gives, as the upgrade page compares them. Prices in US cents. */
export interface PlanInfo {
	id: PlanId;
	name: string;
	/** Per month, billed monthly; and per year, billed yearly (null where the plan has no yearly price). */
	monthlyCents: number;
	yearlyCents: number | null;
	machines: number;
	hostedMinutes: number;
	hostedRunning: number;
	keptSandboxes: number;
	sizes: Array<"small" | "standard" | "large">;
	crossRepo: boolean;
	githubItemsPerDay: number;
	/** US cents per 1,000 hosted minutes past the included ones; null: a hard stop at the included minutes. */
	overageCentsPer1000: number | null;
}

/** The Plan section of Settings and the upgrade page. `enabled` false: the deployment has no billing, and nothing of it is shown. */
export type BillingView = { enabled: false } | {
	enabled: true;
	/** The plan whose limits apply now: Pro while its subscription is active or in its grace period, otherwise Free. */
	plan: PlanId;
	/** The subscription's state: "none" without one; "past_due" after a failed payment, until `graceUntil`; "ended" after it ended. */
	status: "none" | "active" | "past_due" | "paused" | "ended";
	period: BillingPeriod | null;
	/** When the subscription renews, or ends where `cancelAtPeriodEnd`. */
	periodEnd: number | null;
	cancelAtPeriodEnd: boolean;
	/** After a failed payment: when the account falls back to Free unless a payment succeeds. Nothing is deleted then. */
	graceUntil: number | null;
	/** The most overage may cost in a month, in US cents; `maxCapCents` is the highest it may be set to. */
	capCents: number;
	maxCapCents: number;
	/** Overage minutes counted this month, and what the provider has been told of them. */
	overageMinutes: number;
	reportedMinutes: number;
	/** Whether a customer portal can be opened: there is a customer at the provider. */
	portal: boolean;
	plans: PlanInfo[];
	month: HostedMonth | null;
};

/** One agent's sandbox time today. */
export interface UsageSession {
	sessionId: string;
	/** Null for an agent that was deleted since. */
	title: string | null;
	/** Seconds counted today for this agent's sandbox. */
	seconds: number;
	/**
	 * Of `seconds`, what was counted in full because the agent never reported how long its sandbox
	 * really ran: the server it was on stopped under it. It ran that long at most.
	 */
	unreportedSeconds: number;
	/** Seconds its sandbox holds now; 0 when it does not run. */
	heldSeconds: number;
	/** The size of its sandbox, where the deployment offers sizes: what its seconds are priced at. */
	hostedSize?: HostedSize;
}

/** One UTC day of the history. */
export interface UsageDay {
	/** "2026-11-17". */
	day: string;
	seconds: number;
}

/** A sandbox the user keeps: it exists for one of their agents, running or paused. */
export interface KeptSandbox {
	/** The agent it was made for: what `freeSandbox` takes. */
	sessionId: string;
	/** Null when that agent no longer exists and its sandbox was left behind. A work item's reviewer reads "Reviewer of “title”". */
	title: string | null;
	/** The work item whose builder or reviewer it is. */
	item?: { id: string; role: "builder" | "reviewer" };
	/** A reviewer's sandbox, which shares its item builder's place: it takes none of the cap of its own. */
	sharesPlace?: true;
	/** "starting": the agent was given the place and its sandbox is being made. */
	state: "running" | "paused" | "starting";
	/** When the agent was last prompted or its last turn ended, ms since the epoch; null without the agent. */
	usedAt: number | null;
	/** True while the agent works: its sandbox cannot be freed until the turn has ended or is stopped. */
	busy: boolean;
	/** "owner/name" of the repository the agent was launched on through the GitHub connection, when it was. */
	repository: string | null;
	/** Whether the platform has pushed work of this agent to GitHub: that much is cloned again into a new sandbox. */
	pushed: boolean;
	/** Its size, where the deployment offers sizes. */
	hostedSize?: HostedSize;
}

/** What a second of a running sandbox is estimated to cost. */
export interface UsagePrice {
	/** US dollars per second. */
	usdPerSecond: number;
	/** What that price is of, for a sentence: "1 vCPU and 1,024 MiB of memory at E2B's published prices". */
	basis: string;
}

/** What the usage page shows. */
export interface UsageView extends UsageNumbers {
	providerTokens?: { provider: ModelProvider; tokens: number }[];
	/** Model usage reported by requests using the platform credential on this UTC day. */
	usedModelTokens: number;
	factoryLimits: FactoryLimits;
	/** Today's sandbox time by agent, the most first; an agent whose sandbox runs now is among them. */
	today: UsageSession[];
	/** The last USAGE_HISTORY_DAYS days, the oldest first and today last. */
	days: UsageDay[];
	/** The sandboxes the user keeps, as the provider lists them, the most recently used first. */
	kept: KeptSandbox[];
	/** Null where running a sandbox is not billed by the second (local Docker): no cost is estimated then. The smallest size's, where there are sizes. */
	price: UsagePrice | null;
	/** The hosted sizes and what an hour of each costs, as `PlatformInfo.hostedSizes`. The allowance is in seconds whatever the size. */
	hostedSizes?: HostedSizeOption[];
	/**
	 * What becomes of an agent's memory of its conversation when its sandbox is freed. "kept": it is
	 * stored outside the sandbox. "copied": a copy is saved after every turn and put into the next
	 * sandbox. "lost": it is in the sandbox only, and the agent starts without it.
	 */
	memory: "kept" | "copied" | "lost";
}

// --- The user's own machines (Plans "bring your own computer") ------------------------------

/**
 * Where a machine is, with `MachineSummary.since`. "waiting": it was confirmed and its runner has not
 * connected since (since: when it was confirmed); a runner that lost its key before it connected never
 * will, and the page offers to remove it. "online": its runner is connected (since: when it connected).
 * "offline": its runner was connected before and is not now (since: when it was last heard from).
 */
export type MachineStatus = "waiting" | "online" | "offline";

/** A probe on the machine: passed, or what it found. */
export type MachineProbe = { ok: true } | { ok: false; reason: string };

/** Something the Machines page warns about. Each is listed only while it holds. */
export type MachineWarning =
	| { kind: "signing-disabled" }
	/** The runner is older than `MachinesInfo.minRunnerVersion`, so it is refused; its version is `MachineSummary.runnerVersion`. */
	| { kind: "outdated" }
	/** The runner cannot reach Docker on its machine; `reason` is what Docker said, as the runner reported it. */
	| { kind: "docker"; reason: string }
	/** The machine's clock is this far off the platform's (positive: ahead), enough for a turn's access token to read as expired too early or too late. */
	| { kind: "clock"; offsetSeconds: number }
	/** A second runner with this machine's key tried to connect while its runner was connected, last at `at`: the key was copied. */
	| { kind: "key"; at: number };

/** An agent's sandbox on a machine, as its runner last reported it. */
export interface MachineSandbox {
	resizePending?: true;
	sessionId: string;
	/** Null when that agent was deleted and its sandbox is still there. */
	title: string | null;
	state: "running" | "paused";
	/** When the sandbox was last used, ms since the epoch, by the platform's clock. */
	usedAt: number;
}

/** Docker may supply a short or full container ID as the local hostname. */
export function isMachineIdName(name: string): boolean {
	return /^(?:[0-9a-f]{12}|[0-9a-f]{64})?$/i.test(name.trim());
}

/** An OS as runners report it ("linux", "darwin") by the name people use: "Linux", "macOS". */
function osName(os: string | undefined): string {
	const trimmed = (os ?? "").trim();
	const known: Record<string, string> = { linux: "Linux", darwin: "macOS", windows: "Windows", win32: "Windows" };
	return known[trimmed.toLowerCase()] ?? trimmed;
}

export function machineLabel(machine: { name: string; os?: string; arch?: string }): string {
	const name = machine.name.trim();
	if (!isMachineIdName(name)) return name;
	const kind = [osName(machine.os), machine.arch?.trim()].filter(Boolean).join(" ");
	const what = kind ? kind + " machine" : "Machine";
	return name ? what + " (" + name.slice(0, 6).toLowerCase() + ")" : what;
}

/** Latest host sample for an already listed machine. */
export interface MachineHostUpdate { machineId: string; host: NonNullable<MachineSummary["host"]> | null }
export interface MachineDetails { whenToUse: string; tags: string[]; orchestrator?: "yes" | "named" | "never" }
export interface MachineSlotCapacity {
	max: number;
	unit: { cpus: number; memoryBytes: number; pids: number };
	reserve: { cpus: number; memoryBytes: number };
}

// --- Hosted sandbox sizes ------------------------------------------------------------------------

/**
 * The size of a hosted sandbox (E2B). E2B fixes a sandbox's CPUs and memory when its template is built,
 * so each size is a template of its own (sandbox/e2b/build.sh, `WLP_E2B_SIZE`), and a sandbox keeps its size
 * for life: another size is a new sandbox. Machines have no sizes of this kind: a machine's slot is
 * set by its runner (`--slot-memory`).
 */
export type HostedSize = "small" | "standard" | "large";
export const HOSTED_SIZES: readonly HostedSize[] = ["small", "standard", "large"];
export const HOSTED_SIZE_SPECS: Readonly<Record<HostedSize, { cpus: number; memoryMiB: number }>> = {
	small: { cpus: 1, memoryMiB: 1024 },
	standard: { cpus: 2, memoryMiB: 4096 },
	large: { cpus: 4, memoryMiB: 8192 },
};
/** A work item's sandbox, where nothing else is chosen. */
export const ITEM_HOSTED_SIZE: HostedSize = "standard";
/** A person's own agent, where neither the launch form nor the repository says. */
export const SESSION_HOSTED_SIZE: HostedSize = "small";

export function isHostedSize(value: unknown): value is HostedSize {
	return typeof value === "string" && (HOSTED_SIZES as readonly string[]).includes(value);
}

/** "Standard · 2 vCPU, 4 GiB". */
export function hostedSizeWords(size: HostedSize): string {
	const spec = HOSTED_SIZE_SPECS[size];
	return `${size.charAt(0).toUpperCase()}${size.slice(1)} · ${spec.cpus} vCPU, ${spec.memoryMiB / 1024} GiB`;
}

/** The least size that has a plan's `cpus` and `memoryGiB`; null when even the largest has not. */
export function hostedSizeFor(needs: { cpus?: number; memoryGiB?: number }): HostedSize | null {
	if (needs.cpus === undefined && needs.memoryGiB === undefined) return null;
	return HOSTED_SIZES.find((size) => (needs.cpus ?? 0) <= HOSTED_SIZE_SPECS[size].cpus && (needs.memoryGiB ?? 0) * 1024 <= HOSTED_SIZE_SPECS[size].memoryMiB) ?? null;
}

/** The next size up, or null for the largest. */
export function largerHostedSize(size: HostedSize, offered: readonly HostedSize[] = HOSTED_SIZES): HostedSize | null {
	return HOSTED_SIZES.slice(HOSTED_SIZES.indexOf(size) + 1).find(next => offered.includes(next)) ?? null;
}

/**
 * "The sandbox ran out of memory (942 of 977 MiB). A larger size has more room: Standard · 2 vCPU, 4 GiB." What the
 * turn's row and a work item's question say. `offered`: the deployment's sizes, so that only one it has is named.
 */
export function outOfMemoryWords(memory: { usedMiB: number; totalMiB: number; size?: HostedSize }, offered: readonly HostedSize[] = HOSTED_SIZES, place: SandboxPlace["kind"] = "hosted"): string {
	if (place === "machine") return `The machine slot ran out of memory (limit ${memory.totalMiB.toLocaleString("en-US")} MiB). The machine’s owner can give slots more memory with --slot-memory or configure fewer slots to share the available memory.`;
	const said = `The sandbox ran out of memory (${memory.usedMiB.toLocaleString("en-US")} of ${memory.totalMiB.toLocaleString("en-US")} MiB).`;
	const from = memory.size ?? HOSTED_SIZES.find((size) => HOSTED_SIZE_SPECS[size].memoryMiB >= memory.totalMiB) ?? "large";
	const larger = largerHostedSize(from, offered);
	if (larger) return `${said} A larger size has more room: ${hostedSizeWords(larger)}.`;
	return `${said} ${memory.size ? "This is the largest size this deployment has" : "No larger size is offered here"}: have the agent's commands use less memory at once (fewer tests or workers in parallel).`;
}

/** A size this deployment's hosted layer offers, with its estimated price. */
export interface HostedSizeOption {
	id: HostedSize;
	cpus: number;
	memoryMiB: number;
	/** Estimated US dollars per hour of running, at the provider's published prices; null when not billed by time. */
	usdPerHour: number | null;
}

/** Large sandboxes use two or four slots, limited by the machine's configured capacity. */
export function sandboxSlots(requested: number, max: number) {
	return Math.min(max, requested > 2 ? 4 : requested > 1 ? 2 : 1);
}

/** One of the user's machines, as the Machines page lists it. */
export interface MachineSummary extends Partial<MachineDetails> {
	providerAccounts?: ProviderAccount[];
	/** Additive runner sizing report. Older runners report turn counts and sandbox CPU instead. */
	slots?: Pick<MachineSlotCapacity, "max" | "unit"> & { reserve?: MachineSlotCapacity["reserve"]; busy: number; queued: number };
	personalRunning?: number;
	turns?: { running: number; max: number | null; queued: number };
	host?: { cpus: number; sandboxCpus: number; memoryBytes: number; memoryFreeBytes: number; load1: number | null };
	screenshots?: boolean;
	egress?: EgressMode;
	/** With `egress` restricted: how many public hosts the owner's list allows. Absent: any public host. */
	egressDomains?: number;
	claudeRelay?: true;
	/** Owner policy, independent of Docker health. Absent until the first report. */
	allowedProfiles?: Extract<SandboxProfileId, `docker-${string}`>[];
	/** `signInReason`: with `signIn` "unknown", why the runner could not check the sign-in (runner 0.3.4 and later). */
	harnesses?: Array<{ id: Exclude<HarnessId, "windlass">; adapter: string; image: string; loginGeneration?: string; keyRelay?: true; machineProviders?: string[]; platformKeys?: ModelProvider[]; method?: "api-key" | "chatgpt" | "subscription"; modes?: string[]; modeReason?: string; signIn: "token" | "none" | "unknown"; signInReason?: string; optionsDigest?: string; optionsCheckedAt?: number; options?: HarnessOptions }>;
	machineId: string;
	/** Its latest reported name and the OS and architecture supplied at pairing. Nobody checked them. */
	name: string;
	os: string;
	arch: string;
	/** Its runner's release, as the runner last said. */
	runnerVersion: string;
	status: MachineStatus;
	/** Ms since the epoch: see `MachineStatus`. */
	since: number;
	/** How many of the user's agents were launched on it: what keeps its conversation here and cannot run again once it is removed. */
	agents: number;
	/** The sandboxes on it, the most recently used first; empty until its runner first reported. */
	sandboxes: MachineSandbox[];
	/** Whether Windlass can sandbox each command the agent runs there (the runner's probe of bubblewrap); null until its runner first reported. */
	commandSandbox: MachineProbe | null;
	/** Free space where Docker keeps the sandboxes, as last reported; null when not known. */
	freeDiskBytes: number | null;
	/**
	 * The caps its owner set on the machine, as its runner last reported: at most this many sandboxes
	 * running at once (`--max-running`) and kept at once (`--max-sandboxes`). Absent where none is set, and
	 * before its runner first reported. The platform's own limits do not apply to a machine.
	 */
	readySandboxes?: number;
	maxRunning?: number;
	maxSandboxes?: number;
	/**
	 * The snapshot and Git mirror limits in force there, in bytes, as its runner last reported: all
	 * snapshots (`--snapshot-disk`), one user's (`--snapshot-user`), and the free disk kept (`--keep-free`).
	 * `capped`: the deployment's caps changed what its owner set. `builtIn`: a runner 0.3.1 or older, which
	 * takes no flags and reports nothing; these are the limits it applies. Absent before its runner first reported.
	 */
	storeLimits?: { machine: number; user: number; free: number; capped?: true; builtIn?: true };
	/** The sandbox profiles this machine offers, for the launch form: every one, available or not; empty until its runner first reported. */
	profiles: SandboxProfile[];
	/** Whether the repository's and the account's saved secrets are sent to this machine's agents (on for a new machine). */
	sendSecrets: boolean;
	warnings: MachineWarning[];
}

/** What a machine said of itself when its runner asked to be paired: shown before the user confirms it. */
export interface MachineClaim {
	name: string;
	os: string;
	arch: string;
	runnerVersion: string;
	/**
	 * The fingerprint of the key the machine paired with ("K7Q2M-XR4TD"), worked out by the platform from
	 * the key itself. A runner that prints it (`keyPrinted`) shows the same in its terminal.
	 */
	keyFingerprint?: string;
	/** Whether this runner's version prints the key's fingerprint while it pairs. Older ones show only the code. */
	keyPrinted?: boolean;
}

// --- Work items: the software factory (Plans "software factory") ------------------------------

/** How many work items a page holds when it does not say, and at most (`listItems`). */
export const ITEM_PAGE_DEFAULT = 25;
export const ITEM_PAGE_MAX = 100;

/** Where a page of work items starts: after this item, the last of the page before. Both never change. */
export interface ItemCursor {
	createdAt: number;
	id: string;
}

/**
 * A page of the user's work items (`listItems`), in the list's order: newest filed first. `ended`
 * true keeps done, failed and cancelled ones, false keeps the others, and left out keeps both;
 * `repository` and `source` keep one repository's and one way of filing's, as the Factory's filters do.
 */
export interface ItemListPage {
	before?: ItemCursor | null;
	/** `ITEM_PAGE_DEFAULT` when left out, at most `ITEM_PAGE_MAX`. */
	limit?: number;
	ended?: boolean;
	repository?: GithubId | null;
	source?: ItemSource | null;
}

/** How many ended work items the live feed carries (`ItemFeed.ended`): the first page of them. */
export const ITEM_FEED_ENDED = 25;

/**
 * One repository's work items, filed one way, counted by where they stand (`ItemFeed.counts`). The
 * repository's owner and name are those of its newest filed item there.
 */
export interface ItemCount {
	repository: GithubId;
	owner: string;
	name: string;
	source: ItemSource;
	/** Not done, failed or cancelled. */
	open: number;
	done: number;
	failed: number;
	cancelled: number;
}

/**
 * What the user's live feed carries of their work items (`UserEvents.items`, `itemFeed`): every open
 * one, the newest filed ended ones, and how many there are of each. The ended ones beyond are read a
 * page at a time (`listItems` with `ended`). Every part holds the items the whole list does: top-level
 * items, and a feature's child while it asks a question.
 */
export interface ItemFeed {
	/** Not done, failed or cancelled; newest filed first. */
	open: ItemSummary[];
	/** At most ITEM_FEED_ENDED ended items, newest filed first: the first page `listItems({ ended: true })` answers. */
	ended: ItemSummary[];
	counts: {
		/** Every ended item, those beyond `ended` among them. */
		ended: number;
		/** One row for each repository and way of filing that has items. */
		byRepository: ItemCount[];
	};
	/**
	 * Every open subtask of a feature, asking or not, under its own title: what a feature's page, a
	 * subtask's page and the lists read to stay current while subtasks run. Absent from servers before it.
	 */
	children?: ItemSummary[];
}
//
// A work item is a task on one repository that the platform carries through a fixed sequence of
// steps (the blueprint): an agent implements it, the user's checks gate it, the platform pushes the
// branch and opens the pull request, waits for CI, gives the agent at most two rounds of fixes, and
// hands the pull request to the person with a verdict. Each item has one agent session of its own,
// listed with the user's sessions (`SessionSummary.item`). Nothing is refused for lack of capacity:
// an item that cannot go on waits, and says for what (`Waiting`). The server's own types for the
// same things (server/src/factory/types.ts) are these, extended.

/** Where an item is. "waiting" always comes with `ItemSummary.wait`. */
export type ItemState = "draft" | "queued" | "working" | "waiting" | "review" | "done" | "failed" | "cancelled";

/**
 * What a waiting item waits for. "person" and "budget": a question to the person (`ItemSummary.question`);
 * the others end by themselves: "capacity" a free hosted sandbox, or the day's allowance; "machine" the
 * user's machine; "ci" CI on the pushed commit.
 */
export type WaitReason = "provider" | "children" | "capacity" | "machine" | "ci" | "person" | "budget" | "integration" | "sandboxes";

/** A wait as a person reads it: one reason, a sentence with its numbers, and when it is next tried. */
export interface Wait {
	/** The sign-in whose cooldown holds this item, when known. */
	accountKey?: string;
	reason: WaitReason;
	/** "Waiting for one of your 5 factory turns; 5 are running (…)." */
	sentence: string;
	/** When it is tried again, ms since the epoch; null for a wait only a person ends. */
	retryAt: number | null;
}

export interface Waiting extends Wait {
	/** Since when the item waits for this reason. */
	since: number;
}

/**
 * A step of the blueprint. "implement", "ci_fix", "conflict", "review_fix" (and "refine", which is not offered yet)
 * are builder turns; "review" is a turn of the second agent; "gate" and "handoff" are the platform's decisions; "publish" is the
 * platform pushing; "ci" and "merged" are waits on GitHub.
 */
export type StepKind = "plan_review" | "subtasks" | "integration" | "summary" | "refine" | "implement" | "gate" | "publish" | "ci" | "ci_fix" | "run_checks" | "conflict" | "review" | "review_fix" | "handoff" | "merged";

/** The step a run is at. */
export interface ItemStep {
	/** Dense within its run, from 1. */
	n: number;
	kind: StepKind;
	/** From 1: a step tried again (after an interruption, a retried push, every poll of a wait) is a new attempt. */
	attempt: number;
	startedAt: number;
	/** For a turn step: delivered to the session and not started yet, started, or null once it ended. */
	turn: "delivered" | "started" | null;
	/** How many times the session was asked whether the turn still runs. */
	checks: number;
	/** How many times this step's turn was cut off, by a deploy or a restart (at most 3). */
	interruptions: number;
	/** Turns of this step whose sandbox could not be prepared (`sandboxFailed`) since the last that could. */
	sandboxFailures?: number;
	/** Consecutive automatic retries after a provider refusal on this step. */
	providerRetries?: number;
	/** The person was asked in this step about the hosted cap on kept sandboxes (question "sandboxes"): not asked again. */
	capAsked?: true;
	/** The person was asked in this step whether to go on waiting for a machine that stayed away (question "machine_away"): not asked again. */
	awayAsked?: true;
}

/** One run of the blueprint: an item has a new one when it is retried or sent back. */
export interface ItemRun {
	/** Automatic recovery choices taken in this run (zero on older runs). */
	autoSteps?: number;
	n: number;
	startedAt: number;
	endedAt: number | null;
	/** Why it ended other than by handing over: "cancelled", "retried", or the cause of the question given up on. */
	stopReason: string | null;
	step: ItemStep;
	/**
	 * The rounds of each kind used in this run, shown on the item's page and never capped: fixing after the checks, after
	 * CI, merging the base, after the second review; `plan` counts planning turns. A run stops when the same failure comes
	 * back (the stuck detector), when its budget is used, or at the backstop on an item's turns. `review` is absent on runs
	 * stored before it was counted.
	 */
	rounds: { plan: number; gate: number; ci: number; conflict: number; review?: number };
}

/** The work as the item was given it. `base` is the branch its pull request goes into. */
export interface ItemTask {
	title: string;
	body: string;
	/** What a person will check, one criterion each; listed in the verdict, not checked by a machine. */
	acceptance: string[];
	base: string;
}

/**
 * An item's budget: what stops it and asks its person when used up. `tokens` are cost-weighted
 * (factory/budget.ts `weightedTokens`: cached input counts at `CACHED_INPUT_WEIGHT`); hosted seconds are a
 * limit only where the item's sandbox is hosted.
 */
export interface ItemBudget {
	tokens: number;
	hostedSeconds: number;
}

/**
 * What an item has spent: its budget's figures, and what is shown beside them. `rawTokens`: every token as
 * the agent reported it, cached input at full count (absent on items stored before it was kept: `tokens`).
 * `turns` and `activeSeconds` bound nothing a person sets: the turns are held to an internal backstop
 * (blueprint.ts `RULES.turnBackstop`), and active time excludes waiting for a machine, capacity, CI or a person.
 */
export interface ItemSpend extends ItemBudget {
	rawTokens?: number;
	turns: number;
	activeSeconds: number;
}

/** A subtask's budget in a feature's plan: one token figure. At dispatch its token share also determines its share of hosted time. */
export type SubtaskBudget = Pick<ItemBudget, "tokens">;

/** Effective account limits after applying the operator’s overrides to the deployment defaults. */
export interface FactoryLimits {
	dailyTokens: number | null;
	/** Items filed from GitHub issues a day, drafts among them: one guard against a flood of filings. */
	githubItemsPerDay: number;
	attachments: { bytes: number; perItem: number; accountBytes: number; days: number };
	/** The user's hosted sandboxes running at once: factory turns and the person's own hosted agents together. Machines never count. */
	hostedRunning: number;
	/** A new item's budget. */
	item: ItemBudget;
}

/** "turn_refused": the session or provider refused the turn, in its words. "sandboxes": the hosted cap on kept sandboxes stopped a turn. "check_environment": a check failed because the sandbox could not run it (`ItemQuestion.check`). */
export type QuestionKind = "push_ci" | "feature_update" | "sandboxes" | "integration" | "feedback_feature" | "feedback_more" | "placement_refused" | "single_suggested" | "replan_approval" | "plan_approval" | "rounds" | "budget" | "no_change" | "publish_refused" | "ci_timeout" | "turn_refused" | "machine_removed" | "review_question" | "agent_ask" | "secret_needed" | "check_environment" | "sandbox_failed" | "out_of_memory" | "machine_away";

/**
 *   approve     the plan is approved: implement it
 *   revise      plan again, with the person's note
 *   raise       "Raise the limit and go on": the round counter that stopped is reset, or the budget raised
 *   retry       "Retry from scratch": a new run
 *   again       try the same thing again (a turn that changed nothing, a refused push, a check the environment could not run)
 *   wait        keep waiting for CI
 *   hand_over   hand the pull request to the person as it is, with its verdict
 *   give_up     the item fails
 *   reply       "Answer the agent" (an `agent_ask` question): the note is the answer, and is needed
 *   fresh_sandbox  a `sandbox_failed` question: the session's sandbox is removed and the step runs in a new one
 *   larger_sandbox an `out_of_memory` question: the same, in a sandbox of the next hosted size
 */
export type ChoiceId = "send_back" | "dismiss" | "send" | "leave" | "run_single" | "orchestrate_anyway" | "approve" | "revise" | "raise" | "retry" | "again" | "wait" | "hand_over" | "give_up" | "fix" | "add_secret" | "without_secret" | "reply" | "run_anyway" | "fresh_sandbox" | "larger_sandbox" | "run_checks" | "ci_alone" | "update_from_base" | "update_feature";

/** Render the reason as quoted plain text, separately from the platform's own notice. */
export interface SecretRequest {
	name: string;
	why: string;
	/** Platform-authored provenance and save destination, one line each. Absent on older requests. */
	notice?: string;
}

export interface SetRequestedSecretInput {
	/** The open item question's id or SessionSnapshot.secretRequest.id, on the requesting session. */
	requestId: string;
	name: string;
	value: string;
}

/** What an item asks its person ("Needs you"). It waits until answered, for days if need be. */
export interface ItemQuestion {
	/** Unique within the item: what `ItemAction` "answer" names. */
	id: string;
	kind: QuestionKind;
	/** Current repository requirement blocking approval of this plan. */
	approvalBlock?: string;
	criticFindings?: string[];
	text: string;
	choices: Array<{ id: ChoiceId; label: string }>;
	/** Suggested answer. Older clients and stored questions may omit it. */
	recommended?: ChoiceId;
	askedAt: number;
	secret?: SecretRequest;
	/**
	 * An `agent_ask` question's own words, as the builder wrote them (`ask_person`): untrusted text, which
	 * the agent may have been steered to write by what it read. Shown quoted, as the agent's, in plain
	 * text; never Markdown, never in `text`, never posted anywhere. `options`: answers it suggests.
	 */
	asked?: { text: string; options: string[] };
	/**
	 * A `check_environment` question's check: one of the user's that failed because the sandbox could not run it
	 * (factory/check-environment.ts), with the first line that shows why and the end of what it printed. The
	 * output is the command's, shown as output, in plain text.
	 */
	check?: { name: string; command: string; exitCode: number | null; kind: "package_manager" | "network" | "not_found"; line: string; excerpt: string };
	/** An `out_of_memory` question's next hosted size: what "Go on in a larger sandbox" makes. */
	largerSize?: HostedSize;
}

/** An entry of an item's log, oldest first: every change of the item, and what caused it. */
export interface ItemEvent {
	/** Why a run ended before its normal handoff. */
	stopReason?: "feedback";
	at: number;
	/** "person:<uid>" or "platform". */
	by: string;
	/** The step it happened in; null outside a run. */
	step: { run: number; n: number; kind: StepKind; attempt: number } | null;
	said: string;
	/**
	 * On the entry of an `agent_ask` question: the agent's own words (`Question.asked.text`), kept after the
	 * question is answered. Untrusted, as there: shown quoted, as the agent's, in plain text; never in `said`.
	 */
	asked?: string;
}

/** A check run or commit status of CI, as the verdict lists it. */
export interface VerdictRun {
	/** A cancellation without evidence of runner starvation or timeout. */
	stopped?: true;
	name: string;
	/** The app that reported it ("github-actions"), or "status" for a commit status. */
	app: string;
	/** GitHub's conclusion, or `not_run` for a failure GitHub attributed to a job it never started. */
	conclusion: string;
	url: string;
}

/**
 * What the work at a pushed commit rests on, for the person to read: made from what the session's
 * gate recorded (`Verified`), the observations on the changes (`VerifiedFlag`) and CI, never from the
 * agent's words. `result`: "fail" a check or CI failed; "incomplete" the turn did not finish;
 * "unverified" nothing verified this state of the work; "pass" otherwise. A pass with flags needs a
 * look; a verdict never merges anything.
 */
export interface Verdict {
	id: string;
	item: string;
	run: number;
	/** The commit it is for. */
	head: string;
	at: number;
	place: "hosted" | "machine";
	attestedBy: "platform" | `machine:${string}`;
	result: "pass" | "fail" | "incomplete" | "unverified";
	gate: {
		state: Verified["state"] | null;
		/** The user's checks in the run the work rests on. */
		required: Array<{ name: string; status: CheckStatus; sentBack: number }>;
		unneeded?: Verified["unneeded"];
	};
	/**
	 * "not_run": GitHub did not start a job (`said` is its reason);
	 * "not_permitted": GitHub would not show the platform this repository's CI (`said` is GitHub's words);
	 * "timed_out": still running when the work was handed over; "unread": the platform could not read it
	 * (GitHub did not answer while it waited), or not all of it (more checks than it reads: `said`
	 * says so), so nothing is claimed of what was not read. "none" only when GitHub was read and
	 * listed no CI at all; "skipped": CI ran and finished, and none of its checks passed (all skipped or neutral). "cancelled" includes stale checks.
	 */
	ci: { state: "passed" | "failed" | "none" | "skipped" | "cancelled" | "not_run" | "timed_out" | "not_permitted" | "unread"; runs: VerdictRun[]; said: string | null };
	flags: VerifiedFlag[];
	acceptance: string[];
	mergeable: boolean | null;
	/**
	 * The commit the pull request held when the verdict was made, when it is not `head`: pushed to its branch after the agent's
	 * work, and verified by nothing. Such a verdict is never a pass; `said.ci` says so.
	 */
	moved: string | null;
	/** CI, and each of `flags` (in the same order), in a sentence as the server words them for the item's log and the pull request. */
	said: { ci: string; flags: string[] };
}

// ---------------------------------------------------------------------------------------------
// Reviews and reports: what an agent writes for the item's page (Plans "reviewer and its page" §2.2).
// In R1 the builder's report is the only author; the reviewer files ReviewInput from R3 on.
// ---------------------------------------------------------------------------------------------

/** What a reviewer recommends. It never changes `Verdict.result`. */
export type ReviewRecommendation = "approve" | "changes_requested" | "needs_person";

/**
 * Plain text the web app renders itself: paragraphs (blank lines), lines starting "- " as bullets,
 * `code` spans, and fenced code blocks of at most REVIEW_LIMITS.fenceLines lines. Nothing else is
 * interpreted: no links, no images, no HTML, no headings, no emphasis. Saved secrets and control
 * characters are removed before it is stored.
 */
export type ReviewText = string;

/** A place in the repository: a path at the head (or at the base, for removed lines). */
export interface ReviewLocation {
	/** Repository-relative: no "..", no leading "/", no NUL, at most REVIEW_LIMITS.pathChars. */
	path: string;
	/** Default "head". */
	side?: "head" | "base";
	/** 1-based, `end >= start`, at most REVIEW_LIMITS.locationLines lines. */
	lines?: { start: number; end: number };
}

/**
 * A record of the platform's, by the id the platform gave it: `check/<n>` (Verdict.gate.required[n]),
 * `ci/<n>` (Verdict.ci.runs[n]), `flag/<kind>` (one of Verdict.flags), `command/<id>` (a command the
 * reviewer ran in its turn, by Windlass's "<message>/<call>"; from R3). `says` is the author's claim
 * of it; the page shows the platform's record beside the claim.
 */
export interface ReviewRef {
	ref: string;
	says?: "passed" | "failed" | "ran" | "not_run";
}

/** The blocks as a reviewer files them (R3). */
export type ReviewBlockInput =
	| { kind: "summary"; text: ReviewText }
	| { kind: "text"; heading?: string; text: ReviewText; refs?: ReviewRef[] }
	| { kind: "finding"; severity: "blocking" | "should_fix" | "note"; title: string; text: ReviewText; at?: ReviewLocation[]; refs?: ReviewRef[]; /** An earlier round's finding id (r1.f2) this one continues. */ continues?: string }
	| { kind: "earlier"; finding: string; status: "fixed" | "not_fixed" | "withdrawn"; text?: ReviewText }
	| { kind: "risk"; text: ReviewText; at?: ReviewLocation[] }
	| { kind: "question"; text: ReviewText }
	| { kind: "excerpt"; at: ReviewLocation & { lines: { start: number; end: number } }; note?: ReviewText }
	| { kind: "screenshot"; file: string; caption: string; shows?: "after" | "before"; page?: string };

export interface ReviewInput {
	recommendation: ReviewRecommendation;
	blocks: ReviewBlockInput[];
}

/** One of the platform's records as it was when the text was filed: what a `ReviewRef` shows. */
export type ReviewRecord =
	| { ref: string; kind: "check"; name: string; status: CheckStatus }
	| { ref: string; kind: "ci"; name: string; app: string; conclusion: string; url: string }
	| { ref: string; kind: "flag"; flag: VerifiedFlag }
	| { ref: string; kind: "command"; command: string; exitCode: number | null; outcome: string; /** At most 20 lines, redacted. */ tail: string };

/** The blocks as stored and shown: ids assigned, references resolved, code fetched (R3), files stored (R2). */
export type ReviewBlock =
	| { kind: "summary"; text: string }
	| { kind: "text"; heading: string | null; text: string; refs: ReviewRef[] }
	| { kind: "finding"; id: string; root: string; severity: "blocking" | "should_fix" | "note"; title: string; text: string; at: ReviewLocation[]; refs: ReviewRef[] }
	| { kind: "earlier"; finding: string; status: "fixed" | "not_fixed" | "withdrawn"; text: string | null }
	| { kind: "risk"; text: string; at: ReviewLocation[] }
	| { kind: "question"; text: string }
	| { kind: "excerpt"; at: ReviewLocation; code: string; note: string | null }
	| { kind: "screenshot"; attachment: string };

export interface ItemAttachment {
	id: string;
	by: "builder" | "reviewer";
	sessionId: string;
	/** The published commit for the builder's filing, or the reviewer's checkout. Null until known. */
	head: string | null;
	width: number;
	height: number;
	bytes: number;
	sha256: string;
	caption: string;
	shows: "after" | "before" | null;
	page: string | null;
	state: "kept" | "removed";
}

/**
 * What the agent that made the change filed with `report`, as the item's page shows it: its own words,
 * labelled as the author's. Turned into blocks by the platform (review.ts `reportBlocks`): a `text`
 * block "What it did" (the description), a `text` block "Where to look" (`look_at`), and a `risk` for
 * what it is unsure of, followed by a `screenshot` block for each verified image.
 */
export interface ItemReport {
	screenshots: ItemAttachment[];
	by: "builder";
	sessionId: string;
	run: number;
	/** The step attempt's key it was filed in: <item>:<run>:<step>:<attempt>. */
	key: string;
	/** The commit published for this report's turn, or null until known. */
	head: string | null;
	at: number;
	title: string;
	blocks: ReviewBlock[];
	/** Referenced platform records at filing time. Builder blocks have no references in R1. */
	records: ReviewRecord[];
}

/** A review of one pushed head. Its id is the review step attempt's key. */
export interface ItemReview {
	/** Advisory review requested on this GitHub pull request. */
	requestedPull?: { owner: string; name: string; pr: number };
	screenshots: ItemAttachment[];
	id: string;
	run: number;
	round: number;
	head: string;
	base: string;
	verdictId: string;
	by: { sessionId: string; model: string; via?: "host" | "mcp"; commandSandbox?: "windlass" | "none" | "unknown" };
	at: number;
	state: "filed" | "none";
	said: string | null;
	recommendation: ReviewRecommendation | null;
	blocks: ReviewBlock[];
	records: ReviewRecord[];
	notes: string[];
}

export const REVIEW_LIMITS = {
	inputBytes: 96 * 1024,
	totalChars: 40_000,
	blocks: 60,
	summaryChars: 1_500,
	textChars: 4_000,
	headingChars: 80,
	findings: 30,
	findingTitleChars: 160,
	findingChars: 2_000,
	locationsPerBlock: 5,
	refsPerBlock: 8,
	earlierChars: 600,
	risks: 10,
	riskChars: 1_000,
	questions: 5,
	questionChars: 600,
	excerpts: 10,
	excerptLines: 40,
	excerptLineChars: 300,
	screenshots: 8,
	captionChars: 200,
	pageChars: 300,
	paths: 20,
	refs: 40,
	fenceLines: 60,
	pathChars: 300,
	locationLines: 200,
	lookAtChars: 1_000,
} as const;

/** An item as the user's index lists it. */
/** Which agent an item's builder runs, on which model, and what that agent said it used. */
export interface ItemAgent {
	harness: HarnessId;
	/** The builder session's model: one of the account's for Windlass, the agent's own id ("sonnet") or "default" for a machine harness. */
	model: string;
	/** The effort its turns run at (`CreateItemInput.effort`); null or absent: the agent's default. */
	effort?: string | null;
	/**
	 * How the machine's agent was signed in when the item was filed, where that decides whether its tokens
	 * count against the item budget. Its turns run only while the machine reports the same. Absent elsewhere.
	 */
	signIn?: "api-key" | "chatgpt" | "subscription";
	/**
	 * How the item's tokens are known.
	 * - "counted": reported, and counted against `budget.tokens` (Windlass; an agent on an API key).
	 * - "subscription": reported and shown, never counted: the agent's sign-in is a subscription, not billed
	 *   by token, so the item's turns and active time bound it.
	 * - "not_reported": the agent has reported none (yet): `spent.tokens` is not a measurement.
	 */
	tokens: "counted" | "subscription" | "not_reported";
	/** Every token the agent reported over the item's turns, counted or not. */
	reportedTokens: number;
	/** The cost the agent reported for its conversation so far (OpenCode's `usage_update.cost`); null where it reported none. */
	cost: { amount: number; currency: string } | null;
	/** Claude Code's 5-hour window, % used, at the start of the item's first turn and at the end of its latest. */
	fiveHour: { first: number; latest: number } | null;
}

/** How a work item was filed. "github" and "linear" are the two intakes that file from an issue (factory/intake.ts). */
export type ItemSource = "web" | "api" | "github" | "linear";

/**
 * A work item filed from a GitHub issue. `issue.number` is the issue's own number in `ItemSummary.repository`;
 * the item's pull request closes it. `sender` is the GitHub login that added the label or wrote the command.
 */
export interface GithubIssueOrigin {
	issue: { number: number; url: string; author: string; trusted: boolean };
	sender: string;
	linear?: undefined;
}

/**
 * A work item filed from a Linear issue. Linear has no GitHub issue number: nothing here is polled, commented on or closed
 * (the integration is one-way). `identifier` is the issue's own ("ENG-12"), `url` its page, `author` the creator's name and
 * `sender` the name of the person who labelled or assigned it. `trusted` is true when the creator is the Linear user who
 * connected the workspace: otherwise the item is a draft and its text is third-party text.
 */
export interface LinearIssueOrigin {
	linear: { id: string; identifier: string; url: string; author: string; trusted: boolean };
	sender: string;
	issue?: undefined;
}

export type ItemOrigin = GithubIssueOrigin | LinearIssueOrigin;

export interface ItemSummary {
	/** Its builder session has not been created yet. */
	awaitingPlace?: boolean;
	/** Absent for items filed before agents could be chosen: Windlass. */
	agent?: ItemAgent;
	placement?: ChildPlacement;
	mode?: ItemMode;
	parent?: { itemId: string; key: string; title: string } | null;
	id: string;
	title: string;
	/** The repository of the user's GitHub connection it is on; `branch` is the base its pull request goes into. For a cross-repo feature, its primary. */
	repository: SessionRepository;
	/** A cross-repo feature's repositories, the primary first. Absent: the one repository. */
	repositories?: FeatureRepoView[];
	/** A cross-repo feature's combined run. */
	integration?: IntegrationView;
	place: SandboxPlace;
	/** How the item was filed. */
	source: ItemSource;
	/** The issue it was filed from: null unless `source` is "github" or "linear" (a GitHub issue's origin has `issue`, a Linear issue's has `linear`). */
	origin: ItemOrigin | null;
	state: ItemState;
	/** Set exactly when `state` is "waiting". */
	wait: Waiting | null;
	/** The open question, if any. */
	question: ItemQuestion | null;
	pullRequest: { number: number; url: string } | null;
	/** The latest verdict's result and flags; null before the first. */
	verdict: { result: Verdict["result"]; flags: VerifiedFlag[]; ci: Verdict["ci"]["state"] } | null;
	/** The second review for this run, or null before one is due. */
	review: { state: "waiting" | "running" | "filed" | "none" | "off"; recommendation: ReviewRecommendation | null } | null;
	budget: ItemBudget;
	spent: ItemSpend;
	/** The item's agent session, among the user's sessions. */
	sessionId: string;
	createdAt: number;
	/** When the item last changed. */
	updatedAt: number;
	/** When it ended (done, failed or cancelled). Absent while it is open, and on an item that ended before the platform kept the time. */
	endedAt?: number;
	/** Increased by every change: a client that holds an `ItemView` of a lower revision asks for it again. */
	revision: number;
	/** The step its run is at, while the run goes on: what a list row says it is doing without reading the page. */
	step?: ItemSummaryStep;
}

/** The step of `ItemSummary.step`: its kind, since when, its turn, and the rounds of fixing used. */
export interface ItemSummaryStep {
	kind: StepKind;
	startedAt: number;
	turn: ItemStep["turn"];
	rounds: ItemRun["rounds"];
}

/** An item's page. */
export type CheckConclusion = "success" | "action_required" | "failure" | "cancelled";

export interface FeedbackEntry {
	id: string;
	author: string;
	access: "owner" | "write";
	kind: "changes_requested" | "commented" | "issue_comment" | "review_comment";
	body: string;
	path: string | null;
	line: number | null;
	commit: string | null;
	url: string;
	at: number;
}

export interface FeedbackBatch {
	savedPlan?: { goal: string; subtasks: string[] };
	entries: FeedbackEntry[];
	state: "pending" | "held" | "question" | "taken" | "declined";
	reason: string;
	run: number | null;
	plan: number | null;
}

/** A refused destination. DNS observations have no port and count the first lookup seen by the hosted stub.
 * An unparseable proxy destination has no host. Times are Unix milliseconds. For repeated destinations
 * the strongest refusal wins (private, provider, malformed, machine_policy, unlisted). Only "repository" offers allowHost.
 * With "machine", direct the owner to --egress-domains on the named machine. "never" is blocked by design.
 */
export interface BlockedHost {
	host: string | null;
	port: number | null;
	reason: "machine_policy" | "unlisted" | "private" | "provider" | "malformed";
	/** Paired machine display names, including both when an item combines matching destinations. */
	machineNames?: string[];
	allow: "repository" | "machine" | "deployment" | "never";
	firstAt: number;
	lastAt: number;
	count: number;
}

export interface BlockedNetwork {
	hosts: BlockedHost[];
	/** Number of requests to destinations beyond the session's first 50, including their retries. */
	overflow: number;
}

export interface ItemView extends ItemSummary {
	/** Commits on the target missing from the feature. Absent when the comparison is unavailable. */
	featureTargetAhead?: number;
	canUpdateFeature?: boolean;
	/** Union by host and port across all turns of the builder and reviewer. Absent on older servers. */
	blockedNetwork?: BlockedNetwork;
	feedback: { batches: FeedbackBatch[]; notTaken: number };
	verifiedCheck: { sha: string; state: "in_progress" | "completed" | "not_posted"; conclusion: CheckConclusion | null; said: string } | null;
	canRetry?: boolean;
	plan?: FeaturePlan | null;
	/**
	 * With a plan: the keys of its subtasks still to run whose agent works without asking, as approval counts
	 * them (`unattendedKeys`, past the integrated subtasks); approving needs the person's confirmation of each.
	 */
	unattended?: string[];
	/** With a plan: the keys of its subtasks whose work is integrated, which approval neither places nor confirms again. */
	completedSubtasks?: string[];
	/** After a re-plan: why the feature was planned again, in a short sentence ("A pull request comment asked for changes"). */
	replanWhy?: string;
	children?: ItemSummary[];
	/** Dispatched subtasks including placement waits. The start time is null for older jobs. */
	subtasks?: { id: string; key: string; state: ItemState; dispatchedAt: number | null; startedAt: number | null; wait: string | null }[];
	/** Current owner policy for the places named in the proposed plan. */
	placementReview?: { name: string; sendSecrets: boolean }[];
	/** The builder's last report in the run shown, as the page shows it; null before one was filed. */
	report: ItemReport | null;
	/** Last ten, oldest first. */
	reviews: ItemReview[];
	reviewerSessionId: string | null;
	reviewNone: string | null;
	task: ItemTask;
	/** The run it is in, or ended last, with the rounds a run allows; null before it was started. */
	run: (ItemRun & { failureFingerprint?: string | null }) | null;
	/** The commit pushed last. */
	head: string | null;
	/** Its log, oldest first: the runs and steps before the current one are read from it. */
	events: ItemEvent[];
	/** Every verdict, the oldest first. */
	verdicts: Verdict[];
}

export type ItemMode = "single" | "orchestrate";

export interface PlacementNeeds {
	tags?: string[];
	screenshots?: boolean;
	egress?: "open" | "restricted";
	profile?: "docker-hardened" | "docker-windlass-sandbox" | "e2b-open";
	cpus?: number;
	memoryGiB?: number;
}

/**
 * The agent a Plan-first subtask's item runs, as the planner proposed it or the person chose it on the
 * approval card. Absent: Windlass on the feature's model and effort. A machine harness (Claude Code,
 * OpenCode) works without asking and runs only on a machine signed into it, in its hardened container;
 * approving a plan that names one needs the person's confirmation of each such subtask (`approve_plan`'s
 * `agents`). Codex is not offered for work items.
 */
export interface SubtaskAgent {
	harness: HarnessId;
	/** One the place offers for this agent. Left out: the feature's model for Windlass, the agent's own default otherwise. */
	model?: string;
	/** One the place offers for the model. Left out: the feature's effort for Windlass on its model, the agent's default otherwise. */
	effort?: string;
}

export interface ChildPlacement {
	place: SandboxPlace;
	name: string;
	reason: string;
	units: number;
	sendSecrets: boolean;
	profile?: SandboxProfileId;
	/** A machine harness the subtask asked for (`needs.harness`); absent: Windlass. */
	harness?: HarnessId;
	/** Hosted: the size its `cpus` and `memoryGiB` chose (`hostedSizeFor`). Absent: the feature's size. */
	hostedSize?: HostedSize;
}

export interface PlanSubtask {
	/** Older plans inherit the feature's place. */
	place?: { prefer: string; reason: string; allow?: string[] };
	needs?: PlacementNeeds;
	/** Absent: Windlass on the feature's model. */
	agent?: SubtaskAgent;
	/** A cross-repo feature's subtask: the alias of the filing's repository it builds in (`FeatureRepository.alias`). Absent: the primary. */
	repo?: string;
	key: string;
	title: string;
	brief: string;
	acceptance: string[];
	dependsOn: string[];
	owns: string[];
	budget: SubtaskBudget;
}

/**
 * One repository of a cross-repo feature in its merge order: which repositories must merge before it
 * (merge prerequisites, separate from the subtasks' build dependencies), what keeps working between the
 * merges, what shows it, and what to do if a later merge does not happen.
 */
export interface MergeStep {
	repo: string;
	prerequisite: string[];
	intermediate: string;
	evidence: string;
	fallback: string;
}

/** A small named check of one repository against a sibling's integrated head. Stored with the plan, not run yet. */
export interface EarlyCheck {
	repo: string;
	sibling: string;
	name: string;
	command: string;
}

/**
 * The combined run a cross-repo feature needs before it is handed over: every repository at its
 * integrated head, tested together (docs/factory, "Cross-repo features"). `runFrom` is the alias of the
 * repository whose workflow runs it; `command` runs there, with every input checked out beside it.
 */
export interface FinalIntegration {
	runFrom: string;
	command: string;
	inputs: string[];
	/** Where it runs. "actions": the `runFrom` repository's integration workflow, on GitHub's runners. */
	profile: "actions";
	timeoutSeconds: number;
	requiredCases: string[];
	artifactOutputs: string[];
}

export interface FeaturePlanEdit {
	/** A cross-repo feature: the aliases of its filing's repositories, the primary first. Absent on a one-repository plan. */
	repos?: string[];
	mergeOrder?: MergeStep[];
	/** "request": the feature ends at a tested set and a release request. "wait": it waits for the owner's release and adopts it (not offered yet). */
	releaseGate?: "request" | "wait";
	earlyChecks?: EarlyCheck[];
	finalIntegration?: FinalIntegration;
	overflow?: boolean;
	/**
	 * The plan's questions to the owner: `text` one short sentence, `options` short answers to choose from,
	 * `why` the background in a few sentences (shown folded under the question). Older plans have no `why`.
	 */
	questions: { id: string; text: string; options?: string[]; why?: string; answer?: string }[];
	spec: { goal: string; requirements: string[]; outOfScope: string[]; acceptance: string[] };
	subtasks: PlanSubtask[];
	singleSuggested: string | null;
}

export interface FeaturePlan extends FeaturePlanEdit {
	version: number;
	status: "proposed" | "approved" | "superseded";
	budget: ItemBudget;
	compare: { singleBudget: ItemBudget };
	approvedBy?: string;
	approvedAt?: number;
}

/** A repository a cross-repo feature is filed over: a short alias for its mounts and results, GitHub's id for it and its base branch. */
export interface FeatureRepoInput {
	/** `^[a-z][a-z0-9-]{0,15}$`, unique in the filing. */
	alias: string;
	id: GithubId;
	branch?: string;
}

/** A repository of a cross-repo feature as the server bound it at filing. GitHub's ids are the authority; the alias only labels. */
export interface FeatureRepository {
	alias: string;
	repositoryId: GithubId;
	installationId: GithubId;
	owner: string;
	name: string;
	url: string;
	private: boolean;
	baseRef: string;
	/** The base's commit when the feature was filed: what the planner read. */
	planningBaseSha: string | null;
}

/** A repository of a cross-repo feature on its page: where its feature branch, pull request and merge stand. */
export interface FeatureRepoView extends FeatureRepository {
	primary: boolean;
	featureRef: string | null;
	seedSha: string | null;
	markerSha: string | null;
	/** The commit the feature branch was last fast-forwarded to by the platform. */
	integratedHead: string | null;
	pr: { number: number; url: string; draft: boolean } | null;
	/** What GitHub said of the pull request when it was last read. */
	prState: "open" | "draft" | "merged" | "closed" | null;
	mergedCommit: string | null;
}

/** The combined run of a cross-repo feature (`FinalIntegration`), as its page shows it. */
export interface IntegrationView {
	state: "not_run" | "queued" | "running" | "passed" | "failed" | "timed_out" | "cancelled" | "stale" | "unavailable";
	attempt: number;
	/** The heads it ran on, by alias; null before a run. */
	heads: Record<string, string> | null;
	url: string | null;
	said: string | null;
}

export interface CreateItemInput {
	/** Resolve the saved placement again at filing. An explicit place overrides this. */
	useDefaultPlace?: boolean;
	mode?: ItemMode;
	/**
	 * Plan first only, and only where the deployment allows cross-repo features (WLP_FACTORY_CROSS_REPO=1):
	 * the feature's repositories, one or two, the first being `repository`. Left out: the one repository.
	 */
	repositories?: FeatureRepoInput[];
	/** A repository of the user's GitHub connection, by GitHub's id for it, and the base branch (default: the repository's default branch). */
	repository: { id: GithubId; branch?: string };
	/** At most MAX_TITLE_CHARS. */
	title: string;
	/** At most MAX_ITEM_BODY_CHARS. */
	body: string;
	/** At most MAX_ACCEPTANCE_CRITERIA, each at most MAX_NOTE_CHARS. */
	acceptance?: string[];
	/** The agent's sandbox profile and model. A hosted item uses the usual defaults. */
	profile?: SandboxProfileId;
	/** One of the account's models for Windlass; for a machine harness one its machine reported (`HarnessOptions.models`). Left out: the agent's default. */
	model?: string;
	/**
	 * The reasoning effort of every turn of the item's builder: one its agent reported for the item's model
	 * (`ModelChoice.efforts`; for a machine harness model whose efforts it reports only once selected, one it
	 * reported for any model). Left out: the agent's default. Refused (`bad_effort`) otherwise.
	 */
	effort?: string;
	/**
	 * The builder's agent: "windlass" (the default), or a harness the chosen machine reports and is signed
	 * into (`MachineSummary.harnesses`), which runs in its hardened container. Not on hosted, not with Plan
	 * first. The second reviewer uses the same agent and place.
	 */
	harness?: HarnessId;
	/** Left out: hosted. On a paired machine, use the requested profile if available, otherwise its first available profile. */
	place?: SandboxPlace;
	/** Hosted only: the size of the item's sandboxes. Left out: the repository's saved size, else standard. A Plan-first subtask whose plan names `cpus` or `memoryGiB` gets the least size that has them, if larger. */
	hostedSize?: HostedSize;
	/** True: started at once, as "Start" would. Left out: the item is a draft until started. */
	start?: boolean;
	/** As `CreateSessionInput.idempotencyKey`: the same key again answers with the item the first attempt made. */
	idempotencyKey?: IdempotencyKey;
}

/** What a person does to an item: each is refused (`item_conflict`) where the item's state does not allow it. */
export type ItemAction =
	| { kind: "update_feature" }
	| { kind: "cancel_subtask"; key: string }
	| { kind: "edit_plan"; version: number; plan: FeaturePlanEdit }
	/**
	 * `agents`: the keys of the subtasks still to run whose agent works without asking (`SubtaskAgent`), each
	 * one confirmed by the person. Approval is refused (`bad_input`) unless it lists every one of them.
	 * `bases`: a cross-repo feature's repositories whose base moved since the planner read it, by alias, each
	 * with the new commit the person reconfirms the plan on; approval names the move and is refused without it.
	 */
	| { kind: "approve_plan"; version: number; agents?: string[]; bases?: Record<string, string> }
	| { kind: "run_single" }
	/** After approval: the agent a subtask that has not started runs; null runs Windlass on the feature's model. */
	| { kind: "set_subtask_agent"; key: string; agent: SubtaskAgent | null }
	/** A draft: start it. */
	| { kind: "start" }
	| { kind: "cancel" }
	/** A failed item: start a new run. */
	| { kind: "retry" }
	/** An item in review: a new run, with the person's note to the agent. */
	| { kind: "send_back"; note: string }
	/** A note to the builder: into its running turn, or with its next turn. */
	| { kind: "note"; note: string }
	/** The open question: one of its choices, with a note to the agent, and for "raise" on a budget question the new budget. */
	| { kind: "answer"; question: string; choice: ChoiceId; note?: string; budget?: Partial<ItemBudget>; agents?: string[] };

/** What an API token may do. */
export type ApiTokenScope = "items:create" | "items:read";

/**
 * A token for the platform's HTTP API (`POST /api/items`, `GET /api/items/<id>`), sent as
 * `Authorization: Bearer wlp_…`. Its value is shown once, when it is made; the platform keeps only a
 * digest of it. It works until it is revoked.
 */
export interface ApiToken {
	id: string;
	name: string;
	scopes: ApiTokenScope[];
	createdAt: number;
	/** When it was last used, to the minute; null before. */
	usedAt: number | null;
}

export interface UserActions {
	signOutEverywhere(options?: { revokeApiTokens: boolean }): Promise<void>;
	me(): Promise<UserProfile>;
	chatgpt(): Promise<ChatgptStatus>;
	/**
	 * The models the user may choose and the efforts of each. Never throws for a list that cannot be
	 * read: the answer is then the last one that was, or the stand-in, and `source` says which.
	 */
	models(): Promise<ModelList>;
	/** The user's GitHub connection. Throws a UserError with code `github_off` when the deployment has no GitHub App. */
	github(): Promise<GithubStatus>;
	/**
	 * Begins connecting GitHub and returns the address at GitHub to send the browser to. `origin` is the
	 * web app's own address, where the browser is sent back to: with `#github=<ticket>` when GitHub
	 * confirmed which installations this GitHub user can reach, or `#github-error=<code>` when not.
	 * With `install` the address is the app's installation page, for adding another account to a
	 * connection; without it GitHub is first asked who the user is, and they are sent on to install the
	 * app only when it is installed nowhere they can reach.
	 */
	githubConnect(input: { origin: string; install?: boolean }): Promise<{ url: string }>;
	/**
	 * Finishes connecting with the ticket the browser came back with. A ticket is good for a few minutes,
	 * once, and for the user it was made for: another user's is refused (code `github_ticket`).
	 */
	githubComplete(ticket: string): Promise<GithubStatus>;
	/** Forgets the connection. Sessions launched on its repositories stay, and can no longer push. */
	githubDisconnect(): Promise<GithubStatus>;
	/** The Linear connection (see `LinearStatus`). Never throws for a deployment without Linear: the answer is `{ state: "off" }`. */
	linear(): Promise<LinearStatus>;
	/** Begins connecting a workspace. The callback returns to Settings with `#linear=<ticket>` or `#linear-error=<code>`. */
	linearConnect(input: { origin: string }): Promise<{ url: string }>;
	/** Records the connection for the user who started it. Refuses an invalid, expired or used ticket with `linear_ticket`. */
	linearComplete(ticket: string): Promise<LinearStatus>;
	/** The workspace's teams with the repository each files to. Throws a UserError with code `linear_not_connected` before a workspace is connected. */
	linearTeams(): Promise<LinearTeamList>;
	/**
	 * Files a team's issues to a repository of the user's GitHub connection (replacing its earlier mapping) and answers with the teams.
	 * Codes: `linear_not_connected`, `linear_team` (no such team in the workspace), `github_not_connected`, `bad_input` (a repository the connection
	 * does not cover, or one the user cannot push to).
	 */
	saveLinearMapping(input: { teamId: string; repositoryId: GithubId }): Promise<LinearTeamList>;
	/** Stops filing a team's issues. Items already filed stay as they are. Answers with the teams. */
	removeLinearMapping(teamId: string): Promise<LinearTeamList>;
	/** Forgets the Linear connection and every mapping; nothing is filed from Linear after it. Items already filed stay. */
	disconnectLinear(): Promise<LinearStatus>;
	/**
	 * Repositories of the connection whose `owner/name` contains `query`, the most recently pushed first.
	 * With `fresh`, GitHub is asked anew: for a repository that was added to an installation a moment ago.
	 */
	githubRepositories(query: string, fresh?: boolean): Promise<GithubRepositoryList>;
	githubBranches(repositoryId: GithubId): Promise<GithubBranchList>;
	/** The setup command the user saved for a repository, by GitHub's id for it. Asks GitHub nothing. */
	repositorySetup(repositoryId: GithubId): Promise<RepositorySetup>;
	/**
	 * Saves the user's setup command for a repository; "" saves none. It runs in sandboxes made from then
	 * on: a sandbox that has its clone already is not set up again. Throws a UserError with code
	 * `bad_setup_command` for one longer than MAX_SETUP_COMMAND_CHARS or with a character a shell cannot take.
	 */
	saveRepositorySetup(input: { repositoryId: GithubId; command: string }): Promise<RepositorySetup>;
	/** The checks the user saved for a repository, by GitHub's id for it. Asks GitHub nothing. */
	repositoryChecks(repositoryId: GithubId): Promise<RepositoryChecks>;
	/**
	 * Saves the user's checks for a repository: the whole list, in place of what was saved; an empty
	 * one saves none. They are handed to Windlass from each session's next turn on that repository.
	 * Throws a UserError with code `bad_checks` for a list that cannot be saved, with what is wrong.
	 */
	saveRepositoryChecks(input: { repositoryId: GithubId; checks: RepositoryCheck[] }): Promise<RepositoryChecks>;
	repositoryEnvironments(repositoryId: GithubId): Promise<RepositoryEnvironments>;
	rebuildEnvironment(input: { repositoryId: GithubId; place?: EnvironmentPlace }): Promise<RepositoryEnvironments>;
	saveEnvironmentSchedule(input: { repositoryId: GithubId; schedule: EnvironmentSchedule }): Promise<RepositoryEnvironments>;
	/** The repository's network list, with the requests its sessions filed and what the deployment allows anyway. Asks GitHub nothing. */
	repositoryNetwork(repositoryId: GithubId): Promise<RepositoryNetwork>;
	/**
	 * Saves the repository's network list whole: preset ids and exact host names. An empty one saves
	 * none. A request for a host the list now allows is taken off. Throws a UserError with code
	 * `bad_network` for an entry that is no preset and no exact DNS name, or a list that comes to more
	 * than `RepositoryNetwork.limit` hosts.
	 */
	saveRepositoryNetwork(input: { repositoryId: GithubId; entries: string[] }): Promise<RepositoryNetwork>;
	/** Takes a request off the repository's list without allowing it. */
	dismissNetworkRequest(input: { repositoryId: GithubId; host: string }): Promise<RepositoryNetwork>;
	/**
	 * Reads the repository's manifests, lockfiles, install scripts and CI files at its default branch,
	 * and the saved setup command, and answers with the hosts and presets they name that its sandboxes
	 * cannot reach yet. A fixed reading: no agent, no command. Nothing is saved. Throws as `githubRepository` does.
	 */
	scanRepositoryNetwork(repositoryId: GithubId): Promise<NetworkScan>;
	/**
	 * The names, scopes and times of the secrets the user saved for a repository, and what each reaches
	 * in a sandbox of `profile`. Saved values stay on the server.
	 */
	repositorySecrets(input: { repositoryId: GithubId; profile: SandboxProfileId }): Promise<RepositorySecrets>;
	/**
	 * Saves a secret of a repository. With `value`: a new secret, or a new value for the one of that
	 * name. Without: only the scope of the one of that name is changed. It reaches a setup command in
	 * sandboxes made from then on, and Windlass from each session's next turn. Throws a UserError with
	 * code `bad_secret` for a name or value that cannot be saved, `too_many_secrets` at
	 * MAX_SECRETS_PER_REPOSITORY, and `secret_not_found` for a scope change of a name that is not saved.
	 */
	saveRepositorySecret(input: { repositoryId: GithubId; profile: SandboxProfileId; name: string; value?: string; scope: SecretScope }): Promise<RepositorySecrets>;
	/** Deletes a secret of a repository. A sandbox whose setup command already had it keeps what that command made of it. */
	deleteRepositorySecret(input: { repositoryId: GithubId; profile: SandboxProfileId; name: string }): Promise<RepositorySecrets>;
	/**
	 * What is kept for a repository, by GitHub's id for it: the defaults for new sessions and the
	 * remembered approvals of its MCP servers. Asks GitHub nothing, and answers for a repository the
	 * user can no longer reach, too: what was saved stays until its user deletes it.
	 */
	repository(repositoryId: GithubId): Promise<RepositoryView>;
	/**
	 * The repository as GitHub has it now, when the user's connection covers it and the connected user
	 * may read it: what a new session can be launched on. Throws a UserError that says what is in the
	 * way: `github_off`, `github_not_connected`, `github_gone` or `github_denied` when it cannot be used
	 * for new sessions, `github_unreachable` or `github_failed` when GitHub could not be asked.
	 */
	githubRepository(repositoryId: GithubId): Promise<GithubRepository>;
	/**
	 * Saves what new sessions on a repository start with. A field that is left out stays as it is;
	 * null saves none for it. Throws a UserError with code `bad_input` for a sandbox this deployment
	 * does not offer or cannot run, and `bad_model` for a model that is not among the user's.
	 */
	saveRepositoryDefaults(input: ItemPlaceDefaults & RepositoryAutonomy & { repositoryId: GithubId; screenshots?: boolean; profile?: SandboxProfileId | null; model?: string | null; hostedSize?: HostedSize | null }): Promise<RepositoryDefaults>;
	/**
	 * Forgets the user's remembered approvals of that MCP server for a repository, whatever its
	 * definition was (`RepositoryView.forgetting` says what stays). Resolves when nothing was remembered, too.
	 */
	forgetRepositoryApproval(input: { repositoryId: GithubId; name: string }): Promise<RepositoryView>;
	/**
	 * Deletes everything kept for a repository: its setup command, its checks, its secrets, its defaults
	 * and the remembered approvals. The user's sessions on it stay, and their next sandbox is made without them.
	 */
	forgetRepository(repositoryId: GithubId): Promise<RepositoryView>;
	/** The repositories something is kept for, by name. Asks GitHub nothing. */
	savedRepositories(): Promise<SavedRepository[]>;
	/** The account's settings: the defaults for new sessions and the user's own MCP servers. No secret's value. */
	account(): Promise<AccountSettings>;
	/**
	 * Saves what new sessions start with where neither the launch form nor the repository says. A field
	 * that is left out stays as it is; null saves none for it. Throws as `saveRepositoryDefaults` does.
	 */
	saveAccountDefaults(input: ItemPlaceDefaults & { profile?: SandboxProfileId | null; model?: string | null }): Promise<AccountDefaults>;
	/** Forgets where the newest agent was started (`AccountSettings.lastStart`): the next agent starts on the platform's defaults. The next agent started is remembered again. */
	forgetLastStart(): Promise<AccountSettings>;
	/**
	 * Saves an MCP server of the user's own. With `existing`, the definition of the one of that name is
	 * replaced, and its setting with it; without, a new one is added. `unasked` is `PersonalServer.unasked`,
	 * off when it is left out. Windlass has it from each session's next turn. Throws a
	 * UserError with code `bad_server` for a name or a definition Windlass would not take (its message
	 * names the key), `server_exists` for a new one whose name is taken, `server_not_found` for a
	 * change of one that is not saved, and `too_many_servers` at `AccountSettings.limits.servers`.
	 */
	savePersonalServer(input: { name: string; definition: unknown; unasked?: boolean; existing?: boolean }): Promise<AccountSettings>;
	/** Deletes one of the user's own MCP servers. A turn that is running keeps it until it ends. */
	deletePersonalServer(name: string): Promise<AccountSettings>;
	modelProviders(): Promise<ModelProviderStatus[]>;
	saveModelProvider(input: { provider: ModelProvider; key: string }): Promise<ModelProviderCheck>;
	checkModelProvider(provider: ModelProvider): Promise<ModelProviderCheck>;
	removeModelProvider(provider: ModelProvider): Promise<void>;
	/** The names and times of the account's secrets, and what each reaches in a sandbox of `profile` made now. No value. */
	accountSecrets(input: { profile: SandboxProfileId }): Promise<AccountSecrets>;
	/**
	 * Saves a secret of the account, as `saveRepositorySecret` saves a repository's. With `value`: a
	 * new one, or a new value for the one of that name. Without: only the scope of the one of that
	 * name is changed. It holds from each session's next turn. Throws a UserError with code
	 * `bad_secret` for a name or value that cannot be saved, `too_many_secrets` at
	 * `AccountSettings.limits.secrets`, and `secret_not_found` for a scope change of a name that is not saved.
	 */
	saveAccountSecret(input: { profile: SandboxProfileId; name: string; value?: string; scope: SecretScope }): Promise<AccountSecrets>;
	deleteAccountSecret(input: { profile: SandboxProfileId; name: string }): Promise<AccountSecrets>;
	listSessions(): Promise<SessionSummary[]>;
	createSession(input: CreateSessionInput): Promise<SessionSummary>;
	renameSession(id: string, title: string): Promise<SessionSummary>;
	/**
	 * Destroys the session's actor and its sandbox. Refused with `machine_unreachable`, the session still
	 * listed, when its sandbox is on one of the user's machines and that machine's removal of it could not
	 * be recorded: deleting again retries.
	 */
	deleteSession(id: string): Promise<void>;
	/** Today's sandbox time and the count of kept sandboxes, as the user's actor has them. Asks no provider. */
	allowance(): Promise<UsageNumbers>;
	/**
	 * The usage page: today's sandbox time against the allowance, by agent, the kept sandboxes, the last
	 * two weeks and what a second is estimated to cost. The count of kept sandboxes is first held
	 * against the provider's own list of the user's sandboxes, so what is shown is what exists.
	 */
	usage(): Promise<UsageView>;
	/** The account's plan, its subscription and this month's hosted minutes; `{ enabled: false }` where the deployment has no billing. */
	billing(): Promise<BillingView>;
	/**
	 * A checkout for Pro at the provider: the address to send the browser to. `origin` is the web app's own (WLP_ORIGINS);
	 * the provider sends the browser back to its Settings. Throws `billing_off`, `already_subscribed` or `origin_not_allowed`.
	 */
	billingCheckout(input: { period: BillingPeriod; origin: string }): Promise<{ url: string }>;
	/** The provider's customer portal, to change the card or cancel. Throws `billing_off` or `no_customer`. */
	billingPortal(input: { origin: string }): Promise<{ url: string }>;
	/** Sets the overage spend cap, US cents from 0 to `maxCapCents`: the server stops hosted sandboxes at it. Throws `bad_input` or `billing_off`. */
	setOverageCap(input: { cents: number }): Promise<BillingView>;
	/**
	 * Removes the sandbox of one of the user's agents, to make room for another: the files in its
	 * workspace go with it, and the agent and its conversation stay (`UsageView.memory` says what
	 * becomes of the agent's own memory). The agent's next prompt starts a new sandbox. Throws a
	 * UserError with code `sandbox_busy` while the agent works. Answers with the page as it is then.
	 */
	freeSandbox(sessionId: string): Promise<UsageView>;
	/**
	 * The user's machines, the first paired first. The machine actions throw a UserError with code
	 * `machines_off` when the deployment has no machines (`PlatformInfo.machines`).
	 */
	machines(): Promise<MachineSummary[]>;
	machineCatalog(input: { machineId: string; id: "claude" | "opencode" | "codex"; digest: string }): Promise<HarnessOptions | null>;
	/**
	 * Looks up the code a runner printed ("XXXX-XXXX": Crockford base32, so case, spaces and dashes do
	 * not matter, O reads as 0 and I and L as 1) and answers with what that machine said of itself. The
	 * first account to look a code up keeps it: for any other the code is not found. Throws a UserError
	 * with code `pairing_not_found` for a code that is unknown, expired (ten minutes after the runner
	 * asked) or another account's, `too_many_claims` after five lookups in ten minutes, and
	 * `too_many_machines` at MAX_MACHINES.
	 */
	claimMachine(input: { code: string }): Promise<MachineClaim>;
	/**
	 * Pairs the machine of a code this user looked up. Its runner is told the GitHub login of the
	 * account it joined (none when GitHub is not connected), prints it, and connects. Asked again for the
	 * same code, it answers with the same machine. Throws as `claimMachine` does. `keyConfirmed`: the
	 * person said the machine's terminal shows the claim's `keyFingerprint` (or, for a runner that does not
	 * print it, that they started it themselves); without it the platform refuses with `key_not_confirmed`.
	 */
	confirmMachine(input: { code: string; keyConfirmed: true }): Promise<MachineSummary>;
	/**
	 * Removes a machine: its key stops working at once, and its agents keep their conversations and can
	 * no longer run. With `removeSandboxes`, its runner also removes the agents' sandboxes on it and
	 * Windlass's data volume there, now when it is online and when it next connects when not. Throws a
	 * UserError with code `machine_not_found` for one that is not the user's. Answers with the list as it is then.
	 */
	removeMachine(input: { machineId: string; removeSandboxes: boolean }): Promise<MachineSummary[]>;
	/** Turns the sending of saved secrets to a machine's agents on or off, from each one's next turn. Throws as `removeMachine` does. */
	setMachineDetails(input: { machineId: string } & MachineDetails): Promise<MachineSummary[]>;
	setMachineSecrets(input: { machineId: string; send: boolean }): Promise<MachineSummary[]>;
	/**
	 * The user's work items, the newest first: every one of them, for API clients and scripts (the web
	 * app reads `itemFeed`). With `page`, at most `page.limit` of them after
	 * `page.before`, kept to ended ones, one repository or one way of filing where it says so
	 * (`ItemListPage`); a page shorter than its limit is the last. Throws a UserError with code
	 * `bad_input` for a page that is not one.
	 */
	listItems(page?: ItemListPage): Promise<ItemSummary[]>;
	/** What the live feed carries (`ItemFeed`): every open item, the newest filed ended ones, and the counts. The web app reads this, not the whole list. */
	itemFeed(): Promise<ItemFeed>;
	/** One item's page. Throws a UserError with code `item_not_found` for one that is not the user's. */
	item(id: string): Promise<ItemView>;
	itemAttachmentLinks(itemId: string): Promise<Array<{ id: string; url: string; expiresAt: number }>>;
	/**
	 * Files a work item, with its own agent session on the repository. Checks the repository at GitHub
	 * as `createSession` does, and throws as it does; also `bad_input` for a title, body or criteria that
	 * cannot be taken. A machine must be paired to this user and have an available profile.
	 */
	createItem(input: CreateItemInput): Promise<ItemSummary>;
	/** Throws a UserError with code `item_not_found`, or `item_conflict` when the item's state does not allow the action (it says why). */
	actOnItem(input: { id: string; action: ItemAction }): Promise<ItemView>;
	/** The factory's limits for this user. */
	factoryLimits(): Promise<FactoryLimits>;
	/** The user's API tokens, the newest first; never a token's value. */
	apiTokens(): Promise<ApiToken[]>;
	/** Makes an API token: `secret` is its value, shown this once. Throws a UserError with code `bad_input` for a name or scopes that cannot be taken, `too_many_tokens` at MAX_API_TOKENS. */
	createApiToken(input: { name: string; scopes: ApiTokenScope[] }): Promise<{ token: ApiToken; secret: string }>;
	/** Revokes one: it stops working at once. Resolves for one that is not there, too. */
	revokeApiToken(id: string): Promise<ApiToken[]>;
}

export interface UserEvents {
	/** The full list, newest first, after any change to it. */
	sessions: SessionSummary[];
	/** Today's numbers, after sandbox time was held or counted, or a sandbox was kept or freed. */
	usage: UsageNumbers;
	/** The user's machines, after one was paired or removed, or its status, warnings or secrets switch changed. */
	machines: MachineSummary[];
	machineHost: MachineHostUpdate;
	/** The user's open work items and the newest ended ones, with the counts (`ItemFeed`), after any of them changed. */
	items: ItemFeed;
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

export interface UsageWindow {
	kind: "5h" | "7d" | "model" | "rpm" | "other";
	usedPct: number | null;
	resetsAt: number | null;
	observedAt: number;
	source: "refusal" | "event" | "header";
}
export interface ProviderAccount {
	provider?: ModelProvider;
	key: string;
	harness: HarnessId;
	state: "ok" | "warning" | "limited";
	limitedUntil: number | null;
	windows: UsageWindow[];
}
export interface AcpContext {
	fiveHourUsedPct?: number;
	used: number;
	size: number;
	cost: { amount: number; currency: string } | null;
}

export type AcpContent = { type: "text"; text: string } | { type: string; [key: string]: unknown };
type AcpChunk = { content: AcpContent };
type AcpTool = { toolCallId: string; title?: string; kind?: string; status?: string; content?: AcpContent[] };

export type AcpUpdate = (
	| ({ sessionUpdate: "agent_message_chunk" } & AcpChunk)
	| ({ sessionUpdate: "agent_thought_chunk" } & AcpChunk)
	| ({ sessionUpdate: "user_message_chunk" } & AcpChunk)
	| ({ sessionUpdate: "tool_call" } & AcpTool)
	| ({ sessionUpdate: "tool_call_update" } & AcpTool)
	| { sessionUpdate: "plan"; entries: Array<{ content: string; priority: string; status: string }> }
	| { sessionUpdate: "available_commands_update"; availableCommands: Array<{ name: string; description: string }> }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "config_option_update"; configOptions: unknown[] }
	| { sessionUpdate: "session_info_update"; title?: string; updatedAt?: string }
	| { sessionUpdate: "usage_update"; rateLimit?: { status: "allowed" | "allowed_warning" | "rejected"; window: UsageWindow }; fiveHourUsedPct?: number; used: number; size: number; cost?: AcpContext["cost"] }
	| { sessionUpdate: "notice" }
	| { sessionUpdate: "compaction_update" }
	| { sessionUpdate: "unknown"; originalSessionUpdate: string }
) & Record<string, unknown>;

/** The title an ACP update may give a personal session whose owner has not named it. */
export function generatedSessionTitle(update: AcpUpdate, owner: { typed?: boolean; item?: { role?: "builder" | "reviewer" } }, redactor?: { text(value: string): string }): string | undefined {
	if (update.sessionUpdate !== "session_info_update" || typeof update.title !== "string" || owner.typed || owner.item) return;
	const line = update.title.replace(/[\s\u0085]/gu, " ").replace(/\p{Cc}/gu, "").replace(/ +/g, " ").trim();
	// Removing controls can join fragments of a secret. Redact the whole line before cutting it.
	const safe = redactor?.text(line) ?? line;
	return safe.match(/^.{1,200}/u)?.[0].trimEnd();
}

/**
 * An entry of a session's timeline. `seq` is the platform's own numbering, dense and increasing
 * within a session, and has nothing to do with a Windlass event's `seq`.
 */
export type NetworkBlockedItem = { seq: number; at: number; turn: number; kind: "network.blocked"; revision: number } & BlockedNetwork;

export interface ModelKeySpend { provider: ModelProvider; generation: string; tokens: number }

export type TimelineItem =
	/** One row per turn. Its first snapshot arrives on item, replacements on networkBlocked with the same seq. */
	| NetworkBlockedItem
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
			/** Sources of quoted GitHub feedback, also used when rebuilding the prompt after a pause. */
			untrusted?: string[];
			/** A message sent while the turn was paused: held, and given to the agent when the turn resumes. */
			held?: boolean;
	  }
	/** Something the platform did around a turn: "Creating sandbox", "Cloning repository". */
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "platform";
			modelKey?: ModelKeySpend;
			/** The agent’s request, with its reason as quoted plain text. */
			secretRequest?: SecretRequest & { id: string };
			level: "info" | "warn" | "error";
			text: string;
			/**
			 * Set on the line that says the platform declined a question because nobody answered in time
			 * ("question_expired"), with the call the question was about. Windlass's own `approval.answered`
			 * for that call follows, with choice "deny": this is how a client tells it from the user's choice.
			 * "question_allowed" is the same for a question the platform allowed itself: Windlass's question
			 * about the tool that hands the agent's request to publish to the platform, and its question
			 * about a tool of one of the user's own MCP servers whose tools run without asking
			 * (`PersonalServer.unasked`). The `approval.answered` that follows has choice "once", and nobody was asked.
			 */
			code?: "question_expired" | "question_allowed" | "host_blocked" | "turn_paused" | "turn_resumed";
			call?: { messageId: string; callId: string };
			/**
			 * With `code` "host_blocked": the host a command in the session's sandbox asked for and could
			 * not reach, which the line names. `repository` is set when the session's repository's network
			 * list can allow it (`allowHost`); without it only the deployment's operator can.
			 */
			host?: string;
			repository?: boolean;
	  }
	/** A durable Windlass event, or one of the stored ephemeral ones (`notice`, `workspace.changes`, `cli.summary`). */
	| { seq: number; at: number; turn: number; kind: "windlass"; event: WindlassEvent; modelKey?: ModelKeySpend }
	| { seq: number; at: number; turn: number; kind: "acp"; update: AcpUpdate; messageKey?: string; truncated?: boolean }
	/**
	 * A run of the repository's setup command (`RepositorySetup`) in the session's new sandbox. Two items
	 * with one `id`: the first when it starts (`state: "started"`), the second when it has ended. What it
	 * prints in between is not stored: it arrives as `setup.output` deltas (`LiveDelta`), and the ending
	 * item carries the end of it. A run with no ending item was cut off with its server.
	 */
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "setup";
			id: string;
			/** The command as it was run. */
			command: string;
			/**
			 * "started", or how it ended: "succeeded" (exit code 0), "failed" (another exit code, or it could
			 * not be run), "timed_out" (stopped by the platform at `limitMs`), "stopped" (the turn was stopped).
			 */
			state: "started" | "succeeded" | "failed" | "timed_out" | "stopped";
			/** Null while it runs, and when it was killed. */
			exitCode: number | null;
			/** Null while it runs. */
			durationMs: number | null;
			/** How long it may run. */
			limitMs: number;
			/** On the ending item: the end of what it printed, standard output and standard error as they came, at most SETUP_OUTPUT_CHARS. */
			output: string;
			/** True when it printed more than `output` holds. */
			truncated: boolean;
	  }
	| {
			seq: number;
			at: number;
			turn: number;
			kind: "turn.ended";
			modelKey?: ModelKeySpend;
			outcome: TurnOutcome;
			/** Windlass's exit code, null when it never ran or was killed. */
			exitCode: number | null;
			steps: number | null;
			durationMs: number;
			usage: TurnUsage | null;
			/** Share of input tokens read from the prompt cache, 0..1. */
			cachedShare: number | null;
			/** What went wrong, including a provider refusal on a failed turn, fit to show. */
			message: string | null;
			/** What the session's work rests on after this turn. */
			verified: Verified | null;
			context?: AcpContext | null;
			/** Another agent's own session id, which it names only once a turn has opened it (ACP `session/new`); the panel shows it at once. */
			sessionId?: string;
	  };

/**
 * Streaming output that is broadcast but never stored: `text.delta`, `reasoning.delta`, `tool.input.delta`,
 * `tool.progress`. And one event of the platform's own, in the same shape: `{ type: "setup.output", id, text }`,
 * what a run of the repository's setup command printed since the delta before it (`id` is the run's,
 * as on its `setup` items; `text` is to be appended, and a reader keeps the end of it).
 */
export interface WindlassDelta { turn: number; event: WindlassEvent }

export type LiveDelta =
	| WindlassDelta
	| { turn: number; acp: AcpUpdate; messageKey: string };

/** One answer a question offers. */
export interface QuestionChoice {
	/** Windlass's own id: "once", "session", "project" or "deny". For a question about a server (`PendingQuestion.server`): "start" or "not_now". */
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
	/**
	 * Set when the question is not about a tool call but about an MCP server the project's own
	 * configuration names (`.windlass/config.json` in the workspace): Windlass does not start such a
	 * server until the user approves exactly this definition of it. `messageId` and `callId` are empty
	 * then, `subject` is the command with its arguments (each argument that is not plain text in single
	 * quotes) or the address, `details` are the platform's own sentences about where the server runs in
	 * this session's sandbox profile and what approving means, and the choices are "start" and
	 * "not_now". Nothing of it is in Windlass's events: what became of it is a `platform` item.
	 *
	 * A tool call's question comes first: while one waits, a server's question steps aside (the
	 * `question` event carries the call's question) and is put again afterwards, under the same `id` and
	 * with a new `expiresAt`. `answer()` takes its id while it stands aside too.
	 */
	server?: QuestionServer;
	/**
	 * Set when the question is the platform's own about a request of the agent's to publish the
	 * session's work: what would be committed, pushed and opened. `messageId` and `callId` name the
	 * agent's call, `subject` is the pull request's title, `details` are the platform's sentences
	 * about what allowing means, and the choices are "once", "session" (which turns
	 * `SessionSummary.publishUnasked` on) and "deny", whose note goes to the agent. Nothing of it is in
	 * Windlass's events: what became of it is a `platform` item, and the call's own result.
	 */
	publish?: QuestionPublish;
}

/** What a request of the agent's to publish would do, as the question about it shows it. */
export interface QuestionPublish {
	/** "owner/name". */
	repository: string;
	/** The session's branch, which the work goes to. */
	branch: string;
	/** The branch the pull request asks to be merged into. */
	base: string;
	/** The whole message of the commit the platform makes of what is uncommitted. */
	commit: string;
	/** The pull request's title and description, as the agent wrote them; the description may be "". */
	title: string;
	description: string;
	/** The session's pull request when it is open: the push goes to it, and it is given the title and description. Null: one is opened. */
	pullRequest: number | null;
}

/** The MCP server a question is about. */
export interface QuestionServer {
	name: string;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	/** True when it is reached at an address (`subject`) and nothing is started. */
	remote: boolean;
	/** The variables its definition reads that are not set in the sandbox: with any, it does not start, approved or not. */
	unset: string[];
	/**
	 * True when the turn's prompt waits for the answer (the session is `waiting`): the question was put
	 * before Windlass got the prompt. False when Windlass reported the server while the turn was already
	 * running: the turn goes on, and the question goes when the turn ends.
	 */
	holdsTurn: boolean;
}

/** How a session last knew a server of its project. A server lives with the Windlass process of a turn: between turns none runs. */
export type SessionServerState =
	/** Windlass started it (or reaches it). It starts again with each turn while an approval of it holds. */
	| "running"
	/** Approved, and it had not finished starting when the session last heard. */
	| "starting"
	/** Not started: it waits for the user's approval of exactly this definition. */
	| "waiting"
	/** Approved, and it could not start; `reason` says why. */
	| "failed"
	| "stopped";

/**
 * An MCP server of a session, as the session last heard of it from Windlass: one the configuration of
 * its project names, or one of its user's own (`PersonalServer`).
 */
export interface SessionServer {
	name: string;
	/**
	 * "user": one of the user's own, from the account's settings: Windlass starts it without asking, so
	 * it never waits and has no approval. Absent or "project": the project's configuration names it.
	 */
	origin?: "project" | "user";
	/** What approving starts, as a question shows it: the command with its arguments, or the address it is reached at. */
	subject: string;
	/** True when it is reached at an address and nothing is started. */
	remote: boolean;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	state: SessionServerState;
	/** How many tools it offers, once it runs. */
	tools: number | null;
	/** Why it could not start, in Windlass's own words. */
	reason: string | null;
	/**
	 * Windlass's mark for the definition the session last saw wait for approval, which is what
	 * `approveServer` takes. Null when the session never saw the server wait: Windlass started it from a
	 * record of its own.
	 */
	fingerprint: string | null;
	/** When the session last heard something new of it, ms since the epoch. */
	at: number;
	/** The user's remembered approval of this definition for the session's project: when they approved, and until when it holds. */
	approval: { approvedAt: number; expiresAt: number } | null;
	/**
	 * Set when `approval` is null and the user's newest remembered approval of a server of this name for
	 * the project is of another definition: the definition changed since they approved, which is why it
	 * is asked about again. `forgetServer` forgets that one too.
	 */
	earlier?: { approvedAt: number; expiresAt: number } | null;
	/**
	 * Set for a server that waits and has no remembered approval: the question about it as the panel
	 * puts it before `approveServer`, in the words of the question a turn would put (`PendingQuestion`),
	 * for an approval given between turns.
	 */
	asks?: { title: string; details: string[] };
}

/** What the side panel shows of the MCP servers a session's project names. */
export interface SessionServers {
	/**
	 * What an approval is remembered for: the session's repository ("github": `label` is "owner/name";
	 * "address": the pasted address without its scheme), or, for a session with no repository, the
	 * session itself.
	 */
	project: { kind: "github" | "address" | "session"; label: string };
	servers: SessionServer[];
	/** What forgetting an approval does and does not do where this session runs, in a sentence or two. */
	forgetting: string;
	/**
	 * Set where this session's sandbox hands MCP servers only some of the account's secrets, and says
	 * which and why: a server of the user's own that reads another one does not start there.
	 */
	accountSecrets?: string | null;
}

export interface SessionSnapshot {
	/** The open request in a person’s session. Item requests live on the item question. */
	secretRequest?: SecretRequest & { id: string };
	summary: SessionSummary;
	profile: SandboxProfile;
	/** The harness's conversation id, once the first turn created it. */
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
	/**
	 * For a session on one of the user's machines, what its banner says of the machine: whether it
	 * answered when the session last needed it, and since when. "not_answering": a turn waits on a
	 * machine that stopped answering, and goes on when it is back or ends ten minutes after `since`.
	 * Null until the session needed its machine since its actor last woke; absent for a hosted session.
	 */
	machine?: { state: "answering" | "not_answering" | "offline" | "removed"; since: number } | null;
}

export interface PromptInput {
	/** The agent's own plan mode for this turn, where it has one (`SessionCapabilities.planMode`): it plans and changes nothing. Only for a turn that starts. */
	planMode?: boolean;
	text: string;
	/** Switches to an offered account or harness model from this turn on. */
	model?: string;
	/** One of the efforts the turn's model accepts. */
	effort?: string;
	/**
	 * The key of this submission (`IdempotencyKey`). The same key again, with the same text, is
	 * answered as the first attempt was and adds nothing: no second message in the running turn, no
	 * second turn. What a key is held against is the text; `model` and `effort` are the first attempt's.
	 * A session remembers the keys of its last MAX_REMEMBERED_SUBMISSIONS messages that came with one.
	 */
	idempotencyKey?: IdempotencyKey;
}

export interface WorkspaceFile {
	/** Relative to the workspace root. */
	path: string;
	/** Git's two-letter status, e.g. " M", "??", "A ". */
	status: string;
}

export interface AgentSessionActions {
	/** Select the mode for the next prompt. An unavailable choice or item session returns bad_input. */
	setMode(input: { mode: string }): Promise<SessionSummary>;
	snapshot(): Promise<SessionSnapshot>;
	/** Create the missing secret at agent scope and continue. A name saved since the request returns secret_exists.
	 * A failed item save reopens the question with its error and a new id. */
	setRequestedSecret(input: SetRequestedSecretInput): Promise<void>;
	/**
	 * Starts a turn and returns as soon as it is accepted; the work arrives as events. While a turn is
	 * running it steers that turn instead: the message is stored as a `user` item with `steer: true`,
	 * the model reads it at its next step, and `steered` is true (`model` and `effort` are ignored
	 * then). Throws a UserError when the text is empty, when the user must sign in to ChatGPT first,
	 * or when a running turn cannot take the message (code `steer_unavailable`).
	 * A turn that would start is also held to its user's two limits (`UsageNumbers`), before a sandbox is
	 * created or started: code `allowance_used` when too little of the day's sandbox time is left, and
	 * `too_many_sandboxes` when the session needs a sandbox and its user keeps as many as they may. Each
	 * comes with a sentence that says what was used, what the limit is, and what to do or when it resets.
	 * With `idempotencyKey`, a message that was taken before under that key is not taken again: the
	 * answer is the one its first attempt had, whatever the session does now (`IdempotencyKey`).
	 */
	prompt(input: PromptInput): Promise<{ turn: number; steered: boolean }>;
	/**
	 * Answers the pending question with one of its choices. `note` goes to the model with the result
	 * (why it was declined, what to do instead); a question about a server takes none. Throws a UserError with code `no_question` when that
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
	/** What the side panel shows about the session's pull request. Reads GitHub for the pull request's state; never starts a paused sandbox. */
	publishState(): Promise<PublishState>;
	/**
	 * Puts the session's work on its branch at GitHub: commits what is uncommitted with `message`,
	 * pushes, and opens a pull request when none is open (`message` is its title and body then). The
	 * platform does it, not the agent. Throws a UserError with a sentence the user can act on: code
	 * `publish_blocked` (a turn is running, no connected repository, nothing to push), `github_gone`
	 * (the connection, the installation or the repository is no longer there), `github_denied` (no
	 * write access, a protected branch) or `publish_failed`.
	 */
	publish(input: { message: PublishMessage }): Promise<PublishResult>;
	/**
	 * Sets `SessionSummary.publishUnasked`: whether the agent may have the platform publish the session's
	 * work without the user being asked each time. Takes effect at once, also for a request that is
	 * being asked about (turning it on allows that one). Throws a UserError with code `publish_blocked`
	 * for a session that does not work on a repository of the user's GitHub connection, and for turning
	 * it on in a profile whose commands are not held in Windlass's sandbox, with the sentence that says why.
	 */
	setPublishUnasked(input: { unasked: boolean }): Promise<SessionSummary>;
	/**
	 * The MCP servers the session's project names, each as the session last heard of it, with the
	 * user's remembered approval where there is one. Never starts a sandbox: it reads what the session
	 * kept and asks the user's own record.
	 */
	servers(): Promise<SessionServers>;
	/**
	 * Approves a server that waits, by the fingerprint `servers()` gave for it, and remembers that for
	 * the session's project. While a question about that definition is open, this answers it and the
	 * server starts at once; otherwise nothing runs to start it in, and it starts with the next turn,
	 * unasked. Throws a UserError with code `server_gone` when the session knows no such server, and
	 * `server_changed` when it does not wait with that fingerprint (any more).
	 */
	approveServer(input: { name: string; fingerprint: string }): Promise<SessionServers>;
	/**
	 * Forgets the user's remembered approvals of that server for the session's project. It holds for
	 * the next session and the next sandbox (`SessionServers.forgetting` says what stays); no server is
	 * stopped. Resolves when nothing was remembered, too.
	 */
	forgetServer(input: { name: string }): Promise<SessionServers>;
	/**
	 * "Allow for this repository": adds the host to the network list of the session's repository and,
	 * while a turn holds the session's sandbox, lets that sandbox reach it at once (`applied`); otherwise
	 * it applies from the next turn. Only the person who can change the repository's settings may. Today
	 * that is the only person who can call it at all (a session's actions are its user's), so the other
	 * branch, which files a request (`NetworkRequest`) and answers `applied: false`, cannot run yet.
	 * Throws a UserError with code `bad_network` for a host that is not an exact DNS name, a session with
	 * no repository of the GitHub connection, a full list, or a sandbox outside restricted hosted egress.
	 * For blocked destinations only offer this action when BlockedHost.allow is "repository".
	 */
	allowHost(input: { host: string }): Promise<HostAllowed>;
}

export interface AgentSessionEvents {
	/** Replace the network.blocked row with this seq if revision is newer. Counts are cumulative for its turn. */
	networkBlocked: NetworkBlockedItem;
	/** A stored timeline entry, in `seq` order. */
	item: TimelineItem;
	/** Streaming output of the turn in progress. */
	delta: LiveDelta;
	/** The session's summary, after any change to it. */
	summary: SessionSummary;
	/** The pending question, when one is asked; null when it was settled (answered, expired, withdrawn). */
	question: PendingQuestion | null;
	/** For a session on one of the user's machines, what its banner says of the machine, each time that changes. */
	machine: NonNullable<SessionSnapshot["machine"]>;
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
/**
 * `GET` on the same address: this deployment's `PlatformConnection`, as JSON. Asked when the web app
 * starts and again whenever its token runs out.
 */
export const PLATFORM_CONNECTION_PATH = "/platform/connection";

export const MAX_PROMPT_CHARS = 20_000;
/** The longest `IdempotencyKey`, in characters: the Agent Client Protocol's limit. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;
/** How many of a session's messages that came with a key have theirs remembered: the newest. */
export const MAX_REMEMBERED_SUBMISSIONS = 50;
/** The title of a commit or pull request, and its body. */
export const MAX_PUBLISH_TITLE_CHARS = 120;
export const MAX_PUBLISH_BODY_CHARS = 4_000;
export const MAX_TITLE_CHARS = 80;
/** The note sent with an answer to a question. */
export const MAX_NOTE_CHARS = 2_000;
/** A repository's setup command. */
export const MAX_SETUP_COMMAND_CHARS = 2_000;
/** How much of a setup run's output is kept, and shown while it runs: the end of it. */
export const SETUP_OUTPUT_CHARS = 32_000;
/** A repository's checks: how many one repository may have, and Windlass's own limit on how long one may run. */
export const MAX_CHECKS_PER_REPOSITORY = 20;
/** How many hosts one repository's network list may come to, presets expanded. */
export const MAX_REPOSITORY_HOSTS = 40;
export const MAX_CHECK_NAME_CHARS = 64;
export const MAX_CHECK_TIMEOUT_SECONDS = 3600;
/** How many glob patterns one check's `when` may hold, and how long one may be. */
export const MAX_CHECK_PATTERNS = 20;
export const MAX_CHECK_PATTERN_CHARS = 200;
/** How much of a check's output the platform keeps for a pull request's description: the end of it. */
export const CHECK_OUTPUT_CHARS = 1_500;
/** A repository's secrets: how many one repository may have, and what a name and a value may be. */
export const MAX_SECRETS_PER_REPOSITORY = 50;
export const MAX_SECRET_NAME_CHARS = 64;
/** A shorter value could not be taken out of what is shown without taking ordinary words with it. */
export const MIN_SECRET_VALUE_CHARS = 8;
/** In bytes of UTF-8: every secret of a repository is in the environment of one process. */
export const MAX_SECRET_VALUE_BYTES = 16_384;
/** How many repositories one user may have defaults for; the ones saved longest ago go first. */
export const MAX_REPOSITORY_DEFAULTS = 500;
/** The user's own MCP servers: how many one account may keep, and how long one's definition may be as JSON, in bytes of UTF-8. */
export const MAX_PERSONAL_SERVERS = 20;
export const MAX_SERVER_DEFINITION_BYTES = 8_192;
/** A server's name in Windlass's configuration: at most this many characters. */
export const MAX_SERVER_NAME_CHARS = 64;
/** How many secrets one account may keep for its MCP servers. */
export const MAX_ACCOUNT_SECRETS = 50;
/**
 * How long a question in a running interactive turn waits for an answer before the platform declines it: the
 * turn holds its sandbox meanwhile, and turns are 45 minutes at most. A work item never asks this way: its
 * questions end the turn and wait for days if need be.
 */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
/** How many machines a user may have paired at once. */
export const MAX_MACHINES = 3;
/** A work item's body, in characters. */
export const MAX_ITEM_BODY_CHARS = 20_000;
export const MAX_ACCEPTANCE_CRITERIA = 20;
export const MAX_API_TOKENS = 20;
/** A machine whose runner has not been heard from for this long is removed, its sandboxes left where they are. */
export const MACHINE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
/** How many days of sandbox time the usage page lists, today included. */
export const USAGE_HISTORY_DAYS = 14;
/** The share of the day's allowance below which a session says how little is left. */
export const USAGE_LOW_SHARE = 0.2;
