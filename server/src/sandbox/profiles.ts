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
		summary: "A container of its own, and every command the agent runs is sandboxed again by Windlass: no network, and the sign-in is out of its reach.",
		layers: [
			"Docker container (non-root, no capabilities, resource limits)",
			"Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace, credentials hidden)",
		],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadLogin: false,
		available: true,
	},
	{
		id: "docker-hardened",
		name: "Docker, hardened",
		summary: "A container under Docker's default seccomp and AppArmor profiles; commands run directly in it, with network, and can read the sign-in kept there.",
		layers: ["Docker container (default seccomp and AppArmor, non-root, no capabilities, resource limits)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadLogin: true,
		available: true,
	},
	{
		id: "e2b",
		name: "E2B",
		summary: "A Firecracker microVM hosted by E2B.",
		layers: ["E2B microVM"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason:
			"A hosted VM cannot share the user's sign-in volume, so Windlass would have to accept a short-lived token handed in from outside, which it does not do yet.",
	},
	{
		id: "daytona",
		name: "Daytona",
		summary: "A workspace hosted by Daytona.",
		layers: ["Daytona workspace"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason:
			"A hosted workspace cannot share the user's sign-in volume, so Windlass would have to accept a short-lived token handed in from outside, which it does not do yet.",
	},
	{
		id: "firecracker",
		name: "Firecracker microVM",
		summary: "A microVM per session on this host.",
		layers: ["Firecracker microVM (KVM)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason: "It needs a host with KVM and a guest agent to run commands in the VM, and this deployment has neither.",
	},
	{
		id: "agentos",
		name: "agentOS",
		summary: "Rivet's agentOS, where the agent's tools run through a remote execution interface.",
		layers: ["agentOS runtime"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadLogin: false,
		available: false,
		unavailableReason:
			"agentOS cannot run the Windlass executable, and Windlass's tools would have to work through agentOS's remote execution interface, which they do not.",
	},
];

export function findProfile(id: SandboxProfileId): SandboxProfile {
	const profile = PROFILES.find((item) => item.id === id);
	if (profile === undefined) throw new Error(`unknown sandbox profile: ${String(id)}`);
	return profile;
}
