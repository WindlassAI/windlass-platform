import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import type { PlanProvider } from "../contract.js";

/** How long a connect code is accepted. */
export const CONNECT_CODE_TTL_MS = 10 * 60_000;
/** Codes a user may hold at once: a reload or a second tab keeps the code it has (web), so a few are plenty. */
const LIVE_PER_USER = 5;

/**
 * One-time codes that let the connect command hand a plan's token to its user without signing in: the code is
 * the authorization. Only each code's digest is kept (connect-route.ts); a code is used once, then removed.
 */
export const connectCodes = actor({
	db: db({
		onMigrate: async db => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS codes (digest TEXT PRIMARY KEY, uid TEXT NOT NULL, provider TEXT NOT NULL, expires INTEGER NOT NULL)",
			);
		},
	}),
	onCreate: c => {
		if (c.key.length !== 1 || c.key[0] !== "codes") c.destroy();
	},
	onBeforeConnect: internalConnection,
	actions: {
		/** Keeps a code's digest for its user. Null when the user already holds as many live codes as allowed. */
		internalIssue: async (c, digest: string, uid: string, provider: PlanProvider): Promise<number | null> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			await c.db.execute("DELETE FROM codes WHERE expires <= ?", now);
			const rows = await c.db.execute<{ expires: number }>(
				"INSERT INTO codes SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM codes WHERE uid = ?) < ? RETURNING expires",
				digest,
				uid,
				provider,
				now + CONNECT_CODE_TTL_MS,
				uid,
				LIVE_PER_USER,
			);
			return rows[0]?.expires ?? null;
		},
		/** Takes a live code: who it belongs to and for which plan. A code is taken once. */
		internalRedeem: async (c, digest: string): Promise<{ uid: string; provider: PlanProvider } | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string; provider: PlanProvider }>(
				"DELETE FROM codes WHERE digest = ? AND expires > ? RETURNING uid, provider",
				digest,
				Date.now(),
			);
			return row ?? null;
		},
	},
});
