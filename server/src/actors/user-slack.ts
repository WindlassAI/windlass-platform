import { randomUUID } from "node:crypto";
import { UserError } from "rivetkit";
import { createClient } from "rivetkit/client";
import type { RawAccess } from "rivetkit/db";
import { requireUser, requireServiceFor, serviceParams } from "../auth.js";
import { config, ownEngineEndpoint } from "../config.js";
import type { GithubId, SlackIdentity, SlackSettingsActions, SlackStatus } from "../contract.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository, type StoredConnection } from "../github/repos.js";
import { slackApp } from "../slack/app.js";
import { issueSlackState, openSlackTicket, SLACK_STATE_TTL_MS, type SlackConnectStore } from "../slack/connect.js";
import { isSlackTeam, proofTeam } from "../slack/identity.js";
import type { workspaceOps } from "./slack-workspace.js";
import { isActorGone } from "./internal.js";

// The workspace owns credentials, mappings and link uniqueness. Only routing references live here.
export const SLACK_TABLES = [
	"CREATE TABLE IF NOT EXISTS slack_state (nonce TEXT PRIMARY KEY, claimed INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS slack_connection_ref (id INTEGER PRIMARY KEY CHECK (id = 1), team_id TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS slack_link_ref (team_id TEXT PRIMARY KEY)",
];

export interface SlackCtx {
	key: string[];
	db: RawAccess;
	vars: { github: StoredConnection | null };
	client(): any;
}

type Workspace = ReturnType<typeof workspaceOps>;
function workspace(c: SlackCtx, team: string, create = false): Workspace {
	const directory = c.client().slackWorkspace;
	const options = { params: serviceParams() };
	return create ? directory.getOrCreate([team], options) : directory.get([team], options);
}

const queues = new WeakMap<object, Promise<unknown>>();
function serial<T>(c: SlackCtx, work: () => Promise<T>): Promise<T> {
	const next = (queues.get(c.vars) ?? Promise.resolve()).then(work);
	queues.set(c.vars, next.catch(() => undefined));
	return next;
}
const problem = (code: string, message: string) => new UserError(message, { code });
function requireSlack() {
	const app = slackApp();
	if (!app) throw problem("slack_off", "This deployment has no Slack app.");
	return app;
}
async function teamRef(c: SlackCtx): Promise<string | null> {
	const [row] = await c.db.execute<{ team_id: string }>("SELECT team_id FROM slack_connection_ref WHERE id=1");
	return row?.team_id ?? null;
}
async function connectedWorkspace(c: SlackCtx) {
	const team = await teamRef(c);
	if (!team) throw problem("slack_not_connected", "Connect a Slack workspace first.");
	return workspace(c, team);
}
async function ifPresent<T>(call: Promise<T>): Promise<T | null> {
	try { return await call; } catch (error) { if (isActorGone(error)) return null; throw error; }
}
async function status(c: SlackCtx): Promise<SlackStatus> {
	if (!slackApp()) return { state: "off" };
	const uid = c.key[0]!;
	const refs = await c.db.execute<{ team_id: string }>("SELECT team_id FROM slack_link_ref ORDER BY team_id");
	const links: SlackIdentity[] = [];
	for (const { team_id } of refs) {
		const link = await ifPresent(workspace(c, team_id).internalLink(uid));
		if (link) links.push(link);
		else await c.db.execute("DELETE FROM slack_link_ref WHERE team_id=?", team_id);
	}
	const team = await teamRef(c);
	if (team) {
		const view = await ifPresent(workspace(c, team).internalView(uid));
		if (view) return { state: "connected", connection: view.connection, mappings: view.mappings, links };
		await c.db.execute("DELETE FROM slack_connection_ref WHERE id=1");
	}
	return { state: "disconnected", links };
}
export function slackStatus(c: SlackCtx) { return serial(c, () => status(c)); }

export function beginSlackConnect(c: SlackCtx, input: { origin: string }) {
	return serial(c, async () => {
		const app = requireSlack();
		const origin = typeof input?.origin === "string" ? input.origin.replace(/\/+$/, "") : "";
		if (!config.origins.includes(origin)) throw problem("origin_not_allowed", "Connect Slack from the web app's own address.");
		const nonce = randomUUID(), now = Date.now();
		await c.db.execute("DELETE FROM slack_state WHERE expires_at <= ?", now);
		await c.db.execute("DELETE FROM slack_state WHERE nonce NOT IN (SELECT nonce FROM slack_state ORDER BY expires_at DESC LIMIT 19)");
		await c.db.execute("INSERT INTO slack_state VALUES (?, 0, ?)", nonce, now + SLACK_STATE_TTL_MS);
		return { url: app.authorizeUrl(issueSlackState(c.key[0]!, nonce, origin, now)) };
	});
}

export async function claimSlackState(c: SlackCtx, nonce: string): Promise<boolean> {
	const now = Date.now();
	const rows = await c.db.execute("UPDATE slack_state SET claimed=1, expires_at=? WHERE nonce=? AND claimed=0 AND expires_at>? RETURNING nonce", now + SLACK_STATE_TTL_MS, nonce, now);
	return rows.length !== 0;
}

