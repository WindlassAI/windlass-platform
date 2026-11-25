/**
 * `E2bClient` in memory: what E2B does with sandboxes, as its documentation describes it, with nothing
 * sent anywhere. The provider's logic is tested on it (scripts/e2b-provider-test.ts): the cap, the
 * timeout that is pushed out while a turn runs, pause, resume, kill, the metadata and the cleanup.
 *
 * What it models: a sandbox runs or is paused; it has a timeout, and when that runs out the sandbox is
 * paused or killed by itself (`onTimeout`), which a test brings about with `expire()` or lets a clock
 * decide; `connect` resumes a paused sandbox and only ever pushes the timeout out; `setTimeout` sets it
 * from now; `list` filters by metadata and state; the account's own limit on running sandboxes answers
 * a create or a resume with `E2bLimitError`.
 *
 * What runs inside a sandbox is not E2B's business and is not modelled here: a `FakeMachine` runs the
 * commands. The default one knows no program and answers every command with exit code 0; a test gives
 * one that answers as it needs, or one that runs the commands in a real container of the sandbox image
 * (scripts/e2b-provider-test.ts, "a real turn"), which is how the provider's quoting, standard input and
 * signals are tried without E2B.
 */

import type { E2bNetworkConfig } from "./network.js";
import { E2bBusyError, type E2bClient, type E2bCommand, type E2bCommandOptions, type E2bConnectOptions, type E2bConnection, type E2bCreateInput, E2bLimitError, type E2bMetric, type E2bSandboxInfo, E2bSnapshotModeError, type E2bSnapshotInfo, type E2bState } from "./client.js";

/** What runs a fake sandbox's commands. */
export interface FakeMachine {
	start(command: string, options: E2bCommandOptions): Promise<E2bCommand>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	/** The sandbox was paused: nothing in it runs until `resumed`. */
	paused?(): Promise<void>;
	resumed?(): Promise<void>;
	/** The sandbox was started from its disk (`connect` with `reboot`): what ran in it before is gone. Default `resumed`. */
	rebooted?(): Promise<void>;
	/** The sandbox is gone. */
	killed?(): Promise<void>;
	/** What E2B now lets out of the sandbox: at create, and at every `updateNetwork`. Null: E2B's default. */
	network?(config: E2bNetworkConfig | null): Promise<void>;
	/** A filesystem snapshot of it is taken: what a sandbox made from it starts with (`FakeE2bOptions.machine`'s second argument). */
	snapshot?(): unknown;
}

/** A command that has ended already, with this result. */
export function finishedCommand(result: { exitCode?: number; stdout?: string; stderr?: string; error?: string }, options: E2bCommandOptions): E2bCommand {
	if (result.stdout) options.onStdout?.(result.stdout);
	if (result.stderr) options.onStderr?.(result.stderr);
	return {
		pid: 1,
		sendStdin: async () => {},
		closeStdin: async () => {},
		wait: async () => ({ exitCode: result.exitCode ?? 0, error: result.error }),
		disconnect: async () => {},
		kill: async () => {},
	};
}

/** A machine whose commands are answered by a function of the test's; without one, each ends with exit code 0 and no output. Files are kept in a map. */
export class ScriptedMachine implements FakeMachine {
	readonly commands: Array<{ command: string; options: E2bCommandOptions; stdin: string }> = [];
	readonly files = new Map<string, string>();

	constructor(private readonly answer: (command: string, stdin: () => string) => { exitCode?: number; stdout?: string; stderr?: string; error?: string } | undefined = () => undefined) {}

	async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
		const entry = { command, options, stdin: "" };
		this.commands.push(entry);
		let closed: () => void = () => {};
		const stdinClosed = new Promise<void>((resolve) => (closed = resolve));
		if (!options.stdin) closed();
		return {
			pid: this.commands.length,
			sendStdin: async (data) => {
				entry.stdin += data;
			},
			closeStdin: async () => closed(),
			// The answer is made once the input is complete, as a program that reads its input to the end would make it.
			wait: async () => {
				await stdinClosed;
				const result = this.answer(command, () => entry.stdin) ?? {};
				if (result.stdout) options.onStdout?.(result.stdout);
				if (result.stderr) options.onStderr?.(result.stderr);
				return { exitCode: result.exitCode ?? 0, error: result.error };
			},
			disconnect: async () => {},
			kill: async () => closed(),
		};
	}

	async readFile(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`no such file: ${path}`);
		return content;
	}

	async writeFile(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}

	snapshot(): Map<string, string> {
		return new Map(this.files);
	}
}

