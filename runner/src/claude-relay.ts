import { createHash, createPublicKey, randomBytes, sign } from "node:crypto";
import { docker, LABEL, LABEL_ARG } from "../../server/src/sandbox/docker.js";
import { image, type MachineDocker } from "./policy.js";
import { loadPair, Refusal, RunnerError } from "./state.js";

declare const CLAUDE_RELAY_SCRIPT: string;
const role = LABEL + ".credential-relay";
const gatewayMode = "com.docker.network.bridge.gateway_mode_ipv4";
export const relayUrl = "http://wlp-relay:8080";
const names = (m: MachineDocker) => ({ relay: "wlp-claude-relay-" + m.identity.machineId, network: "wlp-claude-net-" + m.identity.machineId });
const flags = (m: MachineDocker) => ["--label", LABEL_ARG, ...m.pairingLabelFlags, "--label", role + "=1"];

function owned(labels: Record<string, string> | null, m: MachineDocker) {
	return labels?.[LABEL] === "1" && labels[role] === "1" && Object.entries(m.labels).every(([k, v]) => labels[k] === v);
}

// A missing object is normal. A daemon or permissions failure must never authorize adoption.
async function inspect(kind: "network" | "container", name: string) {
	const result = await docker([kind, "inspect", name], { timeoutMs: 15_000 });
	if (result.code === 0) return JSON.parse(result.stdout)[0];
	if (/no such (network|container|object)|network .* not found/i.test(result.stderr)) return;
	throw new RunnerError("Docker could not inspect the Claude relay.");
}

async function ownedRelay(m: MachineDocker) {
	const box = await inspect("container", names(m).relay);
	if (box && !owned(box.Config.Labels, m)) throw new Refusal("The Claude relay container belongs to a different pairing.");
	return box;
}

// Call under the login lock, including logout from a standalone runner command.
export async function removeRelay(m: MachineDocker) {
	const box = await ownedRelay(m);
	if (box) await docker(["rm", "-f", box.Id], { check: true });
}
export async function removeRelayNetwork(m: MachineDocker) {
	const net = await inspect("network", names(m).network);
	if (!net) return;
	if (!owned(net.Labels, m)) throw new Refusal("The Claude relay network belongs to a different pairing.");
	await docker(["network", "rm", net.Id], { check: true });
}

// The old image gave every session a volume reference. Preserve its workspace, but stop
// the process before replacing the token. Docker cannot detach a container's volume.
export async function stopLegacyClaude(m: MachineDocker) {
	const running = await docker(["ps", "-q", "--filter", "volume=" + m.claudeVolume, "--filter", "label=" + LABEL + ".harness=claude", "--filter", "label=" + LABEL + ".session",
		...Object.entries(m.labels).flatMap(([k, v]) => ["--filter", "label=" + k + "=" + v])], { check: true });
	for (const id of running.stdout.trim().split(/\s+/).filter(Boolean))
		await docker(["stop", "-t", "1", id], { check: true });
}

/** Caller holds the login-volume lock. The internal network carries session-to-relay traffic.
 * The sandbox keeps its ordinary egress interface, and only the relay has its own TLS uplink. */
export async function ensureRelay(m: MachineDocker) {
	const pair = loadPair();
	if (!pair?.key || pair.current.machineId !== m.identity.machineId || pair.current.uid !== m.identity.uid)
		throw new Refusal("The machine pairing changed while preparing the Claude relay.");
	await m.ownedVolume(true, m.claudeVolume);
	await m.ensureImage();
	const { network, relay } = names(m);
	let net = await inspect("network", network);
	if (!net) {
		await docker(["network", "create", "--internal", "--driver", "bridge", "--ipv6=false", "--opt", gatewayMode + "=isolated", ...flags(m), network], { check: true });
		net = await inspect("network", network);
	}
	if (!net?.Internal || net.Driver !== "bridge" || net.EnableIPv6 || net.Options?.[gatewayMode] !== "isolated" || !owned(net.Labels, m))
		throw new Refusal("The Claude relay requires an isolated internal bridge owned by this pairing.");

	const version = createHash("sha256").update(CLAUDE_RELAY_SCRIPT).digest("hex");
	const publicKey = createPublicKey(pair.key).export({ format: "der", type: "spki" }).toString("base64");
	let box = await ownedRelay(m);
	if (box && (!box.NetworkSettings.Networks[network] || box.Config.Labels[role + ".version"] !== version || box.Config.Image !== image ||
		!box.Config.Env.includes("WLP_CLAUDE_RELAY_PUBLIC_KEY=" + publicKey))) {
		await docker(["rm", "-f", box.Id], { check: true }); box = undefined;
	}
	if (!box) {
		await docker(["create", "--pull", "never", "--name", relay, ...flags(m), "--label", role + ".version=" + version,
			"--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
			"--log-driver", "none", "--memory", "192m", "--pids-limit", "48",
			"--network", network, "--network-alias", "wlp-relay",
			"--mount", `type=volume,src=${m.claudeVolume},dst=/run/wlp-harness/claude,readonly,volume-nocopy`,
			"-e", "WLP_CLAUDE_RELAY_PUBLIC_KEY=" + publicKey, "-e", "WLP_CLAUDE_RELAY_MACHINE=" + m.identity.machineId,
			image, "node", "-e", CLAUDE_RELAY_SCRIPT], { check: true });
		box = await ownedRelay(m);
	}
	// Docker supports adding the default bridge to an existing container. Combining it
	// with a user-defined network in 'docker run' is rejected by the CLI.
	if (!box.NetworkSettings.Networks.bridge) await docker(["network", "connect", "bridge", box.Id], { check: true });
	if (!box.State.Running) await docker(["start", box.Id], { check: true });
	return { network, key: pair.key };
}

export async function prepareRelay(m: MachineDocker) {
	const { network, key } = await ensureRelay(m);
	const nonce = randomBytes(16).toString("hex");
	const signature = sign(null, Buffer.from("windlass-claude-relay-v1\n" + m.identity.machineId + "\n" + nonce), key);
	return {
		env: ["-e", "ANTHROPIC_BASE_URL=" + relayUrl, "-e", "CLAUDE_CODE_OAUTH_TOKEN=" + nonce + "." + signature.toString("base64url")],
		attach: async (name: string) => {
			await docker(["network", "connect", "--alias", "cc-" + nonce + ".invalid", network, name], { check: true });
		},
	};
}
