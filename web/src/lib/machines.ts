/**
 * What a machine is called on the page. Its name is the host name its runner reported when it was
 * paired; a runner in a Docker container reports the container's id ("f892b469d6c5"), which reads as
 * something broke. Such a machine is called by what it is instead, its OS and architecture, with the
 * start of that id so two of them stay apart: "Linux arm64 machine (f892b4)".
 */

interface Described {
	name: string;
	os: string;
	arch: string;
}

export { isMachineIdName, machineLabel } from "@contract";
import { type EgressMode, type MachineSummary, type SandboxProfileId, isMachineIdName, isolationName } from "@contract";

/** "Strict" or "Open": a profile by its id alone, where no profile object is at hand (a saved default). */
export function machineProfileName(id: SandboxProfileId): string {
	return isolationName(id);
}

/** The host name the runner reported, where the label does not show it whole: shown beside the label, for finding the container. */
export function machineHostNote(machine: Described): string | null {
	const name = machine.name.trim();
	return name !== "" && isMachineIdName(name) ? name : null;
}

/** The most an owner may write of when to use a machine, and of its tags (server/src/machines/details.ts, `machineDetails`). */
export const MAX_WHEN_TO_USE = 500;
export const MAX_MACHINE_TAGS = 12;
const TAG = /^[a-z0-9][a-z0-9_-]{0,23}$/i;
/** Tags the runner reports itself: an owner's may not take their names. */
const RUNNER_TAGS = /^(os|arch|screenshots)$/i;

/** The tags as typed, split at commas and spaces, each once. */
export function tagsOf(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter(tag => tag !== ""))];
}

/** What the server would refuse in a machine's details, in a sentence; null when it takes them. */
export function machineDetailsProblem(whenToUse: string, tags: string[]): string | null {
	if (whenToUse.length > MAX_WHEN_TO_USE)
		return `Use at most ${MAX_WHEN_TO_USE} characters for when to use this machine.`;
	if (tags.length > MAX_MACHINE_TAGS) return `Use at most ${MAX_MACHINE_TAGS} tags; there are ${tags.length}.`;
	const reserved = tags.find(tag => RUNNER_TAGS.test(tag));
	if (reserved) return `“${reserved}” comes from the runner: OS, arch and screenshots are reported, not set.`;
	const bad = tags.find(tag => !TAG.test(tag));
	if (bad) return `“${bad}” is not a tag: letters, digits, - and _, at most 24, starting with a letter or digit.`;
	return null;
}

/**
 * Network reach of a process outside a per-command sandbox, including repository setup. `hosted`: a hosted sandbox of a
 * deployment with a network mode (`PlatformInfo.hostedEgress`). `domains`: a machine's count of allowed public hosts (`MachineSummary.egressDomains`).
 */
export function workspaceNetwork(egress?: EgressMode, hosted = false, domains?: number): string {
	if (hosted)
		switch (egress) {
			case "restricted":
				return "The workspace can reach only the model API, GitHub and the hosts this deployment allows.";
			case "none":
				return "The workspace can reach only the model API.";
		}
	switch (egress) {
		case "open":
			return "The workspace can reach the internet and the local network.";
		case "restricted":
			return domains
				? `The workspace can reach only the ${domains} public ${domains === 1 ? "host" : "hosts"} the owner allows, through the web proxy.`
				: "The workspace can reach public sites and hosts allowed by the owner through the web proxy.";
		case "none":
			return "The workspace has no direct outbound network access.";
		default:
			return "Network access follows the workspace’s network policy.";
	}
}

export function hardenedItemNote(machine: MachineSummary): string {
	if (machine.profiles.find(profile => profile.available)?.id !== "docker-hardened") return "";
	return (
		" It runs in Open isolation: commands run freely. " + workspaceNetwork(machine.egress, false, machine.egressDomains)
	);
}

/** Free disk in a sentence: "61 GB", "3.2 GB", "820 MB". */
export function diskSize(bytes: number): string {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1).replace(/\.0$/, "")} TB`;
	if (bytes >= 1e9)
		return `${bytes >= 1e10 ? Math.round(bytes / 1e9) : (bytes / 1e9).toFixed(1).replace(/\.0$/, "")} GB`;
	return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** The snapshot and Git mirror limits in force on a machine (`MachineSummary.storeLimits`). */
export function storeLimits(limits: NonNullable<MachineSummary["storeLimits"]>): string {
	return `${diskSize(limits.machine)} in all, ${diskSize(limits.user)} per user, keeps ${limits.free === 0 ? "no disk" : diskSize(limits.free)} free`;
}

/** How many sandboxes the machine's runner may run and keep, as its owner started it: "no limit" unless a cap is set. */
export function sandboxLimit(machine: MachineSummary): string {
	const caps = [
		machine.maxRunning === undefined ? null : `at most ${machine.maxRunning} running at once`,
		machine.maxSandboxes === undefined ? null : `at most ${machine.maxSandboxes} kept`,
	].filter(cap => cap !== null);
	return caps.length === 0 ? "no limit" : caps.join(", ");
}

/** Why the machine cannot relay the user's API keys yet, or null when it can. */
export function settingsKeyUpgrade(machine: MachineSummary) {
	return machine.harnesses?.some(h => !h.keyRelay) ? "Update the machine software to use your API keys here." : null;
}
