/**
 * The `docker` CLI, driven with node:child_process. Nothing else in the sandbox layer spawns processes.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { DATA_DIR, WORKSPACE, randomId } from "./provider.js";

// The layout inside a sandbox is every provider's, so provider.ts names it; it is passed on here for the Docker code.
export { DATA_DIR, WORKSPACE, randomId };

/** Use the local published image by default. Checks pass their pinned image ID to child servers. */
export const IMAGE = process.env.WLP_SANDBOX_IMAGE || "windlass-platform-sandbox:latest";
export const SHOTS_IMAGE = process.env.WLP_SANDBOX_SHOTS_IMAGE || "windlass-platform-sandbox:shots";
/** Every resource the platform creates carries `dev.windlass-platform=1`. */
export const LABEL = "dev.windlass-platform";
export const LABEL_ARG = `${LABEL}=1`;
/**
 * The machine id a runner's containers carry. Every container of the sandbox image carries LABEL from
 * the image itself, so this is what keeps a runner's containers and the hosted provider's apart when
 * both use one Docker daemon: each provider sees only those whose machine is its own, the hosted one
 * those with none (`DockerSandboxes`).
 */
export const MACHINE_LABEL = `${LABEL}.machine`;
/**
 * The log policy of every container the platform and the runner start, whatever the daemon's default. Nothing
 * reads the log of a session, egress or helper container, and the agent can write to a session
 * container's main process output, so those keep none: an unbounded default log would let it fill the host's
 * disk. Machine relays and the runner keep rotated logs, because `docker logs windlass-runner` is how an
 * operator reads it.
 */
export const NO_LOGS = ["--log-driver", "none"];
export const RELAY_LOGS = ["--log-driver", "json-file", "--log-opt", "max-size=4m", "--log-opt", "max-file=2"];
export const RUNNER_LOGS = ["--log-driver", "json-file", "--log-opt", "max-size=16m", "--log-opt", "max-file=3"];

export interface DockerResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface DockerOptions {
	/** Consume large listings incrementally instead of retaining stdout in memory. */
	onStdout?: (chunk: string) => void;
	stdin?: string;
	timeoutMs?: number;
	/** Rejects with the command's stderr when it exits non-zero. */
	check?: boolean;
}

/** Runs `docker <args>` to its end and returns what it printed. */
export function docker(args: string[], options: DockerOptions = {}): Promise<DockerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const out = new StringDecoder("utf8");
		const err = new StringDecoder("utf8");
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const collect = options.onStdout ?? ((chunk: string) => { stdout += chunk; });
		child.stdout.on("data", (chunk: Buffer) => collect(out.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => (stderr += err.write(chunk)));
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin ?? "");
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						child.kill("SIGKILL");
					}, options.timeoutMs);
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(new Error(`could not run docker: ${error.message}`));
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			collect(out.end());
			stderr += err.end();
			const result = { code, stdout, stderr, timedOut };
			if (options.check && code !== 0) reject(new Error(`docker ${args[0]} failed (${timedOut ? "timed out" : `exit ${code}`}): ${stderr.trim() || stdout.trim()}`));
			else resolve(result);
		});
	});
}

/** Marks the helper containers this process starts, so one process can find its own among another's. */
export const PROCESS_MARK = randomId(3);

/** A short-lived helper container's name: `wlp-tmp-<this process>-<random>`. */
export function tmpName(): string {
	return `wlp-tmp-${PROCESS_MARK}-${randomId(4)}`;
}

export async function volumeExists(name: string): Promise<boolean> {
	const result = await docker(["volume", "inspect", "--format", "{{.Name}}", name]);
	return result.code === 0;
}

export async function createVolume(name: string, extraLabels: Record<string, string> = {}): Promise<void> {
	const labels = Object.entries(extraLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
	await docker(["volume", "create", "--label", LABEL_ARG, ...labels, name], { check: true });
}

export async function removeVolume(name: string): Promise<void> {
	// Only a volume of ours: check the label before removing.
	const result = await docker(["volume", "inspect", "--format", `{{index .Labels "${LABEL}"}}`, name]);
	if (result.code !== 0 || result.stdout.trim() !== "1") return;
	await docker(["volume", "rm", "-f", name], { check: true });
}

/** Flags shared by every helper container (login steps, access tokens, version probe). */
export function helperFlags(name: string, network: "none" | "bridge"): string[] {
	return [
		"--rm",
		"-i",
		"--init",
		...NO_LOGS,
		"--name",
		name,
		"--label",
		LABEL_ARG,
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--network",
		network,
		"--memory",
		"512m",
		"--pids-limit",
		"128",
	];
}

/**
 * Runs a throwaway container to its end. On a timeout the container itself is removed too (killing the
 * local client does not stop it).
 */
export async function runHelper(flags: string[], name: string, command: string[], options: { stdin?: string; timeoutMs?: number; image?: string } = {}): Promise<DockerResult> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const result = await docker(["run", ...flags, options.image ?? IMAGE, ...command], { stdin: options.stdin, timeoutMs });
	if (result.timedOut) await docker(["rm", "-f", name]);
	return result;
}
