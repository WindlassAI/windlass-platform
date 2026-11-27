/**
 * Webhook signatures by the Standard Webhooks spec (https://www.standardwebhooks.com), which Dodo Payments follows:
 * "Dodo Payments webhooks follow the Standard Webhooks specification for signature verification and payload
 * structure" (https://docs.dodopayments.com/developer-resources/webhooks.md).
 *
 *   headers         webhook-id, webhook-timestamp (Unix seconds), webhook-signature
 *   signed content  `${id}.${timestamp}.${body}`, the raw body before it is parsed
 *   key             the secret without its `whsec_` prefix, base64-decoded
 *   signature       HMAC-SHA256, base64; the header holds one or more `v1,<base64>` separated by spaces, any may match
 *   tolerance       five minutes either way, as the Standard Webhooks libraries allow
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 5 * 60;

function key(secret: string): Buffer {
	return Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
	return `v1,${createHmac("sha256", key(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** The delivery's id when its signature verifies and its time is within the tolerance; null otherwise. */
export function verify(
	secret: string,
	headers: Headers,
	body: string,
	now: number,
): { id: string; timestamp: number } | null {
	const id = headers.get("webhook-id");
	const stamp = headers.get("webhook-timestamp");
	const signatures = headers.get("webhook-signature");
	if (!id || !stamp || !signatures || !/^\d{1,12}$/.test(stamp)) return null;
	const timestamp = Number(stamp);
	if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return null;
	const expected = Buffer.from(sign(secret, id, timestamp, body).slice(3), "base64");
	for (const part of signatures.split(" ")) {
		const [version, value] = part.split(",", 2);
		if (version !== "v1" || !value) continue;
		const given = Buffer.from(value, "base64");
		if (given.length === expected.length && timingSafeEqual(given, expected)) return { id, timestamp };
	}
	return null;
}
