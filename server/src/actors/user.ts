/**
 * `user`, key [uid]: a user's profile, the index of their sessions, and their ChatGPT sign-in.
 *
 * Stored in SQLite: the profile last seen on a valid token, one row per session holding its summary,
 * and the sign-in. The summaries are also held in memory so that counting the running sessions and
 * marking one as running happen in one synchronous step. A session that was created with the key of
 * its submission (submissions.ts; README, "A message sent twice") has that key in its row, and in
 * memory with the summaries: `createSession` with the same key answers with that session and makes none.
 *
 * The sign-in is what Windlass saves of it (`auth.json`, `host-id`), in one row, sealed with a key that
 * is derived from the server's secret and is never in this storage (signin/seal.ts): whoever holds the
 * storage and not the secret reads that the row exists, how long it is and when it last changed. This
 * actor is also the one place that asks for the user's access token (signin/holder.ts): it runs in one
 * place at a time, so one request to Windlass runs per user whichever servers ask, and a refreshed
 * sign-in is saved here before its token leaves. What leaves is sealed for the server that asked
 * (`internalAccessToken`): the engine that carries the answer does not see the token either.
 *
 * The user's GitHub connection is here too (README, "GitHub"): the GitHub user who connected and the
 * installations of the deployment's GitHub App that user could reach then, as GitHub confirmed them to
 * the server's callback route (github/connect.ts). It is one row of plain JSON: names and ids, and no
 * credential, because there is none to keep. What the platform does at GitHub it does with a token of
 * the installation, which any server asks for when it needs one and then drops. Beside it, the numbers
 * of connections that were begun and not yet finished, each good once.
 *
 * And the user's approvals of MCP servers that projects name (server-approvals.ts), one row each: the
 * project, the server's name, Windlass's fingerprint of its definition, when the user approved and
 * until when that holds. The user's sessions are actors of their own, on whichever servers, and each
 * asks here before it puts the question; no session and no server keeps a copy. The rows are plain:
 * they name repositories and servers, and hold no credential.
 *
 * And the setup commands the user saved for repositories of their GitHub connection (setup-command.ts),
 * one row per repository: the command a session runs once in each new sandbox, after the clone. A
 * session reads it here when its sandbox is new, so what is saved holds for every session of the user
 * on whichever server; nothing but the user's own calls writes a row.
 *
 * And the checks the user saved for those repositories (repository-checks.ts), one row per repository
 * with the whole list: the commands Windlass runs before it calls a turn done. A session is handed
 * them with its repository's secrets when a turn starts, and no file of a repository is read for them.
 *
 * And the secrets the user saved for those repositories (repo-secrets.ts), one row per repository and
 * name: the name, the scope, when it was last changed, and the value, sealed like the sign-in with a
 * key of its own purpose and bound to this user, that repository and that name. A value comes in
 * from the user's browser once and is never sent back to one: the listing reads no value at all.
 * The one caller that is handed the sealed values is a session of this user, for the repository
 * this actor's own index says that session is on (`internalSessionSecrets`); it opens them on the
 * server that runs its turn. Whoever holds this storage and not the servers' secret reads which
 * repositories have secrets, their names, scopes and times, and how long each value is.
 *
 * And what new sessions on those repositories start with, where the user said so
 * (repository-defaults.ts), one row per repository: a sandbox profile and a model. A repository is not
 * an object here: it is the key those five tables share, GitHub's id for it, and its page
 * (`repository`) is what they hold under that key, beside the user's sessions on it.
 *
 * And what the user keeps for their account, whatever the repository (README, "Account settings"):
 * the defaults a new session starts with where neither the form nor its repository says
 * (account-defaults.ts), the user's own MCP servers (personal-servers.ts), one row each, and the
 * secrets those servers read (account-secrets.ts), one row per name, the value sealed as a
 * repository's secret is. A session is handed the servers and the sealed values with its
 * repository's secrets, in the one answer (`internalSessionSecrets`). Each save is one statement
 * that reads nothing first, so saves that run together all stay and a limit holds between them.
 *
 * And the models the user may choose (account-models.ts): what their ChatGPT plan offers, as Windlass
 * listed it with an access token of the sign-in above, in one row with the generation of that sign-in.
 * It is listed again when somebody asks and the row is older than an hour, by one request to Windlass
 * however many ask, and a row of an earlier sign-in is nobody's list.
 *
 * And the deleted sessions whose copy of Windlass's data the bucket still holds (`backup_removal`),
 * one row each: a session that could not remove its copy as it was deleted hands it here, and this
 * actor, which outlives its sessions, tries again on its durable schedule, further apart each time.
 *
 * And the user's sandbox time and the sandboxes they keep (usage.ts): a ledger of the seconds their
 * sessions' sandboxes ran, one entry per hold that was closed; the holds of sandboxes that run now;
 * and one row per session that has a place among the kept sandboxes. A `UsageBook` holds the same in
 * memory, and every decision about a limit is one synchronous step on it: the user's sessions are on
 * whichever servers, and each takes its hold and its place here, so no server counts for itself.
 */

import { randomBytes } from "node:crypto";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, maySubscribe, requireService, requireServiceFor, requireUser } from "../auth.js";
import { config } from "../config.js";
import {
	type AccountDefaults,
	type AccountSecrets,
	type AccountSettings,
	type ChatgptStatus,
	type CreateSessionInput,
	type GithubBranchList,
	type GithubRepository,
	type GithubRepositoryList,
	type GithubStatus,
	type KeptSandbox,
	MAX_ACCOUNT_SECRETS,
	MAX_PERSONAL_SERVERS,
	MAX_RUNNING_SESSIONS,
	MAX_SERVER_DEFINITION_BYTES,
	MAX_TITLE_CHARS,
	type ModelList,
	MAX_SECRETS_PER_REPOSITORY,
	type RepositoryApproval,
	type RepositoryCheck,
	type RepositoryChecks,
	type RepositoryDefaults,
	type RepositorySecrets,
	type RepositorySetup,
	type RepositoryView,
	type SandboxPlace,
	type SandboxProfile,
	type SavedRepository,
	type SecretScope,
	type SessionSummary,
	USAGE_HISTORY_DAYS,
	type UsageNumbers,
	type UsageView,
	type UserProfile,
} from "../contract.js";
import { githubApp, type GithubApp } from "../github/app.js";
import { isBranchName } from "../github/git.js";
import type { StoredRepository } from "../github/publish.js";
import { GithubProblem, type StoredConnection, forgetGithubCaches, listBranches, listRepositories, resolveRepository } from "../github/repos.js";
import { STATE_TTL_MS, TICKET_TTL_MS, issueState, newCodeVerifier, newNonce, verifyTicket } from "../github/state.js";
import { getLayer, layerFor } from "../layer.js";
import { ACCOUNT_DEFAULTS_TABLE, readAccountDefaults, saveAccountDefaults } from "../account-defaults.js";
import { AccountModels, MODELS_TABLE, ModelProblem, chosenModel, standInModels } from "../account-models.js";
import { ACCOUNT_SECRETS_TABLE, ACCOUNT_SECRET_PROJECT, SecretNotFound, TooManySecrets, accountSecretNames, deleteAccountSecret, listedAccountSecrets, saveAccountSecret } from "../account-secrets.js";
import { publishUnaskedProblem } from "../agent-publish.js";
import { PERSONAL_SERVERS_TABLE, ServerProblem, addServer, changeServer, cleanServerDefinition, cleanServerName, cleanUnasked, deleteServer, listedServer, readServers } from "../personal-servers.js";
import { MAX_SECRETS_PER_USER, SecretProblem, cleanSecretName, cleanSecretScope, cleanSecretValue, commandSandbox, listedSecrets, sealSecret } from "../repo-secrets.js";
import { DEFAULTS_TABLE, type DefaultsChange, DefaultsProblem, cleanDefaults, readDefaults, saveDefaults } from "../repository-defaults.js";
import type { ChatgptAccount, ListedSandbox } from "../sandbox/api.js";
import { ApprovalBook, type BookChange, type ServerApproval, sessionProjectKey } from "../server-approvals.js";
import { forgettingWords, personalServerReach } from "../server-question.js";
import { CHECKS_TABLE, ChecksProblem, cleanChecks, readChecks, saveChecks } from "../repository-checks.js";
import { MAX_SETUP_COMMANDS, SetupCommandProblem, cleanSetupCommand, setupProjectKey } from "../setup-command.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { type SealedTokenAnswer, type SignInAnswer, problemOf, tokenSubject } from "../signin/directory.js";
import { SignInHolder, type StoredSignIn } from "../signin/holder.js";
import { getSignIns } from "../signin/index.js";
import { serverSealer } from "../signin/seal.js";
import { uidOfAccount } from "../signin/material.js";
import { USAGE_KEPT_DAYS, UsageBook, type UsageChange, dayOf, isEmptyChange } from "../usage.js";
import { type ReserveAnswer, type ReserveRequest, type SealedSecrets, createSessionActor, isActorGone, secretsCaller, sessionActor } from "./internal.js";

export const DEFAULT_TITLE = "New agent";
const MAX_REPO_URL_CHARS = 300;
/**
 * How often a deleted session's copy is tried again, and how long before the first try: each wait is
 * twice the one before, so the tries come 1, 2, 4, ... 128 minutes apart, the last about four hours
 * and a quarter after the session was deleted.
 */
const BACKUP_REMOVE_TRIES = 8;
const BACKUP_REMOVE_FIRST_MS = 60_000;
/** A try this far past its time when the actor wakes lost its schedule, and is set again. */
const BACKUP_REMOVE_LATE_MS = 10 * 60_000;

interface ConnParams {
	token?: string;
}

interface UserVars {
	profile: UserProfile | null;
	/** False until a valid token of this user has been seen: until then the actor may be a stranger's doing. */
	reached: boolean;
	sessions: Map<string, SessionSummary>;
	/**
	 * The sessions that were created with a key (submissions.ts), by that key: the digest of what was
	 * asked for, and the session it made. As the `sessions` table has them, one for each such session
	 * and for as long as that session exists: a `createSession` with one of these keys answers with
	 * its session and makes none.
	 */
	created: Map<string, Submission & { id: string }>;
	/** The `createSession` calls with a key that are being decided: another attempt of one of them ends as it does. */
	creating: Attempts<SessionSummary>;
	/** The user's sign-in and token source, made when first needed: a demo user never has one. */
	signIn: Promise<SignInHolder> | null;
	/** The database as the action that is running now has it: what the holder's store reads and writes. */
	signInDb: RawAccess | null;
	/** The user's remembered approvals of projects' MCP servers, as the table has them. */
	approvals: ApprovalBook;
	/** The user's GitHub connection; null when there is none. */
	github: StoredConnection | null;
	/** The models of the user's ChatGPT plan, as the table has them, and the listing that runs now. */
	models: AccountModels;
	/** The user's sandbox time and kept sandboxes, as the tables have them. */
	usage: UsageBook;
	/** The user's sandboxes as the provider last listed them, and when; null until it was asked. */
	listed: { at: number; sandboxes: ListedSandbox[] } | null;
}

interface SignInCtx {
	vars: UserVars;
	db: RawAccess;
	key: string[];
}

type SignInRow = { sealed: string | null; generation: number; short_noted: number };

/**
 * The holder of this user's sign-in, over this actor's storage. The store's `save` resolves when the
 * database has taken the row, which is what "saved before the token is handed out" rests on.
 */
