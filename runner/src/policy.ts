import { spawn } from "node:child_process";
import type { MachineSlotCapacity } from "../../server/src/contract.js";
import type { Args } from "../../server/src/runner/protocol.js";
import { LABEL, LABEL_ARG, MACHINE_LABEL, NO_LOGS, createVolume, docker, removeVolume, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { DOCKER_BWRAP_PROBE, PROFILE_RUN_FLAGS } from "../../server/src/sandbox/docker-flags.js";
import { COMMON_RUN_FLAGS } from "../../server/src/sandbox/profiles.js";
import { DATA_DIR } from "../../server/src/sandbox/provider.js";
import { Refusal, RunnerError, type Identity } from "./state.js";

declare const SANDBOX_IMAGE: string;
declare const SHOTS_IMAGE_PIN: string;
declare const HARNESS_IMAGES: Partial<Record<MachineHarness, string>>;
export type MachineHarness = NonNullable<Args<"create">["harness"]>;
export const harnessImage = (id: MachineHarness) => HARNESS_IMAGES[id];
export const shotsImage = SHOTS_IMAGE_PIN;
export const image = SANDBOX_IMAGE;
export const imagePins = () => ({ sandbox: image, "sandbox-shots": shotsImage, ...HARNESS_IMAGES });
export const bubblewrap = "docker-windlass-sandbox";
export type Profile = Args<"create">["profile"];

// The machine belongs to its owner, so the platform sets no default sandbox limits.
export type Limits = { slots?: MachineSlotCapacity | null; maxTurns?: number; maxRunning?: number; maxSandboxes?: number };
// The Docker name distinguishes Claude containers. The platform keeps the original sandbox id across upgrades.
export const externalId = (machine: string, raw: string) => `m${machine}-${raw.replace(/^(?:claude|opencode)-/, "")}`;
export function rawId(machine: string, id: string) {
	const prefix = externalId(machine, "");
	const raw = id.slice(prefix.length);
	if (!id.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(raw)) throw new Refusal("This sandbox id does not belong to this machine.");
	return raw;
}

function imageRole(pin: string) {
	if (pin === image) return "sandbox";
	if (pin === shotsImage) return "screenshots";
	if (pin === harnessImage("claude")) return "Claude Code";
	return "OpenCode";
}

async function pullImage(pin: string, platform: string, progress: boolean) {
	const child = spawn("docker", ["pull", "--platform", platform, pin], { stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000, killSignal: "SIGKILL" });
	let diagnostic = "";
	for (const output of [child.stdout, child.stderr]) {
		output.on("data", (chunk: Buffer) => {
			diagnostic = (diagnostic + chunk.toString()).slice(-8192);
			if (progress) process.stderr.write(chunk);
		});
	}
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (code === 0) return;
	if (/no matching manifest|no match for platform|does not match the specified platform|does not provide the specified platform/i.test(diagnostic))
		throw new RunnerError(`This runner release has no ${platform} images (${imageRole(pin)}).`);
	throw new RunnerError(`The pinned ${imageRole(pin)} image is missing and could not be pulled.`);
}

async function daemonPlatform() {
	const result = await docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], { timeoutMs: 10_000 });
	const platform = result.stdout.trim();
	if (result.code !== 0 || !/^linux\/[a-z0-9_]+$/.test(platform))
		throw new RunnerError("Could not determine the Linux Docker daemon architecture.");
	return platform;
}

async function fetchImage(pin: string, mode: "setup" | "run" | "session" = "session", platform?: string) {
	const cached = await docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", pin]);
	if (!pin.includes("@")) {
		if (cached.code !== 0) throw new RunnerError(`The pinned ${imageRole(pin)} image is missing and could not be pulled.`);
		return;
	}
	platform ??= await daemonPlatform();
	if (cached.code === 0 && cached.stdout.trim() === platform) return;
	if (mode !== "run") return pullImage(pin, platform, mode === "setup");
	// A service started without setup only needs the index to check compatibility.
	const manifest = await docker(["manifest", "inspect", pin], { timeoutMs: 30_000 });
	if (manifest.code !== 0) throw new RunnerError(`Could not inspect the pinned ${imageRole(pin)} image index.`);
	const entries: { platform?: { os: string; architecture: string } }[] | undefined = JSON.parse(manifest.stdout).manifests;
	// A locally assembled runner can also refer directly to a single image manifest.
	if (!entries) return pullImage(pin, platform, false);
	if (!entries.some(entry => entry.platform && entry.platform.os + "/" + entry.platform.architecture === platform))
		throw new RunnerError(`This runner release has no ${platform} images (${imageRole(pin)}).`);
}

