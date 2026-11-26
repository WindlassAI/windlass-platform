/** Service-only directories. A callback authenticates a registration, not a project claim. */
import { createHash, randomUUID } from "node:crypto";
import { actor } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { ownEngineEndpoint } from "../config.js";
import type { JiraDelivery, JiraDispatch, JiraWebhookBinding } from "../jira/webhook.js";
import { isActorGone } from "../actor-errors.js";

export const jiraCallbackHash = (key: string): string => createHash("sha256").update(key).digest("hex");
const digest = /^[0-9a-f]{64}$/;
const cloud = /^[a-z0-9][a-z0-9-]{0,127}$/;
const project = /^[1-9]\d{0,31}$/;
type Binding = JiraWebhookBinding & { uid: string };

export const jiraCallback = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !digest.test(c.key[0]!)) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), uid TEXT NOT NULL, site TEXT NOT NULL, url TEXT NOT NULL, hooks TEXT NOT NULL)");
	} }),
	actions: {
		internalBind: async (c, binding: Binding): Promise<void> => {
			requireServiceFor(c, "call");
			if (!binding.uid || !cloud.test(binding.cloudId) || !URL.canParse(binding.siteUrl) ||
				!binding.webhookIds.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error("Invalid Jira binding");
			const updated = await c.db.execute(`INSERT INTO binding VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, hooks=excluded.hooks
				WHERE uid=excluded.uid AND site=excluded.site RETURNING id`, binding.uid, binding.cloudId, binding.siteUrl, JSON.stringify(binding.webhookIds));
			if (!updated.length) throw new Error("Callback belongs to another Jira connection");
		},
		internalUnbind: async (c, input: { uid: string }): Promise<void> => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM binding WHERE uid=?", input.uid);
		},
		internalResolve: async c => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string; site: string; url: string; hooks: string }>("SELECT * FROM binding");
			return row ? { uid: row.uid, cloudId: row.site, siteUrl: row.url, webhookIds: JSON.parse(row.hooks) as number[] } : null;
		},
	},
});

interface JiraUser {
	internalJiraHoldsProject(cloudId: string, projectId: string): Promise<boolean>;
	internalJiraDelivery(delivery: JiraDelivery): Promise<JiraDispatch>;
}
function userActor(c: { client(): any }, uid: string): JiraUser {
	return c.client().user.get([uid], { params: serviceParams() });
}

type Claim = { uid: string; projectId: string };
async function holder(db: RawAccess, projectId: string) {
	const [row] = await db.execute<{ uid: string; epoch: string; revision: string }>("SELECT uid,epoch,revision FROM project_owner WHERE project=?", projectId);
	return row;
}