function signIn(c: SignInCtx): Promise<SignInHolder> {
	c.vars.signInDb = c.db;
	const vars = c.vars;
	const uid = c.key[0]!;
	const db = () => vars.signInDb as RawAccess;
	vars.signIn ??= getSignIns()
		.then(
			({ commands, sealer, hooks }) =>
				new SignInHolder({
					uid,
					commands,
					sealer,
					legacy: hooks.legacy,
					revoke: hooks.revoke,
					// The sign-in of one OpenAI account is one user's: no other user's actor takes it.
					ownerOf: (account) => uidOfAccount(account.sub),
					store: {
						load: async (): Promise<StoredSignIn | null> => {
							const [row] = await db().execute<SignInRow>("SELECT sealed, generation, short_noted FROM signin WHERE id = 1");
							return row ? { sealed: row.sealed, generation: row.generation, shortNoted: row.short_noted === 1 } : null;
						},
						save: async (row) => {
							await db().execute(
								"INSERT INTO signin (id, sealed, generation, short_noted, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, generation = excluded.generation, short_noted = excluded.short_noted, updated_at = excluded.updated_at",
								row.sealed,
								row.generation,
								row.shortNoted ? 1 : 0,
								Date.now(),
							);
						},
					},
				}),
		)
		.catch((error: unknown) => {
			vars.signIn = null;
			throw error;
		});
	return vars.signIn;
}

/** A step on the sign-in for another server: its failure goes back as data, with its kind (signin/directory.ts). */
async function answered<T>(c: { log: { error: (entry: unknown) => void } }, step: () => Promise<T>): Promise<SignInAnswer<T>> {
	try {
		return { ok: true, value: await step() };
	} catch (error) {
		const problem = problemOf(error);
		if (problem.kind === "other") c.log.error({ msg: "a step on the user's sign-in failed", error: problem.message });
		return { ok: false, problem };
	}
}

interface ModelsCtx extends SignInCtx {
	keepAwake<T>(promise: Promise<T>): Promise<T>;
}

/**
 * The models the user may choose (account-models.ts). The demo's scripted model answers under any
 * name, so a demo user is given the stand-in and Windlass is asked nothing. For anyone else the list
 * is their plan's: Windlass lists it with the user's access token when the one kept here is older
 * than an hour. The actor stays awake while it does, as for any request for the token: a sign-in
 * that had to be refreshed for it is saved before the actor may sleep or move.
 */
function modelsOf(c: ModelsCtx, demo: boolean): Promise<ModelList> {
	if (demo) return Promise.resolve(standInModels("demo"));
	return c.vars.models.current({
		db: c.db,
		generation: async () => {
			const [row] = await c.db.execute<{ generation: number }>("SELECT generation FROM signin WHERE id = 1 AND sealed IS NOT NULL");
			return row?.generation ?? null;
		},
		list: () => c.keepAwake((async () => (await getSignIns()).commands.models(await (await signIn(c)).accessToken()))()),
	});
}

