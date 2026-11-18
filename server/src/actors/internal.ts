/**
 * How the actors call each other. Each call goes through `c.client()` with a short-lived service token
 * as its credential (see tokens.ts); the actions on this page accept nothing else.
 *
 * The same credential is what a server shows the `user` actor when it asks for a user's sign-in or
 * access token (`internalAdoptSignIn`, `internalSignInStatus`, `internalSignOut`, `internalAccessToken`).
 * Those calls are not made from here: the code that runs a turn has no actor's `c`, so
 * signin/directory.ts makes them with a client of its own.
 */

import type { ModelList, RepositorySetup, SandboxProfileId, SecretScope, SessionSummary, UsageNumbers } from "../contract.js";
import { serviceParams } from "../auth.js";
import type { StoredRepository } from "../github/publish.js";
import type { StoredConnection } from "../github/repos.js";
import type { ServerApproval } from "../server-approvals.js";
import { issueServiceToken, verifyToken } from "../tokens.js";

/** What `user` passes when it creates an `agentSession`. */
export interface SessionCreateInput {
	/** A service token bound to this actor's key: proof that `user` created it. */
	grant: string;
	title: string;
	titleIsDefault: boolean;
	profile: SandboxProfileId;
	model: string;
	repoUrl: string | null;
	/** Set when the session is launched on a repository of the user's GitHub connection; `repoUrl` is then its address. */
	repo?: StoredRepository | null;
	/** With `repo`: whether the agent may have the platform publish without the user being asked each time. */
	publishUnasked?: boolean;
	demo: boolean;
	createdAt: number;
}

/** What a session asks for when its sandbox is about to run or goes on running (usage.ts, `ReserveInput`). */
export interface ReserveRequest {
	/** The new hold's id, made by the session: the same request sent twice is one hold. */
	id: string;
	sessionId: string;
	/** True when the session has no sandbox and is about to have one made. */
	keep?: boolean;
	/** True when a turn, or a paused sandbox, is about to start. */
	fresh?: boolean;
	/** The hold the session has, and the seconds its sandbox ran of it. */
	settle?: { hold: string; seconds: number };
}

/**
 * The answer: the hold and how many seconds it is for, or which limit refused it ("gone": the user
 * has no such session any more). Either way with the user's numbers as they are then.
 */
export type ReserveAnswer = { ok: true; hold: { id: string; seconds: number }; numbers: UsageNumbers } | { ok: false; reason: "allowance" | "sandboxes" | "gone"; numbers: UsageNumbers };

/** Actions of `user` that only actors may call. */
export interface UserInternal {
	internalSessionChanged(summary: SessionSummary): Promise<void>;
	/** Takes over removing a deleted session's copy from the bucket, which the session could not do itself. */
	internalRemoveBackupLater(sessionId: string): Promise<void>;
	/** Counts the session as running if the user is below MAX_RUNNING_SESSIONS. */
	internalAcquireRun(sessionId: string): Promise<{ ok: boolean; running: number; known: boolean }>;
	/** The user's GitHub connection as it is now; null when there is none. */
	internalGithubConnection(): Promise<StoredConnection | null>;
	/** The user's remembered approvals of a project's MCP servers that have not run out, the newest first (server-approvals.ts). */
	internalServerApprovals(project: string): Promise<ServerApproval[]>;
	/** Remembers that the user approved exactly this definition of a server for a project, from now. Answers with the project's approvals. */
	internalServerApprove(input: { project: string; label: string; name: string; fingerprint: string }): Promise<ServerApproval[]>;
	/** Forgets the user's approvals of that server for a project. Answers with how many there were, and the project's approvals that are left. */
	internalServerForget(input: { project: string; name: string }): Promise<{ forgotten: number; approvals: ServerApproval[] }>;
	/** The setup command the user saved for a repository, by its key (setup-command.ts); `command` is "" when there is none. */
	internalSetupCommand(project: string): Promise<RepositorySetup>;
	/** Takes a hold of the user's sandbox time for the session, and a place among the kept sandboxes when it needs one: both, or neither. */
	internalReserve(input: ReserveRequest): Promise<ReserveAnswer>;
	/** The session's sandbox stopped: counts the seconds it ran of its hold. `known` is false when that hold is not open any more. */
	internalSettle(input: { sessionId: string; hold: string; seconds: number }): Promise<{ known: boolean }>;
	/** The session has no sandbox any more: its place among the kept ones is free. */
	internalRelease(sessionId: string): Promise<void>;
	/** The models the user may choose and the efforts of each (account-models.ts): their plan's, or what stands in for it. */
	internalModels(): Promise<ModelList>;
}

