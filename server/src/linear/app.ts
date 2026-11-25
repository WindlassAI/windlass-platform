import { createHash, randomBytes } from "node:crypto";
import { linearClientSecret, linearConfig } from "../config.js";

const USER_AGENT = "windlass-platform";
const REQUEST_TIMEOUT_MS = 20_000;
/** The most of an answer that is read. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_PAGES = 10;
export const LINEAR_SCOPES = ["read", "write", "app:assignable"] as const;

/** Linear's ids are UUIDs. */
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const isLinearId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export interface LinearAppSettings {
	clientId: string;
	/** Linear's API, without a trailing slash. */
	apiUrl: string;
	/** Linear itself, without a trailing slash: where the owner authorizes. */
	webUrl: string;
	/** The callback address registered with the app. */
	redirectUrl: string;
}

/**
 * A failed call to Linear. `status` is Linear's answer (0 when it could not be reached), `said` its own
 * words, redacted. The message is for the server's log: it names the call and never a credential.
 */
export class LinearError extends Error {
	constructor(readonly status: number, readonly said: string, what: string, readonly code = "") {
		super(`${what}: ${status === 0 ? said : `Linear answered ${status}${said ? ` (${said})` : ""}`}`);
		this.name = "LinearError";
	}

	get unreachable(): boolean {
		return this.status === 0 || this.status >= 500;
	}

	/** The token is no good any more: expired, revoked, or the app was uninstalled. */
	get unauthorized(): boolean {
		return this.status === 401 || this.code === "AuthenticationError" || this.code === "AUTHENTICATION_ERROR";
	}

	get rateLimited(): boolean {
		return this.status === 429 || this.code === "RATELIMITED";
	}
}

/** What a code or a refresh token is exchanged for. Both tokens are secrets. */
export interface LinearToken {
	accessToken: string;
	refreshToken: string | null;
	/** Milliseconds since the epoch; null when Linear gave no lifetime. */
	expiresAt: number | null;
	scopes: string[];
}

export interface LinearWorkspace {
	id: string;
	name: string;
	urlKey: string;
}

/** The application user of the workspace: what an issue is assigned to in order to file it. */
export interface LinearAppUser {
	id: string;
	name: string;
}

export interface LinearIdentity {
	workspace: LinearWorkspace;
	appUser: LinearAppUser;
	/**
	 * The human who installed the app. Always null: an app token cannot say, and Windlass does not ask
	 * for a second, personal authorization. Authorship of issues is untrusted until it is established.
	 */
	installer: null;
}

export interface LinearTeam {
	id: string;
	key: string;
	name: string;
}

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string;
	url: string;
	teamId: string;
	creator: { id: string; name: string } | null;
	assigneeId: string | null;
	labels: Array<{ id: string; name: string }>;
	/** Linear's state type: triage, backlog, unstarted, started, completed or canceled. */
	stateType: string;
	/** Archived or in the trash: not an active issue. */
	archived: boolean;
}

export type LinearWrite =
	| { key: "opened" | "handed over" | "merged" | "failed" | "cancelled"; commentId: string; pr: string | null }
	| { key: "attachment"; pr: string }
	| { key: "complete" };

export const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Linear's token shapes: API keys, OAuth tokens, and webhook signing secrets. */
const TOKEN_SHAPE = /\blin_(?:api|oauth|wh)_[A-Za-z0-9]{8,}/g;

/** Takes the credentials the caller used, and anything shaped like one, out of text that is logged or shown. */
export function redactLinear(value: string, known: ReadonlyArray<string | null | undefined> = []): string {
	let out = value;
	for (const secret of known) if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
	return out.replace(TOKEN_SHAPE, "[redacted]");
}

/** A PKCE verifier and, for the authorization address, its S256 challenge. */
export function newVerifier(): string {
	return randomBytes(32).toString("base64url");
}

export function challengeOf(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

async function boundedText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_ANSWER_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw new LinearError(response.status, "the answer is too large", "could not read Linear's answer");
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof LinearError) throw error;
		throw new LinearError(0, "the answer could not be read", "could not read Linear's answer");
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

export class LinearApp {
	constructor(
		readonly settings: LinearAppSettings,
		private readonly secrets: { clientSecret: () => string | null } = { clientSecret: () => linearClientSecret() },
	) {}

