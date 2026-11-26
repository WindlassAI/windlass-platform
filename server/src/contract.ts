/** Shared wire types and runtime constants for the actors, runner and web app. Keep all runtime imports browser-safe. */

import type { SlackSettingsActions } from "./contract/slack.js";
export type * from "./contract/slack.js";
import type { UsageNumbers, BillingPeriod, PlanInfo, BillingView, UsageView } from "./contract/usage.js";
export type { UsageNumbers, HostedMonth, PlanId, BillingPeriod, PlanInfo, BillingView, UsageSession, UsageDay, KeptSandbox, UsagePrice, UsageView } from "./contract/usage.js";
import type { HostedSize, HostedSizeOption } from "./contract/hosted-sizes.js";
export type { HostedSize, HostedSizeOption } from "./contract/hosted-sizes.js";
export type { Isolation } from "./contract/isolation.js";
export { ISOLATION_LINES, ISOLATION_NAMES, PROFILE_ISOLATION, isolationName, openLine } from "./contract/isolation.js";
export { HOSTED_SIZES, HOSTED_SIZE_NAMES, HOSTED_SIZE_SPECS, ITEM_HOSTED_SIZE, SESSION_HOSTED_SIZE, isHostedSize, hostedSizeWords, hostedSizeFor, largerHostedSize, outOfMemoryWords } from "./contract/hosted-sizes.js";

// Sandboxes

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
	/** The user's word for it: "Strict" or "Open" (contract/isolation.ts). Where it runs is said beside it, never in it. */
	name: string;
	/** One outcome line, free of provider and technology names: "Commands sandboxed, no internet. For untrusted code." */
	summary: string;
	/** How it is isolated, in full: shown only behind "How it's isolated", where provider and technology names belong. */
	details?: string;
	/** What isolates the agent, outermost layer first. Short phrases; technical, so only behind "How it's isolated". */
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
	/** Commands can read the turn's token file, including a usable relay placeholder. The renewing sign-in stays outside the sandbox. */
	commandsCanReadAccessToken: boolean;
	/** Can commands read the real access token? Defaults to commandsCanReadAccessToken when absent. */
	accessTokenReadable?: boolean;
	/** A relayed turn keeps only a per-turn placeholder in the sandbox. Without the relay the file holds the access token. */
	modelRelay?: true;
	available: boolean;
	/** Why it cannot be chosen yet. Set when `available` is false. */
	unavailableReason?: string;
}

// Platform information (GET PLATFORM_INFO_PATH)

export interface PlatformInfo {
	googleLogin?: true;
	/** True when the server runs with WLP_DEMO=1: the demo sign-in is offered and its model is scripted. */
	demoEnabled: boolean;
	/** The Windlass version inside the sandbox image, e.g. "0.4.0". */
	windlassVersion: string | null;
	profiles: SandboxProfile[];
	/** Restricted allows the model API, GitHub and approved hosts. None allows only the model API. Absent when no restriction is reported. */
	hostedEgress?: "restricted" | "none";
	/** Smallest first. Omitted when the deployment offers a single fixed size. */
	hostedSizes?: HostedSizeOption[];
	/** Absent or null disables GitHub integration. */
	github?: GithubInfo | null;
	/** Absent disables the machines route. */
	machines?: MachinesInfo;
	/** Absent disables items and API token actions. A deployment-wide screenshot refusal overrides repository settings. */
	items?: { reviewer: boolean; orchestrate?: boolean; screenshots?: boolean };
	/** Set when the deployment takes payment for plans (WLP_BILLING_PROVIDER). Absent: no plans, the deployment's own limits, and nothing of billing shown. */
	billing?: { plans: PlanInfo[] };
}

/** Published runner capabilities and connection details for pairing. The runner volume preserves the pairing key across updates within a protocol. */
export interface MachinesInfo {
	platformFingerprint?: string;
	/** Oldest compatible runner release for this deployment's protocol. */
	minRunnerVersion: string;
	/** The runner image to install, pinned by digest; null while none is published, and the page says it cannot be installed yet. */
	runnerImage: string | null;
	/** Harnesses built into this exact published image, from its capabilities command. */
	runnerHarnesses?: Array<Exclude<HarnessId, "windlass">>;
	/** The platform's address as a runner on another machine reaches it: `--platform` in the install command. */
	platformUrl: string;
}

// The models a user may choose (`UserActions.models`)

/** One model, and the reasoning efforts it accepts: none for a model that takes no effort. */
export interface ModelChoice {
	id: string;
	/** What the provider calls it, where that is not its id. */
	name: string | null;
	efforts: string[];
}

