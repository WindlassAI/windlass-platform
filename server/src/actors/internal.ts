/**
 * How the actors call each other. Each call goes through `c.client()` with a short-lived service token
 * as its credential (see tokens.ts); the actions on this page accept nothing else.
 *
 * The same credential is what a server shows the `user` actor when it asks for a user's sign-in or
 * access token (`internalAdoptSignIn`, `internalSignInStatus`, `internalSignOut`, `internalAccessToken`).
 * Those calls are not made from here: the code that runs a turn has no actor's `c`, so
 * signin/directory.ts makes them with a client of its own.
 */

import { UserError } from "rivetkit";
import type { CreateSandboxInput } from "../sandbox/api.js";
import type { HarnessOptions, HarnessId, ItemAction, ItemSummary, ItemView, ModelList, RepositoryCheck, RepositorySetup, SandboxPlace, SandboxProfileId, SecretScope, SessionSummary, UsageNumbers } from "../contract.js";
import type { Fact } from "../factory/types.js";
import type { Delivery, TurnAnswer, TurnRelease, TurnRequest } from "./session-inbox.js";
import type { ItemCreateInput, ItemPublishAnswer } from "./work-item.js";
import type { ItemFacts } from "./user-items.js";
import { serviceParams } from "../auth.js";
import type { StoredRepository } from "../github/publish.js";
import type { StoredConnection } from "../github/repos.js";
import type { ServerApproval } from "../server-approvals.js";
import { issueServiceToken, verifyToken } from "../tokens.js";

/** What `user` passes when it creates an `agentSession`. */
export interface SessionCreateInput {
	mode?: string;
	harness?: HarnessId;
	harnessOptions?: HarnessOptions;
	/** A service token bound to this actor's key: proof that `user` created it. */
	grant: string;
	title: string;
	titleIsTyped: boolean;
	place: SandboxPlace;
	/** For a place on one of the user's machines: its name when the session was launched. */
	machineName?: string;
	profile: SandboxProfileId;
	model: string;
	repoUrl: string | null;
	/** Set when the session is launched on a repository of the user's GitHub connection; `repoUrl` is then its address. */
	repo?: StoredRepository | null;
	/** With `repo`: whether the agent may have the platform publish without the user being asked each time. */
	publishUnasked?: boolean;
	demo: boolean;
	createdAt: number;
	/** Set for a work item's session: its prompts come from that item (session-inbox.ts). Absent: a person's. */
	origin?: { kind: "item"; itemId: string; role?: "builder" | "reviewer" };
}

/** The repository setting selects an image only for work item sessions, at sandbox creation. */
export function sessionSandboxInput(session: Pick<CreateSandboxInput, "uid" | "sessionId" | "profile"> & Pick<SessionCreateInput, "origin" | "harness">, screenshots = false): CreateSandboxInput {
	const { uid, sessionId, profile, origin } = session;
	return { uid, sessionId, profile, ...(session.harness === "claude" ? { harness: session.harness } : {}), privateData: origin?.role === "reviewer", screenshots: origin?.kind === "item" && screenshots };
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
	internalMachineSystem(id: string): Promise<{ os: string; arch: string } | null>;
	internalPlannerMachines(): Promise<ReturnType<typeof import("../machines/details.js").plannerMachines>>;
	internalSessionChanged(summary: SessionSummary): Promise<void>;
	/** Takes over removing a deleted session's copy from the bucket, which the session could not do itself. */
	internalRemoveBackupLater(sessionId: string): Promise<void>;
	/** Counts the session as running if the user's hosted sessions at work are below their ceiling (`FactoryLimits.runningTurns`); one on a machine of theirs always is. */
	internalAcquireRun(sessionId: string): Promise<{ ok: boolean; running: number; known: boolean; until: number | null; claim: number | null }>;
	/** Gives back the running slot of the claim named `claim`, for a prompt the session refused after it was claimed; a newer claim, or one already settled, is left as it is. */
	internalReleaseRun(input: { sessionId: string; claim: number; summary: SessionSummary }): Promise<{ released: boolean }>;
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
	/** The session's place among the kept sandboxes, claimed right before its sandbox is made (`UsageBook.claim`). */
	internalClaimPlace(sessionId: string): Promise<{ ok: boolean; numbers: UsageNumbers } | { ok: false; reason: "gone" }>;
	/** The models the user may choose and the efforts of each (account-models.ts): their plan's, or what stands in for it. */
	internalModels(): Promise<ModelList>;
	/** A work item's summary changed (user-items.ts). */
	internalItemChanged(summary: ItemSummary): Promise<void>;
	/** What an item reads of its user: its session's hosted seconds in the ledger, and the user's open items. */
	internalItemFacts(sessionIds: string[]): Promise<ItemFacts>;
	/** An item session asks for a running slot for the turn of a delivery: granted now, or queued (`SessionInternal.internalGrant` later). */
	internalRequestTurn(request: TurnRequest): Promise<TurnAnswer>;
	/** The turn a slot was given to ended, or could not start: the slot, by its id, is free. */
	internalTurnDone(input: TurnRelease): Promise<void>;
	/** A delivery that waited for a slot is not wanted any more. */
	internalWithdrawTurn(input: { sessionId: string; key: string }): Promise<void>;
}

