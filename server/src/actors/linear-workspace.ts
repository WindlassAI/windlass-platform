/**
 * linearWorkspace[workspaceId]: what the platform knows of one Linear workspace that an owner connected, and every delivery
 * that arrived for it. Only service actions read or write it.
 *
 *   owner         the user whose connection the workspace is (the newest one: only an administrator of the workspace can
 *                 authorize the app), the app user an issue is assigned to, and the teams that are mapped. The user's actor
 *                 keeps the mappings and decides every filing; this is the copy the webhook route asks, so it can turn an
 *                 unmapped team away without waking anyone.
 *   deliveries    one row per `Linear-Delivery`, written before the route answers. That row is the durable decision to take the
 *                 delivery in: a second one with the same id is a redelivery and changes nothing, whether the first was
 *                 finished or was interrupted between being taken in and being filed. An unfinished row is worked on again
 *                 (here, on wake and on a timer) until the owner's actor has answered; the answer is kept in the row.
 *
 * Why a retry cannot file twice. What a row asks of the owner's actor is `fileLinearDelivery`, whose item is keyed by the Linear
 * issue (actors/issue-intake.ts): the same issue has one active item however often, and from however many deliveries, it is asked.
 * Rows are kept seven days.
 */

import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { createClient } from "rivetkit/client";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { ownEngineEndpoint } from "../config.js";
import { isLinearId } from "../linear/app.js";
import type { LinearDelivery, LinearWebhookStore, LinearWorkspaceLink } from "../linear/webhook.js";
import { isActorGone } from "./internal.js";

const DAY = 86_400_000;
const FIRST_RETRY = 15_000;
const KEPT = 7 * DAY;
const MAX_ATTEMPTS = 8;
const MAX_WAITING = 2_000;

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

/** Called under the actor's write queue. The replacement is durable before its predecessor is cancelled. */
async function arm(c: Ctx, at: number | null) {
	const [old] = await c.db.execute<{ id: string; at: number }>("SELECT id, at FROM timer");
	if (at === null) {
		if (!old) return;
		await c.db.execute("DELETE FROM timer");
	} else {
		if (old?.at === at && at > Date.now()) return;
		const id = await c.schedule.at(Math.max(Date.now(), at), "internalDue");
		await c.db.execute("INSERT OR REPLACE INTO timer VALUES (1, ?, ?)", id, at);
	}
	if (old) await c.schedule.cancel(old.id).catch(() => false);
}

async function armDeliveries(c: Ctx) {
	const [row] = await c.db.execute<{ at: number | null }>(`SELECT min(at) AS at FROM (
		SELECT min(received_at) + ? AS at FROM deliveries UNION ALL
		SELECT min(next_at) FROM deliveries WHERE state = 'received')`, KEPT);
	const due = row?.at;
	// Due work is being drained: a watchdog stays in case the node stops during it.
	await arm(c, due == null ? null : due <= Date.now() ? Date.now() + FIRST_RETRY : due);
}

type Row = { id: string; data: string; attempts: number };

/** What the owner's actor answered, as kept: the kind and its reason or item, nothing of the issue's text. */
type Decision = { kind: string; why?: string; itemId?: string };

async function decide(c: Ctx, delivery: LinearDelivery): Promise<Decision> {
	const [owner] = await c.db.execute<{ uid: string }>("SELECT uid FROM owner");
	if (!owner) return { kind: "ignored", why: "The workspace is not connected." };
	const [mapped] = await c.db.execute("SELECT 1 FROM mapped_team WHERE team_id = ?", delivery.teamId);
	if (!mapped) return { kind: "ignored", why: "The team is not mapped." };
	const answer = await c.client().user.get([owner.uid], { params: serviceParams() }).internalLinearDelivery(delivery) as
		{ kind: string; why?: string; reason?: string; itemId?: string };
	return { kind: answer.kind, ...(answer.why || answer.reason ? { why: String(answer.why ?? answer.reason).slice(0, 300) } : {}), ...(answer.itemId ? { itemId: answer.itemId } : {}) };
}

