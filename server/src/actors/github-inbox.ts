/** githubInbox[installationId] and githubHooks["app"]. Only service actions write or read rows.
 * A scheduled action must be fired by the engine. An empty actor has no work and arms no timer.
 */
import type { GithubId } from "../contract.js";
import { decimalId, githubId } from "../github/ids.js";
import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { githubConfig } from "../config.js";
import { githubApp, GithubError } from "../github/app.js";
import { githubIdKey, type Delivery } from "../github/events.js";

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
function missingActor(error: unknown): boolean {
	const e = error as { group?: string; code?: string } | null;
	return e?.group === "actor" && e.code === "not_found";
}

async function nudgeItems(d: Delivery, c: Ctx): Promise<"no item" | void> {
	if (!d.repositoryId || !(d.event === "check_run" || d.event === "check_suite" || d.event === "status" || d.event === "pull_request")) return "no item";
	const subject = d.event === "pull_request" ? { kind: "pr" as const, pr: d.data.pr } : { kind: "ci" as const, head: d.data.head };
	const directory = c.client().githubRepository.get([String(d.repositoryId)], { params: serviceParams() });
	let matches: { uid: string; itemId: string }[];
	try {
		matches = await directory.internalFind({ ...subject, installationId: d.installationId });
	} catch (error) {
		if (missingActor(error)) return "no item";
		throw error;
	}
	let waiting = false;
	let retry = false;
	for (const { uid, itemId } of matches) {
		const item = c.client().workItem.get([uid, itemId], { params: serviceParams() });
		try {
			if (await item.internalGithubNudge({ ...subject, repositoryId: d.repositoryId, installationId: d.installationId })) waiting = true;
		} catch (error) {
			if (missingActor(error) || (error as { code?: string })?.code === "item_not_found") await directory.internalForget(itemId);
			else retry = true;
		}
	}
	if (retry) throw new Error("A work item could not be reached");
	if (!waiting) return "no item";
}
export const HANDLERS: Partial<Record<Delivery["event"], (delivery: Delivery, c: Ctx) => void | Promise<void | "no item">>> = {
	check_run: nudgeItems,
	check_suite: nudgeItems,
	status: nudgeItems,
	pull_request: nudgeItems,
	installation: logInstallation,
	installation_repositories: logInstallation,
};

type Row = { guid: string; event: Delivery["event"]; action: string; repository: string | null; data: string; received_at: number; attempts: number };

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
		const [row] = await c.db.execute<Row>("SELECT guid, event, action, CAST(repository AS TEXT) AS repository, data, received_at, attempts FROM deliveries WHERE state = 'received' AND next_at <= ? ORDER BY received_at, rowid LIMIT 1", Date.now());
		if (!row) break;
		const attempts = row.attempts + 1;
		let state = "done", said = "", next = 0;
		try {
			const handler = HANDLERS[row.event];
			if (handler) {
				// Older inbox rows have safe numeric comment and review IDs.
				const data = JSON.parse(row.data, (key, value) => key === "commentId" || key === "reviewId" ? decimalId(value) : value);
				const ignored = await handler({ guid: row.guid, event: row.event, action: row.action, installationId: githubId(c.key[0])!, repositoryId: githubId(row.repository), data, at: row.received_at }, c);
				if (ignored) { state = "ignored"; said = ignored; }
			} else { state = "ignored"; said = "no handler yet"; }
		} catch {
			said = "handler failed"; // thrown errors can contain delivery text
			state = attempts >= 8 ? "failed" : "received";
			next = Date.now() + Math.min(30 * 60_000, FIRST_RETRY * 2 ** (attempts - 1));
		}
		await queued(c, () => c.db.execute("UPDATE deliveries SET state = ?, said = ?, next_at = ?, attempts = ? WHERE guid = ?", state, said, next, attempts, row.guid));
		if (state === "ignored") console.log(`github.delivery.ignored(${said}) event=${row.event} installation=${c.key[0]} delivery=${row.guid}`);
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
	onBeforeConnect: internalConnection,
	onCreate: c => { if (!githubIdKey(c.key)) c.destroy(); },
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

async function linked(db: RawAccess, installation: GithubId) {
	return (await db.execute("SELECT 1 FROM installation_links WHERE installation = ? LIMIT 1", installation)).length > 0;
}