export async function jiraSiteTables(db: RawAccess) {
	await db.execute("CREATE TABLE IF NOT EXISTS project_owner (project TEXT PRIMARY KEY, uid TEXT NOT NULL, epoch TEXT NOT NULL, revision TEXT NOT NULL)");
	await db.execute("CREATE TABLE IF NOT EXISTS delivery (id TEXT PRIMARY KEY, epoch TEXT, project TEXT NOT NULL, issue TEXT NOT NULL, done INTEGER NOT NULL, received INTEGER NOT NULL)");
	await db.execute("CREATE INDEX IF NOT EXISTS delivery_received ON delivery(received)");
}
const WEEK = 7 * 86_400_000;
export const jiraSite = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !cloud.test(c.key[0]!)) c.destroy(); },
	db: db({ onMigrate: jiraSiteTables }),
	createVars: () => ({ delivering: Promise.resolve() }),
	actions: {
		internalClaim: async (c, { projectId, uid }: Claim): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (!project.test(projectId) || !uid) return false;
			// The revision invalidates a stale probe even when the same owner reasserts its claim.
			// The epoch stays stable for idempotent reassertions, so their pending deliveries survive.
			for (;;) {
				const version = randomUUID();
				const claimed = await c.db.execute(`INSERT INTO project_owner VALUES (?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET revision=excluded.revision
					WHERE uid=excluded.uid RETURNING uid`, projectId, uid, version, version);
				if (claimed.length) return true;
				const old = await holder(c.db, projectId);
				if (!old || old.uid === uid) continue;
				const live = await userActor(c, old.uid).internalJiraHoldsProject(c.key[0]!, projectId).catch(error => {
					if (isActorGone(error)) return false;
					throw error;
				});
				if (live) return false;
				const changed = await c.db.execute("UPDATE project_owner SET uid=?, epoch=?, revision=? WHERE project=? AND revision=? RETURNING uid", uid, version, version, projectId, old.revision);
				if (changed.length) return true;
			}
		},
		internalRelease: async (c, { projectId, uid }: Claim): Promise<void> => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM project_owner WHERE project=? AND uid=?", projectId, uid);
		},
		internalDispatch: async (c, delivery: JiraDelivery, callbackHash: string): Promise<JiraDispatch> => {
			requireServiceFor(c, "call");
			if (delivery.cloudId !== c.key[0] || !digest.test(callbackHash)) return "ignored";
			const run = c.vars.delivering.then(async (): Promise<JiraDispatch> => {
				const binding: Binding | null = await c.client().jiraCallback.get([callbackHash], { params: serviceParams() }).internalResolve();
				if (!binding || binding.cloudId !== delivery.cloudId) return "ignored";
				const matchedWebhookIds = delivery.matchedWebhookIds.filter(id => binding.webhookIds.includes(id));
				if (!matchedWebhookIds.length) return "ignored";
				await c.db.execute("DELETE FROM delivery WHERE received <= ?", Date.now() - WEEK);
				const owner = await c.db.transaction(async tx => {
					const current = await holder(tx, delivery.projectId);
					// Multiple users can have callbacks at this site. An unrelated callback must not consume the owner's delivery.
					if (current && current.uid !== binding.uid) return "ignored";
					const [prior] = await tx.execute<{ done: number; epoch: string | null; project: string; issue: string }>("SELECT * FROM delivery WHERE id=?", delivery.deliveryId);
					if (prior) {
						if (prior.done) return "duplicate";
						if (prior.epoch !== current?.epoch || prior.project !== delivery.projectId || prior.issue !== delivery.issueId) return "ignored";
					} else {
						await tx.execute("INSERT INTO delivery VALUES (?, ?, ?, ?, ?, ?)", delivery.deliveryId, current?.epoch ?? null, delivery.projectId, delivery.issueId, current ? 0 : 1, Date.now());
					}
					return current ?? "ignored";
				});
				if (typeof owner === "string") return owner;
				// A lost reply leaves the same epoch retryable. The user rechecks its current mapping and deduplicates its own filing.
				const result = await userActor(c, owner.uid).internalJiraDelivery({ ...delivery, matchedWebhookIds }).catch(error => {
					if (isActorGone(error)) return "ignored" as const;
					throw error;
				});
				await c.db.execute("UPDATE delivery SET done=1 WHERE id=?", delivery.deliveryId);
				return result;
			});
			c.vars.delivering = run.then(() => {}, () => {});
			return run;
		},
	},
});

interface Directory {
	jiraSite: { get(keys: string[], options: unknown): { internalDispatch(delivery: JiraDelivery, hash: string): Promise<JiraDispatch> } };
	jiraCallback: { get(keys: string[], options: unknown): { internalResolve(): Promise<Binding | null> } };
}
let client: Directory | undefined;
function directories() { return client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as Directory; }
export async function resolveJiraWebhook(key: string): Promise<JiraWebhookBinding | null> {
	try { return await directories().jiraCallback.get([jiraCallbackHash(key)], { params: serviceParams() }).internalResolve(); }
	catch (error) { if (isActorGone(error)) return null; throw error; }
}
export async function dispatchJiraWebhook(delivery: JiraDelivery, key: string): Promise<JiraDispatch> {
	try { return await directories().jiraSite.get([delivery.cloudId], { params: serviceParams() }).internalDispatch(delivery, jiraCallbackHash(key)); }
	catch (error) { if (isActorGone(error)) return "ignored"; throw error; }
}
