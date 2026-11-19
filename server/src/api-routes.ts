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
import { bearerOf, tokenOwner } from "./api-tokens.js";
import { describeError } from "./auth.js";
import { ownEngineEndpoint } from "./config.js";
import type { CreateItemInput } from "./contract.js";
import type { Registry } from "./registry.js";
import { issueServiceToken } from "./tokens.js";

export const API_ITEMS_PATH = "/api/items";
/** The largest body taken: an item's text and criteria at their limits, with room. */
const MAX_BODY_BYTES = 128 * 1024;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS: Record<string, number> = {
	invalid_token: 401,
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
	if (pathname !== API_ITEMS_PATH && !one) return pathname.startsWith("/api/") ? json(404, { code: "not_found", message: "There is no such route." }) : null;
	const token = bearerOf(request) ?? "";
	const owner = tokenOwner(token);
	if (!owner) return json(401, { code: "invalid_token", message: "Send an API token: Authorization: Bearer wlp_…" });
	const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
	// The user actor takes these calls from this route alone, with the caller's token beside them.
	const user = client.user.get([owner.uid], { params: { token: issueServiceToken("api") } });
	try {
		if (pathname === API_ITEMS_PATH && request.method === "POST") {
			const body = await readJson(request);
			if (body instanceof Response) return body;
			const given = (typeof body.value === "object" && body.value !== null ? body.value : {}) as Record<string, unknown>;
			const key = request.headers.get("idempotency-key");
			const item = { ...given, idempotencyKey: key === null ? undefined : key } as CreateItemInput;
			return json(201, await user.internalApiCreateItem({ token, item }));
		}
		if (one && request.method === "GET") return json(200, await user.internalApiItem({ token, id: one[1] }));
		return json(405, { code: "method_not_allowed", message: "Use POST on /api/items and GET on /api/items/<id>." });
	} catch (error) {
		const { code, message } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
		// A UserError of the user's actor says what is wrong in its words; an error of the engine's own (group "actor") does not.
		if (typeof code === "string" && code !== "internal_error" && typeof message === "string" && (error as { group?: unknown }).group !== "actor") return json(STATUS[code] ?? 400, { code, message });
		// The user's actor was never reached, or failed: nothing of the token or the body is said.
		console.error(`[wlp] api.failed path=${pathname}: ${describeError(error)}`);
		return json(500, { code: "internal_error", message: "The request could not be handled. Try again." });
	}
}
