/**
 * `login`, key [attemptId]: one sign-in attempt. Takes no credentials; it is what hands them out.
 *
 * The actor lives for one attempt: it destroys itself shortly after it has issued a token, or when the
 * attempt expires, and an unfinished attempt is gone with it.
 *
 * Between `start` and `finish` the attempt is what Windlass saved of the pending sign-in (the PKCE
 * verifier, state and nonce in `auth-pending.json`, and `host-id`). It is kept in this actor's storage,
 * sealed for this attempt with a key the storage does not hold (signin/seal.ts), and nowhere else: the
 * two steps may be served by different servers, and all that connects them is that blob. A finished
 * sign-in stays here only until the user's actor has taken it, sealed for that user.
 */

import { randomBytes } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, clientError, serviceParams } from "../auth.js";
import { config } from "../config.js";
import type { AuthResult, LoginStart, UserProfile } from "../contract.js";
import { NOT_INVITED, mayUse, normalizeEmail } from "../access.js";
import { getLayer } from "../layer.js";
import { claimAccountUid } from "./account-email.js";
import { SealError, serverSealer } from "../signin/seal.js";
import { issueUserToken } from "../tokens.js";

/** How long a started attempt is accepted: ten minutes. */
const ATTEMPT_TTL_MS = config.loginTtlMs;
/** How long the actor stays after it has issued a token, so the reply reaches the client first. */
const CLEANUP_DELAY_MS = 3_000;
/** The attempt id is part of what a sealed attempt is bound to, and it may name things at a provider, so it is held to a safe alphabet. */
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

