/** Owner-side Jira grant, project mappings and delivery receipts. Only public connection metadata leaves the actor. */
import { createHash, randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import { createClient } from "rivetkit/client";
import type { RawAccess } from "rivetkit/db";
import { serviceParams } from "../auth.js";
import { config, ownEngineEndpoint } from "../config.js";
import type { GithubId, ItemSummary, JiraConnection, JiraMapping, JiraProjectList, JiraStatus } from "../contract.js";
import type { JiraFiled } from "../factory/intake.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository, type StoredConnection } from "../github/repos.js";
import { jiraApp, JiraError, JIRA_SCOPES, type JiraApp, type JiraSite, type JiraToken } from "../jira/app.js";
import { jiraCallbackResponse, type JiraClaim } from "../jira/connect.js";
import { isTriggerLabel, newJiraWebhookKey, JIRA_WEBHOOK_PATH, type JiraDelivery, type JiraDispatch } from "../jira/webhook.js";
import { readSignedPayload, signedPayload } from "../signatures.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import { isActorGone, type JiraItemWrite } from "./internal.js";
import type { SiteJiraFiling } from "./issue-intake.js";
import { jiraCallbackHash, type JiraGeneration } from "./jira-site.js";

export const JIRA_TABLES = [
	`CREATE TABLE IF NOT EXISTS jira_state (nonce TEXT PRIMARY KEY, origin TEXT NOT NULL, expires INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, ticket TEXT UNIQUE, sealed TEXT)`,
	`CREATE TABLE IF NOT EXISTS jira_connection (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL, sealed TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS jira_mapping (project TEXT PRIMARY KEY, mapping TEXT NOT NULL, hook INTEGER NOT NULL, callback_hash TEXT NOT NULL, expires INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS jira_delivery (site TEXT NOT NULL, id TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY(site,id))`,
];

export interface JiraCtx {
	key: string[];
	db: RawAccess;
	vars: { github: StoredConnection | null };
	client(): any;
	schedule: { at(at: number, action: "internalJiraRenew"): Promise<string> };
	log: { warn(entry: unknown): void };
}
const DAY = 86_400_000;
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const problem = (message: string, code: string) => new UserError(message, { code });
const invalid = () => problem("This Jira connection link is no longer valid. Connect again.", "jira_ticket");
const requireApp = () => { const app = jiraApp(); if (!app) throw problem("This deployment has no Jira app.", "jira_off"); return app; };
const queues = new WeakMap<object, Promise<unknown>>();
/** Rotation, site changes, registration and writes all use the same queue. */
function serial<T>(c: JiraCtx, job: () => Promise<T>): Promise<T> {
	const result = (queues.get(c.vars) ?? Promise.resolve()).then(job);
	queues.set(c.vars, result.catch(() => {}));
	return result;
}
const seal = (uid: string, purpose: string, value: unknown) => sealSecret(serverSealer(), uid, "jira", purpose, JSON.stringify(value));
const open = <T>(uid: string, purpose: string, blob: string): T => JSON.parse(openSecret(serverSealer(), uid, "jira", purpose, blob));

export async function beginJiraConnect(c: JiraCtx, input: { origin: string }): Promise<{ url: string }> {
	const app = requireApp();
	if (!config.origins.includes(input?.origin)) throw problem("Connect Jira from the web app.", "origin_not_allowed");
	const nonce = random(), origin = input.origin, exp = Date.now() + 600_000;
	await c.db.transaction(async tx => {
		await tx.execute("DELETE FROM jira_state WHERE expires<=?", Date.now());
		await tx.execute("DELETE FROM jira_state WHERE nonce NOT IN (SELECT nonce FROM jira_state ORDER BY expires DESC LIMIT 19)");
		await tx.execute("INSERT INTO jira_state(nonce,origin,expires) VALUES(?,?,?)", nonce, origin, exp);
	});
	return { url: app.authorizeUrl(signedPayload("ji1", "github-state", { k: "jira-state", uid: c.key[0], nonce, origin, exp })) };
}
export function readJiraState(state: string) {
	const p = readSignedPayload(state, "ji1", 8192, k => k === "jira-state" ? "github-state" : null);
	if (!p || typeof p.uid !== "string" || typeof p.origin !== "string" || typeof p.nonce !== "string" || typeof p.exp !== "number" || p.exp <= Date.now()) return null;
	return { uid: p.uid, nonce: p.nonce, origin: p.origin, exp: p.exp };
}
export async function claimJiraState(c: JiraCtx, nonce: string): Promise<JiraClaim | null> {
	const [row] = await c.db.execute<{ origin: string }>("UPDATE jira_state SET claimed=1 WHERE nonce=? AND claimed=0 AND expires>? RETURNING origin", nonce, Date.now());
	return row ? { uid: c.key[0]!, nonce, origin: row.origin } : null;
}
interface Grant { token: JiraToken; sites: JiraSite[]; ticketHash: string }
export async function completeJiraConnection(c: JiraCtx, nonce: string, sealed: string): Promise<void> {
	const grant = open<Grant>(c.key[0]!, `pending:${nonce}`, sealed);
	const rows = await c.db.execute("UPDATE jira_state SET sealed=?,ticket=?,expires=? WHERE nonce=? AND claimed=1 AND ticket IS NULL AND expires>? RETURNING nonce", sealed, grant.ticketHash, Date.now() + 300_000, nonce, Date.now());
	if (!rows.length) throw invalid();
}
interface CallbackUser {
	internalJiraClaim(nonce: string): Promise<JiraClaim | null>;
	internalJiraComplete(nonce: string, sealed: string): Promise<void>;
}
interface CallbackDeps {
	claim?(state: string): Promise<JiraClaim | null>;
	complete?(claim: JiraClaim, sealed: string): Promise<void>;
	app?: JiraApp | null;
	origins?: string[];
}
let engine: { user: { get(key: string[], options: { params: unknown }): CallbackUser } } | undefined;
function callbackUser(uid: string) {
	engine ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as NonNullable<typeof engine>;
	return engine.user.get([uid], { params: serviceParams() });
}
/** The callback stages ciphertext but cannot install it. Only the signed-in browser holding the returned fragment can. */
export async function jiraOwnerCallbackResponse(request: Request, deps: CallbackDeps = {}) {
	let location: string | undefined;
	const result = await jiraCallbackResponse(request, { app: deps.app, origins: deps.origins, store: {
		async claim(state) {
			const p = readJiraState(state);
			if (!p || !(deps.origins ?? config.origins).includes(p.origin)) return null;
			try {
				const claim = await (deps.claim ? deps.claim(state) : callbackUser(p.uid).internalJiraClaim(p.nonce));
				return claim?.origin === p.origin && claim.uid === p.uid && claim.nonce === p.nonce ? claim : null;
			} catch (error) { if (isActorGone(error)) return null; throw error; }
		},
		async complete(claim, token, sites) {
			const ticket = random();
			const sealed = seal(claim.uid, `pending:${claim.nonce}`, { token, sites, ticketHash: hash(ticket) });
			if (deps.complete) await deps.complete(claim, sealed);
			else await callbackUser(claim.uid).internalJiraComplete(claim.nonce, sealed);
			location = `${claim.origin}/settings#jira=${ticket}`;
		},
	} });
	if (location && result.status === 302) result.headers.set("location", location);
	return result;
}

async function stored(c: JiraCtx) {
	const [row] = await c.db.execute<{ metadata: string; sealed: string }>("SELECT metadata,sealed FROM jira_connection WHERE id=1");
	return row ? { meta: JSON.parse(row.metadata) as JiraConnection, sealed: row.sealed } : null;
}
export async function jiraStatus(c: JiraCtx): Promise<JiraStatus> {
	if (!jiraApp()) return { state: "off" };
	const saved = await stored(c);
	return saved ? { state: "connected", connection: saved.meta } : { state: "disconnected" };
}
const tokenPurpose = (meta: JiraConnection) => `token:${meta.site?.id ?? "pending"}`;
async function access(c: JiraCtx) {
	const app = requireApp(), saved = await stored(c);
	if (!saved) throw problem("Connect Jira first.", "jira_not_connected");
	const purpose = tokenPurpose(saved.meta), uid = c.key[0]!;
	let token = open<JiraToken>(uid, purpose, saved.sealed);
	if (token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000) {
		if (!token.refreshToken) throw new JiraError(401, "refresh the Jira connection");
		const renewed = await app.refresh(token.refreshToken);
		token = { ...renewed, refreshToken: renewed.refreshToken ?? token.refreshToken };
		await c.db.execute("UPDATE jira_connection SET sealed=? WHERE id=1", seal(uid, purpose, token));
	}
	return { app, meta: saved.meta, token };
}
function authorized(sites: JiraSite[]) {
	return sites.filter(site => {
		const url = URL.parse(site.url);
		return /^[a-z0-9][a-z0-9-]{0,127}$/.test(site.id) && url?.protocol === "https:" && !url.username && !url.password && JIRA_SCOPES.every(s => s === "offline_access" || site.scopes.includes(s));
	}).map(({ id, name, url }) => ({ id, name, url: new URL(url).origin }));
}
export function finishJiraConnect(c: JiraCtx, ticket: string, origin?: string | null): Promise<JiraStatus> {
	return serial(c, async () => {
		const app = requireApp();
		if (typeof ticket !== "string" || !/^[\w-]{43}$/.test(ticket)) throw invalid();
		const [row] = await c.db.execute<{ sealed: string; nonce: string; origin: string }>("SELECT sealed,nonce,origin FROM jira_state WHERE ticket=? AND expires>?", hash(ticket), Date.now());
		if (!row || !config.origins.includes(row.origin) || (origin != null && origin !== row.origin)) throw invalid();
		const grant = open<Grant>(c.key[0]!, `pending:${row.nonce}`, row.sealed), sites = authorized(grant.sites);
		if (!sites.length) throw invalid();
		const identity = await app.identity(grant.token.accessToken, sites[0]!.id);
		const meta: JiraConnection = { user: { id: identity.accountId, name: identity.displayName }, sites, site: null, connectedAt: Date.now() };
		const sealed = seal(c.key[0]!, tokenPurpose(meta), grant.token);
		// Consume the live ticket before retiring any of the previous connection's mappings.
		if (!(await c.db.execute("DELETE FROM jira_state WHERE nonce=? AND expires>? RETURNING nonce", row.nonce, Date.now())).length) throw invalid();
		await clearMappings(c);
		await c.db.execute("INSERT OR REPLACE INTO jira_connection VALUES(1,?,?)", JSON.stringify(meta), sealed);
		return { state: "connected", connection: meta };
	});
}
export function selectJiraSite(c: JiraCtx, siteId: string): Promise<JiraStatus> {
	return serial(c, async () => {
		const { app, token, meta } = await access(c);
		const sites = authorized(await app.sites(token.accessToken)), site = sites.find(s => s.id === siteId);
		if (!site || !meta.sites.some(s => s.id === siteId)) throw problem("Choose an authorized Jira site.", "jira_site");
		const identity = await app.identity(token.accessToken, siteId);
		if (meta.site?.id !== siteId || meta.user.id !== identity.accountId) await clearMappings(c);
		const next = { ...meta, user: { id: identity.accountId, name: identity.displayName }, site, sites };
		await c.db.execute("UPDATE jira_connection SET metadata=?,sealed=? WHERE id=1", JSON.stringify(next), seal(c.key[0]!, tokenPurpose(next), token));
		return { state: "connected", connection: next };
	});
}

type Registration = { project: string; mapping: string; hook: number; callback_hash: string; expires: number }
const registrations = (c: JiraCtx) => c.db.execute<Registration>("SELECT * FROM jira_mapping ORDER BY project");
const siteDirectory = (c: JiraCtx, siteId: string) => c.client().jiraSite.getOrCreate([siteId], { params: serviceParams() });
const callbackDirectory = (c: JiraCtx, digest: string) => c.client().jiraCallback.getOrCreate([digest], { params: serviceParams() });
const pending = new WeakMap<object, string>();
/** Called by the directory without taking our queue (which may already be waiting for a claim). */
export async function jiraHoldsProject(c: JiraCtx, siteId: string, projectId: string) {
	if (pending.get(c.vars) === JSON.stringify([siteId, projectId])) return true;
	const saved = await stored(c);
	return saved?.meta.site?.id === siteId && (await c.db.execute("SELECT 1 FROM jira_mapping WHERE project=?", projectId)).length > 0;
}
async function removeRegistration(c: JiraCtx, siteId: string, row: Registration) {
	await callbackDirectory(c, row.callback_hash).internalUnbind({ uid: c.key[0] });
	await siteDirectory(c, siteId).internalRelease({ uid: c.key[0], projectId: row.project });
	await c.db.execute("DELETE FROM jira_mapping WHERE project=?", row.project);
	// Local routing is disabled even if the user already revoked their grant at Atlassian.
	try {
		const { token, app } = await access(c);
		await app.deleteWebhooks(token.accessToken, siteId, [row.hook]);
	} catch { c.log.warn({ msg: "Could not retire a Jira webhook at Atlassian" }); }
}
async function clearMappings(c: JiraCtx) {
	const site = (await stored(c))?.meta.site;
	if (site) for (const row of await registrations(c)) await removeRegistration(c, site.id, row);
}
export function disconnectJira(c: JiraCtx): Promise<JiraStatus> {
	return serial(c, async () => {
		await clearMappings(c);
		await c.db.transaction(async tx => {
			await tx.execute("DELETE FROM jira_connection");
			await tx.execute("DELETE FROM jira_state");
			await tx.execute("DELETE FROM jira_delivery");
		});
		return jiraStatus(c);
	});
}
async function projectList(c: JiraCtx, expectedSite?: string) {
	const { app, meta, token } = await access(c), site = meta.site;
	if (!site || (expectedSite !== undefined && expectedSite !== site.id)) throw problem("Choose the connected Jira site first.", "jira_site");
	const projects = await app.projects(token.accessToken, site.id), present = new Set(projects.map(p => p.id));
	const mappings = new Map<string, JiraMapping>();
	for (const row of await registrations(c)) {
		if (!present.has(row.project)) await removeRegistration(c, site.id, row);
		else mappings.set(row.project, JSON.parse(row.mapping));
	}
	return { list: { projects: projects.map(p => ({ ...p, mapping: mappings.get(p.id) ?? null })) }, site, app, token };
}
export function jiraProjects(c: JiraCtx): Promise<JiraProjectList> { return serial(c, async () => (await projectList(c)).list); }

const RENEW_AHEAD = 3 * DAY;
async function register(c: JiraCtx, app: JiraApp, token: string, site: NonNullable<JiraConnection["site"]>, project: string) {
	const raw = newJiraWebhookKey(), digest = jiraCallbackHash(raw);
	const url = new URL(`${JIRA_WEBHOOK_PATH}/${raw}`, app.settings.redirectUrl).href;
	const id = await app.registerWebhook(token, site.id, url, `project = ${project}`);
	try {
		// Register returns only an id. Obtain the real expiry; never rely on a guessed TTL.
		const expires = await app.refreshWebhooks(token, site.id, [id]);
		await c.schedule.at(Math.max(Date.now() + 60_000, expires - RENEW_AHEAD), "internalJiraRenew");
		await callbackDirectory(c, digest).internalBind({ uid: c.key[0], cloudId: site.id, siteUrl: site.url, webhookIds: [id] });
		return { id, digest, expires };
	} catch (error) {
		await app.deleteWebhooks(token, site.id, [id]).catch(() => {});
		throw error;
	}
}
export function saveJiraMapping(c: JiraCtx, input: { siteId: string; projectId: string; repositoryId: GithubId }): Promise<JiraProjectList> {
	return serial(c, async () => {
		if (!input || typeof input.siteId !== "string" || typeof input.projectId !== "string" || !/^[1-9]\d{0,31}$/.test(input.projectId) || !isGithubId(input.repositoryId)) throw problem("Choose a listed project and repository.", "bad_input");
		const { site, token, app, list } = await projectList(c, input.siteId);
		const project = list.projects.find(p => p.id === input.projectId);
		if (!project) throw problem("Choose a project in the connected site.", "jira_project");
		const github = githubApp(), connection = c.vars.github;
		if (!github || !connection) throw problem("Connect GitHub first.", "github_not_connected");
		const { described: repo } = await resolveRepository(github, connection, input.repositoryId, "write").catch((error: unknown) => {
			if (error instanceof GithubProblem && (error.code === "github_gone" || error.code === "github_denied")) {
				throw problem("Choose a repository your GitHub connection can write to.", "bad_input");
			}
			throw problem("The repository could not be checked at GitHub. Try again.", "github_unreachable");
		});
		const mapping: JiraMapping = { projectId: project.id, siteId: site.id, repository: { id: repo.id, owner: repo.owner, name: repo.name }, savedAt: Date.now() };
		const directory = siteDirectory(c, site.id), claim = { uid: c.key[0], projectId: project.id };
		pending.set(c.vars, JSON.stringify([site.id, project.id]));
		try {
			if (!await directory.internalClaim(claim)) throw problem("Another Windlass user has mapped this Jira project.", "jira_project_taken");
			if (project.mapping) await c.db.execute("UPDATE jira_mapping SET mapping=? WHERE project=?", JSON.stringify(mapping), project.id);
			else {
				try {
					const hook = await register(c, app, token.accessToken, site, project.id);
					await c.db.execute("INSERT INTO jira_mapping VALUES(?,?,?,?,?)", project.id, JSON.stringify(mapping), hook.id, hook.digest, hook.expires);
				} catch (error) { await directory.internalRelease(claim); throw error; }
			}
		} finally { pending.delete(c.vars); }
		project.mapping = mapping;
		return list;
	});
}
export function removeJiraMapping(c: JiraCtx, input: { siteId: string; projectId: string }): Promise<JiraProjectList> {
	return serial(c, async () => {
		if (!input || (await stored(c))?.meta.site?.id !== input.siteId) throw problem("Choose the connected site.", "jira_site");
		const row = (await registrations(c)).find(r => r.project === input.projectId);
		if (row) await removeRegistration(c, input.siteId, row);
		return (await projectList(c, input.siteId)).list;
	});
}
/** Multiple mappings may schedule the same tick. Only renew due rows; each such row gets its next alarm. */
export function renewJiraWebhooks(c: JiraCtx): Promise<void> {
	return serial(c, async () => {
		const rows = (await registrations(c)).filter(row => row.expires - RENEW_AHEAD <= Date.now());
		if (!rows.length) return;
		try {
			const { app, token, meta } = await access(c);
			if (!meta.site) return;
			for (const row of rows) {
				let expires: number;
				try { expires = await app.refreshWebhooks(token.accessToken, meta.site.id, [row.hook]); }
				catch (error) {
					if (!(error instanceof JiraError) || (error.status !== 404 && error.status !== 400)) throw error;
					if (error.status === 400 && (await app.webhooks(token.accessToken, meta.site.id)).some(hook => hook.id === row.hook)) throw error;
					const hook = await register(c, app, token.accessToken, meta.site, row.project);
					await c.db.execute("UPDATE jira_mapping SET hook=?,callback_hash=?,expires=? WHERE project=?", hook.id, hook.digest, hook.expires, row.project);
					await callbackDirectory(c, row.callback_hash).internalUnbind({ uid: c.key[0] });
					continue;
				}
				await c.schedule.at(Math.max(Date.now() + 60_000, expires - RENEW_AHEAD), "internalJiraRenew");
				await c.db.execute("UPDATE jira_mapping SET expires=? WHERE project=?", expires, row.project);
			}
		} catch (error) {
			await c.schedule.at(Math.max(Date.now() + 3_600_000, error instanceof JiraError ? error.retryAt : 0), "internalJiraRenew");
			c.log.warn({ msg: "Jira webhook renewal deferred" });
		}
	});
}

// Keep the mapping stable through intake. Work-item creation only enqueues its comment: the
// onWake outbox is detached, so the owner does not wait on a Jira write while holding this queue.
export function fileJiraDelivery(c: JiraCtx, d: JiraDelivery, file: (filing: SiteJiraFiling) => Promise<JiraFiled>): Promise<JiraDispatch> {
	return serial(c, async () => {
		const meta = (await stored(c))?.meta, site = meta?.site;
		if (!meta || !site || site.id !== d.cloudId || !jiraApp()) return "ignored";
		const [row] = await c.db.execute<Registration>("SELECT * FROM jira_mapping WHERE project=? AND expires>?", d.projectId, Date.now());
		if (!row || !d.matchedWebhookIds.includes(row.hook)) return "ignored";
		const assignment = d.assignedTo === meta.user.id;
		if (!assignment && !d.label) return "ignored";
		await c.db.execute("DELETE FROM jira_delivery WHERE received<=?", Date.now() - 7 * DAY);
		if ((await c.db.execute("SELECT 1 FROM jira_delivery WHERE site=? AND id=?", site.id, d.deliveryId)).length) return "duplicate";
		const { app, token } = await access(c);
		const issue = await app.issue(token.accessToken, site.id, d.issueId);
		let result: JiraDispatch = "ignored";
		if (issue && issue.id === d.issueId && issue.projectId === d.projectId && issue.statusCategory !== "done") {
			const byAssignment = assignment && issue.assignee?.accountId === meta.user.id;
			const byLabel = d.label && issue.labels.some(isTriggerLabel);
			const author = issue.creator ?? issue.reporter;
			const sender = [author, issue.assignee, issue.reporter].find(p => p && p.accountId === d.actorId);
			const mapping: JiraMapping = JSON.parse(row.mapping);
			const ref = { uid: c.key[0]!, projectId: d.projectId, issue: d.issueId, delivery: d.deliveryId };
			const directory = siteDirectory(c, site.id);
			const plan: JiraGeneration = await directory.internalGeneration(ref, d.sentAt);
			const decision = plan.kind === "exists" ? plan : await file({ reservation: { ref, plan }, project: { id: issue.projectId, siteId: site.id }, repository: { id: mapping.repository.id },
				issue: { id: issue.id, identifier: issue.key, url: `${site.url}/browse/${encodeURIComponent(issue.key)}`, title: issue.summary, description: issue.description,
					issueType: issue.issueType, labels: issue.labels, creator: author && { id: author.accountId, name: author.displayName } },
				trigger: { via: byAssignment ? "assignment" : byLabel || d.label ? "label" : "assignment", at: d.sentAt,
					sender: { id: d.actorId ?? "unknown", name: sender?.displayName ?? (d.actorId === meta.user.id ? meta.user.name : "a Jira user") }, ...(!byAssignment && !byLabel && { lapsed: true }) } });
			if (plan.kind === "file" && (decision.kind === "filed" || decision.kind === "exists"))
				await directory.internalFinishIssue(ref, plan.generation, decision.itemId);
			if (decision.kind === "refused" && decision.dailyCap) throw new Error("jira_daily_cap");
			result = decision.kind === "ignored" ? "ignored" : "taken";
		}
		await c.db.execute("INSERT INTO jira_delivery VALUES(?,?,?)", site.id, d.deliveryId, Date.now());
		return result;
	});
}

const retry = new WeakMap<object, number>();
export function writeJiraItem(c: JiraCtx, write: JiraItemWrite): Promise<boolean> {
	return serial(c, async () => {
		if ((retry.get(c.vars) ?? 0) > Date.now()) throw new Error("jira_rate_limited");
		try {
			if ((await stored(c))?.meta.site?.id !== write.siteId) return false;
			const [row] = await c.db.execute<{ mapping: string }>("SELECT mapping FROM jira_mapping WHERE project=?", write.projectId);
			if (!row) return false;
			const [indexed] = await c.db.execute<{ summary: string; key: string }>("SELECT summary,key FROM items WHERE id=?", write.itemId);
			// The outbox may wake before the owner has committed the item index. Retry, rather than dropping its first comment.
			if (!indexed) throw new Error("item_not_indexed");
			const item: ItemSummary = JSON.parse(indexed.summary), mapping: JiraMapping = JSON.parse(row.mapping);
			if (item.source !== "jira" || item.origin?.jira?.id !== write.issueId || item.repository.id !== mapping.repository.id || !indexed.key?.startsWith(`jira:${write.siteId}:${write.issueId}:`)) return false;
			const { app, token, meta } = await access(c), accessToken = token.accessToken;
			const issue = await app.issue(accessToken, write.siteId, write.issueId);
			if (!issue || issue.id !== write.issueId || issue.projectId !== write.projectId) return false;
			// A POST may succeed with its reply lost. Match our marker only on the consenting account's own comments.
			const { action, itemId } = write, marker = `[windlass:${itemId}:${action.key}]`;
			const comments = await app.comments(accessToken, write.siteId, issue.id);
			if (comments.some(comment => comment.author?.accountId === meta.user.id && comment.body.split("\n").includes(marker))) return true;
			const wording = { filed: "Filed as a Windlass draft.", opened: "Windlass opened a pull request.", done: "The Windlass work item is done.", failed: "The Windlass work item failed.", cancelled: "The Windlass work item was cancelled." };
			const pr = "pr" in action && action.pr;
			await app.comment(accessToken, write.siteId, issue.id, `${wording[action.key]}\n${marker}`,
				{ text: "Work item", href: action.itemUrl }, ...(pr ? [{ text: "Pull request", href: pr }] : []));
			return true;
		} catch (error) {
			if (error instanceof JiraError && error.rateLimited) { retry.set(c.vars, Math.max(Date.now() + 15_000, error.retryAt)); throw new Error("jira_rate_limited"); }
			if (error instanceof UserError || (error instanceof JiraError && !error.unreachable && !error.rateLimited)) return false;
			throw new Error("jira_write_failed");
		}
	});
}
