/** githubInbox[installationId] and githubHooks["app"]. Only service actions write or read rows.
 * A scheduled action must be fired by the engine. An empty actor has no work and arms no timer.
 */
import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { requireServiceFor, serviceParams } from "../auth.js";
import { githubConfig } from "../config.js";
import { githubApp, GithubError } from "../github/app.js";
import type { Delivery } from "../github/events.js";

// https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
// Redeliveries have "the same" delivery GUID. This is the inbox primary key.
// https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
// "GitHub does not automatically redeliver failed deliveries." Requests are available for three days.
const DAY = 86_400_000;
const SWEEP = 10 * 60_000;
const FIRST_RETRY = 15_000;
type Vars = { writing: Promise<unknown>; draining: boolean; drainAgain: boolean };
type Ctx = {
	key: string[]; db: RawAccess; vars: Vars; client(): any;
	keepAwake<T>(work: Promise<T>): Promise<T>;
	schedule: { at(time: number, action: string): Promise<string>; cancel(id: string): Promise<boolean> };
};
const vars = (): Vars => ({ writing: Promise.resolve(), draining: false, drainAgain: false });
function queued<T>(c: Ctx, work: () => Promise<T>): Promise<T> {
	const run = c.vars.writing.then(work);
	c.vars.writing = run.catch(() => undefined);
	return run;
}

// Called under the actor's write queue. Make the replacement durable before cancelling its predecessor.
async function arm(c: Ctx, at: number | null, action: string) {
	const [old] = await c.db.execute<{ id: string; at: number }>("SELECT id, at FROM timer");
	if (at === null) {
		if (!old) return;
		await c.db.execute("DELETE FROM timer");
	} else {
		if (old?.at === at && at > Date.now()) return;
		const id = await c.schedule.at(Math.max(Date.now(), at), action);
		await c.db.execute("INSERT OR REPLACE INTO timer VALUES (1, ?, ?)", id, at);
	}
	if (old) await c.schedule.cancel(old.id).catch(() => false);
}
const TIMER = "CREATE TABLE IF NOT EXISTS timer (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, at INTEGER NOT NULL)";

function logInstallation(d: Delivery) {
	console.log(`github.installation event=${d.event}.${d.action} installation=${d.installationId} delivery=${d.guid}`);
}
export const HANDLERS: Partial<Record<Delivery["event"], (delivery: Delivery) => void | Promise<void>>> = {
	installation: logInstallation,
	installation_repositories: logInstallation,
};

type Row = { guid: string; event: Delivery["event"]; action: string; repository: number | null; data: string; received_at: number; attempts: number };

async function armInbox(c: Ctx) {
	const [row] = await c.db.execute<{ at: number | null }>(`SELECT min(at) AS at FROM (
		SELECT min(received_at) + ? AS at FROM deliveries UNION ALL
		SELECT min(next_at) FROM deliveries WHERE state = 'received' UNION ALL
		SELECT next_at FROM hook_start WHERE started = 0)`, 7 * DAY);
	const due = row?.at;
	// Due work is already being drained. Leave a watchdog if the node stops during a handler.
	await arm(c, due == null ? null : due <= Date.now() ? Date.now() + FIRST_RETRY : due, "internalDue");
}

