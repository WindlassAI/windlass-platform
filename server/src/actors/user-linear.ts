/**
 * The owner's side of the Linear integration, inside the user's actor: the workspace the owner connected, the teams they
 * mapped to repositories, and what one verified delivery comes to. The HTTP routes (linear/connect.ts, linear/webhook.ts)
 * and the per-workspace actor (linear-workspace.ts) reach it only through service actions.
 *
 * What is kept, and where.
 *   linear_connection  one row: the workspace, its app user, the teams Linear listed when it was read, and the OAuth token,
 *                      sealed for this user and this workspace (signin/seal.ts, purpose "secret") like a repository's secret.
 *                      The token never leaves the actor in the clear: it is not in any answer, any log, or the directory.
 *   linear_mapping     one row per mapped team: the repository of the owner's GitHub connection it files to. The source of
 *                      truth. The workspace actor holds a copy only to answer the webhook route quickly, and filing
 *                      reads this table again, so a mapping that was removed, or a team that left the workspace, cannot file.
 *   linear_state       the numbers of the connections that were begun, each good once (a replay finds nothing) and bound
 *                      to the web origin that began it.
 *
 * Connecting. `linearConnect` (the owner, signed in) makes a signed state naming this user and the web app's own address, and a
 * PKCE verifier kept here. The server's callback claims the state once (`internalLinearClaim`), exchanges the code, and hands
 * the result back sealed in transit (`internalLinearComplete`): the engine between the server and this actor never carries a token.
 *
 * Authorship. An app token cannot say which person authorized it (linear/app.ts), so no Linear person is the owner's own:
 * every issue is filed as third-party text (a draft, quoted), as GitHub's issues of other people are.
 */

import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { clientError, serviceParams } from "../auth.js";
import { config, linearConfig, ownEngineEndpoint } from "../config.js";
import type { GithubId, LinearMapping, LinearStatus, LinearTeam, LinearTeamList } from "../contract.js";
import type { LinearFiled, LinearFiling } from "../factory/intake.js";
import { linearId } from "../factory/intake.js";
import { githubApp } from "../github/app.js";
import { githubId, isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository, type StoredConnection } from "../github/repos.js";
import { LinearError, isLinearId, linearApp, newVerifier, challengeOf, redactLinear, type LinearApp, type LinearIdentity, type LinearToken, type LinearTeam as ProtocolTeam } from "../linear/app.js";
import { type LinearClaim, type LinearConnectStore, type LinearConnection as ProtocolConnection } from "../linear/connect.js";
import type { LinearDelivery } from "../linear/webhook.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { readSignedPayload, signedPayload } from "../signatures.js";
import { serverSealer } from "../signin/seal.js";
import { createClient } from "rivetkit/client";
import { isActorGone } from "./internal.js";
import { intakeScope } from "./issue-intake.js";
import type { ItemsState } from "./user-items.js";

