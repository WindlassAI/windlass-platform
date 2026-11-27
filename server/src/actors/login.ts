/** One short-lived OAuth or demo login attempt. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor, clientError, serviceParams } from "../auth.js";
import { config } from "../config.js";
import type { AuthResult, LoginProvider, LoginStart, UserProfile } from "../contract.js";
import { NOT_INVITED, mayUse } from "../access.js";
import { getLayer } from "../layer.js";
import { beginOAuth, finishOAuth, type Identity, type OAuthAttempt } from "../platform-login.js";
import { SealError, serverSealer } from "../signin/seal.js";
import { grantIsValid } from "./internal.js";
import { issueUserToken } from "../tokens.js";

/** How long a started attempt is accepted: ten minutes. */
const ATTEMPT_TTL_MS = config.loginTtlMs;
/** How long the actor stays after it has issued a token, so the reply reaches the client first. */
const CLEANUP_DELAY_MS = 3_000;
/** The attempt id is part of what a sealed attempt is bound to, and it may name things at a provider, so it is held to a safe alphabet. */
const browserHash = (secret: unknown) =>
	typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret)
		? createHash("sha256").update(secret).digest("hex")
		: null;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

interface Attempt {
	/** `new`: nothing started. `started`: waiting for the OAuth callback. `done`: a token was issued. */
	state: "new" | "started" | "done";
	expiresAt: number;
	/** The sealed OAuth verifier or the verified identity awaiting token issuance. */
	sealed: string | null;
	/**
	 * The `expire` schedule that ends the attempt. A new one is set and stored before the one it
	 * replaces is cancelled, so the attempt always has one; a firing of another does nothing.
	 */
	scheduleId: string | null;
	/** Set when an attempt that held material was emptied because it expired: said when the actor goes. */
	discarded?: boolean;
}

interface LoginVars {
	attempt: Attempt;
	busy: boolean;
}

type AttemptRow = {
	state: Attempt["state"];
	expires_at: number;
	sealed: string | null;
	schedule_id: string | null;
};

async function save(c: { db: RawAccess; vars: LoginVars }): Promise<void> {
	const { state, expiresAt, sealed, scheduleId } = c.vars.attempt;
	await c.db.execute(
		"UPDATE attempt SET state = ?, expires_at = ?, sealed = ?, schedule_id = ? WHERE id = 1",
		state,
		expiresAt,
		sealed,
		scheduleId,
	);
}

/** One sign-in step at a time: the steps talk to the sandbox layer and must not interleave. */
async function exclusive<T>(vars: LoginVars, step: () => Promise<T>): Promise<T> {
	if (vars.busy) throw new UserError("This sign-in is busy. Try again in a moment.", { code: "busy" });
	vars.busy = true;
	try {
		return await step();
	} finally {
		vars.busy = false;
	}
}

