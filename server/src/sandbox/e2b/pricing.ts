import { readFileSync } from "node:fs";

export interface RateCard {
	usdPerVcpuSecond: number;
	usdPerGiBSecond: number;
}

export const DEFAULT_RATES: RateCard = { usdPerVcpuSecond: 0.000014, usdPerGiBSecond: 0.0000045 };

export function readRateCard(file: string | undefined): RateCard {
	if (!file?.trim()) return DEFAULT_RATES;
	const rates = JSON.parse(readFileSync(file.trim(), "utf8")).e2b?.microvm;
	if (!rates || ![rates.usdPerVcpuSecond, rates.usdPerGiBSecond].every(rate => Number.isFinite(rate) && rate >= 0))
		throw new Error("WLP_HOSTED_RATE_CARD_FILE needs finite, nonnegative usdPerVcpuSecond and usdPerGiBSecond under e2b.microvm");
	return { usdPerVcpuSecond: rates.usdPerVcpuSecond, usdPerGiBSecond: rates.usdPerGiBSecond };
}

/** The estimated cost in US dollars of a sandbox of this size running for `seconds`. */
export function estimatedCostUsd(seconds: number, cpuCount: number, memoryMB: number, rates: RateCard = DEFAULT_RATES): number {
	return Math.max(0, seconds) * (cpuCount * rates.usdPerVcpuSecond + (memoryMB / 1024) * rates.usdPerGiBSecond);
}

/** What a second of a sandbox of this size costs, with the size in words: for the usage page (`Sandboxes.price`). */
export function pricePerSecond(cpuCount: number, memoryMB: number, rates: RateCard = DEFAULT_RATES): { usdPerSecond: number; basis: string } {
	return { usdPerSecond: estimatedCostUsd(1, cpuCount, memoryMB, rates), basis: `${cpuCount} CPU and ${memoryMB.toLocaleString("en-US")} MiB of memory at ${rates === DEFAULT_RATES ? "published prices" : "configured prices"}` };
}

/** "$0.0031 (estimated)": small amounts keep four decimals, since a turn costs a fraction of a cent. */
export function formatEstimate(usd: number): string {
	return `$${usd.toFixed(usd < 1 ? 4 : 2)} (estimated)`;
}

/** "182 s at 1 vCPU and 1024 MiB, $0.0034 (estimated)". */
export function describeUsage(seconds: number, cpuCount: number, memoryMB: number, rates: RateCard = DEFAULT_RATES): string {
	return `${Math.round(seconds)} s at ${cpuCount} vCPU and ${memoryMB} MiB, ${formatEstimate(estimatedCostUsd(seconds, cpuCount, memoryMB, rates))}`;
}