async function sweep(c: Ctx) {
	const app = githubApp();
	if (!app || !githubConfig().webhook) return;
	const [window] = await c.db.execute<{ last_at: number; started_at: number; cursor: string | null }>("SELECT last_at, started_at, cursor FROM sweeps");
	if (!window) return;
	const now = Date.now();
	const started = window.started_at || now;
	const since = Math.max(window.last_at - 60_000, now - 3 * DAY);
	await c.db.execute("DELETE FROM redelivered WHERE at <= ?", now - 4 * DAY);
	await c.db.execute("DELETE FROM pending_redelivery WHERE at <= ?", now - 3 * DAY);
	let cursor = window.cursor ?? undefined;
	for (let page = 0; page < 3; page++) {
		const batch = await app.hookDeliveries({ cursor, status: "failure" });
		const inWindow = batch.deliveries.filter(d => d.at >= since);
		const next = inWindow.length === batch.deliveries.length ? batch.cursor : null;
		// Advance the cursor with the durable candidates. A full installation cannot pin the scan
		// to its own page, and excess work survives a restart between ten-minute ticks.
		await c.db.transaction(async tx => {
			await tx.execute(`INSERT OR IGNORE INTO pending_redelivery (guid, delivery, installation, at)
				SELECT d.value ->> 'guid', d.value ->> 'id', d.value ->> 'installationId', d.value ->> 'at'
				FROM json_each(?) d
				WHERE EXISTS (SELECT 1 FROM installation_links WHERE installation = d.value ->> 'installationId')
				AND NOT EXISTS (SELECT 1 FROM redelivered WHERE guid = d.value ->> 'guid')`, JSON.stringify(inWindow));
			if (next) await tx.execute("UPDATE sweeps SET cursor = ?, started_at = ?", next, started);
			else await tx.execute("UPDATE sweeps SET last_at = ?, started_at = 0, cursor = NULL", started);
		});
		if (!next) break;
		cursor = next;
	}

	// One candidate per installation before any installation gets a second. Continue after
	// the last installation served so even more than 50 active installations get a turn.
	const candidates = await c.db.execute<{ guid: string; delivery: string; installation: string }>(`
		SELECT guid, delivery, CAST(installation AS TEXT) AS installation FROM pending_redelivery
		ORDER BY row_number() OVER (PARTITION BY installation ORDER BY at, length(delivery), delivery),
			pending_redelivery.installation <= coalesce((SELECT installation FROM redelivery_turn), 0), pending_redelivery.installation
		LIMIT 50`);
	const unavailable = new Set<string>();
	for (const d of candidates) {
		if (unavailable.has(d.installation)) continue;
		if (!await linked(c.db, d.installation)) continue;
		const inbox = c.client().githubInbox.getOrCreate([String(d.installation)], { params: serviceParams() });
		await c.db.execute("INSERT OR REPLACE INTO redelivery_turn VALUES (1, ?)", d.installation);
		let known: boolean;
		try { known = await inbox.internalKnows(d.guid); }
		catch {
			unavailable.add(d.installation);
			continue;
		}
		if (known) {
			await c.db.execute("DELETE FROM pending_redelivery WHERE guid = ?", d.guid);
			continue;
		}
		// Reserve before POST. Recheck membership after the actor call, in the same transaction.
		const reserved = await c.db.transaction(async tx => {
			if (!await linked(tx, d.installation)) return false;
			return (await tx.execute("INSERT OR IGNORE INTO redelivered VALUES (?, ?) RETURNING guid", d.guid, now)).length > 0;
		});
		if (reserved) {
			try {
				await app.redeliver(d.delivery);
			} catch (error) {
				unavailable.add(d.installation);
				if (error instanceof GithubError && error.status >= 400 && error.status < 500) {
					await c.db.execute("DELETE FROM redelivered WHERE guid = ?", d.guid);
					continue; // GitHub refused this request. Leave it for the next sweep.
				}
				// An ambiguous response keeps its reservation in case the POST reached GitHub.
			}
		}
		await c.db.execute("DELETE FROM pending_redelivery WHERE guid = ?", d.guid);
	}
	if (unavailable.size) console.warn(`github.webhook.redelivery_unavailable installations=${unavailable.size}`);
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
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || c.key[0] !== "app") c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute(TIMER);
		await db.execute("CREATE TABLE IF NOT EXISTS sweeps (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_at INTEGER NOT NULL, started_at INTEGER NOT NULL, cursor TEXT)");
		await db.execute("CREATE TABLE IF NOT EXISTS installation_links (installation INTEGER NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (installation, uid))");
		await db.execute("CREATE INDEX IF NOT EXISTS links_by_user ON installation_links(uid)");
		const pending = "CREATE TABLE IF NOT EXISTS pending_redelivery (guid TEXT PRIMARY KEY, delivery TEXT NOT NULL, installation INTEGER NOT NULL, at INTEGER NOT NULL)";
		await db.execute(pending);
		const columns = await db.execute<{ name: string; type: string }>("PRAGMA table_info(pending_redelivery)");
		if (columns.some(c => c.name === "delivery" && c.type === "INTEGER")) {
			await db.execute("ALTER TABLE pending_redelivery RENAME TO old_pending_redelivery");
			await db.execute(pending);
			// The old reader stored 0 for every unsafe ID. Re-list the three-day window to recover them.
			await db.execute("INSERT INTO pending_redelivery SELECT guid, CAST(delivery AS TEXT), installation, at FROM old_pending_redelivery WHERE delivery BETWEEN 1 AND 9007199254740991");
			await db.execute("UPDATE sweeps SET last_at = 0, started_at = 0, cursor = NULL");
			await db.execute("DROP TABLE old_pending_redelivery");
		}
		await db.execute("CREATE INDEX IF NOT EXISTS pending_by_installation ON pending_redelivery(installation, at, length(delivery), delivery)");
		await db.execute("CREATE TABLE IF NOT EXISTS redelivery_turn (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), installation INTEGER NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS redelivered (guid TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	} }),
	createVars: vars,
	onWake: async c => {
		if (!(await c.db.execute("SELECT 1 FROM sweeps")).length) return;
		const [timer] = await c.db.execute<{ at: number }>("SELECT at FROM timer");
		if (!timer || timer.at <= Date.now()) void c.keepAwake(runSweep(c).catch(() => console.warn("github.webhook.sweep_failed")));
	},
	actions: {
		internalSetInstallations: async (c, uid: string, ids: GithubId[]) => {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				const old = await tx.execute<{ installation: string }>("DELETE FROM installation_links WHERE uid = ? RETURNING CAST(installation AS TEXT) AS installation", uid);
				await tx.execute("INSERT OR IGNORE INTO installation_links SELECT value, ? FROM json_each(?)", uid, JSON.stringify(ids));
				for (const { installation } of old) {
					await tx.execute(`DELETE FROM pending_redelivery WHERE installation = ?
						AND NOT EXISTS (SELECT 1 FROM installation_links WHERE installation = ?)`, installation, installation);
				}
			});
		},
		internalLinked: async (c, installation: GithubId) => {
			requireServiceFor(c, "call");
			return linked(c.db, installation);
		},
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