/** A repository's secrets, and what the user keeps for their account, on their way to a session: each value as the `user` actor stores it, sealed (repo-secrets.ts). */
export interface SealedSecrets {
	/** Only the server-side redactor may use these values. The machine owner disabled sending them. */
	redactOnly?: boolean;
	screenshots?: boolean;
	/** What the secrets are saved for; null when the session has no repository of the GitHub connection. */
	project: string | null;
	secrets: Array<{ name: string; scope: SecretScope; sealed: string }>;
	/** The checks the user saved for that repository (repository-checks.ts); none without one. They are no secret: they come with the secrets because a turn needs both before it starts. */
	checks: RepositoryCheck[];
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
	internalFreeSandbox(throughReviewRun?: number): Promise<{ freed: boolean }>;
	/** A work item's message (its `deliver` effect), into the inbox: resolves once it is stored; the same key again adds nothing. */
	internalDeliver(input: Delivery): Promise<void>;
	/** The user's turn queue gives the delivery of `key` its slot. */
	internalGrant(input: { key: string; slot: string }): Promise<void>;
	/** The turn of `key` is not wanted any more: out of the inbox, or stopped. */
	internalWithdraw(key: string): Promise<void>;
	/** Whether the turn of `turn` still runs (a `turn_running` fact with `check`), how it ended, or null when it has not started. */
	internalCheckTurn(input: { turn: string; check: string }): Promise<Fact | null>;
	/** Pushes the item's work and opens or updates its pull request, with the agent's report or else the item's title and body. */
	internalPublish(input: { key: string; title: string; body: string }): Promise<ItemPublishAnswer>;
}

/** Actions of `workItem` that only actors may call. */
export interface ItemInternal {
	internalFilePlan(input: { key: string; plan: unknown }): Promise<string>;
	internalSummary(): Promise<ItemSummary>;
	internalView(): Promise<ItemView>;
	internalAct(input: { action: ItemAction; by: string }): Promise<ItemView>;
	/** A fact about the item's turn; resolves once it is stored. */
	internalFact(fact: Fact): Promise<void>;
}

interface HasClient {
	// The registry's type is not named here: actors that call each other would make it circular.
	// biome-ignore lint/suspicious/noExplicitAny: see above
	client(): any;
}

function creationSubject(kind: string, key: readonly string[]): string {
	return `create:${encodeURIComponent(kind)}:${key.map(encodeURIComponent).join("/")}`;
}

export function createGrant(kind: string, key: readonly string[]): string {
	return issueServiceToken(creationSubject(kind, key));
}

export function grantIsValid(grant: unknown, key: readonly string[], kind: string): boolean {
	const caller = verifyToken(grant);
	if (caller?.kind === "service" && caller.subject === creationSubject(kind, key)) return true;
	console.warn(`[wlp] actor.create_refused kind=${kind} keyParts=${key.length}`);
	return false;
}

export async function createSessionActor(c: HasClient, uid: string, sessionId: string, input: Omit<SessionCreateInput, "grant">): Promise<void> {
	if (input.origin && input.mode !== undefined) throw new UserError("A work item and its reviewer use the profile’s approval mode.", { code: "bad_input" });
	if (input.origin && input.harness !== undefined && input.harness !== "windlass") throw new UserError("Work items and their reviewers run only with Windlass.", { code: "bad_input" });
	const full: SessionCreateInput = { ...input, grant: createGrant("agentSession", [uid, sessionId]) };
	await c.client().agentSession.create([uid, sessionId], { input: full, params: serviceParams() });
}

/** Whether a create failed because an actor of that key exists: for an id derived from a key, a creation that was tried before. */
export function isDuplicateKey(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { group, code } = error as { group?: unknown; code?: unknown };
	return group === "actor" && code === "duplicate_key";
}

/** Creates a work item; one of that key that exists already is the one a creation tried before made. */
export async function createItemActor(c: HasClient, uid: string, itemId: string, input: Omit<ItemCreateInput, "grant">): Promise<void> {
	const full: ItemCreateInput = { ...input, grant: createGrant("workItem", [uid, itemId]) };
	try {
		await c.client().workItem.create([uid, itemId], { input: full, params: serviceParams() });
	} catch (error) {
		if (!isDuplicateKey(error)) throw error;
	}
}

export function itemActor(c: HasClient, uid: string, itemId: string): ItemInternal {
	return c.client().workItem.get([uid, itemId], { params: serviceParams() }) as ItemInternal;
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
