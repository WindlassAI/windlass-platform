/**
 * Sandboxes on E2B: one microVM per agent session, made from the template sandbox/e2b/ builds from the
 * Docker image's own Dockerfile. Any server machine of a deployment reaches any of them by its id, so
 * nothing here is kept on one machine that another would need: what a sandbox is, whose it is and
 * whether it runs is asked of E2B every time (`E2bClient`, client.ts).
 *
 * Commands run through E2B's command API as `wlp-run exec <tag> …`, the same helper as in a container
 * (sandbox/wlp-run): every process of a run carries its tag, so a stop reaches all of them with a
 * second command. E2B's API takes a command as one string for a shell, so an argv is quoted
 * (`shellQuote`), and a value never becomes part of the string: it goes in as an argument or in the
 * environment.
 *
 * Keeping the use of E2B small is part of the provider, not an afterthought:
 *
 *   The dead-man switch   A sandbox has a timeout of its own, kept at E2B, and when it runs out E2B
 *                         pauses the sandbox by itself (`onTimeout: "pause"`: files and memory are
 *                         kept, nothing is billed). The timeout is short (WLP_E2B_IDLE_TIMEOUT_MS, two
 *                         minutes) and is only ever pushed out by a server that is alive: on `connect`,
 *                         and every minute while a turn runs (`holdForTurn`: WLP_E2B_TURN_LEASE_MS,
 *                         three minutes, set again every third of it) or a command outside a turn
 *                         takes long (cloning a repository). A server that crashes stops vouching, and
 *                         every sandbox it was using is paused within three minutes.
 *   The cap               No more than WLP_E2B_MAX_RUNNING sandboxes of the deployment run at once
 *                         (default 3; the Hobby plan itself allows 10). It is counted from E2B's own
 *                         list of the deployment's running sandboxes before a sandbox is created or
 *                         resumed, and again after: one that turns out to be one too many (two servers
 *                         looked at the same moment) is taken back at once. So the cap holds however
 *                         many servers there are, with no state shared between them.
 *   Metadata              Every sandbox carries `wlp_deployment`, `wlp_uid`, `wlp_session` and
 *                         `wlp_profile`. A sandbox without this deployment's mark is not one of ours:
 *                         it is never connected to, paused or killed (scripts/e2b-cleanup.ts lists and
 *                         removes the deployment's by the same mark).
 *   Suspend and destroy   `suspend` pauses (E2B keeps a paused sandbox without limit and bills nothing
 *                         for it, on the Hobby plan too), `destroy` kills. With WLP_E2B_PAUSE=0, for an
 *                         account that cannot pause, both the timeout and `suspend` kill instead, and
 *                         the session's files and its Windlass session are lost each time: a log line
 *                         says so when it happens.
 *   The plan's hour       A Hobby sandbox may run one hour without a pause (WLP_E2B_MAX_RUNTIME_MS). A
 *                         turn may take 45 minutes, so before a turn starts in a sandbox that has not
 *                         enough of its hour left, the sandbox is paused and resumed, which starts the
 *                         hour again (https://docs.e2b.dev/sandbox/persistence.md, "Continuous runtime limits").
 *   What it cost          When a sandbox stops running through this server (paused, killed), one line
 *                         says how long it ran and what that costs by E2B's published prices
 *                         (pricing.ts). An estimate: the time is this server's measurement.
 *
 * Windlass's data directory (session logs, memory, the turn's access token file) is on the microVM's
 * own disk, at the same path as in a container. No volume: E2B's volumes are a private beta in which
 * file locks can hang, and Windlass keeps SQLite databases there. So a session's Windlass state lives
 * and dies with its sandbox (`sessionsLiveInSandbox`), and nothing of one session is visible to another,
 * also not the token file of a turn of the same user.
 */

import { machineHarnesses } from "../harnesses.js";
import type { SandboxProfile, SandboxProfileId } from "../../contract.js";
import { type CreateSandboxInput, DeploymentFull, type ExecOptions, type ExecResult, type ListedSandbox, type SandboxHandle, type SandboxPrice, SandboxUserError, type Sandboxes } from "../api.js";
import { profilesFor } from "../profiles.js";
import {
	BWRAP_PROBE,
	type Answer,
	type InternalExecResult,
	NAME,
	type ProcessEnd,
	RUN_TAG,
	SECRET_FILE_SCRIPT,
	SWEEP_SCRIPT,
	type SandboxProcess,
	type StartOptions,
	type TurnSandbox,
	WORKSPACE,
	assertEnvNames,
	GIT_USER_ENV,
	gitProcess,
	markTurnSandbox,
	signalGitProcess,
	randomId,
	shellQuote,
} from "../provider.js";
import { tokenFilePath } from "../token-file.js";
import { E2bBusyError, type E2bClient, type E2bCommand, type E2bConnection, E2bLimitError, type E2bSandboxInfo } from "./client.js";
import { DEFAULT_CPU_COUNT, DEFAULT_MEMORY_MB, type E2bSettings } from "./config.js";
import { describeUsage, pricePerSecond } from "./pricing.js";

