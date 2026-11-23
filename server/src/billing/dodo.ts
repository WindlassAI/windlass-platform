/**
 * Dodo Payments, as the billing provider (WLP_BILLING_PROVIDER=dodo). The pages followed, fetched 2026-11-23:
 *
 *   API base and keys    https://docs.dodopayments.com/api-reference/introduction.md
 *                        test mode https://test.dodopayments.com, live mode https://live.dodopayments.com;
 *                        `Authorization: Bearer <key>`, a test key refused by live and the other way round
 *   checkout             https://docs.dodopayments.com/api-reference/checkout-sessions/create.md
 *                        https://docs.dodopayments.com/developer-resources/checkout-session.md
 *                        https://docs.dodopayments.com/developer-resources/subscription-integration-guide.md
 *                        POST /checkouts { product_cart: [{ product_id, quantity }], customer?, return_url, metadata }
 *                        answers { session_id, checkout_url }; a subscription product in the cart is a subscription
 *   customer portal      https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session.md
 *                        POST /customers/{customer_id}/customer-portal/session?return_url=… answers { link }
 *   metadata             https://docs.dodopayments.com/api-reference/metadata.md
 *                        string values; "Webhook payloads include the metadata of the object"
 *   webhooks             https://docs.dodopayments.com/developer-resources/webhooks.md (Standard Webhooks)
 *                        https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide.md
 *                        https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription.md
 *                        envelope { business_id, type, timestamp, data }; the Subscription object as
 *                        https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions.md has it
 *   usage                https://docs.dodopayments.com/features/usage-based-billing/meters.md
 *                        https://docs.dodopayments.com/features/usage-based-billing/event-ingestion.md
 *                        https://docs.dodopayments.com/api-reference/usage-events/ingest-events.md
 *                        POST /events/ingest { events: [{ event_id, customer_id, event_name, timestamp, metadata }] };
 *                        "Subsequent requests with existing `event_id` values are ignored (idempotent behavior)"
 *
 * Nothing of a customer but their id is logged or kept: no name, email, card or address.
 */

import type { BillingPeriod } from "../contract.js";
import { BillingProviderError, type BillingEvent, type BillingProvider, type CheckoutInput, type UsageReport } from "./provider.js";
import { verify } from "./standard-webhooks.js";

export interface DodoSettings {
	apiKey: string;
	webhookSecret: string;
	environment: "test_mode" | "live_mode";
	/** The subscription products for Pro, billed monthly and yearly. */
	products: Record<BillingPeriod, string>;
	/** The event name the overage meter counts (its "Event Name"), summed over the `minutes` property. */
	meterEvent: string;
}

/** The metadata key the checkout puts the account in, which Dodo carries to the subscription and its webhooks. */
export const UID_KEY = "wlp_uid";

