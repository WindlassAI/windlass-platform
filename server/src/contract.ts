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
	| "e2b-open"
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
	/**
	 * Set when this deployment has a GitHub App: users can connect GitHub, launch agents on their own
	 * repositories and open pull requests. Absent or null when it has none: the web app then shows
	 * nothing of it.
	 */
	github?: GithubInfo | null;
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
 * (README, "Models"). They are no fact of the deployment: they are what the user's ChatGPT plan
 * offers, as Windlass lists them with that user's sign-in, kept in the user's actor for about an hour.
 */
export interface ModelList {
	/**
	 * Whose list this is. "account": the user's plan's, as it was read at `fetchedAt`. Anything else is
	 * the platform's fixed stand-in, and says why it stands in: "demo", the demo's scripted model
	 * answers under any of its names; "signed-out", there is no ChatGPT sign-in to list with;
	 * "unavailable", the plan's list could not be read and none is kept from before.
	 */
	source: "account" | "demo" | "signed-out" | "unavailable";
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
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** Whether the sandbox exists and whether it is running or paused. */
	sandbox: "none" | "running" | "paused";
	/**
	 * Whether the Windlass in the session's sandbox can be told by name which variables its commands
	 * get, which is what makes a secret's scope exact (`SecretReach`), as it said when a turn last
	 * asked it. A sandbox keeps the Windlass of the image it was made from. Absent while the session
	 * has no sandbox, and for a sandbox that no turn has asked.
	 */
	envLists?: boolean;
	/**
	 * Set once Windlass has told the session of MCP servers: those its project's configuration names,
	 * and its user's own (`PersonalServer`). How many, and when what the session knows of them last
	 * changed (a server started, failed, came to wait, an approval was remembered or forgotten here). A
	 * client asks `servers()` again when `changedAt` moves. Absent for a session that has none.
	 */
	servers?: { count: number; changedAt: number };
}

export interface CreateSessionInput {
	/** Defaults to "New agent"; replaced by the first prompt's opening words when left unset. */
	title?: string;
	profile: SandboxProfileId;
	/** One of the user's models (`UserActions.models`). Defaults to their default. */
	model?: string;
	/** An https git address to clone into the workspace. */
	repoUrl?: string;
	/**
	 * A repository of the user's GitHub connection to launch on, by GitHub's id for it (`GithubRepository.id`),
	 * and the branch to start from (default: the repository's default branch). Not together with `repoUrl`.
	 */
	repository?: { id: number; branch?: string };
	/**
	 * With `repository`: the setup command to save for that repository before the session is made
	 * (`RepositorySetup`), in place of what was saved; "" saves none. Left out, what is saved stays.
	 */
	setupCommand?: string;
	/** With `repository`: `SessionSummary.publishUnasked` to start with. Left out: the agent's requests to publish are asked about. Refused (`bad_input`) for a profile it cannot be on in. */
	publishUnasked?: boolean;
}

export interface ChatgptStatus {
	connected: boolean;
	email: string | null;
	/** When the saved sign-in's access token expires, ms since the epoch. The platform refreshes it when a turn needs a token within twenty minutes of that, or after. */
	accessExpiresAt: number | null;
}

// --- GitHub ----------------------------------------------------------------------------------

