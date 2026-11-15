/**
 * The `docker` CLI, driven with node:child_process. Nothing else in the sandbox layer spawns processes.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/** The sandbox image the server uses. A layer made for another one (`createSandboxLayer({ image })`) is for the layer's own checks. */
export const IMAGE = "windlass-platform-sandbox:latest";
/** Every resource the platform creates carries `dev.windlass-platform=1`. */
export const LABEL = "dev.windlass-platform";
export const LABEL_ARG = `${LABEL}=1`;
/** Windlass's data directory inside the image (`$XDG_DATA_HOME` is unset, so `~/.local/share/windlass`). */
export const DATA_DIR = "/home/agent/.local/share/windlass";
export const WORKSPACE = "/workspace";

export interface DockerResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface DockerOptions {
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
		child.stdout.on("data", (chunk: Buffer) => (stdout += out.write(chunk)));
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
			stdout += out.end();
			stderr += err.end();
			const result = { code, stdout, stderr, timedOut };
			if (options.check && code !== 0) reject(new Error(`docker ${args[0]} failed (${timedOut ? "timed out" : `exit ${code}`}): ${stderr.trim() || stdout.trim()}`));
			else resolve(result);
		});
	});
}

export function randomId(bytes = 8): string {
	return randomBytes(bytes).toString("hex");
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
