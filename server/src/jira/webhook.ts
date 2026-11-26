import { randomBytes } from "node:crypto";
import { jwtVerify } from "jose";
import { config, jiraClientSecret, jiraConfig } from "../config.js";
import { AddressBudget, clientAddress, rateLimited } from "../http-limits.js";

export const JIRA_WEBHOOK_PATH = "/jira/webhook";
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** Register `${JIRA_WEBHOOK_PATH}/${key}`. Never expose the key in logs or public state. */
export const newJiraWebhookKey = (): string => randomBytes(32).toString("base64url");

export interface JiraWebhookBinding {
	cloudId: string;
	/** Canonical site URL from accessible-resources, not from the incoming event. */
	siteUrl: string;
	/** Only current registration IDs returned by Jira for THIS callback and site. */
	webhookIds: readonly number[];
}

export interface JiraDelivery {
	cloudId: string;
	projectId: string;
	issueId: string;
	/** Unique only within cloudId. Stable across retries. */
	deliveryId: string;
	matchedWebhookIds: number[];
	label: boolean;
	assignedTo: string | null;
	actorId: string | null;
	sentAt: number;
}
export type JiraDispatch = "taken" | "duplicate" | "ignored";
export interface JiraWebhookDeps {
	/** Resolve the opaque callback key in active server-side registrations. Never use the request body to select the tenant. */
	resolve(key: string): Promise<JiraWebhookBinding | null>;
	/** Recheck binding, mapping and current issue. Durably deduplicate on (cloudId, deliveryId) before acknowledging. */
	dispatch(delivery: JiraDelivery): Promise<JiraDispatch>;
	settings?: () => { clientId: string; clientSecret: string } | null;
	now?: () => number;
	dispatchTimeoutMs?: number;
}

const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const account = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : null;
const numericId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,31}$/.test(v);
const normalized = (label: string) => label.trim().toLowerCase();
export function isTriggerLabel(label: string): boolean {
	return ["windlass", "windlass-quick"].includes(normalized(label));
}