async function drainDue(c: Ctx) {
	await queued(c, () => c.db.execute("DELETE FROM deliveries WHERE received_at <= ?", Date.now() - 7 * DAY));
	// Retry the singleton handoff after an engine outage, even if no further delivery arrives.
	const [start] = await c.db.execute("SELECT 1 FROM hook_start WHERE started = 0 AND next_at <= ?", Date.now());
	if (start && githubConfig().webhook) {
		try {
			await c.client().githubHooks.getOrCreate(["app"], { params: serviceParams() }).internalStart();
			await queued(c, () => c.db.execute("UPDATE hook_start SET started = 1"));
		} catch {
			await queued(c, () => c.db.execute("UPDATE hook_start SET next_at = ?", Date.now() + FIRST_RETRY));
		}
	} else if (start) {
		await queued(c, () => c.db.execute("UPDATE hook_start SET next_at = ?", Date.now() + SWEEP));
	}
	while (true) {
		const [row] = await c.db.execute<Row>("SELECT * FROM deliveries WHERE state = 'received' AND next_at <= ? ORDER BY received_at, rowid LIMIT 1", Date.now());
		if (!row) break;
		const attempts = row.attempts + 1;
		let state = "done", said = "", next = 0;
		try {
			const handler = HANDLERS[row.event];
			if (handler) await handler({ guid: row.guid, event: row.event, action: row.action, installationId: Number(c.key[0]), repositoryId: row.repository, data: JSON.parse(row.data), at: row.received_at });
			else { state = "ignored"; said = "no handler yet"; }
		} catch {
			said = "handler failed"; // thrown errors can contain delivery text
			state = attempts >= 8 ? "failed" : "received";
			next = Date.now() + Math.min(30 * 60_000, FIRST_RETRY * 2 ** (attempts - 1));
		}
		await queued(c, () => c.db.execute("UPDATE deliveries SET state = ?, said = ?, next_at = ?, attempts = ? WHERE guid = ?", state, said, next, attempts, row.guid));
		if (state === "ignored") console.log(`github.delivery.ignored(no handler yet) event=${row.event} installation=${c.key[0]} delivery=${row.guid}`);
		if (state === "failed") console.warn(`github.delivery.failed event=${row.event} installation=${c.key[0]} delivery=${row.guid}`);
	}
}

async function drain(c: Ctx) {
	if (c.vars.draining) {
		c.vars.drainAgain = true;
		return;
	}
	c.vars.draining = true;
	try {
		// A receive can finish while the wake pass is inspecting an empty inbox.
		do {
			c.vars.drainAgain = false;
			await drainDue(c);
		} while (c.vars.drainAgain);
	} finally {
		c.vars.draining = false;
		await queued(c, () => armInbox(c));
	}
}

function runDrain(c: Ctx) {
	void c.keepAwake(drain(c).catch(() => console.warn("github.inbox.drain_failed")));
}

export const githubInbox = actor({
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS deliveries (guid TEXT PRIMARY KEY, event TEXT NOT NULL, action TEXT NOT NULL, repository INTEGER, data TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, said TEXT NOT NULL)");
		await db.execute("CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(state, next_at)");
		await db.execute("CREATE INDEX IF NOT EXISTS delivery_age ON deliveries(received_at)");
		await db.execute(TIMER);
		await db.execute("CREATE TABLE IF NOT EXISTS hook_start (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), started INTEGER NOT NULL, next_at INTEGER NOT NULL)");
	} }),
	createVars: vars,
	onWake: runDrain,
	actions: {
		internalReceive: async (c, d: Delivery): Promise<"stored" | "duplicate" | "busy"> => {
			requireServiceFor(c, "call");
			if (String(d.installationId) !== c.key[0] || c.key.length !== 1) throw new Error("Wrong installation inbox.");
			const result = await queued(c, async () => {
				const result = await c.db.transaction(async tx => {
					await tx.execute("DELETE FROM deliveries WHERE received_at <= ?", Date.now() - 7 * DAY);
					if ((await tx.execute("SELECT 1 FROM deliveries WHERE guid = ?", d.guid)).length) return "duplicate";
					const [count] = await tx.execute<{ waiting: number; total: number }>("SELECT count(*) AS total, count(CASE WHEN state = 'received' THEN 1 END) AS waiting FROM deliveries");
					if (count.waiting >= 2_000) return "busy";
					if (count.total >= 20_000) {
						// Preserve waiting work. Prefer reclaiming a completed/ignored row to a failed row.
						await tx.execute("DELETE FROM deliveries WHERE rowid = (SELECT rowid FROM deliveries WHERE state <> 'received' ORDER BY (state = 'failed'), received_at, rowid LIMIT 1)");
					}
					const rows = await tx.execute("INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, '') RETURNING guid",
						d.guid, d.event, d.action, d.repositoryId, JSON.stringify(d.data), d.at, d.at);
					await tx.execute("INSERT OR IGNORE INTO hook_start VALUES (1, 0, 0)");
					return rows.length ? "stored" : "duplicate";
				});
				// A wake is durable before acknowledging. A duplicate also repairs a lost schedule.
				if (result !== "busy") await armInbox(c);
				return result;
			});
			if (result === "stored") console.log(`github.delivery.stored event=${d.event}${d.action ? "." + d.action : ""} installation=${d.installationId} delivery=${d.guid}`);
			if (result !== "busy") runDrain(c);
			return result;
		},
		internalKnows: async (c, guid: string) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM deliveries WHERE guid = ? AND received_at > ?", guid, Date.now() - 7 * DAY)).length !== 0;
		},
		internalDue: async c => {
			if (!c.scheduledFire) requireServiceFor(c, "call");
			await queued(c, () => armInbox(c));
			await drain(c);
		},
	},
});

