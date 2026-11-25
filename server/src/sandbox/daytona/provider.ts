import { randomUUID } from "node:crypto";
import { Daytona, DaytonaGoneError, DaytonaNotFoundError, DaytonaTimeoutError, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytona/sdk";
import { HOSTED_SIZE_NAMES, HOSTED_SIZE_SPECS, isHostedSize, type HostedSize, type SandboxProfile } from "../../contract.js";
import { INIT_WORKSPACE } from "../../github/git-flags.js";
import { readsModelRelay } from "../../model-relay-url.js";
import { DeploymentFull, SandboxUserError, type CreateSandboxInput, type ListedSandbox, type SandboxObservation } from "../api.js";
import { capReached, META } from "../e2b/sandboxes.js";
import type { HostedSandboxProvider } from "../hosted.js";
import { offeredSize } from "../hosted-settings.js";
import { PROFILES } from "../profiles.js";
import { NAME } from "../provider.js";
import { diskGiB, type DaytonaSettings } from "./config.js";
import { DaytonaGuest, type OpenPty } from "./guest.js";

export type Machine = Pick<Sandbox,
	"id" | "name" | "state" | "target" | "sandboxClass" | "user" | "public" | "cpu" | "memory" | "disk" |
	"labels" | "snapshot" | "start" | "stop" | "delete" | "refreshActivity"
> & { process: { createPty: OpenPty } };

export interface DaytonaClient {
	create(input: CreateSandboxFromSnapshotParams, options: { timeout: number }): Promise<Machine>;
	get(id: string): Promise<Machine | undefined>;
	list(query: { labels: Record<string, string>; targets?: string[] }): AsyncIterable<Machine>;
}

function missing(error: unknown): undefined {
	if (error instanceof DaytonaNotFoundError || error instanceof DaytonaGoneError) return undefined;
	throw error;
}

export function createDaytonaProvider(settings: DaytonaSettings, key: string | undefined) {
	const apiKey = key?.trim();
	if (!apiKey) throw new Error("DAYTONA_API_KEY is required for WLP_SANDBOX=daytona");
	const sdk = new Daytona({ apiKey, apiUrl: settings.apiUrl, target: settings.target, requestTimeoutMs: 30_000 });
	return new DaytonaProvider(sdk, settings);
}

function state(vm: Machine): SandboxObservation["state"] {
	switch (vm.state) {
		case "started": return "running";
		case "stopped": return "paused";
		case "destroyed": return "none";
		default: throw new Error(`Daytona sandbox ${vm.id} is ${vm.state ?? "in an unknown state"}`);
	}
}

export class DaytonaProvider implements HostedSandboxProvider {
	readonly openProfileId = "daytona";
	readonly supportsAllowList = false;
	get network() { return this.settings.network; }
	get idleStopMs() { return Math.ceil(this.settings.idleTimeoutMs / 60_000) * 60_000; }
	version: string | null;
	constructor(private readonly client: DaytonaClient, private readonly settings: DaytonaSettings) {
		this.version = settings.windlassVersion;
	}

	profiles(): SandboxProfile[] {
		return PROFILES.map(profile => {
			if (profile.id !== "daytona") return { ...profile, available: false, unavailableReason: "This Daytona deployment offers only Open isolation." };
			const { unavailableReason: _, ...open } = profile;
			return { ...open, available: this.settings.openProfile, modelRelay: true, accessTokenReadable: false, platformKeys: true,
				...(!this.settings.openProfile && { unavailableReason: "WLP_HOSTED_OPEN_PROFILE=0 disables the Open profile." }) };
		});
	}
	private rate(size: HostedSize) {
		const spec = HOSTED_SIZE_SPECS[size], rates = this.settings.rates;
		return spec.cpus * rates.usdPerVcpuSecond + spec.memoryMiB / 1024 * rates.usdPerGiBSecond + diskGiB[size] * rates.usdPerDiskGiBSecond;
	}
	price() { return { usdPerSecond: this.rate("small"), basis: "Daytona running estimate for 1 vCPU, 1 GiB RAM and 3 GiB disk before storage allowances" }; }
	sizes() { return this.settings.sizes.map(id => ({ id, ...HOSTED_SIZE_SPECS[id], usdPerHour: this.rate(id) * 3600 })); }

	private belongs(vm: Machine) {
		return vm.labels[META.deployment] === this.settings.deployment && (!this.settings.target || vm.target === this.settings.target);
	}
	private async ours(id: string) {
		if (!NAME.test(id)) return undefined;
		const vm = await this.client.get(id).catch(missing);
		return vm && vm.id === id && this.belongs(vm) ? vm : undefined;
	}
	private async *machines(uid?: string) {
		const labels = { [META.deployment]: this.settings.deployment, ...(uid && { [META.uid]: uid }) };
		for await (const vm of this.client.list({ labels, targets: this.settings.target ? [this.settings.target] : undefined })) {
			if (this.belongs(vm) && (!uid || vm.labels[META.uid] === uid) && vm.state !== "destroyed") yield vm;
		}
	}
	async owners() {
		const users = new Set<string>();
		for await (const vm of this.machines()) {
			const uid = vm.labels[META.uid];
			if (uid && NAME.test(uid)) users.add(uid);
		}
		return [...users];
	}
	async inventory(uid: string) {
		const found: ListedSandbox[] = [];
		if (!NAME.test(uid)) return found;
		for await (const vm of this.machines(uid)) {
			const observed = state(vm);
			if (observed !== "none") found.push({ id: vm.id, sessionId: vm.labels[META.session] ?? "", state: observed });
		}
		return found;
	}
	private async checkCapacity(alreadyStarted = false) {
		let count = 0;
		for await (const vm of this.machines()) {
			// Pending starts and stops can still occupy capacity.
			if (vm.state !== "stopped") count++;
		}
		const limit = this.settings.maxRunning;
		if (count + (alreadyStarted ? 0 : 1) > limit) throw new DeploymentFull(limit, capReached(limit));
	}
	private guest(vm: Machine) {
		const size = vm.labels[META.size];
		if (vm.public || vm.sandboxClass !== "linux-vm" || vm.user !== "wlp-launcher" ||
			vm.labels[META.profile] !== "daytona" || vm.labels[META.network] !== "open" ||
			!NAME.test(vm.labels[META.uid] ?? "") || !vm.labels[META.session] || !isHostedSize(size))
			throw new Error("Unexpected Daytona sandbox class, user, visibility or labels");
		const spec = HOSTED_SIZE_SPECS[size];
		if (vm.cpu !== spec.cpus || vm.memory !== spec.memoryMiB / 1024 || vm.disk !== diskGiB[size])
			throw new Error(`Daytona snapshot does not match the ${HOSTED_SIZE_NAMES[size]} resource shape`);
		return new DaytonaGuest(vm, size, { ...this.settings, windlassVersion: this.version });
	}
	async provision(input: CreateSandboxInput) {
		if (input.profile !== "daytona" || !this.settings.openProfile) throw new SandboxUserError("Daytona requires the Open profile.");
		if (!NAME.test(input.uid) || !input.sessionId) throw new Error("Missing session or invalid owner");
		if (input.environmentBuild) throw new SandboxUserError("Daytona prepared environments are unavailable.");
		if (input.harness && input.screenshots) throw new SandboxUserError("Hosted harness images do not include screenshots.");
		await this.checkCapacity();
		const size = offeredSize(this.settings, input.hostedSize);
		const snapshot = [this.settings.snapshot, size === "small" ? undefined : size, input.harness ?? (input.screenshots ? "shots" : undefined)].filter(Boolean).join("-");
		const name = "wlp-" + randomUUID();
		const labels = { [META.deployment]: this.settings.deployment, [META.uid]: input.uid, [META.session]: input.sessionId, [META.size]: size, [META.network]: "open", [META.profile]: input.profile };
		const vm = await this.client.create({
			name, labels, snapshot, target: this.settings.target, user: "wlp-launcher", public: false,
			autoStopInterval: this.idleStopMs / 60_000, autoPauseInterval: 0, autoDeleteInterval: this.settings.pause ? -1 : 0,
		}, { timeout: 120 }).catch(async error => {
			// A timed-out create can leave a VM before the API returns its ID.
			if (error instanceof DaytonaTimeoutError) {
				const pending = await this.client.get(error.sandboxId ?? name).catch(missing);
				if (pending?.name === name && Object.entries(labels).every(([key, value]) => pending.labels[key] === value))
					await pending.delete(60, true);
			}
			throw error;
		});
		try {
			await this.checkCapacity(true);
			const handle = this.guest(vm);
			const init = await handle.ask(["sh", "-ec", INIT_WORKSPACE + " && windlass --version"]);
			const version = /^Windlass\s+(\S+)/im.exec(init?.stdout ?? "")?.[1];
			if (init?.code !== 0 || !readsModelRelay(version)) throw new Error("Daytona workspace initialization requires Windlass 0.6.0+ in the snapshot");
			this.version ??= version!;
			return vm.id;
		} catch (error) {
			await vm.delete(60, true);
			throw error;
		}
	}
	async forgetTokenFiles(uid: string) {
		for await (const vm of this.machines(uid)) {
			if (vm.state === "started") await this.guest(vm).clearTokenFiles();
		}
	}

	async acquire(id: string) {
		const vm = await this.ours(id);
		if (!vm) return undefined;
		const observed = state(vm);
		if (observed === "none") return undefined;
		const handle = this.guest(vm);
		if (observed === "running") {
			await vm.refreshActivity();
		} else {
			await this.checkCapacity();
			await vm.start(120);
			try {
				await this.checkCapacity(true);
				await handle.clearTokenFiles();
			} catch (error) { await vm.stop(60); throw error; }
		}
		return handle;
	}
	async inspect(id: string): Promise<SandboxObservation> {
		const vm = await this.ours(id);
		return { state: vm ? state(vm) : "none" };
	}
	async suspend(id: string) {
		const vm = await this.ours(id);
		if (!vm) return;
		if (!this.settings.pause) await vm.delete(60, true);
		else if (state(vm) === "running") {
			try { await this.guest(vm).clearTokenFiles(); }
			finally { await vm.stop(60); }
		}
	}
	async destroy(id: string) {
		const vm = await this.ours(id);
		if (vm && vm.state !== "destroyed") await vm.delete(60, true);
	}
	async applyEgress() { return true; } // Open already permits repository hosts.
}
