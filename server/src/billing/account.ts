/**
 * One account's billing, as its `user` actor keeps it: the subscription as the provider's webhooks told it, the
 * webhook deliveries already applied, and the overage minutes reported per subscription period.
 *
 * Webhooks are applied once each: a delivery's id is written in the same transaction that applies it, and a delivery
 * seen before changes nothing (the provider retries until it is answered 2xx). An event older than the last one
 * applied changes nothing either, so deliveries that arrive out of order end where the newest says.
 *
 * Overage is reported conservatively:
 *   - only for a subscription that runs now (active, or in its grace period), with a customer and a subscription id;
 *     never for Free or yearly Pro;
 *   - in whole minutes, rounded down, and never past what the spend cap pays for;
 *   - as the difference between what is counted and what was reported before, written down as "pending" under one id
 *     before it is sent, and sent again under that same id until the provider has taken it. The provider ignores an id
 *     it has seen (Dodo: `event_id`), so a report that was taken and whose answer was lost is not counted twice.
 */

import type { RawAccess } from "rivetkit/db";
import type { BillingView, HostedMonth } from "../contract.js";
import { boundedPeriodStart, meterPeriod, shiftMonths, type MeterPeriod } from "./meter.js";
import { capMinutes, effectivePlan, MAX_CAP_CENTS, NO_SUBSCRIPTION, PLAN_LIST, PLANS, type BillingState } from "./plans.js";
import type { BillingEvent, BillingProvider, CheckoutInput, UsageReport } from "./provider.js";

export type BillingDb = Pick<RawAccess, "execute">;
type TxDb = BillingDb & Pick<RawAccess, "transaction">;

export const BILLING_TABLES = [
	`CREATE TABLE IF NOT EXISTS billing (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`,
	// One checkout link per account until settlement or provider expiry.
	`CREATE TABLE IF NOT EXISTS billing_checkout (id INTEGER PRIMARY KEY CHECK (id = 1), session TEXT NOT NULL, url TEXT NOT NULL, opened_at INTEGER NOT NULL, period TEXT NOT NULL)`,
	// The deliveries applied, by the provider's id. Kept for 90 days, longer than any provider retries one.
	`CREATE TABLE IF NOT EXISTS billing_event (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL)`,
	// A durable outbox. Each row covers a distinct increment of one subscription period's cumulative total.
	`CREATE TABLE IF NOT EXISTS billing_usage (event_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
		period_start INTEGER NOT NULL, total INTEGER NOT NULL, minutes INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
		UNIQUE(subscription_id, period_start, total))`,
	`CREATE INDEX IF NOT EXISTS billing_usage_pending ON billing_usage(period_start, total) WHERE sent = 0`,
];

export const EVENT_KEPT_MS = 90 * 86_400_000;

export async function billingTables(db: BillingDb): Promise<void> {
	for (const statement of BILLING_TABLES) await db.execute(statement);
}

export async function readBilling(db: BillingDb): Promise<BillingState> {
	const [row] = await db.execute<{ state: string }>("SELECT state FROM billing WHERE id = 1");
	return row ? JSON.parse(row.state) as BillingState : { ...NO_SUBSCRIPTION };
}

async function writeBilling(db: BillingDb, state: BillingState): Promise<void> {
	await db.execute("INSERT INTO billing (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state", JSON.stringify(state));
}

export type ApplyOutcome = "applied" | "duplicate" | "stale" | "other_customer" | "other_subscription" | "no_subscription";

