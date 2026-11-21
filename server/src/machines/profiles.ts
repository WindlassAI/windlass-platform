import type { SandboxProfile } from "../contract.js";
import { PROFILE_DENIED } from "../runner/protocol.js";
import type { Report } from "../runner/control.js";

/** The last report is the runner's account of its Docker daemon and probe, including while offline. */
export function machineProfiles(name: string | null | undefined, report: Report | null): SandboxProfile[] {
	const named = name ? ` "${name}"` : "";
	const machine = `your machine${named}`;
	const layers = [`Your machine${named} (yours; the platform does not control it)`, "Docker container made by the runner (non-root, no capabilities, limits)"];
	const docker = !report ? "The machine's report is unavailable." : report.docker.ok ? null : report.docker.reason;
	const ownerDenies = report?.allowedProfiles && !report.allowedProfiles.includes("docker-windlass-sandbox");
	const sandbox = ownerDenies ? PROFILE_DENIED : docker ?? (report && !report.commandSandbox.ok ? report.commandSandbox.reason : null);
	const trust = "The platform does not control this machine. It receives the repository, the saved secrets you allow and a ChatGPT token that lasts about an hour. The checks and changes shown are what your machine reports.";
	const mode = report?.egress ?? "open";
	const commandNetworkText = !report?.docker.ok ? "the runner has not verified command network access"
		: mode === "none" ? "commands have no network"
		: mode === "restricted" ? "commands can reach public sites and hosts allowed by the owner through the web proxy"
		: "commands can reach the internet and the local network";
	return [
		{ id: "docker-windlass-sandbox", name: `Docker + Windlass sandbox on ${machine}`,
			summary: `The agent runs in a container on ${machine}. As far as its runner reports, Windlass sandboxes each command, with no network and the session's access token out of reach. ${trust}`,
			layers: [...layers, "Windlass's bubblewrap sandbox around each command (as the runner reports)"],
			approval: "auto", commandNetwork: false, commandsCanReadAccessToken: false, available: sandbox === null,
			...(sandbox !== null && { unavailableReason: sandbox }) },
		{ id: "docker-hardened", name: `Hardened Docker on ${machine}`,
			summary: `Commands run directly in a container on ${machine} and can read the session's access token. With this network policy, ${commandNetworkText}. ${trust}`,
			layers, approval: "full", commandNetworkText, commandNetwork: mode !== "none", commandsCanReadAccessToken: true, available: docker === null,
			...(docker !== null && { unavailableReason: docker }) },
	];
}
