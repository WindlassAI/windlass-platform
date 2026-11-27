/**
 * The payment provider, behind one small interface: everything else of billing (plans, the meter, limits, the spend
 * cap, grace and the fall back to Free, the screens) is the platform's own and does not know which provider it is.
 *
 *   createCheckout   a hosted checkout for Pro, monthly or yearly: the address to send the browser to
 *   portalLink       the provider's customer portal, to change the card or cancel
 *   parseWebhook     verifies a webhook's signature and turns it into our events (`BillingEvent`), or refuses it
 *   reportUsage      tells the provider of overage minutes, once: the same `eventId` again is ignored by it
 *
 * The provider is chosen with WLP_BILLING_PROVIDER (billing/config.ts). Unset: no billing, no plans, and the
 * deployment's limits, as before. Dodo Payments is the one adapter (billing/dodo.ts).
 */

import type { BillingPeriod } from "../contract.js";

/**
 * The customer id identifies the account. The optional uid in checkout metadata is a fallback and must agree
 * with the customer directory when both are present.
 *
 *   active          a subscription for Pro is paid and running: it started, renewed, or recovered from a failed payment
 *   changed         it changed (period, renewal date, cancel at period end) and is still running
 *   ended           it ended: cancelled, expired or failed for good. Free's limits from now
 *   paused          resumable; same grace as a failed payment, new checkout blocked
 *   payment_failed  a payment failed: the grace period starts, if it has not
 */
export interface BillingEvent {
	/** The provider's id of this delivery: the same id again is the same event (webhook retries). */
	id: string;
	kind: "active" | "changed" | "ended" | "paused" | "payment_failed";
	/** When the provider says it happened, ms since the epoch: an older one arriving later changes nothing. */
	occurredAt: number;
	uid: string | null;
	customerId: string | null;
	subscriptionId: string | null;
	period: BillingPeriod | null;
	periodStart: number | null;
	periodEnd: number | null;
	cancelAtPeriodEnd: boolean;
	/** The provider's own event type, for the log. */
	type: string;
}

export interface CheckoutInput {
	uid: string;
	period: BillingPeriod;
	/** The account's customer at the provider when it has one, so that a second subscription is the same customer's. */
	customerId: string;
	/** Where the provider sends the browser back to. */
	returnUrl: string;
}

export type UsageReport = {
	/** The provider's dedupe key: a retry with the same id is counted once. */
	eventId: string;
	customerId: string;
	subscriptionId: string;
	/** UTC start of the subscription period the minutes belong to. */
	periodStart: number;
	/** Overage minutes to add: whole minutes, above zero. */
	minutes: number;
};

export interface BillingProvider {
	readonly name: string;
	createCustomer(uid: string, email: string): Promise<string>;
	createCheckout(input: CheckoutInput): Promise<{ id: string; url: string }>;
	checkoutReplaceable(session: string, now: number): Promise<boolean>;
	portalLink(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
	/** Null for a signature that does not verify, or a delivery too old. An empty list for events billing does not use. */
	parseWebhook(headers: Headers, body: string, now: number): BillingEvent[] | null;
	reportUsage(report: UsageReport): Promise<void>;
}

/** A provider error that says nothing of what was sent: its status, and the provider's own code where it gave one. */
export class BillingProviderError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string,
	) {
		super(`the billing provider answered ${status}${detail ? ` (${detail})` : ""}`);
	}
}
