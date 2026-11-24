/** githubRepository[repositoryId]. Every action requires the platform service credential. */
import type { GithubId } from "../contract.js";
import type { IssueFiling } from "../factory/intake.js";
import type { GithubUser } from "../github/app.js";
import { githubId } from "../github/ids.js";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { githubIdKey } from "../github/events.js";
import { internalConnection, requireServiceFor } from "../auth.js";
import { githubApp } from "../github/app.js";

type Item = { itemId: string; uid: string; installationId?: GithubId; issue?: number; generation?: number; pr?: number; head?: string; moved?: string | null; live?: boolean };
export type SessionPull = { sessionId: string; uid: string; installationId: GithubId; pr: number };
type Match = { itemId: string; uid: string; issue: number | null; generation: number | null; pr: number | null; head: string | null };
const TTL = 10 * 60_000;

export type IssueClaim = { generation: number; uid: string; itemId: string; installation: string; pending: number; subject: string }
export type IssueDecision = { kind: "file"; filing: IssueFiling; itemId: string } | { kind: "retry"; itemId: string } | { kind: "refuse"; reason: string; generation: number } | { kind: "ignore" };
type Receipt = { uid: string; generation: number; decision: string | null };

export const githubRepository = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (!githubIdKey(c.key)) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS items (item_id TEXT PRIMARY KEY, uid TEXT NOT NULL, issue INTEGER, generation INTEGER, pr INTEGER, head TEXT, live INTEGER NOT NULL)");
		const columns = await db.execute<{ name: string }>("PRAGMA table_info(items)");
		if (!columns.some(column => column.name === "moved")) await db.execute("ALTER TABLE items ADD COLUMN moved TEXT");
		if (!columns.some(column => column.name === "installation")) await db.execute("ALTER TABLE items ADD COLUMN installation TEXT");
		await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS live_issue ON items(issue) WHERE live = 1");
		await db.execute("CREATE TABLE IF NOT EXISTS issue_claims (issue INTEGER PRIMARY KEY, generation INTEGER NOT NULL, uid TEXT NOT NULL, itemId TEXT NOT NULL, installation TEXT NOT NULL, pending INTEGER NOT NULL, subject TEXT NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS issue_receipts (subject TEXT PRIMARY KEY, uid TEXT NOT NULL, generation INTEGER NOT NULL, decision TEXT)");
		await db.execute("CREATE TABLE IF NOT EXISTS issue_access (installation TEXT, user TEXT, level TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(installation,user))");
		await db.execute("DROP TABLE IF EXISTS access");
		await db.execute("CREATE TABLE IF NOT EXISTS session_pulls (sessionId TEXT PRIMARY KEY, uid TEXT NOT NULL, installation TEXT NOT NULL, pr INTEGER NOT NULL)");
		// The users with prepared environments of this repository, told of pushes to its default branch (github-inbox.ts).
		await db.execute("CREATE TABLE IF NOT EXISTS environment_users (uid TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	} }),
	actions: {
		internalRegisterSession: async (c, row: SessionPull) => {
			requireServiceFor(c, "call");
			await c.db.execute("INSERT OR REPLACE INTO session_pulls VALUES(?,?,?,?)", row.sessionId, row.uid, String(row.installationId), row.pr);
		},
		internalForgetSession: async (c, sessionId: string) => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM session_pulls WHERE sessionId=?", sessionId);
		},
		internalFindSession: async (c, key: { installationId: GithubId; pr: number }): Promise<SessionPull[]> => {
			requireServiceFor(c, "call");
			return c.db.execute<SessionPull>("SELECT sessionId, uid, installation AS installationId, pr FROM session_pulls WHERE installation=? AND pr=? ORDER BY sessionId", String(key.installationId), key.pr);
		},
		internalIssuePermission: async (c, installation: GithubId, user: GithubUser): Promise<"write" | "read" | "none"> => {
			requireServiceFor(c, "call");
			const now = Date.now();
			const [cached] = await c.db.execute<{ level: "write" | "read" | "none" }>("SELECT level FROM issue_access WHERE installation=? AND user=? AND at>?", String(installation), String(user.id), now - TTL);
			if (cached) return cached.level;
			const app = githubApp(), repositoryId = githubId(c.key[0])!;
			if (!app) throw new Error("The GitHub App is unavailable.");
			const level = await app.issuePermission(installation, repositoryId, user);
			await c.db.execute("DELETE FROM issue_access WHERE at<=?", now - TTL);
			await c.db.execute("INSERT OR REPLACE INTO issue_access VALUES (?,?,?,?)", String(installation), String(user.id), level, now);
			return level;
		},
		internalIssueClaim: async (c, issue: number): Promise<IssueClaim | null> => {
			requireServiceFor(c, "call");
			return (await c.db.execute<IssueClaim>("SELECT * FROM issue_claims WHERE issue=?", issue))[0] ?? null;
		},
		// The subject and its decision are one write. Retrying a lost actor call finishes the same
		// generation with its original snapshot, even when GitHub or the user's defaults have changed.
		internalDecideIssue: async (c, input: { issue: number; installation: GithubId; subject: string; uid: string; previous: number; decision: IssueDecision }): Promise<IssueDecision> => {
			requireServiceFor(c, "call");
			return c.db.transaction(async tx => {
				const [receipt] = await tx.execute<Receipt>("SELECT * FROM issue_receipts WHERE subject=?", input.subject);
				if (receipt) return receipt.uid === input.uid && receipt.decision ? JSON.parse(receipt.decision) : { kind: "ignore" };
				const [claim] = await tx.execute<IssueClaim>("SELECT * FROM issue_claims WHERE issue=?", input.issue);
				if ((claim?.generation ?? 0) !== input.previous) throw new Error("The issue generation changed.");
				const decision = input.decision;
				let generation = input.previous;
				if (decision.kind === "file") {
					if (claim?.pending) throw new Error("The previous filing is still pending.");
					generation++;
					await tx.execute("UPDATE items SET live=0 WHERE issue=? AND live=1", input.issue);
					await tx.execute("INSERT INTO items(item_id,uid,issue,generation,installation,live) VALUES(?,?,?,?,?,1)", decision.itemId, input.uid, input.issue, generation, String(input.installation));
					await tx.execute("INSERT OR REPLACE INTO issue_claims VALUES(?,?,?,?,?,1,?)", input.issue, generation, input.uid, decision.itemId, String(input.installation), input.subject);
				}
				await tx.execute("INSERT INTO issue_receipts VALUES(?,?,?,?)", input.subject, input.uid, generation, decision.kind === "ignore" ? null : JSON.stringify(decision));
				return decision;
			});
		},
		internalFinishIssue: async (c, issue: number, subject: string) => {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				const [r] = await tx.execute<Receipt>("SELECT * FROM issue_receipts WHERE subject=?", subject);
				if (r?.decision && JSON.parse(r.decision).kind === "file") await tx.execute("UPDATE issue_claims SET pending=0 WHERE issue=? AND generation=?", issue, r.generation);
				await tx.execute("UPDATE issue_receipts SET decision=NULL WHERE subject=?", subject);
			});
		},
		internalRegister: async (c, row: Item) => {
			requireServiceFor(c, "call");
			// Publishing updates pr/head without dropping the issue registration made at intake.
			await c.db.execute(`INSERT INTO items (item_id, uid, issue, generation, pr, head, live, installation, moved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET
				installation = coalesce(excluded.installation, items.installation), issue = coalesce(excluded.issue, items.issue), generation = coalesce(excluded.generation, items.generation),
				pr = CASE WHEN excluded.issue IS NULL THEN coalesce(excluded.pr, items.pr) ELSE excluded.pr END,
				moved = excluded.moved, head = CASE WHEN excluded.issue IS NULL THEN coalesce(excluded.head, items.head) ELSE excluded.head END, live = excluded.live`,
				row.itemId, row.uid, row.issue ?? null, row.generation ?? null, row.pr ?? null, row.head ?? null, Number(row.live ?? true), row.installationId == null ? null : String(row.installationId), row.moved ?? null);
		},
		internalWatchPushes: async (c, uid: string): Promise<void> => {
			requireServiceFor(c, "call");
			if (typeof uid !== "string" || uid.length > 200) return;
			await c.db.execute("INSERT OR REPLACE INTO environment_users (uid, at) VALUES (?, ?)", uid, Date.now());
			// A user who has not built here in 30 days is told no more.
			await c.db.execute("DELETE FROM environment_users WHERE at < ?", Date.now() - 30 * 86_400_000);
		},
		internalEnvironmentUsers: async (c): Promise<string[]> => {
			requireServiceFor(c, "call");
			return (await c.db.execute<{ uid: string }>("SELECT uid FROM environment_users ORDER BY at DESC LIMIT 100")).map(r => r.uid);
		},
		internalForget: async (c, itemId: string) => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM items WHERE item_id = ?", itemId);
		},
		internalFind: async (c, key: ({ issue: number } | { pr: number } | { head: string }) & { installationId?: GithubId }): Promise<Match[]> => {
			requireServiceFor(c, "call");
			const [column, value] = "issue" in key ? ["issue", key.issue] : "pr" in key ? ["pr", key.pr] : ["head", key.head];
			const installation = key.installationId === undefined ? null : String(key.installationId);
			return await c.db.execute<Match>(`SELECT item_id AS itemId, uid, issue, generation, pr, head FROM items
				WHERE live = 1 AND ${column === "head" ? "(head = ? OR moved = ?)" : column + " = ?"} AND (? IS NULL OR installation = ?) ORDER BY item_id`, value, ...(column === "head" ? [value] : []), installation, installation);
		},
	},
});
