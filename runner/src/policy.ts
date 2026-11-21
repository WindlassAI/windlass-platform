import { availableParallelism } from "node:os";
import type { Args } from "../../server/src/runner/protocol.js";
import { LABEL, LABEL_ARG, MACHINE_LABEL, createVolume, docker, removeVolume, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { COMMON_RUN_FLAGS, PROFILE_RUN_FLAGS } from "../../server/src/sandbox/profiles.js";
import { BWRAP_PROBE, DATA_DIR } from "../../server/src/sandbox/provider.js";
import { Refusal, RunnerError, type Identity } from "./state.js";

declare const SANDBOX_IMAGE: string;
declare const SHOTS_IMAGE_PIN: string;
declare const HARNESS_IMAGES: Partial<Record<"claude", string>>;
export const harnessImage = (id: "claude") => HARNESS_IMAGES[id];
export const shotsImage = SHOTS_IMAGE_PIN;
export const image = SANDBOX_IMAGE;
export const bubblewrap = "docker-windlass-sandbox";
export type Profile = Args<"create">["profile"];
export function runnerCpus(): number {
	const setting = process.env.WLP_RUNNER_CPUS;
	if (setting === undefined) return Math.max(0.5, availableParallelism() / 2);
	const value = Number(setting);
	if (!/^\d+(?:\.\d{1,9})?$/.test(setting) || !Number.isFinite(value) || value < 0.01)
		throw new RunnerError("Give WLP_RUNNER_CPUS a CPU count of at least 0.01.");
	return value;
}

// The machine belongs to its owner, so the platform sets no default sandbox limits.
export type Limits = { maxTurns?: number; maxRunning?: number; maxSandboxes?: number };
// The Docker name distinguishes Claude containers. The platform keeps the original sandbox id across upgrades.
export const externalId = (machine: string, raw: string) => `m${machine}-${raw.replace(/^claude-/, "")}`;
export function rawId(machine: string, id: string) {
	const prefix = externalId(machine, "");
	const raw = id.slice(prefix.length);
	if (!id.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(raw)) throw new Refusal("This sandbox id does not belong to this machine.");
	return raw;
}

export class MachineDocker {
	readonly labels: Record<string, string>;
	readonly volume: string;
	readonly claudeVolume: string;
	constructor(readonly identity: Identity) {
		this.labels = { [MACHINE_LABEL]: identity.machineId, [LABEL + ".uid"]: identity.uid };
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
		return ["--rm", "--name", name, "--label", LABEL_ARG, ...this.pairingLabelFlags, "--pull", "never", ...COMMON_RUN_FLAGS, ...PROFILE_RUN_FLAGS[profile]!];
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
		const fetch = this.fetchImage(pin).finally(() => this.preparing.delete(pin));
		this.preparing.set(pin, fetch);
		return fetch;
	}
	private async fetchImage(image: string) {
		if ((await docker(["image", "inspect", image, "--format", "{{.Id}}"])).code === 0) return;
		if (!image.includes("@") || (await docker(["pull", image], { timeoutMs: 30 * 60_000 })).code !== 0)
			throw new RunnerError("The pinned sandbox image is missing and could not be pulled.");
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
			return (await docker(["exec", name, ...BWRAP_PROBE], { timeoutMs: 20_000 })).code === 0;
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
