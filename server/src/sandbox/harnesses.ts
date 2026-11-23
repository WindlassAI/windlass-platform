import type { HarnessOptions, HarnessId, ModelList, SandboxProfileId } from "../contract.js";

export interface AcpProfile {
	id: Exclude<HarnessId, "windlass">;
	name: string;
	command: string[];
	leftovers: string;
	profiles: SandboxProfileId[];
	steering: string;
	signedOutCodes: number[];
	/**
	 * The profiles a work item may run this agent in, each with the mode its session starts in, every turn:
	 * one that never asks, since nobody answers an item's questions. The first is the one an item takes when
	 * its filing names none (`itemProfileOf`).
	 */
	itemModes: Partial<Record<SandboxProfileId, string>>;
	/**
	 * The profiles where the agent's commands run in its own sandbox and every request to leave it is refused
	 * (Codex on the Windlass sandbox profile). An item there does not "work without asking": a request ends
	 * the step (acp-harness.ts).
	 */
	sandboxedOn: SandboxProfileId[];
	/**
	 * How a work item counts the tokens this agent reports. "budget": against the item's token budget (an
	 * API key, billed by token). "subscription": shown, never counted, since a subscription is not billed by
	 * token; the item's turns and active time bound it instead. "sign-in": by the machine's sign-in method,
	 * kept on the item when it is filed (`itemTokensOf`).
	 */
	itemTokens: "budget" | "subscription" | "sign-in";
	/** With `itemTokens` "sign-in": the methods a work item may be filed with. The machine reports which it has. */
	itemSignIns?: readonly SignInMethod[];
	/**
	 * Whether a work item may run this agent. When false, filing one is refused (`itemHarnessProblem`), and
	 * an unattended turn is refused before the agent starts, so no permission is ever allowed in its name.
	 */
	items: boolean;
	/** Whether a Plan-first subtask may run this agent (`subtaskHarnessProblem`). Only where `items` is. */
	subtasks: boolean;
}

/** How a machine's Codex is signed in, as its runner reports it. */
export type SignInMethod = "api-key" | "chatgpt";

export const CLAUDE: AcpProfile = {
	id: "claude", name: "Claude Code", command: ["wlp-claude-acp"], leftovers: "claude-agent-acp",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
	// Offered where the adapter is not root (the container's agent user is uid 1000) and the managed settings do not disable it.
	itemModes: { "docker-hardened": "bypassPermissions" }, sandboxedOn: [], itemTokens: "subscription", items: true, subtasks: true,
};

export const OPENCODE: AcpProfile = {
	id: "opencode", name: "OpenCode", command: ["wlp-opencode-acp"], leftovers: "opencode",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
	// Its permission config asks before edits and commands; an item's turn answers those itself (acp-harness.ts, `unattended`).
	itemModes: { "docker-hardened": "build" }, sandboxedOn: [], itemTokens: "budget", items: true, subtasks: true,
};

export const CODEX: AcpProfile = {
	id: "codex", name: "Codex", command: ["wlp-codex-acp"], leftovers: "codex",
	profiles: ["docker-hardened","docker-windlass-sandbox"], steering: "_session/steering", signedOutCodes: [-32000],
	// Workspace access asks before anything outside Codex's sandbox, and on this profile every such request is
	// refused (codex-modes.ts); Container access asks nothing, the container being the boundary.
	itemModes: { "docker-windlass-sandbox": "workspace-write", "docker-hardened": "agent-full-access" },
	sandboxedOn: ["docker-windlass-sandbox"],
	// ChatGPT is a subscription. An API key bills by token, and Codex reports a turn's tokens (`promptUsage`),
	// but no API-key turn has been seen through the platform yet: ChatGPT only for now.
	itemTokens: "sign-in", itemSignIns: ["chatgpt"],
	items: true, subtasks: false,
};

export const machineHarnesses = { claude: CLAUDE, opencode: OPENCODE, codex: CODEX };

/** A machine harness by its id, whatever harnesses this build has; null for Windlass and for an id it does not know. */
export function machineHarness(id: unknown): AcpProfile | null {
	return typeof id === "string" && Object.hasOwn(machineHarnesses, id) ? machineHarnesses[id as keyof typeof machineHarnesses] : null;
}

/** Names joined for a sentence: "Windlass, Claude Code or OpenCode". */
const anyOf = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0] ?? "";

/** Why a work item cannot run this agent, or null when it can. Windlass always can. */
export function itemHarnessProblem(id: HarnessId): string | null {
	const machine = machineHarness(id);
	if (!machine || machine.items) return null;
	return `Work items run ${anyOf(["Windlass", ...Object.values(machineHarnesses).filter(h => h.items).map(h => h.name)])} for now. Start a ${machine.name} session instead.`;
}

