import type { SandboxProfile } from "../contract.js";
import { PROFILE_DENIED } from "../runner/protocol.js";
import type { Report } from "../runner/control.js";
import { relayPlaceholderSentences } from "../sandbox/profiles.js";
import { config } from "../config.js";
import { ISOLATION_LINES, ISOLATION_NAMES, openLine } from "../contract/isolation.js";

/** The last report is the runner's account of its Docker daemon and probe, including while offline. */
export function machineProfiles(name: string | null | undefined, report: Report | null): SandboxProfile[] {
	const named = name ? ` "${name}"` : "";
	const machine = `your machine${named}`;
	const layers = [
		`Your machine${named} (yours; the platform does not control it)`,
		"Docker container made by the runner (non-root, no capabilities, limits)",
	];
	const docker = !report ? "The machine's report is unavailable." : report.docker.ok ? null : report.docker.reason;
	const ownerDenies = report?.allowedProfiles && !report.allowedProfiles.includes("docker-windlass-sandbox");
	const sandbox = ownerDenies
		? PROFILE_DENIED
		: (docker ?? (report && !report.commandSandbox.ok ? report.commandSandbox.reason : null));
	// The runner said `modelRelay` (its sandbox image's Windlass reads the relay's address): the token is in the machine's relay container, not the session's.
	const relay = report?.modelRelay === true && config.modelRelay.on;
	const trust = relay
		? "The platform does not control this machine. It receives the repository, the saved secrets you allow and a ChatGPT token for the turn, which the runner keeps in its model relay outside the session's container. The checks and changes shown are what your machine reports."
		: "The platform does not control this machine. It receives the repository, the saved secrets you allow and a ChatGPT token for the turn. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. The checks and changes shown are what your machine reports.";
	const mode = report?.egress ?? "open";
	const commandNetworkText = !report?.docker.ok
		? "the runner has not verified command network access"
		: mode === "none"
			? "commands have no network"
			: mode === "restricted" && report.egressDomains
				? `commands can reach only the ${report.egressDomains} public ${report.egressDomains === 1 ? "host" : "hosts"} the owner allows, through the web proxy`
				: mode === "restricted"
					? "commands can reach public sites and hosts allowed by the owner through the web proxy"
					: "commands can reach the internet and the local network";
	return [
		{
			id: "docker-windlass-sandbox",
			name: ISOLATION_NAMES.strict,
			summary: ISOLATION_LINES.strict,
			details: relay
				? `The agent runs in a container on ${machine}. As far as its runner reports, Windlass sandboxes each command, so commands have no network and cannot read the session's token file. ${relayPlaceholderSentences("Approved local MCP servers and processes left from setup", "container")} ${trust}`
				: `The agent runs in a container on ${machine}. As far as its runner reports, Windlass sandboxes each command, so commands have no network and cannot read the session's access token. ${trust}`,
			layers: [...layers, "Windlass's bubblewrap sandbox around each command (as the runner reports)"],
			approval: "auto",
			commandNetwork: false,
			commandsCanReadAccessToken: false,
			...(relay && { modelRelay: true as const }),
			available: sandbox === null,
			...(sandbox !== null && { unavailableReason: sandbox }),
		},
		{
			id: "docker-hardened",
			name: ISOLATION_NAMES.open,
			summary: openLine(mode),
			details: relay
				? `Commands run directly in a container on ${machine}.${report?.sessionVolumes ? " The session has a data directory of its own, so they cannot read your other sessions' conversations." : ""} ${relayPlaceholderSentences("Commands", "container")} With this network policy, ${commandNetworkText}. ${trust}`
				: `Commands run directly in a container on ${machine} and can read the session's access token and its replacements during the turn.${report?.sessionVolumes ? " The session has a data directory of its own, so they cannot read your other sessions' conversations." : ""} With this network policy, ${commandNetworkText}. ${trust}`,
			layers: report?.sessionVolumes
				? [layers[0]!, layers[1]!.replace(/\)$/, ", a data directory of the session's own)")]
				: layers,
			approval: "full",
			...(report?.claudeRelay && { claudeRelay: true }),
			commandNetworkText,
			commandNetwork: mode !== "none",
			commandsCanReadAccessToken: true,
			...(relay && { modelRelay: true as const }),
			available: docker === null,
			...(docker !== null && { unavailableReason: docker }),
		},
	];
}