/** Account-specific model and effort choices, cached by the user actor. */
export interface ModelList {
	/** An unavailable list has neither a fresh answer nor a cached account list. */
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

// The browser's connection to the actors (HTTP, `GET PLATFORM_CONNECTION_PATH`)

/** A token of the Rivet engine's for browsers: good for a while, and for reaching this deployment's actors only. */
export interface ConnectionToken {
	token: string;
	/** When the engine stops accepting it, ms since the epoch, by the engine's clock. */
	expiresAt: number;
	/** Count from receipt. The browser clock can differ from the server by more than a token lifetime. */
	validForMs: number;
}

/** What a browser needs to reach the actors. */
export interface PlatformConnection {
	/** Null uses the endpoint built into the web app, falling back to DEFAULT_ENDPOINT. */
	endpoint: string | null;
	/** The namespace the actors live in. */
	namespace: string;
	/** Null when the engine asks for no token: the local engine of a development server. */
	token: ConnectionToken | null;
}

// login actor

/** Opaque to the web app: stored and sent back as the `token` connection parameter. */
export type AuthToken = string;

export interface UserProfile {
	uid: string;
	/** The verified address supplied by the login provider, when available. */
	email: string | null;
	/** A demo user has no ChatGPT sign-in: its sessions run a scripted model. */
	demo: boolean;
}

export interface AuthResult {
	token: AuthToken;
	profile: UserProfile;
}

export type LoginProvider = "github" | "google";

export interface LinkedLogin {
	provider: LoginProvider;
	/** Provider login or email for display. Older links may have no label until the next sign-in. */
	display: string | null;
	/** The provider's name for the person, and an https picture address, captured at the last sign-in. */
	name: string | null;
	avatar: string | null;
}

export interface LoginStart {
	url: string;
	redirectPrefix: string;
	/** When this attempt stops being accepted, ms since the epoch. */
	expiresAt: number;
}

// user actor

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
	/** An unfinished turn resumes when its server or machine returns. Messages wait meanwhile. */
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
export type PlatformToolName = "publish" | "report" | "request_secret" | "ask_person" | "push" | "fetch_base" | "file_review" | "file_plan" | "file_plan_review" | "file_repo_setup" | "file_repo_setup_review";

/** Screens choose behavior by capability, so a new harness needs no agent-name checks. */
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

/** Milliseconds from slot admission to first output. Phases that did not run are omitted. */
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
	/** Absent or null for pasted URLs and sessions without a repository. */
	repository?: SessionRepository | null;
	/** The pull request the platform opened for the session's work, once there is one. */
	pullRequest?: PullRequestInfo | null;
	/** May bypass publish confirmation only where isolated commands have neither network nor token-file access. Else ask on every request. */
	publishUnasked?: boolean;
	createdAt: number;
	/** Last session activity, including turns, questions and pull request changes. */
	updatedAt: number;
	/** Start of the current turn, for its elapsed clock. */
	turnStartedAt?: number;
	status: SessionStatus;
	/** Machine-paused turns resume on reconnect and deliver any held messages. */
	paused?: { reason: "restart" | "machine"; since: number; held: number };
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** The last few turns' start times, oldest first (StartTimes). */
	startTimes?: StartTimes[];
	/** Whether the sandbox exists and whether it is running or paused. */
	sandbox: "none" | "running" | "paused";
	/** Reload servers() when changedAt advances. Absent when the session has no known MCP servers. */
	servers?: { count: number; changedAt: number };
	/** Item sessions receive prompts from the factory. The recorded sign-in determines token accounting for machine agents. */
	item?: { id: string; role?: "builder" | "reviewer"; subtaskScreenshots?: boolean; planCritic?: true; reviewer?: { id: string; status: SessionStatus }; signIn?: "api-key" | "chatgpt" | "subscription" };
	/** Set for a session that only builds a prepared environment (environments.ts): it is not listed, and is deleted when done. */
	environmentBuild?: true;
	readiness?: true;
	/** Set when the session's sandbox started from a validated environment: the commit setup and the checks ran at, and when they passed. */
	environment?: { commit: string; validatedAt: number; checks: number };
}

export function itemSessionRole(item: NonNullable<SessionSummary["item"]>): string {
	return item.planCritic ? "Plan review" : item.role === "reviewer" ? "Code review" : "Builder";
}

