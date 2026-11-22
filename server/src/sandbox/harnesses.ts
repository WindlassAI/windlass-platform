import type { HarnessOptions, HarnessId, ModelList, SandboxProfileId } from "../contract.js";

export interface AcpProfile {
	id: Exclude<HarnessId, "windlass">;
	name: string;
	command: string[];
	leftovers: string;
	profiles: SandboxProfileId[];
	steering: string;
	signedOutCodes: number[];
}

export const CLAUDE: AcpProfile = {
	id: "claude", name: "Claude Code", command: ["wlp-claude-acp"], leftovers: "claude-agent-acp",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
};

export const OPENCODE: AcpProfile = {
	id: "opencode", name: "OpenCode", command: ["wlp-opencode-acp"], leftovers: "opencode",
	profiles: ["docker-hardened"], steering: "_session/steering", signedOutCodes: [-32000],
};

export const CODEX: AcpProfile = {
	id: "codex", name: "Codex", command: ["wlp-codex-acp"], leftovers: "codex",
	profiles: ["docker-hardened","docker-windlass-sandbox"], steering: "_session/steering", signedOutCodes: [-32000],
};

export const machineHarnesses = { claude: CLAUDE, opencode: OPENCODE, codex: CODEX };

export function initialHarnessModels(options?: HarnessOptions): ModelList {
	if (options) return { source: "harness", defaultModel: options.defaultModel, models: options.models, fetchedAt: options.checkedAt };
	return { source: "harness", defaultModel: "default", models: [{ id: "default", name: null, efforts: [] }], fetchedAt: null };
}

export function machineLoginMessage(profile: AcpProfile, machine: string): string {
	return `${profile.name} on “${machine}” is not signed in. Run windlass-runner login ${profile.id} there.`;
}
