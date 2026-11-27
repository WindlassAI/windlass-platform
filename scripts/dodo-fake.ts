/**
 * A stand-in for Dodo Payments' API and webhooks, for checks: no request leaves the process. The shapes follow the
 * pages server/src/billing/dodo.ts cites:
 *
 *   POST /checkouts                                 { session_id, checkout_url }
 *     (https://docs.dodopayments.com/api-reference/checkout-sessions/create.md)
 *   POST /customers/{id}/customer-portal/session    { link }
 *     (https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session.md)
 *   POST /events/ingest                             { ingested_count }, an event_id seen before ignored
 *     (https://docs.dodopayments.com/api-reference/usage-events/ingest-events.md)
 *   webhooks: { business_id, type, timestamp, data } signed by Standard Webhooks
 *     (https://docs.dodopayments.com/developer-resources/webhooks.md), `data` a Subscription as
 *     https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions.md has it, or a Payment as
 *     https://docs.dodopayments.com/api-reference/payments/get-payments-1.md has it
 */

import { randomBytes } from "node:crypto";
import { sign } from "../server/src/billing/standard-webhooks.js";

export const FAKE_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
export const FAKE_KEY = "dodo_test_fake";

export interface FakeCall {
	method: string;
	path: string;
	query: URLSearchParams;
	body: any;
	auth: string | null;
}

type PaymentStatus = "failed" | "cancelled" | "processing" | "succeeded";

export class FakeDodo {
	readonly checkouts = new Map<
		string,
		{ id: string; created_at: string; payment_id: string | null; payment_status: PaymentStatus | null }
	>();
	readonly calls: FakeCall[] = [];
	/** Event ids taken by /events/ingest, and the minutes each carried. */
	readonly ingested = new Map<string, number>();
	/** Answer the next n requests with this status (a 500 that took the request first, with `took`). */
	failNext: { status: number; count: number; took?: boolean } | null = null;

	fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const parsed = new URL(url);
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const auth = new Headers(init.headers).get("authorization");
		this.calls.push({ method: init.method ?? "GET", path: parsed.pathname, query: parsed.searchParams, body, auth });
		if (auth !== `Bearer ${FAKE_KEY}`)
			return Response.json({ code: "UNAUTHORIZED", message: "bad key" }, { status: 401 });
		const fail = this.failNext;
		if (fail && fail.count > 0) {
			fail.count -= 1;
			if (fail.took && parsed.pathname === "/events/ingest") this.take(body);
			return Response.json(
				{ code: "INTERNAL", message: "customer jane@example.com card 4242" },
				{ status: fail.status },
			);
		}
		if (init.method === "POST" && parsed.pathname === "/customers" && body.name && body.email)
			return Response.json({ customer_id: "cus_1" });
		if (init.method === "POST" && parsed.pathname === "/checkouts" && body.customer?.customer_id) {
			const id = `cks_${randomBytes(6).toString("hex")}`;
			this.checkouts.set(id, { id, created_at: new Date().toISOString(), payment_id: null, payment_status: null });
			return Response.json({ session_id: id, checkout_url: `https://test.checkout.dodopayments.com/session/${id}` });
		}
		const checkout = this.checkouts.get(parsed.pathname.slice("/checkouts/".length));
		if (init.method === "GET" && parsed.pathname.startsWith("/checkouts/") && checkout) return Response.json(checkout);
		const portal = /^\/customers\/([^/]+)\/customer-portal\/session$/.exec(parsed.pathname);
		if (init.method === "POST" && portal)
			return Response.json({ link: `https://test.customer.dodopayments.com/portal/${portal[1]}` });
		if (init.method === "POST" && parsed.pathname === "/events/ingest")
			return Response.json({ ingested_count: this.take(body) });
		return Response.json({ code: "NOT_FOUND" }, { status: 404 });
	};

	setPayment(session: string, status: PaymentStatus | null): void {
		const checkout = this.checkouts.get(session);
		if (!checkout) throw new Error(`Unknown checkout ${session}`);
		checkout.payment_id = status === null ? null : `pay_${session}`;
		checkout.payment_status = status;
	}

	private take(body: { events: Array<{ event_id: string; metadata: { minutes: number } }> }): number {
		let count = 0;
		for (const event of body.events) {
			if (this.ingested.has(event.event_id)) continue;
			this.ingested.set(event.event_id, event.metadata.minutes);
			count++;
		}
		return count;
	}

	/** The overage minutes Dodo would bill: the sum over the events it took. */
	get minutes(): number {
		return [...this.ingested.values()].reduce((a, b) => a + b, 0);
	}
}

