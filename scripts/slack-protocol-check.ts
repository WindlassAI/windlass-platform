/** Run: cd server && npx tsx ../scripts/slack-protocol-check.ts
 * Loopback OAuth and Web API; raw signed Requests go to the production routes. Only actor state and
 * dispatch are in memory. The check requires no Slack app, production credentials or external HTTP.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { format } from "node:util";
import { SlackStandin } from "./slack-standin.js";
import type { SlackDelivery } from "../server/src/slack/webhook.js";

process.env.WLP_SECRET = randomBytes(32).toString("hex");
const { slackConfig } = await import("../server/src/config.js");
const { SlackApp, SlackError } = await import("../server/src/slack/app.js");
const { slackCallbackResponse, openSlackTicket, issueSlackState, SLACK_STATE_TTL_MS } = await import("../server/src/slack/connect.js");
const hook = await import("../server/src/slack/webhook.js");
const slack = await SlackStandin.start();
const origin = "http://localhost:5193";
const output: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
for (const level of Object.keys(original) as (keyof typeof original)[]) console[level] = (...args) => { output.push(format(...args)); };
async function section(name: string, run: () => Promise<void> | void) {
	await run();
	process.stdout.write(`ok  ${name}\n`);
}

try {
	const settings = slackConfig(slack.env)!;
	const app = new SlackApp(settings);
	const privateValues = [slack.clientSecret, slack.signingSecret];
	await section("configuration: complete credentials required, secrets hidden, HTTPS or loopback only", () => {
		assert.equal(slackConfig({}), null);
		for (const field of ["WLP_SLACK_CLIENT_ID", "WLP_SLACK_CLIENT_SECRET", "WLP_SLACK_SIGNING_SECRET"]) assert.equal(slackConfig({ ...slack.env, [field]: "" }), null);
		for (const url of ["http://slack.example/api", "https://user@example.test/api", "https://example.test/api?token=bad"]) assert.throws(() => slackConfig({ ...slack.env, WLP_SLACK_API_URL: url }));
		output.push(JSON.stringify(settings), format("%o", Object.entries(settings)));
	});

	const pending = new Set<string>(); // Only the owner's store has pending nonces in this check.
	let claims = 0;
	const deps = { app, origins: [origin], redirectUri: slack.redirectUri, store: { async claim(uid: string, nonce: string) {
		claims++;
		return uid === "owner" && pending.delete(nonce);
	} } };
	function begin(from = origin, now = Date.now(), nonce: string = randomUUID()) {
		pending.add(nonce);
		return app.authorizeUrl(issueSlackState("owner", nonce, from, now), slack.redirectUri);
	}
	async function callback(url: string) {
		const response = await slackCallbackResponse(new Request(url), deps);
		assert.equal(response.status, 302);
		const location = response.headers.get("location")!;
		output.push(location, await response.text());
		const landing = new URL(location);
		assert.equal(landing.origin + landing.pathname + landing.search, `${origin}/settings`);
		return landing.hash;
	}
	let botToken = "";
	await section("OAuth v2: bot scopes, workspace and installer, sealed owner-bound callback", async () => {
		const expectedNonce = randomUUID();
		const url = new URL(begin(origin, Date.now(), expectedNonce));
		assert.equal(url.origin + url.pathname, settings.authorizeUrl);
		assert.deepEqual(new Set(url.searchParams.get("scope")!.split(",")), new Set(["app_mentions:read", "commands", "chat:write", "channels:read", "groups:read"]));
		assert.equal(url.searchParams.has("user_scope"), false);
		output.push(url.href);
		const returned = await slack.authorize(url.href);
		const code = new URL(returned).searchParams.get("code")!;
		privateValues.push(code);
		const fragment = await callback(returned);
		assert.match(fragment, /^#slack=wlps1\./);
		const ticket = fragment.slice(7);
		assert.throws(() => openSlackTicket("other", ticket));
		const { install, nonce } = openSlackTicket("owner", ticket);
		assert.equal(nonce, expectedNonce);
		botToken = install.accessToken;
		assert.ok(slack.tokens.has(botToken));
		assert.equal(install.teamId, slack.team.id);
		assert.equal(install.teamName, slack.team.name);
		assert.equal(install.botUserId, slack.botUserId);
		assert.equal(install.installerId, slack.installerId);
		assert.equal(await callback(returned), "#slack-error=used");
		await assert.rejects(app.exchangeCode(code, slack.redirectUri), (err: unknown) => err instanceof SlackError && err.code === "invalid_code");
	});
	await section("OAuth refuses forged and expired states, invalid origins, denial replay, wrong code, user grant and missing scope", async () => {
		const before = slack.calls.length, claimsBefore = claims;
		assert.equal(await callback(`${slack.redirectUri}?state=invented&code=x`), "#slack-error=state");
		assert.equal(await callback(`${slack.redirectUri}?code=x`), "#slack-error=state");
		assert.equal(slack.calls.length, before);
		const expiredNonce = randomUUID();
		const expired = await slack.authorize(begin(origin, Date.now() - SLACK_STATE_TTL_MS - 1, expiredNonce));
		const afterAuthorization = slack.calls.length;
		assert.equal(await callback(expired), "#slack-error=state");
		assert.equal(claims, claimsBefore, "invalid or expired state reached the nonce store");
		assert.ok(pending.has(expiredNonce));
		assert.equal(slack.calls.length, afterAuthorization, "expired state reached token exchange");
		assert.equal(await callback(await slack.authorize(begin("https://untrusted.test"))), "#slack-error=state");
		slack.decline = true;
		const denied = await slack.authorize(begin());
		const afterDenial = slack.calls.length;
		assert.equal(await callback(denied), "#slack-error=denied");
		assert.equal(await callback(denied), "#slack-error=used");
		assert.equal(slack.calls.length, afterDenial);
		slack.decline = false;
		const wrong = new URL(await slack.authorize(begin()));
		wrong.searchParams.set("code", "wrong");
		assert.equal(await callback(wrong.href), "#slack-error=code");
		slack.identityTeamId = "TDIFFERENT";
		assert.equal(await callback(await slack.authorize(begin())), "#slack-error=not_bot");
		slack.identityTeamId = slack.team.id;
		slack.tokenType = "user";
		assert.equal(await callback(await slack.authorize(begin())), "#slack-error=not_bot");
		slack.tokenType = "bot";
		slack.grantScopes = ["commands"];
		assert.equal(await callback(await slack.authorize(begin())), "#slack-error=scope");
		slack.grantScopes = null;
		const req = new Request(slack.redirectUri, { method: "POST" });
		assert.equal((await slackCallbackResponse(req, deps)).status, 405);
		assert.equal((await slackCallbackResponse(req, { ...deps, app: null })).status, 404);
	});
	privateValues.push(...slack.tokens);
	await section("conversations.info accepts visible public/private channels, not archived, unjoined, missing or direct messages", async () => {
		for (const { id, name } of slack.channels.slice(0, 2)) assert.deepEqual(await app.channel(botToken, id), { id, name });
		for (const id of [...slack.channels.slice(2).map(c => c.id), "CMISSING", "DDIRECT"]) assert.equal(await app.channel(botToken, id), null);
	});
	await section("chat.postMessage records channel, new parent and threaded reply; limits and revoked bot refused", async () => {
		await app.postEphemeral(botToken, slack.channelId, slack.installerId, "Private link");
		assert.deepEqual(slack.ephemeral, [{ channel: slack.channelId, user: slack.installerId, text: "Private link" }]);
		const parent = await app.postMessage(botToken, slack.channelId, "Accepted");
		const reply = await app.postMessage(botToken, slack.channelId, "Finished", parent);
		assert.deepEqual(slack.messages, [{ channel: slack.channelId, ts: parent, text: "Accepted" }, { channel: slack.channelId, ts: reply, thread_ts: parent, text: "Finished" }]);
		slack.rateLimited = true;
		const before = Date.now();
		await assert.rejects(app.postMessage(botToken, slack.channelId, "retry"), (err: unknown) => err instanceof SlackError && err.rateLimited && err.retryAt >= before + 3000);
		slack.rateLimited = false;
		await app.revoke(botToken);
		await assert.rejects(app.postMessage(botToken, slack.channelId, "after revoke"), (err: unknown) => err instanceof SlackError && err.unauthorized);
		assert.equal(slack.messages.length, 2);
	});

	const events = origin + hook.SLACK_EVENTS_PATH, commands = origin + hook.SLACK_COMMANDS_PATH;
	const formType = "application/x-www-form-urlencoded";
	const received: SlackDelivery[] = [];
	const seen = new Set<string>();
	let configured = true, available = true;
	const route = hook.slackWebhookRoute({ settings: () => configured ? settings : null, async dispatch(delivery) {
		received.push(delivery);
		if (!available) throw new Error("actor unavailable");
		if (seen.has(delivery.deliveryId)) return "duplicate";
		seen.add(delivery.deliveryId);
		return "taken";
	} });
	async function send(req: Request, status: number) {
		const answer = await route(req);
		assert.equal(answer?.status, status);
		const body = await answer!.text();
		output.push(body);
		return body;
	}
	const mention = slack.mention();
	const json = (obj: unknown) => slack.request(events, JSON.stringify(obj));
	await section("signed challenge, threaded mention and slash command, stable retry keys, no response URL or trigger forwarded", async () => {
		const challenge = { type: "url_verification", challenge: "wlp-verify-me" };
		assert.deepEqual(JSON.parse(await send(json(challenge), 200)), { challenge: challenge.challenge });
		assert.equal(received.length, 0);
		const signedMention = json(mention);
		const sentAt = Number(signedMention.headers.get("x-slack-request-timestamp")) * 1000;
		await send(signedMention, 200);
		const delivered = received[0];
		assert.deepEqual(delivered, { kind: "app_mention", userId: slack.installerId, teamId: slack.team.id, channelId: slack.channelId, text: "fix café",
			deliveryId: mention.event_id, threadTs: mention.event.thread_ts, messageTs: mention.event.ts, sentAt });
		await send(slack.request(events, JSON.stringify(mention), "application/json", { headers: { "x-slack-retry-num": "1" } }), 200);
		assert.equal(received[1].deliveryId, delivered.deliveryId);
		const form = slack.command();
		privateValues.push(form.get("response_url")!, form.get("trigger_id")!);
		await send(slack.request(commands, form.toString(), formType), 200);
		const command = received[2];
		assert.deepEqual(command, { kind: "command", teamId: slack.team.id, userId: slack.installerId, channelId: slack.channelId, deliveryId: command.deliveryId, text: form.get("text"), threadTs: null, messageTs: null, sentAt: command.sentAt });
		await send(slack.request(commands, form.toString(), formType, { timestamp: String(Math.floor(Date.now() / 1000) + 1) }), 200);
		assert.equal(received[3].deliveryId, command.deliveryId);
		await send(slack.request(commands, slack.command().toString(), formType), 200);
		assert.notEqual(received[4].deliveryId, command.deliveryId);
		assert.equal(seen.size, 3);
		const root = slack.mention();
		await send(json({ ...root, event: { ...root.event, thread_ts: undefined } }), 200);
		assert.equal(received.at(-1)?.threadTs, root.event.ts);
		form.set("thread_ts", root.event.ts);
		await send(slack.request(commands, form.toString(), formType), 200);
		assert.equal(received.at(-1)?.threadTs, root.event.ts);
		output.push(JSON.stringify(received));
	});
	await section("unsigned, wrong, altered, stale, future, malformed, oversized and wrong-type requests never dispatch", async () => {
		const before = received.length;
		const body = JSON.stringify(mention), stamp = Math.floor(Date.now() / 1000);
		for (const opts of [{ omit: "x-slack-signature" }, { omit: "x-slack-request-timestamp" }, { secret: "other-app" }, { sentBody: `${body} ` }, { timestamp: `${stamp - 301}` }, { timestamp: `${stamp + 302}` }, { timestamp: "n/a" }, { headers: { "x-slack-signature": "v1=0" } }]) {
			await send(slack.request(events, body, "application/json", opts), 401);
		}
		await send(slack.request(events, "{"), 400);
		await send(json({ type: "url_verification", challenge: {} }), 400);
		await send(slack.request(events, "x".repeat(hook.MAX_WEBHOOK_BYTES + 1)), 413);
		await send(slack.request(commands, body), 415);
		const form = slack.command();
		const raw = form.toString();
		await send(slack.request(commands, raw, formType, { omit: "x-slack-signature" }), 401);
		await send(slack.request(commands, raw, formType, { timestamp: `${stamp - 301}` }), 401);
		await send(slack.request(commands, raw, formType, { sentBody: raw.replaceAll("+", "%20") }), 401);
		await send(slack.request(commands, raw + "&team_id=TOTHER", formType), 400);
		form.set("command", "/other");
		await send(slack.request(commands, form.toString(), formType), 400);
		await send(new Request(events), 405);
		configured = false;
		await send(json(mention), 404);
		await send(slack.request(commands, raw, formType), 404);
		configured = true;
		assert.equal(received.length, before);
	});
	await section("unrelated events and bot messages ignored; dispatch outage requests redelivery", async () => {
		const before = received.length;
		for (const patch of [{ type: "message" }, { subtype: "message_changed" }, { bot_id: "B12345678" }, { user: slack.botUserId }, { user: "" }, { channel: "DDIRECT" }, { channel_type: "mpim" }]) await send(json({ ...mention, event: { ...mention.event, ...patch } }), 200);
		assert.equal(received.length, before);
		available = false;
		const retry = slack.mention();
		await send(json(retry), 503);
		available = true;
		await send(json(retry), 200);
		assert.equal(received.at(-1)?.deliveryId, retry.event_id);
	});
	await section("command link replies stay ephemeral, never returned for an event; slow dispatch is retriable", async () => {
		const reply = hook.slackWebhookRoute({ settings: () => settings, dispatch: async () => ({ ephemeral: "Link your account" }) });
		const answer = await reply(slack.request(commands, slack.command().toString(), formType));
		assert.deepEqual(await answer?.json(), { response_type: "ephemeral", text: "Link your account" });
		assert.equal(await (await reply(json(mention)))?.text(), "");
		const slow = hook.slackWebhookRoute({ settings: () => settings, dispatchTimeoutMs: 5, dispatch: () => new Promise(() => {}) });
		assert.equal((await slow(json(mention)))?.status, 503);
	});
	for (const value of privateValues) assert.ok(!output.some(line => line.includes(value)), "a credential or private capability escaped the protocol boundary");
} finally {
	Object.assign(console, original);
	await slack.close();
}
process.stdout.write("slack-protocol-check: all sections passed\n");
