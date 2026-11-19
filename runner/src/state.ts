import { spawnSync } from "node:child_process";
import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_ID } from "../../server/src/runner/control.js";
import { list, object, is, text, json, nullable } from "../../server/src/runner/check.js";
import { NAME } from "../../server/src/sandbox/provider.js";
import manifest from "../package.json";

export const VERSION = manifest.version;
export const directory = process.env.WLP_RUNNER_STATE_DIR ?? "/var/lib/windlass-runner";
export class RunnerError extends Error {}
export class Refusal extends RunnerError {}

export function origin(address: string): string {
	let u: URL;
	try { u = new URL(address); } catch { throw new RunnerError("Give a platform HTTPS origin."); }
	if (u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
		!(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))))
		throw new RunnerError("Use an HTTPS origin, or HTTP on loopback.");
	return u.origin;
}

const identity = object({ uid: is<string>(v => typeof v === "string" && NAME.test(v)), machineId: is<string>(v => typeof v === "string" && MACHINE_ID.test(v)) });
export type Identity = { uid: string; machineId: string };
const record = object({ current: identity, previous: list(identity), platform: text(2048), key: nullable(text(512)) });

export function read(file: string): unknown {
	const path = join(directory, file);
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || (stat.mode & 0o077) !== 0)
			throw new RunnerError(`Restore ${file} as a private regular file (mode 0600) in the runner state volume.`);
		const value = json(readFileSync(path, "utf8"));
		if (value === undefined) throw new Error("invalid JSON");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof RunnerError) throw error;
		throw new RunnerError(`Cannot read ${file}. Repair or restore that file in the runner state volume.`);
	}
}
export function save(file: string, value: unknown): void {
	const path = join(directory, file);
	const temp = path + "." + randomUUID();
	try {
		writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally { rmSync(temp, { force: true }); }
}
export function loadPair() {
	const stored = read("pair.json");
	if (stored === undefined) return;
	const invalid = () => new RunnerError("Invalid pair.json. Repair or restore that file in the runner state volume.");
	if (!record(stored)) throw invalid();
	try { origin(stored.platform); } catch { throw invalid(); }
	let key: KeyObject | null = null;
	if (stored.key !== null) {
		try { key = createPrivateKey(stored.key); } catch { throw invalid(); }
		if (key.asymmetricKeyType !== "ed25519") throw invalid();
	}
	return { current: stored.current, previous: stored.previous, platform: stored.platform, key };
}
export function forgetKey() {
	const paired = loadPair();
	if (paired) save("pair.json", { ...paired, key: null });
}
export function storePair(current: Identity, key: KeyObject, platform: string) {
	const prior = loadPair();
	const previous = prior ? [...prior.previous, prior.current].filter(m => m.machineId !== current.machineId) : [];
	save("pair.json", { current, previous, platform, key: key.export({ type: "pkcs8", format: "pem" }).toString() });
	return { current, previous, key, platform };
}

// flock also works across Docker PID namespaces (two services can both be PID 1).
// Keep the fd open until exit. The kernel releases it even on SIGKILL; the PID is diagnostic.
export function tryLock(): boolean {
	mkdirSync(directory, { mode: 0o700, recursive: true });
	chmodSync(directory, 0o700);
	const fd = openSync(join(directory, "lock"), "a+", 0o600);
	const result = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
	if (result.status !== 0) {
		closeSync(fd);
		if (result.status === 1) return false;
		throw new RunnerError("The runner needs flock to lock its state.");
	}
	process.once("exit", () => closeSync(fd));
	ftruncateSync(fd);
	writeFileSync(fd, String(process.pid) + "\n");
	return true;
}

export function serviceRunning(): boolean {
	const path = join(directory, "lock");
	if (!existsSync(path)) return false;
	return spawnSync("flock", ["-n", "-s", path, "true"]).status === 1;
}
