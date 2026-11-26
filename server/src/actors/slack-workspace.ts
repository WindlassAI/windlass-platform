/** One service-only actor per Slack workspace. The user actor checks GitHub write access
 * before saving a repository; the member's actor must check it again before filing. */
import { randomUUID } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import { config } from "../config.js";
import type { GithubId, SlackMapping } from "../contract.js";
import { isGithubId } from "../github/ids.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import { slackApp } from "../slack/app.js";
import { openSlackTicket } from "../slack/connect.js";
import { IDENTITY_TABLES, clearIdentity, issueProof, isSlackTeam, linkedIdentity, redeemProof, resolveIdentity, unlinkIdentity } from "../slack/identity.js";

export const WORKSPACE_TABLES = [
	`CREATE TABLE IF NOT EXISTS slack_install (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, name TEXT NOT NULL,
		bot TEXT NOT NULL, connected_at INTEGER NOT NULL, sealed TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS slack_channel (id TEXT PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL, generation TEXT NOT NULL)`,
	...IDENTITY_TABLES,
];

type WorkspaceCtx = { key: string[]; db: RawAccess; vars: { queue: Promise<void> } };
type Install = { owner: string; name: string; bot: string; connected_at: number; sealed: string };
type Channel = { id: string; name: string; repository: string; generation: string };
const decline = () => new UserError("The Slack connection or mapping is no longer available.", { code: "slack_unavailable" });
function app() { const a = slackApp(); if (!a) throw decline(); return a; }
const messages = {
	started: "Work item filed", plan: "Plan ready for approval", question: "Question ready", pr: "Pull request opened", done: "Work item finished", failed: "Work item failed",
};
export interface SlackPost {
	teamId: string; channelId: string; repositoryId: GithubId; generation: string;
	itemId: string; event: keyof typeof messages; threadTs: string | null;
}

