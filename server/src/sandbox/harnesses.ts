import type { HarnessId, ModelList, SandboxProfileId } from "../contract.js";

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

export function initialHarnessModels(): ModelList {
	return { source: "harness", defaultModel: "default", models: [{ id: "default", name: null, efforts: [] }], fetchedAt: null };
}

export function machineLoginMessage(profile: AcpProfile, machine: string): string {
	return `${profile.name} on “${machine}” is not signed in. Run windlass-runner login ${profile.id} there.`;
}
