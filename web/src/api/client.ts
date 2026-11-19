/**
 * `PlatformClient`: the one interface the screens use to reach the backend. Two implementations:
 * `mock.ts` (in memory, no network) and `rivet.ts` (the real actors over `rivetkit/client`).
 *
 * Everything in the contract is reachable through it, shaped the way the screens use it: plain
 * async calls for actions, and `watch` / `open` for the two live feeds. Both feeds hand over a whole
 * state first (`onSessions`, `onSnapshot`) and again after every reconnect, because events that
 * happen while a connection is down are lost.
 */
import type {
	AccountDefaults,
	AccountSecrets,
	AccountSettings,
	AuthResult,
	ChatgptStatus,
	CreateSessionInput,
	GithubBranchList,
	GithubRepository,
	GithubRepositoryList,
	GithubStatus,
	LiveDelta,
	LoginStart,
	ModelList,
	PendingQuestion,
	PlatformInfo,
	PromptInput,
	PublishMessage,
	PublishResult,
	PublishState,
	RepositoryCheck,
	RepositoryChecks,
	RepositoryDefaults,
	RepositorySecrets,
	RepositorySetup,
	RepositoryView,
	SandboxProfileId,
	SavedRepository,
	SecretScope,
	SessionServers,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
	UsageNumbers,
	UsageView,
	UserProfile,
	WorkspaceFile,
} from "@contract";

export type ClientKind = "mock" | "rivet";

export type PlatformErrorCode =
	/** The server said so on purpose (a UserError): `message` is fit to show as it is. */
	| "user"
	/** The token was refused: sign in again. */
	| "unauthorized"
	/** No such session. */
	| "not_found"
	/** The server could not be reached, or the connection could not be opened. */
	| "network"
	/** Anything else: `message` is generic. */
	| "internal";

/**
 * Codes the server gives a UserError that the screens act on (contract.ts): `no_question` from
 * `answer()` (that question is no longer pending), `turn_running` from `prompt()` (a turn that is
 * starting or stopping cannot take a message), and the two limits a user can run into, which the
 * screens answer with the way to the usage page: `allowance_used` (too little of the day's sandbox
 * time is left) and `too_many_sandboxes` (the user keeps as many sandboxes as they may).
 */
export type PlatformErrorReason = "no_question" | "turn_running" | "allowance_used" | "too_many_sandboxes" | (string & {});

export class PlatformError extends Error {
	readonly code: PlatformErrorCode;
	/** For code "user": the code the server gave its UserError, when it gave one. */
	readonly reason: PlatformErrorReason | null;
	constructor(code: PlatformErrorCode, message: string, options?: { cause?: unknown; reason?: PlatformErrorReason | null }) {
		super(message, options);
		this.name = "PlatformError";
		this.code = code;
		this.reason = options?.reason ?? null;
	}
}

/** Whether something thrown at the interface is a UserError with this code. */
export function hasReason(error: unknown, reason: PlatformErrorReason): boolean {
	return error instanceof PlatformError && error.reason === reason;
}

/** A message fit to show for anything thrown at the interface. */
export function errorMessage(error: unknown): string {
	if (error instanceof PlatformError) return error.message;
	if (error instanceof Error && error.message !== "") return error.message;
	return "Something went wrong.";
}

export type ConnectionState =
	| "connecting"
	| "connected"
	/** The connection dropped and is being opened again; what is shown may be stale. */
	| "reconnecting"
	/** The connection cannot be opened (the feed's `error` says why) and will not be retried. */
	| "failed";

export interface UserFeed {
	/** The full list, newest first: once when the feed opens, then after every change and reconnect. */
	onSessions(sessions: SessionSummary[]): void;
	/** Today's sandbox time and the count of kept sandboxes, whenever either changes. */
	onUsage?(numbers: UsageNumbers): void;
	onConnection?(state: ConnectionState, error?: PlatformError): void;
}

export interface SessionFeed {
	/** The whole session: once when the feed opens and again after every reconnect. Rebuild from it. */
	onSnapshot(snapshot: SessionSnapshot): void;
	onItem(item: TimelineItem): void;
	onDelta(delta: LiveDelta): void;
	onSummary(summary: SessionSummary): void;
	/** The pending question, when one is asked; null when it was settled. The snapshot carries it too. */
	onQuestion(question: PendingQuestion | null): void;
	onConnection(state: ConnectionState, error?: PlatformError): void;
}