/** A model a client named, held against the user's list, or the UserError that says what is wrong with it. */
function modelInput<T>(pick: () => T): T {
	try {
		return pick();
	} catch (error) {
		if (error instanceof ModelProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	}
}

interface UserCtx {
	key: string[];
	vars: UserVars;
	db: RawAccess;
	broadcast(name: string, ...args: unknown[]): void;
}

function sessionList(vars: UserVars): SessionSummary[] {
	return [...vars.sessions.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

function broadcastSessions(c: UserCtx): void {
	c.broadcast("sessions", sessionList(c.vars));
}

/** Writes a session's row: its summary, and for a new session the key it was created with, which stays with the row. */
async function storeSession(c: UserCtx, summary: SessionSummary, submission: Submission | null = null): Promise<void> {
	await c.db.execute(
		"INSERT INTO sessions (id, created_at, summary, key, sent) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary",
		summary.id,
		summary.createdAt,
		JSON.stringify(summary),
		submission?.key ?? null,
		submission?.sent ?? null,
	);
}

interface BackupRemovalCtx {
	db: RawAccess;
	schedule: { at(timestamp: number, action: string, ...args: unknown[]): Promise<string> };
}

/**
 * Sets the next try at removing a deleted session's copy, after `tries` of this actor's own. The
 * schedule is set before the row names it: a firing that the row does not name does nothing.
 */
async function armBackupRemoval(c: BackupRemovalCtx, session: string, tries: number): Promise<void> {
	const at = Date.now() + BACKUP_REMOVE_FIRST_MS * 2 ** tries;
	const id = await c.schedule.at(at, "internalRemoveBackup", session);
	await c.db.execute("INSERT OR REPLACE INTO backup_removal (session, tries, due_at, schedule_id) VALUES (?, ?, ?, ?)", session, tries, at, id);
}

/** Keeps the profile of the newest valid token: the email can change between sign-ins. */
async function rememberProfile(c: UserCtx, profile: UserProfile): Promise<void> {
	const known = c.vars.profile;
	c.vars.profile = profile;
	if (known && known.email === profile.email && known.demo === profile.demo) return;
	await c.db.execute(
		"INSERT INTO profile (id, uid, email, demo, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email, demo = excluded.demo, updated_at = excluded.updated_at",
		profile.uid,
		profile.email,
		profile.demo ? 1 : 0,
		Date.now(),
	);
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

/** How many accounts one connection keeps, and how many connections may be begun and left unfinished. */
const MAX_GITHUB_ACCOUNTS = 30;
const MAX_GITHUB_PENDING = 20;

/** The deployment's GitHub App, or a UserError: without one there is nothing to connect. */
function requireGithub(): GithubApp {
	const app = githubApp();
	if (!app) throw new UserError("This deployment has no GitHub App, so GitHub cannot be connected here.", { code: "github_off" });
	return app;
}

function requireConnection(c: { vars: UserVars }): StoredConnection {
	if (!c.vars.github) throw new UserError("GitHub is not connected. Connect GitHub first.", { code: "github_not_connected" });
	return c.vars.github;
}

function githubStatus(vars: UserVars): GithubStatus {
	const stored = vars.github;
	if (!stored) return { connection: null };
	return {
		connection: {
			login: stored.user.login,
			accounts: stored.installations.map((installation) => ({
				installationId: installation.id,
				login: installation.account.login,
				kind: installation.account.type === "Organization" ? "organization" : "user",
				manageUrl: installation.htmlUrl,
			})),
			connectedAt: stored.connectedAt,
		},
	};
}

/** A failure at GitHub as the client is told it: the sentence, under the problem's own code. */
function githubError(log: { error: (entry: unknown) => void }, error: unknown, fallback: string): UserError {
	if (error instanceof GithubProblem) return new UserError(error.message, { code: error.code });
	return clientError(log, error, fallback);
}

/** Keeps the number of a connection that was begun: a state's, with the PKCE verifier its code is exchanged with. */
async function rememberPending(c: UserCtx, nonce: string, verifier: string | null): Promise<void> {
	const now = Date.now();
	await c.db.execute("DELETE FROM github_nonce WHERE expires_at <= ?", now);
	// Somebody who begins again and again leaves no more than a few behind; the oldest go first.
	await c.db.execute("DELETE FROM github_nonce WHERE kind = 'state' AND nonce NOT IN (SELECT nonce FROM github_nonce WHERE kind = 'state' ORDER BY expires_at DESC LIMIT ?)", MAX_GITHUB_PENDING - 1);
	await c.db.execute("INSERT INTO github_nonce (nonce, kind, verifier, expires_at) VALUES (?, 'state', ?, ?)", nonce, verifier, now + STATE_TTL_MS);
}

// ---------------------------------------------------------------------------------------------
// Approvals of projects' MCP servers
// ---------------------------------------------------------------------------------------------

type ApprovalRow = { project: string; label: string; name: string; fingerprint: string; approved_at: number; expires_at: number };

async function readApprovals(db: RawAccess): Promise<ServerApproval[]> {
	const rows = await db.execute<ApprovalRow>("SELECT project, label, name, fingerprint, approved_at, expires_at FROM server_approval");
	return rows.map((row) => ({ project: row.project, label: row.label, name: row.name, fingerprint: row.fingerprint, approvedAt: row.approved_at, expiresAt: row.expires_at }));
}

/**
 * Makes a change to the book and to the table. The book changes first, in one step, so two calls
 * cannot both decide from the same rows; if the table cannot be written, the book is read from it
 * again and the call fails: what is remembered is what is stored.
 */
async function changeApprovals(c: UserCtx, change: (book: ApprovalBook) => BookChange): Promise<BookChange> {
	const done = change(c.vars.approvals);
	try {
		for (const row of done.removed) await c.db.execute("DELETE FROM server_approval WHERE project = ? AND name = ? AND fingerprint = ?", row.project, row.name, row.fingerprint);
		for (const row of done.added) {
			await c.db.execute(
				"INSERT OR REPLACE INTO server_approval (project, label, name, fingerprint, approved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
				row.project,
				row.label,
				row.name,
				row.fingerprint,
				row.approvedAt,
				row.expiresAt,
			);
		}
	} catch (error) {
		c.vars.approvals = new ApprovalBook(await readApprovals(c.db).catch(() => []), config.serverApprovalTtlMs);
		throw error;
	}
	return done;
}

/** A project's key and a server's name or fingerprint, as a session hands them over: text of a sane length, or nothing. */
function approvalText(value: unknown, max: number): string {
	return typeof value === "string" && value.length <= max ? value : "";
}

// ---------------------------------------------------------------------------------------------
// Setup commands of repositories
// ---------------------------------------------------------------------------------------------

/** The setup command saved for a project (setup-command.ts, `SetupProject.key`); none when there is no row. */
async function readSetup(db: RawAccess, project: string): Promise<RepositorySetup> {
	const [row] = await db.execute<{ command: string; updated_at: number }>("SELECT command, updated_at FROM setup_command WHERE project = ?", project);
	return { command: row?.command ?? "", updatedAt: row?.updated_at ?? null, timeoutMs: config.setupTimeoutMs };
}

/** Saves a command that was cleaned already, in place of the project's earlier one; "" removes the row. */
async function saveSetup(c: UserCtx, uid: string, project: string, label: string, command: string): Promise<RepositorySetup> {
	if (command === "") {
		await c.db.execute("DELETE FROM setup_command WHERE project = ?", project);
	} else {
		await c.db.execute(
			"INSERT INTO setup_command (project, label, command, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, command = excluded.command, updated_at = excluded.updated_at",
			project,
			label,
			command,
			Date.now(),
		);
		// Somebody who saves for one repository after another leaves no more than this many rows.
		await c.db.execute("DELETE FROM setup_command WHERE project NOT IN (SELECT project FROM setup_command ORDER BY updated_at DESC LIMIT ?)", MAX_SETUP_COMMANDS);
	}
	// The command is the user's text and may hold what they would not want in a log: only its length is said.
	console.log(`[wlp] setup.saved uid=${uid} project=${project} chars=${command.length}`);
	return readSetup(c.db, project);
}

/** A setup command as a client sent it, cleaned, or the UserError that says what is wrong with it. */
function setupCommandOf(raw: unknown): string {
	try {
		return cleanSetupCommand(raw);
	} catch (error) {
		if (error instanceof SetupCommandProblem) throw new UserError(error.message, { code: "bad_setup_command" });
		throw error;
	}
}

/** The key a repository's setup command is saved under, from GitHub's id as a client sent it. */
function setupKeyOf(repositoryId: unknown): string {
	const key = setupProjectKey(repositoryId);
	if (key === null) throw new UserError("Choose one of the listed repositories.", { code: "bad_input" });
	return key;
}

// ---------------------------------------------------------------------------------------------
// Secrets of repositories
// ---------------------------------------------------------------------------------------------

/** A session's list describes its own sandbox. The settings and launch form describe hosted profiles. */
async function secretProfile(c: UserCtx, id: unknown, repo?: { repositoryId: number; sessionId?: string }): Promise<SandboxProfile> {
	const session = repo?.sessionId ? c.vars.sessions.get(repo.sessionId) : undefined;
	const place: SandboxPlace = session && session.repository?.id === repo?.repositoryId ? session.place : { kind: "hosted" };
	const { sandboxes } = await layerFor(place, c.key[0]!);
	const profile = sandboxes.profiles().find((item) => item.id === id);
	if (!profile) throw new UserError("Choose one of the listed sandboxes.", { code: "bad_input" });
	return profile;
}

/**
 * A repository's secrets as a client may see them: name, scope, when each was last changed, and what
 * it reaches in a sandbox of `profile`. The value's column is not read, so no value can be in the answer.
 */
async function listSecrets(db: RawAccess, project: string, profile: SandboxProfile, lists: boolean): Promise<RepositorySecrets> {
	const rows = await db.execute<{ name: string; scope: string; updated_at: number }>("SELECT name, scope, updated_at FROM repo_secret WHERE project = ? ORDER BY name", project);
	const listed = listedSecrets(rows, profile, lists);
	// A secret of the account under the same name is not used in this repository's sessions: the list says where that is so.
	const account = rows.length === 0 ? new Set<string>() : await accountSecretNames(db);
	return account.size === 0 ? listed : { ...listed, secrets: listed.secrets.map((secret) => (account.has(secret.name) ? { ...secret, account: true } : secret)) };
}

/**
 * Whether the list is said for a Windlass that can be told by name which variables its commands get
 * (repo-secrets.ts). For a session of the user's on that repository it is what the session's sandbox
 * said when a turn last asked (`SessionSummary.envLists`). A sandbox nobody has asked was made before
 * the platform asked, so it is taken to have the older Windlass until its next turn asks. Without a
 * session, and for one that has no sandbox yet, it is said for a sandbox made now, from an image
 * with the Windlass this platform is built for (README, "Run it").
 */
function secretLists(vars: UserVars, repositoryId: number, sessionId: unknown): boolean {
	const session = typeof sessionId === "string" ? vars.sessions.get(sessionId) : undefined;
	if (session === undefined || session.repository?.id !== repositoryId || session.sandbox === "none") return true;
	return session.envLists === true;
}

/**
 * Saves a secret whose name, value and scope were cleaned already. With a value: a new secret, or a
 * new value for the one of that name, sealed for this user, repository and name before it is stored.
 * Without: the scope of the one of that name.
 */
async function saveSecret(c: UserCtx, uid: string, project: string, label: string, name: string, value: string | undefined, scope: SecretScope): Promise<void> {
	const [found] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM repo_secret WHERE project = ? AND name = ?", project, name);
	const exists = (found?.n ?? 0) > 0;
	if (value === undefined) {
		if (!exists) throw new UserError(`No secret named ${name} is saved for this repository.`, { code: "secret_not_found" });
		await c.db.execute("UPDATE repo_secret SET scope = ?, updated_at = ? WHERE project = ? AND name = ?", scope, Date.now(), project, name);
	} else {
		if (!exists) {
			const [here] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM repo_secret WHERE project = ?", project);
			if ((here?.n ?? 0) >= MAX_SECRETS_PER_REPOSITORY) throw new UserError(`A repository can have at most ${MAX_SECRETS_PER_REPOSITORY} secrets. Delete one first.`, { code: "too_many_secrets" });
			const [all] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM repo_secret");
			if ((all?.n ?? 0) >= MAX_SECRETS_PER_USER) throw new UserError(`You have ${MAX_SECRETS_PER_USER.toLocaleString("en-US")} secrets saved over all your repositories, which is the limit. Delete one first.`, { code: "too_many_secrets" });
		}
		await c.db.execute(
			"INSERT INTO repo_secret (project, name, label, scope, sealed, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project, name) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, scope = excluded.scope, sealed = excluded.sealed, updated_at = excluded.updated_at",
			project,
			name,
			label,
			scope,
			sealSecret(serverSealer(), uid, project, name, value),
			Date.now(),
		);
	}
	// The name, never anything of the value: not its length either.
	console.log(`[wlp] secret.saved uid=${uid} project=${project} name=${name} scope=${scope} value=${value === undefined ? "kept" : exists ? "replaced" : "new"}`);
}

/** What a client sent about a secret, cleaned, or the UserError that says what is wrong with it. */
function secretInput<T>(clean: () => T): T {
	try {
		return clean();
	} catch (error) {
		if (error instanceof SecretProblem) throw new UserError(error.message, { code: "bad_secret" });
		throw error;
	}
}

/** The repository in words, for a reader of the table: as the newest of the user's sessions on it has it. */
function repositoryLabel(vars: UserVars, repositoryId: unknown): string {
	let newest: SessionSummary | null = null;
	for (const session of vars.sessions.values()) if (session.repository?.id === repositoryId && (newest === null || session.createdAt > newest.createdAt)) newest = session;
	const known = newest?.repository;
	return known ? `${known.owner}/${known.name}` : "";
}

// ---------------------------------------------------------------------------------------------
// A repository's page: what the tables above hold under one repository's key
// ---------------------------------------------------------------------------------------------

/** How many repositories `savedRepositories` names. */
const MAX_SAVED_REPOSITORIES = 500;

/** GitHub's id for the repository a key names; null for the key of a pasted address or of a session. */
function repositoryIdOf(project: string): number | null {
	const id = /^github:([1-9][0-9]{0,15})$/.exec(project)?.[1];
	return id === undefined ? null : Number(id);
}

/**
 * "owner/name" of a repository without asking GitHub: as the newest session on it has it, and with no
 * session, as it was called when something was last saved for it. "" when nothing names it.
 */
async function repositoryName(c: UserCtx, repositoryId: number, project: string): Promise<string> {
	const known = repositoryLabel(c.vars, repositoryId);
	if (known !== "") return known;
	const [row] = await c.db.execute<{ label: string }>(
		"SELECT label FROM (SELECT label, updated_at FROM repository_defaults WHERE project = ? UNION ALL SELECT label, updated_at FROM setup_command WHERE project = ? UNION ALL SELECT label, updated_at FROM repository_checks WHERE project = ? UNION ALL SELECT label, updated_at FROM repo_secret WHERE project = ?) WHERE label != '' ORDER BY updated_at DESC LIMIT 1",
		project,
		project,
		project,
		project,
	);
	return row?.label ?? c.vars.approvals.of(project, Date.now()).find((approval) => approval.label !== "")?.label ?? "";
}

/** How long a save waits for GitHub to say what a repository is called, when nothing here does. */
const NAMING_MS = 4_000;

/**
 * The repository in words, for a row that is about to be saved. Where neither a session nor an earlier
 * row names it, GitHub is asked once, for a few seconds at most: somebody who saves a secret in the
 * launch form and never launches would otherwise leave a row no page could name. Never throws: a
 * repository GitHub does not name now is saved for all the same, without a name.
 */
async function labelFor(c: UserCtx, repositoryId: number, project: string): Promise<string> {
	const known = await repositoryName(c, repositoryId, project);
	const app = githubApp();
	const connection = c.vars.github;
	if (known !== "" || !app || !connection) return known;
	try {
		const { described } = await resolveRepository(app, connection, repositoryId, "read", Date.now() + NAMING_MS);
		return `${described.owner}/${described.name}`;
	} catch {
		return "";
	}
}

/** What is kept for a repository beside its setup command and its secrets, which have their own actions. No value of a secret is read. */
async function repositoryView(c: UserCtx, repositoryId: number, project: string): Promise<RepositoryView> {
	const defaults = await readDefaults(c.db, project);
	const [setup] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM setup_command WHERE project = ?", project);
	const [secrets] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM repo_secret WHERE project = ?", project);
	const { checks } = await readChecks(c.db, project);
	const name = await repositoryName(c, repositoryId, project);
	const { sandboxes } = await getLayer();
	// The book is read last and in one step: what is listed is what is remembered when the answer is made.
	const approvals = new Map<string, RepositoryApproval>();
	for (const approval of c.vars.approvals.of(project, Date.now())) {
		const listed = approvals.get(approval.name);
		// The newest comes first: its times are the ones shown, and an older definition is counted.
		if (listed) listed.definitions += 1;
		else approvals.set(approval.name, { name: approval.name, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt, definitions: 1 });
	}
	return {
		id: repositoryId,
		name: name === "" ? null : name,
		defaults,
		approvals: [...approvals.values()],
		forgetting: forgettingWords({ dataInSandbox: sandboxes.sessionsLiveInSandbox }),
		saved: { setup: (setup?.n ?? 0) > 0, secrets: secrets?.n ?? 0, checks: checks.length },
	};
}

/** A name a client sent, for a log line: what is printable of it. */
const logged = (text: string) => text.replace(/[^\x21-\x7e]/g, "?");

// ---------------------------------------------------------------------------------------------
// The account's settings: defaults, the user's own MCP servers, and their secrets
// ---------------------------------------------------------------------------------------------

/** The account's settings as their page shows them. No value of a secret is read. */
async function accountView(db: RawAccess): Promise<AccountSettings> {
	const defaults = await readAccountDefaults(db);
	const servers = await readServers(db);
	const secrets = await accountSecretNames(db);
	const { sandboxes } = await getLayer();
	return {
		defaults,
		servers: servers.map((server) => listedServer(server, secrets)),
		serverReach: personalServerReach(sandboxes.profiles()),
		limits: { servers: MAX_PERSONAL_SERVERS, definitionBytes: MAX_SERVER_DEFINITION_BYTES, secrets: MAX_ACCOUNT_SECRETS },
	};
}

/**
 * The account's secrets as a client may see them: name, when each last changed, what it reaches in a
 * sandbox of `profile`, and which repositories have a secret of their own under its name. The value's
 * column is not read, of either table, so no value can be in the answer.
 */
async function listAccountSecrets(db: RawAccess, profile: SandboxProfile): Promise<AccountSecrets> {
	const rows = await db.execute<{ name: string; scope: string; updated_at: number }>("SELECT name, scope, updated_at FROM account_secret ORDER BY name");
	const shared = rows.length === 0 ? [] : await db.execute<{ name: string; project: string; label: string }>("SELECT name, project, label FROM repo_secret WHERE name IN (SELECT name FROM account_secret)");
	return listedAccountSecrets(rows, shared, profile);
}

/** What a client sent about a server of the user's own, cleaned, or the UserError that says what is wrong with it. */
function serverInput<T>(clean: () => T): T {
	try {
		return clean();
	} catch (error) {
		if (error instanceof ServerProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------
// Sandbox time and kept sandboxes (usage.ts)
// ---------------------------------------------------------------------------------------------

/** How long the provider's list of the user's sandboxes is taken as it was read before it is asked for again. */
const KEPT_FRESH_MS = 30_000;

interface UsageCtx extends UserCtx {
	log: { warn(entry: unknown): void };
}

type UsageEntryRow = { day: number; session: string; hold: string; kind: string; seconds: number; at: number; note: string | null };
type UsageHoldRow = { id: string; session: string; day: number; seconds: number; started_at: number; expires_at: number };

/** The book as the tables have it: the open holds, the places, and the entries of the days the usage page shows. */
async function readUsage(db: RawAccess): Promise<UsageBook> {
	const today = dayOf(Date.now());
	// A hold whose entry was written and whose own row was then not removed, because the server stopped in between, is closed.
	await db.execute("DELETE FROM usage_hold WHERE id IN (SELECT hold FROM usage_entry)");
	await db.execute("DELETE FROM usage_entry WHERE day < ?", today - USAGE_KEPT_DAYS);
	const entries = await db.execute<UsageEntryRow>("SELECT day, session, hold, kind, seconds, at, note FROM usage_entry WHERE day > ? ORDER BY id", today - USAGE_HISTORY_DAYS);
	const holds = await db.execute<UsageHoldRow>("SELECT id, session, day, seconds, started_at, expires_at FROM usage_hold");
	const kept = await db.execute<{ session: string; since: number }>("SELECT session, since FROM kept_sandbox");
	return new UsageBook(config.usage, {
		entries: entries.map((row) => ({ day: row.day, session: row.session, hold: row.hold, kind: row.kind === "unreported" || row.kind === "corrected" ? row.kind : "used", seconds: row.seconds, at: row.at, note: row.note })),
		holds: holds.map((row) => ({ id: row.id, session: row.session, day: row.day, seconds: row.seconds, startedAt: row.started_at, expiresAt: row.expires_at })),
		kept,
	});
}

/**
 * Makes a step in the book and writes what it did to the tables before the caller answers. The book
 * changes first, in one synchronous step, so two calls cannot both decide from the same numbers; if
 * the tables cannot be written, the book is read from them again and the call fails: what is counted
 * is what is stored. An entry is written before its hold's row is removed, and a hold is closed once
 * (an entry's `hold` is unique), so a server that stops in between counts nothing twice.
 */
async function changeUsage<T extends { change: UsageChange }>(c: UsageCtx, step: (book: UsageBook) => T): Promise<T> {
	const done = step(c.vars.usage);
	const { change } = done;
	if (isEmptyChange(change)) return done;
	try {
		for (const entry of change.entries) {
			await c.db.execute("INSERT OR IGNORE INTO usage_entry (day, session, hold, kind, seconds, at, note) VALUES (?, ?, ?, ?, ?, ?, ?)", entry.day, entry.session, entry.hold, entry.kind, entry.seconds, entry.at, entry.note);
		}
		for (const id of change.closed) await c.db.execute("DELETE FROM usage_hold WHERE id = ?", id);
		for (const hold of change.opened) {
			await c.db.execute("INSERT OR REPLACE INTO usage_hold (session, id, day, seconds, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", hold.session, hold.id, hold.day, hold.seconds, hold.startedAt, hold.expiresAt);
		}
		for (const session of change.released) await c.db.execute("DELETE FROM kept_sandbox WHERE session = ?", session);
		for (const claim of change.kept) await c.db.execute("INSERT OR REPLACE INTO kept_sandbox (session, since) VALUES (?, ?)", claim.session, claim.since);
	} catch (error) {
		c.vars.usage = await readUsage(c.db).catch(() => c.vars.usage);
		throw error;
	}
	// One line per entry: what was counted, for whoever reads the log beside the provider's bill.
	for (const entry of change.entries) {
		console.log(`[wlp] usage.counted uid=${c.key[0]} session=${entry.session} hold=${entry.hold} kind=${entry.kind} seconds=${entry.seconds}${entry.note === null ? "" : `: ${entry.note}`}`);
	}
	c.broadcast("usage", c.vars.usage.numbers(Date.now()));
	return done;
}

/** Counts the holds that ran out, so that what is read next has them as entries. */
function sweepUsage(c: UsageCtx, now: number): Promise<{ change: UsageChange }> {
	return changeUsage(c, (book) => ({ change: book.sweep(now) }));
}

/**
 * Holds the count of kept sandboxes against the provider's own list of the user's sandboxes (usage.ts,
 * `reconcile`): at most once in KEPT_FRESH_MS, unless `force`. Never throws: when the provider cannot
 * be asked, the count stays as it is.
 */
async function reconcileKept(c: UsageCtx, force = false): Promise<void> {
	if (!force && c.vars.listed !== null && Date.now() - c.vars.listed.at < KEPT_FRESH_MS) return;
	try {
		const { sandboxes } = await getLayer();
		const listed = await sandboxes.list(c.key[0]!);
		const now = Date.now();
		c.vars.listed = { at: now, sandboxes: listed };
		const done = await changeUsage(c, (book) =>
			book.reconcile(
				now,
				listed.map((sandbox) => sandbox.sessionId).filter((session) => session !== ""),
			),
		);
		// A count that was wrong means a sandbox was made or removed without this actor being told: worth a look.
		if (done.added.length > 0 || done.dropped.length > 0) {
			console.warn(`[wlp] usage.kept_corrected uid=${c.key[0]}: counted ${done.added.length} sandbox(es) nobody had claimed (${done.added.join(",") || "none"}) and dropped ${done.dropped.length} place(s) with no sandbox behind them (${done.dropped.join(",") || "none"}); ${c.vars.usage.kept().length} kept now`);
		}
	} catch (error) {
		c.log.warn({ msg: "could not hold the count of kept sandboxes against the provider's list", error: String(error) });
	}
}

/** The usage page: the numbers, today by agent, the kept sandboxes as the provider lists them, the history and the price. */
async function usageView(c: UsageCtx): Promise<UsageView> {
	const layer = await getLayer();
	await reconcileKept(c);
	const now = Date.now();
	await sweepUsage(c, now);
	const book = c.vars.usage;
	const listed = new Map<string, ListedSandbox>();
	// A session with more than one sandbox at the provider is shown as running when any of them is.
	for (const sandbox of c.vars.listed?.sandboxes ?? []) if (sandbox.state === "running" || !listed.has(sandbox.sessionId)) listed.set(sandbox.sessionId, sandbox);
	const kept: KeptSandbox[] = book
		.kept()
		.map((claim) => {
			const session = c.vars.sessions.get(claim.session);
			return {
				sessionId: claim.session,
				title: session?.title ?? null,
				state: listed.get(claim.session)?.state ?? (session && session.sandbox !== "none" ? session.sandbox : ("starting" as const)),
				usedAt: session?.updatedAt ?? null,
				busy: session !== undefined && session.status !== "idle",
				repository: session?.repository ? `${session.repository.owner}/${session.repository.name}` : null,
				pushed: Boolean(session?.pullRequest),
			};
		})
		.sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || (a.sessionId < b.sessionId ? -1 : 1));
	return {
		...book.numbers(now),
		today: book.today(now).map((row) => ({ ...row, title: c.vars.sessions.get(row.sessionId)?.title ?? null })),
		days: book.days(now),
		kept,
		price: layer.sandboxes.price(),
		// Where Windlass's data is on the sandbox's own disk, the agent's memory goes with it unless a copy is kept in a bucket.
		memory: layer.sandboxes.sessionsLiveInSandbox ? (layer.backups ? "copied" : "lost") : "kept",
	};
}

export function cleanTitle(title: unknown): string | null {
	if (typeof title !== "string") return null;
	const clean = title.replace(/\s+/g, " ").trim();
	if (clean === "") return null;
	return clean.length > MAX_TITLE_CHARS ? clean.slice(0, MAX_TITLE_CHARS) : clean;
}

/** An https git address with no credentials in it, and nothing a shell or git could read as an option. */
export function cleanRepoUrl(raw: unknown): string | null {
	if (raw === undefined || raw === null || raw === "") return null;
	const problem = new UserError("The repository must be an https git address without a user name or password in it, like https://github.com/owner/name.git", {
		code: "bad_repo_url",
	});
	if (typeof raw !== "string") throw problem;
	const text = raw.trim();
	if (text.length > MAX_REPO_URL_CHARS || !/^https:\/\/[A-Za-z0-9._~:/%+-]+$/.test(text)) throw problem;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw problem;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "" || url.pathname.length < 2) throw problem;
	return url.toString();
}

function launchPlace(place: SandboxPlace | undefined): SandboxPlace {
	if (place === undefined || place?.kind === "hosted") return { kind: "hosted" };
	if (place?.kind === "machine" && typeof place.machineId === "string" && place.machineId !== "") return { kind: "machine", machineId: place.machineId };
	throw new UserError("Choose where the sandbox runs.", { code: "bad_input" });
}

/** What `makeSession` needs of an action's context. */
interface CreateCtx extends UserCtx, ModelsCtx {
	log: { error(entry: unknown): void };
	// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
	client(): any;
}

/** What a key belongs to in a user's actor, in the words of a refusal (submissions.ts). */
const KEYED = "agent";

/**
 * Makes a session from what `createSession` was sent: checks it, asks GitHub about a repository of the
 * connection, creates the session's actor, and puts the session in the user's index. It waits on
 * several of those, and other calls run meanwhile; the session is in the index, and its key with it,
 * in one synchronous step at the end, or the call is refused and nothing of it is kept.
 */
async function makeSession(c: CreateCtx, profile: UserProfile, input: CreateSessionInput, submission: Submission | null): Promise<SessionSummary> {
	const place = launchPlace(input.place);
	let repoUrl = cleanRepoUrl(input.repoUrl);
	const givenTitle = input.title === undefined || input.title === null ? null : cleanTitle(input.title);
	// A setup command is saved for a repository of the GitHub connection, and is checked before GitHub is asked anything.
	const setupCommand = input.setupCommand === undefined || input.setupCommand === null ? null : setupCommandOf(input.setupCommand);
	if (setupCommand !== null && (input.repository === undefined || input.repository === null)) {
		throw new UserError("A setup command is saved for a repository of your GitHub connection. Choose one, or leave the setup command out.", { code: "bad_input" });
	}
	if (input.publishUnasked !== undefined && input.publishUnasked !== null && typeof input.publishUnasked !== "boolean") throw new UserError("Say yes or no to letting the agent publish without asking.", { code: "bad_input" });
	if (input.publishUnasked === true && (input.repository === undefined || input.repository === null)) {
		throw new UserError("An agent can publish only to a repository of your GitHub connection. Choose one, or leave that setting off.", { code: "bad_input" });
	}
	// A repository of the user's GitHub connection: GitHub is asked now whether this user may read it.
	let repo: StoredRepository | null = null;
	if (input.repository !== undefined && input.repository !== null) {
		if (repoUrl !== null) throw new UserError("Choose a repository from GitHub or paste an address, not both.", { code: "bad_input" });
		const { id, branch } = input.repository;
		if (!Number.isSafeInteger(id) || id <= 0 || (branch !== undefined && branch !== null && !isBranchName(branch))) throw new UserError("Choose one of the listed repositories and one of its branches.", { code: "bad_input" });
		const app = requireGithub();
		try {
			const { installation, repository } = await resolveRepository(app, requireConnection(c), id, "read");
			repo = {
				provider: "github",
				id: repository.id,
				owner: repository.owner,
				name: repository.name,
				branch: branch ?? repository.defaultBranch,
				private: repository.private,
				url: app.repositoryUrl(repository.owner, repository.name),
				installationId: installation.id,
			};
			repoUrl = app.cloneUrl(repository.owner, repository.name);
		} catch (error) {
			throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
		}
	}

	let summary: SessionSummary;
	try {
		const { sandboxes } = await layerFor(place, profile.uid);
		const chosen = sandboxes.profiles().find((candidate) => candidate.id === input.profile);
		if (!chosen) throw new UserError("That sandbox does not exist.", { code: "bad_profile" });
		if (!chosen.available) {
			throw new UserError(`${chosen.name} cannot be chosen yet. ${chosen.unavailableReason ?? ""}`.trim(), { code: "profile_unavailable" });
		}
		// Letting the agent publish unasked is for sandboxes whose commands cannot ask in its name.
		const unaskedProblem = repo && input.publishUnasked === true ? publishUnaskedProblem(commandSandbox(chosen)) : null;
		if (unaskedProblem !== null) throw new UserError(unaskedProblem, { code: "bad_input" });
		const models = await modelsOf(c, profile.demo);
		const model = modelInput(() => chosenModel(models, input.model));

		// Saved before the session exists, so that its first sandbox finds it. It stays if the session cannot be made.
		if (repo && setupCommand !== null) await saveSetup(c, profile.uid, setupKeyOf(repo.id), `${repo.owner}/${repo.name}`, setupCommand);

		const now = Date.now();
		summary = {
			id: `s_${randomBytes(8).toString("hex")}`,
			title: givenTitle ?? DEFAULT_TITLE,
			place,
			profile: chosen.id,
			model,
			repoUrl,
			...(repo ? { repository: { provider: repo.provider, id: repo.id, owner: repo.owner, name: repo.name, branch: repo.branch, private: repo.private, url: repo.url }, pullRequest: null, publishUnasked: input.publishUnasked === true } : {}),
			createdAt: now,
			updatedAt: now,
			status: "idle",
			turns: 0,
			lastOutcome: null,
			sandbox: "none",
		};
		await createSessionActor(c, profile.uid, summary.id, {
			title: summary.title,
			titleIsDefault: givenTitle === null,
			place: summary.place,
			profile: summary.profile,
			model,
			repoUrl,
			repo,
			publishUnasked: repo !== null && input.publishUnasked === true,
			demo: profile.demo,
			createdAt: now,
		});
	} catch (error) {
		throw clientError(c.log, error, "The agent could not be created. Try again.");
	}

	// In one step with the session: from here a `createSession` with this key answers with it.
	c.vars.sessions.set(summary.id, summary);
	if (submission) c.vars.created.set(submission.key, { ...submission, id: summary.id });
	await storeSession(c, summary, submission);
	broadcastSessions(c);
	return summary;
}

export const user = actor({
	options: { name: "User", icon: "user", actionTimeout: 180_000 },

	db: db({
		onMigrate: async (db) => {
			await db.execute(`
				CREATE TABLE IF NOT EXISTS profile (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					uid TEXT NOT NULL,
					email TEXT,
					demo INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			await db.execute(`
				CREATE TABLE IF NOT EXISTS sessions (
					id TEXT PRIMARY KEY,
					created_at INTEGER NOT NULL,
					summary TEXT NOT NULL
				)
			`);
			// `sealed` is the sign-in, encrypted (signin/seal.ts); NULL once it was forgotten.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS signin (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					sealed TEXT,
					generation INTEGER NOT NULL,
					short_noted INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			// The GitHub connection: who connected and which installations, as JSON. No credential.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS github (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					connection TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			// Numbers used once: a state that was issued and waits for GitHub's answer (`state`, with its
			// PKCE verifier), and a ticket that was taken (`ticket`), kept until it would have expired.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS github_nonce (
					nonce TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					verifier TEXT,
					expires_at INTEGER NOT NULL
				)
			`);
			// The approvals of MCP servers that projects name (server-approvals.ts): one per project, server and
			// definition, good until `expires_at`. `label` is the project in words, for a reader of the table.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS server_approval (
					project TEXT NOT NULL,
					name TEXT NOT NULL,
					fingerprint TEXT NOT NULL,
					label TEXT NOT NULL,
					approved_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					PRIMARY KEY (project, name, fingerprint)
				)
			`);
			// The setup commands of repositories (setup-command.ts): one per repository of the GitHub connection,
			// `project` being "github:<GitHub's id>". `label` is the repository in words, for a reader of the table.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS setup_command (
					project TEXT PRIMARY KEY,
					label TEXT NOT NULL,
					command TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			// The secrets of repositories (repo-secrets.ts): one per repository and name, `project` as above.
			// `sealed` is the value, encrypted for this user, repository and name; nothing else here is secret.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS repo_secret (
					project TEXT NOT NULL,
					name TEXT NOT NULL,
					label TEXT NOT NULL,
					scope TEXT NOT NULL,
					sealed TEXT NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (project, name)
				)
			`);
			// What new sessions on a repository start with (repository-defaults.ts): one row per repository, `project` as above.
			await db.execute(DEFAULTS_TABLE);
			// The checks of repositories (repository-checks.ts): one row per repository, `project` as above, the list as JSON.
			await db.execute(CHECKS_TABLE);
			// What the user keeps for their account: the defaults for new sessions (account-defaults.ts), their own MCP
			// servers (personal-servers.ts) and the secrets those read (account-secrets.ts), each value sealed.
			await db.execute(ACCOUNT_DEFAULTS_TABLE);
			// The models of the user's ChatGPT plan as Windlass last listed them (account-models.ts): one row.
			await db.execute(MODELS_TABLE);
			await db.execute(PERSONAL_SERVERS_TABLE);
			await db.execute(ACCOUNT_SECRETS_TABLE);
			// Tables made before a server had its setting and a secret its scope lack the column: those servers' tools ask, and those secrets are for MCP servers only, as they were.
			// And the sessions made before a session could be created with a key have none (submissions.ts): `key`, and `sent`, the digest of what was asked for under it.
			for (const [table, column, definition] of [
				["personal_server", "unasked", "INTEGER NOT NULL DEFAULT 0"],
				["account_secret", "scope", "TEXT NOT NULL DEFAULT 'setup'"],
				["sessions", "key", "TEXT"],
				["sessions", "sent", "TEXT"],
			] as const) {
				const columns = await db.execute<{ name: string }>(`PRAGMA table_info(${table})`);
				if (!columns.some((found) => found.name === column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
			}
			// The deleted sessions whose copy in the bucket is still to be removed: how often this actor
			// tried, when it tries next, and the schedule that is to do it.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS backup_removal (
					session TEXT PRIMARY KEY,
					tries INTEGER NOT NULL,
					due_at INTEGER NOT NULL,
					schedule_id TEXT NOT NULL
				)
			`);
			// The ledger of sandbox time (usage.ts): one row per hold that was closed, with the seconds counted
			// for it and the UTC day they count against. Rows are added and never changed; `hold` is unique, so a
			// hold is counted once. `note` says why a count is not simply what the session reported.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS usage_entry (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					day INTEGER NOT NULL,
					session TEXT NOT NULL,
					hold TEXT NOT NULL UNIQUE,
					kind TEXT NOT NULL,
					seconds INTEGER NOT NULL,
					at INTEGER NOT NULL,
					note TEXT
				)
			`);
			await db.execute("CREATE INDEX IF NOT EXISTS usage_entry_day ON usage_entry (day)");
			// The holds of sandboxes that run now, one per session, each counted in full at `expires_at` unless settled before.
			await db.execute(`
				CREATE TABLE IF NOT EXISTS usage_hold (
					session TEXT PRIMARY KEY,
					id TEXT NOT NULL,
					day INTEGER NOT NULL,
					seconds INTEGER NOT NULL,
					started_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL
				)
			`);
			// The sessions that have a place among the sandboxes the user keeps.
			await db.execute("CREATE TABLE IF NOT EXISTS kept_sandbox (session TEXT PRIMARY KEY, since INTEGER NOT NULL)");
		},
	}),

	createVars: async (c): Promise<UserVars> => {
		const [row] = await c.db.execute<{ uid: string; email: string | null; demo: number }>("SELECT uid, email, demo FROM profile WHERE id = 1");
		const rows = await c.db.execute<{ summary: string; key: string | null; sent: string | null }>("SELECT summary, key, sent FROM sessions");
		const sessions = new Map<string, SessionSummary>();
		const created = new Map<string, Submission & { id: string }>();
		for (const { summary, key, sent } of rows) {
			const parsed = JSON.parse(summary) as SessionSummary;
			if (parsed.place === undefined) parsed.place = { kind: "hosted" };
			sessions.set(parsed.id, parsed);
			if (key !== null && sent !== null) created.set(key, { key, sent, id: parsed.id });
		}
		// An actor that holds a sign-in is a user's, also before that user's own token was seen here.
		const [held] = await c.db.execute<{ id: number }>("SELECT id FROM signin WHERE id = 1");
		const [connected] = await c.db.execute<{ connection: string }>("SELECT connection FROM github WHERE id = 1");
		const github = connected ? (JSON.parse(connected.connection) as StoredConnection) : null;
		const approvals = new ApprovalBook(await readApprovals(c.db), config.serverApprovalTtlMs);
		return { profile: row ? { uid: row.uid, email: row.email, demo: row.demo === 1 } : null, reached: row !== undefined || held !== undefined, sessions, created, creating: new Attempts(), signIn: null, signInDb: null, approvals, github, models: new AccountModels({ uid: c.key[0]! }), usage: await readUsage(c.db), listed: null };
	},

	events: {
		sessions: event<SessionSummary[]>({ canSubscribe: (c) => maySubscribe(c) }),
		usage: event<UsageNumbers>({ canSubscribe: (c) => maySubscribe(c) }),
	},

	onBeforeConnect: (c, params: ConnParams | undefined) => {
		assertOrigin(c);
		try {
			const caller = authenticate(c.key, params);
			if (caller.kind === "user") c.vars.reached = true;
		} catch (error) {
			// `getOrCreate` makes the actor before this hook runs, so a call without a valid token can
			// leave an empty actor behind under any key. One that no user has ever reached is removed.
			if (!c.vars.reached && c.vars.sessions.size === 0) c.destroy();
			throw error;
		}
	},

	onConnect: async (c, conn) => {
		const caller = authenticate(c.key, conn.params);
		if (caller.kind === "user") await rememberProfile(c, caller.profile);
	},

	onWake: async (c) => {
		// A try whose next schedule was set and not stored, because the server stopped in between, is set again.
		try {
			const late = await c.db.execute<{ session: string; tries: number }>("SELECT session, tries FROM backup_removal WHERE due_at < ?", Date.now() - BACKUP_REMOVE_LATE_MS);
			for (const { session, tries } of late) await armBackupRemoval(c, session, tries);
		} catch (error) {
			c.log.warn({ msg: "could not set the removal of deleted sessions' copies again", error: String(error) });
		}
	},

	actions: {
		me: async (c): Promise<UserProfile> => {
			const profile = requireUser(c);
			await rememberProfile(c, profile);
			return profile;
		},

		chatgpt: async (c): Promise<ChatgptStatus> => {
			const profile = requireUser(c);
			if (profile.demo) return { connected: false, email: null, accessExpiresAt: null };
			try {
				const account = await (await signIn(c)).status();
				if (!account) return { connected: false, email: null, accessExpiresAt: null };
				return { connected: true, email: account.email ?? null, accessExpiresAt: account.accessExpiresAt ?? null };
			} catch (error) {
				throw clientError(c.log, error, "The ChatGPT sign-in could not be checked.");
			}
		},

		/**
		 * Forgets the user's ChatGPT sign-in: no access token of it is handed out again, and the token
		 * files of turns still running are removed. The platform's own token stays as it is.
		 */
		forgetChatgpt: async (c): Promise<void> => {
			const profile = requireUser(c);
			if (profile.demo) return;
			try {
				await (await signIn(c)).logout();
				await c.vars.models.forget(c.db);
				console.log(`[wlp] sign-in.forgotten uid=${profile.uid}`);
			} catch (error) {
				throw clientError(c.log, error, "The ChatGPT sign-in could not be forgotten. Try again.");
			}
		},

		models: async (c): Promise<ModelList> => {
			const profile = requireUser(c);
			try {
				return await modelsOf(c, profile.demo);
			} catch (error) {
				throw clientError(c.log, error, "Your models could not be read. Try again.");
			}
		},

		listSessions: (c): SessionSummary[] => {
			requireUser(c);
			return sessionList(c.vars);
		},

		createSession: async (c, input: CreateSessionInput): Promise<SessionSummary> => {
			const profile = requireUser(c);
			if (typeof input !== "object" || input === null) throw new UserError("Choose a sandbox for the agent.", { code: "bad_input" });
			// Without a key every call makes a session, as it always did.
			let attempt: Promise<SessionSummary>;
			try {
				const { idempotencyKey, ...asked } = input;
				const submission = submissionOf(idempotencyKey, asked);
				if (submission === null) return await makeSession(c, profile, input, null);
				// Made before, and still there: the answer is that session as it is now. Nothing was awaited, so this is decided before any other call runs.
				const made = c.vars.created.get(submission.key);
				const session = made && isRepeat(made, submission, KEYED) ? c.vars.sessions.get(made.id) : undefined;
				if (session) return session;
				// Being decided, or new: every attempt that arrives until the session is made or refused ends as this one does.
				attempt = c.vars.creating.run(submission, KEYED, () => makeSession(c, profile, input, submission));
			} catch (error) {
				if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
			return await attempt;
		},

		renameSession: async (c, id: string, title: string): Promise<SessionSummary> => {
			const profile = requireUser(c);
			const clean = cleanTitle(title);
			if (!clean) throw new UserError("Give the agent a name.", { code: "bad_title" });
			if (typeof id !== "string" || !c.vars.sessions.has(id)) throw new UserError("That agent does not exist.", { code: "session_not_found" });

			let summary: SessionSummary;
			try {
				summary = await sessionActor(c, profile.uid, id).internalRename(clean);
			} catch (error) {
				if (isActorGone(error)) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
				throw clientError(c.log, error, "The agent could not be renamed. Try again.");
			}
			if (c.vars.sessions.has(id)) {
				c.vars.sessions.set(id, summary);
				await storeSession(c, summary);
				broadcastSessions(c);
			}
			return summary;
		},

		deleteSession: async (c, id: string): Promise<void> => {
			const profile = requireUser(c);
			const existing = typeof id === "string" ? c.vars.sessions.get(id) : undefined;
			if (!existing) throw new UserError("That agent does not exist.", { code: "session_not_found" });

			// Out of the index first, so a report the session sends while it shuts down is ignored.
			c.vars.sessions.delete(id);
			try {
				await sessionActor(c, profile.uid, id).internalDestroy();
			} catch (error) {
				if (!isActorGone(error)) {
					if (!c.vars.sessions.has(id)) c.vars.sessions.set(id, existing);
					throw clientError(c.log, error, "The agent could not be deleted. Try again.");
				}
			}
			await c.db.execute("DELETE FROM sessions WHERE id = ?", id);
		// The key it was created with went with its row: the same key makes a new session from here.
		for (const [key, made] of c.vars.created) if (made.id === id) c.vars.created.delete(key);
			// A session with no repository was its own project: what was approved for it goes with it.
			await changeApprovals(c, (book) => book.forgetProject(sessionProjectKey(id))).catch((error) => c.log.warn({ msg: "could not forget the deleted session's approvals of MCP servers", session: id, error: String(error) }));
			broadcastSessions(c);
		},

		// --- sandbox time and kept sandboxes (usage.ts) ---------------------------------------------

		allowance: async (c): Promise<UsageNumbers> => {
			requireUser(c);
			try {
				const now = Date.now();
				await sweepUsage(c, now);
				return c.vars.usage.numbers(now);
			} catch (error) {
				throw clientError(c.log, error, "Your sandbox time could not be read. Try again.");
			}
		},

		usage: async (c): Promise<UsageView> => {
			requireUser(c);
			try {
				return await usageView(c);
			} catch (error) {
				throw clientError(c.log, error, "Your usage could not be read. Try again.");
			}
		},

		/**
		 * Removes the sandbox of one of the user's agents to make room. The agent does it itself where it
		 * is there, so its timeline says so and nothing is removed under a turn. What the provider then
		 * still lists for that agent is removed here: a sandbox the agent no longer knows of, or one that
		 * an agent which was deleted left behind.
		 */
		freeSandbox: async (c, sessionId: string): Promise<UsageView> => {
			const profile = requireUser(c);
			const id = approvalText(sessionId, 200);
			if (id === "") throw new UserError("Say which agent's sandbox to free.", { code: "bad_input" });
			try {
				const session = c.vars.sessions.get(id);
				if (session) {
					await sessionActor(c, profile.uid, id)
						.internalFreeSandbox()
						.catch((error: unknown) => {
							if (isActorGone(error)) return;
							// What the session itself refused (it is working) is said in its words.
							const { group, code, message } = (typeof error === "object" && error !== null ? error : {}) as { group?: unknown; code?: unknown; message?: unknown };
							if (group === "user" && typeof message === "string") throw new UserError(message, { code: typeof code === "string" ? code : "sandbox_busy" });
							throw error;
						});
					if (session.place.kind === "machine") return await usageView(c);
				}
				const { sandboxes } = await getLayer();
				for (const left of await sandboxes.list(profile.uid)) {
					if (left.sessionId !== id) continue;
					await sandboxes.destroy(left.id);
					console.log(`[wlp] sandbox.freed id=${left.id} uid=${profile.uid} session=${id}: it was left at the provider without its agent`);
				}
				await changeUsage(c, (book) => ({ change: book.release(id) }));
				c.vars.listed = null;
				return await usageView(c);
			} catch (error) {
				throw clientError(c.log, error, "The sandbox could not be freed. Try again.");
			}
		},

		// --- GitHub ------------------------------------------------------------------------------

		github: (c): GithubStatus => {
			requireUser(c);
			requireGithub();
			return githubStatus(c.vars);
		},

		githubConnect: async (c, input: { origin: string; install?: boolean }): Promise<{ url: string }> => {
			const profile = requireUser(c);
			const app = requireGithub();
			const origin = typeof input?.origin === "string" ? input.origin.replace(/\/+$/, "") : "";
			// The browser is sent back there with the ticket: only to the web app's own address.
			if (!config.origins.includes(origin)) throw new UserError("GitHub can only be connected from the web app's own address.", { code: "origin_not_allowed" });
			try {
				const nonce = newNonce();
				// The installation page takes no PKCE challenge: the code it ends with is exchanged without a verifier.
				if (input.install === true) {
					await rememberPending(c, nonce, null);
					return { url: app.installUrl(issueState(profile.uid, nonce, origin)) };
				}
				const { verifier, challenge } = newCodeVerifier();
				await rememberPending(c, nonce, verifier);
				return { url: app.authorizeUrl(issueState(profile.uid, nonce, origin), challenge) };
			} catch (error) {
				throw clientError(c.log, error, "Connecting GitHub could not be started. Try again.");
			}
		},

		githubComplete: async (c, ticket: string): Promise<GithubStatus> => {
			const profile = requireUser(c);
			requireGithub();
			const confirmed = verifyTicket(ticket);
			if (!confirmed) throw new UserError("This link to connect GitHub is not valid any more. Connect GitHub again.", { code: "github_ticket" });
			// The one check that ties the browser that came back from GitHub to the user who began.
			if (confirmed.uid !== profile.uid) {
				throw new UserError("This GitHub connection was started from another Windlass account, so it was not added to yours. Connect GitHub again from here.", { code: "github_ticket" });
			}
			try {
				// The primary key lets one of two calls with the same ticket through.
				await c.db.execute("INSERT INTO github_nonce (nonce, kind, verifier, expires_at) VALUES (?, 'ticket', NULL, ?)", `ticket:${confirmed.nonce}`, confirmed.exp + TICKET_TTL_MS);
			} catch {
				throw new UserError("This link to connect GitHub was already used. Connect GitHub again if it is not connected.", { code: "github_ticket" });
			}
			const connection: StoredConnection = {
				user: { id: confirmed.user.id, login: confirmed.user.login },
				installations: confirmed.installations.slice(0, MAX_GITHUB_ACCOUNTS).map(({ id, account, htmlUrl }) => ({ id, account: { id: account.id, login: account.login, type: account.type }, htmlUrl })),
				connectedAt: Date.now(),
			};
			await c.db.execute("INSERT INTO github (id, connection, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET connection = excluded.connection, updated_at = excluded.updated_at", JSON.stringify(connection), connection.connectedAt);
			c.vars.github = connection;
			c.vars.reached = true;
			console.log(`[wlp] github.connected uid=${profile.uid} github=${connection.user.login} installations=${connection.installations.map((installation) => installation.id).join(",")}`);
			return githubStatus(c.vars);
		},

		/** Forgets the connection. The app stays installed at GitHub, which is the account owner's to change. */
		githubDisconnect: async (c): Promise<GithubStatus> => {
			const profile = requireUser(c);
			requireGithub();
			await c.db.execute("DELETE FROM github");
			// A connection that was begun and not finished ends here too. The tickets that were taken stay
			// on the list until they would have expired: one of them must not bring the connection back.
			await c.db.execute("DELETE FROM github_nonce WHERE kind = 'state'");
			if (c.vars.github) console.log(`[wlp] github.disconnected uid=${profile.uid}`);
			c.vars.github = null;
			return githubStatus(c.vars);
		},

		githubRepositories: async (c, query: string, fresh?: boolean): Promise<GithubRepositoryList> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (typeof query !== "string" || query.length > 200) throw new UserError("Search for part of a repository's name.", { code: "bad_input" });
			try {
				// Asked for anew: somebody who has just added a repository at GitHub wants to see it.
				if (fresh === true) forgetGithubCaches();
				return await listRepositories(app, connection, query);
			} catch (error) {
				throw githubError(c.log, error, "The repositories could not be listed. Try again.");
			}
		},

		githubBranches: async (c, repositoryId: number): Promise<GithubBranchList> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new UserError("Choose one of the listed repositories.", { code: "bad_input" });
			try {
				return await listBranches(app, connection, repositoryId);
			} catch (error) {
				throw githubError(c.log, error, "The repository's branches could not be listed. Try again.");
			}
		},

		// --- setup commands of repositories (setup-command.ts) --------------------------------------

		repositorySetup: async (c, repositoryId: number): Promise<RepositorySetup> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await readSetup(c.db, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's setup command could not be read. Try again.");
			}
		},

		saveRepositorySetup: async (c, input: { repositoryId: number; command: string }): Promise<RepositorySetup> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const command = setupCommandOf(input?.command);
			try {
				return await saveSetup(c, profile.uid, project, await labelFor(c, input.repositoryId, project), command);
			} catch (error) {
				throw clientError(c.log, error, "The setup command could not be saved. Try again.");
			}
		},

		// --- checks of repositories (repository-checks.ts) -------------------------------------------

		repositoryChecks: async (c, repositoryId: number): Promise<RepositoryChecks> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await readChecks(c.db, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's checks could not be read. Try again.");
			}
		},

		saveRepositoryChecks: async (c, input: { repositoryId: number; checks: RepositoryCheck[] }): Promise<RepositoryChecks> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			let checks: RepositoryCheck[];
			try {
				checks = cleanChecks(input?.checks);
			} catch (error) {
				if (error instanceof ChecksProblem) throw new UserError(error.message, { code: "bad_checks" });
				throw error;
			}
			try {
				// The list is written whole, in one statement: of two saves that run together, one stays as it was sent.
				const saved = await saveChecks(c.db, project, await labelFor(c, input.repositoryId, project), checks, Date.now());
				// A command is the user's text and may hold what they would not want in a log: only how many there are is said.
				console.log(`[wlp] checks.saved uid=${profile.uid} project=${project} checks=${checks.length}`);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The checks could not be saved. Try again.");
			}
		},

		/** The setup command of a session's repository, for that session when its sandbox is new. */
		internalSetupCommand: async (c, project: string): Promise<RepositorySetup> => {
			requireService(c);
			return readSetup(c.db, approvalText(project, 600));
		},

		// --- secrets of repositories (repo-secrets.ts) ----------------------------------------------

		repositorySecrets: async (c, input: { repositoryId: number; profile: string; sessionId?: string }): Promise<RepositorySecrets> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(c, input?.profile, input);
			try {
				return await listSecrets(c.db, project, profile, secretLists(c.vars, input.repositoryId, input.sessionId));
			} catch (error) {
				throw clientError(c.log, error, "The repository's secrets could not be read. Try again.");
			}
		},

		saveRepositorySecret: async (c, input: { repositoryId: number; profile: string; sessionId?: string; name: string; value?: string; scope: SecretScope }): Promise<RepositorySecrets> => {
			const user = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(c, input?.profile, input);
			const name = secretInput(() => cleanSecretName(input?.name));
			const scope = secretInput(() => cleanSecretScope(input?.scope));
			const value = input?.value === undefined || input?.value === null ? undefined : secretInput(() => cleanSecretValue(input.value));
			try {
				await saveSecret(c, user.uid, project, await labelFor(c, input.repositoryId, project), name, value, scope);
				return await listSecrets(c.db, project, profile, secretLists(c.vars, input.repositoryId, input.sessionId));
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be saved. Try again.");
			}
		},

		deleteRepositorySecret: async (c, input: { repositoryId: number; profile: string; sessionId?: string; name: string }): Promise<RepositorySecrets> => {
			const user = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(c, input?.profile, input);
			const name = approvalText(input?.name, 200);
			try {
				await c.db.execute("DELETE FROM repo_secret WHERE project = ? AND name = ?", project, name);
				console.log(`[wlp] secret.deleted uid=${user.uid} project=${project} name=${name.replace(/[^A-Za-z0-9_]/g, "?")}`);
				return await listSecrets(c.db, project, profile, secretLists(c.vars, input.repositoryId, input.sessionId));
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be deleted. Try again.");
			}
		},

		/**
		 * The secrets of a session's repository, each value still sealed, for that session's turn, and with
		 * them what its user keeps for the account: the account's secrets, sealed too, and the user's own
		 * MCP servers. The caller must hold a service token made for exactly this user and session
		 * (`secretsCaller`), and which repository it is is read from this actor's own index of the user's
		 * sessions, not from the call: a session is handed the secrets of the repository it was launched
		 * on and of no other, and a session this user does not have is handed none.
		 */
		internalSessionSecrets: async (c, sessionId: string): Promise<SealedSecrets> => {
			const id = approvalText(sessionId, 200);
			requireServiceFor(c, secretsCaller(c.key[0]!, id));
			// A session this user does not have is handed nothing, of the account's either.
			const session = c.vars.sessions.get(id);
			if (!session) return { project: null, secrets: [], checks: [], account: { secrets: [], servers: [] } };
			const kept = await c.db.execute<{ name: string; scope: string; sealed: string }>("SELECT name, scope, sealed FROM account_secret ORDER BY name");
			const account = {
				secrets: kept.map((row) => ({ name: row.name, scope: row.scope === "agent" ? ("agent" as const) : ("setup" as const), sealed: row.sealed })),
				servers: (await readServers(c.db)).map(({ name, definition, unasked }) => ({ name, definition, unasked })),
			};
			const project = setupProjectKey(session.repository?.id);
			if (project === null) return { project: null, secrets: [], checks: [], account };
			const rows = await c.db.execute<{ name: string; scope: string; sealed: string }>("SELECT name, scope, sealed FROM repo_secret WHERE project = ? ORDER BY name", project);
			const { checks } = await readChecks(c.db, project);
			return { project, secrets: rows.map((row) => ({ name: row.name, scope: row.scope === "agent" ? "agent" : "setup", sealed: row.sealed })), checks, account };
		},

		// --- a repository's page ----------------------------------------------------------------------

		repository: async (c, repositoryId: number): Promise<RepositoryView> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await repositoryView(c, repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "What is saved for the repository could not be read. Try again.");
			}
		},

		/** Asks GitHub whether the user's connection still reaches the repository, and what it is called now. */
		githubRepository: async (c, repositoryId: number): Promise<GithubRepository> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			const app = requireGithub();
			const connection = requireConnection(c);
			let found: GithubRepository;
			try {
				found = (await resolveRepository(app, connection, repositoryId, "read")).described;
			} catch (error) {
				throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
			}
			// What is saved for it is named as GitHub names it now: its page then says the name without asking, also once GitHub no longer answers for it.
			const name = `${found.owner}/${found.name}`;
			try {
				for (const table of ["setup_command", "repository_checks", "repo_secret", "repository_defaults"]) await c.db.execute(`UPDATE ${table} SET label = ? WHERE project = ? AND label != ?`, name, project, name);
			} catch (error) {
				c.log.warn({ msg: "could not note what a repository is called now", project, error: String(error) });
			}
			return found;
		},

		saveRepositoryDefaults: async (c, input: { repositoryId: number; profile?: string | null; model?: string | null }): Promise<RepositoryDefaults> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			let change: DefaultsChange;
			try {
				const { sandboxes } = await getLayer();
				change = cleanDefaults(input, sandboxes.profiles(), await modelsOf(c, profile.demo));
			} catch (error) {
				if (error instanceof DefaultsProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
			try {
				const saved = await saveDefaults(c.db, project, await labelFor(c, input.repositoryId, project), change, Date.now());
				console.log(`[wlp] defaults.saved uid=${profile.uid} project=${project}${change.profile === undefined ? "" : ` profile=${change.profile ?? "none"}`}${change.model === undefined ? "" : ` model=${change.model ?? "none"}`}`);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
		},

		forgetRepositoryApproval: async (c, input: { repositoryId: number; name: string }): Promise<RepositoryView> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const name = approvalText(input?.name, 200);
			try {
				const done = await changeApprovals(c, (book) => book.forget(project, name));
				if (done.removed.length > 0) console.log(`[wlp] server.approval_forgotten uid=${profile.uid} project=${project} server=${logged(name)}`);
				return await repositoryView(c, input.repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be forgotten. Try again.");
			}
		},

		forgetRepository: async (c, repositoryId: number): Promise<RepositoryView> => {
			const profile = requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				// The secrets first: if anything after them fails, what is left holds no value.
				await c.db.execute("DELETE FROM repo_secret WHERE project = ?", project);
				await c.db.execute("DELETE FROM setup_command WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_checks WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_defaults WHERE project = ?", project);
				const done = await changeApprovals(c, (book) => book.forgetProject(project));
				console.log(`[wlp] repository.forgotten uid=${profile.uid} project=${project} approvals=${done.removed.length}`);
				return await repositoryView(c, repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "What is saved for the repository could not be deleted. Try again.");
			}
		},

		savedRepositories: async (c): Promise<SavedRepository[]> => {
			requireUser(c);
			try {
				const rows = await c.db.execute<{ project: string; label: string }>(
					"SELECT project, MAX(label) AS label FROM (SELECT project, label FROM setup_command UNION ALL SELECT project, label FROM repository_checks UNION ALL SELECT project, label FROM repo_secret UNION ALL SELECT project, label FROM repository_defaults) GROUP BY project",
				);
				const now = Date.now();
				const found = new Map<number, string>();
				const note = (project: string, label: string) => {
					const id = repositoryIdOf(project);
					if (id !== null && (found.get(id) ?? "") === "") found.set(id, label);
				};
				for (const row of rows) note(row.project, row.label);
				for (const approval of c.vars.approvals.all()) if (approval.expiresAt > now) note(approval.project, approval.label);
				return [...found]
					.map(([id, label]) => ({ id, name: repositoryLabel(c.vars, id) || label || null }))
					// By name, and those nothing names after them.
					.sort((a, b) => Number(a.name === null) - Number(b.name === null) || (a.name ?? "").localeCompare(b.name ?? "") || a.id - b.id)
					.slice(0, MAX_SAVED_REPOSITORIES);
			} catch (error) {
				throw clientError(c.log, error, "The repositories something is saved for could not be listed. Try again.");
			}
		},

		// --- the account's settings (account-defaults.ts, personal-servers.ts, account-secrets.ts) ----

		account: async (c): Promise<AccountSettings> => {
			requireUser(c);
			try {
				return await accountView(c.db);
			} catch (error) {
				throw clientError(c.log, error, "Your settings could not be read. Try again.");
			}
		},

		saveAccountDefaults: async (c, input: { profile?: string | null; model?: string | null }): Promise<AccountDefaults> => {
			const profile = requireUser(c);
			let change: DefaultsChange;
			try {
				const { sandboxes } = await getLayer();
				change = cleanDefaults(input, sandboxes.profiles(), await modelsOf(c, profile.demo));
			} catch (error) {
				if (error instanceof DefaultsProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
			try {
				const saved = await saveAccountDefaults(c.db, change, Date.now());
				console.log(`[wlp] defaults.saved uid=${profile.uid} project=account${change.profile === undefined ? "" : ` profile=${change.profile ?? "none"}`}${change.model === undefined ? "" : ` model=${change.model ?? "none"}`}`);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
		},

		savePersonalServer: async (c, input: { name: string; definition: unknown; unasked?: boolean; existing?: boolean }): Promise<AccountSettings> => {
			const profile = requireUser(c);
			// Decided before anything is awaited: what is stored is what Windlass takes, or nothing is.
			const name = serverInput(() => cleanServerName(input?.name));
			const definition = serverInput(() => cleanServerDefinition(input?.definition));
			const unasked = serverInput(() => cleanUnasked(input?.unasked));
			const existing = input?.existing === true;
			try {
				if (existing) await changeServer(c.db, name, definition, unasked, Date.now());
				else await addServer(c.db, name, definition, unasked, Date.now());
			} catch (error) {
				if (error instanceof ServerProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The server could not be saved. Try again.");
			}
			// The name and the kind, never anything of the definition: an argument or an address may hold what its user would not want in a log.
			console.log(`[wlp] server.saved uid=${profile.uid} name=${name} kind=${typeof definition.url === "string" ? "address" : "command"} unasked=${unasked} definition=${existing ? "replaced" : "new"}`);
			try {
				return await accountView(c.db);
			} catch (error) {
				throw clientError(c.log, error, "The server was saved, but your settings could not be read again. Reload the page.");
			}
		},

		deletePersonalServer: async (c, name: string): Promise<AccountSettings> => {
			const profile = requireUser(c);
			const named = approvalText(name, 200);
			try {
				await deleteServer(c.db, named);
				console.log(`[wlp] server.deleted uid=${profile.uid} name=${logged(named)}`);
				return await accountView(c.db);
			} catch (error) {
				throw clientError(c.log, error, "The server could not be deleted. Try again.");
			}
		},

		accountSecrets: async (c, input: { profile: string }): Promise<AccountSecrets> => {
			requireUser(c);
			const profile = await secretProfile(c, input?.profile);
			try {
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "Your account's secrets could not be read. Try again.");
			}
		},

		saveAccountSecret: async (c, input: { profile: string; name: string; value?: string; scope: SecretScope }): Promise<AccountSecrets> => {
			const user = requireUser(c);
			const profile = await secretProfile(c, input?.profile);
			const name = secretInput(() => cleanSecretName(input?.name));
			const scope = secretInput(() => cleanSecretScope(input?.scope));
			const value = input?.value === undefined || input?.value === null ? undefined : secretInput(() => cleanSecretValue(input.value));
			try {
				// Sealed for this user, the account and the name before it is stored.
				await saveAccountSecret(c.db, name, scope, value === undefined ? undefined : sealSecret(serverSealer(), user.uid, ACCOUNT_SECRET_PROJECT, name, value), Date.now());
			} catch (error) {
				if (error instanceof TooManySecrets) throw new UserError(error.message, { code: "too_many_secrets" });
				if (error instanceof SecretNotFound) throw new UserError(error.message, { code: "secret_not_found" });
				throw clientError(c.log, error, "The secret could not be saved. Try again.");
			}
			// The name, never anything of the value: not its length either.
			console.log(`[wlp] secret.saved uid=${user.uid} project=${ACCOUNT_SECRET_PROJECT} name=${name} scope=${scope} value=${value === undefined ? "kept" : "saved"}`);
			try {
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret was saved, but the list could not be read again. Reload the page.");
			}
		},

		deleteAccountSecret: async (c, input: { profile: string; name: string }): Promise<AccountSecrets> => {
			const user = requireUser(c);
			const profile = await secretProfile(c, input?.profile);
			const name = approvalText(input?.name, 200);
			try {
				await deleteAccountSecret(c.db, name);
				console.log(`[wlp] secret.deleted uid=${user.uid} project=${ACCOUNT_SECRET_PROJECT} name=${name.replace(/[^A-Za-z0-9_]/g, "?")}`);
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be deleted. Try again.");
			}
		},

		// --- GitHub, for the servers and the sessions ---------------------------------------------

		/** Takes a state's number out of the list (github/connect.ts): it is there once. Answers with its PKCE verifier. */
		internalGithubClaim: async (c, nonce: string): Promise<{ ok: boolean; verifier: string | null }> => {
			requireService(c);
			if (typeof nonce !== "string" || nonce === "") return { ok: false, verifier: null };
			const [row] = await c.db.execute<{ verifier: string | null; expires_at: number }>("SELECT verifier, expires_at FROM github_nonce WHERE nonce = ? AND kind = 'state'", nonce);
			if (!row) return { ok: false, verifier: null };
			await c.db.execute("DELETE FROM github_nonce WHERE nonce = ? AND kind = 'state'", nonce);
			return row.expires_at > Date.now() ? { ok: true, verifier: row.verifier } : { ok: false, verifier: null };
		},

		/** A new state for this user, for the visit to the installation page that follows an authorization with nothing installed. */
		internalGithubState: async (c, origin: string): Promise<{ state: string }> => {
			requireService(c);
			const nonce = newNonce();
			await rememberPending(c, nonce, null);
			return { state: issueState(c.key[0]!, nonce, String(origin)) };
		},

		/** The connection, for a session that is about to clone or push. */
		internalGithubConnection: (c): StoredConnection | null => {
			requireService(c);
			return c.vars.github;
		},

		// --- approvals of projects' MCP servers, for the user's sessions (server-approvals.ts) -----

		internalServerApprovals: async (c, project: string): Promise<ServerApproval[]> => {
			requireService(c);
			const now = Date.now();
			// What has run out is dropped when somebody looks: nothing is scheduled for it.
			await changeApprovals(c, (book) => book.prune(now));
			return c.vars.approvals.of(approvalText(project, 600), now);
		},

		internalServerApprove: async (c, input: { project: string; label: string; name: string; fingerprint: string }): Promise<ServerApproval[]> => {
			requireService(c);
			const project = approvalText(input?.project, 600);
			const name = approvalText(input?.name, 200);
			const fingerprint = approvalText(input?.fingerprint, 200);
			if (project === "" || name === "" || fingerprint === "") throw new UserError("That approval names no project, server or definition.", { code: "bad_input" });
			const now = Date.now();
			await changeApprovals(c, (book) => {
				const pruned = book.prune(now);
				const approved = book.approve({ project, label: approvalText(input.label, 600), name, fingerprint }, now);
				return { added: approved.added, removed: [...pruned.removed, ...approved.removed] };
			});
			console.log(`[wlp] server.approval_remembered uid=${c.key[0]} project=${project} server=${name}`);
			return c.vars.approvals.of(project, now);
		},

		internalServerForget: async (c, input: { project: string; name: string }): Promise<{ forgotten: number; approvals: ServerApproval[] }> => {
			requireService(c);
			const project = approvalText(input?.project, 600);
			const name = approvalText(input?.name, 200);
			const now = Date.now();
			const done = await changeApprovals(c, (book) => book.forget(project, name));
			const forgotten = done.removed.filter((row) => row.expiresAt > now).length;
			if (done.removed.length > 0) console.log(`[wlp] server.approval_forgotten uid=${c.key[0]} project=${project} server=${name}`);
			return { forgotten, approvals: c.vars.approvals.of(project, now) };
		},

		// --- the sign-in, for the servers (signin/directory.ts) -----------------------------------

		/** Takes a finished sign-in, sealed for this user by the server that finished it, in place of an earlier one. */
		internalAdoptSignIn: async (c, sealed: string): Promise<SignInAnswer<null>> => {
			requireService(c);
			return answered(c, async () => {
				await (await signIn(c)).adopt(sealed);
				// From here on the actor is a user's, and stays.
				c.vars.reached = true;
				console.log(`[wlp] sign-in.adopted uid=${c.key[0]}`);
				return null;
			});
		},

		internalSignInStatus: async (c): Promise<SignInAnswer<ChatgptAccount | null>> => {
			requireService(c);
			return answered(c, async () => (await signIn(c)).status());
		},

		internalSignOut: async (c): Promise<SignInAnswer<null>> => {
			requireService(c);
			return answered(c, async () => {
				await (await signIn(c)).logout();
				await c.vars.models.forget(c.db);
				console.log(`[wlp] sign-in.forgotten uid=${c.key[0]}`);
				return null;
			});
		},

		/**
		 * The user's current access token (`AccessTokens.current`, sandbox/api.ts), sealed for the request
		 * that asked: `nonce` is the asking server's. The actor stays awake until the answer is made, so a
		 * refreshed sign-in is saved before the actor may sleep or move.
		 */
		internalAccessToken: async (c, nonce: string): Promise<SealedTokenAnswer> => {
			requireService(c);
			if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, problem: { kind: "other", message: "the request for an access token carries no nonce" } };
			try {
				const holder = await signIn(c);
				const token = await c.keepAwake(holder.accessToken());
				const { sealer } = await getSignIns();
				return { ok: true, sealed: sealer.seal("transit", tokenSubject(c.key[0]!, nonce), JSON.stringify(token)) };
			} catch (error) {
				const problem = problemOf(error);
				if (problem.kind === "other") c.log.error({ msg: "the user's access token could not be had", error: problem.message });
				return { ok: false, problem };
			}
		},

		/** The user's models, for a session of theirs whose prompt names a model or an effort. Never a demo user's: their sessions have the stand-in (account-models.ts). */
		internalModels: async (c): Promise<ModelList> => {
			requireService(c);
			return modelsOf(c, false);
		},

		// --- called by the actor's own schedule only ------------------------------------------------

		internalRemoveBackup: async (c, sessionId: string): Promise<void> => {
			// RivetKit sets `scheduledFire` on the context of a call its schedule makes; a client cannot.
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const [row] = await c.db.execute<{ tries: number; schedule_id: string }>("SELECT tries, schedule_id FROM backup_removal WHERE session = ?", sessionId);
			// Done already, or a firing that a later schedule took the place of.
			if (!row || row.schedule_id !== c.scheduledFire.id) return;
			const owner = { uid: c.key[0]!, sessionId };
			const tries = row.tries + 1;
			let object = `sessions/${owner.uid}/${sessionId}.tgz`;
			try {
				const { backups } = await getLayer();
				if (!backups) throw new Error("the server has no bucket configured");
				object = backups.keyOf(owner);
				// An object that is gone already counts as removed: the store answers a delete of it as done.
				await backups.remove(owner);
				await c.db.execute("DELETE FROM backup_removal WHERE session = ?", sessionId);
				console.log(`[wlp] backup.removed session=${sessionId} tries=${tries}`);
			} catch (error) {
				if (tries < BACKUP_REMOVE_TRIES) {
					console.warn(`[wlp] backup.remove_retry uid=${owner.uid} session=${sessionId} try=${tries}: ${String(error)}`);
					await armBackupRemoval(c, sessionId, tries);
					return;
				}
				await c.db.execute("DELETE FROM backup_removal WHERE session = ?", sessionId);
				console.error(`[wlp] backup.remove_failed uid=${owner.uid} session=${sessionId} object=${object}: gave up after ${tries} tries; the copy of this deleted session's Windlass data may still be in the bucket (${String(error)})`);
			}
		},

		// --- called by `agentSession` only -------------------------------------------------------

		internalSessionChanged: async (c, summary: SessionSummary): Promise<void> => {
			requireService(c);
			if (typeof summary?.id !== "string" || !c.vars.sessions.has(summary.id)) return;
			c.vars.sessions.set(summary.id, summary);
			await c.db.execute("UPDATE sessions SET summary = ? WHERE id = ?", JSON.stringify(summary), summary.id);
			broadcastSessions(c);
		},

		/** A deleted session's copy that the session could not remove: it is tried again from here. */
		internalRemoveBackupLater: async (c, sessionId: string): Promise<void> => {
			requireService(c);
			if (typeof sessionId !== "string" || sessionId === "") throw new UserError("A session id is needed.", { code: "bad_request" });
			const [pending] = await c.db.execute<{ session: string }>("SELECT session FROM backup_removal WHERE session = ?", sessionId);
			if (pending) return;
			await armBackupRemoval(c, sessionId, 0);
			console.log(`[wlp] backup.remove_deferred uid=${c.key[0]} session=${sessionId}: tried again in ${BACKUP_REMOVE_FIRST_MS / 1000} s`);
		},

		internalAcquireRun: async (c, sessionId: string): Promise<{ ok: boolean; running: number; known: boolean }> => {
			requireService(c);
			const uid = c.key[0];
			const others = () => [...c.vars.sessions.values()].filter((session) => session.id !== sessionId && session.status !== "idle");

			// At the limit, ask the sessions that look busy: one whose report never arrived would
			// otherwise block the user for good.
			if (others().length >= MAX_RUNNING_SESSIONS) {
				await Promise.all(
					others().map(async (stale) => {
						let fresh: SessionSummary | null = null;
						try {
							fresh = await sessionActor(c, uid, stale.id).internalSummary();
						} catch (error) {
							if (isActorGone(error)) fresh = { ...stale, status: "idle", sandbox: "none" };
							else c.log.warn({ msg: "could not refresh a session's summary", session: stale.id, error: String(error) });
						}
						if (fresh && c.vars.sessions.has(stale.id)) {
							c.vars.sessions.set(stale.id, fresh);
							await storeSession(c, fresh);
						}
					}),
				);
			}

			// From here to the `set` nothing is awaited: the count and the claim are one step.
			const entry = c.vars.sessions.get(sessionId);
			if (!entry) return { ok: false, running: others().length, known: false };
			const running = others().length;
			if (running >= MAX_RUNNING_SESSIONS) return { ok: false, running, known: true };
			const claimed: SessionSummary = { ...entry, status: entry.status === "idle" ? "starting" : entry.status };
			c.vars.sessions.set(sessionId, claimed);

			await storeSession(c, claimed);
			broadcastSessions(c);
			return { ok: true, running: running + 1, known: true };
		},

		// --- sandbox time and kept sandboxes, for the user's sessions (usage.ts) --------------------

		/**
		 * A session's sandbox is about to run, or goes on running: takes a hold of the day's allowance for
		 * it, and a place among the kept sandboxes when the session has none (`UsageBook.reserve`). Before
		 * a place is given or refused, the count is held against the provider's list, so that nobody is
		 * kept out by a count that is wrong. From there the count, the claim and the hold are one step.
		 */
		internalReserve: async (c, input: ReserveRequest): Promise<ReserveAnswer> => {
			requireService(c);
			const id = approvalText(input?.id, 64);
			const session = approvalText(input?.sessionId, 200);
			if (id === "" || session === "") throw new UserError("A hold needs an id and a session.", { code: "bad_input" });
			const settle = typeof input.settle?.hold === "string" && typeof input.settle.seconds === "number" ? { hold: input.settle.hold, seconds: input.settle.seconds } : undefined;
			const keep = input.keep === true;
			// A session that is being deleted is given nothing new.
			if (!c.vars.sessions.has(session)) return { ok: false, reason: "gone", numbers: c.vars.usage.numbers(Date.now()) };
			if (keep) await reconcileKept(c, c.vars.usage.atCap(session));

			const now = Date.now();
			const done = await changeUsage(c, (book) => book.reserve(now, { id, session, keep, fresh: input.fresh === true, settle }));
			const numbers = c.vars.usage.numbers(now);
			if (!done.ok) {
				console.log(`[wlp] usage.refused uid=${c.key[0]} session=${session} limit=${done.reason} used=${numbers.usedSeconds} held=${numbers.heldSeconds} allowance=${numbers.allowanceSeconds ?? "none"} kept=${numbers.sandboxes.kept} of ${numbers.sandboxes.limit ?? "any"}`);
				return { ok: false, reason: done.reason, numbers };
			}
			return { ok: true, hold: { id: done.hold.id, seconds: done.hold.seconds }, numbers };
		},

		internalSettle: async (c, input: { sessionId: string; hold: string; seconds: number }): Promise<{ known: boolean }> => {
			requireService(c);
			const session = approvalText(input?.sessionId, 200);
			const hold = approvalText(input?.hold, 64);
			const done = await changeUsage(c, (book) => book.settle(Date.now(), { session, hold, seconds: typeof input?.seconds === "number" ? input.seconds : Number.NaN }));
			return { known: done.known };
		},

		internalRelease: async (c, sessionId: string): Promise<void> => {
			requireService(c);
			await changeUsage(c, (book) => ({ change: book.release(approvalText(sessionId, 200)) }));
		},
	},
});