export const login = actor({
	options: { name: "Login", icon: "right-to-bracket", actionTimeout: 150_000 },

	db: db({
		onMigrate: async db => {
			await db.execute(`
				CREATE TABLE IF NOT EXISTS attempt (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					state TEXT NOT NULL,
					expires_at INTEGER NOT NULL,
					schedule_id TEXT,
					sealed TEXT
				)
			`);
			const columns = await db.execute<{ name: string }>("PRAGMA table_info(attempt)");
			if (!columns.some(column => column.name === "failures"))
				await db.execute("ALTER TABLE attempt ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");
		},
	}),

	onCreate: async (c, input?: { grant: string }) => {
		if (!grantIsValid(input?.grant, c.key, "login")) {
			c.destroy();
			return;
		}
		const expiresAt = Date.now() + ATTEMPT_TTL_MS;
		// An attempt nobody finishes is removed, whether or not it was ever started.
		const scheduleId = await c.schedule.after(ATTEMPT_TTL_MS + 1_000, "expire");
		await c.db.execute(
			"INSERT OR REPLACE INTO attempt (id, state, expires_at, schedule_id) VALUES (1, 'new', ?, ?)",
			expiresAt,
			scheduleId,
		);
	},

	createVars: async (c): Promise<LoginVars> => {
		const [row] = await c.db.execute<AttemptRow>(
			"SELECT state, expires_at, sealed, schedule_id FROM attempt WHERE id = 1",
		);
		if (row?.sealed && !serverSealer().isCurrent(row.sealed)) {
			const sealer = serverSealer();
			try {
				const next = sealer.seal("attempt", c.key[0], sealer.open("attempt", c.key[0], row.sealed));
				await c.db.execute("UPDATE attempt SET sealed = ? WHERE id = 1 AND sealed = ?", next, row.sealed);
				row.sealed = next;
			} catch (error) {
				// An unreadable attempt still expires.
				if (!(error instanceof SealError)) throw error;
			}
		}
		return {
			attempt: row
				? { state: row.state, expiresAt: row.expires_at, sealed: row.sealed, scheduleId: row.schedule_id }
				: { state: "new", expiresAt: Date.now() + ATTEMPT_TTL_MS, sealed: null, scheduleId: null },
			busy: false,
		};
	},

	onBeforeConnect: internalConnection,

	// Runs when the attempt expires and when the actor has done its job. What an unfinished attempt
	// held was in this actor's storage only (`expire` has emptied it), and goes with the actor.
	onDestroy: c => {
		if (c.vars.attempt.state !== "done" && c.vars.attempt.discarded)
			console.log(`[wlp] login.discarded attempt=${c.key[0]}`);
	},

	actions: {
		start: (c, provider: LoginProvider, origin: string, secret: string, owner: string | null): Promise<LoginStart> =>
			exclusive(c.vars, async () => {
				requireServiceFor(c, "call");
				const attemptId = c.key[0];
				if (c.key.length !== 1 || !ATTEMPT_ID.test(attemptId ?? "")) {
					throw new UserError("The sign-in attempt's id must be 8 to 64 letters, digits, dashes or underscores.", {
						code: "bad_attempt_id",
					});
				}
				const attempt = c.vars.attempt;
				if (attempt.state === "started")
					throw new UserError("This sign-in has already started.", { code: "attempt_started" });
				const binding = browserHash(secret);
				if (!binding) throw new UserError("Start sign-in in this tab.", { code: "bad_browser" });
				if (attempt.state === "done")
					throw new UserError("This sign-in is already finished.", { code: "attempt_done" });
				try {
					const { pending, url } = beginOAuth(provider, origin);
					const sealed = serverSealer().seal("attempt", attemptId, JSON.stringify({ pending, binding, owner }));
					attempt.sealed = sealed;
					attempt.state = "started";
					await save(c);
					return { url, redirectPrefix: pending.redirect, expiresAt: attempt.expiresAt };
				} catch (error) {
					throw clientError(c.log, error, "The sign-in could not be started. Try again.");
				}
			}),

		finish: (c, callback: string, secret: string, session: AuthResult | null): Promise<AuthResult> =>
			exclusive(c.vars, async () => {
				requireServiceFor(c, "call");
				const attemptId = c.key[0];
				const attempt = c.vars.attempt;
				if (attempt.state === "done")
					throw new UserError("This sign-in is already finished.", { code: "attempt_done" });
				if (attempt.state !== "started" || attempt.sealed === null)
					throw new UserError("Start the sign-in first.", { code: "attempt_not_started" });
				if (Date.now() > attempt.expiresAt)
					throw new UserError("This sign-in attempt has expired. Start again.", { code: "attempt_expired" });

				const slot = await c.db.execute(
					"UPDATE attempt SET failures=failures+1 WHERE id=1 AND failures<5 RETURNING failures",
				);
				if (!slot.length) throw new UserError("Too many attempts. Start sign-in again.", { code: "attempt_locked" });
				if (typeof callback !== "string" || callback.trim() === "") {
					throw new UserError("Missing sign-in callback.", { code: "bad_input" });
				}
				if (callback.length > 8_192)
					throw new UserError("That address is too long to be the one the sign-in ended on.", { code: "bad_input" });
				try {
					const sealer = serverSealer();
					const saved = JSON.parse(sealer.open("attempt", attemptId, attempt.sealed)) as {
						binding: string;
						owner: string | null;
						pending?: OAuthAttempt;
						identity?: Identity;
						digest?: string;
					};
					const binding = browserHash(secret);
					if (!saved.binding || !binding || !timingSafeEqual(Buffer.from(binding), Buffer.from(saved.binding)))
						throw new UserError("Start sign-in in this tab.", { code: "bad_browser" });
					if (saved.owner !== (session?.profile.uid ?? null))
						throw new UserError("Return to the account that started this link.", { code: "wrong_account" });
					const digest = createHash("sha256").update(callback).digest("hex");
					let identity: Identity;
					if (saved.pending) {
						identity = await finishOAuth(saved.pending, callback, !saved.owner && !!config.access.allowed?.emails.size);
						// Preserve a successful code exchange across a failed handover, only for this callback.
						attempt.sealed = sealer.seal(
							"attempt",
							attemptId,
							JSON.stringify({ identity, digest, binding: saved.binding, owner: saved.owner }),
						);
						await save(c);
					} else if (saved.identity && saved.digest === digest) {
						identity = saved.identity;
					} else throw new UserError("Start the sign-in again.", { code: "invalid_callback" });
					const directory = c.client().accountIdentities.getOrCreate(["platform"], { params: serviceParams() });
					let result: AuthResult;
					if (session) {
						await c
							.client()
							.user.get([session.profile.uid], { params: { token: session.token } })
							.me();
						await directory.internalLink(session.profile.uid, identity);
						result = session;
					} else {
						const uid: string | null = await directory.internalResolve(identity);
						if (!uid || !mayUse({ uid, email: identity.email, demo: false }, config.access)) {
							if (identity.emailPermissionMissing)
								throw new UserError("The GitHub App needs the Email addresses permission", {
									code: "email_permission",
								});
							throw new UserError(NOT_INVITED, { code: "not_invited" });
						}
						const profile: UserProfile = { uid, email: identity.email, demo: false };
						const generation: number = await c
							.client()
							.user.getOrCreate([uid], { params: serviceParams() })
							.internalLogin(profile);
						await (await getLayer()).logins.ensureUserVolume(uid);
						result = { token: issueUserToken(profile, generation), profile };
					}
					const replaced = attempt.scheduleId;
					attempt.scheduleId = await c.schedule.after(CLEANUP_DELAY_MS, "expire");
					attempt.sealed = null;
					attempt.state = "done";
					await save(c);
					if (replaced) await c.schedule.cancel(replaced).catch(() => false);
					return result;
				} catch (error) {
					await save(c).catch(() => undefined);
					if ((error as { code?: string }).code === "identity_linked")
						throw new UserError("That login identity or provider is already linked.", { code: "identity_linked" });
					throw clientError(c.log, error, "The sign-in could not be finished. Please try again.");
				}
			}),

		demo: (c): Promise<AuthResult> =>
			exclusive(c.vars, async () => {
				requireServiceFor(c, "call");
				if (!config.demo)
					throw new UserError("The demo sign-in is not enabled on this server.", { code: "demo_disabled" });
				const attempt = c.vars.attempt;
				if (attempt.state === "done")
					throw new UserError("This sign-in is already finished.", { code: "attempt_done" });
				try {
					if (attempt.state !== "new") throw new UserError("This attempt is in use.", { code: "attempt_started" });
					const { logins } = await getLayer();
					const uid = `demo_${randomBytes(6).toString("hex")}`;
					const profile: UserProfile = { uid, email: null, demo: true };
					const generation: number = await c
						.client()
						.user.getOrCreate([uid], { params: serviceParams() })
						.internalLogin(profile);
					await logins.ensureUserVolume(uid);

					const token = issueUserToken(profile, generation);
					const replaced = attempt.scheduleId;
					attempt.scheduleId = await c.schedule.after(CLEANUP_DELAY_MS, "expire");
					attempt.state = "done";
					await save(c);
					if (replaced) await c.schedule.cancel(replaced).catch(() => false);
					return { token, profile };
				} catch (error) {
					throw clientError(c.log, error, "The demo sign-in failed. Try again.");
				}
			}),

		/** Run by the schedule only: removes the actor, and with it an unfinished attempt. */
		expire: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const attempt = c.vars.attempt;
			// A schedule that a later one took the place of, and whose cancel did not reach it: the later one will come.
			if (attempt.scheduleId !== null && attempt.scheduleId !== c.scheduledFire.id) return;
			// A step is talking to the sandbox layer right now: let it end before the attempt is removed.
			if (c.vars.busy) {
				const later = await c.schedule.after(5_000, "expire");
				// A step that set a schedule of its own meanwhile keeps it, and this one does nothing when it comes.
				if (attempt.scheduleId !== c.scheduledFire.id) return;
				attempt.scheduleId = later;
				await save(c);
				return;
			}
			// What the attempt held goes before the actor does, whatever becomes of a destroyed actor's storage.
			if (attempt.sealed !== null) {
				attempt.sealed = null;
				attempt.discarded = true;
				await save(c);
			}
			c.destroy();
		},
	},
});
