/**
 * Everything this layer asks of E2B, as one small interface. The provider's logic (sandboxes.ts) is
 * written against it and against nothing of E2B's SDK, so it is tested on an in-memory client
 * (fake.ts) without an account; sdk.ts is the one file that imports the SDK and maps this to it.
 *
 * Each method names the SDK call it stands for and the page of E2B's documentation that describes it
 * (read 2026-11-15, SDK 2.63.0).
 */

import type { E2bNetworkConfig } from "./network.js";

export type E2bState = "running" | "paused";

/** `SandboxInfo` of the SDK, the fields this layer reads. Times are ms since the epoch. */
export interface E2bSandboxInfo {
	sandboxId: string;
	templateId: string;
	state: E2bState;
	metadata: Record<string, string>;
	/** When the sandbox started. Whether a resume moves it is one of the things scripts/e2b-check.ts reports. */
	startedAt: number;
	/** The timeout deadline while running, or the last pause time while paused. */
	endAt: number;
	cpuCount: number;
	memoryMB: number;
}

export interface E2bCreateInput {
	/** The template's name or id. Its build decided the sandbox's CPUs and memory. */
	template: string;
	/** The sandbox's own timeout: when it runs out, E2B does `onTimeout` to the sandbox by itself. */
	timeoutMs: number;
	metadata: Record<string, string>;
	/** Environment variables of every command in the sandbox. A template's own are only set during its build. */
	envs: Record<string, string>;
	onTimeout: "pause" | "kill";
	/** `network`: what E2B lets out of the sandbox (network.ts). Absent: no option, E2B's default. https://docs.e2b.dev/network/internet-access.md */
	network?: E2bNetworkConfig;
}

