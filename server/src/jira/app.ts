import { jiraClientSecret, jiraConfig } from "../config.js";

/** Atlassian 3LO tokens are delegated user credentials. Issue text is third-party input. */
export interface JiraAppSettings {
	clientId: string;
	authUrl: string;
	apiUrl: string;
	redirectUrl: string;
}

export const JIRA_SCOPES = ["read:jira-user", "read:jira-work", "write:jira-work", "manage:jira-webhook", "offline_access"] as const;
export const JIRA_EVENTS = ["jira:issue_created", "jira:issue_updated"] as const;
export interface JiraToken { accessToken: string; refreshToken: string | null; expiresAt: number | null; scopes: string[] }
export interface JiraSite { id: string; name: string; url: string; scopes: string[] }
export interface JiraIdentity { accountId: string; displayName: string }
export interface JiraProject { id: string; key: string; name: string }
export interface JiraIssue {
	id: string;
	key: string;
	projectId: string;
	summary: string;
	description: string;
	labels: string[];
	creator: JiraIdentity | null;
	reporter: JiraIdentity | null;
	assignee: JiraIdentity | null;
	issueType: string;
	statusCategory: string;
}
export interface JiraWebhook { id: number; expirationDate: number | null; jqlFilter: string; events: string[] }

export class JiraError extends Error {
	constructor(readonly status: number, what: string, readonly retryAt = 0, readonly code = "") {
		super(`Could not ${what}: ${status === 0 ? "Jira could not be reached" : `Jira answered ${status}`}`);
		this.name = "JiraError";
	}
	get unauthorized(): boolean { return this.status === 401 || this.code === "invalid_grant"; }
	get rateLimited(): boolean { return this.status === 429; }
	get unreachable(): boolean { return this.status === 0 || this.status >= 500; }
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function expiration(value: unknown): number | null {
	const parsed = typeof value === "string" ? Date.parse(value) : value;
	return positive(parsed) ? parsed : null;
}
const malformed = (what: string) => new JiraError(502, `read ${what} from Jira's answer`);

function segment(value: string): string {
	if (!value || value === "." || value === "..") throw new Error("Expected a Jira resource id");
	return encodeURIComponent(value);
}

function person(value: unknown): JiraIdentity | null {
	const row = record(value);
	return text(row.accountId) ? { accountId: text(row.accountId), displayName: text(row.displayName) } : null;
}

/** Read visible text from ADF, without following media or embedded links. */
export function adfText(value: unknown): string {
	const parts: string[] = [];
	function visit(node: unknown, depth: number): void {
		if (depth > 64) return;
		const { type, text: contentText, content, attrs } = record(node);
		if (type === "text") parts.push(text(contentText));
		else if (type === "hardBreak") parts.push("\n");
		else if (type === "mention") parts.push(text(record(attrs).text));
		else if (Array.isArray(content)) {
			for (const child of content) visit(child, depth + 1);
			if (type === "paragraph" || type === "heading" || type === "codeBlock") parts.push("\n");
		}
	}
	visit(value, 0);
	return parts.join("").trimEnd();
}

export interface JiraCommentLink { text: string; href: string }

export function textAdf(value: string, link?: JiraCommentLink) {
	const content = value.split(/\r?\n/).map(line => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
	if (!link) return { type: "doc", version: 1, content };
	const url = URL.parse(link.href);
	if (!link.text.trim() || !url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Jira comment link");
	const linked = { type: "text", text: link.text, marks: [{ type: "link", attrs: { href: url.href } }] };
	return { type: "doc", version: 1, content: [...content, { type: "paragraph", content: [linked] }] };
}

async function answer(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 1024 * 1024) {
			void reader.cancel().catch(() => undefined);
			throw malformed("a bounded response");
		}
		chunks.push(value);
	}
	if (!size) return null;
	try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
	catch { throw malformed("JSON"); }
}

export class JiraApp {
	constructor(readonly settings: JiraAppSettings, private readonly secrets: { clientSecret: () => string | null } = { clientSecret: jiraClientSecret }) {}