export const LINEAR_TABLES = [
	`CREATE TABLE IF NOT EXISTS linear_connection (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		workspace TEXT NOT NULL,
		app_user TEXT NOT NULL,
		teams TEXT NOT NULL,
		sealed TEXT NOT NULL,
		connected_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS linear_mapping (
		team_id TEXT PRIMARY KEY,
		repository_id TEXT NOT NULL,
		owner TEXT NOT NULL,
		name TEXT NOT NULL,
		saved_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS linear_state (
		nonce TEXT PRIMARY KEY,
		verifier TEXT NOT NULL,
		origin TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
];

export const LINEAR_STATE_TTL_MS = 10 * 60_000;
/** How many connections may be begun and left unfinished. */
const MAX_PENDING = 20;
/** A token this close to its end is refreshed before it is used. */
const REFRESH_MARGIN_MS = 60_000;
/** What no Linear person's id can be: nobody is the owner's own author (see the top of this file). */
const NOBODY = "unknown";
const PROJECT = (workspaceId: string) => `linear:${workspaceId}`;
const TOKEN_NAME = "oauth-token";

export interface LinearCtx {
	key: string[];
	db: RawAccess;
	vars: { items: Pick<ItemsState, "created" | "items">; github: StoredConnection | null };
	client(): any;
	log: { error(entry: unknown): void; warn(entry: unknown): void };
}

// ---------------------------------------------------------------------------------------------
// The signed state
// ---------------------------------------------------------------------------------------------

const STATE_PREFIX = "ln1";

interface StatePayload { k: "linear-state"; uid: string; nonce: string; origin: string; exp: number }

/**
 * A state is signed under the key of GitHub's states with its own prefix, which the MAC covers: a GitHub state is not a Linear one,
 * nor the reverse. Used once: the user's actor issued its number and takes it out when it is claimed.
 */
function issueState(uid: string, nonce: string, origin: string, now = Date.now()): string {
	const payload: StatePayload = { k: "linear-state", uid, nonce, origin, exp: now + LINEAR_STATE_TTL_MS };
	return signedPayload(STATE_PREFIX, "github-state", payload);
}

function readState(token: unknown): StatePayload | null {
	const fields = readSignedPayload(token, STATE_PREFIX, 8192, kind => kind === "linear-state" ? "github-state" : null);
	if (!fields) return null;
	const { uid, nonce, origin, exp } = fields;
	if (typeof uid !== "string" || uid === "" || typeof nonce !== "string" || nonce === "" || typeof origin !== "string" || typeof exp !== "number") return null;
	return { k: "linear-state", uid, nonce, origin, exp };
}

// ---------------------------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------------------------

interface Stored {
	workspace: { id: string; name: string; urlKey: string };
	appUser: { id: string; name: string };
	teams: ProtocolTeam[];
	sealed: string;
	connectedAt: number;
}

async function readConnection(db: RawAccess): Promise<Stored | null> {
	const [row] = await db.execute<{ workspace: string; app_user: string; teams: string; sealed: string; connected_at: number }>("SELECT workspace, app_user, teams, sealed, connected_at FROM linear_connection WHERE id = 1");
	return row ? { workspace: JSON.parse(row.workspace), appUser: JSON.parse(row.app_user), teams: JSON.parse(row.teams), sealed: row.sealed, connectedAt: row.connected_at } : null;
}

async function readMappings(db: RawAccess): Promise<LinearMapping[]> {
	const rows = await db.execute<{ team_id: string; repository_id: string; owner: string; name: string; saved_at: number }>("SELECT team_id, repository_id, owner, name, saved_at FROM linear_mapping ORDER BY team_id");
	// GitHub's ids are numbers where they are exact (github/ids.ts); the column is text, so they are read back through `githubId`.
	return rows.flatMap(r => { const id = githubId(r.repository_id); return id === null ? [] : [{ teamId: r.team_id, repository: { id, owner: r.owner, name: r.name }, savedAt: r.saved_at }]; });
}

const lower = (id: string) => id.toLowerCase();

const queues = new WeakMap<object, Promise<unknown>>();

/** One change of the connection or its token at a time: Linear rotates a refresh token, so two refreshes must not race. */
function inLinearQueue<T>(c: LinearCtx, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(c.vars) ?? Promise.resolve()).then(job);
	queues.set(c.vars, next.catch(() => undefined));
	return next;
}

function requireLinear(): LinearApp {
	const app = linearApp();
	if (!app) throw new UserError("This deployment has no Linear app, so Linear cannot be connected here.", { code: "linear_off" });
	return app;
}

const notConnected = () => new UserError("Linear is not connected. Connect a Linear workspace first.", { code: "linear_not_connected" });
const reconnect = () => new UserError("Linear no longer accepts this connection. Connect Linear again.", { code: "linear_reconnect" });

function workspaceActor(c: LinearCtx, workspaceId: string) {
	return c.client().linearWorkspace.getOrCreate([workspaceId], { params: serviceParams() });
}

/** What the owner is told of a failure at Linear; anything else is logged and answered in general words. */
function linearFailure(c: LinearCtx, error: unknown, fallback: string): UserError {
	if (error instanceof UserError) return error;
	if (error instanceof LinearError) {
		if (error.unauthorized) return reconnect();
		if (error.unreachable) return new UserError("Linear could not be reached. Try again.", { code: "linear_unreachable" });
		if (error.rateLimited) return new UserError("Linear is limiting requests. Try again in a minute.", { code: "linear_unreachable" });
	}
	return clientError(c.log, error instanceof Error ? new Error(redactLinear(error.message)) : error, fallback);
}

// ---------------------------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------------------------

function sealToken(uid: string, workspaceId: string, token: LinearToken): string {
	return sealSecret(serverSealer(), uid, PROJECT(workspaceId), TOKEN_NAME, JSON.stringify(token));
}

function openToken(uid: string, stored: Stored): LinearToken {
	try {
		const token = JSON.parse(openSecret(serverSealer(), uid, PROJECT(stored.workspace.id), TOKEN_NAME, stored.sealed)) as LinearToken;
		if (typeof token.accessToken !== "string" || token.accessToken === "") throw new Error("no token");
		return token;
	} catch {
		throw new LinearError(401, "the saved connection cannot be opened", "use the saved Linear token", "AuthenticationError");
	}
}

/**
 * The connection's access token, refreshed when it is about to end. A token Linear no longer honours, or one that has expired with
 * no refresh token, is a `LinearError` that is `unauthorized`: the owner connects again.
 */
async function accessToken(c: LinearCtx, app: LinearApp): Promise<{ stored: Stored; token: string }> {
	return inLinearQueue(c, async () => {
		const uid = c.key[0]!;
		const stored = await readConnection(c.db);
		if (!stored) throw notConnected();
		const token = openToken(uid, stored);
		if (token.expiresAt === null || token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return { stored, token: token.accessToken };
		if (!token.refreshToken) throw new LinearError(401, "the token has expired", "use the saved Linear token", "AuthenticationError");
		const renewed = await app.refresh(token.refreshToken);
		const sealed = sealToken(uid, stored.workspace.id, { ...renewed, refreshToken: renewed.refreshToken ?? token.refreshToken });
		// Written before it is used: the old refresh token is spent.
		await c.db.execute("UPDATE linear_connection SET sealed = ? WHERE id = 1 AND connected_at = ?", sealed, stored.connectedAt);
		return { stored: { ...stored, sealed }, token: renewed.accessToken };
	});
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function connectedStatus(stored: Stored): LinearStatus {
	// The app token cannot name the person who authorized it (linear/app.ts), so the connection is shown as the app user's.
	return { state: "connected", connection: { workspace: stored.workspace, user: stored.appUser, appUser: stored.appUser, connectedAt: stored.connectedAt } };
}

export async function linearStatus(c: LinearCtx): Promise<LinearStatus> {
	if (!linearConfig().app) return { state: "off" };
	const stored = await readConnection(c.db);
	return stored ? connectedStatus(stored) : { state: "disconnected" };
}

/** Begins a connection for this user: the address at Linear to send the browser to. */
export async function beginLinearConnect(c: LinearCtx, input: { origin: string }): Promise<{ url: string }> {
	const app = requireLinear();
	const origin = typeof input?.origin === "string" ? input.origin.replace(/\/+$/, "") : "";
	// The browser is sent back there: only to the web app's own address.
	if (!config.origins.includes(origin)) throw new UserError("Linear can only be connected from the web app's own address.", { code: "origin_not_allowed" });
	try {
		const verifier = newVerifier();
		const nonce = newVerifier();
		const now = Date.now();
		await c.db.execute("DELETE FROM linear_state WHERE expires_at <= ?", now);
		// Somebody who begins again and again leaves no more than a few behind; the oldest go first.
		await c.db.execute("DELETE FROM linear_state WHERE nonce NOT IN (SELECT nonce FROM linear_state ORDER BY expires_at DESC LIMIT ?)", MAX_PENDING - 1);
		await c.db.execute("INSERT INTO linear_state (nonce, verifier, origin, expires_at) VALUES (?, ?, ?, ?)", nonce, verifier, origin, now + LINEAR_STATE_TTL_MS);
		return { url: app.authorizeUrl(issueState(c.key[0]!, nonce, origin, now), challengeOf(verifier)) };
	} catch (error) {
		throw linearFailure(c, error, "Connecting Linear could not be started. Try again.");
	}
}

/** Takes a state's number out of the list: it is there once. Answers with the verifier and the origin that began it. */
export async function claimLinearState(c: LinearCtx, nonce: string): Promise<{ ok: boolean; verifier: string | null; origin: string | null }> {
	if (typeof nonce !== "string" || nonce === "") return { ok: false, verifier: null, origin: null };
	// One statement: of two claims of one state, one gets the row.
	const [row] = await c.db.execute<{ verifier: string; origin: string; expires_at: number }>("DELETE FROM linear_state WHERE nonce = ? RETURNING verifier, origin, expires_at", nonce);
	if (!row || row.expires_at <= Date.now()) return { ok: false, verifier: null, origin: null };
	return { ok: true, verifier: row.verifier, origin: row.origin };
}

const transitSubject = (uid: string) => `linear-connect\n${uid}`;

/** What the server hands the actor after the code was exchanged: the token and what Linear confirmed, sealed for this user. */
export function sealConnection(uid: string, connection: ProtocolConnection): string {
	return serverSealer().seal("transit", transitSubject(uid), JSON.stringify(connection));
}

function readConnectionBlob(uid: string, blob: string): { token: LinearToken; identity: LinearIdentity; teams: ProtocolTeam[] } {
	const parsed = JSON.parse(serverSealer().open("transit", transitSubject(uid), blob)) as ProtocolConnection;
	const { token, identity, teams } = parsed;
	if (typeof token?.accessToken !== "string" || !isLinearId(identity?.workspace?.id) || !isLinearId(identity?.appUser?.id) || !Array.isArray(teams)) throw new Error("The connection is not well formed.");
	return { token, identity, teams: teams.filter(team => isLinearId(team?.id) && typeof team.key === "string") };
}

/**
 * Records the connection that Linear confirmed for the state this user began. The workspace's directory learns its owner first
 * (the newest connection of a workspace is its owner's: only an administrator of the workspace can authorize the app), then the
 * connection is written. Mappings of teams the workspace still has are kept; the rest are dropped.
 */
export async function completeLinearConnection(c: LinearCtx, blob: string): Promise<void> {
	const uid = c.key[0]!;
	const { token, identity, teams } = readConnectionBlob(uid, blob);
	const workspace = { id: lower(identity.workspace.id), name: identity.workspace.name, urlKey: identity.workspace.urlKey };
	const appUser = { id: lower(identity.appUser.id), name: identity.appUser.name };
	const known = teams.map(team => ({ id: lower(team.id), key: team.key, name: team.name }));
	await inLinearQueue(c, async () => {
		const previous = await readConnection(c.db);
		const present = new Set(known.map(team => team.id));
		const kept = (previous?.workspace.id === workspace.id ? await readMappings(c.db) : []).filter(mapping => present.has(mapping.teamId));
		await workspaceActor(c, workspace.id).internalAttach({ uid, appUserId: appUser.id, mapped: kept.map(mapping => mapping.teamId) });
		const connectedAt = Date.now();
		await c.db.transaction(async tx => {
			await tx.execute("INSERT OR REPLACE INTO linear_connection (id, workspace, app_user, teams, sealed, connected_at) VALUES (1, ?, ?, ?, ?, ?)",
				JSON.stringify(workspace), JSON.stringify(appUser), JSON.stringify(known), sealToken(uid, workspace.id, token), connectedAt);
			await tx.execute("DELETE FROM linear_mapping WHERE team_id NOT IN (SELECT value FROM json_each(?))", JSON.stringify(kept.map(mapping => mapping.teamId)));
		});
		if (previous && previous.workspace.id !== workspace.id) {
			await workspaceActor(c, previous.workspace.id).internalRelease(uid).catch(() => console.warn(`linear.workspace.release_failed uid=${uid}`));
		}
		console.log(`[wlp] linear.connected uid=${uid} workspace=${workspace.id} teams=${known.length} mapped=${kept.length}`);
	});
}

/** Another owner took this workspace: this connection no longer receives its deliveries, and its mappings go. */
export async function releaseLinearWorkspace(c: LinearCtx, workspaceId: string): Promise<void> {
	await inLinearQueue(c, async () => {
		const stored = await readConnection(c.db);
		if (!stored || stored.workspace.id !== lower(workspaceId)) return;
		await c.db.transaction(async tx => {
			await tx.execute("DELETE FROM linear_connection WHERE id = 1");
			await tx.execute("DELETE FROM linear_mapping");
		});
		console.log(`[wlp] linear.released uid=${c.key[0]} workspace=${stored.workspace.id}`);
	});
}

function teamList(teams: ProtocolTeam[], mappings: LinearMapping[]): LinearTeamList {
	const byTeam = new Map(mappings.map(mapping => [mapping.teamId, mapping]));
	return { teams: teams.map((team): LinearTeam => ({ id: team.id, key: team.key, name: team.name, mapping: byTeam.get(team.id) ?? null })) };
}

/**
 * The workspace's teams, read from Linear now, with the mapping of each. A mapping whose team left the workspace is dropped
 * here. When Linear cannot be reached the teams of the last read are shown.
 */
export async function linearTeams(c: LinearCtx, fresh = false): Promise<{ list: LinearTeamList; stored: Stored }> {
	const app = requireLinear();
	const { stored, token } = await accessToken(c, app).catch(error => { throw linearFailure(c, error, "The Linear teams could not be listed. Try again."); });
	let teams = stored.teams;
	try {
		teams = (await app.teams(token)).map(team => ({ id: lower(team.id), key: team.key, name: team.name }));
		await c.db.execute("UPDATE linear_connection SET teams = ? WHERE id = 1 AND connected_at = ?", JSON.stringify(teams), stored.connectedAt);
	} catch (error) {
		if (fresh || !(error instanceof LinearError && error.unreachable)) throw linearFailure(c, error, "The Linear teams could not be listed. Try again.");
	}
	const present = new Set(teams.map(team => team.id));
	const mappings = await readMappings(c.db);
	const gone = mappings.filter(mapping => !present.has(mapping.teamId));
	for (const mapping of gone) await unmap(c, stored.workspace.id, mapping.teamId);
	return { list: teamList(teams, mappings.filter(mapping => present.has(mapping.teamId))), stored };
}

/** Removes a mapping here first, then from the directory: a team the directory still routes is turned away by the filing. */
async function unmap(c: LinearCtx, workspaceId: string, teamId: string): Promise<void> {
	await c.db.execute("DELETE FROM linear_mapping WHERE team_id = ?", teamId);
	try { await workspaceActor(c, workspaceId).internalMap({ uid: c.key[0], teamId, mapped: false }); }
	catch { console.warn(`linear.mapping.unroute_failed uid=${c.key[0]} team=${teamId}`); }
}

export async function listLinearTeams(c: LinearCtx): Promise<LinearTeamList> {
	return (await linearTeams(c)).list;
}

export async function saveLinearMapping(c: LinearCtx, input: { teamId: string; repositoryId: GithubId }): Promise<LinearTeamList> {
	requireLinear();
	const teamId = typeof input?.teamId === "string" ? lower(input.teamId) : "";
	if (!isLinearId(teamId) || !isGithubId(input?.repositoryId)) throw new UserError("Choose one of the listed teams and one of the listed repositories.", { code: "bad_input" });
	const connection = c.vars.github;
	if (!await readConnection(c.db)) throw notConnected();
	if (!connection) throw new UserError("GitHub is not connected. Connect GitHub first.", { code: "github_not_connected" });
	const app = githubApp();
	if (!app) throw new UserError("This deployment has no GitHub App, so GitHub cannot be connected here.", { code: "github_off" });
	// Linear is asked now: a team that is not in the connected workspace cannot be mapped, whatever a client says.
	const { list, stored } = await linearTeams(c, true);
	if (!list.teams.some(team => team.id === teamId)) throw new UserError("That team is not in the connected Linear workspace.", { code: "linear_team" });
	let repository;
	try {
		// The owner must be able to push to it now; filing asks again.
		repository = (await resolveRepository(app, connection, input.repositoryId, "write")).described;
	} catch (error) {
		if (error instanceof GithubProblem) throw new UserError(error.message, { code: error.code === "github_gone" || error.code === "github_denied" ? "bad_input" : error.code });
		throw clientError(c.log, error, "The repository could not be checked at GitHub. Try again.");
	}
	const savedAt = Date.now();
	// Routed first, then recorded: a route without a mapping files nothing, a mapping without a route only waits.
	try { await workspaceActor(c, stored.workspace.id).internalMap({ uid: c.key[0], teamId, mapped: true }); }
	catch (error) { throw clientError(c.log, error, "The mapping could not be saved. Try again."); }
	await c.db.execute("INSERT INTO linear_mapping (team_id, repository_id, owner, name, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (team_id) DO UPDATE SET repository_id = excluded.repository_id, owner = excluded.owner, name = excluded.name, saved_at = excluded.saved_at",
		teamId, String(repository.id), repository.owner, repository.name, savedAt);
	console.log(`[wlp] linear.mapping.saved uid=${c.key[0]} team=${teamId} repository=${repository.id}`);
	return teamList(list.teams.map(({ id, key, name }) => ({ id, key, name })), await readMappings(c.db));
}

export async function removeLinearMapping(c: LinearCtx, teamId: string): Promise<LinearTeamList> {
	requireLinear();
	const stored = await readConnection(c.db);
	if (!stored) throw notConnected();
	const id = typeof teamId === "string" ? lower(teamId) : "";
	if (!isLinearId(id)) throw new UserError("Choose one of the listed teams.", { code: "bad_input" });
	await unmap(c, stored.workspace.id, id);
	console.log(`[wlp] linear.mapping.removed uid=${c.key[0]} team=${id}`);
	return teamList(stored.teams, await readMappings(c.db));
}

// ---------------------------------------------------------------------------------------------
// One verified delivery
// ---------------------------------------------------------------------------------------------

const TRIGGER_LABELS = new Set(["windlass", "windlass:quick"]);

/** The issue was reserved a key and not filed yet (an interrupted filing): it is finished whatever the issue says by now. */
function interrupted(c: LinearCtx, issueId: string): boolean {
	const prefix = intakeScope(`linear:${issueId}:`);
	for (const [key, entry] of c.vars.items.created) if (key.startsWith(prefix) && !c.vars.items.items.has(entry.id)) return true;
	return false;
}

/** A link to the issue: Linear's own when it is https, otherwise the one Linear's addresses have. */
function issueUrl(reported: string, urlKey: string, identifier: string): string {
	if (/^https:\/\/[^\s/]+\/\S*$/.test(reported) && reported.length <= 500) return reported;
	return `https://linear.app/${encodeURIComponent(urlKey || "issue")}/issue/${identifier}`;
}

