/**
 * Hosted minutes: what a plan includes and overage is billed in.
 *
 * One hosted minute is one minute of a standard sandbox (2 vCPU, 4 GiB). A small sandbox counts half, a large one
 * twice. They are counted from the ledger of sandbox time (usage.ts), whose entries say which session's sandbox ran how
 * many seconds. Each hold counts at the weight it opened with. Runs on the user's own machines never reach that ledger, so they are never metered.
 *
 * Free follows UTC calendar months. Pro follows Dodo's billing dates, with monthly allowances within a yearly term.
 */

import type { SessionSummary } from "../contract.js";
import type { BillingState, SandboxSize } from "./plans.js";

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => Math.floor(ms / DAY_MS);

export const SIZE_WEIGHT: Record<SandboxSize, number> = { small: 0.5, standard: 1, large: 2 };

/**
 * The size a session's hosted sandbox runs at (contract.ts `HostedSize`). A session made before sizes existed has none
 * and ran small (1 vCPU, 1 GiB), which is also the size of a person's agent where nothing else is chosen.
 */
export function sessionSize(session: Pick<SessionSummary, "hostedSize"> | undefined): SandboxSize {
	return session?.hostedSize ?? "small";
}

export function sessionWeight(session: Pick<SessionSummary, "hostedSize"> | undefined): number {
	return SIZE_WEIGHT[sessionSize(session)];
}

/** The month a UTC day is in, as "2026-11". */
export function monthOfDay(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 7);
}

export function monthOf(ms: number): string {
	return monthOfDay(dayOf(ms));
}

export interface MeterPeriod { start: number; end: number }
export type SubscriptionDates = Pick<BillingState, "periodStart" | "periodEnd" | "period">;

/** UTC anniversary, clamped to the last day of a shorter month. Always offset from the original anchor. */
export function shiftMonths(anchor: number, months: number): number {
	const date = new Date(anchor);
	const day = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + months);
	const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(day, last));
	return date.getTime();
}

function anniversaryPeriod(anchor: number, now: number): MeterPeriod {
	const first = new Date(anchor), date = new Date(now);
	let months = (date.getUTCFullYear() - first.getUTCFullYear()) * 12 + date.getUTCMonth() - first.getUTCMonth();
	if (shiftMonths(anchor, months) > now) months--;
	return { start: shiftMonths(anchor, months), end: shiftMonths(anchor, months + 1) };
}

/** Bound the provider's term before deriving any monthly anniversaries from it. */
export function boundedPeriodStart(start: number, end: number | null, period: SubscriptionDates["period"]): number {
	if (end === null) return start;
	const earliest = end - (period === "year" ? 366 : 31) * DAY_MS;
	if (start >= earliest) return start;
	console.warn("[wlp] billing.period_clamped");
	return earliest;
}

export function meterPeriod(dates: SubscriptionDates | null, now: number): MeterPeriod {
	if (!dates) {
		const date = new Date(now);
		const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
		return { start, end: shiftMonths(start, 1) };
	}
	const end = dates.periodEnd;
	const start = boundedPeriodStart(dates.periodStart ?? now, end, dates.period);
	if (end !== null && now >= end) return anniversaryPeriod(end, now);
	if (dates.period === "month" && end !== null) return { start, end };
	const window = anniversaryPeriod(start, Math.max(start, now));
	return { start: window.start, end: Math.min(end ?? window.end, window.end) };
}
