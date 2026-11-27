import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import type { ConnectRequestState, PlanProvider } from "../contract.js";

/** How long a connect request waits for approval, and then for its token. */
export const CONNECT_REQUEST_TTL_MS = 10 * 60_000;
/** Requests open at once across the deployment: starting one needs no sign-in, so the table is bounded. */
const LIVE_REQUESTS = 1_000;
/** Codes a user may get wrong per TTL: with at most LIVE_REQUESTS live, guessing one stays out of reach. */
const MISSES_PER_USER = 10;

export type ConnectDecision = "ok" | "not_found" | "rate_limited";

/**
 * Connect requests of the connect command (connect-route.ts), `gh auth login`-style: the terminal starts one
 * without signing in, its user approves the code it shows on the web page, and only then does the terminal
 * hand a plan's token over, once. Only digests of the user code and of the terminal's request secret are kept.
 */
export const connectCodes = actor({
	db: db({
		onMigrate: async db => {
			await db.execute(
				`CREATE TABLE IF NOT EXISTS requests (
					request TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'pending', uid TEXT, expires INTEGER NOT NULL
				)`,
			);
			await db.execute("CREATE TABLE IF NOT EXISTS misses (uid TEXT NOT NULL, at INTEGER NOT NULL)");
		},
	}),
	onCreate: c => {
		if (c.key.length !== 1 || c.key[0] !== "codes") c.destroy();
	},
	onBeforeConnect: internalConnection,
	actions: {
		/** Opens a pending request. Null when too many are open, or (vanishingly rarely) the user code is taken. */
		internalStart: async (c, request: string, userCode: string, provider: PlanProvider): Promise<number | null> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			await c.db.execute("DELETE FROM requests WHERE expires <= ?", now);
			await c.db.execute("DELETE FROM misses WHERE at <= ?", now - CONNECT_REQUEST_TTL_MS);
			const rows = await c.db.execute<{ expires: number }>(
				`INSERT OR IGNORE INTO requests (request, user_code, provider, expires)
				SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM requests) < ? RETURNING expires`,
				request,
				userCode,
				provider,
				now + CONNECT_REQUEST_TTL_MS,
				LIVE_REQUESTS,
			);
			return rows[0]?.expires ?? null;
		},
		/** Where the terminal's request stands. A request that is gone, used or out of time is expired. */
		internalPoll: async (c, request: string): Promise<ConnectRequestState> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ state: ConnectRequestState }>(
				"SELECT state FROM requests WHERE request = ? AND expires > ?",
				request,
				Date.now(),
			);
			return row?.state ?? "expired";
		},
		/**
		 * The signed-in user approves or denies the code on the page. Only a pending, live request is decided, and
		 * an approval only for the plan the page named (`provider`), so a link that names another plan approves
		 * nothing. Approving gives the terminal a fresh TTL for its sign-in. Wrong codes count against the user.
		 */
		internalDecide: async (
			c,
			userCode: string,
			uid: string,
			approve: boolean,
			provider?: PlanProvider,
		): Promise<ConnectDecision> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			const [misses] = await c.db.execute<{ n: number }>(
				"SELECT count(*) AS n FROM misses WHERE uid = ? AND at > ?",
				uid,
				now - CONNECT_REQUEST_TTL_MS,
			);
			if ((misses?.n ?? 0) >= MISSES_PER_USER) return "rate_limited";
			const decided = await c.db.execute(
				`UPDATE requests SET state = ?, uid = ?, expires = ?
				WHERE user_code = ? AND state = 'pending' AND expires > ? AND (? IS NULL OR provider = ?) RETURNING provider`,
				approve ? "approved" : "denied",
				uid,
				approve ? now + CONNECT_REQUEST_TTL_MS : now + 60_000,
				userCode,
				now,
				provider ?? null,
				provider ?? null,
			);
			if (decided.length) return "ok";
			await c.db.execute("INSERT INTO misses VALUES (?, ?)", uid, now);
			return "not_found";
		},
		/** Takes an approved request: whose it is and for which plan. A request is taken once. */
		internalTake: async (c, request: string): Promise<{ uid: string; provider: PlanProvider } | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string; provider: PlanProvider }>(
				"DELETE FROM requests WHERE request = ? AND state = 'approved' AND expires > ? RETURNING uid, provider",
				request,
				Date.now(),
			);
			return row ?? null;
		},
	},
});