async function drainDue(c: Ctx) {
	await queued(c, () => c.db.execute("DELETE FROM deliveries WHERE received_at <= ?", Date.now() - KEPT));
	for (;;) {
		const [row] = await c.db.execute<Row>("SELECT id, data, attempts FROM deliveries WHERE state = 'received' AND next_at <= ? ORDER BY received_at, rowid LIMIT 1", Date.now());
		if (!row) break;
		const attempts = row.attempts + 1;
		let state = "done", decision: Decision = { kind: "failed" }, next = 0;
		try {
			decision = await decide(c, JSON.parse(row.data) as LinearDelivery);
		} catch (error) {
			// An actor that is gone owns no connection any more: nothing to file for. Anything else is tried again.
			if (isActorGone(error)) decision = { kind: "ignored", why: "The owner is gone." };
			else {
				state = attempts >= MAX_ATTEMPTS ? "failed" : "received";
				next = Date.now() + Math.min(30 * 60_000, FIRST_RETRY * 2 ** (attempts - 1));
				decision = { kind: "retry", why: "The owner's actor could not be reached." };
			}
		}
		await queued(c, () => c.db.execute("UPDATE deliveries SET state = ?, decision = ?, next_at = ?, attempts = ? WHERE id = ?", state, JSON.stringify(decision), next, attempts, row.id));
		const where = `workspace=${c.key[0]} delivery=${row.id}`;
		if (state === "failed") console.warn(`linear.delivery.failed ${where}`);
		else if (state === "done") console.log(`linear.delivery.${decision.kind} ${where}${decision.itemId ? ` item=${decision.itemId}` : ""}${decision.why ? ` (${decision.why})` : ""}`);
	}
}

async function drain(c: Ctx) {
	if (c.vars.draining) {
		c.vars.drainAgain = true;
		return;
	}
	c.vars.draining = true;
	try {
		// A receive can finish while a pass is looking at an empty table.
		do {
			c.vars.drainAgain = false;
			await drainDue(c);
		} while (c.vars.drainAgain);
	} finally {
		c.vars.draining = false;
		await queued(c, () => armDeliveries(c));
	}
}

function runDrain(c: Ctx) {
	void c.keepAwake(drain(c).catch(() => console.warn("linear.workspace.drain_failed")));
}

