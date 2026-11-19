import type { SandboxProfile } from "../contract.js";
import type { Report } from "../runner/control.js";

/** The last report is the runner's account of its Docker daemon and probe, including while offline. */
export function machineProfiles(name: string, report: Report | null): SandboxProfile[] {
	if (!report) return [];
	const machine = `your machine "${name}"`;
	const layers = [`Your machine "${name}" (yours; the platform does not control it)`, "Docker container made by the runner (non-root, no capabilities, limits)"];
	const docker = !report.docker.ok ? report.docker.reason : null;
	const sandbox = docker ?? (!report.commandSandbox.ok ? report.commandSandbox.reason : null);
	const trust = "The platform does not control this machine. It receives the repository, the saved secrets you allow and a ChatGPT token that lasts about an hour. The checks and changes shown are what your machine reports.";
	return [
		{ id: "docker-windlass-sandbox", name: `Docker + Windlass sandbox on ${machine}`,
			summary: `The agent runs in a container on ${machine}. As far as its runner reports, Windlass sandboxes each command, with no network and the session's access token out of reach. ${trust}`,
			layers: [...layers, "Windlass's bubblewrap sandbox around each command (as the runner reports)"],
			approval: "auto", commandNetwork: false, commandsCanReadAccessToken: false, available: sandbox === null,
			...(sandbox !== null && { unavailableReason: sandbox }) },
		{ id: "docker-hardened", name: `Hardened Docker on ${machine}`,
			summary: `Commands run directly in a container on ${machine}, can reach its local network and can read the session's access token. ${trust}`,
			layers, approval: "full", commandNetwork: true, commandsCanReadAccessToken: true, available: docker === null,
			...(docker !== null && { unavailableReason: docker }) },
	];
}
