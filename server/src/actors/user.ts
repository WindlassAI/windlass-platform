import { snapshotGeneration } from "../sandbox/snapshot-key.js";
import { plannerMachines } from "../machines/details.js";
import type { AgentModels } from "../factory/placement.js";
/**
 * `user`, key [uid]: a user's profile, the index of their sessions, and their ChatGPT sign-in.
 *
 * Stored in SQLite: the profile last seen on a valid token, one row per session holding its summary,
 * and the sign-in. The summaries are also held in memory so that counting the running sessions and
 * marking one as running happen in one synchronous step. A session that was created with the key of
 * its submission (submissions.ts; docs/architecture.md, "A message sent twice") has that key in its row, and in
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
 * The user's GitHub connection is here too (docs/github-and-repositories.md, "GitHub"): the GitHub user who connected and the
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
 * And what the user keeps for their account, whatever the repository (docs/github-and-repositories.md, "Account settings"):
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

import { githubId, isGithubId } from "../github/ids.js";
import type { MachineUpdate } from "./machine.js";
import { accountLimits, changeUserLimit, limitsSubject, type LimitAuditRow, type LimitChange } from "../user-limits.js";
import { limitedAccounts, loginGeneration, providerAccounts, recordProviderUsage, type AccountLocation } from "./provider-accounts.js";
import type { UsageObservation } from "../provider-usage.js";
import { changed as machinesChanged, machineCatalog, launchPlace, listMachines, launchMachineProfiles, logoutMachines, machineActions, machineSecrets, machineTables } from "./user-machines.js";
import { accountTokenWait, ATTACHMENT_SWEEP_ACTION, ITEM_TABLES, type ItemFacts, type ItemsState, type MakeSession, QUEUE_ACTION, notifyProviderWaits, notifyRemovedMachines, factorySlots, itemActions, itemSessionRefusal, loadItems, queueChanged } from "./user-items.js";
import type { EnvironmentPlace, EnvironmentSchedule, RepositoryEnvironments, SandboxProfileId } from "../contract.js";
import { ENVIRONMENT_SCHEDULES } from "../contract.js";
import { USAGE_HISTORY_DAYS, HOSTED_SIZES, ITEM_HOSTED_SIZE, SESSION_HOSTED_SIZE, isHostedSize, type HostedSize, type HostedSizeOption } from "../contract.js";
import type { GithubId, ApiToken, ApiTokenScope, CreateItemInput, FactoryLimits, ItemAction, ItemFeed, ItemListPage, ItemSummary, ItemView } from "../contract.js";
import type { TurnAnswer, TurnRelease, TurnRequest } from "./session-inbox.js";
import { randomBytes } from "node:crypto";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { serviceParams } from "../auth.js";
import { assertOrigin, disconnectRevoked, userActorCaller, clientError, maySubscribe, requireService, requireServiceFor, requireUser } from "../auth.js";
import { config, githubConfig, snapshotsFor } from "../config.js";
import { snapshotPlaces } from "../snapshot-places.js";
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
	listedSessions,
	type KeptSandbox,
	MAX_ACCOUNT_SECRETS,
	MAX_PERSONAL_SERVERS,
	MAX_SERVER_DEFINITION_BYTES,
	MAX_TITLE_CHARS,
	type ModelList,
	MAX_SECRETS_PER_REPOSITORY,
	type RepositoryApproval,
	type RepositoryCheck,
	type RepositoryChecks,
	type RepositoryNetwork,
	type NetworkScan,
	type EgressMode,
	type RepositoryDefaults,
	type RepositorySecrets,
	type RepositorySetup,
	type RepositoryView,
	type SandboxPlace,
	type MachineSummary,
	type MachineClaim,
	type MachineHostUpdate,
	type UserActions,
	type SandboxProfile,
	type SavedRepository,
	type SecretScope,
	type SessionSummary,
	type UsageNumbers,
	type UsageView,
	type UserProfile,
} from "../contract.js";
import { GITHUB_SYNC, GITHUB_SYNC_TABLE, retryGithubSync, syncGithubWebhooks, updateGithubInstallation, replaceGithubConnection, type InstallationChange } from "./user-github.js";
import { githubApp, type GithubApp } from "../github/app.js";
import { isBranchName } from "../github/git.js";
import type { StoredRepository } from "../github/publish.js";
import { GithubProblem, type StoredConnection, listBranches, listRepositories, resolveBoundRepository, resolveRepository } from "../github/repos.js";
import { MAX_GITHUB_ACCOUNTS, STATE_TTL_MS, TICKET_TTL_MS, issueState, newCodeVerifier, newNonce, verifyTicket } from "../github/state.js";
import { getLayer } from "../layer.js";
import { ACCOUNT_DEFAULTS_TABLE, LAST_START_TABLE, forgetLastStart, readAccountDefaults, readLastStart, recordLastStart, saveAccountDefaults } from "../account-defaults.js";
import { initialSessionModes } from "../sandbox/profiles.js";
import { codexModes, innerModesReason } from "../sandbox/codex-modes.js";
import { harnessName, itemHarnessProblem, itemProfileProblem, itemSignInMessage, itemSignInMethodProblem, knownHarness, machineHarnesses, initialHarnessModels, machineLoginMessage, sessionCapabilities } from "../sandbox/harnesses.js";
import { AccountModels, MODELS_TABLE, ModelProblem, checkItemEffort, chosenModel, standInModels } from "../account-models.js";
import { ACCOUNT_SECRETS_TABLE, ACCOUNT_SECRET_PROJECT, SecretNotFound, TooManySecrets, accountSecretNames, deleteAccountSecret, listedAccountSecrets, saveAccountSecret } from "../account-secrets.js";
import { publishAsksEveryTime, publishUnaskedProblem } from "../agent-publish.js";
import { PERSONAL_SERVERS_TABLE, ServerProblem, addServer, changeServer, cleanServerDefinition, cleanServerName, cleanUnasked, deleteServer, listedServer, readServers } from "../personal-servers.js";
import { refreshSecretRows } from "../signin/secret-rows.js";
import { MAX_SECRETS_PER_USER, SecretProblem, unavailableSecretName, validRequestedSecretName, cleanSecretName, cleanSecretScope, cleanSecretValue, commandSandbox, listedSecrets, saveRepoSecret, sealSecret } from "../repo-secrets.js";
import { criticSessionId } from "../factory/feature-ids.js";
import { reviewerAllowed } from "../factory/review.js";
import { DEFAULTS_TABLE, type DefaultsChange, DefaultsProblem, cleanDefaults, migrateDefaults, readDefaults, saveDefaults } from "../repository-defaults.js";
import type { ChatgptAccount, ListedSandbox } from "../sandbox/api.js";
import { ApprovalBook, type BookChange, type ServerApproval, sessionProjectKey } from "../server-approvals.js";
import { forgettingWords, personalServerReach } from "../server-question.js";
import { CHECKS_TABLE, ChecksProblem, cleanChecks, readChecks, saveChecks } from "../repository-checks.js";
import { NETWORK_TABLE, NetworkProblem, REQUESTS_TABLE, addEntry, cleanEntries, cleanEntry, dismissRequest, fileRequests, mayChangeNetwork, networkLimit, networkPresets, readNetwork, readRequests, saveNetwork, scanForHosts, scanPaths, unionHosts } from "../repository-network.js";
import { MAX_SETUP_COMMANDS, SetupCommandProblem, cleanSetupCommand, setupProjectKey } from "../setup-command.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { type SealedTokenAnswer, type SignInAnswer, problemOf, tokenSubject } from "../signin/directory.js";
import { SignInHolder, type StoredSignIn } from "../signin/holder.js";
import { getSignIns } from "../signin/index.js";
import { serverSealer } from "../signin/seal.js";
import { ownerOfAccount } from "./account-email.js";
import { recordTurnTokens, tokensOn, usesPlatformModel, type TokenReceipt, type HoldReport, type UsageLimits, USAGE_KEPT_DAYS, UsageBook, type UsageChange, DAY_MS, dayOf, hostedLimitsApply, isEmptyChange } from "../usage.js";
import { OFFLINE_REPOSITORY } from "../runner/egress.js";
import { HOSTED_OFFLINE_REPOSITORY } from "../sandbox/e2b/network.js";
import { readE2bSettings } from "../sandbox/e2b/config.js";
import { ENVIRONMENT_SCHEDULE_TABLE, ENVIRONMENT_TABLE, HOSTED } from "../environments.js";
import { buildResult, environmentsView, forgetEnvironments, nudge as environmentNudge, pushed as environmentPushed, rebuild as rebuildEnvironments, saveSchedule, sessionEnvironment, settingsChanged, tick as environmentTick, type EnvironmentHost } from "./user-environments.js";
import type { EnvironmentBuildOrigin, EnvironmentBuildResult } from "./internal.js";
import { customerDirectory } from "../billing/customer-index.js";
import { AccountCheckout, CheckoutBlocked, CheckoutEmailRequired, applyBillingEvent, billingTables, billingView, readBilling, setCapCents, reportOverage } from "../billing/account.js";
import { billing } from "../billing/config.js";
import { sessionWeight } from "../billing/meter.js";
import { hostedSizesForPlan, planAllowsSize } from "../billing/plans.js";
import type { BillingEvent } from "../billing/provider.js";
import type { BillingPeriod, BillingView } from "../contract.js";
import { type ReserveAnswer, type ReserveRequest, type SealedSecrets, type RequestedSecretSave, createSessionActor, isSessionGone, isDuplicateKey, secretsCaller, sessionActor } from "./internal.js";

export const DEFAULT_TITLE = "New agent";
const MAX_REPO_URL_CHARS = 300;
// The session normally acknowledges the next turn after its meter call (10 s timeout).
// If that launch dies first, reconcile its claim with the session after a minute.
const LAUNCH_LEASE_MS = 60_000;
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
	/** A retry that fires during a slow sweep waits for its batch checkpoints. */
	disconnectSweep?: Promise<void>;
	tokenGen: number;
	profile: UserProfile | null;
	/** False until a valid token of this user has been seen: until then the actor may be a stranger's doing. */
	reached: boolean;
	sessions: Map<string, SessionSummary>;
	launchUntil: Map<string, number>;
	/**
	 * The name of each session's outstanding launch claim (`internalAcquireRun`), what `internalReleaseRun`
	 * is given back: a generation from a counter stored with the actor (`launch_counter`), so two claims
	 * never share one, not even made in one millisecond or across a reload. Goes with the claim's lease.
	 */
	launchClaim: Map<string, number>;
	/** The last generation handed out, as `launch_counter` has it. */
	launchGen: number;
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
	githubWriting: Promise<void>;
	/** The models of the user's ChatGPT plan, as the table has them, and the listing that runs now. */
	models: AccountModels;
	/** The user's sandbox time and kept sandboxes, as the tables have them. */
	usage: UsageBook;
	/** The overage report under way (billing/account.ts `reportOverage`): one at a time. */
	overageReport: Promise<void>;
	checkout: AccountCheckout;
	/** The user's sandboxes as the provider last listed them, and when; null until it was asked. */
	listed: { at: number; sandboxes: ListedSandbox[] } | null;
	/** The user's work items, the turn queue and its slots (user-items.ts), as the tables have them. */
	items: ItemsState;
	machines: Map<string, MachineSummary>;
}

