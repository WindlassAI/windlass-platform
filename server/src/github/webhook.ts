/** The App's HTTP route. Only the trimmed, authenticated delivery crosses the actor boundary. */
import { parseGithubJson } from "./ids.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "rivetkit/client";
import { serviceParams } from "../auth.js";
import { config, githubConfig, ownEngineEndpoint } from "../config.js";
import { AddressBudget, clientAddress, MINUTE_MS, rateLimited } from "../http-limits.js";
import type { Registry } from "../registry.js";
import { edge, type Delivery } from "./events.js";

const LIMIT = 2 * 1024 * 1024;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (status: number, code: string, message: string) => json(status, { code, message });

const refusals = new AddressBudget(config.httpLimits.webhookRefusals);
let refused = 0;
let badSignatures = 0;
let throttled = 0;

// One trailing summary even when the burst stops. Keep only counts, shared by this node.
function refuse(request: Request, status: number, code: string, message: string): Response {
	const address = clientAddress(request);
	const admission = refusals.refusal(address);
	if (refused++ === 0) setTimeout(() => {
		console.warn(`github.webhook.refused count=${refused} bad_signature=${badSignatures} rate_limited=${throttled}`);
		refused = badSignatures = throttled = 0;
	}, MINUTE_MS).unref();
	if (code === "bad_signature") badSignatures++;
	if (admission) {
		throttled++;
		return rateLimited(admission, address === null ? "Too many refused webhook requests. Try again later." : "This address has sent too many refused webhook requests. Try again later.");
	}
	return error(status, code, message);
}

async function receive(delivery: Delivery) {
	const signal = AbortSignal.timeout(8_000);
	const client = createClient<Registry>({
		endpoint: ownEngineEndpoint(),
		disableMetadataLookup: true,
		fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
	});
	const options = { params: serviceParams() };
	async function admit() {
		if (delivery.event !== "installation" && delivery.event !== "installation_repositories") {
			const hooks = client.githubHooks.getOrCreate(["app"], options);
			if (!await hooks.internalLinked(delivery.installationId)) return "unlinked";
		}
		return client.githubInbox.getOrCreate([String(delivery.installationId)], options).internalReceive(delivery);
	}
	// Bound directory lookup and inbox admission together, including client retries.
	return Promise.race([
		admit(),
		new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("inbox timeout")), { once: true })),
	]);
}

export async function webhookRoute(request: Request): Promise<Response | null> {
	if (new URL(request.url).pathname !== "/github/webhook") return null;
	const { app, webhook } = githubConfig();
	if (!app || !webhook) return error(404, "not_found", "There is no such route.");
	if (request.method !== "POST") return refuse(request, 405, "method_not_allowed", "Use POST on /github/webhook.");
	// https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers
	// X-GitHub-Event: "name of the event"; X-GitHub-Delivery: "globally unique identifier (GUID)".
	// X-Hub-Signature-256: "HMAC hex digest of the request body" using SHA-256.
	const event = request.headers.get("x-github-event") ?? "";
	const guid = request.headers.get("x-github-delivery") ?? "";
	const signature = request.headers.get("x-hub-signature-256") ?? "";
	if (!/^[a-z_]{1,64}$/.test(event) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(guid) || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
		return refuse(request, 400, "bad_headers", "Required delivery headers are missing or malformed.");

	let size = 0;
	const chunks: Uint8Array[] = [];
	const reader = request.body?.getReader();
	try {
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > LIMIT) {
				void reader.cancel().catch(() => undefined);
				return refuse(request, 413, "body_too_large", "The delivery is larger than 2 MiB.");
			}
			chunks.push(value);
		}
	} catch {
		return refuse(request, 400, "bad_body", "The delivery body could not be read.");
	} finally {
		reader?.releaseLock();
	}
	const bytes = Buffer.concat(chunks, size);
	const digest = Buffer.from(signature.slice(7), "hex"); // exactly 32 bytes after the header check
	// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
	// "Never use a plain == operator." Compare the MAC of the original bytes before decoding JSON.
	if (!webhook.secrets.some(secret => timingSafeEqual(digest, createHmac("sha256", secret).update(bytes).digest()))) {
		return refuse(request, 401, "bad_signature", "The delivery signature is invalid.");
	}
	// X-GitHub-Hook-Installation-Target-ID: "unique identifier of the resource where the webhook was created" (delivery headers above).
	if (request.headers.get("x-github-hook-installation-target-id") !== app.appId)
		return refuse(request, 403, "wrong_app", "The delivery is for a different App.");
	let payload: unknown;
	try {
		payload = parseGithubJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return refuse(request, 400, "bad_json", "The delivery body must be JSON.");
	}
	const delivery = edge(event, payload, { slug: app.slug, appId: app.appId, guid, at: Date.now() });
	if (!delivery) {
		if (event === "ping") console.log(`github.webhook.ping delivery=${guid}`);
		return json(202, { taken: false });
	}
	try {
		const result = await receive(delivery);
		if (result === "unlinked") return json(202, { taken: false });
		if (result !== "busy") return json(202, { taken: result === "duplicate" ? "duplicate" : true });
	} catch { /* A lost reply can be retried under the same GUID. */ }
	return error(503, "inbox_unavailable", "The inbox could not take the delivery. Try again.");
}
