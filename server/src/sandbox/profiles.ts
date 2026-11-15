/**
 * The sandbox profiles and what each promises. In every profile the user's ChatGPT sign-in stays out of
 * the sandbox: a turn is handed a short-lived access token in a file in Windlass's data directory
 * (token-file.ts). `commandsCanReadAccessToken` says whether a command the agent runs can read that
 * file: not where Windlass sandboxes commands (its sandbox hides the data directory), yes where commands
 * run directly in the container. web/src/api/mock.ts repeats these texts for the web app's mock.
 */

import type { SandboxProfile, SandboxProfileId } from "../contract.js";

/** What every session container gets: non-root, no privilege gain, no capabilities, limits for a 2-CPU host. */
export const COMMON_RUN_FLAGS = [
	"--init",
	"--user",
	"agent",
	"--security-opt",
	"no-new-privileges",
	"--cap-drop",
	"ALL",
	"--network",
	"bridge",
	"--memory",
	"1536m",
	"--memory-swap",
	"1536m",
	"--cpus",
	"1.5",
	"--pids-limit",
	"512",
	"--hostname",
	"sandbox",
];

/** The extra `docker run` flags of each available profile. */
export const PROFILE_RUN_FLAGS: Partial<Record<SandboxProfileId, string[]>> = {
	// bubblewrap needs to create namespaces and mount /proc: Docker's seccomp and AppArmor profiles and
	// its masked /proc paths forbid that. Without them Windlass's own sandbox works inside the container.
	"docker-windlass-sandbox": ["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined", "--security-opt", "systempaths=unconfined"],
	"docker-hardened": [],
};

export const PROFILES: SandboxProfile[] = [
	{
		id: "docker-windlass-sandbox",
		name: "Docker + Windlass sandbox",
		summary: "A container of its own, and every command the agent runs is sandboxed again by Windlass: no network, and the session's access token is out of its reach. Your ChatGPT sign-in is never in the container.",
		layers: [
			"Docker container (non-root, no capabilities, resource limits)",
			"Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace, credentials hidden)",
		],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: true,
	},
	{
		id: "docker-hardened",
		name: "Docker, hardened",
		summary: "A container under Docker's default seccomp and AppArmor profiles; commands run directly in it, with network, and can read the session's access token, which lasts about an hour and cannot be renewed. Your ChatGPT sign-in is never in the container.",
		layers: ["Docker container (default seccomp and AppArmor, non-root, no capabilities, resource limits)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadAccessToken: true,
		available: true,
	},
	{
		id: "e2b",
		name: "E2B",
		summary: "A Firecracker microVM hosted by E2B.",
		layers: ["E2B microVM"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "Not built here yet: it needs an E2B provider in the sandbox layer, an E2B template with Windlass in it and an E2B account. Windlass no longer stands in the way: a session there would be handed a short-lived access token, as the Docker sessions are, and the sign-in would stay on the platform.",
	},
	{
		id: "daytona",
		name: "Daytona",
		summary: "A workspace hosted by Daytona.",
		layers: ["Daytona workspace"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "Not built here yet: it needs a Daytona provider in the sandbox layer, a Daytona image with Windlass in it and a Daytona account. Windlass no longer stands in the way: a session there would be handed a short-lived access token, as the Docker sessions are, and the sign-in would stay on the platform.",
	},
	{
		id: "firecracker",
		name: "Firecracker microVM",
		summary: "A microVM per session on this host.",
		layers: ["Firecracker microVM (KVM)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "Not built here: it needs a host with KVM, a guest image with Windlass in it and a guest agent to run commands in the VM, and this deployment has none of them. A session there would be handed a short-lived access token, as the Docker sessions are.",
	},
	{
		id: "agentos",
		name: "agentOS",
		summary: "Rivet's agentOS, where the agent's tools run through a remote execution interface.",
		layers: ["agentOS runtime"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "agentOS cannot run the Windlass executable, and Windlass's tools would have to work through agentOS's remote execution interface, which they do not. Handing a session an access token changes nothing about that.",
	},
];

export function findProfile(id: SandboxProfileId): SandboxProfile {
	const profile = PROFILES.find((item) => item.id === id);
	if (profile === undefined) throw new Error(`unknown sandbox profile: ${String(id)}`);
	return profile;
}
