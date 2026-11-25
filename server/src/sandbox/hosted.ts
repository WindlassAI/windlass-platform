import type { EgressMode, HostedSizeOption, SandboxProfile, SandboxProfileId } from "../contract.js";
import { SandboxUserError, type ConnectOptions, type CreateSandboxInput, type ListedSandbox, type Sandboxes, type SandboxObservation, type SandboxPrice } from "./api.js";
import type { TurnSandbox } from "./provider.js";

type SessionLimit = { source: "config" | "api"; value: number | "unlimited" } | { source: "unknown" };

export class HostedProviderError extends SandboxUserError {
	constructor(readonly kind: "limited" | "busy" | "invalidSize" | "unsupportedPolicy", message: string) {
		super(message);
	}
}

type CapacityReading =
	| { scope: "deployment"; observedAt: number; running: number; maxRunning: number }
	| { scope: "organization-region"; observedAt: number; resources: readonly { unit: "vCPU" | "MiB" | "GiB"; used: number; limit: number }[] };

export interface HostedCapabilities {
	canPause: boolean;
	persistenceOnStop: "disk" | "none" | "unsupported";
	persistenceOnPause: "disk+memory" | "unsupported";
	snapshots: { bootFromArtifact: boolean; filesystemCapture: "running" | "stopped" | "unsupported" };
	maxSession: { continuousMs: SessionLimit; wallClockMs: SessionLimit; resumeResetsContinuous: boolean };
	sizes: readonly HostedSizeOption[];
	egress: { allowList: boolean };
	concurrency: { source: "account-count" | "regional-resource-pool" | "unknown" };
}

type RetainedState = "paused" | "stopped" | "archived";
type HostedObservation = { state: "running" | RetainedState | "none"; pausedAt?: number };
type HostedInventory = Omit<ListedSandbox, "state"> & { state: "running" | RetainedState };
type SnapshotOperations = Required<Pick<Sandboxes, "hasSnapshot" | "saveSnapshot" | "dropSnapshots" | "sweepSnapshots">>;

/** One configured deployment. Only acquire may wake a retained workspace. Inspect and inventory
 * must reject on ambiguous state or incomplete reads so actors keep their existing claims. */
export interface HostedSandboxProvider {
	readonly id: string;
	readonly capabilities: HostedCapabilities;
	readonly idleStopMs: number;
	readonly network: { mode: EgressMode; hosts: readonly string[] };
	readonly artifacts?: SnapshotOperations;
	capacity(): Promise<CapacityReading>;
	price(): SandboxPrice;
	profiles(): SandboxProfile[];
	readonly openProfileId: SandboxProfileId;
	provision(input: CreateSandboxInput): Promise<string>;
	acquire(id: string, options?: ConnectOptions): Promise<TurnSandbox | undefined>;
	inspect(id: string): Promise<HostedObservation>;
	inventory(uid: string): Promise<HostedInventory[]>;
	owners(): Promise<string[]>;
	suspend(id: string): Promise<void>;
	destroy(id: string): Promise<void>;
	applyEgress(id: string, hosts: readonly string[]): Promise<boolean>;
	forgetTokenFiles(uid: string): Promise<void>;
}

const ALLOW_LIST_UNAVAILABLE = "This provider cannot enforce a network allow-list.";

export class HostedSandboxes implements Sandboxes {
	readonly sessionsLiveInSandbox = true;
	readonly hasSnapshot?: Sandboxes["hasSnapshot"];
	readonly saveSnapshot?: Sandboxes["saveSnapshot"];
	readonly dropSnapshots?: Sandboxes["dropSnapshots"];
	readonly sweepSnapshots?: Sandboxes["sweepSnapshots"];

	constructor(readonly provider: HostedSandboxProvider) {
		if (!provider.capabilities.egress.allowList && provider.network.mode !== "open")
			throw new HostedProviderError("unsupportedPolicy", "This provider cannot enforce the deployment's network allow-list.");
		const artifacts = provider.artifacts;
		if (artifacts) {
			this.hasSnapshot = artifacts.hasSnapshot.bind(artifacts);
			this.saveSnapshot = artifacts.saveSnapshot.bind(artifacts);
			this.dropSnapshots = artifacts.dropSnapshots.bind(artifacts);
			this.sweepSnapshots = artifacts.sweepSnapshots.bind(artifacts);
		}
	}

	get idleStopMs() { return this.provider.idleStopMs; }
	price() { return this.provider.price(); }
	sizes() { return this.provider.capabilities.sizes.map(size => ({ ...size })); }
	egress() { return this.provider.network.mode; }
	allowedHosts() { return this.provider.network.hosts; }
	setNetwork(id: string, hosts: readonly string[]) { return this.provider.applyEgress(id, hosts); }
	owners() { return this.provider.owners(); }

	profiles(): SandboxProfile[] {
		const { allowList } = this.provider.capabilities.egress;
		return this.provider.profiles().map(profile =>
			profile.available && !allowList && profile.id !== this.provider.openProfileId
				? { ...profile, available: false, unavailableReason: ALLOW_LIST_UNAVAILABLE }
				: profile);
	}

	profile(id: SandboxProfileId) {
		const profile = this.profiles().find(item => item.id === id);
		if (!profile) throw new Error(`unknown sandbox profile: ${String(id)}`);
		return profile;
	}

	async create(input: CreateSandboxInput) {
		if (!this.provider.capabilities.egress.allowList && input.profile !== this.provider.openProfileId)
			throw new HostedProviderError("unsupportedPolicy", ALLOW_LIST_UNAVAILABLE);
		return this.provider.provision(input);
	}

	async list(uid: string): Promise<ListedSandbox[]> {
		return (await this.provider.inventory(uid)).map(row => ({ ...row, state: row.state === "running" ? "running" : "paused" }));
	}

	async observe(id: string): Promise<SandboxObservation> {
		const row = await this.provider.inspect(id);
		return { ...row, state: row.state === "stopped" || row.state === "archived" ? "paused" : row.state };
	}

	async state(id: string) { return (await this.observe(id)).state; }
	connect(id: string, options?: ConnectOptions) { return this.provider.acquire(id, options); }
	suspend(id: string) { return this.provider.suspend(id); }
	destroy(id: string) { return this.provider.destroy(id); }
}