/** Why a Plan-first subtask cannot run this agent, or null when it can. */
export function subtaskHarnessProblem(id: HarnessId): string | null {
	const machine = machineHarness(id);
	if (!machine || machine.subtasks) return itemHarnessProblem(id);
	return `Plan-first subtasks run ${anyOf(["Windlass", ...Object.values(machineHarnesses).filter(h => h.subtasks).map(h => h.name)])} for now. ${machine.name} runs Quick items only.`;
}

/** The profiles a work item may run a machine harness in; the first is its default. */
export function itemProfiles(id: HarnessId): SandboxProfileId[] {
	return Object.keys(machineHarness(id)?.itemModes ?? {}) as SandboxProfileId[];
}

/** The mode an item's session of a machine harness runs in on a profile; undefined for Windlass or a profile it has none for. */
export function itemModeOf(id: HarnessId | undefined, profile: SandboxProfileId): string | undefined {
	return machineHarness(id)?.itemModes[profile];
}

/** Why a work item cannot run this agent in this profile, or null when it can. Windlass is the profile's to judge. */
export function itemProfileProblem(id: HarnessId, profile: SandboxProfileId): string | null {
	const machine = machineHarness(id);
	if (!machine || itemModeOf(id, profile) !== undefined) return null;
	const names: Record<string, string> = { "docker-hardened": "“Docker, hardened”", "docker-windlass-sandbox": "“Docker + Windlass sandbox”" };
	return `A work item runs ${machine.name} only on ${anyOf(itemProfiles(id).map(p => names[p] ?? p)).replace(/ or /, " or on ")}.`;
}

/** A sign-in method in words. */
export const signInWords = (method: SignInMethod | undefined) => method === "api-key" ? "an API key" : method === "chatgpt" ? "ChatGPT" : "a method it did not report";

/**
 * Why a work item cannot be filed with the machine's sign-in method: only where its tokens are counted by
 * sign-in (`itemTokens` "sign-in"), and the method is not one of `itemSignIns`. Null where it can.
 */
export function itemSignInMethodProblem(profile: AcpProfile, machine: string, method: SignInMethod | undefined): string | null {
	if (profile.itemTokens !== "sign-in" || (method && profile.itemSignIns?.includes(method))) return null;
	const allowed = (profile.itemSignIns ?? []).map(signInWords);
	return `${profile.name} on “${machine}” signs in with ${signInWords(method)}, and its work items run only with ${anyOf(allowed)} sign-in for now. Run windlass-runner login ${profile.id} there and choose ${anyOf(allowed)}, or start a ${profile.name} session instead.`;
}

/**
 * Why an item's turn cannot run on the machine's sign-in method now: the item was filed with another, and
 * its tokens would be counted differently from then on. Never switched silently. Null where it is the same.
 */
export function itemSignInChanged(profile: AcpProfile, machine: string, filed: SignInMethod | undefined, now: SignInMethod | undefined): string | null {
	if (profile.itemTokens !== "sign-in" || filed === undefined || filed === now) return null;
	return `${profile.name} on “${machine}” now signs in with ${signInWords(now)}, not ${signInWords(filed)} as when this item was filed. File the work again.`;
}

/** How an item counts its agent's tokens, by the sign-in method it was filed with where that decides. */
export function itemTokensOf(profile: AcpProfile, signIn: SignInMethod | undefined): "budget" | "subscription" {
	if (profile.itemTokens !== "sign-in") return profile.itemTokens;
	return signIn === "chatgpt" ? "subscription" : "budget";
}

/** "windlass" or an id of `machineHarnesses`; null for anything else. */
export function knownHarness(id: unknown): HarnessId | null {
	return id === "windlass" ? "windlass" : machineHarness(id)?.id ?? null;
}

/** What a harness is called: "Windlass", "Claude Code". */
export function harnessName(id: HarnessId): string {
	return machineHarness(id)?.name ?? "Windlass";
}

/**
 * Whether the agent takes Windlass's marker for outside text (`_meta["windlass/untrusted"]`, factory/untrusted.ts):
 * only Windlass does. Claude Code, OpenCode and Codex get the labelled prompt only.
 */
export function takesUntrustedMarker(id: HarnessId | undefined): boolean {
	return machineHarness(id) === null;
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
 * nobody answers an item's questions (`itemModes`), except where its commands run in its own sandbox and
 * a request to leave it ends the step (`sandboxedOn`). Windlass asks before what its sandbox cannot contain.
 * A subtask runs on "Docker, hardened", the default here.
 */
export function worksWithoutAsking(id: HarnessId | undefined, profile: SandboxProfileId = "docker-hardened"): boolean {
	const machine = machineHarness(id);
	return machine?.items === true && machine.itemModes[profile] !== undefined && !machine.sandboxedOn.includes(profile);
}