export async function prepareImages(agents: MachineHarness[], screenshots: boolean, mode: "setup" | "run") {
	const pins = [image, ...agents.map(id => harnessImage(id)!), ...(screenshots ? [shotsImage] : [])];
	const platform = pins.some(pin => pin.includes("@")) ? await daemonPlatform() : undefined;
	for (const pin of new Set(pins)) {
		if (mode === "setup" || pin.includes("@")) await fetchImage(pin, mode, platform);
	}
}

export class MachineDocker {
	readonly labels: Record<string, string>;
	readonly volume: string;
	readonly claudeVolume: string;
	readonly opencodeVolume: string;
	constructor(readonly identity: Identity) {
		this.labels = { [MACHINE_LABEL]: identity.machineId, [LABEL + ".uid"]: identity.uid };
		this.opencodeVolume = "wlp-harness-opencode-" + identity.machineId;
		this.claudeVolume = "wlp-harness-claude-" + identity.machineId;
		this.volume = "wlp-machine-" + identity.machineId;
	}
	async ownedVolume(create: boolean, name = this.volume) {
		const volumes = await docker(["volume", "ls", "-q", "--filter", "name=" + name], { check: true });
		if (!volumes.stdout.trim().split("\n").includes(name)) {
			if (!create) return false;
			await createVolume(name, this.labels);
		}
		const [v] = JSON.parse((await docker(["volume", "inspect", name], { check: true })).stdout);
		if (v.Driver !== "local" || Object.keys(v.Options ?? {}).length || v.Labels?.[LABEL] !== "1" ||
			Object.entries(this.labels).some(([k, value]) => v.Labels[k] !== value))
			throw new Refusal("The data volume must be a plain local volume owned by this machine.");
		return true;
	}
	async dropVolume(name = this.volume) {
		if (await this.ownedVolume(false, name)) await removeVolume(name);
	}
	get pairingLabelFlags() {
		return Object.entries(this.labels).flatMap(([k, v]) => ["--label", k + "=" + v]);
	}
	private flags(name: string, profile: Profile) {
		return ["--rm", "--name", name, "--label", LABEL_ARG, ...this.pairingLabelFlags, "--pull", "never", ...NO_LOGS, ...COMMON_RUN_FLAGS, ...PROFILE_RUN_FLAGS[profile]!];
	}
	private helper(argv: string[], mount = false) {
		const name = tmpName();
		return runHelper([...this.flags(name, "docker-hardened"),
			...(mount ? ["--mount", `type=volume,src=${this.volume},dst=/data,volume-nocopy`] : [])], name, argv, { image });
	}
	private preparing = new Map<string, Promise<void>>();
	ensureImage(pin = image) {
		const pending = this.preparing.get(pin);
		if (pending) return pending;
		const fetch = fetchImage(pin).finally(() => this.preparing.delete(pin));
		this.preparing.set(pin, fetch);
		return fetch;
	}
	async disk() {
		const result = await this.helper(["df", "-B1", "--output=avail", "/workspace"]);
		const bytes = Number(result.stdout.trim().split("\n")[1]);
		if (result.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 0) throw new RunnerError("Could not measure free space on Docker's sandbox filesystem.");
		return bytes;
	}
	async probe() {
		// Test docker exec in the same mount namespace as a real sandbox. Running bwrap
		// as the image command can pass on a daemon where the create-time probe fails.
		const name = tmpName();
		const probeVolume = name + "-data";
		await this.ownedVolume(true, probeVolume);
		try {
			const started = await docker(["run", "-d", ...this.flags(name, bubblewrap), "-v", `${probeVolume}:${DATA_DIR}`, image, "sleep", "infinity"], { timeoutMs: 30_000 });
			if (started.code !== 0) return false;
			return (await docker(["exec", name, ...DOCKER_BWRAP_PROBE], { timeoutMs: 20_000 })).code === 0;
		} finally {
			await docker(["rm", "-f", name]);
			await this.dropVolume(probeVolume);
		}
	}
	async logout() {
		if (!await this.ownedVolume(false)) return;
		const result = await this.helper(["sh", "-c", "rm -f -- /data/access-token-*.json /data/access-token-*.json.tmp"], true);
		if (result.code !== 0) throw new RunnerError("Could not remove access token files from the data volume.");
	}
}
