import type { SandboxProfileId } from "../contract.js";

/**
 * The two words a user sees for a sandbox profile, whatever runs it. Where it runs (Hosted, or a machine's
 * name) is said beside it; how it is isolated (the provider and its layers) is only in `SandboxProfile.details`
 * and `layers`, behind "How it's isolated".
 */
export type Isolation = "strict" | "open";

export const PROFILE_ISOLATION: Readonly<Record<SandboxProfileId, Isolation>> = {
	"docker-windlass-sandbox": "strict",
	"docker-hardened": "open",
	e2b: "strict",
	"e2b-open": "open",
	daytona: "open",
	firecracker: "strict",
	agentos: "strict",
};

export const ISOLATION_NAMES: Readonly<Record<Isolation, string>> = { strict: "Strict", open: "Open" };

/** One outcome line each, as the place picker says it. */
export const ISOLATION_LINES: Readonly<Record<Isolation, string>> = {
	strict: "Commands sandboxed, no internet. For untrusted code.",
	open: "Commands run freely and can reach the internet.",
};

/** "Strict" or "Open": a profile's label from its id alone, for a saved choice whose profile is not listed. */
export function isolationName(id: SandboxProfileId | string): string {
	const isolation = PROFILE_ISOLATION[id as SandboxProfileId];
	return isolation ? ISOLATION_NAMES[isolation] : id;
}

/** What an Open profile's commands reach, by its network policy. */
export function openLine(network: "open" | "restricted" | "none"): string {
	return network === "open" ? ISOLATION_LINES.open : network === "restricted" ? "Commands run freely and reach only allowed hosts." : "Commands run freely, with no internet.";
}
