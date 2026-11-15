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
 */

import { randomBytes } from "node:crypto";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, maySubscribe, requireService, requireUser } from "../auth.js";
import {
	type ChatgptStatus,
	type CreateSessionInput,
	MAX_RUNNING_SESSIONS,
	MAX_TITLE_CHARS,
	type SessionSummary,
	type UserProfile,
} from "../contract.js";
import { getLayer } from "../layer.js";
import { platformModels } from "../platform-info.js";
import type { ChatgptAccount } from "../sandbox/api.js";
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
		return { profile: row ? { uid: row.uid, email: row.email, demo: row.demo === 1 } : null, reached: row !== undefined || held !== undefined, sessions, signIn: null, signInDb: null };
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
			const repoUrl = cleanRepoUrl(input.repoUrl);
			const givenTitle = input.title === undefined || input.title === null ? null : cleanTitle(input.title);

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
			broadcastSessions(c);
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
