/**
 * `user`, key [uid]: a user's profile and the index of their sessions.
 *
 * Stored in SQLite: the profile last seen on a valid token, and one row per session holding its
 * summary. The summaries are also held in memory so that counting the running sessions and marking
 * one as running happen in one synchronous step.
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
		return { profile: row ? { uid: row.uid, email: row.email, demo: row.demo === 1 } : null, reached: row !== undefined, sessions };
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
				const { logins } = await getLayer();
				const account = await logins.status(profile.uid);
				if (!account) return { connected: false, email: null, accessExpiresAt: null };
				return { connected: true, email: account.email ?? null, accessExpiresAt: account.accessExpiresAt ?? null };
			} catch (error) {
				throw clientError(c.log, error, "The ChatGPT sign-in could not be checked.");
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
