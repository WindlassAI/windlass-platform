import type { SandboxPlace } from "../contract.js";

/** A hosted size fixes the sandbox template for its lifetime. A machine's slot resources come from its runner instead. */
export type HostedSize = "small" | "standard" | "large";
export const HOSTED_SIZES: readonly HostedSize[] = ["small", "standard", "large"];
export const HOSTED_SIZE_SPECS: Readonly<Record<HostedSize, { cpus: number; memoryMiB: number }>> = {
	small: { cpus: 1, memoryMiB: 1024 },
	standard: { cpus: 2, memoryMiB: 4096 },
	large: { cpus: 4, memoryMiB: 8192 },
};
/** A work item's sandbox, where nothing else is chosen. */
export const ITEM_HOSTED_SIZE: HostedSize = "standard";
/** A person's own agent, where neither the launch form nor the repository says. */
export const SESSION_HOSTED_SIZE: HostedSize = "small";

export function isHostedSize(value: unknown): value is HostedSize {
	return typeof value === "string" && (HOSTED_SIZES as readonly string[]).includes(value);
}

/** "Standard · 2 vCPU, 4 GiB". */
export function hostedSizeWords(size: HostedSize): string {
	const spec = HOSTED_SIZE_SPECS[size];
	return `${size.charAt(0).toUpperCase()}${size.slice(1)} · ${spec.cpus} vCPU, ${spec.memoryMiB / 1024} GiB`;
}

/** The least size that has a plan's `cpus` and `memoryGiB`; null when even the largest has not. */
export function hostedSizeFor(needs: { cpus?: number; memoryGiB?: number }): HostedSize | null {
	if (needs.cpus === undefined && needs.memoryGiB === undefined) return null;
	return HOSTED_SIZES.find((size) => (needs.cpus ?? 0) <= HOSTED_SIZE_SPECS[size].cpus && (needs.memoryGiB ?? 0) * 1024 <= HOSTED_SIZE_SPECS[size].memoryMiB) ?? null;
}

/** The next size up, or null for the largest. */
export function largerHostedSize(size: HostedSize, offered: readonly HostedSize[] = HOSTED_SIZES): HostedSize | null {
	return HOSTED_SIZES.slice(HOSTED_SIZES.indexOf(size) + 1).find(next => offered.includes(next)) ?? null;
}

/** Suggest a larger size only when the deployment offers it. */
export function outOfMemoryWords(memory: { usedMiB: number; totalMiB: number; size?: HostedSize }, offered: readonly HostedSize[] = HOSTED_SIZES, place: SandboxPlace["kind"] = "hosted"): string {
	if (place === "machine") return `The machine slot ran out of memory (limit ${memory.totalMiB.toLocaleString("en-US")} MiB). The machine’s owner can give slots more memory with --slot-memory or configure fewer slots to share the available memory.`;
	const said = `The sandbox ran out of memory (${memory.usedMiB.toLocaleString("en-US")} of ${memory.totalMiB.toLocaleString("en-US")} MiB).`;
	const from = memory.size ?? HOSTED_SIZES.find((size) => HOSTED_SIZE_SPECS[size].memoryMiB >= memory.totalMiB) ?? "large";
	const larger = largerHostedSize(from, offered);
	if (larger) return `${said} A larger size has more room: ${hostedSizeWords(larger)}.`;
	return `${said} ${memory.size ? "This is the largest size this deployment has" : "No larger size is offered here"}: have the agent's commands use less memory at once (fewer tests or workers in parallel).`;
}

/** A size this deployment's hosted layer offers, with its estimated price. */
export interface HostedSizeOption {
	id: HostedSize;
	cpus: number;
	memoryMiB: number;
	/** Estimated US dollars per hour of running, at the provider's published prices; null when not billed by time. */
	usdPerHour: number | null;
}
