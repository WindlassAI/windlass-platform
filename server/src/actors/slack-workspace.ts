import { createHash, randomUUID } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import { config } from "../config.js";
import type { SlackMapping } from "../contract.js";
import { openSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import { listChannels, postMessage, postPrivate, revoke } from "../slack/app.js";
import type { SlackDelivery } from "../slack/webhook.js";
import { userActor } from "./internal.js";

type Install = { owner: string; name: string; bot: string; sealed: string };
type Mapping = { id: string; name: string; repository: string; generation: string };
type Ctx = { db: RawAccess; key: string[]; vars: { queue: Promise<unknown> }; client(): any };
const unavailable = () => new UserError("This Slack connection is no longer available.", { code: "slack_unavailable" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function serial<T>(c: Ctx, work: () => Promise<T>) {
	const run = c.vars.queue.then(work);
	c.vars.queue = run.catch(() => {});
	return run;
}
async function install(c: Ctx, owner?: string) {
	const [row] = await c.db.execute<Install>("SELECT * FROM install");
	if (!row || (owner && row.owner !== owner)) throw unavailable();
	return row;
}
function token(c: Ctx, row: Install) {
	return openSecret(serverSealer(), row.owner, `slack:${c.key[0]}`, "bot", row.sealed);
}

const route = `SELECT m.generation, m.repository, (SELECT uid FROM member WHERE user_id=?) AS uid
	FROM mapping m, install WHERE m.id=? AND install.bot<>?`;
type Route = { generation: string; repository: string; uid: string | null };
async function deliver(c: Ctx, d: SlackDelivery, generation: string, uid: string | null) {
	const [current] = await c.db.execute<Route>(route, d.userId, d.channelId, d.userId);
	if (!current || current.generation !== generation || current.uid !== uid) return;
	const bearer = token(c, await install(c));
	// Slash commands also reach channels the bot has left since the mapping was saved.
	if (d.deliveryId.startsWith("command:") && !(await listChannels(bearer)).some(channel => channel.id === d.channelId)) return;
	if (!uid) {
		const proof = randomUUID();
		await c.db.execute("INSERT OR REPLACE INTO proof VALUES(?,?,?)", hash(proof), d.userId, Date.now() + 300_000);
		await postPrivate(bearer, d.channelId, d.userId, `Link your Windlass account, then try again: ${config.origins[0]}/settings#slack-link=${d.teamId}.${proof}`);
		return;
	}
	const repository: SlackMapping["repository"] = JSON.parse(current.repository);
	const result = await userActor(c, uid).internalSlackIntake({ delivery: d, repository, generation });
	if (result.kind === "refused") await postPrivate(bearer, d.channelId, d.userId, result.reason);
}

export const slackWorkspace = actor({
	onBeforeConnect: internalConnection,
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS install (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, name TEXT, bot TEXT, sealed TEXT)");
		await db.execute("CREATE TABLE IF NOT EXISTS mapping (id TEXT PRIMARY KEY, name TEXT, repository TEXT, generation TEXT)");
		await db.execute("CREATE TABLE IF NOT EXISTS member (uid TEXT PRIMARY KEY, user_id TEXT UNIQUE)");
		await db.execute("CREATE TABLE IF NOT EXISTS proof (digest TEXT PRIMARY KEY, user_id TEXT UNIQUE, expires INTEGER)");
		await db.execute("CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, received INTEGER, payload TEXT, generation TEXT, uid TEXT, attempts INTEGER DEFAULT 0)");
	} }),
	createVars: () => ({ queue: Promise.resolve() as Promise<unknown> }),
	actions: {
		async internalInstall(c, row: Install) {
			requireServiceFor(c, "call");
			const saved = await c.db.execute("INSERT INTO install VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,bot=excluded.bot,sealed=excluded.sealed WHERE owner=excluded.owner RETURNING id", row.owner, row.name, row.bot, row.sealed);
			if (!saved.length) throw new UserError("Another Windlass account manages this workspace.", { code: "slack_owner" });
		},
		async internalView(c, uid: string) {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<Install>("SELECT * FROM install WHERE owner=?", uid);
			if (!row) return null;
			const mappings = await c.db.execute<Mapping>("SELECT * FROM mapping ORDER BY name");
			return { workspaceName: row.name, mappings: mappings.map(m => ({ channel: { id: m.id, name: m.name }, repository: JSON.parse(m.repository) as SlackMapping["repository"] })) };
		},
		async internalChannels(c, uid: string) {
			requireServiceFor(c, "call");
			return listChannels(token(c, await install(c, uid)));
		},
		async internalMap(c, uid: string, id: string, repository: SlackMapping["repository"] | null) {
			requireServiceFor(c, "call");
			await serial(c, async () => {
				const row = await install(c, uid);
				if (!repository) { await c.db.execute("DELETE FROM mapping WHERE id=?", id); return; }
				const channel = (await listChannels(token(c, row))).find(channel => channel.id === id);
				if (!channel) throw unavailable();
				await c.db.execute("INSERT OR REPLACE INTO mapping VALUES(?,?,?,?)", id, channel.name, JSON.stringify(repository), randomUUID());
			});
		},
		async internalDisconnect(c, uid: string) {
			requireServiceFor(c, "call");
			await serial(c, async () => {
				const row = await install(c, uid);
				await c.db.transaction(async tx => {
					for (const table of ["install", "mapping", "member", "proof"]) await tx.execute(`DELETE FROM ${table}`);
					await tx.execute("UPDATE inbox SET payload=NULL,uid=NULL");
				});
				await revoke(token(c, row)).catch(() => {}); // Local disconnect also works with a revoked token.
			});
		},
		async internalLink(c, uid: string, proof: string) {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				const [row] = await tx.execute<{ user_id: string }>("DELETE FROM proof WHERE digest=? AND expires>? RETURNING user_id", hash(proof), Date.now());
				if (!row) throw new UserError("This Slack link has expired or was already used.", { code: "slack_proof" });
				await tx.execute("INSERT INTO member VALUES(?,?)", uid, row.user_id);
			});
		},
		async internalLinked(c, uid: string) {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ name: string }>("SELECT name FROM install,member WHERE member.uid=?", uid);
			return row?.name ?? null;
		},
		async internalUnlink(c, uid: string) {
			requireServiceFor(c, "call");
			await serial(c, () => c.db.execute("DELETE FROM member WHERE uid=?", uid));
		},
		async internalReceive(c, d: SlackDelivery) {
			requireServiceFor(c, "call");
			// Snapshot authority in the same write as the dedupe key. A retry number identifies an attempt, not a request.
			await c.db.execute("DELETE FROM inbox WHERE received<?", Date.now() - 7 * 86_400_000);
			await c.db.transaction(async tx => {
				const [current] = await tx.execute<Route>(route, d.userId, d.channelId, d.userId);
				const payload = current ? JSON.stringify(current.uid ? d : { ...d, text: "" }) : null;
				await tx.execute("INSERT OR IGNORE INTO inbox(id,received,payload,generation,uid) VALUES(?,?,?,?,?)",
					d.deliveryId, Date.now(), payload, current?.generation ?? null, current?.uid ?? null);
			});
			if ((await c.db.execute("SELECT 1 FROM inbox WHERE id=? AND payload IS NOT NULL", d.deliveryId)).length)
				await c.schedule.after(0, "internalDeliver", d.deliveryId);
		},
		async internalDeliver(c, id: string) {
			if (!c.scheduledFire) throw unavailable();
			await serial(c, async () => {
				const [row] = await c.db.execute<{ payload: string; generation: string; uid: string | null; attempts: number }>(
					"UPDATE inbox SET attempts=attempts+1 WHERE id=? AND payload IS NOT NULL RETURNING *", id);
				if (!row) return;
				// Arm the retry before contacting another actor. Its idempotency key survives a lost reply.
				const retry = await c.schedule.after(Math.min(1800_000, 15_000 * 2 ** Math.min(row.attempts - 1, 7)), "internalDeliver", id);
				try { await deliver(c, JSON.parse(row.payload), row.generation, row.uid); }
				catch (error) {
					if (row.attempts < 8 && (error as { code?: string }).code !== "slack_unavailable") return;
					c.log.warn({ msg: "Slack filing could not be delivered", attempts: row.attempts });
				}
				await c.db.execute("UPDATE inbox SET payload=NULL,uid=NULL WHERE id=?", id);
				await c.schedule.cancel(retry);
			});
		},
		async internalPost(c, channel: string, generation: string, message: string, threadTs: string | null) {
			requireServiceFor(c, "call");
			return serial(c, async () => {
				const row = await install(c);
				if (!(await c.db.execute("SELECT 1 FROM mapping WHERE id=? AND generation=?", channel, generation)).length) throw unavailable();
				return postMessage(token(c, row), channel, message, threadTs);
			});
		},
	},
});