	authorizeUrl(state: string): string {
		const query = new URLSearchParams({ audience: "api.atlassian.com", client_id: this.settings.clientId, redirect_uri: this.settings.redirectUrl,
			response_type: "code", prompt: "consent", scope: JIRA_SCOPES.join(" "), state });
		return `${this.settings.authUrl}/authorize?${query}`;
	}

	private async send(url: string, what: string, method = "GET", token?: string, body?: unknown): Promise<unknown> {
		try {
			const response = await fetch(url, { method, headers: { accept: "application/json", "user-agent": "windlass-platform",
				...(token !== undefined && { authorization: `Bearer ${token}` }), ...(body !== undefined && { "content-type": "application/json" }) },
				body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20_000) });
			if (!response.ok) {
				const after = response.headers.get("retry-after") || "";
				const at = /^\d+$/.test(after) ? Date.now() + Number(after) * 1000 : Date.parse(after);
				// Never propagate upstream text, which may echo credentials or callback URLs.
				const row = record(await answer(response).catch(() => null));
				throw new JiraError(response.status, what, Number.isFinite(at) ? at : 0, row.error === "invalid_grant" ? "invalid_grant" : "");
			}
			return await answer(response);
		} catch (error) {
			if (error instanceof JiraError) throw error;
			throw new JiraError(0, what);
		}
	}

	private async token(form: Record<string, string>): Promise<JiraToken> {
		const secret = this.secrets.clientSecret();
		if (!secret) throw new Error("WLP_JIRA_CLIENT_SECRET is not set");
		const row = record(await this.send(`${this.settings.authUrl}/oauth/token`, "obtain an access token", "POST", undefined,
			{ ...form, client_id: this.settings.clientId, client_secret: secret }));
		if (!text(row.access_token)) throw malformed("an access token");
		return { accessToken: text(row.access_token), refreshToken: text(row.refresh_token) || null,
			expiresAt: positive(row.expires_in) ? Date.now() + row.expires_in * 1000 : null, scopes: text(row.scope).split(/\s+/).filter(Boolean) };
	}

