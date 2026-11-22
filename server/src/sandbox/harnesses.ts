import type { HarnessOptions, HarnessId, ModelList, SandboxProfileId } from "../contract.js";

export interface AcpProfile {
	id: Exclude<HarnessId, "windlass">;
	name: string;
	command: string[];
	leftovers: string;
	profiles: SandboxProfileId[];
	steering: string;
	signedOutCodes: number[];
	/** The mode a work item's session starts in, every turn: one that never asks, since nobody answers an item's questions. */
	itemMode: string;
	/**
	 * How a work item counts the tokens this agent reports. "budget": against the item's token budget (an
	 * API key, billed by token). "subscription": shown, never counted, since a subscription is not billed by
	 * token; the item's turns and active time bound it instead.
	 */
	itemTokens: "budget" | "subscription";
}

export const CLAUDE: AcpProfile = {
	id: "claude", name: "Claude Code", command: ["wlp-claude-acp"], leftovers: "claude-agent-acp",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
	// Offered where the adapter is not root (the container's agent user is uid 1000) and the managed settings do not disable it.
	itemMode: "bypassPermissions", itemTokens: "subscription",
};

export const OPENCODE: AcpProfile = {
	id: "opencode", name: "OpenCode", command: ["wlp-opencode-acp"], leftovers: "opencode",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
	// Its permission config asks before edits and commands; an item's turn answers those itself (acp-harness.ts, `unattended`).
	itemMode: "build", itemTokens: "budget",
};

export const machineHarnesses = { claude: CLAUDE, opencode: OPENCODE };

/** A machine harness by its id, whatever harnesses this build has; null for Windlass and for an id it does not know. */
export function machineHarness(id: unknown): AcpProfile | null {
	return typeof id === "string" && Object.hasOwn(machineHarnesses, id) ? machineHarnesses[id as keyof typeof machineHarnesses] : null;
}

/** "windlass" or an id of `machineHarnesses`; null for anything else. */
export function knownHarness(id: unknown): HarnessId | null {
	return id === "windlass" ? "windlass" : machineHarness(id)?.id ?? null;
}

/** What a harness is called: "Windlass", "Claude Code". */
export function harnessName(id: HarnessId): string {
	return machineHarness(id)?.name ?? "Windlass";
}

export function initialHarnessModels(options?: HarnessOptions): ModelList {
	if (options) return { source: "harness", defaultModel: options.defaultModel, models: options.models, fetchedAt: options.checkedAt };
	return { source: "harness", defaultModel: "default", models: [{ id: "default", name: null, efforts: [] }], fetchedAt: null };
}

export function machineLoginMessage(profile: AcpProfile, machine: string): string {
	return `${profile.name} on “${machine}” is not signed in. Run windlass-runner login ${profile.id} there.`;
}

/** Why a work item cannot run this agent, by the machine's reported sign-in: only "token" is known to be signed in. */
export function itemSignInMessage(profile: AcpProfile, machine: string, signIn: "token" | "none" | "unknown"): string | null {
	if (signIn === "token") return null;
	if (signIn === "none") return machineLoginMessage(profile, machine);
	return `“${machine}” could not say whether ${profile.name} is signed in there, and a work item runs only where it is. Check that Docker runs there, or run windlass-runner login ${profile.id} there.`;
}