/** Shared by the actor actions and the offline integration check. No operation returns a bearer. */
export function workspaceOps(c: WorkspaceCtx) {
	const team = c.key[0];
	if (c.key.length !== 1 || !isSlackTeam(team)) throw decline();
	const scope = `slack:${team}`;
	function queued<T>(job: () => Promise<T>) {
		const run = c.vars.queue.then(job);
		c.vars.queue = run.then(() => {}, () => {});
		return run;
	}
	async function install() { return (await c.db.execute<Install>("SELECT * FROM slack_install"))[0]; }
	async function owned(uid: string) {
		const row = await install();
		if (!row || row.owner !== uid) throw decline();
		return row;
	}
	function token(row: Install) { return openSecret(serverSealer(), row.owner, scope, "bot", row.sealed); }
	async function mapping(channel: string) { return (await c.db.execute<Channel>("SELECT * FROM slack_channel WHERE id=?", channel))[0]; }
	function repository(row: Channel): SlackMapping["repository"] { return JSON.parse(row.repository); }
	async function route(teamId: string, channelId: string) {
		if (team !== teamId) throw decline();
		const row = await install();
		const channel = await mapping(channelId);
		if (!row || !channel) return null;
		const bearer = token(row);
		return await app().channel(bearer, channelId) ? { channel, bearer } : null;
	}
	return {
		internalInstall: (uid: string, ticket: string) => queued(async () => {
			// The user's actor already consumed the matching callback nonce. Only a sealed,
			// account-bound ticket crosses this actor boundary (not the OAuth bearer).
			let grant;
			try { grant = openSlackTicket(uid, ticket).install; } catch { throw decline(); }
			const previous = await install();
			if (!uid || grant.teamId !== team || (previous && previous.owner !== uid)) throw decline();
			const bot = await app().identity(grant.accessToken);
			if (bot.teamId !== team || bot.botUserId !== grant.botUserId) throw decline();
			const sealed = sealSecret(serverSealer(), uid, scope, "bot", grant.accessToken);
			await c.db.transaction(async tx => {
				await tx.execute("INSERT OR REPLACE INTO slack_install VALUES (1,?,?,?,?,?)", uid, bot.teamName, bot.botUserId, Date.now(), sealed);
				// Reauthorization preserves settings, but old thread handles do not authorize this bot.
				await tx.execute("UPDATE slack_channel SET generation=lower(hex(randomblob(16)))");
			});
		}),
		internalView: (uid: string) => queued(async () => {
			const row = await install();
			if (!row || row.owner !== uid) return null;
			const channels = await c.db.execute<Channel>("SELECT * FROM slack_channel ORDER BY id");
			return { connection: { workspace: { id: team, name: row.name }, botUserId: row.bot, connectedAt: row.connected_at },
				mappings: channels.map(ch => ({ channel: { id: ch.id, name: ch.name }, repository: repository(ch) })) };
		}),
		internalSaveMapping: (uid: string, channelId: string, repo: SlackMapping["repository"]) => queued(async () => {
			const row = await owned(uid);
			if (!isGithubId(repo?.id) || !repo.owner || !repo.name) throw decline();
			const ch = await app().channel(token(row), channelId);
			if (!ch) throw decline();
			await c.db.execute("INSERT OR REPLACE INTO slack_channel VALUES (?,?,?,?)", ch.id, ch.name, JSON.stringify({ id: repo.id, owner: repo.owner, name: repo.name }), randomUUID());
		}),
		internalRemoveMapping: (uid: string, channelId: string) => queued(async () => {
			await owned(uid);
			await c.db.execute("DELETE FROM slack_channel WHERE id=?", channelId);
		}),
		internalDisconnect: (uid: string) => queued(async () => {
			const row = await owned(uid);
			await c.db.transaction(async tx => {
				await clearIdentity(tx);
				await tx.execute("DELETE FROM slack_channel");
				await tx.execute("DELETE FROM slack_install");
			});
			// Best effort: remote revocation must not keep a dead installation routable.
			try { await app().revoke(token(row)); } catch { /* already disabled locally */ }
		}),
		internalRedeem: (uid: string, ticket: string) => queued(() => redeemProof(c.db, team, uid, ticket)),
		internalLink: (uid: string) => queued(() => linkedIdentity(c.db, team, uid)),
		internalUnlink: (uid: string) => queued(() => unlinkIdentity(c.db, uid)),
		internalLookup: (teamId: string, channelId: string, userId: string) => queued(async () => {
			const active = await route(teamId, channelId);
			if (!active) return null;
			return { repository: repository(active.channel), generation: active.channel.generation, uid: await resolveIdentity(c.db, userId) };
		}),
		// Called only with the identity of a signature-verified request. Do not return the proof.
		internalPromptLink: (teamId: string, channelId: string, userId: string) => queued(async () => {
			const active = await route(teamId, channelId);
			if (!active || await resolveIdentity(c.db, userId)) throw decline();
			const proof = await issueProof(c.db, team, userId);
			await app().postEphemeral(active.bearer, channelId, userId, `Link your Windlass account in Settings, then try again: ${config.origins[0]}/settings#slack-link=${encodeURIComponent(proof)}`);
		}),
		internalPost: (input: SlackPost) => queued(async () => {
			if (!Object.hasOwn(messages, input.event) || !/^[\w-]{1,128}$/.test(input.itemId) ||
				!(input.threadTs === null && input.event === "started" || /^\d{1,16}\.\d{1,6}$/.test(input.threadTs ?? ""))) throw decline();
			const active = await route(input.teamId, input.channelId);
			if (!active || active.channel.generation !== input.generation || repository(active.channel).id !== input.repositoryId) throw decline();
			return app().postMessage(active.bearer, input.channelId, `${messages[input.event]}: ${config.origins[0]}/items/${input.itemId}`, input.threadTs ?? undefined);
		}),
	};
}

function service(c: WorkspaceCtx & { conn?: { params: unknown } | null }) {
	requireServiceFor(c, "call");
	return workspaceOps(c);
}

export const slackWorkspace = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !isSlackTeam(c.key[0])) c.destroy(); },
	db: db({ onMigrate: async db => { for (const sql of WORKSPACE_TABLES) await db.execute(sql); } }),
	createVars: () => ({ queue: Promise.resolve() }),
	actions: {
		internalInstall: (c, uid: string, ticket: string) => service(c).internalInstall(uid, ticket),
		internalView: (c, uid: string) => service(c).internalView(uid),
		internalSaveMapping: (c, uid: string, channelId: string, repo: SlackMapping["repository"]) => service(c).internalSaveMapping(uid, channelId, repo),
		internalRemoveMapping: (c, uid: string, channelId: string) => service(c).internalRemoveMapping(uid, channelId),
		internalDisconnect: (c, uid: string) => service(c).internalDisconnect(uid),
		internalRedeem: (c, uid: string, ticket: string) => service(c).internalRedeem(uid, ticket),
		internalLink: (c, uid: string) => service(c).internalLink(uid),
		internalUnlink: (c, uid: string) => service(c).internalUnlink(uid),
		internalLookup: (c, teamId: string, channelId: string, userId: string) => service(c).internalLookup(teamId, channelId, userId),
		internalPromptLink: (c, teamId: string, channelId: string, userId: string) => service(c).internalPromptLink(teamId, channelId, userId),
		internalPost: (c, input: SlackPost) => service(c).internalPost(input),
	},
});