interface FakeSandbox {
	id: string;
	template: string;
	state: E2bState;
	metadata: Record<string, string>;
	envs: Record<string, string>;
	onTimeout: "pause" | "kill";
	/** As E2B keeps it: what create was given, replaced by every `updateNetwork`. */
	network: E2bNetworkConfig | null;
	startedAt: number;
	endAt: number;
	machine: FakeMachine;
	/** How long it has run in all, over every stretch that has ended, in ms. */
	ranMs: number;
	/** Since when the stretch at hand has run; null while paused. */
	runningSince: number | null;
}

export interface FakeE2bOptions {
	/** The clock sandboxes' timeouts are measured on. Default `Date.now`. */
	now?: () => number;
	/** Makes the machine of a new sandbox; `from` is what its snapshot's machine gave (`FakeMachine.snapshot`), when made from one. Default a `ScriptedMachine` that answers everything with exit code 0. */
	machine?: (sandboxId: string, from?: unknown) => FakeMachine | Promise<FakeMachine>;
	/** The account's own limit on sandboxes running at once (default 10). */
	accountMaxRunning?: number;
	/** What every sandbox is made with, as a template's build decides. */
	cpuCount?: number;
	memoryMB?: number;
	/** The size of the sandboxes of each template, where it is not `cpuCount` and `memoryMB`. */
	templateSizes?: Record<string, { cpuCount: number; memoryMB: number }>;
}

export class FakeE2b implements E2bClient {
	readonly sandboxes = new Map<string, FakeSandbox>();
	/** Every call, in order, as "name id …": what a test reads to see what the provider asked of E2B. */
	readonly calls: string[] = [];
	/** Set to make the next `pause` answer as E2B does while it is still writing a snapshot. Counts down. */
	pauseBusy = 0;
	/** Set to make `setTimeout` fail (the keepalive's failure path). */
	failSetTimeout: Error | null = null;
	/** The account's snapshots, by id: the template the source was made from, and what its machine gave. */
	readonly snapshots = new Map<string, { names: string[]; template: string; from: unknown }>();
	/** False: the account takes no filesystem-only snapshot (`E2bSnapshotModeError`). */
	filesystemSnapshots = true;
	/** The build each template's default tag points at; a template not here is unknown. */
	readonly builds = new Map<string, string>([["windlass-platform-sandbox", "build-1"], ["windlass-platform-sandbox-shots", "shots-1"]]);
	/** What `metrics` answers for a sandbox, by id: its samples. None: no samples. */
	readonly samples = new Map<string, E2bMetric[]>();
	private next = 1;
	private readonly now: () => number;

	constructor(private readonly options: FakeE2bOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	// ---- what a test does to the fake service ----

	/** The sandbox's timeout has run out, whatever the clock says: E2B pauses or kills it by itself. */
	async expire(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined || sandbox.state !== "running") return;
		sandbox.endAt = Math.min(sandbox.endAt, this.now());
		await this.timeOut(sandbox);
	}

