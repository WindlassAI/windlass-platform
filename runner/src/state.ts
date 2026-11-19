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
	if (!existsSync(path)) return undefined;
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new RunnerError("The runner state must be a private regular file.");
	const value = json(readFileSync(path, "utf8"));
	if (value === undefined) throw new RunnerError("The runner state is unreadable.");
	return value;
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
	if (!record(stored)) throw new RunnerError("Invalid pairing state. Check the runner's state volume.");
	origin(stored.platform);
	let key: KeyObject | null = null;
	if (stored.key !== null) {
		try { key = createPrivateKey(stored.key); } catch { throw new RunnerError("Invalid private key in the runner state."); }
		if (key.asymmetricKeyType !== "ed25519") throw new RunnerError("The runner state needs an Ed25519 key.");
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
export function lock(): () => void {
	mkdirSync(directory, { mode: 0o700, recursive: true });
	chmodSync(directory, 0o700);
	const fd = openSync(join(directory, "lock"), "a+", 0o600);
	const result = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
	if (result.status !== 0) {
		closeSync(fd);
		throw new RunnerError(result.error ? "The runner needs flock to lock its state." : "Another runner holds the state lock. Stop the service before pairing or pruning.");
	}
	ftruncateSync(fd);
	writeFileSync(fd, String(process.pid) + "\n");
	return () => closeSync(fd);
}

export function serviceRunning(): boolean {
	const path = join(directory, "lock");
	if (!existsSync(path)) return false;
	return spawnSync("flock", ["-n", "-s", path, "true"]).status === 1;
}