export type LinearDeliveryResult = LinearFiled | { kind: "ignored"; why: string };

/**
 * What one verified delivery comes to for the owner. The delivery says only which issue and why; the issue itself is read from
 * Linear with the connection's token, and the mapping is read from here. It is filed only while the workspace is still this
 * connection's, the team still mapped, and the reason it qualified still holds (a label removed since is not filed), apart from
 * an interrupted filing, which is finished. Throws when it must be tried again: Linear unreachable, the filing interrupted.
 *
 * Filing is idempotent: the key of an issue's active item is the issue's, so a redelivery or a second event files nothing.
 */
export async function fileLinearDelivery(c: LinearCtx, delivery: LinearDelivery, file: (filing: LinearFiling) => Promise<LinearFiled>): Promise<LinearDeliveryResult> {
	const app = linearApp();
	if (!app) return { kind: "ignored", why: "Linear is off on this deployment." };
	const stored = await readConnection(c.db);
	if (!stored || stored.workspace.id !== lower(delivery.workspaceId)) return { kind: "ignored", why: "The workspace is not this owner's connection." };
	const teamId = lower(delivery.teamId);
	const [mapping] = await c.db.execute<{ repository_id: string }>("SELECT repository_id FROM linear_mapping WHERE team_id = ?", teamId);
	const repositoryId = mapping && githubId(mapping.repository_id);
	if (!repositoryId) return { kind: "ignored", why: "The team is not mapped." };

	let issue;
	try {
		const { token } = await accessToken(c, app);
		issue = await app.issue(token, delivery.issueId);
	} catch (error) {
		if (error instanceof LinearError && error.unauthorized) return { kind: "refused", reason: "Linear no longer accepts the connection; the owner has to connect it again." };
		throw error;
	}
	if (!issue || lower(issue.id) !== lower(delivery.issueId)) return { kind: "ignored", why: "Linear has no such issue." };
	if (lower(issue.teamId) !== teamId) return { kind: "ignored", why: "The issue is not in the mapped team." };

	const labels = issue.labels.map(label => label.name.trim().toLowerCase());
	const holds = {
		label: labels.some(label => TRIGGER_LABELS.has(label)),
		assignment: issue.assigneeId !== null && lower(issue.assigneeId) === stored.appUser.id,
	};
	const via = delivery.reasons.find(reason => holds[reason]);
	if (!via && !interrupted(c, issue.id)) return { kind: "ignored", why: "The issue no longer has what qualified it." };

	const actor = delivery.actor.id ?? NOBODY;
	const filing: LinearFiling = {
		issue: {
			id: lower(issue.id),
			identifier: issue.identifier,
			url: issueUrl(issue.url, stored.workspace.urlKey, issue.identifier),
			title: issue.title,
			description: issue.description,
			labels: issue.labels.map(label => label.name),
			creator: issue.creator && { id: lower(issue.creator.id), name: issue.creator.name },
			closed: issue.archived || issue.stateType === "completed" || issue.stateType === "canceled",
		},
		team: { id: teamId, workspaceId: stored.workspace.id },
		repository: { id: repositoryId },
		owner: { linearUserId: NOBODY },
		trigger: { via: via ?? delivery.reasons[0] ?? "label", at: delivery.sentAt, sender: { id: linearId(actor) ? actor : NOBODY, name: "a Linear user" } },
	};
	// A GitHub that cannot answer now is no refusal: the delivery is tried again. Whether the owner may write there is `file`'s to decide.
	const github = githubApp();
	if (github && c.vars.github) {
		try { await resolveRepository(github, c.vars.github, repositoryId, "write"); }
		catch (error) { if (error instanceof GithubProblem && (error.code === "github_unreachable" || error.code === "github_failed")) throw error; }
	}
	return file(filing);
}