interface SignInCtx {
	client(): unknown;
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
					revoke: hooks.revoke,
					ownerOf: (account) => ownerOfAccount(c, account),
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
function modelInput<T>(pick: () => T, refusalCode?: "bad_input"): T {
	try {
		return pick();
	} catch (error) {
		if (error instanceof ModelProblem) throw new UserError(error.message, { code: refusalCode ?? error.code });
		throw error;
	}
}

interface UserCtx {
	vars: UserVars;
	db: RawAccess;
	broadcast(name: string, ...args: unknown[]): void;
}

function sessionList(vars: UserVars): SessionSummary[] {
	return listedSessions([...vars.sessions.values()]).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
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

/** All reports, including a refresh at the ceiling, respect an outstanding claim for the next turn. */
async function storeReport(c: UserCtx, summary: SessionSummary, checkedAt = 0): Promise<void> {
	const known = c.vars.sessions.get(summary.id);
	if (!known || summary.turns < known.turns) return;
	const until = c.vars.launchUntil.get(summary.id);
	if (until !== undefined && until > checkedAt && summary.turns === known.turns) {
		summary = { ...summary, status: "starting" };
	} else {
		c.vars.launchUntil.delete(summary.id);
		c.vars.launchClaim.delete(summary.id);
	}
	c.vars.sessions.set(summary.id, summary);
	await c.db.execute("UPDATE sessions SET summary = ?, launch_until = ? WHERE id = ?", JSON.stringify(summary), c.vars.launchUntil.get(summary.id) ?? null, summary.id);
	broadcastSessions(c);
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

/** How many connections may be begun and left unfinished. */
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
async function setupRow(db: RawAccess, project: string) {
	const [row] = await db.execute<{ command: string; updated_at: number; snapshot_connection: number | null }>(
		"SELECT command, updated_at, snapshot_connection FROM setup_command WHERE project = ?", project);
	return row;
}
async function readSetup(db: RawAccess, project: string): Promise<RepositorySetup> {
	const row = await setupRow(db, project);
	return { command: row?.command ?? "", updatedAt: row?.updated_at ?? null, timeoutMs: config.setupTimeoutMs };
}

async function dropHostedSnapshots(uid: string, repo?: string) {
	if ((config.snapshots && config.sandbox === "docker") || (config.e2bSnapshots && config.sandbox === "e2b")) await (await getLayer()).sandboxes.dropSnapshots?.(uid, repo).catch(() => {
		console.warn("[wlp] snapshot cleanup deferred");
	});
}

/** Saves a command that was cleaned already, in place of the project's earlier one; "" removes the row. */
async function saveSetup(c: UserCtx, uid: string, project: string, label: string, command: string): Promise<RepositorySetup> {
	const previous = await readSetup(c.db, project);
	if (previous.command === command) return previous;
	if (command === "") {
		await c.db.execute("DELETE FROM setup_command WHERE project = ?", project);
	} else {
		await c.db.execute(
			"INSERT INTO setup_command (project, label, command, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, command = excluded.command, snapshot_connection = NULL, updated_at = MAX(updated_at + 1, excluded.updated_at)",
			project,
			label,
			command,
			Date.now(),
		);
		// Somebody who saves for one repository after another leaves no more than this many rows.
		await c.db.execute("DELETE FROM setup_command WHERE project NOT IN (SELECT project FROM setup_command ORDER BY updated_at DESC LIMIT ?)", MAX_SETUP_COMMANDS);
	}
	// The command is the user's text and may hold what they would not want in a log: only its length is said.
	await dropHostedSnapshots(uid, project.slice("github:".length));
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

/** The profile a list of secrets is asked for, as this deployment's sandbox layer describes it. */
async function secretProfile(id: unknown): Promise<SandboxProfile> {
	const { sandboxes } = await getLayer();
	const profile = sandboxes.profiles().find((item) => item.id === id);
	if (!profile) throw new UserError("Choose one of the listed sandboxes.", { code: "bad_input" });
	return profile;
}

/** Check both stores by name alone, including secrets withheld from this session. */
async function requestedSecretConflict(db: Pick<RawAccess, "execute">, project: string | null, name: string, reader: "agent" | "person" = "agent"): Promise<string | null> {
	const [row] = await db.execute<{ source: string }>(
		"SELECT 'repository' AS source FROM repo_secret WHERE project = ? AND name = ? UNION ALL SELECT 'account' FROM account_secret WHERE name = ? LIMIT 1",
		project, name, name,
	);
	if (!row) return null;
	return reader === "agent"
		? unavailableSecretName(name)
		: `${name} already exists for this ${row.source}, so nothing was saved. To let agents use it, change its scope under Secrets.`;
}

/**
 * A repository's secrets as a client may see them: name, scope, when each was last changed, and what
 * it reaches in a sandbox of `profile`. The value's column is not read, so no value can be in the answer.
 */
async function listSecrets(db: RawAccess, project: string, profile: SandboxProfile): Promise<RepositorySecrets> {
	const rows = await db.execute<{ name: string; scope: string; updated_at: number }>("SELECT name, scope, updated_at FROM repo_secret WHERE project = ? ORDER BY name", project);
	const listed = listedSecrets(rows, profile);
	// A secret of the account under the same name is not used in this repository's sessions: the list says where that is so.
	const account = rows.length === 0 ? new Set<string>() : await accountSecretNames(db);
	return account.size === 0 ? listed : { ...listed, secrets: listed.secrets.map((secret) => (account.has(secret.name) ? { ...secret, account: true } : secret)) };
}

function checkSecretLimit(result: Awaited<ReturnType<typeof saveRepoSecret>>): void {
	if (result === "repository_full") throw new UserError(`A repository can have at most ${MAX_SECRETS_PER_REPOSITORY} secrets. Delete one first.`, { code: "too_many_secrets" });
	if (result === "account_full") throw new UserError(`You have ${MAX_SECRETS_PER_USER.toLocaleString("en-US")} secrets saved over all your repositories, which is the limit. Delete one first.`, { code: "too_many_secrets" });
}

/**
 * Saves a secret whose name, value and scope were cleaned already. With a value: a new secret, or a
 * new value for the one of that name, sealed for this user, repository and name before it is stored.
 * Without: the scope of the one of that name.
 */
async function saveSecret(c: UserCtx, uid: string, project: string, label: string, name: string, value: string | undefined, scope: SecretScope): Promise<void> {
	let saved: "kept" | "new" | "replaced" = "kept";
	if (value === undefined) {
		const [found] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM repo_secret WHERE project = ? AND name = ?", project, name);
		if ((found?.n ?? 0) === 0) throw new UserError(`No secret named ${name} is saved for this repository.`, { code: "secret_not_found" });
		await c.db.execute("UPDATE repo_secret SET scope = ?, updated_at = ? WHERE project = ? AND name = ?", scope, Date.now(), project, name);
	} else {
		// The limits and the write are one conditional statement: saves at the same moment cannot pass a limit together.
		const result = await saveRepoSecret(c.db, { uid, project, label, name, sealed: sealSecret(serverSealer(), uid, project, name, value), scope, now: Date.now() });
		checkSecretLimit(result);
		saved = result === "replaced" ? "replaced" : "new";
	}
	// The name, never anything of the value: not its length either.
	console.log(`[wlp] secret.saved uid=${uid} project=${project} name=${name} scope=${scope} value=${saved}`);
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
function repositoryIdOf(project: string): GithubId | null {
	const id = /^github:([1-9][0-9]{0,18})$/.exec(project)?.[1];
	return githubId(id);
}

/**
 * "owner/name" of a repository without asking GitHub: as the newest session on it has it, and with no
 * session, as it was called when something was last saved for it. "" when nothing names it.
 */
async function repositoryName(c: UserCtx, repositoryId: GithubId, project: string): Promise<string> {
	const known = repositoryLabel(c.vars, repositoryId);
	if (known !== "") return known;
	const [row] = await c.db.execute<{ label: string }>(
		"SELECT label FROM (SELECT label, updated_at FROM repository_defaults WHERE project = ? UNION ALL SELECT label, updated_at FROM setup_command WHERE project = ? UNION ALL SELECT label, updated_at FROM repository_checks WHERE project = ? UNION ALL SELECT label, updated_at FROM repo_secret WHERE project = ? UNION ALL SELECT label, updated_at FROM repository_network WHERE project = ?) WHERE label != '' ORDER BY updated_at DESC LIMIT 1",
		project,
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
async function labelFor(c: UserCtx, repositoryId: GithubId, project: string): Promise<string> {
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
async function repositoryView(c: UserCtx, repositoryId: GithubId, project: string): Promise<RepositoryView> {
	const defaults = await readDefaults(c.db, project);
	const [setup] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM setup_command WHERE project = ?", project);
	const [secrets] = await c.db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM repo_secret WHERE project = ?", project);
	const { checks } = await readChecks(c.db, project);
	const network = await readNetwork(c.db, project);
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
		// For all the repository's sessions, of either Docker profile: a hardened one's Windlass data may be its own.
		forgetting: forgettingWords({ dataInSandbox: sandboxes.sessionsLiveInSandbox, hardenedOwnData: (await sandboxes.privateSessionData?.("docker-hardened")) === true }),
		saved: { setup: (setup?.n ?? 0) > 0, secrets: secrets?.n ?? 0, checks: checks.length, network: network.entries.length },
	};
}

/**
 * What the deployment's hosted sandboxes reach whatever a repository's list says (sandbox/e2b/network.ts):
 * null where hosted sandboxes have no list of hosts (not on E2B).
 */
async function hostedNetwork(): Promise<{ mode: EgressMode; hosts: string[] } | null> {
	const { sandboxes } = await getLayer();
	const hosts = sandboxes.allowedHosts?.();
	const mode = sandboxes.egress?.();
	return hosts === undefined || mode === undefined ? null : { mode, hosts: [...hosts] };
}

/** A repository's network list as its settings show it. */
async function networkView(c: UserCtx, project: string): Promise<RepositoryNetwork> {
	const hosted = await hostedNetwork();
	const saved = await readNetwork(c.db, project);
	const deploymentHosts = hosted?.mode === "restricted" ? hosted.hosts : [];
	return { ...saved, requests: await readRequests(c.db, project, [...saved.hosts, ...deploymentHosts]), presets: networkPresets(), hosted, limit: networkLimit(deploymentHosts) };
}

/** The deployment's hosts a repository's list is held against: only where the list applies, in `restricted`. */
async function deploymentHostsForLimit(): Promise<string[]> {
	const hosted = await hostedNetwork();
	return hosted?.mode === "restricted" ? hosted.hosts : [];
}

function networkInput<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		if (error instanceof NetworkProblem) throw new UserError(error.message, { code: "bad_network" });
		throw error;
	}
}

/** A name a client sent, for a log line: what is printable of it. */
const logged = (text: string) => text.replace(/[^\x21-\x7e]/g, "?");

// ---------------------------------------------------------------------------------------------
// The account's settings: defaults, the user's own MCP servers, and their secrets
// ---------------------------------------------------------------------------------------------

/** The account's settings as their page shows them. No value of a secret is read. */
async function accountView(db: RawAccess): Promise<AccountSettings> {
	const defaults = await readAccountDefaults(db);
	const lastStart = await readLastStart(db);
	const servers = await readServers(db);
	const secrets = await accountSecretNames(db);
	const { sandboxes } = await getLayer();
	return {
		defaults,
		lastStart,
		servers: servers.map((server) => listedServer(server, secrets)),
		serverReach: personalServerReach(sandboxes.profiles(), sandboxes.egress?.()),
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
	schedule: {
		list(): Promise<{ action: string; runAt: number }[]>;
		at(at: number, action: string): Promise<unknown>;
	};
	key: string[];
	log: { warn(entry: unknown): void };
	keepAwake?<T>(promise: Promise<T>): Promise<T>;
}

type UsageEntryRow = { started_at: number | null; day: number; session: string; hold: string; kind: string; seconds: number; weight: number | null; at: number; note: string | null };
type UsageHoldRow = { id: string; session: string; day: number; seconds: number; weight: number | null; started_at: number; expires_at: number };

/** The book as the tables have it: the open holds, the places, and the entries of the days the usage page shows. */
/** A work item's reviewer shares its builder's place among the kept sandboxes (`UsageBook.sharing`): an item counts as one. */
export function itemSharing(sessions: ReadonlyMap<string, SessionSummary>): (session: string) => string | undefined {
	return (session) => {
		const item = sessions.get(session)?.item;
		if (item?.role !== "reviewer") return undefined;
		for (const other of sessions.values()) if (other.item?.id === item.id && other.item.role !== "reviewer") return other.id;
		return undefined;
	};
}

export async function readUsage(db: RawAccess, limits: UsageLimits, sessions: ReadonlyMap<string, SessionSummary>): Promise<UsageBook> {
	const today = dayOf(Date.now());
	// A hold whose entry was written and whose own row was then not removed, because the server stopped in between, is closed.
	await db.execute("DELETE FROM usage_hold WHERE id IN (SELECT hold FROM usage_entry)");
	await db.execute("DELETE FROM usage_start WHERE day < ?", today - USAGE_KEPT_DAYS);
	await db.execute("DELETE FROM usage_entry WHERE day < ?", today - USAGE_KEPT_DAYS);
	await db.execute("DELETE FROM token_usage WHERE day < ?", today - USAGE_KEPT_DAYS);
	// Reload the retained ledger, including both sides of a subscription renewal.
	const since = today - (limits.plan ? USAGE_KEPT_DAYS : USAGE_HISTORY_DAYS);
	const entries = await db.execute<UsageEntryRow>("SELECT e.*, s.started_at FROM usage_entry e LEFT JOIN usage_start s USING (hold) WHERE e.day > ? ORDER BY e.id", since);
	const holds = await db.execute<UsageHoldRow>("SELECT id, session, day, seconds, weight, started_at, expires_at FROM usage_hold");
	const kept = await db.execute<{ session: string; since: number }>("SELECT session, since FROM kept_sandbox");
	const book = new UsageBook(limits, {
		entries: entries.map((row) => ({ day: row.day, startedAt: row.started_at ?? undefined, session: row.session, hold: row.hold, kind: row.kind === "unreported" || row.kind === "corrected" ? row.kind : "used", seconds: row.seconds, weight: row.weight, at: row.at, note: row.note })),
		holds: holds.map((row) => ({ id: row.id, session: row.session, day: row.day, seconds: row.seconds, weight: row.weight, startedAt: row.started_at, expiresAt: row.expires_at })),
		kept,
	});
	book.sharing = itemSharing(sessions);
	book.weightOf = (session) => sessionWeight(sessions.get(session));
	const at = Date.now();
	book.noteModelTokens(at, await tokensOn(db, at));
	return book;
}

/**
 * Makes a step in the book and writes what it did to the tables before the caller answers. The book
 * changes first, in one synchronous step, so two calls cannot both decide from the same numbers; if
 * the tables cannot be written, the book is read from them again and the call fails: what is counted
 * is what is stored. An entry is written before its hold's row is removed, and a hold is closed once
 * (an entry's `hold` is unique), so a server that stops in between counts nothing twice.
 */
/**
 * For scripts/e2e.ts only, and only with the fake layer (WLP_SANDBOX=fake), as the fake layer's own
 * settings are (sandbox-fake.ts): WLP_FAKE_RESERVE_FAULT, read once, plays the reply between a session
 * and this actor going wrong in `internalReserve`. Parts, comma-separated: `lose:<n>` has the next n
 * reserves that start something (`fresh`) do their work and commit, then throw, which is what a reply
 * lost on its way back looks like to the session; `lose-renewal:<n>` the same for the next n renewals;
 * `delay:<ms>` delays fresh reserves; `down:<ms>` refuses every reserve for that long from the first renewal on (this actor unreachable).
 * In this process's memory: a restart starts it again.
 */
const reserveFault = ((): { fresh: number; renewal: number; delayMs: number; downMs: number; downUntil: number | null } | null => {
	const spec = process.env.WLP_FAKE_RESERVE_FAULT;
	if (!spec || config.sandbox !== "fake") return null;
	const fault = { fresh: 0, renewal: 0, delayMs: 0, downMs: 0, downUntil: null };
	for (const part of spec.split(",")) {
		const [kind, value] = part.trim().split(":");
		const n = Number(value);
		if (!Number.isSafeInteger(n) || n < 0) throw new Error(`WLP_FAKE_RESERVE_FAULT: "${part}" is not lose:<n>, lose-renewal:<n>, delay:<ms> or down:<ms>`);
		if (kind === "lose") fault.fresh = n;
		else if (kind === "lose-renewal") fault.renewal = n;
		else if (kind === "delay") fault.delayMs = n;
		else if (kind === "down") fault.downMs = n;
		else throw new Error(`WLP_FAKE_RESERVE_FAULT: "${part}" is not lose:<n>, lose-renewal:<n>, delay:<ms> or down:<ms>`);
	}
	return fault;
})();

async function changeUsage<T extends { change: UsageChange }>(c: UsageCtx, step: (book: UsageBook) => T): Promise<T> {
	// A plan's limits change with the clock (a grace period that ends): the book decides with them as they are now.
	Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
	const done = step(c.vars.usage);
	const { change } = done;
	if (isEmptyChange(change)) return done;
	try {
		for (const entry of change.entries) {
			if (entry.startedAt !== undefined) await c.db.execute("INSERT OR IGNORE INTO usage_start (hold, day, started_at) VALUES (?, ?, ?)", entry.hold, entry.day, entry.startedAt);
			await c.db.execute("INSERT OR IGNORE INTO usage_entry (day, session, hold, kind, seconds, weight, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", entry.day, entry.session, entry.hold, entry.kind, entry.seconds, entry.weight!, entry.at, entry.note);
		}
		for (const id of change.closed) await c.db.execute("DELETE FROM usage_hold WHERE id = ?", id);
		for (const hold of change.opened) {
			await c.db.execute("INSERT OR REPLACE INTO usage_hold (session, id, day, seconds, weight, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", hold.session, hold.id, hold.day, hold.seconds, hold.weight!, hold.startedAt, hold.expiresAt);
		}
		for (const session of change.released) await c.db.execute("DELETE FROM kept_sandbox WHERE session = ?", session);
		for (const claim of change.kept) await c.db.execute("INSERT OR REPLACE INTO kept_sandbox (session, since) VALUES (?, ?)", claim.session, claim.since);
	} catch (error) {
		const restored = await readUsage(c.db, c.vars.usage.limits, c.vars.sessions).catch(() => c.vars.usage);
		const now = Date.now();
		restored.noteModelTokens(now, c.vars.usage.modelTokens(now));
		c.vars.usage = restored;
		throw error;
	}
	// One line per entry: what was counted, for whoever reads the log beside the provider's bill.
	for (const entry of change.entries) {
		console.log(`[wlp] usage.counted uid=${c.key[0]} session=${entry.session} hold=${entry.hold} kind=${entry.kind} seconds=${entry.seconds}${entry.note === null ? "" : `: ${entry.note}`}`);
	}
	c.broadcast("usage", c.vars.usage.numbers(Date.now()));
	if (change.entries.length > 0) queueOverageReport(c);
	return done;
}

/**
 * Tells the payment provider of overage it has not been told of (billing/account.ts), one report at a time, after the
 * request that counted it has been answered. The actor also drains the durable outbox on wake and scheduled retry.
 */
function queueOverageReport(c: UsageCtx): void {
	const settings = billing();
	const state = c.vars.items.limits.billing;
	if (!settings || !state?.customerId) return;
	const now = Date.now();
	const { includedSeconds } = accountLimits(c.vars.items.limits, now).usage;
	c.vars.overageReport = c.vars.overageReport.then(async () => {
		try {
			const sent = await reportOverage(c.db, settings.provider, {
				uid: c.key[0]!, state, now, usedSeconds: period => c.vars.usage.usedInPeriod(period), includedSeconds,
			});
			for (const report of sent) console.log(`[wlp] billing.usage_reported uid=${c.key[0]} event=${report.eventId}`);
		} catch {
			console.warn(`[wlp] billing.usage_report_failed uid=${c.key[0]}`);
			const scheduled = await c.schedule.list();
			if (!scheduled.some(job => job.action === "internalRetryOverage" && job.runAt > Date.now())) {
				await c.schedule.at(Date.now() + 15 * 60_000, "internalRetryOverage");
			}
		}
	}).catch(() => { console.warn(`[wlp] billing.retry_schedule_failed uid=${c.key[0]}`); });
	void c.keepAwake?.(c.vars.overageReport);
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
		const found = await sandboxes.list(c.key[0]!);
		// A sandbox whose session this user no longer has (deleted, or lost with an older deployment) is an orphan: nobody
		// can use or free it from a page, so it is removed, and it holds no place meanwhile. A session's own sandboxes are
		// the session's to sweep (agent-session.ts `sweepSandboxes`). Reviewers are among the sessions, hidden or not.
		const orphans = found.filter((sandbox) => sandbox.sessionId !== "" && !c.vars.sessions.has(sandbox.sessionId));
		const listed = found.filter((sandbox) => !orphans.includes(sandbox));
		for (const orphan of orphans) {
			await sandboxes.destroy(orphan.id).then(
				() => console.warn(`[wlp] sandbox.orphan_removed uid=${c.key[0]} id=${orphan.id} session=${orphan.sessionId} state=${orphan.state}: its session no longer exists`),
				(error: unknown) => c.log.warn({ msg: "an orphaned sandbox could not be removed", id: orphan.id, session: orphan.sessionId, error: String(error) }),
			);
		}
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

function billingOn() {
	const settings = billing();
	if (!settings) throw new UserError("This deployment has no plans or billing.", { code: "billing_off" });
	return settings;
}

function billingOrigin(raw: unknown): string {
	const origin = typeof raw === "string" ? raw.replace(/\/+$/, "") : "";
	if (!config.origins.includes(origin)) throw new UserError("Billing can only be opened from the web app's own address.", { code: "origin_not_allowed" });
	return origin;
}

async function billingAnswer(c: UsageCtx): Promise<BillingView> {
	const state = c.vars.items.limits.billing;
	if (!billing() || !state) return { enabled: false };
	const now = Date.now();
	Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
	return billingView(c.db, state, c.vars.usage.numbers(now).hosted ?? null, now);
}

/** The plan's limits changed: the book, the queue and every open page hear of it. */
function billingChanged(c: UsageCtx & Parameters<typeof queueChanged>[0]): void {
	Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
	c.broadcast("usage", c.vars.usage.numbers(Date.now()));
	queueChanged(c);
	queueOverageReport(c);
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
				// A work item's reviewer is named for its item, and shares its builder's place (`itemSharing`).
				title: session ? (session.item?.role === "reviewer" ? `Reviewer of “${session.title}”` : session.title) : null,
				...(session?.item && { item: { id: session.item.id, role: session.item.role ?? "builder" } }),
				...(book.shares(claim.session) && { sharesPlace: true as const }),
				state: listed.get(claim.session)?.state ?? (session && session.sandbox !== "none" ? session.sandbox : ("starting" as const)),
				usedAt: session?.updatedAt ?? null,
				busy: session !== undefined && session.status !== "idle",
				repository: session?.repository ? `${session.repository.owner}/${session.repository.name}` : null,
				pushed: Boolean(session?.pullRequest),
				...(session?.hostedSize && { hostedSize: session.hostedSize }),
			};
		})
		.sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || (a.sessionId < b.sessionId ? -1 : 1));
	return {
		...book.numbers(now),
		usedModelTokens: book.modelTokens(now),
		factoryLimits: accountLimits(c.vars.items.limits).factory,
		today: book.today(now).map((row) => {
			const session = c.vars.sessions.get(row.sessionId);
			return { ...row, title: session?.title ?? null, ...(session?.hostedSize && { hostedSize: session.hostedSize }) };
		}),
		days: book.days(now),
		kept,
		price: layer.sandboxes.price(),
		...((() => { const sizes = sizesOf(c, layer); return sizes.length > 1 ? { hostedSizes: sizes } : {}; })()),
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
/** The hosted sizes offered to this account, with their prices. */
function sizesOf(c: UserCtx, layer: Awaited<ReturnType<typeof getLayer>>): HostedSizeOption[] {
	return hostedSizesForPlan(layer.sandboxes.sizes?.() ?? [], accountLimits(c.vars.items.limits).plan);
}

/** A replacement sandbox can be smaller than the sandbox the account kept through a downgrade. */
function clampedSandboxSize(c: UserCtx, size: HostedSize | undefined): HostedSize | undefined {
	const plan = accountLimits(c.vars.items.limits).plan;
	if (!plan || !size || planAllowsSize(plan, size)) return undefined;
	return plan.sizes.at(-1);
}

/**
 * The size of a hosted session's sandboxes: the one asked for, else the repository's saved size, else small for a
 * person's agent and standard for a work item's (contract.ts). One the layer does not offer is the largest it
 * offers below it. Undefined where the layer has one size.
 */
async function sessionHostedSize(c: CreateCtx, asked: unknown, project: string | null, item: Parameters<MakeSession>[4] | undefined): Promise<HostedSize | undefined> {
	const layer = await getLayer();
	if (asked !== undefined && asked !== null && !isHostedSize(asked)) throw new UserError(`Choose a hosted size: ${HOSTED_SIZES.join(", ")}.`, { code: "bad_input" });
	// Where the deployment has billing, the plan's sizes only (billing/plans.ts): Free has no large.
	const plan = accountLimits(c.vars.items.limits).plan;
	if (plan && isHostedSize(asked) && !planAllowsSize(plan, asked)) throw new UserError(`${asked.charAt(0).toUpperCase()}${asked.slice(1)} sandboxes are on Pro. Choose a smaller size, or upgrade in Settings.`, { code: "bad_input" });
	const listed = layer.sandboxes.sizes?.() ?? [];
	const offered = hostedSizesForPlan(listed, plan).map(size => size.id);
	if (listed.length > 0 && offered.length === 0) throw new UserError("No hosted sandbox size is available on your plan.", { code: "bad_input" });
	if (listed.length <= 1) return undefined;
	const wanted = (asked as HostedSize | undefined) ?? item?.hostedSize ?? (project ? (await readDefaults(c.db, project)).hostedSize : null) ?? (item ? ITEM_HOSTED_SIZE : SESSION_HOSTED_SIZE);
	return [...offered].reverse().find((size) => HOSTED_SIZES.indexOf(size) <= HOSTED_SIZES.indexOf(wanted)) ?? offered[0];
}

async function makeSession(c: CreateCtx, profile: UserProfile, input: CreateSessionInput, submission: Submission | null, item?: Parameters<MakeSession>[4], build?: EnvironmentBuildOrigin): Promise<SessionSummary> {
	// Builds of prepared environments start from the actor's own alarm, with no caller: they need the profile kept.
	if (!build && !c.vars.profile) await rememberProfile(c, profile);
	const place = launchPlace(input.place);
	if (input.size !== undefined && ![1, 2, 4].includes(input.size))
		throw new UserError("Choose a sandbox size of 1, 2 or 4 slots.", { code: "bad_input" });
	const size = item?.size ?? input.size ?? 1;
	const harness = input.harness === undefined ? "windlass" : input.harness;
	if (knownHarness(harness) === null) throw new UserError("Choose an available harness.", { code: "bad_input" });
	if (harness !== "windlass") {
		if (item?.role === "reviewer") throw new UserError("A work item's reviewer runs only with Windlass.", { code: "bad_input" });
		const notForItems = item ? itemHarnessProblem(harness) : null;
		if (notForItems) throw new UserError(notForItems, { code: "bad_input" });
		if (place.kind !== "machine") throw new UserError(`${machineHarnesses[harness].name} runs only on a machine of yours.`, { code: "bad_input" });
		if (input.profile !== "docker-hardened" && !(harness === "codex" && input.profile === "docker-windlass-sandbox")) throw new UserError(`${machineHarnesses[harness].name} requires the docker-hardened profile.`, { code: "bad_input" });
		const profileProblem = item ? itemProfileProblem(harness, input.profile) : null;
		if (profileProblem) throw new UserError(profileProblem, { code: "bad_input" });
		// Its publish comes over MCP, which any process in the container may reach (platform-tools.ts): it asks every time.
		if (input.publishUnasked) throw new UserError(publishAsksEveryTime(harnessName(harness)), { code: "bad_input" });
	}
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
		if (!isGithubId(id) || (branch !== undefined && branch !== null && !isBranchName(branch))) throw new UserError("Choose one of the listed repositories and one of its branches.", { code: "bad_input" });
		const app = requireGithub();
		try {
			const connection = requireConnection(c);
			const { installation, repository } = item?.issue
				? await resolveBoundRepository(app, connection, id, item.issue.installationId, "read")
				: await resolveRepository(app, connection, id, "read");
			repo = {
				provider: "github",
				id: repository.id,
				owner: repository.owner,
				name: repository.name,
				branch: branch ?? repository.defaultBranch,
				private: repository.private,
				url: app.repositoryUrl(repository.owner, repository.name),
				installationId: installation.id,
				...(item?.issue && { closesIssue: item.issue.number }),
			};
			repoUrl = app.cloneUrl(repository.owner, repository.name);
		} catch (error) {
			throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
		}
	}

	let summary: SessionSummary;
	try {
		const machine = place.kind === "machine" ? await launchMachineProfiles(c.db, place.machineId) : null;
		if (size > 1 && !machine?.slots) throw new UserError("Choose a machine reporting slots for a large sandbox.", { code: "bad_input" });
		if (repoUrl && machine?.egress === "none") throw new UserError(OFFLINE_REPOSITORY, { code: "bad_input" });
		if (repoUrl && place.kind === "hosted" && (await getLayer()).sandboxes.egress?.() === "none") throw new UserError(HOSTED_OFFLINE_REPOSITORY, { code: "bad_input" });
		const offered = machine?.harnesses?.find(entry => entry.id === harness);
		if (harness !== "windlass" && !offered) throw new UserError(`This machine does not offer ${machineHarnesses[harness].name}.`, { code: "bad_input" });
		// A work item is not watched: one filed on a machine whose agent is not known to be signed in would only fail at its first turn.
		const signedOut = item && harness !== "windlass" && offered ? itemSignInMessage(machineHarnesses[harness], machine?.name ?? "your machine", offered.signIn) : null;
		if (signedOut) throw new UserError(signedOut, { code: "harness_signed_out" });
		// Where the sign-in method decides how an item counts its tokens (Codex), it is kept with the item, and refused when it is not one items run with.
		const itemSignIn = item && harness !== "windlass" && machineHarnesses[harness].itemTokens === "sign-in" ? offered?.method : undefined;
		const methodProblem = item && harness !== "windlass" ? itemSignInMethodProblem(machineHarnesses[harness], machine?.name ?? "your machine", offered?.method) : null;
		if (methodProblem) throw new UserError(methodProblem, { code: "bad_input" });
		const hostedSize = place.kind === "hosted" ? await sessionHostedSize(c, input.hostedSize, repo ? setupKeyOf(repo.id) : null, item) : undefined;
		const profiles = machine ? machine.profiles : (await getLayer()).sandboxes.profiles();
		const chosen = profiles.find((candidate) => candidate.id === input.profile);
		if (!chosen) throw new UserError("That sandbox does not exist.", { code: "bad_profile" });
		if (!chosen.available) {
			throw new UserError(`${chosen.name} cannot be chosen yet. ${chosen.unavailableReason ?? ""}`.trim(), { code: "profile_unavailable" });
		}
		// Letting the agent publish unasked is for sandboxes whose commands cannot ask in its name.
		const unaskedProblem = repo && input.publishUnasked === true ? publishUnaskedProblem(commandSandbox(chosen)) : null;
		if (unaskedProblem !== null) throw new UserError(unaskedProblem, { code: "bad_input" });
		const options = offered?.optionsDigest && place.kind === "machine" ? await machineCatalog(c, place.machineId, offered.id, offered.optionsDigest) : undefined;
		if (offered?.optionsDigest && !options) throw new UserError("The machine’s model list changed. Choose the model again.", { code: "bad_input" });
		if (harness === "codex" && chosen.id === "docker-windlass-sandbox" && !offered?.modes?.includes("workspace-write"))
			throw new UserError(offered?.modeReason ?? innerModesReason, {code:"bad_input"});
		const modes = initialSessionModes(chosen.id, harness, !!item, harness === "codex" ? codexModes(chosen.id, offered?.modes ?? []) : options?.modes);
		if (input.mode !== undefined) {
			if (typeof input.mode !== "string" || !input.mode.trim() || ((harness === "windlass" || harness === "codex") && !modes.availableModes.some(m => m.id === input.mode))) throw new UserError("Choose a mode offered by this agent.", { code: "bad_input" });
			modes.mode = input.mode;
		}
		// A build runs no agent, so it asks for no model list (and needs no sign-in): the stand-in names one.
		const models = harness !== "windlass" ? initialHarnessModels(options ?? undefined) : build ? standInModels("demo") : await modelsOf(c, profile.demo);
		const model = modelInput(() => chosenModel(models, input.model), options ? "bad_input" : undefined);
		// An item's effort runs every turn, unwatched: only one its agent reported is taken.
		if (item?.effort !== undefined) modelInput(() => checkItemEffort(models, model, item.effort, harness !== "windlass"));

		// Saved before the session exists, so that its first sandbox finds it. It stays if the session cannot be made.
		if (repo && setupCommand !== null) await saveSetup(c, profile.uid, setupKeyOf(repo.id), `${repo.owner}/${repo.name}`, setupCommand);

		const now = Date.now();
		summary = {
			id: item?.sessionId ?? `s_${randomBytes(8).toString("hex")}`,
			title: givenTitle ?? DEFAULT_TITLE,
			place,
			harness,
			capabilities: sessionCapabilities(harness),
			profile: chosen.id,
			...(hostedSize && { hostedSize }),
			...modes,
			...(options && { harnessModels: models }),
			model,
			repoUrl,
			...(repo ? { repository: { provider: repo.provider, id: repo.id, owner: repo.owner, name: repo.name, branch: repo.branch, private: repo.private, url: repo.url }, pullRequest: null, publishUnasked: input.publishUnasked === true } : {}),
			createdAt: now,
			updatedAt: now,
			status: "idle",
			turns: 0,
			lastOutcome: null,
			sandbox: "none",
			...(item ? { item: { id: item.itemId, role: item.role, ...(item.planCritic && { planCritic: true as const }), ...(itemSignIn && { signIn: itemSignIn }) } } : {}),
			...(build && { environmentBuild: true as const }),
		};
		await createSessionActor(c, profile.uid, summary.id, {
			...(item ? { origin: { kind: "item" as const, itemId: item.itemId, role: item.role, ...(item.planCritic && { planCritic: true as const }), ...(item.owns && { owns: item.owns }), ...(item.childBranch && { childBranch: item.childBranch }), ...(size > 1 && { size }), ...(item.effort && { effort: item.effort }), ...(itemSignIn && { signIn: itemSignIn }) } } : {}),
			...(!item && size > 1 && { size }),
			...(build && { environmentBuild: build }),
			...(hostedSize && { hostedSize }),
			title: summary.title,
			titleIsTyped: !item && givenTitle !== null,
			place: summary.place,
			harness,
			...(machine ? { machineName: machine.name } : {}),
			profile: summary.profile,
			// An item's session takes its profile's mode for its agent in the actor (`itemModeOf`): none is passed for it.
			...(!item && { mode: harness === "codex" ? modes.mode : input.mode }),
			...(harness === "codex" && {codexModes:modes.availableModes}),
			...(options && {harnessOptions:options}),
			model,
			repoUrl,
			repo,
			publishUnasked: repo !== null && input.publishUnasked === true,
			demo: harness === "windlass" && profile.demo,
			createdAt: now,
		}).catch((error: unknown) => {
			// An item's session has an id derived from its item's: one that exists is the one an earlier try made.
			if (!item || !isDuplicateKey(error)) throw error;
		});
	} catch (error) {
		throw clientError(c.log, error, "The agent could not be created. Try again.");
	}

	// In one step with the session: from here a `createSession` with this key answers with it.
	c.vars.sessions.set(summary.id, summary);
	if (submission) c.vars.created.set(submission.key, { ...submission, id: summary.id });
	await storeSession(c, summary, submission);
	broadcastSessions(c);
	// What the next agent starts on. An agent the user started, not a work item's: one that cannot be remembered is still made.
	if (!item && !build) {
		await recordLastStart(c.db, { place: summary.place, harness: summary.harness ?? "windlass", mode: summary.mode, startedAt: summary.createdAt }).catch((error: unknown) => {
			c.log.error({ msg: "the last start could not be remembered", error: String(error) });
		});
	}
	return summary;
}

/**
 * The models a subtask's agent may choose, by the lists `makeSession` holds a session to: the account's
 * for Windlass, each machine harness's catalog (or only its default where its runner reported none).
 * A list that cannot be read is left out, and the child's creation judges it. Each is read at once.
 */
export async function agentModels(c: CreateCtx & { key: string[] }): Promise<AgentModels> {
	const profile = c.vars.profile;
	const harnesses = [...c.vars.machines.values()].flatMap(m => (m.harnesses ?? []).filter(h => machineHarnesses[h.id]?.subtasks).map(h => ({ m, h })));
	const [windlass, catalogs] = await Promise.all([
		profile ? modelsOf(c, profile.demo).catch(() => null) : null,
		Promise.all(harnesses.map(({ m, h }) => h.optionsDigest ? machineCatalog(c, m.machineId, h.id, h.optionsDigest).catch(() => null) : undefined)),
	]);
	const machines: NonNullable<AgentModels["machines"]> = {};
	harnesses.forEach(({ m, h }, i) => {
		const options = catalogs[i];
		if (options !== null) (machines[m.machineId] ??= {})[h.id] = initialHarnessModels(options);
	});
	return { windlass, machines };
}

/** When each user actor's environment alarm is set for, while it is awake. */
const environmentAlarms = new WeakMap<UserVars, number>();

/** An action's context, as prepared environments need it: sessions can be made and the actor woken later. */
interface EnvironmentCtx extends CreateCtx {
	schedule: { at(at: number, action: string, ...args: unknown[]): Promise<unknown> };
}

/** Forget the durable index and its launch and submission keys after the actor is gone. */
async function forgetSession(c: UserCtx, id: string): Promise<void> {
	await c.db.execute("DELETE FROM session_secret_grant WHERE session_id = ?", id);
	await c.db.execute("DELETE FROM requested_secret_receipt WHERE session_id = ?", id);
	await c.db.execute("DELETE FROM sessions WHERE id = ?", id);
	c.vars.sessions.delete(id);
	c.vars.launchUntil.delete(id);
	c.vars.launchClaim.delete(id);
	for (const [key, made] of c.vars.created) if (made.id === id) c.vars.created.delete(key);
	broadcastSessions(c);
}

/** A session leaves the user's index and its actor goes: `deleteSession` without the caller's checks, for build sessions. */
async function removeSession(c: CreateCtx, uid: string, id: string): Promise<void> {
	if (!c.vars.sessions.delete(id)) return;
	try { await sessionActor(c, uid, id).internalDestroy(); }
	catch (error) { if (!isSessionGone(error)) c.log.error({ msg: "a build session could not be removed", session: id, error: String(error) }); }
	await forgetSession(c, id);
}

/** The user actor as user-environments.ts takes it. */
function environmentHost(c: EnvironmentCtx): EnvironmentHost {
	const uid = c.vars.profile?.uid ?? "";
	return {
		db: c.db,
		uid,
		now: () => Date.now(),
		sessions: () => [...c.vars.sessions.values()],
		machines: () => listMachines(c),
		saved: async (project) => {
			const setup = await setupRow(c.db, project);
			const [{ n }] = await c.db.execute<{ n: number }>("SELECT count(*) AS n FROM repo_secret WHERE project = ?", project);
			const [label] = await c.db.execute<{ label: string }>("SELECT label FROM setup_command WHERE project = ?", project);
			return { command: setup?.command ?? "", checks: (await readChecks(c.db, project)).checks, secrets: n, defaults: await readDefaults(c.db, project), label: label?.label ?? project };
		},
		snapshots: { hosted: snapshotsFor({ kind: "hosted" }), machines: snapshotsFor({ kind: "machine" }) },
		hostedUserMax: config.sandbox === "e2b" ? readE2bSettings().snapshots?.maxPerUser ?? null : null,
		startBuild: async (request) => {
			const profile = c.vars.profile;
			if (!profile) throw new Error("Sign in again so the platform can build environments.");
			const [row] = await c.db.execute<{ label: string }>("SELECT label FROM setup_command WHERE project = ?", request.project);
			const place = request.place === HOSTED ? { kind: "hosted" as const } : { kind: "machine" as const, machineId: request.place };
			let summary: SessionSummary;
			try {
				summary = await makeSession(c, profile, { title: `Environment of ${row?.label ?? "the repository"}`, place, profile: request.profile as SandboxProfileId, ...(request.hostedSize && { hostedSize: request.hostedSize }), repository: { id: githubId(request.repositoryId) ?? request.repositoryId } }, null, undefined,
					{ project: request.project, place: request.place, screenshots: request.screenshots });
			} catch (error) {
				throw new Error(error instanceof UserError ? error.message : "The build's sandbox could not be made.");
			}
			try { await sessionActor(c, profile.uid, summary.id).internalBuildEnvironment(); }
			catch (error) {
				await removeSession(c, profile.uid, summary.id);
				const said = (error as { group?: string; message?: string } | null);
				throw new Error(said?.group === "user" && typeof said.message === "string" ? said.message : "The build could not start.");
			}
			return summary.id;
		},
		removeSession: (id) => removeSession(c, uid, id),
		watchPushes: async (repositoryId) => {
			await c.client().githubRepository.getOrCreate([repositoryId], { params: serviceParams() }).internalWatchPushes(uid).catch(() => undefined);
		},
		arm: async (at) => {
			// One alarm is enough: another is set only for a time before the one that is set.
			const set = environmentAlarms.get(c.vars);
			if (set !== undefined && set >= Date.now() && set <= at) return;
			environmentAlarms.set(c.vars, at);
			await c.schedule.at(at, "internalEnvironmentTick");
		},
	};
}

/** `makeSession` for an item's session, as user-items.ts asks for it, with the action's own context. */
function itemSession(c: CreateCtx): MakeSession {
	return (_, profile, input, submission, item) => makeSession(c, profile, input, submission, item);
}

type RevocationContext = UserCtx & {
	key: string[];
	client(): unknown;
	conns: Parameters<typeof disconnectRevoked>[0];
	schedule: { after(ms: number, action: string, attempt: number): Promise<string> };
	log: { warn(entry: unknown): void };
};

const RETRY_DISCONNECT = "retryDisconnectRevoked";

// Six durable retries, starting after 30 seconds and ending with a 15-minute delay.
const DISCONNECT_DELAYS = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000];

async function closeRevokedFeeds(c: RevocationContext, generation: number, lastTry: boolean): Promise<void> {
	let userFeedsFailed = false;
	try {
		await disconnectRevoked(c.conns, generation);
	} catch {
		userFeedsFailed = true;
	}
	// Only the session itself knows which sockets it has. Checkpoint each batch so a retry or
	// actor restart visits only outstanding sessions. A newer generation owns its own marks.
	const sessions = await c.db.execute<{ id: string }>("SELECT id FROM sessions WHERE disconnect_pending = ?", generation);
	let failed = 0;
	for (let i = 0; i < sessions.length; i += 16) {
		if (generation < c.vars.tokenGen) return;
		const closed = await Promise.all(sessions.slice(i, i + 16).map(async ({ id }) => {
			try {
				await sessionActor(c, c.key[0], id).internalDisconnectRevoked(generation);
			} catch (error) {
				if (!isSessionGone(error)) return null;
			}
			return id;
		}));
		const done = closed.filter(id => id !== null);
		failed += closed.length - done.length;
		if (done.length) await c.db.execute("UPDATE sessions SET disconnect_pending = 0 WHERE disconnect_pending = ? AND id IN (SELECT value FROM json_each(?))", generation, JSON.stringify(done));
	}
	if (!userFeedsFailed && failed === 0) {
		await c.db.execute("UPDATE token_generation SET disconnected = ? WHERE id = 1 AND gen = ?", generation, generation);
	} else {
		c.log.warn({ msg: lastTry ? "Revoked feed disconnect retries exhausted" : "Retrying revoked feed disconnects", generation, failedSessions: failed, userFeedsFailed });
	}
}

function sweep(c: RevocationContext, generation: number, lastTry = false): Promise<void> {
	// The timer is already armed. If it fired during a slow pass, wait for that pass to
	// checkpoint its successes before looking up the remaining sessions.
	const previous = c.vars.disconnectSweep ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(() => closeRevokedFeeds(c, generation, lastTry));
	c.vars.disconnectSweep = run;
	return run.finally(() => {
		if (c.vars.disconnectSweep === run) c.vars.disconnectSweep = undefined;
	});
}

async function revokeTokens(c: RevocationContext, revokeApiTokens = false): Promise<void> {
	// Arm recovery before committing the bump, including when the actor stops between the two writes.
	const job = await c.schedule.after(DISCONNECT_DELAYS[0], RETRY_DISCONNECT, 1);
	const gen = await c.db.transaction(async tx => {
		if (revokeApiTokens) await tx.execute("DELETE FROM api_token");
		const [row] = await tx.execute<{ gen: number }>("UPDATE token_generation SET gen = gen + 1, disconnect_job = ? WHERE id = 1 RETURNING gen", job);
		await tx.execute("UPDATE sessions SET disconnect_pending = ?", row.gen);
		return row.gen;
	});
	c.vars.tokenGen = Math.max(c.vars.tokenGen, gen);
	c.vars.reached = true;
	await sweep(c, gen);
}

export const user = actor({
	options: { name: "User", icon: "user", actionTimeout: 180_000 },

	db: db({
		onMigrate: async (db) => {
			await db.execute("CREATE TABLE IF NOT EXISTS token_generation (id INTEGER PRIMARY KEY CHECK(id = 1), gen INTEGER NOT NULL)");
			await db.execute("INSERT OR IGNORE INTO token_generation (id, gen) VALUES (1, 0)");
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
					summary TEXT NOT NULL,
					key TEXT,
					sent TEXT,
					launch_until INTEGER,
					launch_claim INTEGER
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
			await db.execute("DROP TABLE IF EXISTS github_grant");
			// A retry series for the webhook directories after a failed update (user-github.ts).
			await db.execute(GITHUB_SYNC_TABLE);
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
			await migrateDefaults(db);
			// The checks of repositories (repository-checks.ts): one row per repository, `project` as above, the list as JSON.
			await db.execute(CHECKS_TABLE);
			// The network lists of repositories and the hosts their sessions could not reach (repository-network.ts), `project` as above.
			await db.execute(NETWORK_TABLE);
			await db.execute(REQUESTS_TABLE);
			// What the user keeps for their account: the defaults for new sessions (account-defaults.ts), their own MCP
			// servers (personal-servers.ts) and the secrets those read (account-secrets.ts), each value sealed.
			await db.execute(ACCOUNT_DEFAULTS_TABLE);
			// Where the newest agent was started, its agent and its mode (account-defaults.ts): one row, written when an agent is made.
			await db.execute(LAST_START_TABLE);
			// The models of the user's ChatGPT plan as Windlass last listed them (account-models.ts): one row.
			await db.execute(MODELS_TABLE);
			await db.execute(PERSONAL_SERVERS_TABLE);
			await db.execute(ACCOUNT_SECRETS_TABLE);
			await db.execute("CREATE TABLE IF NOT EXISTS requested_secret_receipt (session_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)");
			await db.execute("CREATE TABLE IF NOT EXISTS session_secret_grant (session_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(session_id, name))");
			// Before the column checks below: the API token table is one of them.
			for (const table of ITEM_TABLES) await db.execute(table);
			for (const [table, column, definition] of [
				["token_generation", "disconnected", "INTEGER NOT NULL DEFAULT 0"],
				["token_generation", "disconnect_job", "TEXT"],
				["sessions", "disconnect_pending", "INTEGER NOT NULL DEFAULT 0"],
				["repository_defaults", "screenshots", "INTEGER NOT NULL DEFAULT 0"],
				["api_token", "window_count", "INTEGER NOT NULL DEFAULT 0"],
				["sessions", "launch_claim", "INTEGER"],
				["setup_command", "snapshot_connection", "INTEGER"],
			] as const) {
				const columns = await db.execute<{ name: string }>(`PRAGMA table_info(${table})`);
				if (columns.some((found) => found.name === column)) continue;
				await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				if (column === "disconnect_pending") {
					// A pre-upgrade sweep has a timer but no per-session checkpoints yet.
					await db.execute("UPDATE sessions SET disconnect_pending = (SELECT gen FROM token_generation WHERE id = 1) WHERE EXISTS (SELECT 1 FROM token_generation WHERE gen > disconnected)");
				}
			}
			// Where a post-setup snapshot of a project was last saved (`internalSnapshotSaved`), for placement's snapshot bonus.
			await db.execute("CREATE TABLE IF NOT EXISTS snapshot_place (project TEXT NOT NULL, place TEXT NOT NULL, saved_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, connected_at INTEGER NOT NULL, PRIMARY KEY (project, place))");
			// The last launch claim's generation (`UserVars.launchClaim`): kept on its own, so that it only ever grows.
			// A repository's prepared environments (environments.ts).
			await db.execute(ENVIRONMENT_TABLE);
			await db.execute(ENVIRONMENT_SCHEDULE_TABLE);
			await db.execute("CREATE TABLE IF NOT EXISTS launch_counter (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL)");
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
			// Preserve the opening instant for period attribution without changing the usage ledger.
			await db.execute("CREATE TABLE IF NOT EXISTS usage_start (hold TEXT PRIMARY KEY, day INTEGER NOT NULL, started_at INTEGER NOT NULL)");
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
			// Null on holds and entries written before the monthly meter recorded weights.
			for (const table of ["usage_entry", "usage_hold"]) {
				const columns = await db.execute<{ name: string }>(`PRAGMA table_info(${table})`);
				if (!columns.some(column => column.name === "weight")) await db.execute(`ALTER TABLE ${table} ADD COLUMN weight REAL`);
			}
			// The sessions that have a place among the sandboxes the user keeps.
			await db.execute("CREATE TABLE IF NOT EXISTS kept_sandbox (session TEXT PRIMARY KEY, since INTEGER NOT NULL)");
			await machineTables(db);
			await billingTables(db);
		},
	}),

	createVars: async (c): Promise<UserVars> => {
		const [{ gen }] = await c.db.execute<{ gen: number }>("SELECT gen FROM token_generation WHERE id = 1");
		const [row] = await c.db.execute<{ uid: string; email: string | null; demo: number }>("SELECT uid, email, demo FROM profile WHERE id = 1");
		const rows = await c.db.execute<{ summary: string; key: string | null; sent: string | null; launch_until: number | null; launch_claim: number | null }>("SELECT summary, key, sent, launch_until, launch_claim FROM sessions");
		const launchUntil = new Map<string, number>();
		const launchClaim = new Map<string, number>();
		const [counter] = await c.db.execute<{ last: number }>("SELECT last FROM launch_counter WHERE id = 1");
		const sessions = new Map<string, SessionSummary>();
		const created = new Map<string, Submission & { id: string }>();
		for (const { summary, key, sent, launch_until, launch_claim } of rows) {
			// A summary stored before it carried its agent's capabilities, or with those of an older build, takes this build's.
			const parsed = { ...(JSON.parse(summary) as SessionSummary) };
			parsed.capabilities = sessionCapabilities(parsed.harness);
			sessions.set(parsed.id, parsed);
			if (launch_until !== null) launchUntil.set(parsed.id, launch_until);
			if (launch_until !== null && launch_claim !== null) launchClaim.set(parsed.id, launch_claim);
			if (key !== null && sent !== null) created.set(key, { key, sent, id: parsed.id });
		}
		// An actor that holds a sign-in is a user's, also before that user's own token was seen here.
		const [held] = await c.db.execute<{ id: number }>("SELECT id FROM signin WHERE id = 1");
		const [connected] = await c.db.execute<{ connection: string }>("SELECT connection FROM github WHERE id = 1");
		const github = connected ? (JSON.parse(connected.connection) as StoredConnection) : null;
		const approvals = new ApprovalBook(await readApprovals(c.db), config.serverApprovalTtlMs);
		const items = await loadItems(c.db);
		// Where the deployment has billing, the account's subscription sets its plan's limits (billing/plans.ts).
		items.limits.billing = billing() ? await readBilling(c.db) : null;
		return { tokenGen: gen, profile: row ? { uid: row.uid, email: row.email, demo: row.demo === 1 } : null, reached: gen > 0 || row !== undefined || held !== undefined, sessions, launchUntil, launchClaim, launchGen: counter?.last ?? 0, created, creating: new Attempts(), signIn: null, signInDb: null, approvals, github, githubWriting: Promise.resolve(), models: new AccountModels({ uid: c.key[0]! }), usage: await readUsage(c.db, accountLimits(items.limits).usage, sessions), overageReport: Promise.resolve(), checkout: new AccountCheckout(), listed: null, machines: new Map((await listMachines({ db: c.db, vars: { sessions } })).map(m => [m.machineId, m])), items };
	},

	events: {
		machineHost: event<MachineHostUpdate>({ canSubscribe: (c) => maySubscribe(c) }),
		machines: event<MachineSummary[]>({ canSubscribe: (c) => maySubscribe(c) }),
		sessions: event<SessionSummary[]>({ canSubscribe: (c) => maySubscribe(c) }),
		usage: event<UsageNumbers>({ canSubscribe: (c) => maySubscribe(c) }),
		items: event<ItemSummary[]>({ canSubscribe: (c) => maySubscribe(c) }),
	},

	onBeforeConnect: (c, params: ConnParams | undefined) => {
		assertOrigin(c);
		try {
			const caller = userActorCaller(c, params);
			if (caller.kind === "user") c.vars.reached = true;
		} catch (error) {
			// `getOrCreate` makes the actor before this hook runs, so a call without a valid token can
			// leave an empty actor behind under any key. One that no user has ever reached is removed.
			if (!c.vars.reached && c.vars.sessions.size === 0) c.destroy();
			throw error;
		}
	},

	onConnect: async (c, conn) => {
		const caller = userActorCaller(c, conn.params);
		if (caller.kind === "user") await rememberProfile(c, caller.profile);
	},

	onDestroy: async c => { await dropHostedSnapshots(c.key[0]); },
	onWake: async (c) => {
		queueOverageReport(c);
		// Backfill saved connections on upgrade and repair a grant interrupted after the local write.
		const connection = c.vars.github;
		if (connection && githubConfig().webhook) {
			try {
				// A series whose next try was set and not stored would block every later one: wake starts afresh.
				await c.db.execute("DELETE FROM github_sync");
				await syncGithubWebhooks(c, c.key[0]);
			} catch { console.warn(`github.installations.sync_failed uid=${c.key[0]}`); }
		}
		// Turn requests that waited while the actor was away are tried, and their schedule set again (user-items.ts).
		queueChanged(c);
		await notifyRemovedMachines(c);
		await notifyProviderWaits(c, c.vars.items.items.values());
		// A try whose next schedule was set and not stored, because the server stopped in between, is set again.
		try {
			const late = await c.db.execute<{ session: string; tries: number }>("SELECT session, tries FROM backup_removal WHERE due_at < ?", Date.now() - BACKUP_REMOVE_LATE_MS);
			for (const { session, tries } of late) await armBackupRemoval(c, session, tries);
		} catch (error) {
			c.log.warn({ msg: "could not set the removal of deleted sessions' copies again", error: String(error) });
		}
	},

	actions: {
		[RETRY_DISCONNECT]: async (c, attempt = 1): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const [pending] = await c.db.execute<{ gen: number; disconnect_job: string | null }>(
				"SELECT gen, disconnect_job FROM token_generation WHERE gen > disconnected AND (disconnect_job = ? OR disconnect_job IS NULL)", c.scheduledFire.id);
			if (!pending) return;
			const delay = DISCONNECT_DELAYS[attempt];
			// Arm recovery before the pass. Superseded jobs and duplicate deliveries do no work.
			const next = delay === undefined ? "exhausted" : await c.schedule.after(delay, RETRY_DISCONNECT, attempt + 1);
			const claimed = await c.db.execute("UPDATE token_generation SET disconnect_job = ? WHERE gen = ? AND gen > disconnected AND disconnect_job IS ? RETURNING gen", next, pending.gen, pending.disconnect_job);
			if (claimed.length) await sweep(c, pending.gen, delay === undefined);
		},
		internalTokenGeneration: (c): number => { requireServiceFor(c, "call"); return c.vars.tokenGen; },
		signOutEverywhere: async (c, options?: { revokeApiTokens: boolean }): Promise<void> => {
			requireUser(c);
			await revokeTokens(c, options?.revokeApiTokens === true);
		},
		internalLimitHistory: async (c, operator: string, before?: number) => {
			requireServiceFor(c, limitsSubject(c.key[0]!, operator));
			return c.db.execute<LimitAuditRow>("SELECT id, at, operator, setting, old_value, new_value, overrides FROM limit_changes WHERE id < ? ORDER BY id DESC LIMIT 100", before ?? Number.MAX_SAFE_INTEGER);
		},
		internalSetLimit: async (c, change: LimitChange) => {
			const result = await changeUserLimit(c, change);
			if (result.id >= c.vars.items.limits.id) {
				c.vars.items.limits = { ...result, billing: c.vars.items.limits.billing };
				Object.assign(c.vars.usage.limits, accountLimits(c.vars.items.limits).usage);
				c.broadcast("usage", c.vars.usage.numbers(Date.now()));
				queueChanged(c);
			}
			return accountLimits(c.vars.items.limits);
		},
		internalHostedSizes: async (c): Promise<HostedSize[]> => {
			requireService(c);
			return sizesOf(c, await getLayer()).map(size => size.id);
		},
		internalDailyTokenWait: (c) => { requireServiceFor(c, "call"); return accountTokenWait(c); },
		internalRecordTurnTokens: async (c, input: { sessionId: string; receipt: TokenReceipt }) => {
			requireServiceFor(c, "call");
			// The session can already be out of the index while its deletion settles its last receipt.
			const inserted = await recordTurnTokens(c.db, input.sessionId, input.receipt);
			const { at } = input.receipt;
			c.vars.usage.noteModelTokens(at, await tokensOn(c.db, at));
			if (inserted) {
				c.broadcast("usage", c.vars.usage.numbers(Date.now()));
				if (accountTokenWait(c)) queueChanged(c);
			}
		},
		internalRevokeTokens: async (c): Promise<void> => {
			requireServiceFor(c, "revoke:" + c.key[0]);
			await revokeTokens(c);
		},
		machines: (c): Promise<MachineSummary[]> => machineActions.machines(c),
		machineCatalog: (c, input: Parameters<UserActions["machineCatalog"]>[0]): ReturnType<UserActions["machineCatalog"]> => machineActions.machineCatalog(c, input),
		claimMachine: (c, input: { code: string }): Promise<MachineClaim> => machineActions.claimMachine(c, input),
		confirmMachine: (c, input: { code: string; keyConfirmed: true }): Promise<MachineSummary> => machineActions.confirmMachine(c, input),
		removeMachine: (c, input: { machineId: string; removeSandboxes: boolean }): Promise<MachineSummary[]> => machineActions.removeMachine(c, input),
		internalProviderGeneration: (c, location: AccountLocation) => { requireServiceFor(c, "call"); return loginGeneration(c.db, location); },
		internalLimitedAccounts: async c => { requireServiceFor(c, "call"); return limitedAccounts(await providerAccounts(c.db, Date.now())); },
		internalObserveUsage: async (c, location: AccountLocation, generation: string, observation: UsageObservation) => {
			requireServiceFor(c, "call");
			if (await recordProviderUsage(c.db, location, generation, observation)) {
				if (c.vars.machines.size && (location.harness === "windlass" || location.place !== "hosted")) await machinesChanged(c);
				queueChanged(c);
			}
		},
		internalPlannerMachines: (c) => { requireService(c); return plannerMachines([...c.vars.machines.values()], config.factory.screenshots); },
		internalAgentModels: (c): Promise<AgentModels> => { requireService(c); return agentModels(c); },
		setMachineDetails: (c, input: { machineId: string; whenToUse: string; tags: string[] }) => machineActions.setMachineDetails(c, input),
		setMachineSecrets: (c, input: { machineId: string; send: boolean }): Promise<MachineSummary[]> => machineActions.setMachineSecrets(c, input),
		internalMachineCreated: (c, id: string): Promise<boolean> => machineActions.internalMachineCreated(c, id),
		internalMachineSystem: async (c, id: string): Promise<{ os: string; arch: string } | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ os: string; arch: string }>("SELECT os, arch FROM machines WHERE id = ?", id);
			return row ?? null;
		},
		internalMachineApproval: (c, id: string): Promise<{ login: string | null } | null> => machineActions.internalMachineApproval(c, id),
		internalMachineChanged: async (c, id: string, facts: MachineUpdate | null): Promise<void> => {
			const inventoryChanged = await machineActions.internalMachineChanged(c, id, facts);
			if (facts === null) await notifyRemovedMachines(c, id);
			if (inventoryChanged) queueChanged(c);
		},
		// --- work items, the turn queue and API tokens (user-items.ts) ---
		internalReserveAttachment: (c, input: import("../sandbox/attach.js").Reservation) => itemActions.internalReserveAttachment(c, input),
		internalRecordAttachment: (c, input: { id: string; width: number; height: number }) => itemActions.internalRecordAttachment(c, input),
		internalReleaseAttachment: (c, input: string) => itemActions.internalReleaseAttachment(c, input),
		internalSettleAttachments: (c, input: { sessionId: string; key: string; keep: string[] }) => itemActions.internalSettleAttachments(c, input),
		internalDeleteItemAttachments: (c, input: string) => itemActions.internalDeleteItemAttachments(c, input),
		[ATTACHMENT_SWEEP_ACTION]: (c) => itemActions.internalAttachmentSweep(c),
		itemAttachmentLinks: (c, input: string) => itemActions.itemAttachmentLinks(c, input),
		internalApiItemAttachment: (c, input: { token: string; id: string; attachment: string }) => itemActions.internalApiItemAttachment(c, input),
		listItems: (c, page?: ItemListPage): ItemSummary[] => itemActions.listItems(c, page),
		itemFeed: (c): ItemFeed => itemActions.itemFeed(c),
		item: (c, id: string): Promise<ItemView> => itemActions.item(c, id),
		internalGithubIntake: (c, input: import("../factory/intake.js").IntakeTrigger) => itemActions.internalGithubIntake(c, input, itemSession(c)),
		createItem: (c, input: CreateItemInput): Promise<ItemSummary> => itemActions.createItem(c, input, itemSession(c)),
		actOnItem: (c, input: { id: string; action: ItemAction }): Promise<ItemView> => itemActions.actOnItem(c, input),
		factoryLimits: (c): FactoryLimits => itemActions.factoryLimits(c),
		apiTokens: (c): Promise<ApiToken[]> => itemActions.apiTokens(c),
		createApiToken: (c, input: { name: string; scopes: ApiTokenScope[] }): Promise<{ token: ApiToken; secret: string }> => itemActions.createApiToken(c, input),
		revokeApiToken: (c, id: string): Promise<ApiToken[]> => itemActions.revokeApiToken(c, id),
		internalApiCreateItem: (c, input: { token: string; item: CreateItemInput }): Promise<ItemSummary> => itemActions.internalApiCreateItem(c, input, itemSession(c)),
		internalApiItem: (c, input: { token: string; id: string }): Promise<ItemView> => itemActions.internalApiItem(c, input),
		internalFeatureChild: (c, input: { parent: string; child: string; cancel?: boolean }) => itemActions.internalFeatureChild(c, input, itemSession(c), () => agentModels(c)),
		internalItemChanged: (c, summary: ItemSummary): Promise<void> => itemActions.internalItemChanged(c, summary),
		internalItemFacts: (c, ids: string[] | string): ItemFacts => itemActions.internalItemFacts(c, typeof ids === "string" ? [ids] : ids),
		internalRequestTurn: (c, request: TurnRequest): Promise<TurnAnswer> => itemActions.internalRequestTurn(c, request),
		internalTurnDone: (c, input: TurnRelease): Promise<void> => itemActions.internalTurnDone(c, input),
		internalWithdrawTurn: (c, input: { sessionId: string; key: string }): Promise<void> => itemActions.internalWithdrawTurn(c, input),
		[QUEUE_ACTION]: (c): Promise<void> => itemActions.internalTurnQueue(c),
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
			if (profile.demo) { await logoutMachines(c); return; }
			try {
				await (await signIn(c)).logout();
				await c.vars.models.forget(c.db);
				await logoutMachines(c);
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
				if (isSessionGone(error)) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
				throw clientError(c.log, error, "The agent could not be renamed. Try again.");
			}
			await storeReport(c, summary);
			return summary;
		},

		deleteSession: async (c, id: string): Promise<void> => {
			const profile = requireUser(c);
			const existing = typeof id === "string" ? c.vars.sessions.get(id) : undefined;
			if (!existing) throw new UserError("That agent does not exist.", { code: "session_not_found" });
			const owned = itemSessionRefusal(c, existing);
			if (owned) throw owned;

			// Out of the index first, so a report the session sends while it shuts down is ignored.
			c.vars.sessions.delete(id);
			try {
				await sessionActor(c, profile.uid, id).internalDestroy();
			} catch (error) {
				if (!isSessionGone(error)) {
					if (!c.vars.sessions.has(id)) c.vars.sessions.set(id, existing);
					// What the session itself refused (its machine could not record the sandbox's removal) is said in its words.
					const { group, code, message } = (typeof error === "object" && error !== null ? error : {}) as { group?: unknown; code?: unknown; message?: unknown };
					if (group === "user" && typeof code === "string" && typeof message === "string") throw new UserError(message, { code });
					throw clientError(c.log, error, "The agent could not be deleted. Try again.");
				}
			}
			await forgetSession(c, id);
			// A session with no repository was its own project: what was approved for it goes with it.
			await changeApprovals(c, (book) => book.forgetProject(sessionProjectKey(id))).catch((error) => c.log.warn({ msg: "could not forget the deleted session's approvals of MCP servers", session: id, error: String(error) }));
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

		// --- plans and billing (billing/) -------------------------------------------------------------

		billing: async (c): Promise<BillingView> => {
			requireUser(c);
			return billingAnswer(c);
		},

		billingCheckout: async (c, input: { period: BillingPeriod; origin: string }): Promise<{ url: string }> => {
			const profile = requireUser(c);
			const settings = billingOn();
			if (input?.period !== "month" && input?.period !== "year") throw new UserError("Choose monthly or yearly.", { code: "bad_input" });
			const origin = billingOrigin(input?.origin);
			if (profile.demo) throw new UserError("The demo account cannot subscribe.", { code: "billing_off" });
			try {
				const checkout = await c.vars.checkout.open(c.db, settings.provider, {
					uid: profile.uid, email: profile.email, period: input.period,
					returnUrl: `${origin}/settings?billing=checkout#plan`,
					claimCustomer: async id => (await customerDirectory(c.client()).claim(id, profile.uid)) === profile.uid,
				}, Date.now());
				c.vars.items.limits.billing = await readBilling(c.db);
				return checkout;
			} catch (error) {
				if (error instanceof CheckoutEmailRequired) throw new UserError(error.message, { code: "bad_input" });
				if (error instanceof CheckoutBlocked) throw new UserError(error.message, { code: "already_subscribed" });
				console.warn(`[wlp] billing.checkout_failed uid=${c.key[0]}`);
				throw new UserError("The checkout could not be opened. Try again in a moment.", { code: "billing_unavailable" });
			}
		},

		billingPortal: async (c, input: { origin: string }): Promise<{ url: string }> => {
			requireUser(c);
			const settings = billingOn();
			const origin = billingOrigin(input?.origin);
			const { customerId } = await readBilling(c.db);
			if (customerId === null) throw new UserError("There is no subscription to manage yet.", { code: "no_customer" });
			try {
				return await settings.provider.portalLink({ customerId, returnUrl: `${origin}/settings#plan` });
			} catch {
				console.warn(`[wlp] billing.portal_failed uid=${c.key[0]} customer=${customerId}`);
				throw new UserError("The billing portal could not be opened. Try again in a moment.", { code: "billing_unavailable" });
			}
		},

		setOverageCap: async (c, input: { cents: number }): Promise<BillingView> => {
			requireUser(c);
			billingOn();
			try {
				c.vars.items.limits.billing = await setCapCents(c.db, input?.cents);
			} catch (error) {
				if (error instanceof RangeError) throw new UserError(error.message, { code: "bad_input" });
				throw error;
			}
			console.log(`[wlp] billing.cap uid=${c.key[0]}`);
			billingChanged(c);
			return billingAnswer(c);
		},

		internalRetryOverage: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			queueOverageReport(c);
			await c.vars.overageReport;
		},

		/** A webhook's event for this account (billing/route.ts), applied once. */
		internalBillingEvent: async (c, event: BillingEvent): Promise<string> => {
			requireServiceFor(c, "billing");
			const settings = billingOn();
			const done = await applyBillingEvent(c.db, event, Date.now(), settings.graceMs, async id =>
				(await customerDirectory(c.client()).claim(id, c.key[0]!)) === c.key[0]);
			if (done.outcome === "applied") {
				c.vars.items.limits.billing = done.state;
				billingChanged(c);
			}
			return done.outcome;
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
		 * is there, with every other sandbox the provider lists for it, so its timeline says so and nothing
		 * is removed under a turn. For an agent that was deleted, what the provider still lists for it is
		 * removed here.
		 */
		freeSandbox: async (c, sessionId: string): Promise<UsageView> => {
			const profile = requireUser(c);
			const id = approvalText(sessionId, 200);
			if (id === "") throw new UserError("Say which agent's sandbox to free.", { code: "bad_input" });
			try {
				let gone = !c.vars.sessions.has(id);
				if (!gone) {
					await sessionActor(c, profile.uid, id)
						.internalFreeSandbox()
						.catch((error: unknown) => {
							if (isSessionGone(error)) {
								gone = true;
								return;
							}
							// What the session itself refused (it is working) is said in its words.
							const { group, code, message } = (typeof error === "object" && error !== null ? error : {}) as { group?: unknown; code?: unknown; message?: unknown };
							if (group === "user" && typeof message === "string") throw new UserError(message, { code: typeof code === "string" ? code : "sandbox_busy" });
							throw error;
						});
				}
				// A living session removed its sandboxes and gave its place back itself, inside its own exclusion: a
				// list read here could hold one a prompt has just made it. Only what a session that is gone left is removed here.
				if (gone) {
					const { sandboxes } = await getLayer();
					for (const left of await sandboxes.list(profile.uid)) {
						if (left.sessionId !== id) continue;
						await sandboxes.destroy(left.id);
						console.log(`[wlp] sandbox.freed id=${left.id} uid=${profile.uid} session=${id}: it was left at the provider without its agent`);
					}
					await changeUsage(c, (book) => ({ change: book.release(id) }));
				}
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
				...(githubConfig().webhook ? { webhookLinked: true } : {}),
				user: { id: confirmed.user.id, login: confirmed.user.login },
				installations: confirmed.installations.slice(0, MAX_GITHUB_ACCOUNTS).map(({ id, account, htmlUrl }) => ({ id, account: { id: account.id, login: account.login, type: account.type }, htmlUrl })),
				connectedAt: Date.now(),
			};
			await replaceGithubConnection(c, profile.uid, connection, confirmed.readAt);
			c.vars.reached = true;
			console.log(`[wlp] github.connected uid=${profile.uid} github=${connection.user.login} installations=${connection.installations.map((installation) => installation.id).join(",")}`);
			return githubStatus(c.vars);
		},

		/** Forgets the connection. The app stays installed at GitHub, which is the account owner's to change. */
		githubDisconnect: async (c): Promise<GithubStatus> => {
			const profile = requireUser(c);
			requireGithub();
			// A connection that was begun and not finished ends here too. The tickets that were taken stay
			// on the list until they would have expired: one of them must not bring the connection back.
			await c.db.execute("DELETE FROM github_nonce WHERE kind = 'state'");
			const wasConnected = c.vars.github !== null;
			await replaceGithubConnection(c, profile.uid, null);
			await dropHostedSnapshots(profile.uid);
			if (wasConnected) console.log(`[wlp] github.disconnected uid=${profile.uid}`);
			return githubStatus(c.vars);
		},

		githubRepositories: async (c, query: string, fresh?: boolean): Promise<GithubRepositoryList> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (typeof query !== "string" || query.length > 200) throw new UserError("Search for part of a repository's name.", { code: "bad_input" });
			try {
				// Asked for anew: somebody who has just added a repository at GitHub wants to see it.
				return await listRepositories(app, fresh === true ? { ...connection, refreshedAt: Date.now() } : connection, query);
			} catch (error) {
				throw githubError(c.log, error, "The repositories could not be listed. Try again.");
			}
		},

		githubBranches: async (c, repositoryId: GithubId): Promise<GithubBranchList> => {
			requireUser(c);
			const app = requireGithub();
			const connection = requireConnection(c);
			if (!isGithubId(repositoryId)) throw new UserError("Choose one of the listed repositories.", { code: "bad_input" });
			try {
				return await listBranches(app, connection, repositoryId);
			} catch (error) {
				throw githubError(c.log, error, "The repository's branches could not be listed. Try again.");
			}
		},

		// --- setup commands of repositories (setup-command.ts) --------------------------------------

		repositorySetup: async (c, repositoryId: GithubId): Promise<RepositorySetup> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await readSetup(c.db, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's setup command could not be read. Try again.");
			}
		},