export function completeSlackConnection(c: SlackCtx, ticket: string) {
	return serial(c, async () => {
		requireSlack();
		const uid = c.key[0]!;
		const invalid = () => problem("slack_ticket", "This connection ticket is invalid or expired. Start a new connection.");
		let confirmed;
		try { confirmed = openSlackTicket(uid, ticket); } catch { throw invalid(); }
		const team = confirmed.install.teamId;
		const used = await c.db.execute("DELETE FROM slack_state WHERE nonce=? AND claimed=1 AND expires_at>? RETURNING nonce", confirmed.nonce, Date.now());
		if (!used.length) throw invalid();
		const previous = await teamRef(c);
		if (previous && previous !== team && await ifPresent(workspace(c, previous).internalView(uid))) {
			throw problem("slack_connected", "Disconnect the current Slack workspace before connecting a different one.");
		}
		// Write ahead of the remote mutation: a lost success reply must not orphan the owner's install.
		await c.db.execute("INSERT OR REPLACE INTO slack_connection_ref VALUES (1, ?)", team);
		await workspace(c, team, true).internalInstall(uid, ticket);
		return status(c);
	});
}

function channelId(value: unknown): string {
	if (typeof value !== "string" || !/^[CG][A-Z0-9]{1,127}$/.test(value)) throw problem("bad_input", "Choose a Slack channel.");
	return value;
}
export function saveSlackMapping(c: SlackCtx, input: { channelId: string; repositoryId: GithubId }) {
	return serial(c, async () => {
		requireSlack();
		const id = channelId(input?.channelId);
		if (!isGithubId(input.repositoryId)) throw problem("bad_input", "Choose a GitHub repository.");
		const ws = await connectedWorkspace(c);
		const github = c.vars.github, app = githubApp();
		if (!github || !app) throw problem("github_not_connected", "Connect GitHub first.");
		let repository;
		try { repository = (await resolveRepository(app, github, input.repositoryId, "write")).described; }
		catch (error) {
			if (error instanceof GithubProblem) throw problem(error.code, error.message);
			throw problem("github_unreachable", "The repository could not be checked. Try again.");
		}
		if (github !== c.vars.github) throw problem("github_not_connected", "The GitHub connection changed. Try again.");
		await ws.internalSaveMapping(c.key[0]!, id, { id: repository.id, owner: repository.owner, name: repository.name });
		return status(c);
	});
}
export function removeSlackMapping(c: SlackCtx, channel: string) {
	return serial(c, async () => {
		requireSlack();
		await (await connectedWorkspace(c)).internalRemoveMapping(c.key[0]!, channelId(channel));
		return status(c);
	});
}
export function disconnectSlack(c: SlackCtx) {
	return serial(c, async () => {
		await c.db.execute("DELETE FROM slack_state");
		const team = await teamRef(c);
		if (team) {
			const ws = workspace(c, team), uid = c.key[0]!;
			if (await ifPresent(ws.internalView(uid))) await ws.internalDisconnect(uid);
			await c.db.execute("DELETE FROM slack_connection_ref WHERE id=1");
		}
		return status(c);
	});
}
export function linkSlack(c: SlackCtx, ticket: string) {
	return serial(c, async () => {
		requireSlack();
		const team = proofTeam(ticket);
		const invalid = () => problem("slack_proof", "That Slack link is invalid, expired or already claimed.");
		if (!team) throw invalid();
		const ws = workspace(c, team), uid = c.key[0]!;
		await c.db.execute("INSERT OR IGNORE INTO slack_link_ref VALUES (?)", team);
		try { await ws.internalRedeem(uid, ticket); }
		catch {
			// Reconcile a refused proof without deleting an existing or remotely committed link.
			if (!await ifPresent(ws.internalLink(uid))) await c.db.execute("DELETE FROM slack_link_ref WHERE team_id=?", team);
			throw invalid();
		}
		return status(c);
	});
}
export function unlinkSlack(c: SlackCtx, team: string) {
	return serial(c, async () => {
		if (!isSlackTeam(team)) throw problem("bad_input", "Choose a linked Slack workspace.");
		if ((await c.db.execute("SELECT 1 FROM slack_link_ref WHERE team_id=?", team)).length) {
			await ifPresent(workspace(c, team).internalUnlink(c.key[0]!));
			await c.db.execute("DELETE FROM slack_link_ref WHERE team_id=?", team);
		}
		return status(c);
	});
}

interface CallbackClient { user: { get(key: string[], options: { params: unknown }): { internalSlackClaim(nonce: string): Promise<boolean> } } }
let callbackClient: CallbackClient | undefined;
export const actorSlackConnectStore: SlackConnectStore = {
	async claim(uid, nonce) {
		callbackClient ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as CallbackClient;
		return await ifPresent(callbackClient.user.get([uid], { params: serviceParams() }).internalSlackClaim(nonce)) ?? false;
	},
};

// Only export this collection into the actor's public actions; each entry checks its caller.
type ActionCtx = SlackCtx & Parameters<typeof requireUser>[0];
function userAction<A extends unknown[], R>(action: (c: SlackCtx, ...args: A) => Promise<R>) {
	return (c: ActionCtx, ...args: A) => {
		requireUser(c);
		return action(c, ...args);
	};
}
type SettingsHandlers = { [K in keyof SlackSettingsActions]:
	(c: ActionCtx, ...args: Parameters<SlackSettingsActions[K]>) => ReturnType<SlackSettingsActions[K]> };
export const slackSettingsActions = {
	slack: userAction(slackStatus),
	slackConnect: userAction(beginSlackConnect),
	slackComplete: userAction(completeSlackConnection),
	saveSlackMapping: userAction(saveSlackMapping),
	removeSlackMapping: userAction(removeSlackMapping),
	disconnectSlack: userAction(disconnectSlack),
	linkSlack: userAction(linkSlack),
	unlinkSlack: userAction(unlinkSlack),
	internalSlackClaim(c: ActionCtx, nonce: string) {
		requireServiceFor(c, "call");
		return claimSlackState(c, nonce);
	},
} satisfies SettingsHandlers & { internalSlackClaim(c: ActionCtx, nonce: string): Promise<boolean> };
