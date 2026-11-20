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
 *
 * Environment. What a program is given in `env` is written into the arguments of `docker exec`
 * (`-e NAME=value`), where anyone on the server's machine who lists processes reads it: it is for
 * names and paths. A secret goes in `secretEnv`: `docker exec -e NAME`, without a value, has the
 * client take the value from its own environment, so the value is in the environment of that one
 * `docker` process (readable by the server's own Unix user and by root, as the server's memory is)
 * and in no argument. The Docker daemon is sent the value in the request that starts the program; a
 * daemon run with debug logging writes such requests to its log.
 *
 * A secret's own name never enters the client's environment: it is handed over as WLP_SECRET_<n>, and
 * a `sh` in the container gives each value its name before it runs the program (`secretNamesScript`).
 * Otherwise a name the `docker` client reads itself (DOCKER_HOST, LD_PRELOAD, a proxy, or whatever a
 * later client reads) would change what the client does on the machine it runs on. On the hosted side
 * the names are the user's saved ones, which leave such names out already (repo-secrets.ts); a runner
 * is handed them by a server it does not trust, and no list of names the client reads is ever complete.
 *
 * Two kinds of provider are made from this file: the hosted one, and a runner's on a user's own machine
 * (`DockerSandboxOptions`). They differ in the volume a container mounts and in its machine label.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SandboxProfile, SandboxProfileId } from "../contract.js";
import { type CreateSandboxInput, type ExecOptions, type ExecResult, type ListedSandbox, type SandboxHandle, type SandboxPrice, SandboxUserError, type Sandboxes } from "./api.js";
import { DATA_DIR, IMAGE, LABEL, LABEL_ARG, MACHINE_LABEL, WORKSPACE, docker, randomId } from "./docker.js";
import { COMMON_RUN_FLAGS, PROFILE_RUN_FLAGS, findProfile, profilesFor } from "./profiles.js";
import { type Answer, type InternalExecResult, NAME, type ProcessEnd, RUN_TAG, SECRET_FILE_SCRIPT, SWEEP_SCRIPT, type SandboxProcess, type StartOptions, type TurnSandbox, assertEnvNames, markTurnSandbox } from "./provider.js";
import { tokenFilePath } from "./token-file.js";

const SANDBOX_ID = /^[a-f0-9]{12}$/;
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;

export const containerName = (id: string) => `wlp-session-${id}`;

/** What a secret is called in the `docker` client's environment: `${SECRET_ALIAS}<n>`. No saved secret's name starts with WLP_ (repo-secrets.ts). */
const SECRET_ALIAS = "WLP_SECRET_";

/**
 * Run in the container before the program, with the names as `-c` text: each value is given its own
 * name from its alias, the aliases are unset, and `exec` replaces the shell with the program, so the
 * program keeps the shell's process and nothing of it is left. The names are checked as identifiers
 * (`assertEnvNames`) before they are put into the script. `sh` is in every sandbox image there is.
 */
function secretNamesScript(names: string[]): string {
	const assign = names.map((name, n) => `${name}="$${SECRET_ALIAS}${n}"`).join(" ");
	const aliases = names.map((_, n) => `${SECRET_ALIAS}${n}`).join(" ");
	return `export ${assign}; unset ${aliases}; exec "$@"`;
}

function assertUid(uid: string): void {
	if (!NAME.test(uid)) throw new Error("invalid user id");
}

export type { InternalExecResult, ProcessEnd, SandboxProcess, StartOptions } from "./provider.js";

/** A started program of this provider's: a runner stops reading its output while its session's window is full. */
export interface DockerProcess extends SandboxProcess {
	/** Stops reading the program's output (true), or reads on (false). Unread output fills the pipe, and the program's writes wait. */
	pauseOutput(paused: boolean): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]).finally(() => clearTimeout(timer));
}

export class DockerSandboxHandle implements TurnSandbox {
	readonly cwd = WORKSPACE;
	constructor(
		readonly id: string,
		readonly profile: SandboxProfileId,
		/** The user whose data volume the container mounts, from the container's label. */
		readonly uid: string,
	) {
		markTurnSandbox(this);
	}

	get approval(): "auto" | "full" {
		return findProfile(this.profile).approval;
	}

	get container(): string {
		return containerName(this.id);
	}