export const linearWorkspace = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !isLinearId(c.key[0]) || c.key[0] !== c.key[0]!.toLowerCase()) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), uid TEXT NOT NULL, app_user_id TEXT NOT NULL, attached_at INTEGER NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS mapped_team (team_id TEXT PRIMARY KEY)");
		await db.execute("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, data TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, decision TEXT NOT NULL)");
		await db.execute("CREATE INDEX IF NOT EXISTS linear_delivery_due ON deliveries(state, next_at)");
		await db.execute("CREATE TABLE IF NOT EXISTS timer (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, at INTEGER NOT NULL)");
	} }),
	createVars: vars,
	onWake: runDrain,
	actions: {
		/** The owner connected the workspace (or connected it again): they are its owner, with these teams mapped. Answers with the owner it replaced. */
		internalAttach: async (c, input: { uid: string; appUserId: string; mapped: string[] }): Promise<string | null> => {
			requireServiceFor(c, "call");
			const mapped = input.mapped.filter(id => isLinearId(id)).map(id => id.toLowerCase());
			if (typeof input.uid !== "string" || input.uid === "" || !isLinearId(input.appUserId)) throw new Error("The connection is not well formed.");
			const previous = await queued(c, () => c.db.transaction(async tx => {
				const [old] = await tx.execute<{ uid: string }>("SELECT uid FROM owner");
				await tx.execute("INSERT OR REPLACE INTO owner VALUES (1, ?, ?, ?)", input.uid, input.appUserId.toLowerCase(), Date.now());
				await tx.execute("DELETE FROM mapped_team");
				for (const id of mapped) await tx.execute("INSERT OR IGNORE INTO mapped_team VALUES (?)", id);
				return old?.uid ?? null;
			}));
			if (previous && previous !== input.uid) {
				console.log(`linear.workspace.replaced workspace=${c.key[0]} from=${previous} to=${input.uid}`);
				// Its connection no longer receives deliveries; it is told so it does not show a connection that is not.
				await c.client().user.get([previous], { params: serviceParams() }).internalLinearReleased(c.key[0]).catch(() => console.warn(`linear.workspace.release_notice_failed workspace=${c.key[0]}`));
			}
			return previous !== input.uid ? previous : null;
		},
		/** Routes a team to its owner's mapping, or stops. Only the owner may. */
		internalMap: async (c, input: { uid: string; teamId: string; mapped: boolean }): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (!isLinearId(input.teamId)) return false;
			return queued(c, () => c.db.transaction(async tx => {
				const [owner] = await tx.execute<{ uid: string }>("SELECT uid FROM owner");
				if (owner?.uid !== input.uid) return false;
				if (input.mapped) await tx.execute("INSERT OR IGNORE INTO mapped_team VALUES (?)", input.teamId.toLowerCase());
				else await tx.execute("DELETE FROM mapped_team WHERE team_id = ?", input.teamId.toLowerCase());
				return true;
			}));
		},
		/** The owner connected another workspace, or this one was taken: nothing is routed to them. */
		internalRelease: async (c, uid: string) => {
			requireServiceFor(c, "call");
			await queued(c, () => c.db.transaction(async tx => {
				if (!(await tx.execute("DELETE FROM owner WHERE uid = ? RETURNING uid", uid)).length) return;
				await tx.execute("DELETE FROM mapped_team");
			}));
		},
		/** What the webhook route needs before it takes a delivery in. Null: nobody owns this workspace. */
		internalLink: async (c, teamId: string): Promise<LinearWorkspaceLink | null> => {
			requireServiceFor(c, "call");
			const [owner] = await c.db.execute<{ app_user_id: string }>("SELECT app_user_id FROM owner");
			if (!owner) return null;
			const mapped = isLinearId(teamId) && (await c.db.execute("SELECT 1 FROM mapped_team WHERE team_id = ?", teamId.toLowerCase())).length > 0;
			return { appUserId: owner.app_user_id, mapped };
		},
		/**
		 * Takes a verified delivery in: written before this answers, so a lost answer is a redelivery that finds its row. Only a
		 * delivery that is not in the table is new; one that is, finished or not, changes nothing and gets the work moving again.
		 */
		internalReceive: async (c, d: LinearDelivery): Promise<"taken" | "duplicate" | "busy"> => {
			requireServiceFor(c, "call");
			if (c.key.length !== 1 || d.workspaceId.toLowerCase() !== c.key[0] || !isLinearId(d.deliveryId) || !isLinearId(d.teamId) || !isLinearId(d.issueId)) throw new Error("Wrong workspace.");
			const result = await queued(c, async () => {
				const result = await c.db.transaction(async tx => {
					await tx.execute("DELETE FROM deliveries WHERE received_at <= ?", Date.now() - KEPT);
					if ((await tx.execute("SELECT 1 FROM deliveries WHERE id = ?", d.deliveryId.toLowerCase())).length) return "duplicate" as const;
					const [count] = await tx.execute<{ waiting: number }>("SELECT count(CASE WHEN state = 'received' THEN 1 END) AS waiting FROM deliveries");
					if (count!.waiting >= MAX_WAITING) return "busy" as const;
					await tx.execute("INSERT INTO deliveries VALUES (?, ?, ?, 'received', 0, ?, '{}')", d.deliveryId.toLowerCase(), JSON.stringify(d), Date.now(), Date.now());
					return "taken" as const;
				});
				// The wake is durable before the route is answered; a duplicate also repairs a lost one.
				if (result !== "busy") await armDeliveries(c);
				return result;
			});
			if (result === "taken") console.log(`linear.delivery.stored workspace=${c.key[0]} delivery=${d.deliveryId}`);
			if (result !== "busy") runDrain(c);
			return result;
		},
		internalDue: async c => {
			if (!c.scheduledFire) requireServiceFor(c, "call");
			await queued(c, () => armDeliveries(c));
			await drain(c);
		},
	},
});

// ---------------------------------------------------------------------------------------------
// The webhook route's store
// ---------------------------------------------------------------------------------------------

interface WorkspaceActions {
	internalLink(teamId: string): Promise<LinearWorkspaceLink | null>;
	internalReceive(delivery: LinearDelivery): Promise<"taken" | "duplicate" | "busy">;
}

let client: { linearWorkspace: { get(key: string[], options: { params: unknown }): unknown; getOrCreate(key: string[], options: { params: unknown }): unknown } } | null = null;

function workspaceActions(workspaceId: string, create: boolean): WorkspaceActions {
	client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as NonNullable<typeof client>;
	const options = { params: serviceParams() };
	return (create ? client.linearWorkspace.getOrCreate([workspaceId], options) : client.linearWorkspace.get([workspaceId], options)) as WorkspaceActions;
}

/**
 * What `POST /linear/webhook` needs of the actors. A workspace nobody connected has no actor: it is unknown, and is not made by a
 * delivery. A workspace's id is the signed delivery's; the route has already checked the signature.
 */
export const actorLinearWebhookStore: LinearWebhookStore = {
	async lookup(workspaceId, teamId) {
		try {
			return await workspaceActions(workspaceId, false).internalLink(teamId);
		} catch (error) {
			if (isActorGone(error)) return null;
			throw error;
		}
	},
	async receive(delivery) {
		return workspaceActions(delivery.workspaceId, false).internalReceive(delivery);
	},
};