export interface E2bCommandOptions {
	/** Run as the unprivileged transport user, outside the workspace. */
	gitUser?: true;
	/** Run as root: only the provider's own fixed scripts (the sandbox's name files, network.ts), never a command of a session's. */
	root?: true;
	cwd: string;
	envs?: Record<string, string>;
	/** Keep the command's standard input open for `sendStdin`. Without it the command reads nothing. */
	stdin: boolean;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

/** A command started in a sandbox (`CommandHandle`). */
export interface E2bCommand {
	readonly pid: number;
	/** `sendStdin`: one request per call, so the caller sends one at a time to keep their order. */
	sendStdin(data: string): Promise<void>;
	/** `closeStdin`: end of input. */
	closeStdin(): Promise<void>;
	/**
	 * Resolves when the command has ended, with its exit code whatever that is (the SDK throws for a
	 * non-zero one; the client turns that back into a result). `error` is what E2B says ended it besides
	 * (a signal). Rejects when the stream to the command broke: the command may still run.
	 */
	wait(): Promise<{ exitCode: number; error?: string }>;
	/** `disconnect`: stops listening. The command goes on in the sandbox. */
	disconnect(): Promise<void>;
	/** `kill`: SIGKILL to the command's own process (not to what it started). */
	kill(): Promise<void>;
}

/** A running sandbox this process can run commands in (a `Sandbox` object of the SDK). */
export interface E2bConnection {
	readonly sandboxId: string;
	/**
	 * `commands.run(command, { background: true, timeoutMs: 0, ... })`: the string is run by a shell in the
	 * sandbox as `agent` (or `nobody` for Git transport), with no time limit of E2B's own (its default would kill the command
	 * after 60 seconds). https://docs.e2b.dev/commands/background.md, /commands/streaming.md
	 */
	start(command: string, options: E2bCommandOptions): Promise<E2bCommand>;
	/** `files.read(path)`: a text file. https://docs.e2b.dev/filesystem/read-write.md */
	readFile(path: string): Promise<string>;
	/** `files.write(path, content)`: creates the directories on the way. */
	writeFile(path: string, content: string): Promise<void>;
}

export interface E2bConnectOptions {
	/**
	 * `onResume: "reboot"`: a paused sandbox is started from its disk, without the memory its pause kept, so no
	 * process of before runs in it. E2B's rescue for a guest whose memory image wedges it. A no-op for a running
	 * sandbox. https://docs.e2b.dev/sandbox/persistence.md (SDK 2.63.0 `SandboxOnResume`)
	 */
	reboot?: true;
}

export interface E2bClient {
	/** `Sandbox.create(template, { timeoutMs, metadata, envs, lifecycle: { onTimeout } })`. https://docs.e2b.dev/sandbox.md, /sandbox/metadata.md, /sandbox/persistence.md ("Auto-pause") */
	create(input: E2bCreateInput): Promise<E2bConnection>;
	/**
	 * `Sandbox.connect(id, { timeoutMs })`: resumes the sandbox when it is paused, and moves its timeout to
	 * `timeoutMs` from now unless it already ends later (a connect only ever extends). Undefined when there
	 * is no such sandbox. https://docs.e2b.dev/sandbox/connect.md, /sandbox/persistence.md ("Resuming sandbox", "Sandbox's timeout")
	 */
	connect(sandboxId: string, timeoutMs: number, options?: E2bConnectOptions): Promise<E2bConnection | undefined>;
	/** `Sandbox.getInfo(id)`. Undefined when there is no such sandbox. https://docs.e2b.dev/sandbox.md ("Retrieve sandbox information") */
	info(sandboxId: string): Promise<E2bSandboxInfo | undefined>;
	/** `Sandbox.list({ query: { metadata, state } })`, every page. Without `state`: running and paused. https://docs.e2b.dev/sandbox/list.md */
	list(query: { metadata: Record<string, string>; state?: E2bState[] }): Promise<E2bSandboxInfo[]>;
	/** `Sandbox.setTimeout(id, timeoutMs)`: the timeout is `timeoutMs` from now, longer or shorter than it was. https://docs.e2b.dev/sandbox.md ("Change sandbox timeout during runtime") */
	setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
	/**
	 * `Sandbox.pause(id)`: memory and files are kept, nothing runs and nothing is billed. False when it was
	 * paused already or is gone. Throws `E2bBusyError` when E2B refuses for now and the sandbox goes on
	 * running. https://docs.e2b.dev/sandbox/persistence.md ("Pausing sandbox", "When a pause is refused")
	 */
	pause(sandboxId: string): Promise<boolean>;
	/**
	 * `Sandbox.updateNetwork(id, network)`: replaces the whole egress configuration of a running sandbox;
	 * null clears it (E2B's default, open). https://docs.e2b.dev/api-reference/sandboxes/update-sandbox-network.md
	 */
	updateNetwork(sandboxId: string, network: E2bNetworkConfig | null): Promise<void>;
	/** `Sandbox.kill(id)`: running or paused, it is gone with its files. False when there was none. https://docs.e2b.dev/sandbox/persistence.md ("Removing paused sandboxes") */
	kill(sandboxId: string): Promise<boolean>;
	/**
	 * `Sandbox.createSnapshot(id, { name, mode: "filesystem" })`: a persistent image of the sandbox's disk, without its
	 * memory, from which `create` makes new sandboxes (its `snapshotId` in place of a template). The sandbox is paused
	 * for a moment and goes on running; its open command streams are dropped. A sandbox made from it boots from the
	 * disk: no process of the source runs in it. Throws `E2bSnapshotModeError` where the account cannot take a
	 * filesystem-only snapshot. https://docs.e2b.dev/sandbox/snapshots.md (read 2026-11-22, SDK 2.63.0)
	 */
	createSnapshot(sandboxId: string, name: string): Promise<E2bSnapshotInfo>;
	/** `Sandbox.listSnapshots()`, every page: the account's snapshots, of every deployment. */
	listSnapshots(): Promise<E2bSnapshotInfo[]>;
	/** `Sandbox.deleteSnapshot(snapshotId)`. False when there was none. */
	deleteSnapshot(snapshotId: string): Promise<boolean>;
	/** `Template.getTags(name)`: the build the template's tag points at now; null when the template or the tag is unknown. https://docs.e2b.dev/template/tags.md */
	templateBuild(template: string): Promise<string | null>;
	/**
	 * `Sandbox.getMetrics(id, { start })`: E2B's samples of the sandbox's use since `sinceMs`, the oldest first, in bytes.
	 * Read from outside the guest, so it answers for a guest that answers nothing. https://docs.e2b.dev/sandbox/metrics.md
	 */
	metrics?(sandboxId: string, sinceMs: number): Promise<E2bMetric[]>;
}

/** One of E2B's samples of a sandbox (`SandboxMetrics`): ms since the epoch, memory in bytes. */
export interface E2bMetric {
	at: number;
	memUsed: number;
	memTotal: number;
}

/** `SnapshotInfo` of the SDK: an id `create` takes, and the snapshot template's full names (`team/name:tag`). */
export interface E2bSnapshotInfo {
	snapshotId: string;
	names: string[];
}

/** E2B refused a filesystem-only snapshot (`snapshot_filesystem_only_disabled`, `..._unsupported_node`). A memory snapshot is never taken in its place. */
export class E2bSnapshotModeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "E2bSnapshotModeError";
	}
}

/** E2B answered 503: it cannot do this now (a pause while an earlier snapshot is still being written, no capacity for a new sandbox). Trying again in a few seconds may work. */
export class E2bBusyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "E2bBusyError";
	}
}

/** E2B answered 429: the account is over one of its plan's limits (sandboxes running at once, sandboxes created per second). */
export class E2bLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "E2bLimitError";
	}
}