	run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return this.exec(["bash", "-c", command], options);
	}

	/**
	 * Starts argv (no shell) under wlp-run and leaves its standard input open. `tag` is the run's tag
	 * when the caller has named it already (a runner is given the server's); otherwise one is made.
	 */
	start(argv: string[], options: StartOptions = {}, tag = `r${randomId(6)}`): DockerProcess {
		if (!RUN_TAG.test(tag)) throw new Error("invalid run tag");
		assertEnvNames(options.env);
		assertEnvNames(options.secretEnv);
		const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		const secret = Object.entries(options.secretEnv ?? {}).filter(([key]) => options.env?.[key] === undefined);
		for (const [key] of secret) if (key.startsWith(SECRET_ALIAS)) throw new Error(`the variable ${key} cannot be handed to a program in the sandbox: its name is the platform's`);
		// Named only, by alias: the client takes each value from its own environment, which is this process's with the aliases added.
		const aliases = secret.map(([, value], n) => [`${SECRET_ALIAS}${n}`, value] as const);
		const names = secret.length === 0 ? [] : ["sh", "-c", secretNamesScript(secret.map(([key]) => key)), "sh"];
		const args = ["exec", "-i", "-w", options.cwd ?? this.cwd, ...env, ...aliases.flatMap(([alias]) => ["-e", alias]), this.container, ...names, "wlp-run", "exec", tag, ...argv];
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], ...(secret.length === 0 ? {} : { env: { ...process.env, ...Object.fromEntries(aliases) } }) });
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
			pauseOutput: (paused) => {
				for (const pipe of [child.stdout, child.stderr]) {
					if (paused) pipe.pause();
					else pipe.resume();
				}
			},
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

	/** Runs argv directly with `docker exec`: no shell, no standard input, not under wlp-run. Null when `docker` could not be run. */
	async ask(argv: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Answer | null> {
		const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		const result = await docker(["exec", ...env, this.container, ...argv], { timeoutMs: options.timeoutMs }).catch(() => null);
		return result === null ? null : { code: result.code, stdout: result.stdout, stderr: result.stderr };
	}

	/** A container runs until it is stopped: there is nothing to keep alive for a turn. */
	async holdForTurn(): Promise<() => Promise<void>> {
		return async () => {};
	}

	/** Runs argv (no shell) under wlp-run to its end, with stdin, streaming, timeout and a stop that reaches the container. */
	exec(argv: string[], options: ExecOptions = {}): Promise<InternalExecResult> {
		if (options.signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "", killed: false, stopLog: [], leftovers: 0 });
		let stdout = "";
		let stderr = "";
		const run = this.start(argv, {
			cwd: options.cwd,
			env: options.env,
			secretEnv: options.secretEnv,
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
		if (!RUN_TAG.test(tag)) throw new Error("invalid run tag");
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
		const result = await docker(["exec", this.container, "sh", "-c", SWEEP_SCRIPT, "sh", tag, ...files], { timeoutMs: 15_000 }).catch(() => null);
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

	/**
	 * Writes a file that only its owner can read (0600), whole: the content goes to a file beside it
	 * (`<path>.tmp`), which is then renamed into place, so whoever reads `path` sees the old content or
	 * the new and never a part of either. The content is passed on standard input, never on a command
	 * line. One write of a path at a time.
	 */
	async writeSecretFile(path: string, content: string): Promise<void> {
		const result = await docker(["exec", "-i", this.container, "sh", "-c", SECRET_FILE_SCRIPT, "sh", path], { stdin: content, timeoutMs: 30_000 });
		// What `sh` says about a failure names the path, never the content.
		if (result.code !== 0) throw new Error(`cannot write ${path}: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`}`);
	}

	/** Removes files. A no-op for those that are gone, and when the container is. */
	async removeFiles(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await docker(["exec", this.container, "rm", "-f", "--", ...paths], { timeoutMs: 10_000 }).catch(() => undefined);
	}
}

interface Inspected {
	status: string;
	profile: SandboxProfileId;
	uid: string;
}

function stateOf(status: string): "none" | "running" | "paused" {
	if (status === "running" || status === "restarting") return "running";
	if (status === "created" || status === "exited" || status === "paused") return "paused";
	return "none";
}

/**
 * Removes the sandbox's access token file from the user's data volume, which outlives the container. A
 * turn removes its own when it ends; this is for one that was cut off with its server, or by the stop
 * that follows. The container must be running; a failure is nobody's (the token expires within the hour).
 */
async function forgetTokenFile(id: string): Promise<void> {
	const path = tokenFilePath(id);
	await docker(["exec", containerName(id), "rm", "-f", "--", path, `${path}.tmp`], { timeoutMs: 10_000 }).catch(() => undefined);
}

/** What the hosted provider and a runner's differ in. */
export interface DockerSandboxOptions {
	/** The sandbox image; windlass-platform-sandbox:latest when left out. */
	image?: string;
	/**
	 * Null for the hosted provider. A runner's machine id: every container it makes carries it as
	 * MACHINE_LABEL, and each provider lists and acts on only the containers whose machine label is its
	 * own (none for the hosted one), so a runner and a hosted server on one Docker daemon never see each
	 * other's sandboxes.
	 */
	machine: string | null;
	/**
	 * Makes sure the data volume of `uid`'s containers exists and returns its name: the one volume a
	 * container mounts, at Windlass's data directory. The hosted provider's is `wlp-user-<uid>`, which
	 * it also takes old sign-ins out of (volumes.ts); a runner's is its own, so the two never share one.
	 */
	dataVolume(uid: string): Promise<string>;
}

export class DockerSandboxes implements Sandboxes {
	private readonly image: string;
	private readonly machine: string;
	private readonly dataVolume: (uid: string) => Promise<string>;

	constructor(options: DockerSandboxOptions) {
		if (options.machine !== null && !NAME.test(options.machine)) throw new Error("invalid machine id");
		this.image = options.image ?? IMAGE;
		// A container without the label reads as "" (Go templates), which is the hosted provider's.
		this.machine = options.machine ?? "";
		this.dataVolume = options.dataVolume;
	}

	private async inspect(id: string): Promise<Inspected | null> {
		if (!SANDBOX_ID.test(id)) return null;
		const result = await docker(["container", "inspect", "--format", `{{.State.Status}}|{{index .Config.Labels "${LABEL}"}}|{{index .Config.Labels "${MACHINE_LABEL}"}}|{{index .Config.Labels "${LABEL}.profile"}}|{{index .Config.Labels "${LABEL}.uid"}}`, containerName(id)]);
		if (result.code !== 0) return null;
		const [status = "", ours = "", machine = "", profile = "", uid = ""] = result.stdout.trim().split("|");
		if (ours !== "1" || machine !== this.machine) return null;
		return { status, profile: profile as SandboxProfileId, uid };
	}

	/** The data directory is a volume of the user's (wlp-user-<uid>): it outlives every sandbox. */
	readonly sessionsLiveInSandbox = false;
	/** A container runs until it is stopped. */
	readonly idleStopMs = null;

	/** A container on the server's own machine is not billed by the second. */
	price(): SandboxPrice | null {
		return null;
	}

	/** The user's containers, by the labels each was made with. */
	async list(uid: string): Promise<ListedSandbox[]> {
		assertUid(uid);
		// Docker cannot filter by a label's absence: the hosted provider's are told apart below.
		const onMachine = this.machine === "" ? [] : ["--filter", `label=${MACHINE_LABEL}=${this.machine}`];
		const result = await docker(["ps", "-a", "--no-trunc", "--filter", `label=${LABEL_ARG}`, "--filter", `label=${LABEL}.uid=${uid}`, ...onMachine, "--format", `{{.Names}}|{{.State}}|{{.Label "${LABEL}.session"}}|{{.Label "${MACHINE_LABEL}"}}`], { timeoutMs: 30_000, check: true });
		const found: ListedSandbox[] = [];
		for (const line of result.stdout.split("\n")) {
			const [name = "", status = "", sessionId = "", machine = ""] = line.trim().split("|");
			const id = name.startsWith("wlp-session-") ? name.slice("wlp-session-".length) : "";
			const state = stateOf(status);
			if (SANDBOX_ID.test(id) && state !== "none" && machine === this.machine) found.push({ id, sessionId, state });
		}
		return found;
	}

	profiles(): SandboxProfile[] {
		return profilesFor("docker");
	}

	profile(id: SandboxProfileId): SandboxProfile {
		const profile = findProfile(id);
		return { ...profile, layers: [...profile.layers] };
	}

	async create(input: CreateSandboxInput): Promise<string> {
		assertUid(input.uid);
		const profile = findProfile(input.profile);
		const flags = PROFILE_RUN_FLAGS[input.profile];
		if (!profile.available || flags === undefined) throw new SandboxUserError(`The sandbox "${profile.name}" is not available: ${profile.unavailableReason ?? "not supported here"}`);
		// The reviewer cannot share transcripts or project-wide MCP approvals with the user's other sessions.
		const volume = input.privateData ? null : await this.dataVolume(input.uid);
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
				...(this.machine === "" ? [] : ["--label", `${MACHINE_LABEL}=${this.machine}`]),
				...COMMON_RUN_FLAGS,
				...flags,
				...(volume ? ["-v", `${volume}:${DATA_DIR}`] : []),
				this.image,
			],
			{ timeoutMs: 120_000 },
		);
		if (result.code !== 0) {
			await docker(["rm", "-f", name]);
			const message = result.stderr.trim();
			if (/No such image|pull access denied|not found/i.test(message)) throw new Error(`the sandbox image ${this.image} is missing; run sandbox/build.sh (${message})`);
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
		const found = await this.inspect(id);
		if (found === null || stateOf(found.status) === "none") return undefined;
		if (found.status === "paused") await docker(["unpause", containerName(id)], { check: true });
		else if (found.status !== "running") {
			const started = await docker(["start", containerName(id)], { timeoutMs: 60_000 });
			if (started.code !== 0) throw new Error(`could not start the sandbox: ${started.stderr.trim()}`);
		}
		return new DockerSandboxHandle(id, found.profile, found.uid);
	}

	async state(id: string): Promise<"none" | "running" | "paused"> {
		const found = await this.inspect(id);
		return found === null ? "none" : stateOf(found.status);
	}

	async suspend(id: string): Promise<void> {
		const found = await this.inspect(id);
		if (found === null || found.status !== "running") return;
		await forgetTokenFile(id);
		// SIGTERM to the container's init, SIGKILL after 5 s. A turn still running is cut off: stop it first.
		await docker(["stop", "-t", "5", containerName(id)], { timeoutMs: 60_000 });
	}

	async destroy(id: string): Promise<void> {
		const found = await this.inspect(id);
		if (found === null) return;
		if (found.status === "running") await forgetTokenFile(id);
		await docker(["rm", "-f", "-v", containerName(id)], { timeoutMs: 60_000, check: true });
	}
}