/** What an event makes of the state, or why it changes nothing. Pure: `applyBillingEvent` stores it. */
export function nextBillingState(state: BillingState, event: BillingEvent, now: number, graceMs: number): { state: BillingState; outcome: ApplyOutcome } {
	const same = (outcome: ApplyOutcome) => ({ state, outcome });
	if (event.customerId !== null && state.customerId !== null && event.customerId !== state.customerId) return same("other_customer");
	if (event.occurredAt < state.eventAt) return same("stale");
	// A subscription webhook identifies the Pro product even if its first payment never succeeded.
	const providerHold = (event.kind === "payment_failed" || event.kind === "paused") && event.period !== null && event.subscriptionId !== null;
	const replacing = event.subscriptionId !== null && state.subscriptionId !== null && event.subscriptionId !== state.subscriptionId;
	if (replacing) {
		// A new subscription takes the place of one that no longer runs; while one runs, another is somebody's mistake.
		const newSubscription = event.kind === "active" || (providerHold && state.status === "ended");
		if (!newSubscription || state.status === "paused" || effectivePlan(state, now) !== "free") return same("other_subscription");
	}
	const ids = {
		customerId: event.customerId ?? state.customerId,
		subscriptionId: event.subscriptionId ?? state.subscriptionId,
		eventAt: event.occurredAt,
	};
	const period = event.period ?? state.period;
	const periodEnd = event.periodEnd ?? (replacing ? null : state.periodEnd);
	const start = event.periodStart ?? (replacing ? null : state.periodStart)
		?? (periodEnd === null ? event.occurredAt : shiftMonths(periodEnd, period === "year" ? -12 : -1));
	const periodStart = boundedPeriodStart(start, periodEnd, period);
	let previousPeriod = replacing ? null : state.previousPeriod;
	if (!replacing && state.period === "month" && state.periodStart !== null && state.periodEnd !== null && periodStart > state.periodStart) {
		previousPeriod = { start: state.periodStart, end: state.periodEnd };
	}
	const dates = { period, periodStart, periodEnd, previousPeriod };
	switch (event.kind) {
		case "active":
		case "changed":
			return { outcome: "applied", state: { ...state, ...ids, plan: "pro", status: "active", ...dates, cancelAtPeriodEnd: event.cancelAtPeriodEnd, graceUntil: null } };
		case "paused":
		case "payment_failed": {
			const status = event.kind === "paused" || (!replacing && state.status === "paused") ? "paused" : "past_due";
			if (state.plan !== "pro" || state.status === "ended") {
				if (!providerHold || (state.status === "ended" && !replacing && event.kind !== "paused")) return same("no_subscription");
				return { outcome: "applied", state: { ...state, ...ids, plan: "free", status, ...dates, graceUntil: null } };
			}
			// The grace period starts at the first failure and is not moved by the next.
			return { outcome: "applied", state: { ...state, ...ids, status, ...dates, graceUntil: state.graceUntil ?? now + graceMs } };
		}
		case "ended":
			if (state.subscriptionId === null && event.subscriptionId === null) return same("no_subscription");
			return { outcome: "applied", state: { ...state, ...ids, plan: "free", status: "ended", cancelAtPeriodEnd: false, graceUntil: null } };
	}
}

/** Applies a delivery once. The delivery's id and the new state are written in one transaction. */
export async function applyBillingEvent(db: TxDb, event: BillingEvent, now: number, graceMs: number, claimCustomer?: (id: string) => Promise<boolean>): Promise<{ outcome: ApplyOutcome; state: BillingState }> {
	const result = await db.transaction(async (tx) => {
		const seen = await tx.execute<{ id: string }>("INSERT INTO billing_event (id, at, kind, outcome) VALUES (?, ?, ?, '') ON CONFLICT (id) DO NOTHING RETURNING id", event.id, now, event.kind);
		const before = await readBilling(tx);
		if (seen.length === 0) return { outcome: "duplicate" as const, state: before };
		let done = nextBillingState(before, event, now, graceMs);
		if (done.outcome === "applied" && done.state.customerId && claimCustomer && !await claimCustomer(done.state.customerId)) {
			done = { state: before, outcome: "other_customer" };
		}
		await tx.execute("UPDATE billing_event SET outcome = ? WHERE id = ?", done.outcome, event.id);
		if (done.outcome === "applied") {
			await writeBilling(tx, done.state);
			// A repeated cancellation for the previous subscription cannot settle a new checkout.
			if (done.state.status !== "ended" || before.status !== "ended" || before.subscriptionId !== done.state.subscriptionId) {
				await tx.execute("DELETE FROM billing_checkout WHERE id = 1");
			}
		}
		await tx.execute("DELETE FROM billing_event WHERE at < ?", now - EVENT_KEPT_MS);
		return done;
	}, { name: "billing.event" });
	if (result.outcome === "other_subscription" && event.kind === "active") {
		console.warn(`[wlp] billing.double_subscription event=${event.id} customer=${event.customerId} subscription=${event.subscriptionId} current_subscription=${result.state.subscriptionId}`);
	}
	return result;
}