export interface UserApi {
	me(): Promise<UserProfile>;
	chatgpt(): Promise<ChatgptStatus>;
	/** The models the user may choose and the efforts of each: their ChatGPT plan's, or the stand-in, and which it is. */
	models(): Promise<ModelList>;
	listSessions(): Promise<SessionSummary[]>;
	/** Makes an agent. With `idempotencyKey`, the same call again answers with the agent the first one made, while that agent exists. */
	createSession(input: CreateSessionInput): Promise<SessionSummary>;
	renameSession(id: string, title: string): Promise<SessionSummary>;
	deleteSession(id: string): Promise<void>;
	/** The user's GitHub connection. Only asked where the deployment has a GitHub App (`PlatformInfo.github`). */
	github(): Promise<GithubStatus>;
	/** Begins connecting GitHub: the address at GitHub to send the browser to. With `install`, the app's installation page. */
	githubConnect(origin: string, install?: boolean): Promise<{ url: string }>;
	/** Finishes connecting with the ticket the browser came back from GitHub with. */
	githubComplete(ticket: string): Promise<GithubStatus>;
	githubDisconnect(): Promise<GithubStatus>;
	githubRepositories(query: string, fresh?: boolean): Promise<GithubRepositoryList>;
	githubBranches(repositoryId: number): Promise<GithubBranchList>;
	/** The setup command the user saved for a repository of their GitHub connection; `command` is "" when there is none. */
	repositorySetup(repositoryId: number): Promise<RepositorySetup>;
	/** Saves it, or none with "". Throws with reason `bad_setup_command` for one that is too long. */
	saveRepositorySetup(repositoryId: number, command: string): Promise<RepositorySetup>;
	/** The checks the user saved for a repository of their GitHub connection, in the order they run. */
	repositoryChecks(repositoryId: number): Promise<RepositoryChecks>;
	/** Saves the list whole, or none with an empty one. Throws with reason `bad_checks` for a list that cannot be saved. */
	saveRepositoryChecks(repositoryId: number, checks: RepositoryCheck[]): Promise<RepositoryChecks>;
	/**
	 * The secrets saved for a repository, without their values, and what each reaches in a sandbox of
	 * `profile`: the sandbox of the session `sessionId` names, whose Windlass may be an older one, or
	 * without it a sandbox made now. A value is sent to the server when it is saved and never comes back.
	 */
	repositorySecrets(repositoryId: number, profile: SandboxProfileId, sessionId?: string): Promise<RepositorySecrets>;
	/** Saves a secret: with `value` a new one or a new value, without it only the scope. Throws with reason `bad_secret`, `too_many_secrets` or `secret_not_found`. */
	saveRepositorySecret(repositoryId: number, profile: SandboxProfileId, secret: { name: string; value?: string; scope: SecretScope }, sessionId?: string): Promise<RepositorySecrets>;
	deleteRepositorySecret(repositoryId: number, profile: SandboxProfileId, name: string, sessionId?: string): Promise<RepositorySecrets>;
	/** What is kept for a repository beside its setup command and its secrets: the defaults for new agents and the remembered approvals of its MCP servers. Asks GitHub nothing. */
	repository(repositoryId: number): Promise<RepositoryView>;
	/**
	 * The repository as GitHub has it now: what a new agent can be launched on. Throws with reason `github_off`,
	 * `github_not_connected`, `github_gone` or `github_denied` when it cannot be used for new agents, and
	 * `github_unreachable` or `github_failed` when GitHub could not be asked.
	 */
	githubRepository(repositoryId: number): Promise<GithubRepository>;
	/** Saves what new agents on a repository start with: a field left out stays, null saves none. Throws with reason `bad_input` or `bad_model` for what the deployment does not offer. */
	saveRepositoryDefaults(repositoryId: number, change: { profile?: SandboxProfileId | null; model?: string | null }): Promise<RepositoryDefaults>;
	/** Forgets the remembered approvals of that MCP server for a repository. */
	forgetRepositoryApproval(repositoryId: number, name: string): Promise<RepositoryView>;
	/** Deletes everything kept for a repository: setup command, checks, secrets, defaults and remembered approvals. The agents on it stay. */
	forgetRepository(repositoryId: number): Promise<RepositoryView>;
	/** The repositories something is kept for. Asks GitHub nothing. */
	savedRepositories(): Promise<SavedRepository[]>;
	/** The account's settings: the defaults for new agents and the user's own MCP servers. No secret's value. */
	account(): Promise<AccountSettings>;
	/** Saves what new agents start with where neither the launch form nor the repository says: a field left out stays, null saves none. Throws as `saveRepositoryDefaults` does. */
	saveAccountDefaults(change: { profile?: SandboxProfileId | null; model?: string | null }): Promise<AccountDefaults>;
	/**
	 * Saves an MCP server of the user's own: a new one, or with `existing` the definition of the one of that name.
	 * Throws with reason `bad_server` (the message names the key), `server_exists`, `server_not_found` or `too_many_servers`.
	 */
	savePersonalServer(server: { name: string; definition: unknown; unasked?: boolean; existing?: boolean }): Promise<AccountSettings>;
	deletePersonalServer(name: string): Promise<AccountSettings>;
	/** The account's secrets, without their values, and what each reaches in a sandbox of `profile` made now. */
	accountSecrets(profile: SandboxProfileId): Promise<AccountSecrets>;
	/** Saves a secret of the account: a new one, or a new value for the one of that name. Throws with reason `bad_secret` or `too_many_secrets`. */
	saveAccountSecret(profile: SandboxProfileId, secret: { name: string; value?: string; scope: SecretScope }): Promise<AccountSecrets>;
	deleteAccountSecret(profile: SandboxProfileId, name: string): Promise<AccountSecrets>;
	/** Today's sandbox time against the allowance, and how many sandboxes the user keeps of how many they may. */
	allowance(): Promise<UsageNumbers>;
	/** The usage page: the numbers, today by agent, the kept sandboxes, the last two weeks and what a second is estimated to cost. */
	usage(): Promise<UsageView>;
	/** Frees one agent's sandbox to make room: its workspace files go, the agent and its conversation stay. Throws with reason `sandbox_busy` while it works. */
	freeSandbox(sessionId: string): Promise<UsageView>;
	/** Opens the live list of sessions. Returns the function that closes it. */
	watch(feed: UserFeed): () => void;
}