/** The metadata keys of a sandbox of the platform. */
export const META = { deployment: "wlp_deployment", uid: "wlp_uid", session: "wlp_session", profile: "wlp_profile" } as const;

/** E2B's sandbox ids are short strings of letters and digits; anything else was never one. */
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;
/** A template's own environment is only set while it is built, so what the Dockerfile's ENV gives a container is given here to every command. */
const SANDBOX_ENVS = { LANG: "C.UTF-8", NO_COLOR: "1" };
/** How often a refused pause is tried, and how long apart (E2B: "retry the pause after a short wait"). */
const PAUSE_TRIES = 3;
const PAUSE_RETRY_MS = 5_000;

/** What a user reads when the deployment already runs as many sandboxes as it may. */
export function capReached(limit: number): string {
	return `This deployment runs at most ${limit} ${limit === 1 ? "sandbox" : "sandboxes"} at the same time, and ${limit === 1 ? "it is" : "all of them are"} in use. Try again in a few minutes; an agent's sandbox is freed shortly after its turn has ended.`;
}
/** E2B itself refused: the account's own limit, whatever this deployment's is. */
export const ACCOUNT_LIMIT = "E2B refused to start another sandbox: its account is at the limit of its plan (sandboxes running at once, or sandboxes started per second). Try again in a few minutes.";
export const E2B_BUSY = "E2B could not start a sandbox just now. Try again in a minute.";

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]).finally(() => clearTimeout(timer));
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();

interface PlainResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** What this server knows of a sandbox it has used: for the turn's hold and for the line about what it cost. Nothing another server needs. */
interface Known {
	uid: string;
	session: string;
	cpuCount: number;
	memoryMB: number;
	/** Since when it has been running, as far as this server saw; null while it is not. */
	runningSince: number | null;
	/** When its timeout runs out unless someone pushes it out again: the latest it can still be running. */
	deadline: number;
	/** Turns at work in it (one, as the actors run them). */
	holds: number;
	keepalive: ReturnType<typeof setInterval> | undefined;
}

export interface E2bSandboxesOptions {
	/** Where the lines `[wlp] e2b.…` go. Default the console. */
	log?: (line: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Called with the Windlass version a new sandbox reported (`windlass --version` in the template). */
	onVersion?: (version: string) => void;
}

/** The profiles a sandbox on E2B can be made with. */
const E2B_PROFILES: readonly SandboxProfileId[] = ["e2b", "e2b-open"];

/** The profile a sandbox was made with, from its metadata. */
export function sandboxProfile(metadata: Record<string, string>): SandboxProfileId {
	const named = metadata[META.profile];
	return E2B_PROFILES.find((id) => id === named) ?? "e2b";
}

export class E2bSandboxHandle implements TurnSandbox {
	readonly cwd = WORKSPACE;

	constructor(
		private readonly owner: E2bSandboxes,
		/** Replaced when the sandbox was paused and resumed under the handle (`E2bSandboxes.holdFor`). */
		public connection: E2bConnection,
		readonly id: string,
		readonly uid: string,
		readonly profile: SandboxProfileId,
		readonly approval: "auto" | "full",
	) {
		markTurnSandbox(this);
	}

	run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return this.exec(["bash", "-c", command], options);
	}