export async function setCapCents(db: TxDb, cents: unknown): Promise<BillingState> {
	if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CAP_CENTS) throw new RangeError(`Set the cap in whole cents from 0 to ${MAX_CAP_CENTS}.`);
	return db.transaction(async tx => {
		const state = await readBilling(tx);
		if (state.period === "year" && state.status !== "ended") throw new RangeError("Yearly Pro has no overage spend cap.");
		state.capCents = cents;
		await writeBilling(tx, state);
		return state;
	}, { name: "billing.cap" });
}

const CHECKOUT_WINDOW_MS = 30 * 60_000;

export class CheckoutBlocked extends Error {}
export class CheckoutEmailRequired extends Error {}

async function checkoutState(db: BillingDb): Promise<BillingState> {
	const state = await readBilling(db);
	if (state.status === "paused") throw new CheckoutBlocked("Your subscription is paused. Open Manage billing in Settings.");
	if (state.status === "past_due") throw new CheckoutBlocked("Your subscription has a payment on hold. Open Manage billing in Settings.");
	if (state.status === "active") throw new CheckoutBlocked("You already have Pro. Open Manage billing in Settings.");
	return state;
}

type OpenCheckout = Omit<CheckoutInput, "customerId"> & {
	email: string | null;
	claimCustomer: (id: string) => Promise<boolean>;
};

/** One per user actor. Concurrent requests share the provider call, and retries after a restart use the stored link. */
export class AccountCheckout {
	private opening?: Promise<{ url: string }>;
	private period?: CheckoutInput["period"];

	open(db: TxDb, provider: BillingProvider, input: OpenCheckout, now: number): Promise<{ url: string }> {
		if (this.opening && input.period !== this.period) return this.opening.then(() => this.open(db, provider, input, now));
		this.period = input.period;
		this.opening ??= this.openOrReuse(db, provider, input, now).finally(() => { this.opening = undefined; });
		return this.opening;
	}

	private async openOrReuse(db: TxDb, provider: BillingProvider, input: OpenCheckout, now: number): Promise<{ url: string }> {
		const { state, saved } = await db.transaction(async tx => {
			const state = await checkoutState(tx);
			const [saved] = await tx.execute<{ session: string; url: string; period: string; opened_at: number }>("SELECT session, url, period, opened_at FROM billing_checkout WHERE id = 1");
			return { state, saved };
		}, { name: "billing.checkout.read" });
		if (saved) {
			const recentlyOpened = saved.opened_at > now - CHECKOUT_WINDOW_MS;
			if (recentlyOpened || !await provider.checkoutExpired(saved.session, now)) {
				if (saved.period !== input.period) throw new CheckoutBlocked("You have a checkout open; finish or cancel it first.");
				return { url: saved.url };
			}
		}
		let customerId = state.customerId;
		if (!customerId) {
			if (!input.email) throw new CheckoutEmailRequired("Sign in with an account email to start billing.");
			customerId = await provider.createCustomer(input.uid, input.email);
		}
		const id = customerId;
		await db.transaction(async tx => {
			const current = await checkoutState(tx);
			if ((current.customerId && current.customerId !== id) || !await input.claimCustomer(id)) {
				throw new CheckoutBlocked("The billing customer could not be linked to this account.");
			}
			if (!current.customerId) await writeBilling(tx, { ...current, customerId: id });
		}, { name: "billing.customer" });

		const checkout = await provider.createCheckout({ uid: input.uid, returnUrl: input.returnUrl, period: input.period, customerId: id });
		return db.transaction(async tx => {
			// A webhook may have arrived while the provider was opening the checkout.
			const current = await checkoutState(tx);
			if (current.eventAt !== state.eventAt) throw new CheckoutBlocked("Your subscription changed. Check billing in Settings and try again.");
			await tx.execute("INSERT OR REPLACE INTO billing_checkout (id, session, url, opened_at, period) VALUES (1, ?, ?, ?, ?)", checkout.id, checkout.url, now, input.period);
			return { url: checkout.url };
		}, { name: "billing.checkout" });
	}
}

