import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config, slackConfig } from "../config.js";
import { AddressBudget, clientAddress, rateLimited } from "../http-limits.js";

export const SLACK_EVENTS_PATH = "/slack/events";
export const SLACK_COMMANDS_PATH = "/slack/commands";

/** Authenticated third-party input. Never forward Slack tokens, response URLs or the whole envelope. */
export interface SlackDelivery {
	kind: "app_mention" | "command";
	/** Idempotency key within teamId: Slack event ID, or a digest of the private slash trigger. */
	deliveryId: string;
	teamId: string;
	channelId: string;
	userId: string;
	text: string;
	messageTs: string | null;
	threadTs: string | null;
	sentAt: number;
}

/** Only slash commands may receive private text in their synchronous HTTP response. */
export type SlackDispatch = "taken" | "duplicate" | "ignored" | { ephemeral: string };
export interface SlackWebhookDeps {
	dispatch(delivery: SlackDelivery): Promise<SlackDispatch>;
	/** Read per request; null disables both routes. */
	settings?: () => { signingSecret: string } | null;
	now?: () => number;
	dispatchTimeoutMs?: number;
}

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
export const MAX_TIMESTAMP_SKEW_MS = 5 * 60_000;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const ack = () => new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{2,128}$/.test(v);
const channel = (v: unknown): v is string => id(v) && /^[CG]/.test(v);
const MAX_TEXT = 4_000;
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{1,16}\.\d{1,6}$/.test(v);

/** Hash the original bytes, not a decoded/re-encoded form or JSON document. */
export function signBody(bytes: Uint8Array | string, timestampSeconds: string, secret: string): string {
	return "v0=" + createHmac("sha256", secret).update(`v0:${timestampSeconds}:`).update(bytes).digest("hex");
}

function eventDelivery(body: Record<string, unknown>, sentAt: number): SlackDelivery | null {
	const e = record(body.event);
	if (body.type !== "event_callback" || e.type !== "app_mention" || e.bot_id || e.bot_profile || e.subtype || e.hidden) return null;
	if (!id(body.team_id) || !id(body.event_id) || !channel(e.channel) || e.channel_type === "im" || e.channel_type === "mpim" || !id(e.user) || !timestamp(e.ts) || typeof e.text !== "string") return null;
	if (e.thread_ts != null && !timestamp(e.thread_ts)) return null;
	const bots = new Set((Array.isArray(body.authorizations) ? body.authorizations : []).map(record)
		.filter(a => a.is_bot === true && id(a.user_id)).map(a => a.user_id));
	if (bots.has(e.user)) return null;
	let text = e.text.trim();
	const recipient = /^<@([A-Z0-9]+)(?:\|[^>]+)?>\s*/.exec(text);
	if (recipient && bots.has(recipient[1])) text = text.slice(recipient[0].length);
	return { kind: "app_mention", deliveryId: body.event_id, teamId: body.team_id, channelId: e.channel, userId: e.user,
		text: text.slice(0, MAX_TEXT), messageTs: e.ts, threadTs: e.thread_ts ?? e.ts, sentAt };
}

function commandDelivery(form: URLSearchParams, sentAt: number): SlackDelivery | null {
	// Never persist the trigger capability itself. Hash it to recognize retries independently of signature time.
	const single = (k: string) => form.getAll(k).length === 1 ? form.get(k) : null;
	const teamId = single("team_id"), channelId = single("channel_id"), userId = single("user_id");
	const trigger = single("trigger_id"), text = single("text");
	if (single("command") !== "/windlass" || !id(teamId) || !channel(channelId) || single("channel_name") === "directmessage" || !id(userId) || text === null || !trigger || trigger.length > 512) return null;
	const thread = single("thread_ts");
	if (form.has("thread_ts") && !timestamp(thread)) return null;
	const deliveryId = "command:" + createHash("sha256").update(trigger).digest("hex");
	return { kind: "command", teamId, channelId, userId, deliveryId, text: text.trim().slice(0, MAX_TEXT), messageTs: null, threadTs: thread, sentAt };
}

export function slackWebhookRoute(deps: SlackWebhookDeps): (request: Request) => Promise<Response | null> {
	const refusals = new AddressBudget(config.httpLimits.webhookRefusals);
	return async request => {
		const path = new URL(request.url).pathname;
		if (path !== SLACK_EVENTS_PATH && path !== SLACK_COMMANDS_PATH) return null;
		const settings = (deps.settings ?? slackConfig)();
		if (!settings?.signingSecret) return json(404, { code: "not_found" });
		const refuse = (status: number, code: string) => {
			const seconds = refusals.refusal(clientAddress(request));
			return seconds ? rateLimited(seconds, "Too many refused webhook requests.") : json(status, { code });
		};
		if (request.method !== "POST") return refuse(405, "method_not_allowed");
		const stamp = request.headers.get("x-slack-request-timestamp") ?? "", signature = request.headers.get("x-slack-signature") ?? "";
		if (!/^\d{1,12}$/.test(stamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return refuse(401, "bad_headers");
		if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES) return refuse(413, "body_too_large");

		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = request.body?.getReader();
		try {
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_WEBHOOK_BYTES) {
					void reader.cancel().catch(() => undefined);
					return refuse(413, "body_too_large");
				}
				chunks.push(value);
			}
		} catch { return refuse(400, "bad_body"); }
		finally { reader?.releaseLock(); }
		const bytes = Buffer.concat(chunks, size);
		const expected = signBody(bytes, stamp, settings.signingSecret);
		if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return refuse(401, "bad_signature");
		const sentAt = Number(stamp) * 1000;
		if (Math.abs((deps.now ?? Date.now)() - sentAt) > MAX_TIMESTAMP_SKEW_MS) return refuse(401, "stale_timestamp");

		const events = path === SLACK_EVENTS_PATH;
		const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
		if (mediaType !== (events ? "application/json" : "application/x-www-form-urlencoded")) return refuse(415, "bad_content_type");
		let delivery: SlackDelivery | null;
		try {
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (events) {
				const body = record(JSON.parse(raw));
				if (body.type === "url_verification") {
					return typeof body.challenge === "string" && body.challenge.length > 0 && body.challenge.length <= 4096
						? json(200, { challenge: body.challenge }) : refuse(400, "bad_challenge");
				}
				delivery = eventDelivery(body, sentAt);
			} else {
				delivery = commandDelivery(new URLSearchParams(raw), sentAt);
				if (!delivery) return refuse(400, "bad_command");
			}
		} catch { return refuse(400, "bad_body"); }
		if (!delivery) return ack();
		// A timed-out dispatch may still finish; the consumer must deduplicate by team and delivery id.
		let timer: NodeJS.Timeout | undefined;
		try {
			const outcome = await Promise.race([deps.dispatch(delivery), new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("dispatch timeout")), deps.dispatchTimeoutMs ?? 2500).unref();
			})]);
			if (!events && typeof outcome === "object") return json(200, { response_type: "ephemeral", text: outcome.ephemeral });
			return ack();
		} catch { return json(503, { code: "unavailable" }); }
		finally { clearTimeout(timer); }
	};
}