export interface SubscriptionFacts {
	uid?: string;
	subscriptionId?: string;
	customerId?: string;
	productId: string;
	status?: "pending" | "active" | "on_hold" | "paused" | "cancelled" | "failed" | "expired" | "past_due";
	nextBillingDate?: string;
	cancelAtNext?: boolean;
	/** Where the uid is carried: the subscription's metadata (the default), or only the customer's. */
	uidOn?: "subscription" | "customer" | "none";
}

export function subscriptionData(facts: SubscriptionFacts) {
	const uid = facts.uid ?? "u_check";
	return {
		payload_type: "Subscription",
		subscription_id: facts.subscriptionId ?? "sub_1",
		status: facts.status ?? "active",
		product_id: facts.productId,
		quantity: 1,
		currency: "USD",
		recurring_pre_tax_amount: 1500,
		customer: {
			customer_id: facts.customerId ?? "cus_1",
			email: "jane@example.com",
			name: "Jane Doe",
			...(facts.uidOn === "customer" && { metadata: { wlp_uid: uid } }),
		},
		metadata: facts.uidOn === "customer" || facts.uidOn === "none" ? {} : { wlp_uid: uid },
		next_billing_date: facts.nextBillingDate ?? "2026-12-23T00:00:00Z",
		previous_billing_date: "2026-11-23T00:00:00Z",
		cancel_at_next_billing_date: facts.cancelAtNext ?? false,
		payment_frequency_interval: "Month",
		payment_frequency_count: 1,
		subscription_period_interval: "Year",
		subscription_period_count: 10,
		trial_period_days: 0,
		meters: [{ meter_id: "mtr_1", free_threshold: 0, price_per_unit: "0.006" }],
	};
}

export function paymentData(facts: { uid?: string; subscriptionId?: string | null; customerId?: string }) {
	return {
		payload_type: "Payment",
		payment_id: "pay_1",
		subscription_id: facts.subscriptionId === undefined ? "sub_1" : facts.subscriptionId,
		status: "failed",
		total_amount: 1500,
		currency: "USD",
		customer: { customer_id: facts.customerId ?? "cus_1", email: "jane@example.com", name: "Jane Doe" },
		metadata: facts.uid ? { wlp_uid: facts.uid } : {},
		error_code: "card_declined",
		error_message: "Your card was declined.",
	};
}

let deliveries = 0;

/** A signed delivery: its headers and raw body, as Dodo sends it. */
export function delivery(
	type: string,
	data: unknown,
	options: { at?: number; secret?: string; id?: string; signedAt?: number } = {},
) {
	const at = options.at ?? Date.now();
	const id = options.id ?? `msg_${++deliveries}_${randomBytes(4).toString("hex")}`;
	const body = JSON.stringify({ business_id: "bus_1", type, timestamp: new Date(at).toISOString(), data });
	const timestamp = Math.floor((options.signedAt ?? Date.now()) / 1000);
	const headers = new Headers({
		"webhook-id": id,
		"webhook-timestamp": String(timestamp),
		"webhook-signature": sign(options.secret ?? FAKE_SECRET, id, timestamp, body),
		"content-type": "application/json",
	});
	return { id, headers, body };
}