	exchangeCode(code: string): Promise<JiraToken> { return this.token({ grant_type: "authorization_code", code, redirect_uri: this.settings.redirectUrl }); }
	refresh(refreshToken: string): Promise<JiraToken> { return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }); }

	async sites(token: string): Promise<JiraSite[]> {
		const rows = await this.send(`${this.settings.apiUrl}/oauth/token/accessible-resources`, "list accessible sites", "GET", token);
		if (!Array.isArray(rows)) throw malformed("accessible sites");
		return rows.map(record).filter(row => text(row.id) && text(row.url)).map(row => ({ id: text(row.id), name: text(row.name), url: text(row.url), scopes: strings(row.scopes) }));
	}

	private rest(token: string, cloudId: string, path: string, what: string, method = "GET", body?: unknown) {
		return this.send(`${this.settings.apiUrl}/ex/jira/${segment(cloudId)}/rest/api/3/${path}`, what, method, token, body);
	}

	async identity(token: string, cloudId: string): Promise<JiraIdentity> {
		const identity = person(await this.rest(token, cloudId, "myself", "read the current user"));
		if (!identity) throw malformed("an account id");
		return identity;
	}

	/** Compute offsets locally; never forward the bearer token to a server-provided nextPage URL. */
	private async pages(token: string, cloudId: string, path: string, what: string, field = "values"): Promise<Record<string, unknown>[]> {
		const result: Record<string, unknown>[] = [];
		for (let page = 0; page < 100; page++) {
			const start = result.length;
			const row = record(await this.rest(token, cloudId, `${path}?startAt=${start}&maxResults=100`, what));
			const values = row[field];
			if (!Array.isArray(values) || (row.startAt !== undefined && row.startAt !== start)) throw malformed("a page");
			for (const entry of values) result.push(record(entry));
			if (row.isLast === true || (typeof row.total === "number" && result.length >= row.total)) return result;
			if (row.isLast !== false && !row.nextPage && row.total === undefined && values.length < (positive(row.maxResults) ? row.maxResults : 100)) return result;
			if (!values.length) throw malformed("the next page");
		}
		throw malformed("all pages within the pagination limit");
	}

	async projects(token: string, cloudId: string): Promise<JiraProject[]> {
		const rows = await this.pages(token, cloudId, "project/search", "list projects");
		return rows.filter(row => text(row.id) && text(row.key)).map(row => ({ id: text(row.id), key: text(row.key), name: text(row.name) }));
	}

	async issue(token: string, cloudId: string, id: string): Promise<JiraIssue | null> {
		const fields = "project,summary,description,labels,creator,reporter,assignee,issuetype,status";
		let row: Record<string, unknown>;
		try { row = record(await this.rest(token, cloudId, `issue/${segment(id)}?fields=${fields}`, "read the issue")); }
		catch (error) { if (error instanceof JiraError && error.status === 404) return null; throw error; }
		const f = record(row.fields), projectId = text(record(f.project).id);
		if (!text(row.id) || !text(row.key) || !projectId) throw malformed("an issue");
		return { id: text(row.id), key: text(row.key), projectId, summary: text(f.summary), description: adfText(f.description), labels: strings(f.labels),
			creator: person(f.creator), reporter: person(f.reporter), assignee: person(f.assignee),
			issueType: text(record(f.issuetype).name), statusCategory: text(record(record(f.status).statusCategory).key) };
	}

	async comments(token: string, cloudId: string, issueId: string) {
		const rows = await this.pages(token, cloudId, `issue/${segment(issueId)}/comment`, "list comments", "comments");
		return rows.map(row => ({ id: text(row.id), body: adfText(row.body), author: person(row.author) }));
	}

	async comment(token: string, cloudId: string, issueId: string, message: string, link?: JiraCommentLink): Promise<string> {
		const row = record(await this.rest(token, cloudId, `issue/${segment(issueId)}/comment`, "post a comment", "POST", { body: textAdf(message, link) }));
		if (!text(row.id)) throw malformed("the comment id");
		return text(row.id);
	}

	async webhooks(token: string, cloudId: string): Promise<JiraWebhook[]> {
		const rows = await this.pages(token, cloudId, "webhook", "list dynamic webhooks");
		return rows.map(row => {
			if (!positive(row.id)) throw malformed("a webhook id");
			return { id: row.id, expirationDate: expiration(row.expirationDate), jqlFilter: text(row.jqlFilter), events: strings(row.events) };
		});
	}

	async registerWebhook(token: string, cloudId: string, url: string, jqlFilter: string): Promise<number> {
		const row = record(await this.rest(token, cloudId, "webhook", "register the dynamic webhook", "POST", { url, webhooks: [{ jqlFilter, events: JIRA_EVENTS }] }));
		const result = record(Array.isArray(row.webhookRegistrationResult) ? row.webhookRegistrationResult[0] : null);
		if (!positive(result.createdWebhookId)) throw malformed("a registered webhook id");
		return result.createdWebhookId;
	}

	async refreshWebhooks(token: string, cloudId: string, webhookIds: number[]): Promise<number> {
		if (!webhookIds.length || !webhookIds.every(positive)) throw new Error("Expected Jira webhook ids");
		const row = record(await this.rest(token, cloudId, "webhook/refresh", "renew dynamic webhooks", "PUT", { webhookIds }));
		const expiresAt = expiration(row.expirationDate);
		if (expiresAt === null) throw malformed("the webhook expiration date");
		return expiresAt;
	}

	async deleteWebhooks(token: string, cloudId: string, webhookIds: number[]): Promise<void> {
		if (!webhookIds.length) return;
		if (!webhookIds.every(positive)) throw new Error("Expected Jira webhook ids");
		await this.rest(token, cloudId, "webhook", "delete dynamic webhooks", "DELETE", { webhookIds });
	}
}

/** The deployment's Jira client, or null when the integration is off. */
export function jiraApp(): JiraApp | null {
	const { app } = jiraConfig();
	return app ? new JiraApp(app) : null;
}
