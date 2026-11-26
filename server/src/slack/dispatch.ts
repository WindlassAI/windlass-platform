/** The signed request only commits a route snapshot and arms a durable wake. Slack/GitHub I/O
 * belongs to the worker, never to the HTTP acknowledgement or the inbox's short write queue. */
import { actor, UserError } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db, type RawAccess } from "rivetkit/db";
import { isActorGone, userActor } from "../actors/internal.js";
import { slackWorkspace, workspaceOps, WORKSPACE_TABLES } from "../actors/slack-workspace.js";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { ownEngineEndpoint } from "../config.js";
import type { GithubId } from "../contract.js";
import { refusals, type IntakeFiled } from "../factory/intake.js";
import { openSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import { slackApp, SlackError } from "./app.js";
import { isSlackTeam } from "./identity.js";
import type { SlackDelivery, SlackDispatch } from "./webhook.js";

const RUN = "internalRunSlackDelivery";
const DAY = 86_400_000;
export const SLACK_DISPATCH_TABLES = [
	`CREATE TABLE IF NOT EXISTS slack_inbox (id TEXT PRIMARY KEY, received INTEGER NOT NULL, payload TEXT,
		uid TEXT, repository TEXT, generation TEXT, notice TEXT, attempts INTEGER NOT NULL DEFAULT 0, alarm TEXT)`,
	"CREATE INDEX IF NOT EXISTS slack_inbox_age ON slack_inbox(received)",
];
type Ctx = {
	key: string[]; db: RawAccess; vars: { queue: Promise<void>; writing: Promise<void>; running: Set<string> };
	schedule: { at(at: number, action: typeof RUN, id: string): Promise<string>; cancel(id: string): Promise<boolean> };
};
type Job = { payload: string; notice: string | null; uid: string | null; repository: string; generation: string; attempts: number; alarm: string | null };
function writing<T>(c: Ctx, job: () => Promise<T>) {
	const run = c.vars.writing.then(job);
	c.vars.writing = run.then(() => {}, () => {});
	return run;
}
async function arm(c: Ctx, id: string, at: number) {
	const alarm = await c.schedule.at(at, RUN, id);
	await c.db.execute("UPDATE slack_inbox SET alarm=? WHERE id=?", alarm, id);
	return alarm;
}

/** Called only by the service, with the normalizer's delivery. Pin the link and mapping in one
 * SQLite statement; a request from before a link/remap must never acquire its new authority. */
export function enqueueSlack(c: Ctx, delivery: SlackDelivery): Promise<SlackDispatch> {
	const { kind, deliveryId, teamId, channelId, userId, threadTs, messageTs, sentAt } = delivery;
	if (!isSlackTeam(teamId) || c.key.length !== 1 || c.key[0] !== teamId || !/^[CG][A-Z0-9]{1,127}$/.test(channelId)
		|| !/^[UW][A-Z0-9]{1,127}$/.test(userId) || !(kind === "command" ? /^command:[a-f0-9]{64}$/.test(deliveryId) : kind === "app_mention" && /^[A-Za-z0-9]{2,128}$/.test(deliveryId))) return Promise.resolve("ignored");
	return writing(c, async () => {
		const now = Date.now();
		await c.db.execute("DELETE FROM slack_inbox WHERE received < ?", now - 7 * DAY);
		const [old] = await c.db.execute<Job>("SELECT payload,alarm FROM slack_inbox WHERE id=?", deliveryId);
		if (old) {
			if (old.payload && !old.alarm) await arm(c, deliveryId, now);
			return "duplicate";
		}
		const [route] = await c.db.execute<{ repository: string; generation: string; uid: string | null }>(`SELECT repository, generation,
			(SELECT uid FROM slack_identity WHERE user_id=?) AS uid FROM slack_channel, slack_install WHERE slack_channel.id=? AND bot<>?`, userId, channelId, userId);
		const text = route?.uid ? delivery.text.slice(0, 4000) : "";
		const payload = route ? JSON.stringify({ kind, deliveryId, teamId, channelId, userId, text, messageTs, threadTs, sentAt } satisfies SlackDelivery) : null;
		await c.db.execute("INSERT INTO slack_inbox(id,received,payload,uid,repository,generation) VALUES(?,?,?,?,?,?)",
			deliveryId, now, payload, route?.uid ?? null, route ? JSON.stringify(JSON.parse(route.repository).id) : null, route?.generation ?? null);
		if (!route) return "ignored";
		await arm(c, deliveryId, now);
		return "taken";
	});
}

const notices = {
	limit: "You have reached today's Windlass intake limit. Try again after 00:00 UTC.",
	access: "Your GitHub account needs write access to the mapped repository.",
	connect: "Connect GitHub in Windlass Settings to file here.",
	empty: "Include a description of the work to file.",
	off: refusals.off,
	other: "Your account could not file this work item. Check your Windlass and GitHub access.",
};
function noticeOf(result: Extract<IntakeFiled, { kind: "refused" }>): keyof typeof notices {
	if (result.dailyCap) return "limit";
	for (const key of ["access", "connect", "empty", "off"] as const) if (result.reason === notices[key]) return key;
	return "other";
}

function withPinnedRoute<T>(c: Ctx, row: Job, d: SlackDelivery, repo: GithubId, act: (ops: ReturnType<typeof workspaceOps>) => Promise<T>) {
	// Order removal, unlink and disconnect against the whole filing decision. Intake does
	// not wait for the item's Slack outbox; admission uses a separate, short write queue.
	// Nested workspace operations must not wait on the job that is calling them.
	const handoff = c.vars.queue.then(async () => {
		const ops = workspaceOps({ key: c.key, db: c.db, vars: { queue: Promise.resolve() } });
		const current = await ops.internalLookup(d.teamId, d.channelId, d.userId);
		if (!current || current.generation !== row.generation || current.repository.id !== repo || current.uid !== row.uid) return;
		return act(ops);
	});
	c.vars.queue = handoff.then(() => {}, () => {});
	return handoff;
}

async function deliver(c: Ctx & Parameters<typeof userActor>[0], row: Job) {
	const d: SlackDelivery = JSON.parse(row.payload);
	const repo: GithubId = JSON.parse(row.repository);
	if (!row.notice) {
		const result = await withPinnedRoute(c, row, d, repo, async ops => {
			if (row.uid === null) {
				await ops.internalPromptLink(d.teamId, d.channelId, d.userId);
				return;
			}
			return userActor(c, row.uid).internalSlackIntake({ delivery: d, requesterUid: row.uid, repository: { id: repo }, generation: row.generation });
		});
		if (result?.kind !== "refused") return;
		row.notice = noticeOf(result);
		// A retry of the private refusal must not refile the request under changed permissions.
		await c.db.execute("UPDATE slack_inbox SET notice=?,payload=? WHERE id=?", row.notice, JSON.stringify({ ...d, text: "" }), d.deliveryId);
	}
	const message = Object.hasOwn(notices, row.notice) ? notices[row.notice as keyof typeof notices] : notices.other;
	await withPinnedRoute(c, row, d, repo, async () => {
		const [install] = await c.db.execute<{ owner: string; sealed: string }>("SELECT owner,sealed FROM slack_install");
		const app = slackApp();
		if (!install || !app) return;
		const bot = openSecret(serverSealer(), install.owner, `slack:${d.teamId}`, "bot", install.sealed);
		await app.postEphemeral(bot, d.channelId, d.userId, message);
	});
}

export async function runSlackDelivery(c: Ctx & Parameters<typeof userActor>[0], id: string, fired: string) {
	const row = await writing(c, async () => {
		const [row] = await c.db.execute<Job>("SELECT * FROM slack_inbox WHERE id=? AND payload IS NOT NULL", id);
		if (!row || row.alarm !== fired) return null;
		// Replace the consumed wake before doing anything that might outlive this process.
		row.alarm = await arm(c, id, Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** row.attempts));
		if (c.vars.running.has(id)) return null;
		c.vars.running.add(id);
		return row;
	});
	if (!row) return;
	try {
		let terminal = true, retryAt = 0;
		try { await deliver(c, row); }
		catch (error) {
			terminal = row.attempts >= 7 || isActorGone(error) || (error as { code?: string } | null)?.code === "slack_unavailable"
				|| error instanceof SlackError && !error.rateLimited && !error.unreachable;
			if (error instanceof SlackError) retryAt = error.retryAt;
		}
		await writing(c, async () => {
			if (terminal) {
				const [receipt] = await c.db.execute<{ alarm: string }>(`UPDATE slack_inbox SET payload=NULL,uid=NULL,repository=NULL,generation=NULL,notice=NULL WHERE id=? RETURNING alarm`, id);
				if (receipt?.alarm) await c.schedule.cancel(receipt.alarm).catch(() => false);
			} else {
				await c.db.execute("UPDATE slack_inbox SET attempts=attempts+1 WHERE id=?", id);
				if (retryAt > Date.now()) await arm(c, id, retryAt);
			}
		});
	} finally { c.vars.running.delete(id); }
}

