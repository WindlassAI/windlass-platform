/** githubRepository[repositoryId]. Every action requires the platform service credential. */
import type { GithubId } from "../contract.js";
import { githubId } from "../github/ids.js";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { githubIdKey } from "../github/events.js";
import { internalConnection, requireServiceFor } from "../auth.js";
import { githubApp, GithubError } from "../github/app.js";

type Item = { itemId: string; uid: string; issue?: number; generation?: number; pr?: number; head?: string; live?: boolean };
type Match = { itemId: string; uid: string; issue: number | null; generation: number | null; pr: number | null; head: string | null };
type Level = "admin" | "write" | "read" | "none";
type Permission = { installationId: GithubId; owner: string; name: string; userId: GithubId; login: string; associations: string };
const TTL = 10 * 60_000;

export const githubRepository = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (!githubIdKey(c.key)) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS items (item_id TEXT PRIMARY KEY, uid TEXT NOT NULL, issue INTEGER, generation INTEGER, pr INTEGER, head TEXT, live INTEGER NOT NULL)");
		await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS live_issue ON items(issue) WHERE live = 1");
		await db.execute("CREATE TABLE IF NOT EXISTS access (github_user_id INTEGER PRIMARY KEY, level TEXT NOT NULL, at INTEGER NOT NULL)");
	} }),
	actions: {
		internalRegister: async (c, row: Item) => {
			requireServiceFor(c, "call");
			// Publishing updates pr/head without dropping the issue registration made at intake.
			await c.db.execute(`INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET
				issue = coalesce(excluded.issue, items.issue), generation = coalesce(excluded.generation, items.generation),
				pr = coalesce(excluded.pr, items.pr), head = coalesce(excluded.head, items.head), live = excluded.live`,
				row.itemId, row.uid, row.issue ?? null, row.generation ?? null, row.pr ?? null, row.head ?? null, Number(row.live ?? true));
		},
		internalForget: async (c, itemId: string) => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM items WHERE item_id = ?", itemId);
		},
		internalFind: async (c, key: { issue: number } | { pr: number } | { head: string }): Promise<Match[]> => {
			requireServiceFor(c, "call");
			const [column, value] = "issue" in key ? ["issue", key.issue] : "pr" in key ? ["pr", key.pr] : ["head", key.head];
			return await c.db.execute<Match>(`SELECT item_id AS itemId, uid, issue, generation, pr, head FROM items WHERE live = 1 AND ${column} = ? ORDER BY item_id`, value);
		},
		internalPermission: async (c, input: Permission): Promise<Level> => {
			requireServiceFor(c, "call");
			if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(input.associations)) return "none";
			const now = Date.now();
			const [cached] = await c.db.execute<{ level: Level }>("SELECT level FROM access WHERE github_user_id = ? AND at > ?", input.userId, now - TTL);
			if (cached) return cached.level;
			const app = githubApp();
			if (!app) throw new Error("The GitHub App is unavailable.");
			let level: Level;
			try {
				level = await app.withToken(input.installationId, { repositoryId: githubId(c.key[0])!, permissions: { metadata: "read" } },
					token => app.permission(token, input.owner, input.name, input.login));
			} catch (error) {
				if (!(error instanceof GithubError) || error.status !== 404) throw error;
				level = "none";
			}
			await c.db.execute("DELETE FROM access WHERE at <= ?", now - TTL);
			await c.db.execute("INSERT OR REPLACE INTO access VALUES (?, ?, ?)", input.userId, level, now);
			return level;
		},
	},
});
