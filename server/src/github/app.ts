/**
 * The deployment's GitHub App, as the server talks to GitHub: the app's own token, installation
 * tokens, the exchange of a user's authorization code, and the few REST calls the platform makes.
 *
 * Three credentials exist, and none of them is ever stored, logged, or put into an error:
 *
 *   the app's JWT            signed here with the app's private key (RS256), good for nine minutes, sent
 *                            to GitHub and to nothing else. It can only ask for installation tokens
 *   an installation token    GitHub's, good for an hour at most. Every one is asked for with the one
 *                            repository and the permissions the step at hand needs (`TokenScope`), is
 *                            used for that step and dropped; one that went into a sandbox is revoked
 *                            when its git command has ended
 *   a user access token      what a user's authorization code is exchanged for when they connect. It
 *                            is used for two questions (who is this, which installations can they
 *                            reach), deleted at GitHub, and forgotten. The platform keeps no
 *                            credential of the user's: what it does later it does as the installation
 *
 * What GitHub's documentation says of each call, as read on 2026-11-15:
 *
 *   the JWT                  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *                            (RS256; `iat` a minute in the past; `exp` at most ten minutes ahead; `iss`
 *                            the app id or the client id; sent as `Authorization: Bearer`)
 *   installation tokens      https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 *                            (`repository_ids`, `permissions`; expires after one hour; 404 for an
 *                            installation that is gone, 422 for a repository or a permission the
 *                            installation does not have). They no longer have a fixed length
 *   revoking one             https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token
 *   the code exchange        https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 *                            (`POST <github>/login/oauth/access_token` with `client_id`, `client_secret`,
 *                            `code`, `code_verifier`)
 *   deleting a user token    https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token
 *                            (Basic authentication with the client id and secret)
 *   who the user is          https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 *   their installations      https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
 *   an installation's repos  https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation
 *   a user's permission      https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
 *                            (an installation token with "Metadata: read" may ask:
 *                            https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
 *   branches                 https://docs.github.com/en/rest/branches/branches#list-branches ("Contents: read")
 *   pull requests            https://docs.github.com/en/rest/pulls/pulls ("Pull requests: write" to create)
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { githubClientSecret, githubConfig, githubPrivateKey } from "../config.js";
import { redact } from "./redact.js";

/** The REST API version every request names; the one GitHub's documentation showed when this was written. */
export const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "windlass-platform";
const REQUEST_TIMEOUT_MS = 20_000;
/** Listings are read a hundred a page (GitHub's most), up to this many pages. */
const MAX_PAGES = 10;

export interface GithubAppSettings {
	appId: string;
	slug: string;
	clientId: string;
	/** GitHub's API, without a trailing slash. */
	apiUrl: string;
	/** GitHub itself, without a trailing slash: where users authorize and git clones from. */
	webUrl: string;
}

/**
 * A failure of a call to GitHub. `status` is GitHub's answer (0 when it could not be reached), `said`
 * is GitHub's own `message`, redacted. Whoever catches it turns it into a sentence for the user; the
 * error's own message is for the server's log and names the call, never a credential.
 */
export class GithubError extends Error {
	constructor(
		readonly status: number,
		readonly said: string,
		what: string,
		readonly headers = new Headers(),
	) {
		super(`${what}: ${status === 0 ? said : `GitHub answered ${status}${said ? ` (${said})` : ""}`}`);
		this.name = "GithubError";
	}

	get unreachable(): boolean {
		return this.status === 0 || this.status >= 500;
	}
}

export type PermissionLevel = "read" | "write";

/** What an installation token is asked for: one repository (or none: the installation's list) and the permissions of one step. */
export interface TokenScope {
	/** GitHub's id of the one repository the token is good for; omitted only to list the installation's repositories. */
	repositoryId?: number;
	permissions: { metadata: "read"; contents?: PermissionLevel; pull_requests?: PermissionLevel; checks?: "read"; statuses?: "read"; actions?: "read" };
}

export interface InstallationToken {
	/** A secret. */
	token: string;
	expiresAt: number;
}

export interface GithubUser {
	id: number;
	login: string;
}

export interface Installation {
	id: number;
	account: { id: number; login: string; type: "User" | "Organization" };
	/** The installation's page at GitHub, where its repositories are chosen. */
	htmlUrl: string;
	suspended: boolean;
}

export interface Repository {
	id: number;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	pushedAt: number | null;
}

export interface Pull {
	number: number;
	url: string;
	state: "open" | "draft" | "merged" | "closed";
	mergeable: boolean | null;
	title: string;
	/** Its description, as GitHub has it; "" when it has none. */
	body: string;
	head: string;
	base: string;
}

