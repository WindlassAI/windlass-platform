/**
 * Sandboxes: one Docker container per agent session, `wlp-session-<id>`.
 *
 * Commands run with `docker exec … wlp-run exec <tag> …` (see sandbox/wlp-run): the program leads a new
 * session inside the container and every process it starts carries WLP_RUN_TAG=<tag>, so a stop can
 * reach all of them with a second `docker exec`. Killing the local `docker exec` client alone does not
 * stop anything inside the container.
 *
 * `exec` runs a command to its end; `start` leaves its standard input open, for the program a turn
 * talks to (`windlass acp`, see windlass.ts).
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SandboxProfile, SandboxProfileId } from "../contract.js";
import { type CreateSandboxInput, type ExecOptions, type ExecResult, type SandboxHandle, SandboxUserError, type Sandboxes } from "./api.js";
import { DATA_DIR, IMAGE, LABEL, LABEL_ARG, WORKSPACE, docker, randomId } from "./docker.js";
import { COMMON_RUN_FLAGS, PROFILES, PROFILE_RUN_FLAGS, findProfile } from "./profiles.js";
import { assertName, ensureUserVolume, userVolume } from "./volumes.js";

const SANDBOX_ID = /^[a-f0-9]{12}$/;
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;

export const containerName = (id: string) => `wlp-session-${id}`;

export interface InternalExecResult extends ExecResult {
	/** SIGKILL had to be sent. */
	killed: boolean;
	/** Signals sent during a stop, in order, with ms since the stop began. */
	stopLog: string[];
	/** Processes of the run still alive after it ended and was reaped (should be 0). */
	leftovers: number;
}

export interface StartOptions {
	cwd?: string;
	env?: Record<string, string>;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

/** How a started program ended, as its local `docker exec` client saw it. */
export interface ProcessEnd {
	/** The program's exit code; null when the client was ended by a signal or could not be started. */
	code: number | null;
	/** The signal that ended the local client, if one did. */
	signal: string | null;
	/** Set when `docker` itself could not be run. */
	error: Error | null;
}

/**
 * A program running in the sandbox under wlp-run, with its standard input left open: what a turn's
 * `windlass acp` is. Everything it starts carries the tag, so `signal` and `sweep` reach all of it.
 */
export interface SandboxProcess {
	readonly tag: string;
	/** Writes to standard input. False once it is closed or the client is gone. */
	write(text: string): boolean;
	closeStdin(): void;
	/** Resolves when the local client has ended and all its output was handed over. Never rejects. */
	readonly ended: Promise<ProcessEnd>;
	/** Whether `ended` has resolved. */
	readonly hasEnded: boolean;
	/** Sends a signal inside the sandbox: to the program itself, or to every process that carries the tag. */
	signal(sig: "INT" | "TERM" | "KILL", who: "leader" | "all"): Promise<void>;
	/** Kills the local client. It does not stop anything inside the sandbox. */
	killClient(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]).finally(() => clearTimeout(timer));
}

export class DockerSandboxHandle implements SandboxHandle {
	readonly cwd = WORKSPACE;
	constructor(
		readonly id: string,
		readonly profile: SandboxProfileId,
	) {}

	get container(): string {
		return containerName(this.id);
	}

