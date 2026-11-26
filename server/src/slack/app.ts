import { slackConfig, type SlackConfig } from "../config.js";

/** Bot scopes only; no authorization on behalf of the installer. */
export const SLACK_SCOPES = ["app_mentions:read", "commands", "chat:write", "channels:read", "groups:read"] as const;

export interface SlackInstall {
	accessToken: string;
	teamId: string;
	teamName: string;
	botUserId: string;
	installerId: string;
	scopes: string[];
}

/** Only known Slack error codes may escape the client; response text can contain credentials. */
const knownErrors = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive", "missing_scope", "invalid_code", "bad_redirect_uri", "channel_not_found", "not_in_channel", "ratelimited", "invalid_client_id", "bad_client_secret"]);

export class SlackError extends Error {
	constructor(readonly status: number, readonly code: string, readonly retryAt = 0) {
		super(`Slack request failed (${status}, ${code})`);
		this.name = "SlackError";
	}
	get rateLimited() { return this.status === 429 || this.code === "ratelimited"; }
	get unreachable() { return this.status === 0 || this.status >= 500; }
	get unauthorized() { return this.status === 401 || ["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(this.code); }
}

const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v : "";

/** Limit decompressed bytes, even for a chunked reply without Content-Length. */
async function readAnswer(response: Response): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) return {};
	let length = 0;
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > 1024 * 1024) {
			void reader.cancel().catch(() => undefined);
			throw new SlackError(response.status, "answer_too_large");
		}
		chunks.push(value);
	}
	try { return record(JSON.parse(Buffer.concat(chunks, length).toString("utf8"))); } catch { return {}; }
}

export class SlackApp {
	constructor(private readonly settings: SlackConfig, private readonly send: typeof fetch = fetch) {}

	authorizeUrl(state: string, redirectUri = this.settings.redirectUrl): string {
		const url = new URL(this.settings.authorizeUrl);
		url.searchParams.set("client_id", this.settings.clientId);
		url.searchParams.set("scope", SLACK_SCOPES.join(","));
		url.searchParams.set("state", state);
		if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);
		return url.href;
	}

	private async call(method: string, form: Record<string, string>, token?: string) {
		try {
			const lookup = method === "conversations.info";
			const params = new URLSearchParams(form);
			const url = `${this.settings.apiUrl.replace(/\/$/, "")}/${method}`;
			const response = await this.send(lookup ? `${url}?${params}` : url, {
				method: lookup ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
				headers: token ? { authorization: `Bearer ${token}` } : {}, body: lookup ? undefined : params,
			});
			const answer = await readAnswer(response);
			if (!response.ok || answer.ok !== true) {
				const code = text(answer.error), after = Number(response.headers.get("retry-after"));
				throw new SlackError(response.status, knownErrors.has(code) ? code : "refused", Number.isSafeInteger(after) && after > 0 ? Date.now() + after * 1000 : 0);
			}
			return answer;
		} catch (error) {
			if (error instanceof SlackError) throw error;
			throw new SlackError(0, "unreachable");
		}
	}

	async exchangeCode(code: string, redirectUri = this.settings.redirectUrl): Promise<SlackInstall> {
		const answer = await this.call("oauth.v2.access", { code, client_id: this.settings.clientId, client_secret: this.settings.clientSecret, ...(redirectUri && { redirect_uri: redirectUri }) });
		const team = record(answer.team), installer = record(answer.authed_user);
		// Ignore authed_user.access_token: it would act as the human installer.
		if (answer.token_type !== "bot") throw new SlackError(400, "not_bot");
		if (!text(answer.access_token) || !text(team.id) || !text(answer.bot_user_id) || !text(installer.id)) throw new SlackError(502, "invalid_install");
		const scopes = text(answer.scope).split(/[,\s]+/).filter(Boolean);
		if (SLACK_SCOPES.some(scope => !scopes.includes(scope))) throw new SlackError(400, "missing_scope");
		const identity = await this.identity(text(answer.access_token));
		if (identity.teamId !== team.id || identity.botUserId !== answer.bot_user_id) throw new SlackError(400, "not_bot");
		return { accessToken: text(answer.access_token), teamId: text(team.id), teamName: text(team.name).slice(0, 200), botUserId: text(answer.bot_user_id), installerId: text(installer.id), scopes };
	}

	/** Who a bearer token acts as. An install must match its bot and workspace. */
	async identity(token: string): Promise<{ teamId: string; teamName: string; botUserId: string }> {
		const answer = await this.call("auth.test", {}, token);
		if (!text(answer.bot_id)) throw new SlackError(400, "not_bot");
		if (!text(answer.team_id) || !text(answer.user_id)) throw new SlackError(502, "invalid_identity");
		return { teamId: text(answer.team_id), teamName: text(answer.team).slice(0, 200), botUserId: text(answer.user_id) };
	}

	/** Return only public/private channels visible to the bot, not DMs or archived channels. */
	async channel(token: string, channelId: string): Promise<{ id: string; name: string } | null> {
		if (!/^[CG][A-Z0-9]+$/.test(channelId)) return null;
		try {
			const answer = await this.call("conversations.info", { channel: channelId }, token);
			const row = record(answer.channel);
			if (row.id !== channelId || !text(row.name) || row.is_im === true || row.is_mpim === true || row.is_archived === true || row.is_member === false) return null;
			return { id: channelId, name: text(row.name).slice(0, 200) };
		} catch (error) {
			if (error instanceof SlackError && (error.code === "channel_not_found" || error.code === "not_in_channel")) return null;
			throw error;
		}
	}

	async postEphemeral(token: string, channel: string, user: string, message: string): Promise<void> {
		await this.call("chat.postEphemeral", { channel, user, text: message }, token);
	}

	async postMessage(token: string, channel: string, message: string, threadTs?: string): Promise<string> {
		const answer = await this.call("chat.postMessage", { channel, text: message, unfurl_links: "false", unfurl_media: "false", ...(threadTs && { thread_ts: threadTs }) }, token);
		if (!text(answer.ts)) throw new SlackError(502, "missing_ts");
		return text(answer.ts);
	}

	async revoke(token: string): Promise<void> {
		await this.call("auth.revoke", {}, token);
	}
}

export function slackApp(): SlackApp | null {
	const settings = slackConfig();
	return settings && new SlackApp(settings);
}
