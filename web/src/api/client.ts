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
	AuthResult,
	ChatgptStatus,
	CreateSessionInput,
	GithubBranchList,
	GithubRepositoryList,
	GithubStatus,
	LiveDelta,
	LoginStart,
	PendingQuestion,
	PlatformInfo,
	PromptInput,
	PublishMessage,
	PublishResult,
	PublishState,
	RepositorySetup,
	SessionServers,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
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
 * starting or stopping cannot take a message).
 */
export type PlatformErrorReason = "no_question" | "turn_running" | (string & {});

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
	listSessions(): Promise<SessionSummary[]>;
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
	/** Opens the live list of sessions. Returns the function that closes it. */
	watch(feed: UserFeed): () => void;
}

export interface SessionApi {
	/** Opens the session's live feed. Returns the function that closes it. */
	open(feed: SessionFeed): () => void;
	/** Asks for a fresh `onSnapshot` on every open feed (after a gap in the item numbering). */
	resync(): void;
	/** Starts a turn, or steers the running one (`steered: true`). */
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
