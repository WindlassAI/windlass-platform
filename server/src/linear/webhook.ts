/**
 * Linear's webhook route, `POST /linear/webhook`, and the reading of a delivery.
 *
 * What is trusted, and when. The body is read as raw bytes, at most 1 MiB, and nothing in it is looked at
 * until its HMAC-SHA256 under the app's signing secret equals `Linear-Signature` (compared in constant
 * time). Then the JSON is parsed and its `webhookTimestamp`, which the signature covers, must be within
 * a minute of now: a captured delivery cannot be replayed later. Only after both are the delivery id,
 * workspace, team and issue ids taken out, as UUIDs and nothing else. What Linear says an issue
 * contains (its title, its description) is not taken from a delivery at all: filing reads the issue.
 * https://linear.app/developers/webhooks ("Securing webhooks": `Linear-Signature`, `webhookTimestamp`,
 * `Linear-Delivery`, `Linear-Event`)
 *
 * What counts as a trigger. Linear sends the whole issue in `data` and, for an update, the previous
 * value of every field that changed in `updatedFrom`. A delivery triggers filing only by a transition:
 *
 *   assignment   the issue is created assigned to the app user, or an update changed `assigneeId` (it is
 *                a key of `updatedFrom`) to the app user from someone or no one else. Assigned to
 *                another person, or to the app user already, is not a trigger
 *   label        the issue is created with, or an update changed `labelIds` (a key of `updatedFrom`) so
 *                that it has, a label named `windlass` or `windlass:quick` that it did not have
 *
 * An edit that changes neither (a title, a state, a comment) is not a trigger, however the issue
 * stands; neither is a removed label, an unassignment, or the `remove` action. `windlass:quick` among
 * the labels the issue has at that moment selects Quick mode.
 *
 * The route knows nothing of actors: `LinearWebhookStore` is all it needs of them. The store says which
 * app user a workspace has, whether the team is mapped, and takes in what is worth filing; dedupe by
 * delivery id and by issue is the store's.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config, linearConfig, type LinearConfig } from "../config.js";
import { AddressBudget, clientAddress, MINUTE_MS, rateLimited } from "../http-limits.js";
import { isLinearId } from "./app.js";

export const LINEAR_WEBHOOK_PATH = "/linear/webhook";
/** The most a delivery's body may be. Linear's are a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** How far a delivery's signed timestamp may be from now, either way. Linear's own SDK uses a minute. */
export const MAX_TIMESTAMP_SKEW_MS = 60_000;

export const TRIGGER_LABEL = "windlass";
export const QUICK_LABEL = "windlass:quick";

/** What a qualifying delivery comes to, once authenticated: only ids, the transition, and what places it. */
export interface LinearDelivery {
	/** `Linear-Delivery`: the unit of redelivery. */
	deliveryId: string;
	workspaceId: string;
	teamId: string;
	issueId: string;
	/** `ENG-12`. */
	identifier: string;
	/** The issue's address at Linear, http(s) only; "" when the delivery had none that fits. */
	url: string;
	/** Which transitions this delivery is: gaining the label, being assigned to the app user. */
	reasons: Array<"label" | "assignment">;
	/** `windlass:quick` is among the issue's labels. */
	quick: boolean;
	/** Who made the change, as Linear says. Not a person Windlass knows: a hint, never an authorization. */
	actor: { id: string | null; type: string };
	/** The issue's creator, when the delivery says. Authorship stays untrusted. */
	creatorId: string | null;
	/** The delivery's signed timestamp, ms since the epoch. */
	sentAt: number;
}

export interface LinearWorkspaceLink {
	/** The app user of the connected workspace: what an issue is assigned to. */
	appUserId: string;
	/** The team is mapped to a repository. */
	mapped: boolean;
}