		saveRepositorySetup: async (c, input: { repositoryId: GithubId; command: string }): Promise<RepositorySetup> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const command = setupCommandOf(input?.command);
			try {
				const saved = await saveSetup(c, profile.uid, project, await labelFor(c, input.repositoryId, project), command);
				await rememberProfile(c, profile);
				await settingsChanged(environmentHost(c), project).catch((error: unknown) => c.log.warn({ msg: "environments could not be marked stale", error: String(error) }));
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The setup command could not be saved. Try again.");
			}
		},

		// --- checks of repositories (repository-checks.ts) -------------------------------------------

		internalPlanCritic: async (c, builderId: string): Promise<void> => {
			requireServiceFor(c, "call");
			const builder = c.vars.sessions.get(builderId), profile = c.vars.profile;
			if (!profile || !builder?.item || builder.item.role === "reviewer" || !builder.repository ||
				!reviewerAllowed(builder.place, (await getLayer()).sandboxes.profile(builder.profile))) throw new Error("A restricted critic session is unavailable.");
			const sessionId = criticSessionId(builder.item.id);
			if (c.vars.sessions.has(sessionId)) return;
			const { id, branch } = builder.repository;
			const accountModel = (await readAccountDefaults(c.db)).model;
			const model = accountModel && !/luna/i.test(accountModel) ? accountModel : (await modelsOf(c, profile.demo)).defaultModel;
			if (/luna/i.test(model)) throw new Error("The default model is a light model.");
			await makeSession(c, profile, { title: builder.title, profile: builder.profile, model, repository: { id, branch } },
				null, { sessionId, itemId: builder.item.id, role: "reviewer", planCritic: true, hostedSize: builder.hostedSize });
		},

		internalRepositoryAutonomy: async (c, repositoryId: GithubId) => {
			requireService(c);
			const { autoApprovePlans, autoMergeSingles } = await readDefaults(c.db, setupKeyOf(repositoryId));
			return { autoApprovePlans: !!autoApprovePlans, autoMergeSingles: !!autoMergeSingles };
		},

		repositoryChecks: async (c, repositoryId: GithubId): Promise<RepositoryChecks> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await readChecks(c.db, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's checks could not be read. Try again.");
			}
		},

		saveRepositoryChecks: async (c, input: { repositoryId: GithubId; checks: RepositoryCheck[] }): Promise<RepositoryChecks> => {
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
				await rememberProfile(c, profile);
				await settingsChanged(environmentHost(c), project).catch((error: unknown) => c.log.warn({ msg: "environments could not be marked stale", error: String(error) }));
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The checks could not be saved. Try again.");
			}
		},

		// --- network lists of repositories (repository-network.ts) ------------------------------------

		repositoryNetwork: async (c, repositoryId: GithubId): Promise<RepositoryNetwork> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await networkView(c, project);
			} catch (error) {
				throw clientError(c.log, error, "The repository's network list could not be read. Try again.");
			}
		},

		saveRepositoryNetwork: async (c, input: { repositoryId: GithubId; entries: string[] }): Promise<RepositoryNetwork> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			if (!mayChangeNetwork(profile.uid, c.key[0]!)) throw new UserError("Only whoever changes this repository's settings can change its network list.", { code: "forbidden" });
			const limitHosts = await deploymentHostsForLimit();
			const entries = networkInput(() => cleanEntries(input?.entries, limitHosts));
			try {
				const saved = await saveNetwork(c.db, project, await labelFor(c, input.repositoryId, project), entries, Date.now());
				console.log(`[wlp] network.saved uid=${profile.uid} project=${project} entries=${entries.length} hosts=${saved.hosts.length}`);
				return await networkView(c, project);
			} catch (error) {
				throw clientError(c.log, error, "The network list could not be saved. Try again.");
			}
		},

		dismissNetworkRequest: async (c, input: { repositoryId: GithubId; host: string }): Promise<RepositoryNetwork> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const host = approvalText(input?.host, 260);
			try {
				await dismissRequest(c.db, project, host);
				return await networkView(c, project);
			} catch (error) {
				throw clientError(c.log, error, "The request could not be dismissed. Try again.");
			}
		},

		scanRepositoryNetwork: async (c, repositoryId: GithubId): Promise<NetworkScan> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			const app = requireGithub();
			const connection = requireConnection(c);
			let resolved: Awaited<ReturnType<typeof resolveRepository>>;
			try {
				resolved = await resolveRepository(app, connection, repositoryId, "read");
			} catch (error) {
				throw githubError(c.log, error, "The repository could not be checked at GitHub. Try again.");
			}
			const { owner, name, defaultBranch } = resolved.repository;
			let read: { commit: string; files: Array<{ path: string; text: string }>; incomplete: boolean };
			try {
				read = await app.withToken(resolved.installation.id, { repositoryId, permissions: { metadata: "read", contents: "read" } }, (token) => app.scanFiles(token, owner, name, defaultBranch, scanPaths), { revokeAfter: true });
			} catch (error) {
				throw githubError(c.log, error, "The repository's files could not be read at GitHub. Try again.");
			}
			try {
				const hosted = await hostedNetwork();
				const saved = await readNetwork(c.db, project);
				const setup = (await setupRow(c.db, project))?.command ?? "";
				const proposals = scanForHosts(read.files, setup, [...saved.hosts, ...(hosted?.mode === "restricted" ? hosted.hosts : [])]);
				return { proposals, commit: read.commit, branch: defaultBranch, files: read.files.length, incomplete: read.incomplete };
			} catch (error) {
				throw clientError(c.log, error, "The repository's files could not be read. Try again.");
			}
		},

		/**
		 * "Allow for this repository" from a session's timeline (`allowHost` of the session): `by` is who
		 * asked, as the session checked it. Someone who may change the repository's settings adds the host
		 * to its list; anyone else would file a request, but only the session's own user reaches `allowHost`
		 * today, and that is this actor's. Answers with the session's hosts then, as a turn gets them.
		 */
		internalAllowHost: async (c, input: { sessionId: string; host: string; by: string }): Promise<{ allowed: boolean; hosts: string[]; network: RepositoryNetwork }> => {
			requireService(c);
			const session = c.vars.sessions.get(approvalText(input?.sessionId, 200));
			const project = setupProjectKey(session?.repository?.id);
			if (!session || project === null) throw new UserError("This agent has no repository of your GitHub connection, so there is no list to allow a host in. The deployment's operator can allow it for every sandbox (WLP_E2B_NETWORK_ALLOW).", { code: "bad_network" });
			const host = cleanEntry(input?.host);
			if (host === null || host.startsWith("@")) throw new UserError("That is not an exact host name.", { code: "bad_network" });
			const allowed = mayChangeNetwork(typeof input?.by === "string" ? input.by : null, c.key[0]!);
			try {
				if (allowed) {
					const label = session.repository ? `${session.repository.owner}/${session.repository.name}` : "";
					const saved = await addEntry(c.db, project, label, host, await deploymentHostsForLimit(), Date.now());
					console.log(`[wlp] network.allowed uid=${c.key[0]} project=${project} host=${host} session=${input.sessionId}`);
					return { allowed, hosts: saved.hosts, network: await networkView(c, project) };
				}
				await fileRequests(c.db, project, [host], input.sessionId, Date.now());
				return { allowed, hosts: (await readNetwork(c.db, project)).hosts, network: await networkView(c, project) };
			} catch (error) {
				if (error instanceof UserError) throw error;
				if (error instanceof NetworkProblem) throw new UserError(error.message, { code: "bad_network" });
				throw clientError(c.log, error, "The host could not be allowed. Try again.");
			}
		},

		/** Hosts a session's sandbox looked up and could not reach: filed as requests on its repository. */
		internalNetworkRequests: async (c, input: { sessionId: string; hosts: string[] }): Promise<{ filed: string[]; full: string[] }> => {
			requireService(c);
			const session = c.vars.sessions.get(approvalText(input?.sessionId, 200));
			const project = setupProjectKey(session?.repository?.id);
			if (!session || project === null || !Array.isArray(input?.hosts)) return { filed: [], full: [] };
			return await fileRequests(c.db, project, input.hosts.filter((host): host is string => typeof host === "string").slice(0, 50), input.sessionId, Date.now());
		},

		/** The setup command of a session's repository, for that session when its sandbox is new. */
		internalHasChecks: async (c, repositoryId: GithubId): Promise<boolean> => {
			requireService(c);
			return (await readChecks(c.db, setupKeyOf(repositoryId))).checks.length > 0;
		},
		internalSnapshotSaved: async (c, project: string, updatedAt: number | null, connectedAt: number, place?: string) => {
			requireService(c);
			if (c.vars.github?.connectedAt !== connectedAt) return;
			await c.db.execute("UPDATE setup_command SET snapshot_connection = ? WHERE project = ? AND updated_at = ?", connectedAt, project, updatedAt);
			if (typeof place === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(place) && updatedAt !== null)
				await c.db.execute("INSERT INTO snapshot_place (project, place, saved_at, updated_at, connected_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, place) DO UPDATE SET saved_at = excluded.saved_at, updated_at = excluded.updated_at, connected_at = excluded.connected_at", project, place, Date.now(), updatedAt, connectedAt);
		},
		internalSnapshotPlaces: async (c, repositoryId: GithubId): Promise<string[]> => {
			requireService(c);
			return snapshotPlaces(c.db, setupKeyOf(repositoryId), c.vars.github?.connectedAt);
		},
		internalSnapshotGenerations: async (c): Promise<string[]> => {
			requireService(c);
			const connection = c.vars.github;
			if (!connection) return [];
			const rows = await c.db.execute<{project: string; updated_at: number}>("SELECT project, updated_at FROM setup_command");
			return rows.map(row => snapshotGeneration(row.project.slice("github:".length), row.updated_at, connection.connectedAt));
		},
		// --- prepared environments of repositories (environments.ts, user-environments.ts) ---------------

		repositoryEnvironments: async (c, repositoryId: GithubId): Promise<RepositoryEnvironments> => {
			await rememberProfile(c, requireUser(c));
			try { return await environmentsView(environmentHost(c), setupKeyOf(repositoryId)); }
			catch (error) { throw clientError(c.log, error, "The repository's environments could not be read. Try again."); }
		},
		rebuildEnvironment: async (c, input: { repositoryId: GithubId; place?: EnvironmentPlace }): Promise<RepositoryEnvironments> => {
			await rememberProfile(c, requireUser(c));
			const project = setupKeyOf(input?.repositoryId);
			if (input.place !== undefined && (typeof input.place !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.place))) throw new UserError("Choose one of the places listed.", { code: "bad_input" });
			const host = environmentHost(c);
			try { await rebuildEnvironments(host, project, input.place); }
			catch (error) {
				if (error instanceof Error && !(error instanceof UserError)) throw new UserError(error.message, { code: "environment_refused" });
				throw clientError(c.log, error, "The rebuild could not be asked for. Try again.");
			}
			return environmentsView(host, project);
		},
		saveEnvironmentSchedule: async (c, input: { repositoryId: GithubId; schedule: EnvironmentSchedule }): Promise<RepositoryEnvironments> => {
			await rememberProfile(c, requireUser(c));
			const project = setupKeyOf(input?.repositoryId);
			if (!ENVIRONMENT_SCHEDULES.includes(input?.schedule)) throw new UserError("Choose nightly, every 12 hours, every 6 hours or off.", { code: "bad_input" });
			const host = environmentHost(c);
			await saveSchedule(host, project, input.schedule);
			return environmentsView(host, project);
		},
		internalEnvironmentTick: async (c): Promise<void> => {
			environmentAlarms.delete(c.vars);
			if (!c.vars.profile) return;
			await environmentTick(environmentHost(c)).catch((error: unknown) => c.log.warn({ msg: "environment builds could not be started", error: String(error) }));
		},
		internalEnvironmentResult: async (c, sessionId: string, result: EnvironmentBuildResult): Promise<void> => {
			requireService(c);
			const passed = await buildResult(environmentHost(c), approvalText(sessionId, 200), result);
			console.log(`[wlp] environment.built uid=${c.key[0]} session=${sessionId} passed=${passed} failure=${result.failure?.kind ?? "none"}`);
		},
		internalEnvironmentNudge: async (c, sessionId: string, kind: "missed" | "cold"): Promise<void> => {
			requireService(c);
			const session = c.vars.sessions.get(approvalText(sessionId, 200));
			const project = setupProjectKey(session?.repository?.id);
			if (!session || !project || session.environmentBuild || (kind !== "missed" && kind !== "cold")) return;
			await environmentNudge(environmentHost(c), project, session.place.kind === "hosted" ? HOSTED : session.place.machineId, kind, session.hostedSize);
		},
		internalEnvironmentPushed: async (c, repositoryId: GithubId): Promise<void> => {
			requireService(c);
			if (!c.vars.profile) return;
			await environmentPushed(environmentHost(c), setupKeyOf(repositoryId));
		},
		internalSetupCommand: async (c, project: string): Promise<RepositorySetup> => {
			requireService(c);
			return readSetup(c.db, approvalText(project, 600));
		},

		// --- secrets of repositories (repo-secrets.ts) ----------------------------------------------

		repositorySecrets: async (c, input: { repositoryId: GithubId; profile: string }): Promise<RepositorySecrets> => {
			requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(input?.profile);
			try {
				return await listSecrets(c.db, project, profile);
			} catch (error) {
				throw clientError(c.log, error, "The repository's secrets could not be read. Try again.");
			}
		},

		saveRepositorySecret: async (c, input: { repositoryId: GithubId; profile: string; name: string; value?: string; scope: SecretScope }): Promise<RepositorySecrets> => {
			const user = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(input?.profile);
			const name = secretInput(() => cleanSecretName(input?.name));
			const scope = secretInput(() => cleanSecretScope(input?.scope));
			const value = input?.value === undefined || input?.value === null ? undefined : secretInput(() => cleanSecretValue(input.value));
			try {
				await saveSecret(c, user.uid, project, await labelFor(c, input.repositoryId, project), name, value, scope);
				return await listSecrets(c.db, project, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be saved. Try again.");
			}
		},

		deleteRepositorySecret: async (c, input: { repositoryId: GithubId; profile: string; name: string }): Promise<RepositorySecrets> => {
			const user = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			const profile = await secretProfile(input?.profile);
			const name = approvalText(input?.name, 200);
			try {
				await c.db.execute("DELETE FROM repo_secret WHERE project = ? AND name = ?", project, name);
				console.log(`[wlp] secret.deleted uid=${user.uid} project=${project} name=${name.replace(/[^A-Za-z0-9_]/g, "?")}`);
				return await listSecrets(c.db, project, profile);
			} catch (error) {
				throw clientError(c.log, error, "The secret could not be deleted. Try again.");
			}
		},

		internalRequestedSecretConflict: async (c, sessionId: string, name: string): Promise<string | null> => {
			requireServiceFor(c, secretsCaller(c.key[0]!, sessionId));
			const session = c.vars.sessions.get(sessionId);
			if (!session || !validRequestedSecretName(name)) throw new UserError("That secret request is unavailable.", { code: "bad_secret" });
			return requestedSecretConflict(c.db, setupProjectKey(session.repository?.id), name);
		},

		internalSaveRequestedSecret: async (c, sessionId: string, input: RequestedSecretSave): Promise<void> => {
			const uid = c.key[0]!;
			requireServiceFor(c, secretsCaller(uid, sessionId));
			const session = c.vars.sessions.get(sessionId);
			if (!session || !validRequestedSecretName(input.name)) throw new UserError("That secret request is unavailable.", { code: "bad_secret" });
			const project = setupProjectKey(session.repository?.id) ?? ACCOUNT_SECRET_PROJECT;
			if (project !== input.project) throw new UserError("The requested secret’s scope has changed.", { code: "bad_secret" });
			if (session.place.kind === "machine" && !await machineSecrets(c.db, session.place.machineId))
				throw new UserError("Enable sending secrets to this machine before continuing.", { code: "secrets_disabled" });
			const { name, sealed } = input;
			try {
				await c.db.transaction(async tx => {
					const [receipt] = await tx.execute("SELECT 1 FROM requested_secret_receipt WHERE session_id = ? AND request_id = ?", sessionId, input.requestId);
					if (receipt) {
						// An item recovering after a restart replays the exact ciphertext it already saved.
						const same = project === ACCOUNT_SECRET_PROJECT
							? await tx.execute("SELECT 1 FROM account_secret WHERE name = ? AND sealed = ? AND scope = 'agent'", name, sealed)
							: await tx.execute("SELECT 1 FROM repo_secret WHERE project = ? AND name = ? AND sealed = ? AND scope = 'agent'", project, name, sealed);
						if (same.length) return;
						throw new UserError("The saved secret was changed under Secrets.", { code: "bad_secret" });
					}
					const conflict = await requestedSecretConflict(tx, project, name, "person");
					if (conflict) throw new UserError(conflict, { code: "secret_exists" });
					if (project === ACCOUNT_SECRET_PROJECT) await saveAccountSecret(tx, name, "agent", sealed, Date.now());
					else {
						const repo = session.repository!;
						checkSecretLimit(await saveRepoSecret(tx, { uid, project, label: `${repo.owner}/${repo.name}`, name, scope: "agent", sealed, now: Date.now() }));
					}
					await tx.execute("INSERT OR REPLACE INTO requested_secret_receipt VALUES (?, ?)", sessionId, input.requestId);
					if (session.harness && session.harness !== "windlass")
						await tx.execute("INSERT OR IGNORE INTO session_secret_grant VALUES (?, ?)", sessionId, name);
				});
			} catch (error) {
				if (error instanceof TooManySecrets) throw new UserError(error.message, { code: "too_many_secrets" });
				throw clientError(c.log, error, "The requested secret could not be saved.");
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
		internalSessionSecrets: async (c, sessionId: string, includeSnapshotSetup = false): Promise<SealedSecrets> => {
			const id = approvalText(sessionId, 200);
			requireServiceFor(c, secretsCaller(c.key[0]!, id));
			// A session this user does not have is handed nothing, of the account's either.
			const session = c.vars.sessions.get(id);
			if (!session) return { project: null, secrets: [], checks: [], account: { secrets: [], servers: [] } };
			const send = session.place.kind === "hosted" || await machineSecrets(c.db, session.place.machineId) === true;
			const requestedNames = send && session.harness && session.harness !== "windlass"
				? (await c.db.execute<{ name: string }>("SELECT name FROM session_secret_grant WHERE session_id = ?", id)).map(row => row.name) : undefined;
			const redactOnly = !send && !!session.harness && session.harness !== "windlass";
			const kept = send || redactOnly ? await c.db.execute<{ name: string; scope: string; sealed: string }>("SELECT name, scope, sealed FROM account_secret ORDER BY name") : [];
			await refreshSecretRows(c.db, serverSealer(), c.key[0], ACCOUNT_SECRET_PROJECT, kept);
			const account = {
				secrets: kept.map((row) => ({ name: row.name, scope: row.scope === "agent" ? ("agent" as const) : ("setup" as const), sealed: row.sealed })),
				servers: (await readServers(c.db)).map(({ name, definition, unasked }) => ({ name, definition, unasked })),
			};
			const project = setupProjectKey(session.repository?.id);
			if (project === null) return { project: null, secrets: [], checks: [], account, requestedNames, ...(redactOnly && { redactOnly }) };
			// The hosts its repository's list allows, for a hosted sandbox. A cross-repo feature's own session reads every
			// repository of the feature, and is given the hosts of each one's list (`unionHosts`).
			const feature = session.item?.role === "builder" ? c.vars.items.items.get(session.item.id) : undefined;
			const others = (feature?.repositories ?? []).filter(r => String(r.repositoryId) !== String(session.repository?.id));
			const lists = session.place.kind === "hosted" ? [await readNetwork(c.db, project), ...await Promise.all(others.map(r => readNetwork(c.db, setupProjectKey(r.repositoryId)!)))] : [];
			// The others fill only the room the deployment's own hosts leave: the primary's list comes first.
			const network = lists.length > 1 ? unionHosts(lists.map(list => list.hosts), networkLimit(await deploymentHostsForLimit())) : lists[0]?.hosts ?? [];
			const rows = send || redactOnly ? await c.db.execute<{ name: string; scope: string; sealed: string }>("SELECT name, scope, sealed FROM repo_secret WHERE project = ? ORDER BY name", project) : [];
			await refreshSecretRows(c.db, serverSealer(), c.key[0], project, rows);
			const { checks } = await readChecks(c.db, project);
			const connectedAt = c.vars.github?.connectedAt;
			const setup = includeSnapshotSetup && snapshotsFor(session.place) && connectedAt !== undefined && !rows.length ? await setupRow(c.db, project) : undefined;
			const snapshotSetup = setup && connectedAt !== undefined ? { command: setup.command, updatedAt: setup.updated_at,
				connectedAt, previouslySaved: setup.snapshot_connection === connectedAt } : undefined;
			const environment = snapshotSetup?.command ? await sessionEnvironment(c, project, session.place.kind === "hosted" ? HOSTED : session.place.machineId, snapshotSetup.command, checks, session.hostedSize) : undefined;
			return { project, requestedNames, network, ...(snapshotSetup?.command && { snapshotSetup }), ...(environment && { environment }), ...(redactOnly && { redactOnly }), screenshots: (await readDefaults(c.db, project)).screenshots, secrets: rows.map((row) => ({ name: row.name, scope: row.scope === "agent" ? "agent" : "setup", sealed: row.sealed })), checks, account };
		},

		// --- a repository's page ----------------------------------------------------------------------

		repository: async (c, repositoryId: GithubId): Promise<RepositoryView> => {
			requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				return await repositoryView(c, repositoryId, project);
			} catch (error) {
				throw clientError(c.log, error, "What is saved for the repository could not be read. Try again.");
			}
		},

		/** Asks GitHub whether the user's connection still reaches the repository, and what it is called now. */
		githubRepository: async (c, repositoryId: GithubId): Promise<GithubRepository> => {
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
				for (const table of ["setup_command", "repository_checks", "repo_secret", "repository_defaults", "repository_network"]) await c.db.execute(`UPDATE ${table} SET label = ? WHERE project = ? AND label != ?`, name, project, name);
			} catch (error) {
				c.log.warn({ msg: "could not note what a repository is called now", project, error: String(error) });
			}
			return found;
		},

		saveRepositoryDefaults: async (c, input: { repositoryId: GithubId; autoApprovePlans?: boolean; autoMergeSingles?: boolean; screenshots?: boolean; profile?: string | null; model?: string | null; hostedSize?: string | null }): Promise<RepositoryDefaults> => {
			const profile = requireUser(c);
			const project = setupKeyOf(input?.repositoryId);
			let change: DefaultsChange;
			try {
				const layer = await getLayer();
				change = cleanDefaults(input, layer.sandboxes.profiles(), await modelsOf(c, profile.demo), sizesOf(c, layer).map(size => size.id));
				if (change.screenshots === true && !config.factory.screenshots) throw new DefaultsProblem("bad_input", "Screenshots are turned off for this whole deployment, so they cannot be turned on for a repository.");
			} catch (error) {
				if (error instanceof DefaultsProblem) throw new UserError(error.message, { code: error.code });
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
			try {
				const saved = await saveDefaults(c.db, project, await labelFor(c, input.repositoryId, project), change, Date.now());
				console.log(`[wlp] defaults.saved uid=${profile.uid} project=${project}${change.profile === undefined ? "" : ` profile=${change.profile ?? "none"}`}${change.model === undefined ? "" : ` model=${change.model ?? "none"}`}${change.hostedSize === undefined ? "" : ` hosted_size=${change.hostedSize ?? "none"}`}`);
				return saved;
			} catch (error) {
				throw clientError(c.log, error, "The defaults could not be saved. Try again.");
			}
		},

		forgetRepositoryApproval: async (c, input: { repositoryId: GithubId; name: string }): Promise<RepositoryView> => {
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

		forgetRepository: async (c, repositoryId: GithubId): Promise<RepositoryView> => {
			const profile = requireUser(c);
			const project = setupKeyOf(repositoryId);
			try {
				// The secrets first: if anything after them fails, what is left holds no value.
				await c.db.execute("DELETE FROM repo_secret WHERE project = ?", project);
				await c.db.execute("DELETE FROM setup_command WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_checks WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_defaults WHERE project = ?", project);
				await c.db.execute("DELETE FROM repository_network WHERE project = ?", project);
				await c.db.execute("DELETE FROM network_request WHERE project = ?", project);
				await forgetEnvironments(environmentHost(c), project);
				const done = await changeApprovals(c, (book) => book.forgetProject(project));
				await dropHostedSnapshots(profile.uid, String(repositoryId));
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
					"SELECT project, MAX(label) AS label FROM (SELECT project, label FROM setup_command UNION ALL SELECT project, label FROM repository_checks UNION ALL SELECT project, label FROM repo_secret UNION ALL SELECT project, label FROM repository_defaults UNION ALL SELECT project, label FROM repository_network) GROUP BY project",
				);
				const now = Date.now();
				const found = new Map<GithubId, string>();
				const note = (project: string, label: string) => {
					const id = repositoryIdOf(project);
					if (id !== null && (found.get(id) ?? "") === "") found.set(id, label);
				};
				for (const row of rows) note(row.project, row.label);
				for (const approval of c.vars.approvals.all()) if (approval.expiresAt > now) note(approval.project, approval.label);
				return [...found]
					.map(([id, label]) => ({ id, name: repositoryLabel(c.vars, id) || label || null }))
					// By name, and those nothing names after them.
					.sort((a, b) => Number(a.name === null) - Number(b.name === null) || (a.name ?? "").localeCompare(b.name ?? "") || String(a.id).localeCompare(String(b.id), "en", { numeric: true }))
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

		forgetLastStart: async (c): Promise<AccountSettings> => {
			const profile = requireUser(c);
			try {
				await forgetLastStart(c.db);
				console.log(`[wlp] last_start.forgotten uid=${profile.uid}`);
				return await accountView(c.db);
			} catch (error) {
				throw clientError(c.log, error, "Where your last agent ran could not be forgotten. Try again.");
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
			const profile = await secretProfile(input?.profile);
			try {
				return await listAccountSecrets(c.db, profile);
			} catch (error) {
				throw clientError(c.log, error, "Your account's secrets could not be read. Try again.");
			}
		},

		saveAccountSecret: async (c, input: { profile: string; name: string; value?: string; scope: SecretScope }): Promise<AccountSecrets> => {
			const user = requireUser(c);
			const profile = await secretProfile(input?.profile);
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
			const profile = await secretProfile(input?.profile);
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

		internalUpdateGithubInstallation: async (c, change: InstallationChange) => {
			requireServiceFor(c, "call");
			await updateGithubInstallation(c, c.key[0], change);
		},

		[GITHUB_SYNC.action]: async (c, attempt: number) => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			await retryGithubSync(c, c.key[0]!, c.scheduledFire.id, attempt);
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
				if (c.vars.machines.size) await machinesChanged(c);
				queueChanged(c);
				await notifyProviderWaits(c, c.vars.items.items.values(), true);
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
				await logoutMachines(c);
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
			await storeReport(c, summary);
			if (c.vars.sessions.get(summary.id)?.status === "idle") queueChanged(c);
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

		internalCheckLaunch: async (c, id: string, until: number): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			if (c.vars.launchUntil.get(id) !== until) return;
			const entry = c.vars.sessions.get(id);
			if (!entry) return;
			const fresh = await sessionActor(c, c.key[0], id).internalSummary().catch((error: unknown) => {
				if (isSessionGone(error)) return null;
				throw error;
			});
			if (c.vars.launchUntil.get(id) !== until) return;
			if (fresh) await storeReport(c, fresh, until);
			else if (c.vars.sessions.get(id) === entry) await forgetSession(c, id);
			queueChanged(c);
		},

		internalAcquireRun: async (c, sessionId: string): Promise<{ dailyTokenWait?: string; ok: boolean; running: number; known: boolean; until: number | null; claim: number | null }> => {
			requireService(c);
			const uid = c.key[0];
			// An item session's turn holds a slot of the turn queue (user-items.ts), counted here instead of by its summary.
			// A session on one of the user's machines is neither counted nor refused (`hostedLimitsApply`).
			const others = () => [...c.vars.sessions.values()].filter((session) => session.id !== sessionId && !session.item && session.status !== "idle" && hostedLimitsApply(session.place));
			// One ceiling on what the platform pays for: the user's hosted sandboxes at work, their own and their items' (`hostedRunning`).
			const atLimit = () => others().length + factorySlots(c) >= accountLimits(c.vars.items.limits).factory.hostedRunning;
			const asking = c.vars.sessions.get(sessionId);

			// At the limit, ask the sessions that look busy: one whose report never arrived would
			// otherwise block the user for good.
			if ((!asking || hostedLimitsApply(asking.place)) && atLimit()) {
				await Promise.all(
					others().map(async (stale) => {
						const checkedAt = Date.now();
						let fresh: SessionSummary | null = null;
						try {
							fresh = await sessionActor(c, uid, stale.id).internalSummary();
						} catch (error) {
							if (isSessionGone(error)) {
								if (c.vars.sessions.get(stale.id) === stale) await forgetSession(c, stale.id);
							} else c.log.warn({ msg: "could not refresh a session's summary", session: stale.id, error: String(error) });
						}
						if (fresh && c.vars.sessions.get(stale.id) === stale) await storeReport(c, fresh, checkedAt);
					}),
				);
			}

			// The user's index can still be a turn behind. The session asking for the slot
			// cannot start its next turn until we answer, so this is its actual starting count.
			const own = asking && hostedLimitsApply(asking.place) ? await sessionActor(c, uid, sessionId).internalSummary() : null;
			const tokenWait = asking && usesPlatformModel(asking.place, asking.harness) ? accountTokenWait(c) : null;
			// From here to the `set` nothing is awaited: the count and the claim are one step.
			const entry = c.vars.sessions.get(sessionId);
			if (!entry) return { ok: false, running: others().length, known: false, until: null, claim: null };
			const running = others().length;
			if (tokenWait) return { dailyTokenWait: tokenWait, ok: false, running, known: true, until: null, claim: null };
			if (hostedLimitsApply(entry.place) && atLimit()) return { ok: false, running: running + factorySlots(c), known: true, until: null, claim: null };
			const claimed: SessionSummary = { ...entry, turns: own?.turns ?? entry.turns, status: entry.status === "idle" ? "starting" : entry.status };
			// The lease lapses at `until` (`internalCheckLaunch`); the claim is named by its generation (`internalReleaseRun`), one more
			// than any claim before it, taken in this same step: the time names nothing, since two claims can share a millisecond.
			const until = hostedLimitsApply(entry.place) ? Math.max(Date.now() + LAUNCH_LEASE_MS, (c.vars.launchUntil.get(sessionId) ?? 0) + 1) : null;
			const claim = until === null ? null : ++c.vars.launchGen;
			if (until !== null) c.vars.launchUntil.set(sessionId, until);
			if (claim !== null) c.vars.launchClaim.set(sessionId, claim);
			c.vars.sessions.set(sessionId, claimed);

			if (claim !== null) await c.db.execute("INSERT INTO launch_counter (id, last) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last = MAX(last, excluded.last)", claim);
			if (until !== null) await c.schedule.at(until, "internalCheckLaunch", sessionId, until);
			await c.db.execute("UPDATE sessions SET summary = ?, launch_until = ?, launch_claim = ? WHERE id = ?", JSON.stringify(claimed), until, claim, sessionId);
			broadcastSessions(c);
			return { ok: true, running: running + factorySlots(c) + 1, known: true, until, claim };
		},

		/**
		 * Gives back the running slot `internalAcquireRun` claimed for a prompt that the session then refused
		 * (its sandbox time or its place, or a delete meanwhile), so that the user's other agents are not kept
		 * from starting until the launch check, a minute later. Only the claim named by `claim` is given back:
		 * a release that arrives after a newer claim of the same session, or after a report or the launch
		 * check settled this one, finds another name or none, and changes nothing. `summary` is the session's
		 * own after the refusal. A release that never arrives leaves the claim to the launch check, as before.
		 */
		internalReleaseRun: async (c, input: { sessionId: string; claim: number; summary: SessionSummary }): Promise<{ released: boolean }> => {
			requireService(c);
			const sessionId = input?.sessionId;
			if (typeof sessionId !== "string" || typeof input.claim !== "number" || input.summary?.id !== sessionId) {
				throw new UserError("A session, its claim and its summary are needed.", { code: "bad_request" });
			}
			// From the check to the delete nothing is awaited: a claim made meanwhile cannot be the one released.
			if (c.vars.launchClaim.get(sessionId) !== input.claim) return { released: false };
			c.vars.launchUntil.delete(sessionId);
			c.vars.launchClaim.delete(sessionId);
			await storeReport(c, input.summary);
			queueChanged(c);
			console.log(`[wlp] run.released uid=${c.key[0]} session=${sessionId}`);
			return { released: true };
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
			const settle = typeof input.settle?.hold === "string" && typeof input.settle.seconds === "number" ? { hold: input.settle.hold, seconds: input.settle.seconds, observedUntil: input.settle.observedUntil } : undefined;
			const keep = input.keep === true;
			const renewal = input.fresh !== true && settle !== undefined;
			if (reserveFault) {
				if (input.fresh && reserveFault.delayMs) await new Promise((done) => setTimeout(done, reserveFault.delayMs));
				if (renewal && reserveFault.downMs > 0 && reserveFault.downUntil === null) reserveFault.downUntil = Date.now() + reserveFault.downMs;
				if (reserveFault.downUntil !== null && Date.now() < reserveFault.downUntil) {
					console.log(`[wlp] usage.fault_down uid=${c.key[0]} session=${session} hold=${id}: refused (WLP_FAKE_RESERVE_FAULT)`);
					throw new Error("the user's actor is away (WLP_FAKE_RESERVE_FAULT)");
				}
			}
			// A session that is being deleted is given nothing new.
			if (!c.vars.sessions.has(session)) return { ok: false, reason: "gone", numbers: c.vars.usage.numbers(Date.now()) };
			if (keep) await reconcileKept(c, c.vars.usage.atCap(session));

			const now = Date.now();
			const size = isHostedSize(input.hostedSize) ? input.hostedSize : c.vars.sessions.get(session)?.hostedSize;
			const clampedSize = keep ? clampedSandboxSize(c, size) : undefined;
			const weight = size ? sessionWeight({ hostedSize: clampedSize ?? size }) : undefined;
			const done = await changeUsage(c, (book) => book.reserve(now, { id, session, keep, weight, fresh: input.fresh === true, settle }));
			const numbers = c.vars.usage.numbers(now);
			const lose = reserveFault === null ? null : input.fresh === true ? "fresh" : renewal ? "renewal" : null;
			if (reserveFault && lose && reserveFault[lose] > 0) {
				reserveFault[lose] -= 1;
				console.log(`[wlp] usage.fault_lost uid=${c.key[0]} session=${session} hold=${id} ${lose}: done, and its reply lost (WLP_FAKE_RESERVE_FAULT)`);
				throw new Error("reply lost (WLP_FAKE_RESERVE_FAULT)");
			}
			if (!done.ok) {
				console.log(`[wlp] usage.refused uid=${c.key[0]} session=${session} limit=${done.reason} used=${numbers.usedSeconds} held=${numbers.heldSeconds} allowance=${numbers.allowanceSeconds ?? "none"} kept=${numbers.sandboxes.kept} of ${numbers.sandboxes.limit ?? "any"}`);
				return { ok: false, reason: done.reason, numbers };
			}
			return { ok: true, ...(clampedSize && { clampedSize }), hold: { id: done.hold.id, seconds: done.hold.seconds }, numbers };
		},

		/**
		 * The session is about to make its sandbox: its place among the kept ones, taken where the sandbox is
		 * made (`UsageBook.claim`). A reserve's place was the session's as it stood then, and a sandbox found
		 * gone since is replaced here. Held against the provider's list first, as a reserve is.
		 */
		internalClaimPlace: async (c, sessionId: string, hostedSize?: HostedSize): Promise<{ ok: boolean; clampedSize?: HostedSize; numbers: UsageNumbers } | { ok: false; reason: "gone" }> => {
			requireService(c);
			const session = approvalText(sessionId, 200);
			await reconcileKept(c, c.vars.usage.atCap(session));
			// From the check to the claim nothing is awaited: a session being deleted is given nothing new.
			if (!c.vars.sessions.has(session)) return { ok: false, reason: "gone" };
			const now = Date.now();
			const done = await changeUsage(c, (book) => book.claim(now, session));
			const numbers = c.vars.usage.numbers(now);
			if (!done.ok) console.log(`[wlp] usage.refused uid=${c.key[0]} session=${session} limit=sandboxes kept=${numbers.sandboxes.kept} of ${numbers.sandboxes.limit ?? "any"}: at the making of its sandbox`);
			const clampedSize = clampedSandboxSize(c, hostedSize);
			return { ok: done.ok, ...(clampedSize && { clampedSize }), numbers };
		},

		internalSettle: async (c, input: HoldReport & { sessionId: string }): Promise<{ known: boolean }> => {
			requireService(c);
			const session = approvalText(input?.sessionId, 200);
			const hold = approvalText(input?.hold, 64);
			const done = await changeUsage(c, (book) => book.settle(Date.now(), { session, hold, observedUntil: input?.observedUntil, seconds: typeof input?.seconds === "number" ? input.seconds : Number.NaN }));
			return { known: done.known };
		},

		/** The server's sweep (index.ts): the user's hosted sandboxes whose session is gone are removed, and the count held against the rest. */
internalSweepSandboxes: async (c): Promise<void> => {
	requireService(c);
	await reconcileKept(c, true);
},

internalRelease: async (c, sessionId: string): Promise<void> => {
			requireService(c);
			await changeUsage(c, (book) => ({ change: book.release(approvalText(sessionId, 200)) }));
		},
	},
});
