/**
 * One account's billing, as its `user` actor keeps it: the subscription as the provider's webhooks told it, the
 * webhook deliveries already applied, and the overage minutes reported per month.
 *
 * Webhooks are applied once each: a delivery's id is written in the same transaction that applies it, and a delivery
 * seen before changes nothing (the provider retries until it is answered 2xx). An event older than the last one
 * applied changes nothing either, so deliveries that arrive out of order end where the newest says.
 *
 * Overage is reported conservatively:
 *   - only for a subscription that runs now (active, or in its grace period), with a customer and a subscription id;
 *     never for Free, never without a subscription;
 *   - in whole minutes, rounded down, and never past what the spend cap pays for;
 *   - as the difference between what is counted and what was reported before, written down as "pending" under one id
 *     before it is sent, and sent again under that same id until the provider has taken it. The provider ignores an id
 *     it has seen (Dodo: `event_id`), so a report that was taken and whose answer was lost is not counted twice.
 */

import type { RawAccess } from "rivetkit/db";
import type { BillingView, HostedMonth } from "../contract.js";
import { monthOf, previousMonth } from "./meter.js";
import { capMinutes, effectivePlan, MAX_CAP_CENTS, NO_SUBSCRIPTION, PLAN_LIST, PLANS, type BillingState } from "./plans.js";
import type { BillingEvent, BillingProvider } from "./provider.js";

export type BillingDb = Pick<RawAccess, "execute">;
type TxDb = BillingDb & Pick<RawAccess, "transaction">;

export const BILLING_TABLES = [
	`CREATE TABLE IF NOT EXISTS billing (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`,
	// The deliveries applied, by the provider's id. Kept for 90 days, longer than any provider retries one.
	`CREATE TABLE IF NOT EXISTS billing_event (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL)`,
	// Per UTC month: the overage minutes the provider has taken, and the report under way, if any.
	`CREATE TABLE IF NOT EXISTS billing_usage (month TEXT PRIMARY KEY, reported INTEGER NOT NULL, pending_to INTEGER, pending_id TEXT)`,
];

export const EVENT_KEPT_MS = 90 * 86_400_000;

export async function billingTables(db: BillingDb): Promise<void> {
	for (const statement of BILLING_TABLES) await db.execute(statement);
}

export async function readBilling(db: BillingDb): Promise<BillingState> {
	const [row] = await db.execute<{ state: string }>("SELECT state FROM billing WHERE id = 1");
	return row ? { ...NO_SUBSCRIPTION, ...(JSON.parse(row.state) as Partial<BillingState>) } : { ...NO_SUBSCRIPTION };
}

async function writeBilling(db: BillingDb, state: BillingState): Promise<void> {
	await db.execute("INSERT INTO billing (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state", JSON.stringify(state));
}

export type ApplyOutcome = "applied" | "duplicate" | "stale" | "other_customer" | "other_subscription" | "no_subscription";

/** What an event makes of the state, or why it changes nothing. Pure: `applyBillingEvent` stores it. */
export function nextBillingState(state: BillingState, event: BillingEvent, now: number, graceMs: number): { state: BillingState; outcome: ApplyOutcome } {
	const same = (outcome: ApplyOutcome) => ({ state, outcome });
	if (event.customerId !== null && state.customerId !== null && event.customerId !== state.customerId) return same("other_customer");
	const running = effectivePlan(state, now) !== "free";
	const replacing = event.subscriptionId !== null && state.subscriptionId !== null && event.subscriptionId !== state.subscriptionId;
	if (replacing) {
		// A new subscription takes the place of one that no longer runs; while one runs, another is somebody's mistake.
		if (event.kind !== "active" || running) return same("other_subscription");
	} else if (event.occurredAt < state.eventAt) {
		return same("stale");
	}
	const ids = {
		customerId: event.customerId ?? state.customerId,
		subscriptionId: event.subscriptionId ?? state.subscriptionId,
		eventAt: replacing ? event.occurredAt : Math.max(event.occurredAt, state.eventAt),
	};
	switch (event.kind) {
		case "active":
		case "changed":
			return { outcome: "applied", state: { ...state, ...ids, plan: "pro", status: "active", period: event.period ?? state.period, periodEnd: event.periodEnd ?? state.periodEnd, cancelAtPeriodEnd: event.cancelAtPeriodEnd, graceUntil: null } };
		case "payment_failed":
			if (state.plan !== "pro" || state.status === "ended") return same("no_subscription");
			// The grace period starts at the first failure and is not moved by the next.
			return { outcome: "applied", state: { ...state, ...ids, status: "past_due", graceUntil: state.graceUntil ?? now + graceMs } };
		case "ended":
			if (state.subscriptionId === null && event.subscriptionId === null) return same("no_subscription");
			return { outcome: "applied", state: { ...state, ...ids, plan: "free", status: "ended", cancelAtPeriodEnd: false, graceUntil: null } };
	}
}