/** What the route needs of the actors. */
export interface LinearWebhookStore {
	/** The connection of a workspace; null when none is connected. Called only with authenticated ids. */
	lookup(workspaceId: string, teamId: string): Promise<LinearWorkspaceLink | null>;
	/** Takes in a qualifying delivery. `duplicate` when its delivery id was seen; `busy` when it cannot now (Linear retries). */
	receive(delivery: LinearDelivery): Promise<"taken" | "duplicate" | "busy">;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const idOrNull = (value: unknown): string | null => (isLinearId(value) ? value.toLowerCase() : null);

/** Constant-time check of `Linear-Signature` (hex HMAC-SHA256 of the raw bytes) against each secret. */
export function signatureMatches(bytes: Uint8Array, signature: string, secrets: readonly string[]): boolean {
	if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
	const given = Buffer.from(signature, "hex");
	let match = false;
	for (const secret of secrets) match = timingSafeEqual(given, createHmac("sha256", secret).update(bytes).digest()) || match;
	return match;
}

/** The signature Linear would send: for the stand-in and the checks. */
export function signBody(bytes: Uint8Array | string, secret: string): string {
	return createHmac("sha256", secret).update(bytes).digest("hex");
}

export type Refusal = "stale_timestamp" | "bad_timestamp";

/** Whether the signed `webhookTimestamp` of a parsed delivery is fresh. */
export function timestampProblem(payload: unknown, now: number): Refusal | null {
	const at = record(payload).webhookTimestamp;
	if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return "bad_timestamp";
	return Math.abs(now - at) > MAX_TIMESTAMP_SKEW_MS ? "stale_timestamp" : null;
}

/** The label names of an issue's `data`, with their ids. */
function labelsOf(data: Record<string, unknown>): Array<{ id: string; name: string }> {
	const labels: Array<{ id: string; name: string }> = [];
	for (const entry of Array.isArray(data.labels) ? data.labels.slice(0, 250) : []) {
		const label = record(entry);
		const id = idOrNull(label.id);
		if (id !== null) labels.push({ id, name: text(label.name).trim().toLowerCase() });
	}
	return labels;
}

/** The ids a delivery names, once authenticated; null when it is not an issue event that names all of them. */
export function readIds(payload: unknown): { workspaceId: string; teamId: string; issueId: string } | null {
	const body = record(payload), data = record(body.data);
	if (body.type !== "Issue") return null;
	const workspaceId = idOrNull(body.organizationId);
	const teamId = idOrNull(data.teamId) ?? idOrNull(record(data.team).id);
	const issueId = idOrNull(data.id);
	return workspaceId && teamId && issueId ? { workspaceId, teamId, issueId } : null;
}

/**
 * Whether an authenticated issue event is a transition that files, and which. Null when it is not.
 * `appUserId` is the workspace's app user; any other assignee, including a person, is not the app.
 */
export function classify(payload: unknown, appUserId: string): { reasons: Array<"label" | "assignment">; quick: boolean } | null {
	const body = record(payload), data = record(body.data);
	const action = body.action;
	if (body.type !== "Issue" || (action !== "create" && action !== "update")) return null;
	const created = action === "create";
	const before = record(body.updatedFrom);
	// An update that does not say what changed is not a transition we can see.
	if (!created && Object.keys(before).length === 0) return null;
	const app = appUserId.toLowerCase();
	const reasons: Array<"label" | "assignment"> = [];

	if (idOrNull(data.assigneeId) === app) {
		const was = "assigneeId" in before ? idOrNull(before.assigneeId) : app;
		if (created || ("assigneeId" in before && was !== app)) reasons.push("assignment");
	}

	const labels = labelsOf(data);
	const wasLabelIds = Array.isArray(before.labelIds) ? new Set(before.labelIds.map(idOrNull)) : null;
	if (created || wasLabelIds !== null) {
		const gained = labels.filter((label) => (label.name === TRIGGER_LABEL || label.name === QUICK_LABEL) && (created || !wasLabelIds!.has(label.id)));
		if (gained.length > 0) reasons.push("label");
	}
	if (reasons.length === 0) return null;
	return { reasons, quick: labels.some((label) => label.name === QUICK_LABEL) };
}

/** The delivery a classified, authenticated payload comes to. */
function deliveryOf(deliveryId: string, payload: unknown, ids: { workspaceId: string; teamId: string; issueId: string }, transition: { reasons: Array<"label" | "assignment">; quick: boolean }): LinearDelivery {
	const body = record(payload), data = record(body.data), actor = record(body.actor);
	const identifier = text(data.identifier);
	const address = text(body.url) || text(data.url);
	let url = "";
	try {
		const parsed = new URL(address);
		if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username === "" && parsed.password === "" && address.length <= 500) url = parsed.toString();
	} catch {
		url = "";
	}
	return {
		deliveryId,
		...ids,
		identifier: /^[A-Za-z0-9]{1,20}-[0-9]{1,9}$/.test(identifier) ? identifier : "",
		url,
		...transition,
		actor: { id: idOrNull(actor.id), type: text(actor.type).slice(0, 30) },
		creatorId: idOrNull(data.creatorId) ?? idOrNull(record(data.creator).id),
		sentAt: record(payload).webhookTimestamp as number,
	};
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (status: number, code: string, message: string) => json(status, { code, message });

export interface LinearWebhookDeps {
	store: LinearWebhookStore;
	/** Defaults to the environment's, read per request. */
	settings?: () => Pick<LinearConfig, "app" | "webhook">;
	now?: () => number;
	/** How long the store may take before Linear is told to try again. */
	storeTimeoutMs?: number;
}

/** The route's handler. Answers null for any other path. */
export function linearWebhookRoute(deps: LinearWebhookDeps): (request: Request) => Promise<Response | null> {
	const refusals = new AddressBudget(config.httpLimits.webhookRefusals);
	let refused = 0, badSignatures = 0, throttled = 0;

	// One trailing summary even when the burst stops. Only counts are kept.
	function refuse(request: Request, status: number, code: string, message: string): Response {
		const address = clientAddress(request);
		const admission = refusals.refusal(address);
		if (refused++ === 0) setTimeout(() => {
			console.warn(`linear.webhook.refused count=${refused} bad_signature=${badSignatures} rate_limited=${throttled}`);
			refused = badSignatures = throttled = 0;
		}, MINUTE_MS).unref();
		if (code === "bad_signature") badSignatures++;
		if (admission) {
			throttled++;
			return rateLimited(admission, address === null ? "Too many refused webhook requests. Try again later." : "This address has sent too many refused webhook requests. Try again later.");
		}
		return error(status, code, message);
	}

	return async (request) => {
		if (new URL(request.url).pathname !== LINEAR_WEBHOOK_PATH) return null;
		const { app, webhook } = (deps.settings ?? linearConfig)();
		if (!app || !webhook) return error(404, "not_found", "There is no such route.");
		if (request.method !== "POST") return refuse(request, 405, "method_not_allowed", `Use POST on ${LINEAR_WEBHOOK_PATH}.`);

		const deliveryId = request.headers.get("linear-delivery") ?? "";
		const signature = request.headers.get("linear-signature") ?? "";
		if (!isLinearId(deliveryId) || !/^[0-9a-fA-F]{64}$/.test(signature)) return refuse(request, 400, "bad_headers", "Required delivery headers are missing or malformed.");
		const length = request.headers.get("content-length");
		if (length !== null && Number(length) > MAX_WEBHOOK_BYTES) return refuse(request, 413, "body_too_large", "The delivery is larger than 1 MiB.");

		let size = 0;
		const chunks: Uint8Array[] = [];
		const reader = request.body?.getReader();
		try {
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_WEBHOOK_BYTES) {
					void reader.cancel().catch(() => undefined);
					return refuse(request, 413, "body_too_large", "The delivery is larger than 1 MiB.");
				}
				chunks.push(value);
			}
		} catch {
			return refuse(request, 400, "bad_body", "The delivery body could not be read.");
		} finally {
			reader?.releaseLock();
		}
		const bytes = Buffer.concat(chunks, size);
		// The MAC of the original bytes, before any of them is decoded.
		if (!signatureMatches(bytes, signature, webhook.secrets)) return refuse(request, 401, "bad_signature", "The delivery signature is invalid.");

		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return refuse(request, 400, "bad_json", "The delivery body must be JSON.");
		}
		const stale = timestampProblem(payload, (deps.now ?? Date.now)());
		if (stale) return refuse(request, 401, stale, stale === "stale_timestamp" ? "The delivery's timestamp is too far from now." : "The delivery has no usable timestamp.");

		// Authenticated and fresh. Only now are ids taken out.
		const ids = readIds(payload);
		if (!ids) return json(202, { taken: false });
		const limit = deps.storeTimeoutMs ?? 8_000;
		try {
			const outcome = await Promise.race([
				(async () => {
					const link = await deps.store.lookup(ids.workspaceId, ids.teamId);
					if (!link || !link.mapped) return "ignored" as const;
					const transition = classify(payload, link.appUserId);
					if (!transition) return "ignored" as const;
					return deps.store.receive(deliveryOf(deliveryId, payload, ids, transition));
				})(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("store timeout")), limit).unref()),
			]);
			if (outcome === "ignored") return json(202, { taken: false });
			if (outcome !== "busy") return json(202, { taken: outcome === "duplicate" ? "duplicate" : true });
		} catch { /* A lost reply can be retried under the same delivery id. */ }
		return error(503, "store_unavailable", "The delivery could not be taken in. Try again.");
	};
}
