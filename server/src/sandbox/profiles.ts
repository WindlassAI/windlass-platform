/**
 * The sandbox profiles and what each promises. In every profile the user's ChatGPT sign-in stays out of
 * the sandbox: a turn is handed a short-lived access token in a session-private file
 * (token-file.ts). `commandsCanReadAccessToken` says whether a command the agent runs can read that
 * file: not where Windlass sandboxes commands (its sandbox replaces /dev and hides the data directory), yes where commands
 * run directly in the container. web/src/api/mock.ts repeats these texts for the web app's mock.
 *
 * `PROFILES` is the list of a server on local Docker; `profilesFor` gives the list of either kind of
 * server, `e2bProfile` says what the E2B profile promises and why, and `e2bOpenProfile` what the
 * profile does in which the microVM is the only isolation.
 */

import type { EgressMode, HarnessId, SandboxProfile, SandboxProfileId, SessionMode, SessionSummary } from "../contract.js";
import { hostedNetworkSentence, hostedNetworkText } from "./e2b/network.js";
import { codexDefaultMode } from "./codex-modes.js";

export function cpuFlags(cpus: number) {
	return ["--cpu-shares", "256", "--cpus", String(cpus)];
}

/** Docker accepts an integer byte count, or an exact MiB count with the m suffix. */
export function resourceFlags(cpus: number, bytes = 1536 * 2 ** 20, pids = 512) {
	const memory = bytes % (2 ** 20) === 0 ? (bytes / 2 ** 20) + "m" : String(bytes);
	return ["--memory", memory, "--memory-swap", memory, ...cpuFlags(cpus), "--pids-limit", String(pids)];
}

export const commonRunFlags = (cpus: number, network = "bridge", memoryBytes?: number, pids?: number) => [
	"--init",
	"--user",
	"agent",
	"--security-opt",
	"no-new-privileges",
	"--cap-drop",
	"ALL",
	"--network",
	network,
	...resourceFlags(cpus, memoryBytes, pids),
	"--hostname",
	"sandbox",
];

export const COMMON_RUN_FLAGS = commonRunFlags(1);