export const slackDispatchWorkspace = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !isSlackTeam(c.key[0])) c.destroy(); },
	db: db({ onMigrate: async db => { for (const sql of [...WORKSPACE_TABLES, ...SLACK_DISPATCH_TABLES]) await db.execute(sql); } }),
	createVars: () => ({ queue: Promise.resolve(), writing: Promise.resolve(), running: new Set<string>() }),
	onWake: c => writing(c, async () => {
		const pending = await c.db.execute<{ id: string; alarm: string | null }>("SELECT id,alarm FROM slack_inbox WHERE payload IS NOT NULL");
		if (!pending.length) return;
		const held = new Set((await c.schedule.list()).map(s => s.id));
		for (const job of pending) if (!job.alarm || !held.has(job.alarm)) await arm(c, job.id, Date.now());
	}),
	actions: {
		...slackWorkspace.config.actions!,
		internalReceive(c, delivery: SlackDelivery) { requireServiceFor(c, "call"); return enqueueSlack(c, delivery); },
		internalRunSlackDelivery(c, id: string) {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			return runSlackDelivery(c, id, c.scheduledFire.id);
		},
	},
});

type WorkspaceClient = { slackWorkspace: { get(key: string[], options: { params: unknown }): { internalReceive(d: SlackDelivery): Promise<SlackDispatch> } } };
let client: WorkspaceClient | undefined;
export async function dispatchSlackDelivery(delivery: SlackDelivery): Promise<SlackDispatch> {
	if (!isSlackTeam(delivery.teamId)) return "ignored";
	client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as WorkspaceClient;
	try { return await client.slackWorkspace.get([delivery.teamId], { params: serviceParams() }).internalReceive(delivery); }
	catch (error) { if (isActorGone(error)) return "ignored"; throw error; }
}
