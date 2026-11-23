/**
 * Hosted minutes: what a plan includes and overage is billed in.
 *
 * One hosted minute is one minute of a standard sandbox (2 vCPU, 4 GiB). A small sandbox counts half, a large one
 * twice. They are counted from the ledger of sandbox time (usage.ts), whose entries say which session's sandbox ran how
 * many seconds on which UTC day: a month's hosted seconds are the sum of its days' entries, each times the weight when its hold
 * opened. Runs on the user's own machines never reach that ledger, so they are never metered.
 *
 * Months are UTC calendar months. A hold never reaches past midnight UTC (usage.ts), so none reaches past the end of a
 * month either, and the first hold of a month is the new month's.
 */

import type { SessionSummary } from "../contract.js";
import type { SandboxSize } from "./plans.js";

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

/** The first UTC day of the month `ms` is in, as a day number (usage.ts `dayOf`). */
export function monthStartDay(ms: number): number {
	const date = new Date(ms);
	return dayOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Midnight UTC on the first of the next month. */
export function nextMonthStart(ms: number): number {
	const date = new Date(ms);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** The month before "2026-11": "2026-10". */
export function previousMonth(month: string): string {
	const [year, number] = month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
}
