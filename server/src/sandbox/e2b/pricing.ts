/**
 * What E2B charges for a running sandbox, for the estimates this layer logs. E2B bills per second
 * while a sandbox runs; a paused or killed one costs no compute (https://docs.e2b.dev/billing.md), and
 * disk is free (https://e2b.dev/pricing, read 2026-11-15).
 *
 * These are estimates, in every place they are printed: the prices are copied from that page and can
 * change, a sandbox's running time is measured here and not by E2B, and E2B's bill is what counts.
 * This is the one place the numbers are.
 */

/** US dollars per vCPU per second. */
export const USD_PER_VCPU_SECOND = 0.000014;
/** US dollars per GiB of memory per second. */
export const USD_PER_GIB_SECOND = 0.0000045;
/** What a new account gets once, in US dollars: the whole budget of a deployment on the Hobby plan. */
export const HOBBY_FREE_CREDIT_USD = 100;

/** The estimated cost in US dollars of a sandbox of this size running for `seconds`. */
export function estimatedCostUsd(seconds: number, cpuCount: number, memoryMB: number): number {
	return Math.max(0, seconds) * (cpuCount * USD_PER_VCPU_SECOND + (memoryMB / 1024) * USD_PER_GIB_SECOND);
}

/** What a second of a sandbox of this size costs, with the size in words: for the usage page (`Sandboxes.price`). */
export function pricePerSecond(cpuCount: number, memoryMB: number): { usdPerSecond: number; basis: string } {
	return { usdPerSecond: estimatedCostUsd(1, cpuCount, memoryMB), basis: `${cpuCount} CPU and ${memoryMB.toLocaleString("en-US")} MiB of memory` };
}

/** "$0.0031 (estimated)": small amounts keep four decimals, since a turn costs a fraction of a cent. */
export function formatEstimate(usd: number): string {
	return `$${usd.toFixed(usd < 1 ? 4 : 2)} (estimated)`;
}

/** "182 s at 1 vCPU and 1024 MiB, $0.0034 (estimated)". */
export function describeUsage(seconds: number, cpuCount: number, memoryMB: number): string {
	return `${Math.round(seconds)} s at ${cpuCount} vCPU and ${memoryMB} MiB, ${formatEstimate(estimatedCostUsd(seconds, cpuCount, memoryMB))}`;
}