export function sessionTitle(session: Pick<SessionSummary, "title" | "item">): string {
	return session.item ? `${session.title} · ${itemSessionRole(session.item)}` : session.title;
}

/** The user index keeps one builder per item. Its reviewer is reachable from the item and counts toward its usage. */
export function listedSessions(sessions: SessionSummary[]): SessionSummary[] {
	const reviewers = new Map(sessions.flatMap(s => s.item?.role === "reviewer" && !s.item.planCritic ? [[s.item.id, { id: s.id, status: s.status }] as const] : []));
	return sessions.filter(s => s.item?.role !== "reviewer" && !s.environmentBuild && !s.readiness).map(session => {
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
	/** Defaults to "New agent"; replaced by the first prompt’s opening phrase when left unset. */
	title?: string;
	/** Left out: run on the hosted layer. */
	place?: SandboxPlace;
	profile: SandboxProfileId;
	/** An account model or a model offered by the machine's harness. Omit to use its default. */
	model?: string;
	/** An https git address to clone into the workspace. */
	repoUrl?: string;
	/** A connected repository is exclusive with repoUrl. Omit branch to use the repository default. */
	repository?: { id: GithubId; branch?: string };
	/** Omission preserves the saved command. An empty string clears it before session creation. */
	setupCommand?: string;
	/** With `repository`: `SessionSummary.publishUnasked` to start with. Left out: the agent's requests to publish are asked about. Refused (`bad_input`) for a profile it cannot be on in. */
	publishUnasked?: boolean;
	/** The key of this submission (`IdempotencyKey`): the same key again answers with the session the first attempt made, for as long as that session exists. */
	idempotencyKey?: IdempotencyKey;
}

/** Replay the first accepted answer for the same key and payload. A refused submission leaves the key unused.
 * Missing or null disables deduplication. Invalid keys fail with bad_idempotency_key; changed payloads with idempotency_key_reused. */
export type IdempotencyKey = string;

export interface ChatgptStatus {
	connected: boolean;
	email: string | null;
	/** When the saved sign-in's access token expires, ms since the epoch. The platform refreshes it when a turn needs a token within twenty minutes of that, or after. */
	accessExpiresAt: number | null;
}

// GitHub

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

/** Mapped teams file work on their repository through a qualifying label or app assignment. */
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
	/** Short verification summary from the last description the platform wrote. */
	verified: string;
}

/** The message of the commit the platform makes, and of the pull request when it opens one. */
export interface PublishMessage {
	title: string;
	body: string;
	/** Separate commit message for agent requests. Panel publishing uses the title and body. */
	commit?: string;
}

/** What the side panel shows about getting a session's work out. */
export interface PublishState {
	/** Null when the session does not work on a repository of the user's GitHub connection. */
	repository: SessionRepository | null;
	pullRequest: PullRequestInfo | null;
	/** The branch the work goes to: named for the session, and kept once something was pushed. */
	branch: string;
	/** Includes uncommitted files and unpublished commits. Null means checking would require starting the sandbox. */
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

/** Only the owner can set setup. It runs after clone and before the first turn as the sandbox user, outside Windlass command isolation. */
export interface RepositorySetup {
	/** The command as it is saved; "" when none is. */
	command: string;
	/** When it was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
	/** How long a run may take before the platform stops it. */
	timeoutMs: number;
}

/** Windlass runs these owner-defined checks before accepting a turn. */
export interface RepositoryCheck {
	/** Letters, digits, "_", "." and "-", starting with a letter or digit; no two of a list alike. */
	name: string;
	/** Run with `bash -c` in the repository's directory. */
	command: string;
	/** How long it may run, 1 to MAX_CHECK_TIMEOUT_SECONDS; absent: Windlass's own default (120). */
	timeoutSeconds?: number;
	/** Glob patterns of changed files that make it run; absent: any change does. */
	when?: string[];
	/** Include passing output in the PR too (Windlass outputTail “always”). */
	showOutput?: boolean;
}

/** `repositoryChecks`, and what saving answers with. */
export interface RepositoryChecks {
	/** In the order they run. */
	checks: RepositoryCheck[];
	/** When the list was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
}

// A repository's prepared environments (environments.ts)

/** Where an environment is kept: "hosted", or the id of one of the user's machines. */
export type EnvironmentPlace = string;
export type EnvironmentState = "building" | "retrying" | "interrupted" | "ready" | "failed" | "stale";
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
	/** Automatic retries started for this trigger. */
	retries?: number;
	/** This attempt ended before the place could report its result. */
	interrupted?: true;
	startedAt: number;
	/** When setup and the checks finished; null while it runs. For the ready part, when it was validated. */
	finishedAt: number | null;
	/** The base commit setup ran at; "" until the clone. */
	commit: string;
	/** Whether the build used the screenshots image. */
	screenshots?: true;
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
	/** Base-code failures are reported but do not block environment promotion. */
	codeFailures?: string[];
}

/** One place's environment of a repository. */
export interface RepositoryEnvironment {
	place: EnvironmentPlace;
	/** "Hosted", or the machine's name. */
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

// A repository's network list

/** Presets contain exact download and redirect hosts. The sandbox hosts file cannot pin wildcards. */
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

/** Warnings shared by every surface that offers to allow a broad host. */
export const WIDE_HOSTS: Readonly<Record<string, string>> = {
	"storage.googleapis.com": "storage.googleapis.com serves every public Google Cloud Storage bucket, anyone's: allowed, it lets a command send to or fetch from any of them, not only the one a download needs.",
};

/** A blocked lookup is a request only. Granting access requires repository settings permission. */
export interface NetworkRequest {
	host: string;
	/** When a command last asked for it, ms since the epoch. */
	at: number;
	/** The session whose sandbox it was looked up in; null when that is not known. */
	sessionId: string | null;
}

/** Exact hosts and presets extend restricted E2B egress for this repository. An active session can apply an approval immediately. */
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
	/** Deployment-wide egress before repository additions. In restricted mode hosts include the model API, Git host, bucket and operator allowlist. */
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

/** Verification is derived from Windlass's recorded gate for the turn and its measured file state. */
export type Verified = ({
	state: "not_needed";
	/** A restored state can refer to a prior check run or the state at turn start. */
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

	/** Failed checks whose changes were subsequently undone. They are separate from the run that verifies the final state. */
	putBack?: VerifiedCheck[];
	/** Last completed check run supporting this state. seq identifies checks.finished in the Windlass log. */
	run: { turn: number; at: number; seq: number; checks: VerifiedCheck[] } | null;
	/** The user's checks, as saved when `turn` started, that are neither among `run`'s nor among `putBack`. */
	unrun: Array<{ name: string; command: string }>;
	/** True when the user's checks were required ones in `turn` and the repository's file said something about checks or verification: that held for the repository's own checks, and not for the user's. */
	overruled?: boolean;
	/** True when Windlass recorded another state of the workspace after `run` finished than the one the checks ran on. */
	changedAfter: boolean;
}

/** Observations on the changes for a human reviewer. Post-check edits are recorded separately in Verified.changedAfter. */
export interface VerifiedFlag {
	kind: "tests_removed" | "tests_skipped" | "checks_changed" | "exit_ignored" | "agent_instructions_changed" | "outside_scope";
	/** What it was seen in: paths, at most a few. */
	where: string[];
}

/** Repository secrets always reach setup. Agent scope also exposes them to agent commands; account secrets never go to repository setup. */
export type SecretScope = "setup" | "agent";

/** Where commands are unisolated, withholding a secret from them also requires withholding it from Windlass and its MCP servers. */
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

// A repository's page

/** Saved defaults may outlive a model or sandbox. Ignore unavailable choices at launch. */
export interface RepositoryAutonomy {
	autoApprovePlans?: boolean;
	autoMergeSingles?: boolean;
	/** An offer limits automatic merge to these kinds. A manual opt-in covers every kind. */
	mergeKinds?: import("./factory/readiness-track.js").TaskKind[];
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

export type StartPlace = { kind: "hosted" } | { kind: "machine"; machineId: string; profile: SandboxProfileId };

export interface RepositoryDefaults extends RepositoryAutonomy, ItemPlaceDefaults {
	/** The place for interactive launches, independent of work-item placement and the hosted profile. */
	startPlace?: StartPlace | null;
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

export interface RepositoryView {
	knowledge: import("./repo-setup/types.js").SetupKnowledge;
	guideCheck: import("./repo-setup/types.js").GuideCheckStatus;
	readiness: import("./factory/readiness.js").RepositoryReadiness;
	/** GitHub's id for the repository. */
	id: GithubId;
	/** Last known owner/name. Query githubRepository for the current name. */
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

// The account's settings

/** Account defaults apply after explicit launch and repository choices. Ignore unavailable profiles and models. */
export type AccountDefaults = Omit<RepositoryDefaults, keyof RepositoryAutonomy | "screenshots" | "hostedSize">;

export type AccountDefaultsPatch = Partial<Omit<AccountDefaults, "updatedAt">>;
export type RepositoryDefaultsPatch = Partial<Omit<RepositoryDefaults, "updatedAt" | "mergeKinds">> & { offer?: import("./factory/readiness-track.js").Offer };

/** Last personal launch, retained after deleting the session. Item sessions never replace it. */
export interface LastStart {
	place: SandboxPlace;
	harness: HarnessId;
	/** The mode the agent started in: one of that agent's own. */
	mode: string;
	/** When, ms since the epoch. */
	startedAt: number;
}

/** User-owned MCP definition supplied to every session independent of repository configuration. */
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
	/** Allows tools to run without asking. Trust in their output is controlled separately by the definition. */
	unasked: boolean;
	/** Variables referenced by env or headers, in order. An unset variable prevents startup. */
	reads: Array<{ name: string; saved: boolean }>;
	/** When it was last saved, ms since the epoch. */
	updatedAt: number;
}

/** Show the server's reach before saving because user-owned MCP servers start without project approval. */
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

/** Account secrets expose only metadata here and never go to repository setup. */
export interface AccountSecret {
	/** The environment variable a server's definition reads it as. */
	name: string;
	/** A repository's secret's scopes, without the setup command: "setup" is MCP servers only, "agent" the agent's commands as well. */
	scope: SecretScope;
	/** When its value or scope was last changed, ms since the epoch. */
	updatedAt: number;
	/** What it reaches in the sandbox the list was asked for. */
	reach: SecretReach;
	/** Repository-specific value and scope override the account secret in these repositories. */
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
	windlassModels?: string[];
}

/** A failed check leaves the key saved and returns a message safe to display. */
export type ModelProviderCheck = ModelProviderStatus & { message?: string };

export interface AccountSecrets {
	secrets: AccountSecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

// Paired machines

/** Waiting means paired but never connected. Offline means previously connected; since records the last contact. */
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
/** Whose credential a machine agent uses for a provider both can serve: the machine's own sign-in, or the owner's Settings key. */
export type CredentialSource = "machine" | "key";
export interface MachineDetails { whenToUse: string; tags: string[]; orchestrator?: "yes" | "named" | "never" }
export interface MachineSlotCapacity {
	max: number;
	unit: { cpus: number; memoryBytes: number; pids: number };
	reserve: { cpus: number; memoryBytes: number };
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
	/**
	 * `signInReason`: with `signIn` "unknown", why the runner could not check the sign-in (runner 0.3.4 and later).
	 * `machineSignIns`: the providers the machine's own sign-in serves. `platformKeys`: the Settings keys its turns
	 * use, after `source`, the owner's choice (absent: the machine's sign-in first, keys for the rest).
	 */
	harnesses?: Array<{ id: Exclude<HarnessId, "windlass">; adapter: string; image: string; loginGeneration?: string; keyRelay?: true; machineProviders?: string[]; machineSignIns?: ModelProvider[]; machineMethod?: "api-key" | "chatgpt"; source?: CredentialSource; platformKeys?: ModelProvider[]; method?: "api-key" | "chatgpt" | "subscription"; modes?: string[]; modeReason?: string; signIn: "token" | "none" | "unknown"; signInReason?: string; optionsDigest?: string; optionsCheckedAt?: number; options?: HarnessOptions }>;
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
	/** Runner-reported limits. Absent before the first report or when no cap is configured. */
	readySandboxes?: number;
	maxRunning?: number;
	maxSandboxes?: number;
	/** Snapshot and mirror limits in bytes. capped reflects deployment overrides; builtIn identifies limits inferred for older runners. */
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
	/** Platform-derived fingerprint of the pairing key, comparable with a runner that prints it. */
	keyFingerprint?: string;
	/** Whether this runner's version prints the key's fingerprint while it pairs. Older ones show only the code. */
	keyPrinted?: boolean;
}

// Work items

/** How many work items a page holds when it does not say, and at most (`listItems`). */
export const ITEM_PAGE_DEFAULT = 25;
export const ITEM_PAGE_MAX = 100;

/** Where a page of work items starts: after this item, the last of the page before. Both never change. */
export interface ItemCursor {
	createdAt: number;
	id: string;
}

/** Newest first. Omit ended to include open and ended items together. */
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

/** Per repository and filing source. Display names come from its newest filed item. */
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

/** Every open item, recent ended items and counts. Use listItems for older pages. Child items enter the main list when asking a question. */
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
	/** All open subtasks, including ones without questions. */
	children?: ItemSummary[];
}

/** Where an item is. "waiting" always comes with `ItemSummary.wait`. */
export type ItemState = "draft" | "queued" | "working" | "waiting" | "review" | "done" | "failed" | "cancelled";

/** Person and budget waits require an answer. Resource and CI waits can end on their own. */
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

/** Factory step names are persisted and appear on the item timeline. */
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
	/** Observed rounds, uncapped. Repeated failures, the budget and the turn backstop stop the run. */
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

/** Token budgets use cost-weighted input. The time limit applies to hosted sandboxes only. */
export interface ItemBudget {
	tokens: number;
	hostedSeconds: number;
}

/** Raw tokens count cached input at full weight; use tokens when rawTokens is absent. Active time excludes waits. */
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

/** Stored response IDs. Retry starts a new run. Again retries the failed step. */
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
	/** Why automatic plan approval needs the owner. Also included in the full question text. */
	criticReason?: string;
	criticFindings?: string[];
	text: string;
	choices: Array<{ id: ChoiceId; label: string }>;
	/** Suggested answer. Older clients and stored questions may omit it. */
	recommended?: ChoiceId;
	askedAt: number;
	secret?: SecretRequest;
	/** Untrusted builder text. Quote as plain text, separate from platform wording, and never post externally. */
	asked?: { text: string; options: string[] };
	/** Show the check's diagnostic and output tail as plain command output. */
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
	/** Retained after answering. Keep untrusted agent text separate from the platform's said field. */
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

/** Evidence for this pushed head comes from the recorded gate, change flags and CI. A verdict never merges work. */
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
	/** A different PR head has no verification from this verdict and cannot pass. */
	moved: string | null;
	/** CI, and each of `flags` (in the same order), in a sentence as the server words them for the item's log and the pull request. */
	said: { ci: string; flags: string[] };
}

// Reviews and reports

/** What a reviewer recommends. It never changes `Verdict.result`. */
export type ReviewRecommendation = "approve" | "changes_requested" | "needs_person";

/** Redacted text with limited formatting: paragraphs, bullets, inline code and bounded fences. Never interpret HTML, links or images. */
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

/** The author's claim references a platform record. Render the observed result separately from the claim. */
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

/** Builder-authored report, presented separately from platform evidence. */
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
	/** Referenced platform records at filing time. */
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
	/** The sign-in method at filing. Each turn records the method it uses. */
	signIn?: "api-key" | "chatgpt" | "subscription";
	/** Subscription tokens are shown but do not count toward the budget. Unreported tokens are unknown. */
	tokens: "counted" | "subscription" | "not_reported";
	/** Every token the agent reported over the item's turns, counted or not. */
	reportedTokens: number;
	/** Subscription tokens on an item that also has counted turns. */
	subscriptionTokens?: number;
	/** The cost the agent reported for its conversation so far (OpenCode's `usage_update.cost`); null where it reported none. */
	cost: { amount: number; currency: string } | null;
	/** Claude Code's 5-hour window, % used, at the start of the item's first turn and at the end of its latest. */
	fiveHour: { first: number; latest: number } | null;
}

/** How a work item was filed. */
export type ItemSource = "web" | "api" | "github" | "linear" | "slack";

/** The PR closes this issue in the item's repository. The sender added the label or wrote the command. */
export interface GithubIssueOrigin {
	issue: { number: number; url: string; author: string; trusted: boolean };
	sender: string;
	linear?: undefined;
}

/** Linear provenance is separate from the GitHub PR binding. The event sender and issue author may differ. */
export interface LinearIssueOrigin {
	/** `trusted`: the issue creator's id matches the user who connected the workspace; whoever added the label does not make another person's text trusted. */
	linear: { id: string; identifier: string; url: string; author: string; trusted: boolean };
	sender: string;
	issue?: undefined;
}

export type ItemOrigin = GithubIssueOrigin | LinearIssueOrigin;

export interface ItemSummary {
	record?: import("./factory/readiness-track.js").ItemRecord | null;
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
	/** Last activity on the item. Background polls can advance its revision independently. */
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
	/** Remaining unattended subtask keys that each require confirmation at approval. */
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
	profile?: "docker-hardened" | "docker-windlass-sandbox" | "e2b-open" | "daytona";
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

/** Repository merge prerequisites are separate from subtask build dependencies. */
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

/** Cross-repo verification uses each integrated head. Run the command from the named repository beside its checked-out inputs. */
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
	/** Optional why supplies background shown separately from the question. */
	questions: { id: string; text: string; options?: string[]; why?: string; recommended?: string; answer?: string; answeredBy?: "critic" }[];
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
	/** Cross-repo plans list one or two repositories, starting with repository. Omission uses that repository alone. */
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
	/** Approval requires every remaining unattended subtask key. Cross-repo base changes require confirmation at the current heads. */
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

/** The bearer value is shown once. Only its digest is retained until revocation. */
export interface ApiToken {
	id: string;
	name: string;
	scopes: ApiTokenScope[];
	createdAt: number;
	/** When it was last used, to the minute; null before. */
	usedAt: number | null;
}

export interface UserActions extends SlackSettingsActions {
	signOutEverywhere(options?: { revokeApiTokens: boolean }): Promise<void>;
	me(): Promise<UserProfile>;
	linkedLogins(): Promise<LinkedLogin[]>;
	unlinkLogin(provider: LoginProvider): Promise<void>;
	chatgpt(): Promise<ChatgptStatus>;
	startChatgpt(): Promise<LoginStart>;
	finishChatgpt(callback: string): Promise<void>;
	forgetChatgpt(): Promise<void>;
	/** On fetch failure return cached or fallback choices and identify their source. */
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
	/** Short-lived, single-use ticket bound to the user who started the connection. */
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
	/** Search owner/name, newest push first. Use fresh after changing an installation's repository access. */
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
	/** Static scan of the default branch and the saved setup command. It executes nothing and persists nothing. */
	scanRepositoryNetwork(repositoryId: GithubId): Promise<NetworkScan>;
	/** Return metadata and profile-dependent reach. Secret values stay on the server. */
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
	/** Local settings survive loss of GitHub access. */
	repository(repositoryId: GithubId): Promise<RepositoryView>;
	setGuideCheck(repositoryId: GithubId, enabled: boolean): Promise<RepositoryView>;
	setSetupWeekly(repositoryId: GithubId, enabled: boolean): Promise<void>;
	addSetupNotes(repositoryId: GithubId, files: import("./repo-setup/types.js").NoteInput[]): Promise<RepositoryView>;
	deleteSetupNote(repositoryId: GithubId, id: string): Promise<RepositoryView>;
	runReadiness(repositoryId: GithubId, noteIds?: string[], answers?: Record<string, "keep" | "drop">): Promise<RepositoryView>;
	/**
	 * The repository as GitHub has it now, when the user's connection covers it and the connected user
	 * may read it: what a new session can be launched on. Throws a UserError that says what is in the
	 * way: `github_off`, `github_not_connected`, `github_gone` or `github_denied` when it cannot be used
	 * for new sessions, `github_unreachable` or `github_failed` when GitHub could not be asked.
	 */
	githubRepository(repositoryId: GithubId): Promise<GithubRepository>;
	/** Omitted fields keep their values. Explicit null clears a default. */
	saveRepositoryDefaults(input: RepositoryDefaultsPatch & { repositoryId: GithubId }): Promise<RepositoryDefaults>;
	/** Forget all remembered definitions by name. Repeated calls succeed. */
	forgetRepositoryApproval(input: { repositoryId: GithubId; name: string }): Promise<RepositoryView>;
	/** Drop the repository's saved configuration, secrets and approvals. Existing sessions survive. */
	forgetRepository(repositoryId: GithubId): Promise<RepositoryView>;
	/** The repositories something is kept for, by name. Asks GitHub nothing. */
	savedRepositories(): Promise<SavedRepository[]>;
	/** The account's settings: the defaults for new sessions and the user's own MCP servers. No secret's value. */
	account(): Promise<AccountSettings>;
	/** Omission preserves a field and null clears it. Repository overrides still take precedence. */
	saveAccountDefaults(input: AccountDefaultsPatch): Promise<AccountDefaults>;
	/** Clears the remembered launch so saved start places apply. The next personal launch is remembered again. */
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
	/** On machine_unreachable the session stays listed so deletion can be retried. */
	deleteSession(id: string): Promise<void>;
	/** Today's sandbox time and the count of kept sandboxes, as the user's actor has them. Asks no provider. */
	allowance(): Promise<UsageNumbers>;
	/** Reconcile kept sandboxes against the provider inventory before returning usage. */
	usage(): Promise<UsageView>;
	/** The account's plan, its subscription and this month's hosted minutes; `{ enabled: false }` where the deployment has no billing. */
	billing(): Promise<BillingView>;
	/** The checkout return origin must belong to the web app. */
	billingCheckout(input: { period: BillingPeriod; origin: string }): Promise<{ url: string }>;
	/** The provider's customer portal, to change the card or cancel. Throws `billing_off` or `no_customer`. */
	billingPortal(input: { origin: string }): Promise<{ url: string }>;
	/** Sets the overage spend cap, US cents from 0 to `maxCapCents`: the server stops hosted sandboxes at it. Throws `bad_input` or `billing_off`. */
	setOverageCap(input: { cents: number }): Promise<BillingView>;
	/** Refuse while busy. Freeing discards the workspace but preserves the session and its conversation. */
	freeSandbox(sessionId: string): Promise<UsageView>;
	/** Pairing order. Machine actions refuse with machines_off when disabled. */
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
	setCredentialSource(input: { machineId: string; harness: Exclude<HarnessId, "windlass">; source: CredentialSource }): Promise<MachineSummary[]>;
	/** Unpaged calls return every item, newest first. A short page is the last one. */
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

// agentSession actor

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

/** Name an untitled agent from a complete opening sentence or clause. */
export function promptTitle(prompt: string): string {
	// A short one-line prompt is its own title; a longer one gives its first sentence or clause.
	const whole = prompt.replace(/\s+/g, " ").trim();
	if (whole && !prompt.trim().includes("\n") && whole.length <= 60) return whole;
	const line = prompt.trim().split(/\n|(?<=[.!?])\s+/, 1)[0]!.replace(/\s+/g, " ").trim();
	if (line && line.length <= MAX_TITLE_CHARS) return line;
	const clause = line.split(/;\s*|,?\s+(?:and then|then|and|so that|in order to|using|without|which|because)\s+/i, 1)[0]!.trim();
	return clause && clause.length <= MAX_TITLE_CHARS ? clause : "Work on the requested task";
}

/** The title an ACP update may give a personal session whose owner has not named it. */
export function generatedSessionTitle(update: AcpUpdate, owner: { typed?: boolean; item?: { role?: "builder" | "reviewer" } }, redactor?: { text(value: string): string }): string | undefined {
	if (update.sessionUpdate !== "session_info_update" || typeof update.title !== "string" || owner.typed || owner.item) return;
	const line = update.title.replace(/[\s\u0085]/gu, " ").replace(/\p{Cc}/gu, "").replace(/ +/g, " ").trim();
	// Removing controls can join fragments of a secret. Redact the whole line before cutting it.
	const safe = redactor?.text(line) ?? line;
	return safe.match(/^.{1,200}/u)?.[0].trimEnd();
}

/** Session sequence numbers are dense and independent of Windlass event sequence numbers. */
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
			/** A steering message joins the running turn at its next step. */
			steer?: boolean;
			/** Sources of quoted GitHub feedback, also used when rebuilding the prompt after a pause. */
			untrusted?: string[];
			/** A message sent while the turn was paused: held, and given to the agent when the turn resumes. */
			held?: boolean;
	  }
	/** Something the platform did around a turn: "Starting a hosted sandbox (Strict)", "Cloning repository". */
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
	/** Setup emits start and finish items with the same ID. Intervening output streams live; only the ending tail persists. */
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

/** Streaming deltas, including setup.output, are broadcast and never stored. */
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
	/** A pre-prompt approval holds the turn. A request discovered mid-turn expires when that turn ends. */
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

/** Last server status Windlass reported in the session. */
export interface SessionServer {
	name: string;
	/** User-owned servers start without project approval. Absent origin means project. */
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
	/** Null until the session sees a definition wait for approval. Approval must match its fingerprint. */
	fingerprint: string | null;
	/** When the session last heard something new of it, ms since the epoch. */
	at: number;
	/** The user's remembered approval of this definition for the session's project: when they approved, and until when it holds. */
	approval: { approvedAt: number; expiresAt: number } | null;
	/** A prior approval for a different fingerprint cannot authorize the changed definition. */
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
	/** Reads retained session state and remembered approvals without starting a sandbox. */
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

// Constants

/** Where the server's Rivet endpoint listens in development. */
export const DEFAULT_ENDPOINT = "http://localhost:6420";
/** Origin for the server's own routes in development. */
export const DEFAULT_PLATFORM_URL = "http://localhost:6440";
/** `GET` on the platform's HTTP address: this deployment's `PlatformInfo`, as JSON. */
export const PLATFORM_INFO_PATH = "/platform/info";
/** Fetch at startup and again when the browser connection token expires. */
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
/** Interactive prompts hold a sandbox while waiting. Work-item questions close the turn and can wait longer. */
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