/** A repository's secrets, and what the user keeps for their account, on their way to a session: each value as the `user` actor stores it, sealed (repo-secrets.ts). */
export interface SealedSecrets {
	/** What the secrets are saved for; null when the session has no repository of the GitHub connection. */
	project: string | null;
	secrets: Array<{ name: string; scope: SecretScope; sealed: string }>;
	/**
	 * What the session's user keeps for their account, whatever the repository: the account's secrets,
	 * each value sealed (account-secrets.ts), and the user's own MCP servers with their definitions as
	 * Windlass takes them and whether their tools run without asking (personal-servers.ts).
	 */
	account?: { secrets: Array<{ name: string; scope: SecretScope; sealed: string }>; servers: Array<{ name: string; definition: Record<string, unknown>; unasked: boolean }> };
}

/** Actions of `user` that only one session may call, with a token made for it (`secretsActor`). */
export interface UserSecretsInternal {
	internalSessionSecrets(sessionId: string): Promise<SealedSecrets>;
}

/** Actions of `agentSession` that only actors may call. */
export interface SessionInternal {
	internalSummary(): Promise<SessionSummary>;
	internalRename(title: string): Promise<SessionSummary>;
	/** Destroys the sandbox, then the actor. */
	internalDestroy(): Promise<void>;
	/** Removes the session's sandbox for its user, who is making room: the session and its timeline stay. `freed` is false when it had none. */
	internalFreeSandbox(): Promise<{ freed: boolean }>;
}

interface HasClient {
	// The registry's type is not named here: actors that call each other would make it circular.
	// biome-ignore lint/suspicious/noExplicitAny: see above
	client(): any;
}

export function createGrant(uid: string, sessionId: string): string {
	return issueServiceToken(`create:${uid}/${sessionId}`);
}

export function grantIsValid(grant: unknown, key: string[]): boolean {
	const caller = verifyToken(grant);
	return caller?.kind === "service" && caller.subject === `create:${key[0]}/${key[1]}`;
}

export async function createSessionActor(c: HasClient, uid: string, sessionId: string, input: Omit<SessionCreateInput, "grant">): Promise<void> {
	const full: SessionCreateInput = { ...input, grant: createGrant(uid, sessionId) };
	await c.client().agentSession.create([uid, sessionId], { input: full, params: serviceParams() });
}

export function sessionActor(c: HasClient, uid: string, sessionId: string): SessionInternal {
	return c.client().agentSession.get([uid, sessionId], { params: serviceParams() }) as SessionInternal;
}

export function userActor(c: HasClient, uid: string): UserInternal {
	return c.client().user.get([uid], { params: serviceParams() }) as UserInternal;
}

/** What the service token of a session that asks for its repository's secrets is made for. */
export function secretsCaller(uid: string, sessionId: string): string {
	return `secrets:${uid}/${sessionId}`;
}

/**
 * The `user` actor as a session reaches it for its repository's secrets: with a token that names this
 * user and this session, which is the only one `internalSessionSecrets` takes.
 */
export function secretsActor(c: HasClient, uid: string, sessionId: string): UserSecretsInternal {
	return c.client().user.get([uid], { params: { token: issueServiceToken(secretsCaller(uid, sessionId)) } }) as UserSecretsInternal;
}

/** Whether a call failed because the actor it was meant for does not exist (any more). */
export function isActorGone(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { group, code } = error as { group?: unknown; code?: unknown };
	return group === "actor" && (code === "not_found" || code === "destroying" || code === "destroyed");
}