type Auth = { bearer: string } | { basic: string } | null;

interface Call {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	query?: Record<string, string | number>;
	body?: unknown;
	auth: Auth;
	/** What the call is, for an error's message: "list the installation's repositories". */
	what: string;
	/** Against GitHub itself instead of its API (the code exchange). */
	web?: boolean;
	/** Credentials that must not appear in an error, beside the ones in `auth`. */
	secrets?: string[];
	/** When the work the call is part of must be over (ms since the epoch): the call gets what is left of it, at most its own limit. */
	deadline?: number;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : 0);

export class GithubApp {
	private key: KeyObject | null = null;

	constructor(
		readonly settings: GithubAppSettings,
		private readonly secrets: { clientSecret: () => string | null; privateKey: () => string | null },
	) {}

	/** `https://github.com/owner/name`. */
	repositoryUrl(owner: string, name: string): string {
		return `${this.settings.webUrl}/${owner}/${name}`;
	}

	/** What git clones from and pushes to. */
	cloneUrl(owner: string, name: string): string {
		return `${this.repositoryUrl(owner, name)}.git`;
	}

	/** Where a user authorizes the app: the web application flow's first step, with PKCE. */
	authorizeUrl(state: string, codeChallenge: string): string {
		const query = new URLSearchParams({ client_id: this.settings.clientId, state, code_challenge: codeChallenge, code_challenge_method: "S256" });
		return `${this.settings.webUrl}/login/oauth/authorize?${query}`;
	}

	/** Where a user installs the app on an account and chooses its repositories. */
	installUrl(state: string): string {
		return `${this.settings.webUrl}/apps/${this.settings.slug}/installations/new?${new URLSearchParams({ state })}`;
	}

	// ---- the app's own token ------------------------------------------------------------------

	private privateKey(): KeyObject {
		if (this.key) return this.key;
		const pem = this.secrets.privateKey();
		if (pem === null) throw new Error("WLP_GITHUB_PRIVATE_KEY is not set");
		try {
			this.key = createPrivateKey(pem);
		} catch {
			// Node's own message may quote the input.
			throw new Error("WLP_GITHUB_PRIVATE_KEY is not a private key: give the PEM file GitHub lets you download, as it is or in base64");
		}
		if (this.key.asymmetricKeyType !== "rsa") {
			this.key = null;
			throw new Error("WLP_GITHUB_PRIVATE_KEY is not an RSA key, which is what GitHub signs an app's tokens with");
		}
		return this.key;
	}