export function dodoBaseUrl(environment: DodoSettings["environment"]): string {
	return environment === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A subscription as Dodo's webhooks carry it in `data` (payload_type "Subscription"); only what is read. */
interface DodoSubscription {
	payload_type?: string;
	subscription_id?: string;
	status?: "pending" | "active" | "on_hold" | "paused" | "cancelled" | "failed" | "expired" | "past_due";
	product_id?: string;
	customer?: { customer_id?: string; metadata?: Record<string, unknown> };
	metadata?: Record<string, unknown>;
	next_billing_date?: string;
	cancel_at_next_billing_date?: boolean;
	payment_frequency_interval?: "Day" | "Week" | "Month" | "Year";
}

/** A payment (payload_type "Payment"); only what is read. */
interface DodoPayment {
	payload_type?: string;
	payment_id?: string;
	subscription_id?: string | null;
	customer?: { customer_id?: string; metadata?: Record<string, unknown> };
	metadata?: Record<string, unknown>;
}

const ACTIVE_TYPES = new Set(["subscription.active", "subscription.renewed", "subscription.unpaused"]);
const CHANGED_TYPES = new Set(["subscription.updated", "subscription.plan_changed"]);
const FAILED_TYPES = new Set(["subscription.on_hold", "subscription.past_due"]);
const ENDED_TYPES = new Set(["subscription.cancelled", "subscription.expired", "subscription.failed", "subscription.paused"]);

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const time = (value: unknown) => {
	const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(ms) ? ms : null;
};

export class DodoProvider implements BillingProvider {
	readonly name = "dodo";
	private readonly base: string;

	constructor(private readonly settings: DodoSettings, private readonly fetchImpl: Fetch = fetch, base?: string) {
		this.base = base ?? dodoBaseUrl(settings.environment);
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.fetchImpl(`${this.base}${path}`, {
			method,
			headers: { authorization: `Bearer ${this.settings.apiKey}`, "content-type": "application/json" },
			...(body !== undefined && { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(20_000),
		});
		const raw = await response.text();
		if (!response.ok) {
			// Only the provider's own error code, never the message: it may repeat what was sent.
			let code = "";
			try { code = text((JSON.parse(raw) as { code?: unknown }).code) ?? ""; } catch { /* not JSON */ }
			throw new BillingProviderError(response.status, code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64));
		}
		return (raw === "" ? {} : JSON.parse(raw)) as T;
	}

	async createCheckout(input: CheckoutInput): Promise<{ id: string; url: string }> {
		const answer = await this.call<{ session_id?: string; checkout_url?: string | null }>("POST", "/checkouts", {
			product_cart: [{ product_id: this.settings.products[input.period], quantity: 1 }],
			...(input.customerId && { customer: { customer_id: input.customerId } }),
			return_url: input.returnUrl,
			metadata: { [UID_KEY]: input.uid },
		});
		const id = text(answer.session_id);
		if (!id) throw new BillingProviderError(502, "no_checkout_id");
		const url = text(answer.checkout_url);
		if (!url || !url.startsWith("https://")) throw new BillingProviderError(502, "no_checkout_url");
		return { id, url };
	}

	async portalLink(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
		const query = new URLSearchParams({ return_url: input.returnUrl });
		const answer = await this.call<{ link?: string }>("POST", `/customers/${encodeURIComponent(input.customerId)}/customer-portal/session?${query}`);
		const url = text(answer.link);
		if (!url || !url.startsWith("https://")) throw new BillingProviderError(502, "no_portal_link");
		return { url };
	}

	async reportUsage(report: UsageReport): Promise<void> {
		if (!Number.isSafeInteger(report.minutes) || report.minutes <= 0) throw new Error("A usage report needs whole minutes above zero.");
		await this.call("POST", "/events/ingest", {
			events: [{
				event_id: report.eventId,
				customer_id: report.customerId,
				event_name: this.settings.meterEvent,
				// Dodo refuses an event older than an hour, so a retry is sent with its own time; its id keeps it one event.
				timestamp: new Date().toISOString(),
				metadata: { minutes: report.minutes, month: report.month, subscription_id: report.subscriptionId },
			}],
		});
	}

	private period(subscription: DodoSubscription): BillingPeriod | null {
		if (subscription.product_id === this.settings.products.month) return "month";
		if (subscription.product_id === this.settings.products.year) return "year";
		return null;
	}

	parseWebhook(headers: Headers, body: string, now: number): BillingEvent[] | null {
		const delivery = verify(this.settings.webhookSecret, headers, body, now);
		if (delivery === null) return null;
		let envelope: { type?: unknown; timestamp?: unknown; data?: unknown };
		try { envelope = JSON.parse(body); } catch { return []; }
		const type = text(envelope.type) ?? "";
		const occurredAt = time(envelope.timestamp) ?? delivery.timestamp * 1000;
		const data = (typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {}) as DodoSubscription & DodoPayment;
		const uid = text(data.metadata?.[UID_KEY]) ?? text(data.customer?.metadata?.[UID_KEY]);
		const base = { id: delivery.id, occurredAt, uid, customerId: text(data.customer?.customer_id), subscriptionId: text(data.subscription_id), type };

		if (type === "payment.failed") {
			// A payment of no subscription is not ours to act on.
			if (base.subscriptionId === null) return [];
			return [{ ...base, kind: "payment_failed", period: null, periodEnd: null, cancelAtPeriodEnd: false }];
		}
		if (!type.startsWith("subscription.")) return [];
		const period = this.period(data);
		// A subscription to another product of the same Dodo account is not Pro.
		if (period === null) return [];
		const facts = { period, periodEnd: time(data.next_billing_date), cancelAtPeriodEnd: data.cancel_at_next_billing_date === true };
		const status = data.status;
		let kind: BillingEvent["kind"] | null = null;
		if (ACTIVE_TYPES.has(type)) kind = status === undefined || status === "active" ? "active" : null;
		else if (FAILED_TYPES.has(type)) kind = "payment_failed";
		else if (ENDED_TYPES.has(type)) kind = "ended";
		else if (CHANGED_TYPES.has(type)) {
			kind = status === "active" ? "changed"
				: status === "on_hold" || status === "past_due" ? "payment_failed"
				: status === "cancelled" || status === "expired" || status === "failed" || status === "paused" ? "ended"
				: null;
		}
		return kind === null ? [] : [{ ...base, kind, ...facts }];
	}
}