	/** Starts argv (no shell of ours: each argument is quoted for E2B's) under wlp-run and leaves its standard input open. */
	start(argv: string[], options: StartOptions = {}): SandboxProcess {
		const tag = `r${randomId(6)}`;
		assertEnvNames(options.env);
		assertEnvNames(options.secretEnv);
		// Both kinds go in the request that starts the command (`envs`), never in the command's text.
		const envs = options.gitUser ? GIT_USER_ENV : options.secretEnv === undefined ? options.env : { ...options.secretEnv, ...options.env };
		const command = (options.gitUser ? gitProcess(tag, argv) : ["wlp-run", "exec", tag, ...argv]).map(shellQuote).join(" ");
		const emit = (handler: ((chunk: string) => void) | undefined, text: string) => {
			if (text === "" || handler === undefined) return;
			try {
				handler(text);
			} catch {
				// A listener's failure must not stop the program's output from being read.
			}
		};
		let running: E2bCommand | null = null;
		let hasEnded = false;
		let stdinOpen = true;
		/** A write failed: nothing more is sent, also not what was queued behind it. */
		let broken = false;
		const started = this.connection.start(command, { gitUser: options.gitUser, cwd: options.gitUser ? "/" : options.cwd ?? this.cwd, envs, stdin: true, onStdout: (text) => emit(options.onStdout, text), onStderr: (text) => emit(options.onStderr, text) });
		// Each `sendStdin` is a request of its own, so they go one after the other: what is written arrives in the order it was written.
		let queue: Promise<void> = started.then(
			(command) => {
				running = command;
			},
			() => {
				broken = true;
			},
		);
		let detach: (end: ProcessEnd) => void = () => {};
		const detached = new Promise<ProcessEnd>((resolve) => (detach = resolve));
		const natural = started.then(
			(command) =>
				command.wait().then(
					(result): ProcessEnd => {
						// What E2B says of a command a signal ended ("signal: killed"): then there is no exit code of the program's.
						const signal = /^signal: (.+)$/.exec(result.error?.trim() ?? "")?.[1] ?? null;
						return { code: signal === null ? result.exitCode : null, signal, error: null };
					},
					(error: unknown): ProcessEnd => ({ code: null, signal: null, error: new Error(`the connection to the command in the sandbox broke: ${messageOf(error)}`) }),
				),
			(error: unknown): ProcessEnd => ({ code: null, signal: null, error: new Error(`could not start the command in the sandbox: ${messageOf(error)}`) }),
		);
		const ended = Promise.race([natural, detached]).then((end) => {
			hasEnded = true;
			stdinOpen = false;
			return end;
		});
		return {
			tag,
			write: (text) => {
				if (!stdinOpen) return false;
				queue = queue
					.then(() => (broken || running === null ? undefined : running.sendStdin(text)))
					.catch(() => {
						broken = true;
						stdinOpen = false;
					});
				return true;
			},
			closeStdin: () => {
				if (!stdinOpen) return;
				stdinOpen = false;
				queue = queue.then(() => (broken || running === null ? undefined : running.closeStdin())).catch(() => undefined);
			},
			ended,
			get hasEnded() {
				return hasEnded;
			},
			signal: async (sig, who) => {
				await this.plain(options.gitUser ? signalGitProcess(tag, sig) : ["wlp-run", "signal", tag, sig, who], { gitUser: options.gitUser, timeoutMs: 10_000 }).catch(() => undefined);
			},
			killClient: () => {
				// As a killed `docker exec`: this side stops listening, and the program is left to `signal` and `sweep`.
				void started.then((command) => command.disconnect()).catch(() => undefined);
				detach({ code: null, signal: "SIGKILL", error: null });
			},
		};
	}

