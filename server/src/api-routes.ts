/**
 * The platform's HTTP API for scripts (Plans "software factory", slice 1), authorised by a user's API
 * token (api-tokens.ts) and nothing else:
 *
 *   POST /api/items         files a work item: the body is `CreateItemInput` as JSON, without
 *                           `idempotencyKey`; the `Idempotency-Key` header is the creation's key, so
 *                           the same request sent again answers with the item it made, and the same
 *                           key with another body is refused (409, `idempotency_key_reused`).
 *                           Answers 201 with the `ItemSummary`. Needs the scope `items:create`.
 *   GET /api/items/<id>     the item's page, `ItemView`. Needs the scope `items:read`.
 *
 * The token names its user, whose `user` actor decides everything: whether the token is good, and
 * the item. Errors answer `{ code, message }` with the code of the contract's actions.
 */

import { createClient } from "rivetkit/client";
import { isActorGone } from "./actors/internal.js";
import { bearerOf, tokenOwner } from "./api-tokens.js";
import { describeError } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import type { CreateItemInput } from "./contract.js";
import type { Registry } from "./registry.js";
import { AddressBudget, clientAddress, rateLimited } from "./http-limits.js";
import { issueServiceToken } from "./tokens.js";

const requests = new AddressBudget(config.httpLimits.apiAddress);
const failures = new AddressBudget(config.httpLimits.apiFailures);
export const API_ITEMS_PATH = "/api/items";
/** The largest body taken: an item's text and criteria at their limits, with room. */
const MAX_BODY_BYTES = 128 * 1024;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS: Record<string, number> = {
	invalid_token: 401,
	missing_scope: 403,
	item_not_found: 404,
	idempotency_key_reused: 409,
	item_conflict: 409,
	too_many_tokens: 409,
};

async function readJson(request: Request): Promise<{ value: unknown } | Response> {
	const text = await request.text().catch(() => null);
	if (text === null) return json(400, { code: "bad_input", message: "The body could not be read." });
	if (Buffer.byteLength(text) > MAX_BODY_BYTES) return json(413, { code: "body_too_large", message: `The body is larger than ${MAX_BODY_BYTES} bytes.` });
	try {
		return { value: JSON.parse(text) };
	} catch {
		return json(400, { code: "bad_input", message: "The body is not JSON." });
	}
}

/** The answer to a request under /api/, or null for any other path. */
export async function apiRoute(request: Request): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	const one = /^\/api\/items\/([A-Za-z0-9_]{1,64})$/.exec(pathname);
	const attachment = /^\/api\/items\/([A-Za-z0-9_]{1,64})\/attachments\/(a_[a-f0-9]{16})$/.exec(pathname);
	// Without work items on this deployment (WLP_ITEMS) these are unknown routes too, decided before any token is read.
	if (!config.items || (pathname !== API_ITEMS_PATH && !one && !attachment)) return pathname.startsWith("/api/") ? json(404, { code: "not_found", message: "There is no such route." }) : null;
	const address = clientAddress(request);
	const admission = requests.take(address);
	if (admission) return rateLimited(admission, "This address has reached its items API request limit.");
	// Reserve before looking up a user. Concurrent slow misses must fit in the same budget.
	const lookup = await failures.lookup(address);
	if (typeof lookup === "number") return rateLimited(lookup, "This address has reached its token lookup limit. Try again later.");
	const token = bearerOf(request) ?? "";
	const owner = tokenOwner(token);
	if (!owner) {
		lookup(true);
		return json(401, { code: "invalid_token", message: "Send an API token: Authorization: Bearer wlp_…" });
	}
	let invalid = false;
	try {
		const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
		// The user actor takes these calls from this route alone, with the caller's token beside them.
		const user = client.user.get([owner.uid], { params: { token: issueServiceToken("api") } });
		if (pathname === API_ITEMS_PATH && request.method === "POST") {
			const body = await readJson(request);
			if (body instanceof Response) return body;
			const given = (typeof body.value === "object" && body.value !== null ? body.value : {}) as Record<string, unknown>;
			const key = request.headers.get("idempotency-key");
			const item = { ...given, idempotencyKey: key === null ? undefined : key } as CreateItemInput;
			return json(201, await user.internalApiCreateItem({ token, item }));
		}
		if (attachment && request.method === "GET") {
			const location = await user.internalApiItemAttachment({ token, id: attachment[1], attachment: attachment[2] });
			return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
		}
		if (one && request.method === "GET") return json(200, await user.internalApiItem({ token, id: one[1] }));
		return json(405, { code: "method_not_allowed", message: "Use POST on /api/items and GET on /api/items/<id>." });
	} catch (error) {
		// A token that names a user with no actor is a token that is not valid: the same answer as any other, and nothing logged.
		if (isActorGone(error)) {
			invalid = true;
			return json(401, { code: "invalid_token", message: "That API token is not valid, or may not do this." });
		}
		const { code, message } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
		invalid = code === "invalid_token";
		if (code === "token_rate_limited" && typeof message === "string") {
			const { metadata } = error as { metadata?: { retryAfter?: number } };
			return rateLimited(metadata?.retryAfter ?? 60, message, code);
		}
		// A UserError of the user's actor says what is wrong in its words; an error of the engine's own (group "actor") does not.
		if (typeof code === "string" && code !== "internal_error" && typeof message === "string" && (error as { group?: unknown }).group !== "actor") return json(STATUS[code] ?? 400, { code, message });
		// The user's actor was never reached, or failed: nothing of the token or the body is said.
		console.error(`[wlp] api.failed path=${pathname}: ${attachment ? "attachment request failed" : describeError(error)}`);
		return json(500, { code: "internal_error", message: "The request could not be handled. Try again." });
	} finally {
		lookup(invalid);
	}
}
