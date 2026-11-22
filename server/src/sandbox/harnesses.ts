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
	/**
	 * Whether a work item may run this agent. When false, filing one is refused (`itemHarnessProblem`), and
	 * an unattended turn is refused before the agent starts, so no permission is ever allowed in its name.
	 */
	items: boolean;
}

export const CLAUDE: AcpProfile = {
	id: "claude", name: "Claude Code", command: ["wlp-claude-acp"], leftovers: "claude-agent-acp",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
	// Offered where the adapter is not root (the container's agent user is uid 1000) and the managed settings do not disable it.
	itemMode: "bypassPermissions", itemTokens: "subscription", items: true,
};

export const OPENCODE: AcpProfile = {
	id: "opencode", name: "OpenCode", command: ["wlp-opencode-acp"], leftovers: "opencode",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
	// Its permission config asks before edits and commands; an item's turn answers those itself (acp-harness.ts, `unattended`).
	itemMode: "build", itemTokens: "budget", items: true,
};

export const CODEX: AcpProfile = {
	id: "codex", name: "Codex", command: ["wlp-codex-acp"], leftovers: "codex",
	profiles: ["docker-hardened","docker-windlass-sandbox"], steering: "_session/steering", signedOutCodes: [-32000],
	// Not offered for work items yet: these are inert. Read-only asks before anything outside Codex's sandbox,
	// and it signs in with ChatGPT, a subscription, so its tokens would be shown, not counted.
	itemMode: "read-only", itemTokens: "subscription", items: false,
};

export const machineHarnesses = { claude: CLAUDE, opencode: OPENCODE, codex: CODEX };

/** A machine harness by its id, whatever harnesses this build has; null for Windlass and for an id it does not know. */
export function machineHarness(id: unknown): AcpProfile | null {
	return typeof id === "string" && Object.hasOwn(machineHarnesses, id) ? machineHarnesses[id as keyof typeof machineHarnesses] : null;
}

/** Why a work item cannot run this agent, or null when it can. Windlass always can. */
export function itemHarnessProblem(id: HarnessId): string | null {
	const machine = machineHarness(id);
	if (!machine || machine.items) return null;
	const names = ["Windlass", ...Object.values(machineHarnesses).filter(h => h.items).map(h => h.name)];
	const listed = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
	return `Work items run ${listed} for now. Start a ${machine.name} session instead.`;
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

/**
 * Whether a work item's agent works without asking: every machine harness a work item may run does, since
 * nobody answers an item's questions (`itemMode`). Windlass asks before what its sandbox cannot contain.
 */
export function worksWithoutAsking(id: HarnessId | undefined): boolean {
	return machineHarness(id)?.items === true;
}