	run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return this.exec(["bash", "-c", command], options);
	}

	/** Starts argv (no shell) under wlp-run and leaves its standard input open. */
	start(argv: string[], options: StartOptions = {}): SandboxProcess {
		const tag = `r${randomId(6)}`;
		const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment variable name: ${key}`);
			return ["-e", `${key}=${value}`];
		});
		const args = ["exec", "-i", "-w", options.cwd ?? this.cwd, ...env, this.container, "wlp-run", "exec", tag, ...argv];
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		let hasEnded = false;
		let stdinOpen = true;
		const emit = (handler: ((chunk: string) => void) | undefined, text: string) => {
			if (text === "" || handler === undefined) return;
			try {
				handler(text);
			} catch {
				// A listener's failure must not stop the program's output from being read.
			}
		};
		child.stdout.on("data", (chunk: Buffer) => emit(options.onStdout, out.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => emit(options.onStderr, err.write(chunk)));
		child.stdin.on("error", () => (stdinOpen = false));
		child.stdin.on("close", () => (stdinOpen = false));
		const ended = new Promise<ProcessEnd>((resolve) => {
			let failure: Error | null = null;
			const finish = (code: number | null, signal: string | null) => {
				if (hasEnded) return;
				emit(options.onStdout, out.end());
				emit(options.onStderr, err.end());
				hasEnded = true;
				stdinOpen = false;
				resolve({ code, signal, error: failure });
			};
			child.on("error", (error) => {
				failure = new Error(`could not run docker exec: ${error.message}`);
				// Without a process there is no "close" to wait for.
				if (child.pid === undefined) finish(null, null);
			});
			child.on("close", (code, signal) => finish(code, signal));
		});
		return {
			tag,
			write: (text) => {
				if (!stdinOpen) return false;
				child.stdin.write(text);
				return true;
			},
			closeStdin: () => {
				if (!stdinOpen) return;
				stdinOpen = false;
				child.stdin.end();
			},
			ended,
			get hasEnded() {
				return hasEnded;
			},
			signal: async (sig, who) => {
				await docker(["exec", this.container, "wlp-run", "signal", tag, sig, who], { timeoutMs: 10_000 }).catch(() => undefined);
			},
			killClient: () => {
				child.kill("SIGKILL");
			},
		};
	}

	/** Runs argv (no shell) under wlp-run to its end, with stdin, streaming, timeout and a stop that reaches the container. */
	exec(argv: string[], options: ExecOptions = {}): Promise<InternalExecResult> {
		if (options.signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "", killed: false, stopLog: [], leftovers: 0 });
		let stdout = "";
		let stderr = "";
		const run = this.start(argv, {
			cwd: options.cwd,
			env: options.env,
			onStdout: (text) => {
				if (stdout.length < STDOUT_CAP) stdout += text.slice(0, STDOUT_CAP - stdout.length);
				options.onStdout?.(text);
			},
			onStderr: (text) => {
				stderr = (stderr + text).slice(-STDERR_CAP);
				options.onStderr?.(text);
			},
		});
		if (options.stdin !== undefined && options.stdin !== "") run.write(options.stdin);
		run.closeStdin();

		let stopping: Promise<void> | null = null;
		let timedOut = false;
		let aborted = false;
		let killed = false;
		const stopLog: string[] = [];
		// SIGTERM to every process of the run, then SIGKILL after a grace period.
		const stop = () => {
			if (stopping !== null) return;
			const began = Date.now();
			const note = (text: string) => stopLog.push(`${text} at +${Date.now() - began}ms`);
			stopping = (async () => {
				note("SIGTERM to every process of the run");
				await run.signal("TERM", "all");
				if (await within(run.ended, 2000)) return;
				note("SIGKILL to every process of the run");
				killed = true;
				await run.signal("KILL", "all");
				if (await within(run.ended, 3000)) return;
				note("killed the local docker client");
				run.killClient();
			})();
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						stop();
					}, options.timeoutMs);

		return run.ended.then(async (end) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (end.error !== null) throw end.error;
			if (stopping !== null) await stopping;
			const stopped = stopping !== null;
			// What a stopped run left behind is given a moment to go, then killed.
			const leftovers = await this.sweep(run.tag, { waitMs: stopped ? 2000 : 0 });
			// Killed by a signal: no exit code.
			const exitCode = killed || end.signal !== null || (stopped && end.code !== null && end.code > 128) ? null : end.code;
			return { exitCode, timedOut, aborted, stdout, stderr, killed, stopLog, leftovers };
		});
	}

	/**
	 * Stops every run of `program` still going in the container (one whose `docker exec` client died with
	 * a server that stopped): SIGINT to its leader, then SIGKILL to all its processes after 3 s. Returns
	 * how many runs were stopped.
	 */
	async stopLeftovers(program: string): Promise<number> {
		const found = await docker(["exec", this.container, "wlp-run", "tags-of", program], { timeoutMs: 10_000 });
		const tags = found.stdout.split("\n").filter((tag) => /^[A-Za-z0-9_-]+$/.test(tag));
		await Promise.all(
			tags.map(async (tag) => {
				await docker(["exec", this.container, "wlp-run", "signal", tag, "INT", "leader"], { timeoutMs: 10_000 });
				await this.sweep(tag, { waitMs: 3000 });
			}),
		);
		return tags.length;
	}

	/**
	 * Makes sure nothing of a run is left: waits up to `waitMs` for the processes that carry `tag` to go,
	 * kills what is left, and removes `files`. Returns how many processes were still there after that.
	 */
	async sweep(tag: string, options: { waitMs?: number; files?: string[] } = {}): Promise<number> {
		if (!/^[A-Za-z0-9_-]+$/.test(tag)) throw new Error("invalid run tag");
		const list = async () => {
			const result = await docker(["exec", this.container, "wlp-run", "list", tag], { timeoutMs: 10_000 }).catch(() => null);
			if (result === null || result.code !== 0) return 0; // the container is gone or stopped: nothing runs
			return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
		};
		const files = options.files ?? [];
		const waitMs = options.waitMs ?? 0;
		if (waitMs > 0 || files.length === 0) {
			const deadline = Date.now() + waitMs;
			let count = await list();
			while (count > 0 && Date.now() < deadline) {
				await sleep(150);
				count = await list();
			}
			if (count === 0 && files.length === 0) return 0;
		}
		// One call: SIGKILL to what is left, the files removed, and what still runs after that counted.
		const script = 'tag=$1; shift; if [ -n "$(wlp-run list "$tag")" ]; then wlp-run signal "$tag" KILL all; sleep 0.2; fi; [ $# -gt 0 ] && rm -f -- "$@"; wlp-run list "$tag" | wc -l';
		const result = await docker(["exec", this.container, "sh", "-c", script, "sh", tag, ...files], { timeoutMs: 15_000 }).catch(() => null);
		const left = result === null || result.code !== 0 ? 0 : Number(result.stdout.trim());
		return Number.isFinite(left) ? left : 0;
	}

	async readTextFile(path: string): Promise<string> {
		const result = await docker(["exec", "-w", this.cwd, this.container, "cat", "--", path], { timeoutMs: 60_000 });
		if (result.code !== 0) throw new Error(`cannot read ${path}: ${result.stderr.trim()}`);
		return result.stdout;
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		const result = await docker(["exec", "-i", "-w", this.cwd, this.container, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], {
			stdin: content,
			timeoutMs: 60_000,
		});
		if (result.code !== 0) throw new Error(`cannot write ${path}: ${result.stderr.trim()}`);
	}
}

interface Inspected {
	status: string;
	profile: SandboxProfileId;
}

async function inspect(id: string): Promise<Inspected | null> {
	if (!SANDBOX_ID.test(id)) return null;
	const result = await docker(["container", "inspect", "--format", `{{.State.Status}}|{{index .Config.Labels "${LABEL}"}}|{{index .Config.Labels "${LABEL}.profile"}}`, containerName(id)]);
	if (result.code !== 0) return null;
	const [status = "", ours = "", profile = ""] = result.stdout.trim().split("|");
	if (ours !== "1") return null;
	return { status, profile: profile as SandboxProfileId };
}

function stateOf(status: string): "none" | "running" | "paused" {
	if (status === "running" || status === "restarting") return "running";
	if (status === "created" || status === "exited" || status === "paused") return "paused";
	return "none";
}

export class DockerSandboxes implements Sandboxes {
	profiles(): SandboxProfile[] {
		return PROFILES.map((profile) => ({ ...profile, layers: [...profile.layers] }));
	}

	profile(id: SandboxProfileId): SandboxProfile {
		const profile = findProfile(id);
		return { ...profile, layers: [...profile.layers] };
	}

	async create(input: CreateSandboxInput): Promise<string> {
		assertName(input.uid, "user id");
		const profile = findProfile(input.profile);
		const flags = PROFILE_RUN_FLAGS[input.profile];
		if (!profile.available || flags === undefined) throw new SandboxUserError(`The sandbox "${profile.name}" is not available: ${profile.unavailableReason ?? "not supported here"}`);
		await ensureUserVolume(input.uid);
		const id = randomId(6);
		const name = containerName(id);
		const result = await docker(
			[
				"run",
				"-d",
				"--pull",
				"never",
				"--name",
				name,
				"--label",
				LABEL_ARG,
				"--label",
				`${LABEL}.uid=${input.uid}`,
				"--label",
				`${LABEL}.session=${input.sessionId.slice(0, 200)}`,
				"--label",
				`${LABEL}.profile=${input.profile}`,
				...COMMON_RUN_FLAGS,
				...flags,
				"-v",
				`${userVolume(input.uid)}:${DATA_DIR}`,
				IMAGE,
			],
			{ timeoutMs: 120_000 },
		);
		if (result.code !== 0) {
			await docker(["rm", "-f", name]);
			const message = result.stderr.trim();
			if (/No such image|pull access denied|not found/i.test(message)) throw new Error(`the sandbox image ${IMAGE} is missing; run sandbox/build.sh (${message})`);
			throw new Error(`could not create the sandbox: ${message}`);
		}
		const init = await docker(["exec", "-w", WORKSPACE, name, "sh", "-c", 'git init -q && git commit -q --allow-empty -m "Empty workspace"'], { timeoutMs: 60_000 });
		if (init.code !== 0) {
			await docker(["rm", "-f", name]);
			throw new Error(`could not set up the workspace: ${init.stderr.trim()}`);
		}
		return id;
	}

	async connect(id: string): Promise<SandboxHandle | undefined> {
		const found = await inspect(id);
		if (found === null || stateOf(found.status) === "none") return undefined;
		if (found.status === "paused") await docker(["unpause", containerName(id)], { check: true });
		else if (found.status !== "running") {
			const started = await docker(["start", containerName(id)], { timeoutMs: 60_000 });
			if (started.code !== 0) throw new Error(`could not start the sandbox: ${started.stderr.trim()}`);
		}
		return new DockerSandboxHandle(id, found.profile);
	}

	async state(id: string): Promise<"none" | "running" | "paused"> {
		const found = await inspect(id);
		return found === null ? "none" : stateOf(found.status);
	}

	async suspend(id: string): Promise<void> {
		const found = await inspect(id);
		if (found === null || found.status !== "running") return;
		// SIGTERM to the container's init, SIGKILL after 5 s. A turn still running is cut off: stop it first.
		await docker(["stop", "-t", "5", containerName(id)], { timeoutMs: 60_000 });
	}

	async destroy(id: string): Promise<void> {
		const found = await inspect(id);
		if (found === null) return;
		await docker(["rm", "-f", "-v", containerName(id)], { timeoutMs: 60_000, check: true });
	}
}
