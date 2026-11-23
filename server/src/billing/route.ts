/**
 * POST /billing/webhook: where the payment provider sends its webhooks. The signature is verified before anything is
 * read (billing/standard-webhooks.ts); each event is then applied by its account's `user` actor, which applies a
 * delivery once (billing/account.ts). Answered 2xx once every event is applied, ignored or not ours, so the provider
 * stops retrying; 5xx where an actor could not be reached, so that it retries. Without billing the path is not found.
 *
 * The log has the delivery's id, its type and the account's and provider's ids, and nothing else of the payload.
 */

import { createClient } from "rivetkit/client";
import { isActorGone } from "../actors/internal.js";
import { ownEngineEndpoint } from "../config.js";
import type { Registry } from "../registry.js";
import { issueServiceToken } from "../tokens.js";
import { customerDirectory } from "./customer-index.js";
import { billing } from "./config.js";

export const BILLING_WEBHOOK_PATH = "/billing/webhook";
const MAX_BODY_BYTES = 256 * 1024;
const UID = /^u_[A-Za-z0-9_-]{1,62}$/;

const answer = (status: number, text: string) => new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Resolve verified deliveries using the durable customer owner, with metadata for older checkouts. */
export function webhookOwner(owner: string | null, metadata: string | null): string | null {
	if (owner !== null && metadata !== null && owner !== metadata) return null;
	const uid = owner ?? metadata;
	return uid !== null && UID.test(uid) ? uid : null;
}

export async function billingWebhookRoute(request: Request): Promise<Response> {
	const settings = billing();
	if (settings === null) return answer(404, "Not found");
	if (request.method !== "POST") return answer(405, "Use POST.");
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES) return answer(413, "Too large.");
	const body = await request.text().catch(() => null);
	if (body === null || Buffer.byteLength(body) > MAX_BODY_BYTES) return answer(400, "The body could not be read.");
	const events = settings.provider.parseWebhook(request.headers, body, Date.now());
	if (events === null) {
		console.warn("[wlp] billing.webhook_refused: the signature did not verify, or the delivery is too old");
		return answer(401, "The signature does not verify.");
	}
	const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
	try {
		for (const event of events) {
			const ids = `id=${event.id} type=${event.type} customer=${event.customerId ?? "-"} subscription=${event.subscriptionId ?? "-"}`;
			const params = { token: issueServiceToken("billing") };
			const owner = event.customerId === null ? null : await customerDirectory(client).lookup(event.customerId);
			const uid = webhookOwner(owner, event.uid);
			if (uid === null) {
				if (owner && event.uid !== null) {
					console.warn(`[wlp] billing.customer_mismatch ${ids} owner=${owner} metadata=${UID.test(event.uid) ? event.uid : "-"}`);
					continue;
				}
				console.warn(`[wlp] billing.unmatched ${ids}: the event names no account of this deployment`);
				continue;
			}
			try {
				const outcome = await client.user.get([uid], { params }).internalBillingEvent(event);
				console.log(`[wlp] billing.event uid=${uid} ${ids} kind=${event.kind} outcome=${outcome}`);
			} catch (error) {
				if (isActorGone(error)) {
					console.warn(`[wlp] billing.unmatched uid=${uid} ${ids}: no such account`);
					continue;
				}
				throw error;
			}
		}
		return answer(200, "OK");
	} catch {
		console.error("[wlp] billing.webhook_failed");
		return answer(500, "Not applied; send it again.");
	} finally {
		await client.dispose().catch(() => undefined);
	}
}