/** An account the GitHub App is installed on, which the connected GitHub user can reach. */
export interface GithubAccount {
	/** The installation's id at GitHub. */
	installationId: number;
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

/** A repository the connection covers and the connected GitHub user can open. */
export interface GithubRepository {
	/** GitHub's id for it: what `CreateSessionInput.repository` names. */
	id: number;
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
	id: number;
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
 * Who a repository's secret is handed to (README, "A repository's secrets"). Every secret goes to the
 * repository's setup command. Beyond that:
 *
 *   "setup"   the MCP servers the repository names, and not the commands the agent runs
 *   "agent"   the MCP servers, and the commands the agent runs as well
 *
 * Where Windlass sandboxes the agent's commands, that is what each of them gets. Where it does not,
 * and in a sandbox whose Windlass is an older one, a scope can come to less; `SecretReach` says what.
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
 * go without it. A sandbox made from an older image has a Windlass that takes no names: there a
 * secret is kept from commands only by its name or by staying out of Windlass's environment.
 */
export interface SecretReach {
	/** Whether the MCP servers the repository names can be given it (`${NAME}` in their definitions). */
	servers: boolean;
	/**
	 * Whether the commands the agent runs get it: "yes", "no", or "unsandboxed": only the commands
	 * Windlass runs without its own sandbox, which in that profile is not all of them at all times
	 * (an older Windlass, and a name that looks like a credential).
	 */
	commands: "yes" | "no" | "unsandboxed";
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
 * What a new session on a repository starts with, where its user said so (README, "A repository's
 * page"): the launch form starts from them when that repository is picked, and its user can still
 * choose otherwise for one session. Kept as they were saved: a default may come to name a sandbox
 * this deployment no longer offers or a model its user's account no longer does, and such a one is
 * not used.
 */
export interface RepositoryDefaults {
	/** The sandbox profile, by its id; null when none is saved. */
	profile: SandboxProfileId | null;
	/** The model; null when none is saved. */
	model: string | null;
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
	id: number;
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
	/** What else is saved for it: whether a setup command is, and how many secrets. */
	saved: { setup: boolean; secrets: number };
}

/** A repository the user's actor keeps something for: a setup command, a secret, a default or a remembered approval. */
export interface SavedRepository {
	id: number;
	/** As `RepositoryView.name`. */
	name: string | null;
}

// --- The account's settings ------------------------------------------------------------------

/**
 * What a new session starts with where neither the launch form nor the chosen repository says so
 * (README, "Account settings"): a sandbox profile and a model, the user's own, whatever the
 * repository. Kept as they were saved, as a repository's are: one that names a sandbox this
 * deployment no longer offers, or a model the account no longer does, is not used, and whoever reads
 * it says so.
 */
export type AccountDefaults = RepositoryDefaults;

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

export interface AccountSecrets {
	secrets: AccountSecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

// --- Usage -----------------------------------------------------------------------------------

/**
 * A user's sandbox time today and the sandboxes they keep, in numbers (README, "Usage and limits").
 *
 * Sandbox time is the time a session's sandbox runs: from when it is created or resumed, for a turn or
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
}

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
	/** Null when that agent no longer exists and its sandbox was left behind. */
	title: string | null;
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
	/** Today's sandbox time by agent, the most first; an agent whose sandbox runs now is among them. */
	today: UsageSession[];
	/** The last USAGE_HISTORY_DAYS days, the oldest first and today last. */
	days: UsageDay[];
	/** The sandboxes the user keeps, as the provider lists them, the most recently used first. */
	kept: KeptSandbox[];
	/** Null where running a sandbox is not billed by the second (local Docker): no cost is estimated then. */
	price: UsagePrice | null;
	/**
	 * What becomes of an agent's memory of its conversation when its sandbox is freed. "kept": it is
	 * stored outside the sandbox. "copied": a copy is saved after every turn and put into the next
	 * sandbox. "lost": it is in the sandbox only, and the agent starts without it.
	 */
	memory: "kept" | "copied" | "lost";
}

export interface UserActions {
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
	/**
	 * Repositories of the connection whose `owner/name` contains `query`, the most recently pushed first.
	 * With `fresh`, GitHub is asked anew: for a repository that was added to an installation a moment ago.
	 */
	githubRepositories(query: string, fresh?: boolean): Promise<GithubRepositoryList>;
	githubBranches(repositoryId: number): Promise<GithubBranchList>;
	/** The setup command the user saved for a repository, by GitHub's id for it. Asks GitHub nothing. */
	repositorySetup(repositoryId: number): Promise<RepositorySetup>;
	/**
	 * Saves the user's setup command for a repository; "" saves none. It runs in sandboxes made from then
	 * on: a sandbox that has its clone already is not set up again. Throws a UserError with code
	 * `bad_setup_command` for one longer than MAX_SETUP_COMMAND_CHARS or with a character a shell cannot take.
	 */
	saveRepositorySetup(input: { repositoryId: number; command: string }): Promise<RepositorySetup>;
	/**
	 * The names, scopes and times of the secrets the user saved for a repository, and what each reaches
	 * in a sandbox of `profile`. With `sessionId`, one of the user's sessions on that repository, it is
	 * said for that session's sandbox, whose Windlass may be an older one (`SessionSummary.envLists`);
	 * without, for a sandbox made now. No value: a saved value is never sent to a client. Asks GitHub
	 * nothing. `sessionId` means the same in the two actions below, which answer with the list.
	 */
	repositorySecrets(input: { repositoryId: number; profile: SandboxProfileId; sessionId?: string }): Promise<RepositorySecrets>;
	/**
	 * Saves a secret of a repository. With `value`: a new secret, or a new value for the one of that
	 * name. Without: only the scope of the one of that name is changed. It reaches a setup command in
	 * sandboxes made from then on, and Windlass from each session's next turn. Throws a UserError with
	 * code `bad_secret` for a name or value that cannot be saved, `too_many_secrets` at
	 * MAX_SECRETS_PER_REPOSITORY, and `secret_not_found` for a scope change of a name that is not saved.
	 */
	saveRepositorySecret(input: { repositoryId: number; profile: SandboxProfileId; sessionId?: string; name: string; value?: string; scope: SecretScope }): Promise<RepositorySecrets>;
	/** Deletes a secret of a repository. A sandbox whose setup command already had it keeps what that command made of it. */
	deleteRepositorySecret(input: { repositoryId: number; profile: SandboxProfileId; sessionId?: string; name: string }): Promise<RepositorySecrets>;
	/**
	 * What is kept for a repository, by GitHub's id for it: the defaults for new sessions and the
	 * remembered approvals of its MCP servers. Asks GitHub nothing, and answers for a repository the
	 * user can no longer reach, too: what was saved stays until its user deletes it.
	 */
	repository(repositoryId: number): Promise<RepositoryView>;
	/**
	 * The repository as GitHub has it now, when the user's connection covers it and the connected user
	 * may read it: what a new session can be launched on. Throws a UserError that says what is in the
	 * way: `github_off`, `github_not_connected`, `github_gone` or `github_denied` when it cannot be used
	 * for new sessions, `github_unreachable` or `github_failed` when GitHub could not be asked.
	 */
	githubRepository(repositoryId: number): Promise<GithubRepository>;
	/**
	 * Saves what new sessions on a repository start with. A field that is left out stays as it is;
	 * null saves none for it. Throws a UserError with code `bad_input` for a sandbox this deployment
	 * does not offer or cannot run, and `bad_model` for a model that is not among the user's.
	 */
	saveRepositoryDefaults(input: { repositoryId: number; profile?: SandboxProfileId | null; model?: string | null }): Promise<RepositoryDefaults>;
	/**
	 * Forgets the user's remembered approvals of that MCP server for a repository, whatever its
	 * definition was (`RepositoryView.forgetting` says what stays). Resolves when nothing was remembered, too.
	 */
	forgetRepositoryApproval(input: { repositoryId: number; name: string }): Promise<RepositoryView>;
	/**
	 * Deletes everything kept for a repository: its setup command, its secrets, its defaults and the
	 * remembered approvals. The user's sessions on it stay, and their next sandbox is made without them.
	 */
	forgetRepository(repositoryId: number): Promise<RepositoryView>;
	/** The repositories something is kept for, by name. Asks GitHub nothing. */
	savedRepositories(): Promise<SavedRepository[]>;
	/** The account's settings: the defaults for new sessions and the user's own MCP servers. No secret's value. */
	account(): Promise<AccountSettings>;
	/**
	 * Saves what new sessions start with where neither the launch form nor the repository says. A field
	 * that is left out stays as it is; null saves none for it. Throws as `saveRepositoryDefaults` does.
	 */
	saveAccountDefaults(input: { profile?: SandboxProfileId | null; model?: string | null }): Promise<AccountDefaults>;
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
	/** Destroys the session's actor and its sandbox. */
	deleteSession(id: string): Promise<void>;
	/** Today's sandbox time and the count of kept sandboxes, as the user's actor has them. Asks no provider. */
	allowance(): Promise<UsageNumbers>;
	/**
	 * The usage page: today's sandbox time against the allowance, by agent, the kept sandboxes, the last
	 * two weeks and what a second is estimated to cost. The count of kept sandboxes is first held
	 * against the provider's own list of the user's sandboxes, so what is shown is what exists.
	 */
	usage(): Promise<UsageView>;
	/**
	 * Removes the sandbox of one of the user's agents, to make room for another: the files in its
	 * workspace go with it, and the agent and its conversation stay (`UsageView.memory` says what
	 * becomes of the agent's own memory). The agent's next prompt starts a new sandbox. Throws a
	 * UserError with code `sandbox_busy` while the agent works. Answers with the page as it is then.
	 */
	freeSandbox(sessionId: string): Promise<UsageView>;
}

export interface UserEvents {
	/** The full list, newest first, after any change to it. */
	sessions: SessionSummary[];
	/** Today's numbers, after sandbox time was held or counted, or a sandbox was kept or freed. */
	usage: UsageNumbers;
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
			 * "question_allowed" is the same for a question the platform allowed itself: Windlass's question
			 * about the tool that hands the agent's request to publish to the platform, and its question
			 * about a tool of one of the user's own MCP servers whose tools run without asking
			 * (`PersonalServer.unasked`). The `approval.answered` that follows has choice "once", and nobody was asked.
			 */
			code?: "question_expired" | "question_allowed";
			call?: { messageId: string; callId: string };
	  }
	/** A durable Windlass event, or one of the stored ephemeral ones (`notice`, `workspace.changes`, `cli.summary`). */
	| { seq: number; at: number; turn: number; kind: "windlass"; event: WindlassEvent }
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

/**
 * Streaming output that is broadcast but never stored: `text.delta`, `reasoning.delta`, `tool.input.delta`,
 * `tool.progress`. And one event of the platform's own, in the same shape: `{ type: "setup.output", id, text }`,
 * what a run of the repository's setup command printed since the delta before it (`id` is the run's,
 * as on its `setup` items; `text` is to be appended, and a reader keeps the end of it).
 */
export interface LiveDelta {
	turn: number;
	event: WindlassEvent;
}

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
	/** Switches the session's model from this turn on: one of the user's (`UserActions.models`). */
	model?: string;
	/** One of the efforts the turn's model accepts. */
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
	 * A turn that would start is also held to its user's two limits (`UsageNumbers`), before a sandbox is
	 * created or started: code `allowance_used` when too little of the day's sandbox time is left, and
	 * `too_many_sandboxes` when the session needs a sandbox and its user keeps as many as they may. Each
	 * comes with a sentence that says what was used, what the limit is, and what to do or when it resets.
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
/**
 * `GET` on the same address: this deployment's `PlatformConnection`, as JSON. Asked when the web app
 * starts and again whenever its token runs out.
 */
export const PLATFORM_CONNECTION_PATH = "/platform/connection";

export const MAX_PROMPT_CHARS = 20_000;
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
/** How long a question waits for an answer before the platform declines it. */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
/** Sessions of one user that may run a turn at the same time. */
export const MAX_RUNNING_SESSIONS = 3;
/** How many days of sandbox time the usage page lists, today included. */
export const USAGE_HISTORY_DAYS = 14;
/** The share of the day's allowance below which a session says how little is left. */
export const USAGE_LOW_SHARE = 0.2;
