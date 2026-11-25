import { type EgressMode, NETWORK_PRESETS } from "../contract.js";

/** Windlass's engine sends its model requests here (light-harness packages/core/src/provider/openai-responses.ts, RESPONSES_BASE_URL). */
export const MODEL_HOSTS: readonly string[] = ["api.openai.com"];

export const PRESETS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(NETWORK_PRESETS.map((preset) => [preset.id, preset.hosts]));
/** E2B's network configuration is one request; a long list is a sign of a mistake. Every host a sandbox may reach counts: the platform's, the deployment's and a repository's. */
export const MAX_HOSTS = 64;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** An exact DNS name, lower case, with no trailing dot: at least two labels, the last not all digits (no address). */
export function isHostName(host: string): boolean {
	const labels = host.split(".");
	return host.length <= 253 && labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels.at(-1)!);
}

/** What a command with the microVM's network reaches, in the words of the profiles' facts (web Layers.tsx `commandNetworkFact`). */
export function hostedNetworkText(mode: EgressMode): string {
	switch (mode) {
		case "open": return "commands can reach the network";
		case "restricted": return "commands can reach only the model API, GitHub and the hosts this deployment allows";
		case "none": return "commands can reach only the model API";
	}
}

/** The same, as a sentence for a profile's summary. */
export function hostedNetworkSentence(mode: EgressMode): string {
	switch (mode) {
		case "open": return "";
		case "restricted": return " This deployment limits the microVM's network to the model API, GitHub and the hosts its operator allows; every other host is refused.";
		case "none": return " This deployment gives the microVM no network but the model API, so a session here cannot have a repository.";
	}
}

/** Refused at launch and when a turn starts, as `OFFLINE_REPOSITORY` is on a machine with --egress none. */
export const HOSTED_OFFLINE_REPOSITORY = "This deployment's hosted sandboxes have no network for repositories (WLP_E2B_NETWORK=none). Start the session without a repository, or on a machine of yours.";