export interface SessionApi {
	/** Opens the session's live feed. Returns the function that closes it. */
	open(feed: SessionFeed): () => void;
	/** Asks for a fresh `onSnapshot` on every open feed (after a gap in the item numbering). */
	resync(): void;
	/**
	 * Starts a turn, or steers the running one (`steered: true`). With `idempotencyKey`, the key of this
	 * submission (lib/submission.ts), a message the server took before under that key is not taken again:
	 * the answer is its first attempt's. Throws with reason `idempotency_key_reused` for a key that came with another text.
	 */
	prompt(input: PromptInput): Promise<{ turn: number; steered: boolean }>;
	/** Answers the pending question. Throws with reason `no_question` when it is no longer pending. */
	answer(input: { questionId: string; choice: string; note?: string }): Promise<void>;
	/** Stops one running tool call; `stopped: false` comes with Windlass's reason. */
	stopCall(input: { messageId: string; callId: string }): Promise<{ stopped: boolean; message: string | null }>;
	stop(): Promise<void>;
	changes(): Promise<WorkspaceFile[]>;
	diff(): Promise<string>;
	/** What the side panel shows about the session's pull request. */
	publishState(): Promise<PublishState>;
	/** Commits, pushes, and opens the pull request when none is open. It can take a minute. */
	publish(message: PublishMessage): Promise<PublishResult>;
	/** Sets whether the agent may have the platform publish without the user being asked each time (`SessionSummary.publishUnasked`). */
	setPublishUnasked(unasked: boolean): Promise<SessionSummary>;
	/** The MCP servers the session's project names, each as the session last heard of it, with the remembered approval where there is one. */
	servers(): Promise<SessionServers>;
	/** Approves a server that waits, by the fingerprint `servers()` gave. Throws with reason `server_changed` when it no longer waits with that definition. */
	approveServer(name: string, fingerprint: string): Promise<SessionServers>;
	/** Forgets the remembered approvals of that server for the session's project. */
	forgetServer(name: string): Promise<SessionServers>;
}

export interface PlatformClient {
	readonly kind: ClientKind;
	/** Where the real backend is; null for the mock. */
	readonly endpoint: string | null;
	info(): Promise<PlatformInfo>;
	readonly login: {
		start(): Promise<LoginStart>;
		finish(pastedUrl: string): Promise<AuthResult>;
		demo(): Promise<AuthResult>;
	};
	user(auth: AuthResult): UserApi;
	session(auth: AuthResult, sessionId: string): SessionApi;
	/** Closes every connection. */
	dispose(): void;
}