// ---------------------------------------------------------------------------------------------
// The callback route's store
// ---------------------------------------------------------------------------------------------

interface UserLinearActions {
	internalLinearClaim(nonce: string): Promise<{ ok: boolean; verifier: string | null; origin: string | null }>;
	internalLinearComplete(blob: string): Promise<void>;
}

let client: { user: { get(key: string[], options: { params: unknown }): unknown } } | null = null;

function userActor(uid: string): UserLinearActions {
	client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as NonNullable<typeof client>;
	return client.user.get([uid], { params: serviceParams() }) as UserLinearActions;
}

/**
 * What `GET /linear/callback` needs of the actors. The state is checked here (its signature, its time, the number in the named
 * user's actor, which is there once), so a state that was forged, expired or replayed never reaches the code exchange.
 */
export const actorLinearConnectStore: LinearConnectStore = {
	async claim(state: string): Promise<LinearClaim> {
		const payload = readState(state);
		if (!payload) return { ok: false, reason: "state", origin: null };
		if (payload.exp <= Date.now()) return { ok: false, reason: "state", origin: config.origins.includes(payload.origin) ? payload.origin : null };
		let claimed;
		try {
			claimed = await userActor(payload.uid).internalLinearClaim(payload.nonce);
		} catch (error) {
			// A user whose actor is gone started nothing.
			if (isActorGone(error)) return { ok: false, reason: "state", origin: null };
			throw error;
		}
		// The origin is the one the owner's actor kept for this number, and must be the one signed into the state.
		if (!claimed.ok || claimed.origin !== payload.origin || claimed.verifier === null) return { ok: false, reason: "used", origin: config.origins.includes(payload.origin) ? payload.origin : null };
		return { ok: true, uid: payload.uid, origin: claimed.origin, verifier: claimed.verifier };
	},
	async complete(uid, connection) {
		await userActor(uid).internalLinearComplete(sealConnection(uid, connection));
	},
};