/** Applies a delivery once. The delivery's id and the new state are written in one transaction. */
export async function applyBillingEvent(db: TxDb, event: BillingEvent, now: number, graceMs: number): Promise<{ outcome: ApplyOutcome; state: BillingState }> {
	return db.transaction(async (tx) => {
		const seen = await tx.execute<{ id: string }>("INSERT INTO billing_event (id, at, kind, outcome) VALUES (?, ?, ?, '') ON CONFLICT (id) DO NOTHING RETURNING id", event.id, now, event.kind);
		const before = await readBilling(tx);
		if (seen.length === 0) return { outcome: "duplicate" as const, state: before };
		const done = nextBillingState(before, event, now, graceMs);
		await tx.execute("UPDATE billing_event SET outcome = ? WHERE id = ?", done.outcome, event.id);
		if (done.outcome === "applied") await writeBilling(tx, done.state);
		await tx.execute("DELETE FROM billing_event WHERE at < ?", now - EVENT_KEPT_MS);
		return done;
	}, { name: "billing.event" });
}

export async function setCapCents(db: BillingDb, cents: unknown): Promise<BillingState> {
	if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CAP_CENTS) throw new RangeError(`Set the cap in whole cents from 0 to ${MAX_CAP_CENTS}.`);
	const state = { ...(await readBilling(db)), capCents: cents };
	await writeBilling(db, state);
	return state;
}

/** Whole overage minutes of a month: past the included ones, rounded down, and never past what the cap pays for. */
export function overageMinutes(state: BillingState, usedSeconds: number, includedSeconds: number, now: number): number {
	const plan = PLANS[effectivePlan(state, now)];
	if (plan.overageCentsPer1000 === null) return 0;
	return Math.min(Math.floor(Math.max(0, usedSeconds - includedSeconds) / 60), capMinutes(plan, state.capCents));
}

type UsageRow = { month: string; reported: number; pending_to: number | null; pending_id: string | null };

async function usageRow(db: BillingDb, month: string): Promise<UsageRow> {
	const [row] = await db.execute<UsageRow>("SELECT month, reported, pending_to, pending_id FROM billing_usage WHERE month = ?", month);
	return row ?? { month, reported: 0, pending_to: null, pending_id: null };
}

export async function reportedMinutes(db: BillingDb, month: string): Promise<number> {
	return (await usageRow(db, month)).reported;
}

export interface ReportInput {
	uid: string;
	state: BillingState;
	/** The weighted hosted seconds counted in a month: the usage book's `usedInMonth`. */
	usedSeconds: (month: string) => number;
	includedSeconds: number;
	now: number;
}

/**
 * Reports what overage the provider has not been told of yet, for last month and this one. Throws where the provider
 * could not be reached; what was pending stays pending, and the next call sends it again under the same id.
 */
export async function reportOverage(db: BillingDb, provider: BillingProvider, input: ReportInput): Promise<Array<{ month: string; minutes: number; eventId: string }>> {
	const { state, now } = input;
	// Never without a subscription that runs now.
	if (effectivePlan(state, now) === "free" || state.customerId === null || state.subscriptionId === null) return [];
	const sent: Array<{ month: string; minutes: number; eventId: string }> = [];
	const current = monthOf(now);
	for (const month of [previousMonth(current), current]) {
		const send = async (row: UsageRow) => {
			const minutes = row.pending_to! - row.reported;
			if (minutes > 0) await provider.reportUsage({ eventId: row.pending_id!, customerId: state.customerId!, subscriptionId: state.subscriptionId!, month, minutes });
			await db.execute("UPDATE billing_usage SET reported = ?, pending_to = NULL, pending_id = NULL WHERE month = ? AND pending_id = ?", row.pending_to, month, row.pending_id);
			if (minutes > 0) sent.push({ month, minutes, eventId: row.pending_id! });
		};
		// What was written down and not yet taken goes first, under its own id.
		const open = await usageRow(db, month);
		if (open.pending_to !== null) await send(open);
		const row = await usageRow(db, month);
		const counted = overageMinutes(state, input.usedSeconds(month), input.includedSeconds, now);
		if (counted <= row.reported) continue;
		const id = `wlp_${input.uid}_${month}_${row.reported}_${counted}`;
		await db.execute("INSERT INTO billing_usage (month, reported, pending_to, pending_id) VALUES (?, ?, ?, ?) ON CONFLICT (month) DO UPDATE SET pending_to = excluded.pending_to, pending_id = excluded.pending_id",
			month, row.reported, counted, id);
		await send({ ...row, pending_to: counted, pending_id: id });
	}
	return sent;
}

export async function billingView(db: BillingDb, state: BillingState, month: HostedMonth | null, now: number): Promise<BillingView> {
	const current = monthOf(now);
	const reported = await reportedMinutes(db, current);
	return {
		enabled: true,
		plan: effectivePlan(state, now),
		status: state.status,
		period: state.period,
		periodEnd: state.periodEnd,
		cancelAtPeriodEnd: state.cancelAtPeriodEnd,
		graceUntil: state.status === "past_due" ? state.graceUntil : null,
		capCents: state.capCents,
		maxCapCents: MAX_CAP_CENTS,
		overageMinutes: month ? overageMinutes(state, month.usedSeconds, month.includedSeconds, now) : 0,
		reportedMinutes: reported,
		portal: state.customerId !== null,
		plans: PLAN_LIST,
		month,
	};
}