interface Attempt {
	/** `new`: nothing started. `started`: waiting for the pasted address. `done`: a token was issued. */
	state: "new" | "started" | "done";
	expiresAt: number;
	/** The attempt's sign-in material, sealed for this attempt: pending after `start`, finished until the user's actor has it. Null otherwise. */
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
	await c.db.execute("UPDATE attempt SET state = ?, expires_at = ?, sealed = ?, schedule_id = ? WHERE id = 1", state, expiresAt, sealed, scheduleId);
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
		onMigrate: async (db) => {
			await db.execute(`
				CREATE TABLE IF NOT EXISTS attempt (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					state TEXT NOT NULL,
					expires_at INTEGER NOT NULL,
					schedule_id TEXT,
					sealed TEXT
				)
			`);
		},
	}),

	onCreate: async (c) => {
		const expiresAt = Date.now() + ATTEMPT_TTL_MS;
		// An attempt nobody finishes is removed, whether or not it was ever started.
		const scheduleId = await c.schedule.after(ATTEMPT_TTL_MS + 1_000, "expire");
		await c.db.execute("INSERT OR REPLACE INTO attempt (id, state, expires_at, schedule_id) VALUES (1, 'new', ?, ?)", expiresAt, scheduleId);
	},

	createVars: async (c): Promise<LoginVars> => {
		const [row] = await c.db.execute<AttemptRow>("SELECT state, expires_at, sealed, schedule_id FROM attempt WHERE id = 1");
		if (row?.sealed && !serverSealer().isCurrent(row.sealed)) {
			const sealer = serverSealer();
			try {
				const next = sealer.seal("attempt", c.key[0], sealer.open("attempt", c.key[0], row.sealed));
				await c.db.execute("UPDATE attempt SET sealed = ? WHERE id = 1 AND sealed = ?", next, row.sealed);
				row.sealed = next;
			} catch (error) {
				// An unreadable attempt can still expire, or be explicitly restarted.
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

	onBeforeConnect: (c) => {
		assertOrigin(c);
	},

	// Runs when the attempt expires and when the actor has done its job. What an unfinished attempt
	// held was in this actor's storage only (`expire` has emptied it), and goes with the actor.
	onDestroy: (c) => {
		if (c.vars.attempt.state !== "done" && c.vars.attempt.discarded) console.log(`[wlp] login.discarded attempt=${c.key[0]}`);
	},

	actions: {
		start: (c): Promise<LoginStart> =>
			exclusive(c.vars, async () => {
				const attemptId = c.key[0];
				if (!ATTEMPT_ID.test(attemptId ?? "")) {
					throw new UserError("The sign-in attempt's id must be 8 to 64 letters, digits, dashes or underscores.", { code: "bad_attempt_id" });
				}
				const attempt = c.vars.attempt;
				if (attempt.state === "done") throw new UserError("This sign-in is already finished.", { code: "attempt_done" });
				try {
					const { logins } = await getLayer();
					// Calling it again restarts the attempt: what was pending is replaced.
					const { url, redirectPrefix, attempt: sealed } = await logins.start(attemptId);

					const replaced = attempt.scheduleId;
					const scheduleId = await c.schedule.after(ATTEMPT_TTL_MS + 1_000, "expire");
					attempt.sealed = sealed;
					attempt.state = "started";
					attempt.expiresAt = Date.now() + ATTEMPT_TTL_MS;
					attempt.scheduleId = scheduleId;
					await save(c);
					if (replaced) await c.schedule.cancel(replaced).catch(() => false);
					return { url, redirectPrefix, expiresAt: attempt.expiresAt };
				} catch (error) {
					throw clientError(c.log, error, "The sign-in could not be started. Try again.");
				}
			}),

		finish: (c, pastedUrl: string): Promise<AuthResult> =>
			exclusive(c.vars, async () => {
				if (typeof pastedUrl !== "string" || pastedUrl.trim() === "") {
					throw new UserError("Paste the address of the page the sign-in ended on.", { code: "bad_input" });
				}
				if (pastedUrl.length > 8_192) throw new UserError("That address is too long to be the one the sign-in ended on.", { code: "bad_input" });
				const attemptId = c.key[0];
				const attempt = c.vars.attempt;
				if (attempt.state === "done") throw new UserError("This sign-in is already finished.", { code: "attempt_done" });
				if (attempt.state !== "started" || attempt.sealed === null) throw new UserError("Start the sign-in first.", { code: "attempt_not_started" });
				if (Date.now() > attempt.expiresAt) throw new UserError("This sign-in attempt has expired. Start again.", { code: "attempt_expired" });

				try {
					const { logins } = await getLayer();
					const finished = await logins.finish(attemptId, attempt.sealed, pastedUrl.trim());
					const account = finished.account;
					if (typeof account?.sub !== "string" || account.sub === "") throw new Error("the sign-in returned no account identifier");
					// OpenAI takes the code only once. Save the result before calling either directory or user,
					// so a retry after an interrupted handover uses the same verified material.
					attempt.sealed = finished.attempt;
					await save(c);
					const uid = await claimAccountUid(c, account);
					const profile: UserProfile = { uid, email: normalizeEmail(account.email), demo: false };
					if (!mayUse(profile, config.access)) {
						attempt.sealed = null;
						throw new UserError(NOT_INVITED, { code: "not_invited" });
					}
					const generation: number = await c.client().user.getOrCreate([uid], { params: serviceParams() }).internalTokenGeneration();
					await logins.adopt(attemptId, finished.attempt, uid);
					// The user's actor has it: nothing of the sign-in stays here.
					attempt.sealed = null;

					const token = issueUserToken(profile, generation);
					const replaced = attempt.scheduleId;
					attempt.scheduleId = await c.schedule.after(CLEANUP_DELAY_MS, "expire");
					attempt.state = "done";
					await save(c);
					if (replaced) await c.schedule.cancel(replaced).catch(() => false);
					return { token, profile };
				} catch (error) {
					await save(c).catch(() => undefined);
					throw clientError(c.log, error, "The sign-in could not be finished. Try the same address again.");
				}
			}),

		demo: (c): Promise<AuthResult> =>
			exclusive(c.vars, async () => {
				if (!config.demo) throw new UserError("The demo sign-in is not enabled on this server.", { code: "demo_disabled" });
				const attempt = c.vars.attempt;
				if (attempt.state === "done") throw new UserError("This sign-in is already finished.", { code: "attempt_done" });
				try {
					const { logins } = await getLayer();
					const uid = `demo_${randomBytes(6).toString("hex")}`;
					const generation: number = await c.client().user.getOrCreate([uid], { params: serviceParams() }).internalTokenGeneration();
					await logins.ensureUserVolume(uid);

					const profile: UserProfile = { uid, email: null, demo: true };
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