/** Changelog label values are space-separated names, unlike fields.labels (an array). */
export function classify(payload: unknown): Pick<JiraDelivery, "label" | "assignedTo"> | null {
	const body = obj(payload), fields = obj(obj(body.issue).fields);
	const labels = new Set<string>();
	for (const value of Array.isArray(fields.labels) ? fields.labels : []) {
		if (typeof value === "string" && isTriggerLabel(value)) labels.add(normalized(value));
	}
	const assignee = account(obj(fields.assignee).accountId);
	let label = false, assignedTo: string | null = null;
	if (body.webhookEvent === "jira:issue_created") {
		label = labels.size > 0;
		assignedTo = assignee;
	} else if (body.webhookEvent === "jira:issue_updated") {
		const items = obj(body.changelog).items;
		if (!Array.isArray(items)) return null;
		for (const value of items) {
			const item = obj(value), field = item.fieldId ?? item.field;
			if (item.fieldtype !== undefined && item.fieldtype !== "jira") continue;
			const after: unknown = item["toString"];
			if (field === "labels" && (item.fromString === null || typeof item.fromString === "string") && typeof after === "string") {
				const before = new Set((item.fromString ?? "").toLowerCase().split(/\s+/));
				label ||= after.toLowerCase().split(/\s+/).some(l => labels.has(l) && !before.has(l));
			}
			if (field === "assignee" && assignee && item.to === assignee && (item.from === null || account(item.from)) && item.from !== assignee) assignedTo = assignee;
		}
	}
	return label || assignedTo ? { label, assignedTo } : null;
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
function settings() {
	const app = jiraConfig().app, clientSecret = jiraClientSecret();
	return app && clientSecret ? { clientId: app.clientId, clientSecret } : null;
}

/** https://developer.atlassian.com/cloud/jira/platform/webhooks/#webhooks-authentication-for-oauth-2-0-apps
 * This is a client-secret-signed bearer JWT, not Connect QSH or a MAC of the raw body. The docs don't
 * promise a tenant claim. The registration-specific callback and matchedWebhookIds bind the delivery.
 */
export function jiraWebhookRoute(deps: JiraWebhookDeps): (request: Request) => Promise<Response | null> {
	const budget = new AddressBudget(config.httpLimits.webhookRefusals);
	return async request => {
		const path = new URL(request.url).pathname;
		if (path !== JIRA_WEBHOOK_PATH && !path.startsWith(`${JIRA_WEBHOOK_PATH}/`)) return null;
		const refuse = (status: number, code: string) => {
			const retry = budget.refusal(clientAddress(request));
			return retry ? rateLimited(retry, "Too many refused webhook requests.") : json(status, { code });
		};
		const app = (deps.settings ?? settings)();
		if (!app) return json(404, { code: "not_found" });
		if (request.method !== "POST") return refuse(405, "method_not_allowed");
		const key = path.slice(JIRA_WEBHOOK_PATH.length + 1);
		if (!/^[\w-]{43}$/.test(key)) return refuse(404, "not_found");
		const auth = request.headers.get("authorization") ?? "";
		const match = auth.length <= 8192 && /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(auth);
		if (!match) return refuse(401, "bad_token");
		const now = (deps.now ?? Date.now)();
		try {
			const { payload } = await jwtVerify(match[1], new TextEncoder().encode(app.clientSecret), {
				algorithms: ["HS256"], requiredClaims: ["exp"], currentDate: new Date(now),
			});
			if (payload.aud !== undefined && !(Array.isArray(payload.aud) ? payload.aud.includes(app.clientId) : payload.aud === app.clientId)) return refuse(401, "bad_token");
			if (payload.iat !== undefined && payload.iat > now / 1000 + 60) return refuse(401, "bad_token");
		} catch { return refuse(401, "bad_token"); }
		const deliveryId = request.headers.get("x-atlassian-webhook-identifier") ?? "";
		if (!/^[\w.:-]{1,256}$/.test(deliveryId)) return refuse(400, "bad_identifier");
		if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES) return refuse(413, "body_too_large");
		const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
		let body: Record<string, unknown>, size = 0;
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
			body = obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))));
		} catch { return refuse(400, "bad_json"); } finally { reader?.releaseLock(); }
		const issue = obj(body.issue), projectId = obj(obj(issue.fields).project).id, issueId = issue.id;
		const transition = classify(body), ids = body.matchedWebhookIds, sentAt = body.timestamp;
		if (!transition || !numericId(projectId) || !numericId(issueId) || !Array.isArray(ids) || typeof sentAt !== "number" || !Number.isSafeInteger(sentAt) || sentAt <= 0) return json(202, { taken: false });
		let timer: NodeJS.Timeout | undefined;
		try {
			const run = async (): Promise<JiraDispatch> => {
				const binding = await deps.resolve(key);
				if (!binding) return "ignored";
				// Some issue payloads include a self URL. Never follow it or let it contradict the registration.
				if (issue.self !== undefined) {
					const self = typeof issue.self === "string" ? URL.parse(issue.self) : null;
					const gateway = `https://api.atlassian.com/ex/jira/${encodeURIComponent(binding.cloudId)}/`;
					if (!self || !(self.origin === new URL(binding.siteUrl).origin || self.href.startsWith(gateway))) return "ignored";
				}
				const matchedWebhookIds = binding.webhookIds.filter(id => ids.includes(id));
				if (!matchedWebhookIds.length) return "ignored";
				return deps.dispatch({ cloudId: binding.cloudId, projectId, issueId, matchedWebhookIds, deliveryId, sentAt, actorId: account(obj(body.user).accountId), ...transition });
			};
			const result = await Promise.race([run(), new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("dispatch timeout")), deps.dispatchTimeoutMs ?? 8000).unref();
			})]);
			return json(202, { taken: result === "duplicate" ? "duplicate" : result === "taken" });
		} catch { return json(503, { code: "unavailable" }); } finally { clearTimeout(timer); }
	};
}