async function sweep(c: Ctx) {
	const app = githubApp();
	if (!app || !githubConfig().webhook) return;
	const [window] = await c.db.execute<{ last_at: number; started_at: number; cursor: string | null }>("SELECT last_at, started_at, cursor FROM sweeps");
	if (!window) return;
	const now = Date.now();
	const started = window.started_at || now;
	if (!window.started_at) await c.db.execute("UPDATE sweeps SET started_at = ?", started);
	await c.db.execute("DELETE FROM redelivered WHERE at <= ?", now - 4 * DAY);
	let cursor = window.cursor ?? undefined;
	let posted = 0;
	for (let page = 0; page < 3; page++) {
		const batch = await app.hookDeliveries({ cursor, status: "failure" });
		let pastWindow = false;
		for (const d of batch.deliveries) {
			if (d.at < window.last_at - 60_000) { pastWindow = true; continue; }
			if ((await c.db.execute("SELECT 1 FROM redelivered WHERE guid = ?", d.guid)).length) continue;
			if (d.installationId && await c.client().githubInbox.getOrCreate([String(d.installationId)], { params: serviceParams() }).internalKnows(d.guid)) continue;
			if (posted === 50) return; // resume this page; its acknowledged requests are remembered
			// Reserve before POST: a timeout or deploy after GitHub accepts it must not send it twice.
			await c.db.execute("INSERT INTO redelivered VALUES (?, ?)", d.guid, Date.now());
			try {
				await app.redeliver(d.id);
			} catch (error) {
				if (error instanceof GithubError && error.status >= 400 && error.status < 500)
					await c.db.execute("DELETE FROM redelivered WHERE guid = ?", d.guid);
				throw error;
			}
			posted++;
		}
		if (!batch.cursor || pastWindow) {
			await c.db.execute("UPDATE sweeps SET last_at = ?, started_at = 0, cursor = NULL", started);
			return;
		}
		cursor = batch.cursor;
		await c.db.execute("UPDATE sweeps SET cursor = ?, started_at = ?", cursor, started);
	}
}

async function runSweep(c: Ctx) {
	// Even a tick that overlaps a slow sweep has consumed its schedule. Replace it first.
	await queued(c, () => arm(c, Date.now() + SWEEP, "internalSweep"));
	if (c.vars.draining) return;
	c.vars.draining = true;
	try {
		await sweep(c);
	} finally { c.vars.draining = false; }
}

export const githubHooks = actor({
	db: db({ onMigrate: async db => {
		await db.execute(TIMER);
		await db.execute("CREATE TABLE IF NOT EXISTS sweeps (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_at INTEGER NOT NULL, started_at INTEGER NOT NULL, cursor TEXT)");
		await db.execute("CREATE TABLE IF NOT EXISTS redelivered (guid TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	} }),
	createVars: vars,
	onWake: async c => {
		if (!(await c.db.execute("SELECT 1 FROM sweeps")).length) return;
		const [timer] = await c.db.execute<{ at: number }>("SELECT at FROM timer");
		if (!timer || timer.at <= Date.now()) void c.keepAwake(runSweep(c).catch(() => console.warn("github.webhook.sweep_failed")));
	},
	actions: {
		internalStart: async c => {
			requireServiceFor(c, "call");
			if (c.key.length !== 1 || c.key[0] !== "app") throw new Error("Wrong webhook sweep key.");
			await queued(c, async () => {
				await c.db.execute("INSERT OR IGNORE INTO sweeps VALUES (1, 0, 0, NULL)");
				if (!(await c.db.execute("SELECT 1 FROM timer")).length) await arm(c, Date.now() + SWEEP, "internalSweep");
			});
		},
		internalSweep: async c => {
			if (!c.scheduledFire) requireServiceFor(c, "call");
			if (c.key.length !== 1 || c.key[0] !== "app" || !(await c.db.execute("SELECT 1 FROM sweeps")).length) return;
			await runSweep(c);
		},
	},
});