	/** Where the owner authorizes the app, as the app's own user and with PKCE. */
	authorizeUrl(state: string, codeChallenge: string): string {
		const query = new URLSearchParams({
			client_id: this.settings.clientId,
			redirect_uri: this.settings.redirectUrl,
			response_type: "code",
			scope: LINEAR_SCOPES.join(","),
			actor: "app",
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		return `${this.settings.webUrl}/oauth/authorize?${query}`;
	}

	private async send(url: string, init: RequestInit, what: string, secrets: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
		let response: Response;
		try {
			// A redirect would carry the credentials to wherever it points.
			response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		} catch (error) {
			const why = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds` : "the request did not get through";
			throw new LinearError(0, why, `could not ${what}`);
		}
		const raw = await boundedText(response);
		let body: Record<string, unknown> = {};
		try {
			body = raw === "" ? {} : record(JSON.parse(raw));
		} catch {
			body = {};
		}
		if (response.status >= 300) {
			const first = record(Array.isArray(body.errors) ? body.errors[0] : null);
			const said = text(body.error_description) || text(body.error) || text(first.message) || text(body.message);
			const code = text(record(first.extensions).type) || text(record(first.extensions).code) || text(body.error);
			throw new LinearError(response.status, redactLinear(said.replace(/\s+/g, " ").slice(0, 300), secrets), `could not ${what}`, code);
		}
		return { status: response.status, body };
	}

	private async token(form: Record<string, string>, what: string): Promise<LinearToken> {
		const secret = this.secrets.clientSecret();
		if (secret === null) throw new Error("WLP_LINEAR_CLIENT_SECRET is not set");
		const body = new URLSearchParams({ ...form, client_id: this.settings.clientId, client_secret: secret });
		const { body: answer } = await this.send(`${this.settings.apiUrl}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
			body,
		}, what, [secret, ...Object.values(form)]);
		const accessToken = text(answer.access_token);
		if (accessToken === "") throw new LinearError(400, "Linear gave no access token", `could not ${what}`);
		const refreshToken = text(answer.refresh_token);
		const lifetime = typeof answer.expires_in === "number" && Number.isFinite(answer.expires_in) && answer.expires_in > 0 ? answer.expires_in : null;
		const scope = Array.isArray(answer.scope) ? answer.scope.map(text) : text(answer.scope).split(/[\s,]+/);
		return { accessToken, refreshToken: refreshToken === "" ? null : refreshToken, expiresAt: lifetime === null ? null : Date.now() + lifetime * 1000, scopes: scope.filter((entry) => entry !== "") };
	}

	/** The authorization code's one exchange. */
	exchangeCode(code: string, codeVerifier: string | null): Promise<LinearToken> {
		return this.token({ grant_type: "authorization_code", code, redirect_uri: this.settings.redirectUrl, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }, "exchange the authorization code");
	}

	/** A new access token, for a refresh token. Linear rotates the refresh token too. */
	refresh(refreshToken: string): Promise<LinearToken> {
		return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }, "refresh the access token");
	}

	async revoke(token: string): Promise<void> {
		await this.send(`${this.settings.apiUrl}/oauth/revoke`, {
			method: "POST",
			headers: { "user-agent": USER_AGENT },
			body: new URLSearchParams({ token, token_type_hint: "access_token" }),
		}, "revoke the access token", [token]);
	}

	private async query(token: string, what: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const { body } = await this.send(`${this.settings.apiUrl}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT, authorization: `Bearer ${token}` },
			body: JSON.stringify({ query, variables }),
		}, what, [token]);
		if (Array.isArray(body.errors) && body.errors.length > 0) {
			const first = record(body.errors[0]);
			const code = text(record(first.extensions).type) || text(record(first.extensions).code);
			throw new LinearError(code === "AuthenticationError" || code === "AUTHENTICATION_ERROR" ? 401 : 400, redactLinear(text(first.message).replace(/\s+/g, " ").slice(0, 300), [token]), `could not ${what}`, code);
		}
		return record(body.data);
	}

	/**
	 * Who the token is and which workspace it is in. The token must be the app user's: a person's is
	 * refused, so the human installer is never taken for the app, nor the app for a human.
	 */
	async identity(token: string): Promise<LinearIdentity> {
		const data = await this.query(token, "read the workspace and the app user", "query { viewer { id name app } organization { id name urlKey } }");
		const viewer = record(data.viewer), organization = record(data.organization);
		if (viewer.app !== true) throw new LinearError(400, "the token is a person's, not the app user's", "could not read the workspace and the app user", "not_app_user");
		if (!isLinearId(viewer.id) || !isLinearId(organization.id)) throw new LinearError(502, "Linear's answer has no ids", "could not read the workspace and the app user");
		return {
			workspace: { id: organization.id, name: text(organization.name).slice(0, 200), urlKey: text(organization.urlKey).slice(0, 100) },
			appUser: { id: viewer.id, name: text(viewer.name).slice(0, 200) },
			installer: null,
		};
	}

	/** The teams this token can see: what the owner may map to a repository. */
	async teams(token: string): Promise<LinearTeam[]> {
		const teams: LinearTeam[] = [];
		let after: string | null = null;
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const data = await this.query(token, "list the accessible teams", "query($after: String) { teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }", { after });
			const connection = record(data.teams);
			for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
				const row = record(node);
				if (isLinearId(row.id) && text(row.key) !== "") teams.push({ id: row.id, key: text(row.key).slice(0, 20), name: text(row.name).slice(0, 200) });
			}
			const info = record(connection.pageInfo);
			if (info.hasNextPage !== true || text(info.endCursor) === "") break;
			after = text(info.endCursor);
		}
		return teams;
	}

	/** The one issue filing reads: its text, labels, assignee and whether it is still active. Null when Linear has no such issue. */
	async issue(token: string, id: string): Promise<LinearIssue | null> {
		if (!isLinearId(id)) return null;
		let data: Record<string, unknown>;
		try {
			data = await this.query(token, "read the issue", "query($id: String!) { issue(id: $id) { id identifier title description url archivedAt trashed team { id } creator { id name } assignee { id } labels(first: 50) { nodes { id name } } state { type } } }", { id });
		} catch (error) {
			if (error instanceof LinearError && /not found|entity/i.test(error.said)) return null;
			throw error;
		}
		const row = record(data.issue);
		const teamId = record(row.team).id;
		if (!isLinearId(row.id) || !isLinearId(teamId)) return null;
		const nodes = record(row.labels).nodes;
		const labels: LinearIssue["labels"] = [];
		for (const entry of Array.isArray(nodes) ? nodes : []) {
			const label = record(entry);
			if (isLinearId(label.id)) labels.push({ id: label.id, name: text(label.name) });
		}
		const creator = record(row.creator), assignee = record(row.assignee);
		return {
			id: row.id,
			identifier: text(row.identifier).slice(0, 40),
			title: text(row.title),
			description: text(row.description),
			url: text(row.url),
			teamId,
			creator: isLinearId(creator.id) ? { id: creator.id, name: text(creator.name).slice(0, 200) } : null,
			assigneeId: isLinearId(assignee.id) ? assignee.id : null,
			labels,
			stateType: text(record(row.state).type),
			archived: text(row.archivedAt) !== "" || row.trashed === true,
		};
	}

	async writeIssue(token: string, issueId: string, itemId: string, write: LinearWrite): Promise<void> {
		if (write.key === "attachment") {
			const data = await this.query(token, "attach the pull request", "mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }",
				{ input: { issueId, url: write.pr, title: "Windlass pull request" } });
			if (record(data.attachmentCreate).success !== true) throw new LinearError(400, "attachment declined", "attach the pull request");
		} else if (write.key === "complete") {
			const data = await this.query(token, "read the team's completed state",
				'query($id: String!) { issue(id: $id) { state { type } team { states(first: 1, filter: { type: { eq: "completed" } }) { nodes { id } } } } }', { id: issueId });
			const issue = record(data.issue);
			if (record(issue.state).type === "completed") return;
			const nodes = record(record(issue.team).states).nodes;
			const stateId = Array.isArray(nodes) && record(nodes[0]).id;
			if (!isLinearId(stateId)) throw new LinearError(400, "the team has no completed state", "complete the issue");
			const updated = await this.query(token, "complete the issue", "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id: issueId, stateId });
			if (record(updated.issueUpdate).success !== true) throw new LinearError(400, "state change declined", "complete the issue");
		} else {
			const outcome = { opened: "opened its pull request", "handed over": "was handed over", merged: "merged", failed: "failed", cancelled: "was cancelled" }[write.key];
			const body = `Windlass item ${itemId} ${outcome}.${write.pr ? " " + write.pr : ""}`;
			try {
				const data = await this.query(token, "comment on the issue", "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
					{ input: { id: write.commentId, issueId, body } });
				if (record(data.commentCreate).success !== true) throw new LinearError(400, "comment declined", "comment on the issue");
			} catch (error) {
				// Linear may have saved this UUID before the reply was lost.
				if (error instanceof LinearError && ([400, 409, 422].includes(error.status) || error.unreachable)) {
					const found = await this.query(token, "find the item's comment", "query($id: String!) { comment(id: $id) { issue { id } } }", { id: write.commentId })
						.catch((cause: unknown) => {
							if (cause instanceof LinearError && cause.status === 400) return null;
							throw cause;
						});
					if (record(record(found?.comment).issue).id === issueId) return;
				}
				throw error;
			}
		}
	}
}

let current: { key: string; app: LinearApp } | null = null;

/** The deployment's Linear app, or null when it is not configured. */
export function linearApp(): LinearApp | null {
	const { app } = linearConfig();
	if (!app) return null;
	const key = JSON.stringify(app);
	if (current?.key !== key) current = { key, app: new LinearApp(app) };
	return current.app;
}
