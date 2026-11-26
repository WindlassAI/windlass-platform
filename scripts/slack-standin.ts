import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export class SlackStandin {
	readonly team = { id: "T12345678", name: "Test workspace" };
	readonly member = "U55667788";
	readonly bot = "UBOT";
	readonly channel = { id: "C12345678", name: "engineering" };
	readonly messages: { channel: string; text: string; thread: string | null; ts: string }[] = [];
	readonly privateReplies: { user: string; text: string }[] = [];
	readonly secret = randomUUID();
	readonly signing = randomUUID();
	private readonly codes = new Map<string, string>();
	readonly tokens = new Set<string>();
	private readonly server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const url = new URL(req.url!, this.url);
		const form = req.method === "GET" ? url.searchParams : new URLSearchParams(Buffer.concat(chunks).toString());
		const json = (value: unknown) => res.setHeader("content-type", "application/json").end(JSON.stringify(value));
		if (req.url === "/api/oauth.v2.access") {
			const code = form.get("code") ?? "", scope = this.codes.get(code);
			if (!scope || form.get("client_secret") !== this.secret || form.get("redirect_uri") !== this.callback) return json({ ok: false });
			this.codes.delete(code);
			const token = randomUUID();
			this.tokens.add(token);
			return json({ ok: true, team: this.team, bot_user_id: this.bot, access_token: token, token_type: "bot", scope });
		}
		const token = req.headers.authorization?.slice(7) ?? "";
		if (!this.tokens.has(token)) return json({ ok: false, error: "invalid_auth" });
		switch (url.pathname) {
			case "/api/conversations.list": {
				if (req.method !== "GET" || form.get("types") !== "public_channel,private_channel" || form.get("exclude_archived") !== "true") return json({ ok: false });
				const second = form.get("cursor") === "page2";
				return json({ ok: true, channels: second ? [{ ...this.channel, is_member: true }] : [{ id: "COTHER", name: "not-joined", is_member: false }],
					response_metadata: { next_cursor: second ? "" : "page2" } });
			}
			case "/api/chat.postEphemeral":
				this.privateReplies.push({ user: form.get("user")!, text: form.get("text")! });
				return json({ ok: true });
			case "/api/chat.postMessage": {
				const ts = `1711111111.${String(this.messages.length + 1).padStart(6, "0")}`;
				this.messages.push({ ts, channel: form.get("channel")!, text: form.get("text")!, thread: form.get("thread_ts") });
				return json({ ok: true, ts });
			}
			case "/api/auth.revoke": this.tokens.delete(token); return json({ ok: true });
			default: res.writeHead(404).end();
		}
	});
	constructor(private readonly callback: string) {}
	async start() { await new Promise<void>(ok => this.server.listen(0, "127.0.0.1", ok)); }
	async stop() { this.server.closeAllConnections(); await new Promise<void>(ok => this.server.close(() => ok())); }
	get url() { return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; }
	authorize(consent: string) {
		const url = new URL(consent), q = url.searchParams;
		if (url.origin !== this.url || url.pathname !== "/oauth/v2/authorize" || q.get("redirect_uri") !== this.callback) throw new Error("Wrong OAuth destination");
		const code = randomUUID();
		this.codes.set(code, q.get("scope")!);
		return this.callback + "?" + new URLSearchParams({ state: q.get("state")!, code });
	}
	mention(text = "Update the setup guide", user = this.member) {
		return { type: "event_callback", team_id: this.team.id, event_id: "Ev" + randomUUID().replaceAll("-", ""),
			authorizations: [{ is_bot: true, user_id: this.bot }],
			event: { type: "app_mention", channel: this.channel.id, user, text: `<@${this.bot}> ${text}`, ts: "1710000000.123456", thread_ts: "1710000000.000001" } };
	}
	send(url: string, body: string, opts: { retry?: number; stamp?: string; tamper?: boolean; command?: boolean } = {}) {
		const stamp = opts.stamp ?? String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", this.signing).update(`v0:${stamp}:${body}`).digest("hex");
		return fetch(url, { method: "POST", body: opts.tamper ? body + " " : body, headers: {
			"content-type": opts.command ? "application/x-www-form-urlencoded" : "application/json",
			"x-slack-request-timestamp": stamp, "x-slack-signature": "v0=" + signature, ...(opts.retry && { "x-slack-retry-num": String(opts.retry) }),
		} });
	}
}
