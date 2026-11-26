/** Loopback-only stand-in for Atlassian 3LO and the subset of Jira Cloud REST v3 used by the checks. */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
class HttpError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}
function check(condition: unknown, message: string, status = 400): asserts condition {
	if (!condition) throw new HttpError(status, message);
}
function only(object: Obj, keys: string[]) {
	check(Object.keys(object).every((key) => keys.includes(key)), "unexpected property");
}
function query(params: URLSearchParams, keys: string[]) {
	for (const key of params.keys()) check(keys.includes(key) && params.getAll(key).length === 1, "unexpected query parameter");
}
async function json(req: IncomingMessage): Promise<Obj> {
	check(req.headers["content-type"]?.split(";")[0].trim().toLowerCase() === "application/json", "expected JSON", 415);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		check(size <= 1024 * 1024, "body too large", 413);
		chunks.push(chunk);
	}
	let value: unknown;
	try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, "invalid JSON"); }
	check(record(value), "expected object");
	return value;
}
function reply(res: ServerResponse, status: number, value?: unknown) {
	res.writeHead(status, value === undefined ? {} : { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}
export const jiraAdf = (text: string) => ({ type: "doc", version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) });
// The check writes plain text as paragraphs and hard breaks; rich issue descriptions can be seeded directly.
function commentDoc(body: unknown): body is Obj {
	return record(body) && body.type === "doc" && body.version === 1 && Array.isArray(body.content) && body.content.length > 0 && body.content.every((p) =>
		record(p) && p.type === "paragraph" && (p.content === undefined || (Array.isArray(p.content) && p.content.every((n) =>
			record(n) && (n.type === "hardBreak" || (n.type === "text" && typeof n.text === "string" && n.text.length > 0))))));
}
const scopes = ["read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"];
const hookEvents = ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted", "issue_property_set", "issue_property_deleted"];
// The fixture accepts the documented dynamic-hook comparisons, not arbitrary issue-search JQL.
const field = String.raw`(?:issueKey|project|issuetype|status|assignee|reporter|cf\[\d+\]|issue\.property\[[\w.-]+\](?:\.[\w.-]+)?)`;
const literal = String.raw`(?:[\w.:-]+|"[^"\\]+"|'[^'\\]+')`;
const comparison = `${field}\\s*(?:(?:!=|=)\\s*${literal}|(?:NOT\\s+)?IN\\s*\\(\\s*${literal}(?:\\s*,\\s*${literal})*\\s*\\))`;
const filter = new RegExp(`^${comparison}(?:\\s+(?:AND|OR)\\s+${comparison})*$`, "i");
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((s) => typeof s === "string" && s.length > 0);
const hookLifetime = 30 * 24 * 60 * 60 * 1000;
export interface JiraStandinOptions {
	redirectUri?: string;
	pageSize?: number;
	grantScopes?: (asked: string[]) => string[];
}
interface Site { id: string; name: string; url: string; scopes: string[] }
interface Project { id: string; key: string; name: string; projectTypeKey: string }
interface Person { accountId: string; displayName: string; accountType: string; active: boolean }
interface Issue {
	id: string; key: string;
	fields: { project: Project; summary: string; description: Obj | null; labels: string[]; creator: Person; reporter: Person; assignee: Person | null; issuetype: { name: string }; status: { name: string; statusCategory: { key: string } } };
}
interface Hook { id: number; siteId: string; url: string; jqlFilter: string; events: string[]; fieldIdsFilter?: string[]; issuePropertyKeysFilter?: string[]; expirationDate: number }
interface Session { scopes: string[]; expires: number }

export class JiraStandin {
	readonly clientId = `jira-client-${randomUUID()}`;
	readonly clientSecret = randomUUID();
	readonly site: Site = { id: randomUUID(), name: "Acme", url: "https://acme.atlassian.net", scopes: scopes.filter((s) => s !== "offline_access") };
	readonly sites: Site[] = [this.site];
	readonly myself = { accountId: `acct-${randomUUID()}`, displayName: "Ada Owner", accountType: "atlassian", active: true };
	readonly calls: string[] = []; // Methods and paths only; never credentials, query strings or hook callback URLs.
	readonly projects: Project[] = [];
	private readonly projectSites = new Map<string, string>();
	readonly issues = new Map<string, Issue>();
	readonly comments = new Map<string, { issueId: string; id: string; body: Obj; author: Person }>();
	readonly hooks = new Map<number, Hook>();
	consent = { approve: true };
	private readonly codes = new Map<string, string[]>();
	private readonly sessions = new Map<string, Session>();
	private readonly refreshes = new Map<string, string[]>();
	private nextId = 10000;
	private readonly server = createServer((req, res) => {
		void this.route(req, res).catch((e: unknown) => reply(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : "fixture failure" }));
	});
	private constructor(private readonly options: JiraStandinOptions) {}
	static async start(options: JiraStandinOptions = {}) {
		check(options.pageSize === undefined || (Number.isSafeInteger(options.pageSize) && options.pageSize > 0), "invalid page size");
		const fixture = new JiraStandin(options);
		await new Promise<void>((resolve, reject) => fixture.server.once("error", reject).listen(0, "127.0.0.1", resolve));
		return fixture;
	}
	get url() { return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; }
	get redirectUri() { return this.options.redirectUri ?? `${this.url}/jira/callback`; }
	async close() {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
	async authorize(url: string) {
		check(new URL(url).origin === this.url, "consent must be local");
		const res = await fetch(url, { redirect: "manual" });
		check(res.status === 302, `consent failed (${res.status})`);
		return res.headers.get("location")!;
	}
	expireTokens() { for (const s of this.sessions.values()) s.expires = 0; }
	addProject(key: string, name = key, site = this.site) {
		const p = { id: String(++this.nextId), key, name, projectTypeKey: "software" };
		this.projects.push(p);
		this.projectSites.set(p.id, site.id);
		return p;
	}
	createIssue(project: Project, summary: string, description: string | Obj | null = "") {
		const id = String(++this.nextId);
		const issue: Issue = { id, key: `${project.key}-${this.issues.size + 1}`, fields: {
			project, summary, description: typeof description === "string" ? jiraAdf(description) : description, labels: [],
			assignee: null, creator: this.myself, reporter: this.myself, issuetype: { name: "Task" }, status: { name: "Open", statusCategory: { key: "new" } },
		} };
		this.issues.set(id, issue);
		return issue;
	}
	private authorizeRequest(q: URLSearchParams, res: ServerResponse) {
		query(q, ["audience", "client_id", "scope", "redirect_uri", "state", "response_type", "prompt"]);
		check(q.get("client_id") === this.clientId && q.get("redirect_uri") === this.redirectUri, "invalid client or redirect");
		check(q.get("audience") === "api.atlassian.com" && q.get("response_type") === "code" && q.get("prompt") === "consent" && q.get("state"), "invalid consent parameters");
		const asked = (q.get("scope") ?? "").split(" ");
		check(asked.every((s) => scopes.includes(s)), "invalid scope");
		const target = new URL(this.redirectUri);
		target.searchParams.set("state", q.get("state")!);
		if (this.consent.approve) {
			const code = randomUUID();
			this.codes.set(code, this.options.grantScopes?.(asked) ?? asked);
			target.searchParams.set("code", code);
		} else target.searchParams.set("error", "access_denied");
		res.writeHead(302, { location: target.href }).end();
	}
	private async token(req: IncomingMessage, res: ServerResponse) {
		const b = await json(req);
		check(b.client_id === this.clientId && b.client_secret === this.clientSecret, "invalid_client", 401);
		let granted: string[] | undefined;
		const keys = ["grant_type", "client_id", "client_secret"];
		if (b.grant_type === "authorization_code") {
			only(b, [...keys, "code", "redirect_uri"]);
			check(b.redirect_uri === this.redirectUri && typeof b.code === "string", "invalid_grant");
			granted = this.codes.get(b.code);
			this.codes.delete(b.code);
		} else {
			only(b, [...keys, "refresh_token"]);
			check(b.grant_type === "refresh_token" && typeof b.refresh_token === "string", "invalid_grant");
			granted = this.refreshes.get(b.refresh_token);
			this.refreshes.delete(b.refresh_token);
		}
		check(granted, "invalid_grant");
		const access = randomUUID();
		const refresh = granted.includes("offline_access") ? randomUUID() : undefined;
		this.sessions.set(access, { scopes: granted, expires: Date.now() + 3600000 });
		if (refresh) this.refreshes.set(refresh, granted);
		reply(res, 200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: granted.join(" ") });
	}
	private page<T>(values: T[], q: URLSearchParams) {
		query(q, ["startAt", "maxResults"]);
		const start = q.get("startAt") ?? "0", max = q.get("maxResults") ?? "50";
		check(/^\d+$/.test(start) && /^\d+$/.test(max) && Number.isSafeInteger(+start) && Number.isSafeInteger(+max) && +max > 0, "invalid page");
		const maxResults = Math.min(+max, this.options.pageSize ?? 100);
		return { startAt: +start, maxResults, total: values.length, isLast: +start + maxResults >= values.length, values: values.slice(+start, +start + maxResults) };
	}
	private async route(req: IncomingMessage, res: ServerResponse) {
		const { pathname, searchParams: q } = new URL(req.url!, this.url);
		const method = req.method;
		this.calls.push(`${method} ${pathname}`);
		if (method === "GET" && pathname === "/authorize") return this.authorizeRequest(q, res);
		if (method === "POST" && pathname === "/oauth/token") {
			query(q, []);
			return this.token(req, res);
		}
		const access = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1];
		const session = access && this.sessions.get(access);
		check(session && session.expires > Date.now(), "invalid_token", 401);
		if (method === "GET" && pathname === "/oauth/token/accessible-resources") {
			query(q, []);
			return reply(res, 200, this.sites.map((s) => ({ ...s, scopes: s.scopes.filter((scope) => session.scopes.includes(scope)) })));
		}
		const match = /^\/ex\/jira\/([^/]+)\/rest\/api\/3(\/.*)$/.exec(pathname);
		const site = this.sites.find((s) => s.id === match?.[1]);
		check(match && site, "unknown resource", 404);
		const path = match[2];
		const scope = (s: string) => check(session.scopes.includes(s) && site.scopes.includes(s), "insufficient_scope", 403);
		if (path === "/myself" && method === "GET") {
			scope("read:jira-user"); query(q, []);
			return reply(res, 200, this.myself);
		}
		if (path === "/project/search" && method === "GET") {
			scope("read:jira-work");
			return reply(res, 200, this.page(this.projects.filter((p) => this.projectSites.get(p.id) === site.id), q));
		}
		const issuePath = /^\/issue\/([^/]+)(?:\/(comment)(?:\/(\d+))?)?$/.exec(path);
		if (issuePath) {
			const [, key, comment, commentId] = issuePath;
			scope(method === "GET" ? "read:jira-work" : "write:jira-work");
			const issue = [...this.issues.values()].find((i) => this.projectSites.get(i.fields.project.id) === site.id && (i.key === key || i.id === key));
			check(issue, "unknown issue", 404);
			if (!comment && method === "GET") {
				query(q, ["fields"]);
				const fields = q.get("fields")?.split(",");
				return reply(res, 200, { ...issue, fields: fields ? Object.fromEntries(Object.entries(issue.fields).filter(([k]) => fields.includes(k))) : issue.fields });
			}
			if (comment && method === "GET" && !commentId) {
				const { values, startAt, maxResults, total } = this.page([...this.comments.values()].filter((c) => c.issueId === issue.id), q);
				return reply(res, 200, { comments: values.map(({ issueId, ...c }) => c), startAt, maxResults, total });
			}
			query(q, []);
			if (commentId && method === "GET") {
				const c = this.comments.get(commentId);
				check(c?.issueId === issue.id, "unknown comment", 404);
				return reply(res, 200, { id: c.id, author: c.author, body: c.body });
			}
			if (comment && !commentId && method === "POST") {
				const b = await json(req);
				only(b, ["body"]); check(commentDoc(b.body), "expected ADF comment");
				const c = { id: String(++this.nextId), body: b.body, author: this.myself };
				this.comments.set(c.id, { ...c, issueId: issue.id });
				return reply(res, 201, c);
			}
		}
		if (path === "/webhook" || path === "/webhook/refresh") {
			scope("manage:jira-webhook");
			return this.webhook(req, res, site, path, q);
		}
		throw new HttpError(404, "unknown endpoint");
	}
	private async webhook(req: IncomingMessage, res: ServerResponse, site: Site, path: string, q: URLSearchParams) {
		for (const h of this.hooks.values()) if (h.expirationDate <= Date.now()) this.hooks.delete(h.id);
		if (path === "/webhook" && req.method === "GET") {
			const hooks = [...this.hooks.values()].filter((h) => h.siteId === site.id).map(({ siteId, ...h }) => h);
			return reply(res, 200, this.page(hooks, q));
		}
		query(q, []);
		const expires = Date.now() + hookLifetime;
		if (path === "/webhook" && req.method === "POST") {
			const b = await json(req);
			only(b, ["url", "webhooks"]);
			check(typeof b.url === "string" && URL.canParse(b.url), "expected callback URL");
			const callback = new URL(b.url);
			check(!callback.username && !callback.password && !callback.hash && (callback.protocol === "https:" || (callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))), "invalid callback URL");
			check(Array.isArray(b.webhooks) && b.webhooks.length > 0, "expected webhooks array");
			const webhookRegistrationResult = b.webhooks.map((h: unknown) => {
				if (!record(h) || Object.keys(h).some((k) => !["jqlFilter", "events", "fieldIdsFilter", "issuePropertyKeysFilter"].includes(k))
					|| typeof h.jqlFilter !== "string" || (h.jqlFilter !== "" && !filter.test(h.jqlFilter.trim()))
					|| !stringArray(h.events) || !h.events.length || !h.events.every((e) => hookEvents.includes(e))
					|| (h.fieldIdsFilter !== undefined && !stringArray(h.fieldIdsFilter))
					|| (h.issuePropertyKeysFilter !== undefined && !stringArray(h.issuePropertyKeysFilter))) {
					return { errors: ["Invalid webhook filter or events"] };
				}
				const id = ++this.nextId;
				this.hooks.set(id, { id, siteId: site.id, url: callback.href, events: h.events, jqlFilter: h.jqlFilter, fieldIdsFilter: h.fieldIdsFilter, issuePropertyKeysFilter: h.issuePropertyKeysFilter, expirationDate: expires });
				return { createdWebhookId: id };
			});
			return reply(res, 200, { webhookRegistrationResult });
		}
		if ((path === "/webhook/refresh" && req.method === "PUT") || (path === "/webhook" && req.method === "DELETE")) {
			const b = await json(req);
			only(b, ["webhookIds"]);
			check(Array.isArray(b.webhookIds) && b.webhookIds.length && b.webhookIds.every((id) => Number.isSafeInteger(id) && id > 0), "expected webhook IDs");
			for (const id of b.webhookIds) {
				const h = this.hooks.get(id);
				check(h?.siteId === site.id, "unknown webhook", 404);
			}
			for (const id of b.webhookIds) {
				if (req.method === "PUT") this.hooks.get(id)!.expirationDate = expires;
				else this.hooks.delete(id);
			}
			return req.method === "PUT" ? reply(res, 200, { expirationDate: new Date(expires).toISOString() }) : reply(res, 202);
		}
		throw new HttpError(405, "unsupported webhook method");
	}
}
