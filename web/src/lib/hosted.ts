/**
 * The month's hosted minutes as the screens say them (`UsageNumbers.hosted`, server/src/billing/meter.ts). A hosted
 * minute is one minute of a standard sandbox: a small one counts half, a large one twice. Runs on the user's own
 * machines are never counted.
 */
import { USAGE_LOW_SHARE, type HostedMonth, type PlanInfo, type UsageNumbers } from "@contract";
import { count } from "./format";

/** Whole minutes, rounded down: "N of M used" never says more than was used. */
export function minutes(weightedSeconds: number): string {
	return count(Math.floor(Math.max(0, weightedSeconds) / 60));
}

/** "1 December": when the month's minutes start again, in UTC as the server counts them. */
export function monthReset(month: HostedMonth): string {
	const date = new Date(month.resetsAt);
	return `${date.getUTCDate()} ${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;
}

/** Billing-period wording for the usage meter and notices. */
export function periodWords(month: HostedMonth): string {
	return month.plan === "pro" ? `for the period ending ${monthReset(month)}` : "this month";
}

/** Calendar month for Free, allowance reset for Pro. */
export function monthName(month: HostedMonth): string {
	if (month.plan === "pro") return `Resets ${monthReset(month)}`;
	const [year, number] = month.month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(year, number - 1, 1)).toLocaleString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

export type MonthState = "plenty" | "low" | "used";

/** "used": too little is left for a turn to start; "low": less than USAGE_LOW_SHARE of the month's minutes is left. */
export function monthState(numbers: Pick<UsageNumbers, "hosted" | "startSeconds"> | null): MonthState {
	const month = numbers?.hosted;
	if (!month) return "plenty";
	if (month.leftSeconds < numbers.startSeconds) return "used";
	return month.leftSeconds < month.limitSeconds * USAGE_LOW_SHARE ? "low" : "plenty";
}

/** Whether the month's limit is past the included minutes: a plan with overage up to its spend cap. */
export function withOverage(month: HostedMonth): boolean {
	return month.limitSeconds > month.includedSeconds;
}

/**
 * One sentence of where the month stands, for a composer or a notice; null while there is plenty. `launch`: said where
 * agents are launched, so at the limit it says what launching does (a hosted agent waits, one on a machine starts).
 */
export function monthSentence(
	numbers: Pick<UsageNumbers, "hosted" | "startSeconds"> | null,
	pro: PlanInfo | null,
	{ launch = false }: { launch?: boolean } = {},
): string | null {
	const month = numbers?.hosted;
	const state = monthState(numbers ?? null);
	if (!month || state === "plenty") return null;
	const used = month.usedSeconds + month.heldSeconds;
	const of = withOverage(month)
		? `${minutes(month.limitSeconds)} min of hosted time ${periodWords(month)}, your spend cap included`
		: `${minutes(month.includedSeconds)} min of hosted time ${periodWords(month)}`;
	if (state === "low") return `You've used ${minutes(used)} of ${of}. Your own machines are never counted.`;
	if (launch) {
		const more =
			month.plan === "free" && pro
				? ` Or move to Pro for ${count(pro.hostedMinutes)} a month.`
				: month.period === "year"
					? " Or switch to monthly Pro for overage."
					: withOverage(month)
						? " Or raise your spend cap in Settings."
						: "";
		return `You've used all ${of}. A hosted agent launched now is created, and waits until ${monthReset(month)}; one on your own machine starts at once, and is never counted.${more}`;
	}
	const way =
		month.plan === "free" && pro
			? `Run agents on your own machines, which are never counted, or move to Pro for ${count(pro.hostedMinutes)} a month.`
			: month.period === "year"
				? "Switch to monthly Pro for overage, or run agents on your own machines."
				: withOverage(month)
					? "Raise your spend cap in Settings, or run agents on your own machines, which are never counted."
					: "Run agents on your own machines, which are never counted.";
	return `You've used all ${of}, so hosted agents can't start until ${monthReset(month)}. ${way}`;
}

/** "$15", "$12.50". */
export function dollars(cents: number): string {
	return cents % 100 === 0 ? `$${count(cents / 100)}` : `$${(cents / 100).toFixed(2)}`;
}