	/** Runs argv under wlp-run to its end, with stdin, streaming, timeout and a stop that reaches the sandbox. The same steps as on Docker (sandboxes.ts). */
	exec(argv: string[], options: ExecOptions = {}): Promise<InternalExecResult> {
		if (options.signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "", killed: false, stopLog: [], leftovers: 0 });
		let stdout = "";
		let stderr = "";
		const run = this.start(argv, {
			gitUser: options.gitUser,
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
		// A command that takes long (cloning a repository) would outlast the sandbox's short timeout, which only a
		// `connect` or a turn pushes out. One that is still running after a third of that timeout is vouched for like
		// a turn, until it ends. Short commands, which are nearly all, cost E2B no extra request.
		let holding: Promise<() => Promise<void>> | null = null;
		const holdTimer = setTimeout(() => {
			holding = this.owner.holdFor(this, { refresh: false }).catch(() => async () => {});
		}, this.owner.holdCommandsAfterMs);
		const letGo = async () => {
			clearTimeout(holdTimer);
			if (holding !== null) await (await holding)();
		};

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
				note("stopped listening to the command");
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

		return run.ended
			.then(async (end) => {
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
			})
			.finally(letGo);
	}

	/**
	 * Runs argv to its end, not under wlp-run: what a plain `docker exec` is on Docker. `stdin` is written
	 * and closed. Rejects when the command could not be started or the connection to it broke.
	 */
	private async plain(argv: string[], options: { gitUser?: true; stdin?: string; env?: Record<string, string>; timeoutMs: number }): Promise<PlainResult> {
		let stdout = "";
		let stderr = "";
		const command = await this.connection.start(argv.map(shellQuote).join(" "), {
			gitUser: options.gitUser, cwd: options.gitUser ? "/" : this.cwd,
			envs: options.gitUser ? GIT_USER_ENV : options.env,
			stdin: options.stdin !== undefined,
			onStdout: (text) => (stdout += text),
			onStderr: (text) => (stderr += text),
		});
		const done = command.wait();
		// Observed here whatever happens below, so that a command given up on leaves no unhandled rejection behind.
		done.catch(() => undefined);
		if (options.stdin !== undefined) {
			if (options.stdin !== "") await command.sendStdin(options.stdin);
			await command.closeStdin();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), options.timeoutMs)));
		try {
			const result = await Promise.race([done, timeout]);
			if (result === "timeout") {
				await command.kill().catch(() => undefined);
				return { code: null, stdout, stderr, timedOut: true };
			}
			return { code: /^signal: /.test(result.error?.trim() ?? "") ? null : result.exitCode, stdout, stderr, timedOut: false };
		} finally {
			clearTimeout(timer);
		}
	}

	async ask(argv: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Answer | null> {
		const result = await this.plain(argv, { env: options.env, timeoutMs: options.timeoutMs ?? 60_000 }).catch(() => null);
		return result === null ? null : { code: result.code, stdout: result.stdout, stderr: result.stderr };
	}

	async stopLeftovers(program: string): Promise<number> {
		const found = await this.plain(["wlp-run", "tags-of", program], { timeoutMs: 10_000 });
		const tags = found.stdout.split("\n").filter((tag) => RUN_TAG.test(tag));
		await Promise.all(
			tags.map(async (tag) => {
				await this.plain(["wlp-run", "signal", tag, "INT", "leader"], { timeoutMs: 10_000 });
				await this.sweep(tag, { waitMs: 3000 });
			}),
		);
		return tags.length;
	}

	async sweep(tag: string, options: { waitMs?: number; files?: string[] } = {}): Promise<number> {
		if (!RUN_TAG.test(tag)) throw new Error("invalid run tag");
		const list = async () => {
			const result = await this.plain(["wlp-run", "list", tag], { timeoutMs: 10_000 }).catch(() => null);
			if (result === null || result.code !== 0) return 0; // the sandbox is gone or paused: nothing runs
			return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
		};
		const files = options.files ?? [];
		const waitMs = options.waitMs ?? 0;
		if (waitMs > 0 || files.length === 0) {
			const deadline = Date.now() + waitMs;
			let count = await list();
			while (count > 0 && Date.now() < deadline) {
				await realSleep(150);
				count = await list();
			}
			if (count === 0 && files.length === 0) return 0;
		}
		const result = await this.plain(["sh", "-c", SWEEP_SCRIPT, "sh", tag, ...files], { timeoutMs: 15_000 }).catch(() => null);
		const left = result === null || result.code !== 0 ? 0 : Number(result.stdout.trim());
		return Number.isFinite(left) ? left : 0;
	}

	/** A path as E2B's file API needs it: that API resolves a relative one against the user's home, not the workspace. */
	private absolute(path: string): string {
		return path.startsWith("/") ? path : `${this.cwd}/${path}`;
	}

	async readTextFile(path: string): Promise<string> {
		try {
			return await this.connection.readFile(this.absolute(path));
		} catch (error) {
			throw new Error(`cannot read ${path}: ${messageOf(error)}`);
		}
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		try {
			await this.connection.writeFile(this.absolute(path), content);
		} catch (error) {
			throw new Error(`cannot write ${path}: ${messageOf(error)}`);
		}
	}

	/**
	 * The same script as on Docker, the content on the command's standard input: it travels to the sandbox
	 * inside E2B's API request (TLS) and is on no command line. E2B's file API is not used for it: it
	 * promises neither the mode nor that the file appears whole.
	 */
	async writeSecretFile(path: string, content: string): Promise<void> {
		let result: PlainResult;
		try {
			result = await this.plain(["sh", "-c", SECRET_FILE_SCRIPT, "sh", path], { stdin: content, timeoutMs: 30_000 });
		} catch (error) {
			// What E2B says about a failure names the command, never its input.
			throw new Error(`cannot write ${path}: ${messageOf(error)}`);
		}
		if (result.code !== 0) throw new Error(`cannot write ${path}: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`}`);
	}

	async removeFiles(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.plain(["rm", "-f", "--", ...paths], { timeoutMs: 10_000 }).catch(() => undefined);
	}

	holdForTurn(): Promise<() => Promise<void>> {
		return this.owner.holdFor(this);
	}
}

export class E2bSandboxes implements Sandboxes {
	/** Windlass's data directory is on the sandbox's own disk. */
	readonly sessionsLiveInSandbox = true;
	/** A sandbox nobody uses is paused by E2B when its idle timeout runs out ("The dead-man switch"). */
	readonly idleStopMs: number;
	/** The size E2B last said a sandbox of this deployment has; until one was seen, the size the template is built with. */
	private size = { cpuCount: DEFAULT_CPU_COUNT, memoryMB: DEFAULT_MEMORY_MB };
	private readonly known = new Map<string, Known>();
	/** How long a command outside a turn may run before the sandbox is vouched for as for a turn (`E2bSandboxHandle.exec`). */
	readonly holdCommandsAfterMs: number;
	private readonly log: (line: string) => void;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly client: E2bClient,
		private readonly settings: E2bSettings,
		private readonly options: E2bSandboxesOptions = {},
	) {
		this.log = options.log ?? ((line) => console.log(line));
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? realSleep;
		this.holdCommandsAfterMs = Math.floor(settings.idleTimeoutMs / 3);
		this.idleStopMs = settings.idleTimeoutMs;
	}

	/** By E2B's published prices for the size of the deployment's sandboxes (pricing.ts): an estimate. */
	price(): SandboxPrice {
		return pricePerSecond(this.size.cpuCount, this.size.memoryMB);
	}

	/** The user's sandboxes of this deployment, by E2B's own list: running and paused. */
	async list(uid: string): Promise<ListedSandbox[]> {
		if (!NAME.test(uid)) return [];
		const found = await this.client.list({ metadata: { [META.deployment]: this.settings.deployment, [META.uid]: uid } });
		// The filter is E2B's; a sandbox is only taken for this user's when its own metadata says so too.
		return found.filter((info) => info.metadata[META.deployment] === this.settings.deployment && info.metadata[META.uid] === uid).map((info) => ({ id: info.sandboxId, sessionId: info.metadata[META.session] ?? "", state: info.state }));
	}

	profiles(): SandboxProfile[] {
		return profilesFor("e2b", this.settings);
	}

	profile(id: SandboxProfileId): SandboxProfile {
		const profile = this.profiles().find((item) => item.id === id);
		if (profile === undefined) throw new Error(`unknown sandbox profile: ${String(id)}`);
		return profile;
	}

	async create(input: CreateSandboxInput): Promise<string> {
		if (input.harness) throw new SandboxUserError(`${machineHarnesses[input.harness].name} runs only on a machine of yours.`);
		if (typeof input.uid !== "string" || !NAME.test(input.uid)) throw new Error('invalid user id: it must be 1 to 64 letters, digits, "_" or "-", starting with a letter or digit');
		const profile = this.profile(input.profile);
		if (!profile.available || !E2B_PROFILES.includes(profile.id)) throw new SandboxUserError(`The sandbox "${profile.name}" is not available: ${profile.unavailableReason ?? "not supported here"}`);
		await this.assertRoom();
		let connection: E2bConnection;
		try {
			connection = await this.client.create({
				template: input.screenshots ? this.settings.shotsTemplate : this.settings.template,
				timeoutMs: this.settings.idleTimeoutMs,
				metadata: { [META.deployment]: this.settings.deployment, [META.uid]: input.uid, [META.session]: input.sessionId.slice(0, 200), [META.profile]: input.profile },
				envs: SANDBOX_ENVS,
				onTimeout: this.settings.pause ? "pause" : "kill",
			});
		} catch (error) {
			if (error instanceof E2bLimitError) throw new SandboxUserError(ACCOUNT_LIMIT);
			if (error instanceof E2bBusyError) throw new SandboxUserError(E2B_BUSY);
			throw new Error(`could not create the sandbox: ${messageOf(error)}`);
		}
		const id = connection.sandboxId;
		const began = this.now();
		const discard = async () => {
			await this.client.kill(id).catch((error: unknown) => this.log(`[wlp] e2b.sandbox.kill_failed id=${id}: ${messageOf(error)}; its own timeout stops it within ${Math.round(this.settings.idleTimeoutMs / 1000)} s`));
		};
		// Another server may have looked at the list at the same moment and made one too: then this one is one too many.
		const running = await this.running().catch(() => null);
		if (running !== null && running.length > this.settings.maxRunning) {
			await discard();
			this.log(`[wlp] e2b.cap_reached deployment=${this.settings.deployment}: ${running.length} sandboxes ran at once where ${this.settings.maxRunning} may; the newest (id=${id}) was removed again`);
			throw new DeploymentFull(this.settings.maxRunning, capReached(this.settings.maxRunning));
		}
		const handle = new E2bSandboxHandle(this, connection, id, input.uid, profile.id, profile.approval);
		try {
			const init = await handle.exec(["sh", "-c", 'git init -q && git commit -q --allow-empty -m "Empty workspace" && windlass --version'], { timeoutMs: 60_000 });
			if (init.exitCode !== 0) throw new Error(`could not set up the workspace: ${(init.stderr.trim() || init.stdout.trim() || `exit ${init.exitCode}`).slice(-500)}`);
			// "Windlass 0.4.0 (linux-x64)"
			const version = /^\S+\s+(\S+)/.exec(init.stdout.trim().split("\n").pop() ?? "")?.[1];
			if (version !== undefined) this.options.onVersion?.(version);
			if (profile.id === "e2b" && this.settings.windlassSandbox) {
				// The profile promises Windlass's sandbox, so a sandbox in which it cannot work is not handed out. `e2b-open` promises none.
				const probe = await handle.ask(BWRAP_PROBE, { timeoutMs: 20_000 });
				if (probe === null || probe.code !== 0) throw new Error(`bubblewrap does not work in this sandbox, so Windlass could not sandbox commands in it as WLP_E2B_WINDLASS_SANDBOX=1 promises (${probe === null ? "the probe could not be run" : probe.stderr.trim().slice(-300) || `exit ${probe.code}`}). Unset it, or rebuild the template`);
			}
		} catch (error) {
			await discard();
			throw error;
		}
		const info = await this.client.info(id).catch(() => undefined);
		if (info !== undefined && info.cpuCount > 0 && info.memoryMB > 0) this.size = { cpuCount: info.cpuCount, memoryMB: info.memoryMB };
		this.known.set(id, { uid: input.uid, session: input.sessionId, cpuCount: info?.cpuCount ?? 0, memoryMB: info?.memoryMB ?? 0, runningSince: began, deadline: began + this.settings.idleTimeoutMs, holds: 0, keepalive: undefined });
		this.log(`[wlp] e2b.sandbox.created id=${id} uid=${input.uid} session=${input.sessionId} template=${this.settings.template}${running === null ? "" : `: ${running.length} of at most ${this.settings.maxRunning} running`}`);
		return id;
	}

	async connect(id: string): Promise<SandboxHandle | undefined> {
		const info = await this.ours(id);
		if (info === undefined) return undefined;
		const paused = info.state === "paused";
		// Starting a paused sandbox adds one to those that run, as creating one does.
		if (paused) await this.assertRoom();
		let connection: E2bConnection | undefined;
		try {
			connection = await this.client.connect(id, this.settings.idleTimeoutMs);
		} catch (error) {
			if (error instanceof E2bLimitError) throw new SandboxUserError(ACCOUNT_LIMIT);
			if (error instanceof E2bBusyError) throw new SandboxUserError(E2B_BUSY);
			throw new Error(`could not start the sandbox: ${messageOf(error)}`);
		}
		if (connection === undefined) return undefined;
		const now = this.now();
		const known = this.remember(info);
		// The profile the sandbox was made with, as E2B keeps it: whichever server connects runs Windlass the same way.
		const made = sandboxProfile(info.metadata);
		const handle = new E2bSandboxHandle(this, connection, id, known.uid, made, this.profile(made).approval);
		if (paused) {
			const running = await this.running().catch(() => null);
			if (running !== null && running.length > this.settings.maxRunning) {
				await this.client.pause(id).catch(() => undefined);
				this.log(`[wlp] e2b.cap_reached deployment=${this.settings.deployment}: ${running.length} sandboxes ran at once where ${this.settings.maxRunning} may; id=${id} was paused again`);
				throw new DeploymentFull(this.settings.maxRunning, capReached(this.settings.maxRunning));
			}
			known.runningSince = now;
			known.deadline = now + this.settings.idleTimeoutMs;
			this.log(`[wlp] e2b.sandbox.resumed id=${id} uid=${known.uid} session=${known.session}`);
			await this.tidy(handle);
		} else {
			known.runningSince ??= info.startedAt;
			// A connect only ever pushes the timeout out.
			if (known.holds === 0) known.deadline = Math.max(info.endAt, now + this.settings.idleTimeoutMs);
		}
		return handle;
	}

	async state(id: string): Promise<"none" | "running" | "paused"> {
		const info = await this.ours(id);
		return info === undefined ? "none" : info.state;
	}

	async suspend(id: string): Promise<void> {
		const info = await this.ours(id);
		if (info === undefined || info.state !== "running") return;
		if (!this.settings.pause) {
			// Said plainly, each time: without a pause there is nothing to come back to.
			await this.client.kill(id);
			this.ended(info, "killed", "WLP_E2B_PAUSE=0, so it was killed where it would have been paused: the files in its workspace and its Windlass session are lost");
			return;
		}
		// The access token file a turn that was cut off left behind. A turn that ended removed its own.
		const connection = await this.client.connect(id, this.settings.idleTimeoutMs).catch(() => undefined);
		if (connection !== undefined) {
			const path = tokenFilePath(id);
			const made = sandboxProfile(info.metadata);
			await new E2bSandboxHandle(this, connection, id, info.metadata[META.uid] ?? "", made, this.profile(made).approval).removeFiles([path, `${path}.tmp`]);
		}
		for (let attempt = 1; ; attempt += 1) {
			try {
				await this.client.pause(id);
				break;
			} catch (error) {
				// E2B is still writing an earlier snapshot of it: the sandbox goes on running, and a little later the pause works.
				if (!(error instanceof E2bBusyError) || attempt >= PAUSE_TRIES) throw new Error(`could not pause the sandbox (its own timeout pauses it within ${Math.round(this.settings.idleTimeoutMs / 1000)} s): ${messageOf(error)}`);
				await this.sleep(PAUSE_RETRY_MS);
			}
		}
		this.ended(info, "paused");
	}

	async destroy(id: string): Promise<void> {
		const info = await this.ours(id);
		if (info === undefined) return;
		await this.client.kill(id);
		this.ended(info, "killed");
		this.forget(id);
	}

	/**
	 * A turn starts in the sandbox: from now until the returned function is called, this server pushes the
	 * sandbox's timeout out again and again, so the sandbox runs for as long as the turn and stops soon
	 * after a server that died. Before that, a sandbox that has too little left of the time the plan lets
	 * it run without a pause is paused and resumed, which starts that time again (`refresh: false` leaves
	 * that out: for a command that is already running, which a pause would cut off).
	 */
	async holdFor(handle: E2bSandboxHandle, options: { refresh?: boolean } = {}): Promise<() => Promise<void>> {
		const id = handle.id;
		const known = this.known.get(id) ?? this.remember({ sandboxId: id, templateId: "", state: "running", metadata: { [META.uid]: handle.uid }, startedAt: this.now(), endAt: this.now(), cpuCount: 0, memoryMB: 0 });
		known.holds += 1;
		if (known.holds === 1) {
			try {
				const ran = known.runningSince === null ? 0 : this.now() - known.runningSince;
				const needed = this.settings.turnLimitMs + this.settings.turnLeaseMs;
				// Only where a pause helps: a turn that would not fit into a whole fresh period is not helped by starting one.
				if (options.refresh !== false && this.settings.pause && needed < this.settings.maxRuntimeMs && ran + needed > this.settings.maxRuntimeMs) await this.refresh(handle, known, ran);
				await this.client.setTimeout(id, this.settings.turnLeaseMs);
				known.deadline = this.now() + this.settings.turnLeaseMs;
			} catch (error) {
				known.holds -= 1;
				throw error;
			}
			let failed = false;
			known.keepalive = setInterval(
				() => {
					this.client.setTimeout(id, this.settings.turnLeaseMs).then(
						() => {
							known.deadline = this.now() + this.settings.turnLeaseMs;
							failed = false;
						},
						(error: unknown) => {
							// Once per failure, not once a minute: the turn finds out by itself when its sandbox stops.
							if (!failed) this.log(`[wlp] e2b.keepalive_failed id=${id}: the sandbox's timeout could not be pushed out (${messageOf(error)}); unless that changes it stops ${Math.max(0, Math.round((known.deadline - this.now()) / 1000))} s from now, and the turn in it with it`);
							failed = true;
						},
					);
				},
				Math.max(1_000, Math.floor(this.settings.turnLeaseMs / 3)),
			);
			// A turn that has ended otherwise must not be kept alive by this.
			known.keepalive.unref?.();
		}
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			known.holds -= 1;
			if (known.holds > 0) return;
			clearInterval(known.keepalive);
			known.keepalive = undefined;
			// Back to the short timeout: from here the sandbox waits for the next `connect`, and not for long.
			await this.client.setTimeout(id, this.settings.idleTimeoutMs).then(
				() => {
					known.deadline = this.now() + this.settings.idleTimeoutMs;
				},
				() => undefined,
			);
		};
	}

	/**
	 * Removes the access token files of the user's turns that are running now, each in its session's
	 * sandbox: for a sign-in that was forgotten. A paused sandbox is left alone; what it holds is removed
	 * when it is next resumed (`tidy`).
	 */
	async forgetTokenFiles(uid: string): Promise<void> {
		if (!NAME.test(uid)) return;
		const running = await this.client.list({ metadata: { [META.deployment]: this.settings.deployment, [META.uid]: uid }, state: ["running"] });
		await Promise.all(
			running.map(async (info) => {
				const connection = await this.client.connect(info.sandboxId, this.settings.idleTimeoutMs);
				if (connection === undefined) return;
				const path = tokenFilePath(info.sandboxId);
				const made = sandboxProfile(info.metadata);
				await new E2bSandboxHandle(this, connection, info.sandboxId, uid, made, this.profile(made).approval).removeFiles([path, `${path}.tmp`]);
			}),
		);
	}

	/** The deployment's sandboxes that run now, by E2B's own list. */
	running(): Promise<E2bSandboxInfo[]> {
		return this.client.list({ metadata: { [META.deployment]: this.settings.deployment }, state: ["running"] });
	}

	private async assertRoom(): Promise<void> {
		const running = await this.running();
		if (running.length < this.settings.maxRunning) return;
		this.log(`[wlp] e2b.cap_reached deployment=${this.settings.deployment}: ${running.length} of at most ${this.settings.maxRunning} sandboxes are running; none was started`);
		throw new DeploymentFull(this.settings.maxRunning, capReached(this.settings.maxRunning));
	}

	/** The sandbox, when it exists and is this deployment's. */
	private async ours(id: string): Promise<E2bSandboxInfo | undefined> {
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) return undefined;
		const info = await this.client.info(id);
		const known = this.known.get(id);
		if (info === undefined || info.metadata[META.deployment] !== this.settings.deployment) {
			if (info === undefined && known !== undefined) {
				this.stoppedByItself(id, known, "is gone");
				this.forget(id);
			}
			return undefined;
		}
		if (info.state === "paused" && known !== undefined) this.stoppedByItself(id, known, "was paused");
		return info;
	}

	private remember(info: E2bSandboxInfo): Known {
		let known = this.known.get(info.sandboxId);
		if (known === undefined) {
			known = { uid: info.metadata[META.uid] ?? "", session: info.metadata[META.session] ?? "", cpuCount: info.cpuCount, memoryMB: info.memoryMB, runningSince: null, deadline: info.endAt, holds: 0, keepalive: undefined };
			this.known.set(info.sandboxId, known);
		}
		if (info.cpuCount > 0) known.cpuCount = info.cpuCount;
		if (info.memoryMB > 0) known.memoryMB = info.memoryMB;
		if (info.cpuCount > 0 && info.memoryMB > 0) this.size = { cpuCount: info.cpuCount, memoryMB: info.memoryMB };
		return known;
	}

	private forget(id: string): void {
		const known = this.known.get(id);
		if (known?.keepalive !== undefined) clearInterval(known.keepalive);
		this.known.delete(id);
	}

	/** The sandbox stopped running through this server: one line with how long it ran and what that costs, by estimate. */
	private ended(info: E2bSandboxInfo, how: "paused" | "killed", note = ""): void {
		const known = this.remember(info);
		const since = info.state === "running" ? (known.runningSince ?? info.startedAt) : null;
		const ran = since === null ? "it was paused already, so nothing ran" : `it ran ${describeUsage((this.now() - since) / 1000, known.cpuCount, known.memoryMB)}`;
		known.runningSince = null;
		this.log(`[wlp] e2b.sandbox.${how} id=${info.sandboxId} uid=${known.uid} session=${known.session}: ${ran}${note === "" ? "" : `; ${note}`}`);
	}

	/** This server last saw the sandbox running and now it is not: its own timeout stopped it. How long it ran is known to the timeout at most. */
	private stoppedByItself(id: string, known: Known, what: string): void {
		if (known.runningSince === null) return;
		const until = Math.min(this.now(), known.deadline);
		this.log(`[wlp] e2b.sandbox.timed_out id=${id} uid=${known.uid} session=${known.session}: it ${what} by its own timeout; it ran at most ${describeUsage(Math.max(0, until - known.runningSince) / 1000, known.cpuCount, known.memoryMB)}`);
		known.runningSince = null;
	}

	/** Pauses the sandbox and resumes it, which starts the time the plan lets it run without a pause again. */
	private async refresh(handle: E2bSandboxHandle, known: Known, ran: number): Promise<void> {
		const id = handle.id;
		this.log(`[wlp] e2b.sandbox.refreshed id=${id}: it has run ${Math.round(ran / 60_000)} min of the ${Math.round(this.settings.maxRuntimeMs / 60_000)} the plan allows without a pause, which leaves too little for a turn, so it is paused and resumed before the turn starts`);
		await this.client.pause(id);
		const connection = await this.client.connect(id, this.settings.idleTimeoutMs);
		if (connection === undefined) throw new Error("the sandbox was gone after it was paused");
		handle.connection = connection;
		known.runningSince = this.now();
	}

	/**
	 * What a sandbox that was just resumed may still hold of a turn that was cut off with its server: E2B
	 * restores memory too, so that turn's Windlass would go on working, with nobody listening, on the
	 * access token in its file. Both are removed before anything else happens in the sandbox.
	 */
	private async tidy(handle: E2bSandboxHandle): Promise<void> {
		const path = tokenFilePath(handle.id);
		const stopped = await handle.stopLeftovers("windlass").catch(() => 0);
		await handle.removeFiles([path, `${path}.tmp`]);
		if (stopped > 0) this.log(`[wlp] e2b.sandbox.tidied id=${handle.id}: stopped ${stopped} Windlass run(s) that a turn cut off before the pause had left in it`);
	}
}