	/** The app's JWT. `iat` is a minute back for clocks that differ, and `exp` nine minutes ahead: GitHub accepts ten at most. */
	jwt(now = Date.now()): string {
		const seconds = Math.floor(now / 1000);
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
		const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 9 * 60, iss: this.settings.appId })}`;
		return `${body}.${createSign("RSA-SHA256").update(body).sign(this.privateKey()).toString("base64url")}`;
	}

	/** Null when the key signs; otherwise why not, in a sentence that names the variable. */
	keyProblem(): string | null {
		try {
			this.jwt();
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : "WLP_GITHUB_PRIVATE_KEY could not be used";
		}
	}

	// ---- requests -----------------------------------------------------------------------------

	private async request(call: Call, redirect: RequestRedirect): Promise<Response> {
		const base = call.web ? this.settings.webUrl : this.settings.apiUrl;
		const url = new URL(`${base}${call.path}`);
		for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, String(value));
		const headers: Record<string, string> = { accept: call.web ? "application/json" : "application/vnd.github+json", "user-agent": USER_AGENT };
		if (!call.web) headers["x-github-api-version"] = GITHUB_API_VERSION;
		if (call.auth && "bearer" in call.auth) {
			headers.authorization = `Bearer ${call.auth.bearer}`;
		} else if (call.auth) {
			headers.authorization = `Basic ${Buffer.from(call.auth.basic, "utf8").toString("base64")}`;
		}
		if (call.body !== undefined) headers["content-type"] = "application/json";

		const limit = call.deadline === undefined ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, call.deadline - Date.now());
		if (limit <= 0) throw new GithubError(0, "no time was left for it", `could not ${call.what}`);
		try {
			return await fetch(url, { method: call.method ?? "GET", headers, body: call.body === undefined ? undefined : JSON.stringify(call.body), signal: AbortSignal.timeout(limit), redirect });
		} catch (error) {
			const why = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${Math.ceil(limit / 1000)} seconds` : "the request did not get through";
			throw new GithubError(0, why, `could not ${call.what}`);
		}
	}

	private async call(call: Call): Promise<{ status: number; body: unknown; next: boolean }> {
		const response = await this.request(call, "follow");
		const raw = await response.text().catch(() => "");
		let body: unknown = null;
		if (raw !== "") {
			try {
				body = JSON.parse(raw);
			} catch {
				body = null;
			}
		}
		// The code exchange answers 200 with an `error` in it.
		const refused = call.web && text(record(body).error) !== "";
		if (!response.ok || refused) {
			const fields = record(body);
			const errors = Array.isArray(fields.errors) ? fields.errors.map((entry) => text(record(entry).message) || text(entry)).filter((entry) => entry !== "") : [];
			const said = [text(fields.message) || text(fields.error_description) || text(fields.error), ...errors].filter((part) => part !== "").join(": ");
			const known = [...(call.secrets ?? [])];
			if (call.auth) known.push("bearer" in call.auth ? call.auth.bearer : call.auth.basic);
			throw new GithubError(refused && response.ok ? 400 : response.status, redact(said.replace(/\s+/g, " ").slice(0, 300), known), `could not ${call.what}`, response.headers);
		}
		return { status: response.status, body, next: /rel="next"/.test(response.headers.get("link") ?? "") };
	}

	/** Every page of a listing, a hundred a page; `truncated` when there were more pages than are read. */
	async pages<T>(call: Omit<Call, "method" | "body">, read: (body: unknown) => T[]): Promise<{ items: T[]; truncated: boolean }> {
		const items: T[] = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const answer = await this.call({ ...call, query: { ...call.query, per_page: 100, page } });
			items.push(...read(answer.body));
			if (!answer.next) return { items, truncated: false };
		}
		return { items, truncated: true };
	}

	// ---- installation tokens ------------------------------------------------------------------

	/** Asks GitHub for a token of one installation, restricted to `scope`. Throws GithubError: 404 when the installation is gone, 422 when it does not cover the repository or the permission. */
	async installationToken(installationId: number, scope: TokenScope, deadline?: number): Promise<InstallationToken> {
		const body: Record<string, unknown> = { permissions: scope.permissions };
		if (scope.repositoryId !== undefined) body.repository_ids = [scope.repositoryId];
		const answer = await this.call({ method: "POST", path: `/app/installations/${installationId}/access_tokens`, body, auth: { bearer: this.jwt() }, what: "get a token for the installation", deadline });
		const fields = record(answer.body);
		const token = text(fields.token);
		const expiresAt = Date.parse(text(fields.expires_at));
		if (token === "") throw new GithubError(answer.status, "the answer holds no token", "could not get a token for the installation");
		return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000 };
	}

	/** Revokes an installation token. Never throws: a token that could not be revoked runs out within its hour. */
	async revoke(token: InstallationToken | string): Promise<boolean> {
		const secret = typeof token === "string" ? token : token.token;
		try {
			await this.call({ method: "DELETE", path: "/installation/token", auth: { bearer: secret }, what: "revoke an installation token" });
			return true;
		} catch (error) {
			console.error(`[wlp] github.token.revoke_failed: ${error instanceof Error ? error.message : "unknown error"}`);
			return false;
		}
	}

	/**
	 * Runs `step` with a token of the installation for exactly `scope`. The token is not kept: one that
	 * `step` took into a sandbox (`revokeAfter`) is revoked when the step has ended, however it ended.
	 */
	async withToken<T>(installationId: number, scope: TokenScope, step: (token: string) => Promise<T>, options: { revokeAfter?: boolean } = {}): Promise<T> {
		const issued = await this.installationToken(installationId, scope);
		try {
			return await step(issued.token);
		} finally {
			if (options.revokeAfter) await this.revoke(issued);
		}
	}

	// ---- a user who connects ------------------------------------------------------------------

	/** Exchanges the code a user's authorization ended with for a user access token. */
	async exchangeCode(code: string, codeVerifier: string | null): Promise<string> {
		const clientSecret = this.secrets.clientSecret();
		if (clientSecret === null) throw new Error("WLP_GITHUB_CLIENT_SECRET is not set");
		const body: Record<string, string> = { client_id: this.settings.clientId, client_secret: clientSecret, code };
		if (codeVerifier !== null) body.code_verifier = codeVerifier;
		const answer = await this.call({ method: "POST", path: "/login/oauth/access_token", body, auth: null, web: true, what: "exchange the authorization code", secrets: [clientSecret, code] });
		const token = text(record(answer.body).access_token);
		if (token === "") throw new GithubError(answer.status, "the answer holds no token", "could not exchange the authorization code");
		return token;
	}

	async viewer(userToken: string): Promise<GithubUser> {
		const answer = await this.call({ path: "/user", auth: { bearer: userToken }, what: "read who authorized" });
		const fields = record(answer.body);
		const user = { id: whole(fields.id), login: text(fields.login) };
		if (user.id === 0 || user.login === "") throw new GithubError(answer.status, "the answer names no user", "could not read who authorized");
		return user;
	}

	/** The installations of this app the user can reach: accounts they own, and ones they are a member or collaborator in. */
	async userInstallations(userToken: string): Promise<Installation[]> {
		const { items } = await this.pages({ path: "/user/installations", auth: { bearer: userToken }, what: "list the user's installations" }, (body) => {
			const list = record(body).installations;
			return Array.isArray(list) ? list : [];
		});
		const installations: Installation[] = [];
		for (const item of items) {
			const fields = record(item);
			const account = record(fields.account);
			const id = whole(fields.id);
			const login = text(account.login);
			// An enterprise's installation has a `slug` and no `login`: the platform works on repositories of users and organizations.
			if (id === 0 || login === "") continue;
			installations.push({
				id,
				account: { id: whole(account.id), login, type: text(account.type) === "Organization" ? "Organization" : "User" },
				htmlUrl: text(fields.html_url),
				suspended: fields.suspended_at !== null && fields.suspended_at !== undefined,
			});
		}
		return installations;
	}

	/** Deletes the user access token at GitHub: the platform has asked what it needed. Never throws. */
	async forgetUserToken(userToken: string): Promise<void> {
		const clientSecret = this.secrets.clientSecret();
		if (clientSecret === null) return;
		try {
			await this.call({
				method: "DELETE",
				path: `/applications/${this.settings.clientId}/token`,
				body: { access_token: userToken },
				auth: { basic: `${this.settings.clientId}:${clientSecret}` },
				what: "delete the user's token",
				secrets: [userToken, clientSecret],
			});
		} catch (error) {
			console.error(`[wlp] github.user_token.delete_failed: ${error instanceof Error ? error.message : "unknown error"}`);
		}
	}

	// ---- repositories -------------------------------------------------------------------------

	private repositoryOf(value: unknown): Repository | null {
		const fields = record(value);
		const id = whole(fields.id);
		const owner = text(record(fields.owner).login);
		const name = text(fields.name);
		if (id === 0 || owner === "" || name === "") return null;
		const pushed = Date.parse(text(fields.pushed_at));
		return { id, owner, name, private: fields.private === true, archived: fields.archived === true, defaultBranch: text(fields.default_branch) || "main", pushedAt: Number.isFinite(pushed) ? pushed : null };
	}

	/** Every repository the token's installation covers (the first thousand). */
	async installationRepositories(token: string, deadline?: number): Promise<{ repositories: Repository[]; truncated: boolean }> {
		const { items, truncated } = await this.pages({ path: "/installation/repositories", auth: { bearer: token }, what: "list the installation's repositories", deadline }, (body) => {
			const list = record(body).repositories;
			return Array.isArray(list) ? list : [];
		});
		return { repositories: items.map((item) => this.repositoryOf(item)).filter((item): item is Repository => item !== null), truncated };
	}

	async repository(token: string, owner: string, name: string, deadline?: number): Promise<Repository> {
		const answer = await this.call({ path: `/repos/${owner}/${name}`, auth: { bearer: token }, what: `read ${owner}/${name}`, deadline });
		const found = this.repositoryOf(answer.body);
		if (!found) throw new GithubError(answer.status, "the answer describes no repository", `could not read ${owner}/${name}`);
		return found;
	}

	/** The first three hundred branch names. */
	async branches(token: string, owner: string, name: string): Promise<{ branches: string[]; truncated: boolean }> {
		const names: string[] = [];
		for (let page = 1; page <= 3; page += 1) {
			const answer = await this.call({ path: `/repos/${owner}/${name}/branches`, query: { per_page: 100, page }, auth: { bearer: token }, what: `list the branches of ${owner}/${name}` });
			for (const item of Array.isArray(answer.body) ? answer.body : []) {
				const branch = text(record(item).name);
				if (branch !== "") names.push(branch);
			}
			if (!answer.next) return { branches: names, truncated: false };
		}
		return { branches: names, truncated: true };
	}

	/**
	 * What a GitHub user may do in a repository, by GitHub's own reckoning of every grant (the
	 * repository's, a team's, the organization's): "admin", "write", "read" or "none". A user GitHub
	 * does not know there is "none".
	 */
	async permission(token: string, owner: string, name: string, login: string, deadline?: number): Promise<"admin" | "write" | "read" | "none"> {
		try {
			const answer = await this.call({ path: `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`, auth: { bearer: token }, what: `read what ${login} may do in ${owner}/${name}`, deadline });
			const level = text(record(answer.body).permission);
			return level === "admin" || level === "write" || level === "read" ? level : "none";
		} catch (error) {
			if (!(error instanceof GithubError) || error.status !== 404) throw error;
		}
		// Not found: the user is not one GitHub knows in this repository, or the repository is not there.
		// Asking for the repository tells which; if it is gone, that is the failure.
		await this.repository(token, owner, name, deadline);
		return "none";
	}

	/** Job logs redirect to short-lived storage URLs. Start a fresh request there without the installation token. */
	async jobLog(token: string, owner: string, name: string, jobId: number): Promise<Response> {
		const response = await this.request({ path: `/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, auth: { bearer: token }, what: "read the job log" }, "manual");
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) return response;
		await response.body?.cancel();
		return fetch(new URL(location, response.url), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	}

	// ---- pull requests ------------------------------------------------------------------------

	private pullOf(value: unknown): Pull | null {
		const fields = record(value);
		const number = whole(fields.number);
		if (number === 0) return null;
		const merged = fields.merged === true || (fields.merged_at !== null && fields.merged_at !== undefined);
		const state = merged ? "merged" : text(fields.state) === "closed" ? "closed" : fields.draft === true ? "draft" : "open";
		return { number, url: text(fields.html_url), state, mergeable: typeof fields.mergeable === "boolean" ? fields.mergeable : null, title: text(fields.title), body: text(fields.body), head: text(record(fields.head).ref), base: text(record(fields.base).ref) };
	}

	async createPull(token: string, owner: string, name: string, input: { title: string; body: string; head: string; base: string }): Promise<Pull> {
		const answer = await this.call({ method: "POST", path: `/repos/${owner}/${name}/pulls`, body: input, auth: { bearer: token }, what: `open a pull request in ${owner}/${name}` });
		const pull = this.pullOf(answer.body);
		if (!pull) throw new GithubError(answer.status, "the answer describes no pull request", `could not open a pull request in ${owner}/${name}`);
		return pull;
	}

	async pull(token: string, owner: string, name: string, number: number): Promise<Pull> {
		const answer = await this.call({ path: `/repos/${owner}/${name}/pulls/${number}`, auth: { bearer: token }, what: `read pull request #${number} of ${owner}/${name}` });
		const pull = this.pullOf(answer.body);
		if (!pull) throw new GithubError(answer.status, "the answer describes no pull request", `could not read pull request #${number} of ${owner}/${name}`);
		return pull;
	}

	/** Gives an open pull request another title and description. */
	async updatePull(token: string, owner: string, name: string, number: number, input: { title: string; body: string }): Promise<Pull> {
		const answer = await this.call({ method: "PATCH", path: `/repos/${owner}/${name}/pulls/${number}`, body: input, auth: { bearer: token }, what: `update pull request #${number} of ${owner}/${name}` });
		const pull = this.pullOf(answer.body);
		if (!pull) throw new GithubError(answer.status, "the answer describes no pull request", `could not update pull request #${number} of ${owner}/${name}`);
		return pull;
	}

	/** The open pull request from `head` into `base`, if there is one: GitHub allows one per pair of branches. */
	async openPull(token: string, owner: string, name: string, head: string, base: string): Promise<Pull | null> {
		const answer = await this.call({ path: `/repos/${owner}/${name}/pulls`, query: { state: "open", head: `${owner}:${head}`, base, per_page: 5 }, auth: { bearer: token }, what: `look for an open pull request in ${owner}/${name}` });
		const list = (Array.isArray(answer.body) ? answer.body : []).map((item) => this.pullOf(item)).filter((item): item is Pull => item !== null);
		return list.find((item) => item.head === head) ?? null;
	}
}

let own: GithubApp | null | undefined;

/** This server's GitHub App, from its configuration; null when the deployment has none. */
export function githubApp(): GithubApp | null {
	if (own === undefined) {
		const { app } = githubConfig();
		own = app ? new GithubApp(app, { clientSecret: githubClientSecret, privateKey: githubPrivateKey }) : null;
	}
	return own;
}
