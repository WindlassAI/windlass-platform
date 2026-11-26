/** Loopback Slack OAuth v2 and Web API. Signs deliveries independently of the platform verifier. */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const random = () => randomBytes(16).toString("hex");

export class SlackStandin {
	readonly clientId = "123456.789012";
	readonly clientSecret = random();
	readonly signingSecret = random();
	readonly team = { id: "T12345678", name: "Test workspace" };
	readonly installerId = "U12345678";
	readonly botUserId = "U87654321";
	readonly channelId = "C12345678";
	readonly channels = [
		{ id: this.channelId, name: "engineering", is_member: true },
		{ id: "G12345678", name: "private-team", is_private: true, is_member: true },
		{ id: "C23456789", name: "archived", is_archived: true },
		{ id: "C34567890", name: "not-joined", is_member: false },
	];
	readonly tokens = new Set<string>();
	readonly calls: string[] = [];
	readonly messages: { channel: string; text: string; thread_ts?: string; ts: string }[] = [];
	readonly ephemeral: { channel: string; user: string; text: string }[] = [];
	identityTeamId = this.team.id;
	rateLimited = false;
	decline = false;
	grantScopes: string[] | null = null;
	tokenType = "bot";
	private readonly codes = new Map<string, string>();
	private readonly server = createServer((req, res) => void this.handle(req, res).catch(() => {
		res.writeHead(500).end();
	}));

	static async start() {
		const slack = new SlackStandin();
		await new Promise<void>(resolve => slack.server.listen(0, "127.0.0.1", resolve));
		return slack;
	}

	get url() { return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; }
	get redirectUri() { return `${this.url}/slack/callback`; }
	get env() {
		return {
			WLP_SLACK_CLIENT_ID: this.clientId, WLP_SLACK_CLIENT_SECRET: this.clientSecret, WLP_SLACK_SIGNING_SECRET: this.signingSecret,
			WLP_SLACK_API_URL: `${this.url}/api`, WLP_SLACK_AUTHORIZE_URL: `${this.url}/oauth/v2/authorize`, WLP_SLACK_REDIRECT_URL: this.redirectUri,
		};
	}

	async close() {
		this.server.closeAllConnections();
		await new Promise<void>(resolve => this.server.close(() => resolve()));
	}

	async authorize(url: string): Promise<string> {
		if (new URL(url).origin !== this.url) throw new Error("OAuth URL isn't the stand-in");
		const response = await fetch(url, { redirect: "manual" });
		if (response.status !== 302) throw new Error(`stand-in refused authorization: ${response.status}`);
		return response.headers.get("location")!;
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url!, this.url);
		const q = url.searchParams;
		this.calls.push(`${req.method} ${url.pathname}`);
		if (req.method === "GET" && url.pathname === "/oauth/v2/authorize") {
			if (q.get("client_id") !== this.clientId || q.get("redirect_uri") !== this.redirectUri || !q.get("state")) return res.writeHead(400).end();
			const back = new URL(this.redirectUri);
			back.searchParams.set("state", q.get("state")!);
			if (this.decline) back.searchParams.set("error", "access_denied");
			else {
				const code = random();
				this.codes.set(code, this.grantScopes?.join(",") ?? q.get("scope") ?? "");
				back.searchParams.set("code", code);
			}
			return res.writeHead(302, { location: back.href }).end();
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const form = new URLSearchParams(Buffer.concat(chunks).toString());
		const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (req.method === "POST" && url.pathname === "/api/oauth.v2.access") {
			const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
			if (req.headers.authorization !== `Basic ${basic}` && (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret)) return json({ ok: false, error: "bad_client_secret" });
			const code = form.get("code") ?? "";
			if (!this.codes.has(code) || form.get("redirect_uri") !== this.redirectUri) return json({ ok: false, error: "invalid_code" });
			const scope = this.codes.get(code);
			this.codes.delete(code);
			const token = `${this.tokenType === "bot" ? "xoxb" : "xoxp"}-${random()}`;
			this.tokens.add(token);
			return json({ ok: true, app_id: "A12345678", team: this.team, bot_user_id: this.botUserId, authed_user: { id: this.installerId }, token_type: this.tokenType, access_token: token, scope });
		}
		const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
		if (!this.tokens.has(token)) return json({ ok: false, error: "invalid_auth" });
		if (req.method === "GET" && url.pathname === "/api/conversations.info") {
			const channel = this.channels.find(ch => ch.id === q.get("channel"));
			return json(channel ? { ok: true, channel } : { ok: false, error: "channel_not_found" });
		}
		if (req.method === "POST" && url.pathname === "/api/auth.test") return json({ ok: true, team_id: this.identityTeamId, team: this.team.name, bot_id: "B12345678", user_id: this.botUserId });
		if (req.method === "POST" && url.pathname === "/api/chat.postEphemeral") {
			this.ephemeral.push({ channel: form.get("channel") ?? "", user: form.get("user") ?? "", text: form.get("text") ?? "" });
			return json({ ok: true, message_ts: "1711111111.000000" });
		}
		if (req.method === "POST" && url.pathname === "/api/auth.revoke") {
			this.tokens.delete(token);
			return json({ ok: true, revoked: true });
		}
		if (req.method === "POST" && url.pathname === "/api/chat.postMessage") {
			if (this.rateLimited) return res.writeHead(429, { "retry-after": "3" }).end(JSON.stringify({ ok: false, error: "ratelimited" }));
			if (form.get("unfurl_links") !== "false" || form.get("unfurl_media") !== "false" || form.get("reply_broadcast") === "true") {
				return json({ ok: false, error: "unsafe_message" });
			}
			const channel = form.get("channel");
			if (channel !== this.channelId) return json({ ok: false, error: "channel_not_found" });
			const thread = form.get("thread_ts");
			const ts = `1711111111.${String(this.messages.length + 1).padStart(6, "0")}`;
			this.messages.push({ channel, text: form.get("text") ?? "", ...(thread && { thread_ts: thread }), ts });
			return json({ ok: true, channel, ts });
		}
		res.writeHead(404).end();
	}

	mention() {
		return { type: "event_callback", team_id: this.team.id, api_app_id: "A12345678", authorizations: [{ team_id: this.team.id, user_id: this.botUserId, is_bot: true }], event_id: `Ev${random()}`, event: { type: "app_mention", channel: this.channelId, user: this.installerId, ts: "1710000000.123456", thread_ts: "1710000000.000001", text: `<@${this.botUserId}> fix café` } };
	}

	command() {
		return new URLSearchParams({ command: "/windlass", team_id: this.team.id, channel_id: this.channelId, user_id: this.installerId, trigger_id: `12345.67890.${random()}`, text: "fix A+B & café", response_url: `https://hooks.slack.test/commands/${random()}` });
	}

	/** Sign the original bytes, optionally delivering different bytes or headers for refusal cases. */
	request(target: string, body: string, contentType = "application/json", opts: { timestamp?: string; sentBody?: string; headers?: Record<string, string>; omit?: string; secret?: string } = {}) {
		const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", opts.secret ?? this.signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex");
		const headers = new Headers({ "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}`, ...opts.headers });
		if (opts.omit) headers.delete(opts.omit);
		return new Request(target, { method: "POST", headers, body: opts.sentBody ?? body });
	}
}