	/** How long a sandbox has run in all, in ms: what E2B would bill. */
	ranMs(sandboxId: string): number {
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined) return this.gone.get(sandboxId) ?? 0;
		return sandbox.ranMs + (sandbox.runningSince === null ? 0 : this.now() - sandbox.runningSince);
	}

	/** What killed sandboxes had run. */
	private readonly gone = new Map<string, number>();

	/** A sandbox as if someone else had made it: for the tests of what is ours and what is not. */
	async plant(metadata: Record<string, string>, state: E2bState = "running"): Promise<string> {
		const before = this.calls.length;
		const connection = await this.create({ template: "someone-elses", timeoutMs: 3_600_000, metadata, envs: {}, onTimeout: "kill" });
		if (state === "paused") await this.pause(connection.sandboxId);
		// Not a call of the provider's.
		this.calls.length = before;
		return connection.sandboxId;
	}

	// ---- E2bClient ----

	async create(input: E2bCreateInput): Promise<E2bConnection> {
		this.calls.push(`create ${input.template}`);
		await this.settle();
		const limit = this.options.accountMaxRunning ?? 10;
		if ([...this.sandboxes.values()].filter((sandbox) => sandbox.state === "running").length >= limit) throw new E2bLimitError(`fake E2B: the account runs ${limit} sandboxes at once and no more`);
		const id = `fake${String(this.next++).padStart(4, "0")}${Math.random().toString(36).slice(2, 10)}`;
		const now = this.now();
		const snapshot = this.snapshots.get(input.template);
		if (snapshot === undefined && input.template.includes(":")) throw new Error(`fake E2B: no template or snapshot ${input.template}`);
		const machine: FakeMachine = (await this.options.machine?.(id, snapshot?.from)) ?? new ScriptedMachine();
		const scripted: unknown = machine;
		if (snapshot !== undefined && snapshot.from instanceof Map && scripted instanceof ScriptedMachine) {
			const files = scripted.files;
			for (const [path, content] of snapshot.from) files.set(path, content as string);
		}
		this.sandboxes.set(id, {
			id,
			template: input.template,
			state: "running",
			metadata: { ...input.metadata },
			envs: { ...input.envs },
			onTimeout: input.onTimeout,
			network: input.network ? structuredClone(input.network) : null,
			startedAt: now,
			endAt: now + input.timeoutMs,
			machine,
			ranMs: 0,
			runningSince: now,
		});
		await machine.network?.(input.network ?? null);
		return this.connection(id);
	}

	async connect(sandboxId: string, timeoutMs: number, options: E2bConnectOptions = {}): Promise<E2bConnection | undefined> {
		this.calls.push(`connect ${sandboxId} ${timeoutMs}${options.reboot ? " reboot" : ""}`);
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined) return undefined;
		const now = this.now();
		if (sandbox.state === "paused") {
			const limit = this.options.accountMaxRunning ?? 10;
			if ([...this.sandboxes.values()].filter((other) => other.state === "running").length >= limit) throw new E2bLimitError(`fake E2B: the account runs ${limit} sandboxes at once and no more`);
			sandbox.state = "running";
			sandbox.runningSince = now;
			// A resume starts the sandbox's running time again.
			sandbox.startedAt = now;
			sandbox.endAt = now + timeoutMs;
			if (options.reboot && sandbox.machine.rebooted) await sandbox.machine.rebooted();
			else await sandbox.machine.resumed?.();
		} else {
			// "Sandbox.connect() only ever extends the sandbox's lifetime."
			sandbox.endAt = Math.max(sandbox.endAt, now + timeoutMs);
		}
		return this.connection(sandboxId);
	}

	async info(sandboxId: string): Promise<E2bSandboxInfo | undefined> {
		this.calls.push(`info ${sandboxId}`);
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		return sandbox === undefined ? undefined : this.infoOf(sandbox);
	}

	async list(query: { metadata: Record<string, string>; state?: E2bState[] }): Promise<E2bSandboxInfo[]> {
		this.calls.push(`list ${JSON.stringify(query.metadata)} ${(query.state ?? ["running", "paused"]).join(",")}`);
		await this.settle();
		const states = query.state ?? ["running", "paused"];
		return [...this.sandboxes.values()].filter((sandbox) => states.includes(sandbox.state) && Object.entries(query.metadata).every(([key, value]) => sandbox.metadata[key] === value)).map((sandbox) => this.infoOf(sandbox));
	}

	async setTimeout(sandboxId: string, timeoutMs: number): Promise<void> {
		this.calls.push(`setTimeout ${sandboxId} ${timeoutMs}`);
		if (this.failSetTimeout !== null) throw this.failSetTimeout;
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined || sandbox.state !== "running") throw new Error(`fake E2B: sandbox ${sandboxId} is not running`);
		sandbox.endAt = this.now() + timeoutMs;
	}

	async pause(sandboxId: string): Promise<boolean> {
		this.calls.push(`pause ${sandboxId}`);
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined || sandbox.state === "paused") return false;
		if (this.pauseBusy > 0) {
			this.pauseBusy -= 1;
			throw new E2bBusyError("fake E2B: the node is still finishing the previous snapshot of this sandbox");
		}
		await this.pauseNow(sandbox);
		return true;
	}

	async updateNetwork(sandboxId: string, network: E2bNetworkConfig | null): Promise<void> {
		this.calls.push(`updateNetwork ${sandboxId} ${JSON.stringify(network)}`);
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		// E2B's endpoint is for a running sandbox.
		if (sandbox === undefined || sandbox.state !== "running") throw new Error(`fake E2B: sandbox ${sandboxId} is not running`);
		sandbox.network = network ? structuredClone(network) : null;
		await sandbox.machine.network?.(sandbox.network);
	}

	async kill(sandboxId: string): Promise<boolean> {
		this.calls.push(`kill ${sandboxId}`);
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined) return false;
		await this.killNow(sandbox);
		return true;
	}

	async createSnapshot(sandboxId: string, name: string): Promise<E2bSnapshotInfo> {
		this.calls.push(`createSnapshot ${sandboxId} ${name}`);
		await this.settle();
		const sandbox = this.sandboxes.get(sandboxId);
		if (sandbox === undefined) throw new Error(`fake E2B: sandbox ${sandboxId} not found`);
		if (!this.filesystemSnapshots) throw new E2bSnapshotModeError("fake E2B: filesystem-only snapshots are not enabled for this team");
		const snapshotId = `fake-team/${name}:default`;
		this.snapshots.set(snapshotId, { names: [snapshotId], template: sandbox.template, from: sandbox.machine.snapshot?.() });
		return { snapshotId, names: [snapshotId] };
	}

	async listSnapshots(): Promise<E2bSnapshotInfo[]> {
		this.calls.push("listSnapshots");
		return [...this.snapshots].map(([snapshotId, { names }]) => ({ snapshotId, names: [...names] }));
	}

	async deleteSnapshot(snapshotId: string): Promise<boolean> {
		this.calls.push(`deleteSnapshot ${snapshotId}`);
		return this.snapshots.delete(snapshotId);
	}

	async metrics(sandboxId: string, sinceMs: number): Promise<E2bMetric[]> {
		this.calls.push(`metrics ${sandboxId}`);
		return (this.samples.get(sandboxId) ?? []).filter((one) => one.at >= sinceMs);
	}

	async templateBuild(template: string): Promise<string | null> {
		this.calls.push(`templateBuild ${template}`);
		return this.builds.get(template) ?? null;
	}

	// ---- inside ----

	/** Before every call: sandboxes whose timeout has run out on the clock are paused or killed, as E2B does by itself. */
	private async settle(): Promise<void> {
		const now = this.now();
		for (const sandbox of [...this.sandboxes.values()]) if (sandbox.state === "running" && sandbox.endAt <= now) await this.timeOut(sandbox);
	}

	private async timeOut(sandbox: FakeSandbox): Promise<void> {
		if (sandbox.onTimeout === "pause") await this.pauseNow(sandbox, sandbox.endAt);
		else await this.killNow(sandbox, sandbox.endAt);
	}

	private async pauseNow(sandbox: FakeSandbox, at = this.now()): Promise<void> {
		if (sandbox.runningSince !== null) sandbox.ranMs += Math.max(0, at - sandbox.runningSince);
		sandbox.runningSince = null;
		sandbox.state = "paused";
		sandbox.endAt = at;
		await sandbox.machine.paused?.();
	}

	private async killNow(sandbox: FakeSandbox, at = this.now()): Promise<void> {
		if (sandbox.runningSince !== null) sandbox.ranMs += Math.max(0, at - sandbox.runningSince);
		this.gone.set(sandbox.id, sandbox.ranMs);
		this.sandboxes.delete(sandbox.id);
		await sandbox.machine.killed?.();
	}

	private infoOf(sandbox: FakeSandbox): E2bSandboxInfo {
		return {
			sandboxId: sandbox.id,
			templateId: sandbox.template,
			state: sandbox.state,
			metadata: { ...sandbox.metadata },
			startedAt: sandbox.startedAt,
			endAt: sandbox.endAt,
			cpuCount: this.options.templateSizes?.[sandbox.template]?.cpuCount ?? this.options.cpuCount ?? 1,
			memoryMB: this.options.templateSizes?.[sandbox.template]?.memoryMB ?? this.options.memoryMB ?? 1024,
		};
	}

	private connection(sandboxId: string): E2bConnection {
		const running = (): FakeSandbox => {
			const sandbox = this.sandboxes.get(sandboxId);
			if (sandbox === undefined || sandbox.state !== "running") throw new Error(`fake E2B: sandbox ${sandboxId} is not running`);
			return sandbox;
		};
		return {
			sandboxId,
			start: async (command, options) => {
				await this.settle();
				const sandbox = running();
				return sandbox.machine.start(command, { ...options, envs: { ...sandbox.envs, ...options.envs } });
			},
			readFile: async (path) => running().machine.readFile(path),
			writeFile: async (path, content) => running().machine.writeFile(path, content),
		};
	}
}
