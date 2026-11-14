/**
 * `login`, key [attemptId]: one sign-in attempt. Takes no credentials; it is what hands them out.
 *
 * The actor lives for one attempt: it destroys itself shortly after it has issued a token, or when the
 * attempt expires, and an unfinished attempt's data volume is discarded with it.
 */

import { createHash, randomBytes } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, clientError } from "../auth.js";
import { config } from "../config.js";
import type { AuthResult, LoginStart, UserProfile } from "../contract.js";
import { getLayer } from "../layer.js";
import { issueUserToken } from "../tokens.js";

/** How long a started attempt is accepted: ten minutes. */
const ATTEMPT_TTL_MS = config.loginTtlMs;
/** How long the actor stays after it has issued a token, so the reply reaches the client first. */
const CLEANUP_DELAY_MS = 3_000;
/** The attempt id names a Docker volume, so it is held to a safe alphabet. */
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

interface Attempt {
	/** `new`: nothing started. `started`: waiting for the pasted address. `done`: a token was issued. */
	state: "new" | "started" | "done";
	expiresAt: number;
	/** Whether the sandbox layer holds a data volume for this attempt that nobody has adopted. */
	volume: boolean;
	/** The pending `expire` schedule, cancelled when the attempt is restarted. */
	scheduleId: string | null;
}

interface LoginVars {
	attempt: Attempt;
	busy: boolean;
}

type AttemptRow = {
	state: Attempt["state"];
	expires_at: number;
	volume: number;
	schedule_id: string | null;
};

async function save(c: { db: RawAccess; vars: LoginVars }): Promise<void> {
	const { state, expiresAt, volume, scheduleId } = c.vars.attempt;
	await c.db.execute("UPDATE attempt SET state = ?, expires_at = ?, volume = ?, schedule_id = ? WHERE id = 1", state, expiresAt, volume ? 1 : 0, scheduleId);
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
					volume INTEGER NOT NULL,
					schedule_id TEXT
				)
			`);
		},
	}),

	onCreate: async (c) => {
		const expiresAt = Date.now() + ATTEMPT_TTL_MS;
		// An attempt nobody finishes is removed, whether or not it was ever started.
		const scheduleId = await c.schedule.after(ATTEMPT_TTL_MS + 1_000, "expire");
		await c.db.execute("INSERT OR REPLACE INTO attempt (id, state, expires_at, volume, schedule_id) VALUES (1, 'new', ?, 0, ?)", expiresAt, scheduleId);
	},

	createVars: async (c): Promise<LoginVars> => {
		const [row] = await c.db.execute<AttemptRow>("SELECT state, expires_at, volume, schedule_id FROM attempt WHERE id = 1");
		return {
			attempt: row
				? { state: row.state, expiresAt: row.expires_at, volume: row.volume === 1, scheduleId: row.schedule_id }
				: { state: "new", expiresAt: Date.now() + ATTEMPT_TTL_MS, volume: false, scheduleId: null },
			busy: false,
		};
	},

	onBeforeConnect: (c) => {
		assertOrigin(c);
	},

	// Runs when the attempt expires and when the actor has done its job.
	onDestroy: async (c) => {
		if (!c.vars.attempt.volume) return;
		try {
			const { logins } = await getLayer();
			await logins.discard(c.key[0]);
			console.log(`[wlp] login.discarded attempt=${c.key[0]}`);
		} catch (error) {
			c.log.error({ msg: "could not discard the sign-in attempt", error: String(error) });
		}
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
					if (attempt.volume) {
						await logins.discard(attemptId);
						attempt.volume = false;
					}
					// Recorded before the call: a failure halfway may still have left a volume behind.
					attempt.volume = true;
					await save(c);
					const { url, redirectPrefix } = await logins.start(attemptId);

					if (attempt.scheduleId) await c.schedule.cancel(attempt.scheduleId);
					attempt.state = "started";
					attempt.expiresAt = Date.now() + ATTEMPT_TTL_MS;
					attempt.scheduleId = await c.schedule.after(ATTEMPT_TTL_MS + 1_000, "expire");
					await save(c);
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
				if (attempt.state !== "started") throw new UserError("Start the sign-in first.", { code: "attempt_not_started" });
				if (Date.now() > attempt.expiresAt) throw new UserError("This sign-in attempt has expired. Start again.", { code: "attempt_expired" });

				try {
					const { logins } = await getLayer();
					const account = await logins.finish(attemptId, pastedUrl.trim());
					if (typeof account?.sub !== "string" || account.sub === "") throw new Error("the sign-in returned no account identifier");
					const uid = `u_${createHash("sha256").update(account.sub).digest("hex").slice(0, 20)}`;
					await logins.adopt(attemptId, uid);
					attempt.volume = false;

					const profile: UserProfile = { uid, email: typeof account.email === "string" ? account.email : null, demo: false };
					const token = issueUserToken(profile);
					attempt.state = "done";
					if (attempt.scheduleId) await c.schedule.cancel(attempt.scheduleId);
					attempt.scheduleId = await c.schedule.after(CLEANUP_DELAY_MS, "expire");
					await save(c);
					return { token, profile };
				} catch (error) {
					await save(c).catch(() => undefined);
					throw clientError(c.log, error, "The sign-in could not be finished. Start again.");
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
					await logins.ensureUserVolume(uid);

					const profile: UserProfile = { uid, email: null, demo: true };
					const token = issueUserToken(profile);
					attempt.state = "done";
					if (attempt.scheduleId) await c.schedule.cancel(attempt.scheduleId);
					attempt.scheduleId = await c.schedule.after(CLEANUP_DELAY_MS, "expire");
					await save(c);
					return { token, profile };
				} catch (error) {
					throw clientError(c.log, error, "The demo sign-in failed. Try again.");
				}
			}),

		/** Run by the schedule only: removes the actor, and with it an unfinished attempt. */
		expire: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const attempt = c.vars.attempt;
			// A step is talking to the sandbox layer right now: let it end before the attempt is removed.
			if (c.vars.busy) {
				attempt.scheduleId = await c.schedule.after(5_000, "expire");
				await save(c);
				return;
			}
			// A schedule left over from before a restart of the attempt: the newer one will come.
			if (attempt.state === "started" && Date.now() < attempt.expiresAt) return;
			c.destroy();
		},
	},
});