/** Whole overage minutes of a month: past the included ones, rounded down, and never past what the cap pays for. */
export function overageMinutes(state: BillingState, usedSeconds: number, includedSeconds: number, now: number): number {
	const plan = PLANS[effectivePlan(state, now)];
	if (state.period !== "month" || plan.overageCentsPer1000 === null) return 0;
	return Math.min(Math.floor(Math.max(0, usedSeconds - includedSeconds) / 60), capMinutes(plan, state.capCents));
}

export interface ReportInput {
	uid: string;
	state: BillingState;
	/** Weighted hosted seconds for this half-open subscription period. */
	usedSeconds: (period: MeterPeriod) => number;
	includedSeconds: number | null;
	now: number;
}

/** Record every period's tail before contacting Dodo. An earlier outage cannot strand a newer period. */
export async function reportOverage(db: TxDb, provider: BillingProvider, input: ReportInput): Promise<Array<{ periodStart: number; minutes: number; eventId: string }>> {
	const { state, now, includedSeconds } = input;
	const { customerId, subscriptionId, periodEnd, previousPeriod } = state;
	if (effectivePlan(state, now) === "pro" && customerId && subscriptionId && periodEnd !== null && includedSeconds !== null) {
		const periods: MeterPeriod[] = [];
		if (previousPeriod) {
			// If Dodo advanced the renewal, the new period owns holds from its start onward.
			periods.push({ ...previousPeriod, end: Math.min(previousPeriod.end, state.periodStart ?? periodEnd) });
		}
		if (state.period === "month") periods.push(meterPeriod(state, Math.min(now, periodEnd - 1)));
		await db.transaction(async tx => {
			for (const period of periods) {
				const total = overageMinutes({ ...state, period: "month" }, input.usedSeconds(period), includedSeconds, now);
				if (total <= 0) continue;
				const [row] = await tx.execute<{ queued: number }>(
					"SELECT COALESCE(MAX(total), 0) AS queued FROM billing_usage WHERE subscription_id = ? AND period_start = ?", subscriptionId, period.start);
				const queued = row!.queued;
				if (total <= queued) continue;
				const id = `wlp_${input.uid}_${subscriptionId}_${period.start}_${queued}_${total}`;
				await tx.execute("INSERT INTO billing_usage(event_id, customer_id, subscription_id, period_start, total, minutes) VALUES (?, ?, ?, ?, ?, ?)",
					id, customerId, subscriptionId, period.start, total, total - queued);
			}
		}, { name: "billing.usage.queue" });
	}

	const pending = await db.execute<UsageReport>(`SELECT event_id AS eventId, customer_id AS customerId, subscription_id AS subscriptionId,
		period_start AS periodStart, minutes FROM billing_usage WHERE sent = 0 ORDER BY period_start, total`);
	const sent = [];
	let deliveryFailed = false;
	for (const report of pending) {
		try {
			await provider.reportUsage(report);
		} catch {
			// A refusal for one period must not prevent delivery for another.
			deliveryFailed = true;
			continue;
		}
		await db.execute("UPDATE billing_usage SET sent = 1 WHERE event_id = ?", report.eventId);
		sent.push(report);
	}
	if (deliveryFailed) throw new Error("An overage report is still pending.");
	return sent;
}

export async function billingView(db: BillingDb, state: BillingState, month: HostedMonth | null, now: number): Promise<BillingView> {
	const [reported] = effectivePlan(state, now) === "pro" && state.period === "month"
		? await db.execute<{ minutes: number }>("SELECT SUM(minutes) AS minutes FROM billing_usage WHERE subscription_id = ? AND period_start = ? AND sent = 1", state.subscriptionId, meterPeriod(state, now).start) : [];
	return {
		enabled: true,
		plan: effectivePlan(state, now),
		status: state.status,
		period: state.period,
		periodEnd: state.periodEnd,
		cancelAtPeriodEnd: state.cancelAtPeriodEnd,
		graceUntil: state.status === "past_due" || state.status === "paused" ? state.graceUntil : null,
		capCents: state.capCents,
		maxCapCents: MAX_CAP_CENTS,
		overageMinutes: month ? overageMinutes(state, month.usedSeconds, month.includedSeconds, now) : 0,
		reportedMinutes: reported?.minutes ?? 0,
		portal: state.customerId !== null,
		plans: PLAN_LIST,
		month,
	};
}
