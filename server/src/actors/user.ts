/**
 * `user`, key [uid]: a user's profile, the index of their sessions, and their ChatGPT sign-in.
 *
 * Stored in SQLite: the profile last seen on a valid token, one row per session holding its summary,
 * and the sign-in. The summaries are also held in memory so that counting the running sessions and
 * marking one as running happen in one synchronous step.
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
 */

import { randomBytes } from "node:crypto";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, maySubscribe, requireService, requireUser } from "../auth.js";
import { config } from "../config.js";
import {
	type ChatgptStatus,
	type CreateSessionInput,
	type GithubBranchList,
	type GithubRepositoryList,
	type GithubStatus,
	MAX_RUNNING_SESSIONS,
	MAX_TITLE_CHARS,
	type SessionSummary,
	type UserProfile,
} from "../contract.js";
import { githubApp, type GithubApp } from "../github/app.js";
import { isBranchName } from "../github/git.js";
import type { StoredRepository } from "../github/publish.js";
import { GithubProblem, type StoredConnection, forgetGithubCaches, listBranches, listRepositories, resolveRepository } from "../github/repos.js";
import { STATE_TTL_MS, TICKET_TTL_MS, issueState, newCodeVerifier, newNonce, verifyTicket } from "../github/state.js";
import { getLayer } from "../layer.js";
import { platformModels } from "../platform-info.js";
import type { ChatgptAccount } from "../sandbox/api.js";
import { ApprovalBook, type BookChange, type ServerApproval, sessionProjectKey } from "../server-approvals.js";
import { type SealedTokenAnswer, type SignInAnswer, problemOf, tokenSubject } from "../signin/directory.js";
import { SignInHolder, type StoredSignIn } from "../signin/holder.js";
import { getSignIns } from "../signin/index.js";
import { uidOfAccount } from "../signin/material.js";
import { createSessionActor, isActorGone, sessionActor } from "./internal.js";

export const DEFAULT_TITLE = "New agent";
const MAX_REPO_URL_CHARS = 300;

interface ConnParams {
	token?: string;
}

interface UserVars {
	profile: UserProfile | null;
	/** False until a valid token of this user has been seen: until then the actor may be a stranger's doing. */
	reached: boolean;
	sessions: Map<string, SessionSummary>;
	/** The user's sign-in and token source, made when first needed: a demo user never has one. */
	signIn: Promise<SignInHolder> | null;
	/** The database as the action that is running now has it: what the holder's store reads and writes. */
	signInDb: RawAccess | null;
	/** The user's remembered approvals of projects' MCP servers, as the table has them. */
	approvals: ApprovalBook;
	/** The user's GitHub connection; null when there is none. */
	github: StoredConnection | null;
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

interface UserCtx {
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

async function storeSession(c: UserCtx, summary: SessionSummary): Promise<void> {
	await c.db.execute(
		"INSERT INTO sessions (id, created_at, summary) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary",
		summary.id,
		summary.createdAt,
		JSON.stringify(summary),
	);
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
		},
	}),

	createVars: async (c): Promise<UserVars> => {
		const [row] = await c.db.execute<{ uid: string; email: string | null; demo: number }>("SELECT uid, email, demo FROM profile WHERE id = 1");
		const rows = await c.db.execute<{ summary: string }>("SELECT summary FROM sessions");
		const sessions = new Map<string, SessionSummary>();
		for (const { summary } of rows) {
			const parsed = JSON.parse(summary) as SessionSummary;
			sessions.set(parsed.id, parsed);
		}
		// An actor that holds a sign-in is a user's, also before that user's own token was seen here.
		const [held] = await c.db.execute<{ id: number }>("SELECT id FROM signin WHERE id = 1");
		const [connected] = await c.db.execute<{ connection: string }>("SELECT connection FROM github WHERE id = 1");
		const github = connected ? (JSON.parse(connected.connection) as StoredConnection) : null;
		const approvals = new ApprovalBook(await readApprovals(c.db), config.serverApprovalTtlMs);
		return { profile: row ? { uid: row.uid, email: row.email, demo: row.demo === 1 } : null, reached: row !== undefined || held !== undefined, sessions, signIn: null, signInDb: null, approvals, github };
	},

	events: {
		sessions: event<SessionSummary[]>({ canSubscribe: (c) => maySubscribe(c) }),
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
				console.log(`[wlp] sign-in.forgotten uid=${profile.uid}`);
			} catch (error) {
				throw clientError(c.log, error, "The ChatGPT sign-in could not be forgotten. Try again.");
			}
		},

		listSessions: (c): SessionSummary[] => {
			requireUser(c);
			return sessionList(c.vars);
		},

		createSession: async (c, input: CreateSessionInput): Promise<SessionSummary> => {
			const profile = requireUser(c);
			if (typeof input !== "object" || input === null) throw new UserError("Choose a sandbox for the agent.", { code: "bad_input" });
			let repoUrl = cleanRepoUrl(input.repoUrl);
			const givenTitle = input.title === undefined || input.title === null ? null : cleanTitle(input.title);
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
				const { sandboxes } = await getLayer();
				const chosen = sandboxes.profiles().find((candidate) => candidate.id === input.profile);
				if (!chosen) throw new UserError("That sandbox does not exist.", { code: "bad_profile" });
				if (!chosen.available) {
					throw new UserError(`${chosen.name} cannot be chosen yet. ${chosen.unavailableReason ?? ""}`.trim(), { code: "profile_unavailable" });
				}
				const models = await platformModels();
				const model = input.model === undefined || input.model === null || input.model === "" ? models[0] : input.model;
				if (typeof model !== "string" || !models.includes(model)) {
					throw new UserError(`That model is not offered. Choose one of: ${models.join(", ")}`, { code: "bad_model" });
				}

				const now = Date.now();
				summary = {
					id: `s_${randomBytes(8).toString("hex")}`,
					title: givenTitle ?? DEFAULT_TITLE,
					profile: chosen.id,
					model,
					repoUrl,
					...(repo ? { repository: { provider: repo.provider, id: repo.id, owner: repo.owner, name: repo.name, branch: repo.branch, private: repo.private, url: repo.url }, pullRequest: null } : {}),
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
					profile: summary.profile,
					model,
					repoUrl,
					repo,
					demo: profile.demo,
					createdAt: now,
				});
			} catch (error) {
				throw clientError(c.log, error, "The agent could not be created. Try again.");
			}

			c.vars.sessions.set(summary.id, summary);
			await storeSession(c, summary);
			broadcastSessions(c);
			return summary;
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
			// A session with no repository was its own project: what was approved for it goes with it.
			await changeApprovals(c, (book) => book.forgetProject(sessionProjectKey(id))).catch((error) => c.log.warn({ msg: "could not forget the deleted session's approvals of MCP servers", session: id, error: String(error) }));
			broadcastSessions(c);
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

		// --- called by `agentSession` only -------------------------------------------------------

		internalSessionChanged: async (c, summary: SessionSummary): Promise<void> => {
			requireService(c);
			if (typeof summary?.id !== "string" || !c.vars.sessions.has(summary.id)) return;
			c.vars.sessions.set(summary.id, summary);
			await c.db.execute("UPDATE sessions SET summary = ? WHERE id = ?", JSON.stringify(summary), summary.id);
			broadcastSessions(c);
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
	},
});