export const PROFILES: SandboxProfile[] = [
	{
		id: "docker-windlass-sandbox",
		name: "Docker + Windlass sandbox",
		summary: "Windlass sandboxes each agent command inside this session's Docker container. Commands have no network and cannot read the session's access token. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. Your ChatGPT sign-in is never in the container.",
		layers: [
			"Docker container (Docker’s seccomp profile with namespace and mount calls allowed, non-root, no capabilities, resource limits)",
			"Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace and in a home of the session's own, credentials hidden)",
		],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: true,
	},
	{
		id: "docker-hardened",
		name: "Docker, hardened",
		summary: "Commands run directly in a container under Docker's default seccomp and AppArmor profiles. They have network access and can read the session's access token and its replacements during the turn. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. Your ChatGPT sign-in is never in the container.",
		layers: ["Docker container (default seccomp and AppArmor, non-root, no capabilities, resource limits)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadAccessToken: true,
		available: true,
	},
	// As a server on Docker lists it: it cannot be chosen there, so its fields promise nothing. `e2bProfile` is what a server on E2B offers.
	{
		id: "e2b",
		name: "E2B",
		summary: "A Firecracker microVM hosted by E2B.",
		layers: ["E2B microVM"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "This server runs its sandboxes on local Docker. E2B is built: a server started with WLP_SANDBOX=e2b, an E2B API key and the E2B template (docs/operating.md, \"E2B\") offers it in place of the Docker profiles, and says there what it promises.",
	},
	e2bOpenProfile({ offered: false, reason: "This server runs its sandboxes on local Docker; a server on E2B offers it where its operator sets WLP_E2B_OPEN_PROFILE=1." }),
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

/**
 * The `e2b` profile where the server is configured for E2B (WLP_SANDBOX=e2b). What it promises is what
 * holds whether or not Windlass's bubblewrap sandbox works inside an E2B microVM, which nobody has
 * tried yet (scripts/e2b-check.ts reports it):
 *
 *   approval "auto"   Windlass probes bubblewrap when it starts. Where the probe passes, commands run in
 *                     its sandbox; where it fails, Windlass sandboxes nothing and asks before every
 *                     command instead (its docs/troubleshooting.md, "The sandbox is unavailable").
 *                     Neither way does a command run unasked and unsandboxed, which "full" would allow
 *   commandNetwork, commandsCanReadAccessToken
 *                     true, the weaker promise: a command the user allowed to run outside the sandbox
 *                     has the microVM's network and can read the file, and without bubblewrap that is
 *                     every command
 *
 * `windlassSandbox: true` is for a deployment whose owner has seen the check pass and set
 * WLP_E2B_WINDLASS_SANDBOX=1: then the stronger promise of the first Docker profile is made, and
 * `E2bSandboxes.create` holds every new sandbox to it (it runs Windlass's own probe and removes a
 * sandbox in which it fails).
 */
export function e2bProfile(options: { windlassSandbox: boolean; network?: EgressMode }): SandboxProfile {
	const network = options.network ?? "open";
	if (options.windlassSandbox) {
		return {
			id: "e2b",
			name: "E2B + Windlass sandbox",
			summary:
				"Windlass sandboxes each agent command inside this session's E2B microVM. Commands have no network and cannot read the session's access token. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. Your ChatGPT sign-in is never in the microVM." + hostedNetworkSentence(network),
			layers: ["E2B microVM (Firecracker, hosted by E2B; commands run as a non-root user)", "Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace and in a home of the session's own, credentials hidden)"],
			approval: "auto",
			commandNetwork: false,
			commandsCanReadAccessToken: false,
			available: true,
		};
	}
	return {
		id: "e2b",
		name: "E2B",
		summary:
			"A microVM of its own, hosted by E2B. Windlass asks before running a command it cannot sandbox. If allowed, that command has network access and can read the session's access token and its replacements during the turn. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. Your ChatGPT sign-in is never in the microVM." + hostedNetworkSentence(network),
		layers: ["E2B microVM (Firecracker, hosted by E2B; commands run as a non-root user)"],
		approval: "auto",
		...hostedNetworkFields(network),
		commandsCanReadAccessToken: true,
		available: true,
	};
}

/** What a command with the microVM's network reaches, for the facts: as before network modes in `open`. */
function hostedNetworkFields(network: EgressMode): Pick<SandboxProfile, "commandNetwork" | "commandNetworkText"> {
	return network === "open" ? { commandNetwork: true } : { commandNetwork: network !== "none", commandNetworkText: hostedNetworkText(network) };
}

/**
 * `e2b-open`: an E2B microVM and nothing inside it. Windlass runs with approval "full", which sandboxes
 * no command and asks nothing (its approval/decide.ts), so a command has the microVM's network, a
 * writable home directory and the turn's access token file. Its fields are the same whether or not it
 * is offered: they say what a session launched with it gets, also after an operator stopped offering
 * it to new sessions.
 *
 * One thing "full" keeps: Windlass's taint rule (`taint: "enforce"`, its default). Once something from
 * the web or an MCP server is in the conversation, it treats commands as under "auto" again: they run
 * in its bubblewrap sandbox, which works in the template, and network or a write outside the workspace
 * asks first. Such a command gets a home of the session's own (turn.ts, `SANDBOX_HOME`): the microVM's
 * home as the commands before it left it, read-only, and what it adds kept beside it for the session.
 * The summary says so.
 */
export function e2bOpenProfile(options: ({ offered: true } | { offered: false; reason: string }) & { network?: EgressMode }): SandboxProfile {
	const network = options.network ?? "open";
	const reach = network === "open" ? "They can reach any host on the network" : network === "restricted" ? "They can reach the model API, GitHub and the hosts this deployment allows, and no other host" : "They can reach the model API and no other host";
	return {
		id: "e2b-open",
		name: "E2B, microVM only",
		summary:
			`Windlass initially runs agent commands directly in this session's E2B microVM without asking first. ${reach}, write outside the workspace and read the session's access token and its replacements during the turn. Setup finishes before the token arrives. Approved local MCP servers can read it and its replacements. Each token lasts about an hour from issue. Once something from the web or an MCP server is in the conversation, Windlass sandboxes commands again and asks before one uses the network or writes outside the workspace. Existing home files are then read-only, and new home files are kept apart for the session. Your ChatGPT sign-in is never in the microVM.`,
		layers: ["E2B microVM (Firecracker, hosted by E2B; commands run in it directly, as a non-root user)"],
		approval: "full",
		...hostedNetworkFields(network),
		commandsCanReadAccessToken: true,
		...(options.offered ? { available: true } : { available: false, unavailableReason: options.reason }),
	};
}

/** What a server on E2B says of `e2b-open` when WLP_E2B_OPEN_PROFILE is not set. */
export const OPEN_PROFILE_NOT_OFFERED = "This deployment does not offer it: its operator has not set WLP_E2B_OPEN_PROFILE=1.";

/**
 * Every profile, in the picker's order, as a server of this kind offers them. A deployment has one
 * provider: a server on Docker cannot reach E2B, and one on E2B makes no local containers, since a
 * container on one server machine is out of reach of the others.
 */
export function profilesFor(provider: "docker" | "e2b", e2b: { windlassSandbox: boolean; openProfile: boolean; network?: EgressMode } = { windlassSandbox: false, openProfile: false }): SandboxProfile[] {
	return PROFILES.map((profile): SandboxProfile => {
		if (provider === "e2b" && profile.id === "e2b") return e2bProfile(e2b);
		if (provider === "e2b" && profile.id === "e2b-open") return e2bOpenProfile({ ...(e2b.openProfile ? { offered: true as const } : { offered: false as const, reason: OPEN_PROFILE_NOT_OFFERED }), network: e2b.network });
		if (provider === "e2b" && (profile.id === "docker-hardened" || profile.id === "docker-windlass-sandbox")) {
			const { unavailableReason: _, ...rest } = profile;
			return { ...rest, layers: [...profile.layers], available: false, unavailableReason: "This deployment runs its sandboxes on E2B, so that every server machine can reach them; a local Docker container is out of reach of the other machines." };
		}
		return { ...profile, layers: [...profile.layers] };
	});
}

/** Windlass can always ask. Its other mode is the approval policy this profile was built for. */
export function windlassModes(approval: SandboxProfile["approval"]): SessionMode[] {
	return [
		{ id: "ask", name: "Ask", description: "Ask before writes, commands, network access and MCP calls." },
		approval === "auto"
			? { id: "auto", name: "Auto", description: "Use Windlass’s command sandbox and ask when needed." }
			: { id: "full", name: "Full", description: "Allow commands to run directly in the sandbox machine." },
	];
}

export function initialSessionModes(profile: SandboxProfileId, harness?: HarnessId, fixed = false, reported?: SessionMode[]): Pick<SessionSummary, "mode" | "availableModes"> {
	const approval = findProfile(profile).approval;
	const preferred = harness === "claude" ? "auto" : harness === "opencode" ? "build" : harness === "codex" ? codexDefaultMode(profile) : approval;
	const availableModes = reported ?? (fixed || (harness && harness !== "windlass") ? [] : windlassModes(approval));
	return {
		mode: availableModes.length && !availableModes.some(mode => mode.id === preferred) ? availableModes[0]!.id : preferred,
		availableModes,
	};
}

export function findProfile(id: SandboxProfileId): SandboxProfile {
	const profile = PROFILES.find((item) => item.id === id);
	if (profile === undefined) throw new Error(`unknown sandbox profile: ${String(id)}`);
	return profile;
}
