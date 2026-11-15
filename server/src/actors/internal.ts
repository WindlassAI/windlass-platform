/**
 * How the actors call each other. Each call goes through `c.client()` with a short-lived service token
 * as its credential (see tokens.ts); the actions on this page accept nothing else.
 *
 * The same credential is what a server shows the `user` actor when it asks for a user's sign-in or
 * access token (`internalAdoptSignIn`, `internalSignInStatus`, `internalSignOut`, `internalAccessToken`).
 * Those calls are not made from here: the code that runs a turn has no actor's `c`, so
 * signin/directory.ts makes them with a client of its own.
 */

import type { SandboxProfileId, SessionSummary } from "../contract.js";
import { serviceParams } from "../auth.js";
import type { StoredRepository } from "../github/publish.js";
import type { StoredConnection } from "../github/repos.js";
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
	demo: boolean;
	createdAt: number;
}

/** Actions of `user` that only actors may call. */
export interface UserInternal {
	internalSessionChanged(summary: SessionSummary): Promise<void>;
	/** Counts the session as running if the user is below MAX_RUNNING_SESSIONS. */
	internalAcquireRun(sessionId: string): Promise<{ ok: boolean; running: number; known: boolean }>;
	/** The user's GitHub connection as it is now; null when there is none. */
	internalGithubConnection(): Promise<StoredConnection | null>;
}

/** Actions of `agentSession` that only actors may call. */
export interface SessionInternal {
	internalSummary(): Promise<SessionSummary>;
	internalRename(title: string): Promise<SessionSummary>;
	/** Destroys the sandbox, then the actor. */
	internalDestroy(): Promise<void>;
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

/** Whether a call failed because the actor it was meant for does not exist (any more). */
export function isActorGone(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { group, code } = error as { group?: unknown; code?: unknown };
	return group === "actor" && (code === "not_found" || code === "destroying" || code === "destroyed");
}
