import { fingerprint, type Pin, type Trust } from "../../server/src/runner/frame-auth.js";
import { spawnSync } from "node:child_process";
import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_PROFILES, type MachineProfile } from "../../server/src/runner/protocol.js";
import { MACHINE_ID, validAllowedProfiles } from "../../server/src/runner/control.js";
import { list, object, is, text, json, nullable, optional, count } from "../../server/src/runner/check.js";
import { NAME } from "../../server/src/sandbox/provider.js";
import { egressFlags, listedHosts, open, platformHostNote, restricted, type Egress } from "./egress-policy.js";
import { egressMode } from "../../server/src/runner/control.js";
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
const record = object({ current: identity, previous: list(identity), platform: text(2048), key: nullable(text(512)), endpoint: optional(text(2048)), platformRoot: optional(text(80)), maxSerial: optional(count) });

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
export function forget(file: string) { rmSync(join(directory, file), { force: true }); }
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
	let pin: Pin | undefined;
	if (stored.platformRoot !== undefined || stored.endpoint !== undefined || stored.maxSerial !== undefined) {
		if (!stored.platformRoot || !stored.endpoint || stored.maxSerial === undefined) throw invalid();
		try { fingerprint(stored.platformRoot); if (origin(stored.endpoint) !== stored.endpoint) throw invalid(); } catch { throw invalid(); }
		pin = { endpoint: stored.endpoint, platformRoot: stored.platformRoot, maxSerial: stored.maxSerial };
	}
	return { current: stored.current, previous: stored.previous, platform: stored.platform, key, pin };
}
export function forgetKey() {
	const paired = loadPair();
	if (paired) save("pair.json", { current: paired.current, previous: paired.previous, platform: paired.platform, ...paired.pin, key: null });
}
// A separate file keeps pair.json readable by the previous runner on rollback. Its
// name scopes consent to this pairing, including when an owner pairs again in place.
const policyFile = (id: string) => `profiles-${id}.json`;
export function pairingProfiles(id: string, requested?: MachineProfile[]): MachineProfile[] {
	if (requested) {
		save(policyFile(id), requested);
		return requested;
	}
	const stored = read(policyFile(id));
	if (stored === undefined) return [...MACHINE_PROFILES]; // Only pre-policy pairings lack the file.
	if (!validAllowedProfiles(stored)) throw new RunnerError("Invalid profile policy in the runner state volume. Start the runner with --allow-profile docker-hardened to reset it.");
	return stored;
}
const egressFile = (id: string) => `egress-${id}.json`;
const validEgress = object({ mode: egressMode, allow: list(text(253), 64), domains: optional(list(text(255), 64)) });
/** Printed when egress flags without --egress-domains replace a saved list: the flags are saved whole. */
export const DOMAINS_REMOVED = "The --egress-domains list was removed: commands can reach any public host again. Give --egress-domains with the other --egress flags to keep a list.";
export function pairingEgress(id: string, requested?: Egress): Egress {
	if (requested) {
		const prior = read(egressFile(id));
		if (!requested.domains && validEgress(prior) && prior.domains) console.log(DOMAINS_REMOVED);
		save(egressFile(id), requested);
		return requested;
	}
	const stored = read(egressFile(id));
	if (stored === undefined) return open;
	if (!validEgress(stored)) throw new RunnerError("Invalid egress policy. Set --egress to reset it.");
	return egressFlags(stored.mode, stored.allow.length ? stored.allow.join(",") : undefined, stored.domains?.join(","))!;
}
export function egressNote(id: string) {
	if (read(egressFile(id)) === undefined) return "Network egress is open for this existing pairing. Start the runner with --egress restricted to opt in.";
	const { mode, allow, domains } = pairingEgress(id);
	const only = domains && listedHosts(domains).map(host => platformHostNote(host) ? `${host} (${platformHostNote(host)})` : host);
	return `Network egress is ${mode}.${only ? " Only these public hosts: " + only.join(", ") + "." : ""}${allow.length ? " Allowed hosts: " + allow.join(", ") : ""}`;
}
export function storePair(current: Identity, key: KeyObject, platform: string, profiles: MachineProfile[] = ["docker-hardened"], pin?: Pin) {
	const prior = loadPair();
	const previous = prior ? [...prior.previous, prior.current].filter(m => m.machineId !== current.machineId) : [];
	// Commit the policy before publishing the new key, including for standalone pairing.
	save(policyFile(current.machineId), profiles);
	save(egressFile(current.machineId), restricted);
	save("pair.json", { current, previous, platform, ...pin, key: key.export({ type: "pkcs8", format: "pem" }).toString() });
	return { current, previous, key, platform, pin };
}

/** Shared by control and all its sessions. Persist before exposing a newly verified socket. */
export function pairingTrust(pair: NonNullable<ReturnType<typeof loadPair>>): Trust {
	const pin = pair.pin;
	if (!pin || !pair.key) throw new RunnerError("Pair again to pin the platform identity.");
	return { pin, commit(maxSerial, endpoint) {
		if (maxSerial < pin.maxSerial) throw new RunnerError("Platform certificate serial decreased.");
		if (maxSerial === pin.maxSerial && endpoint === pin.endpoint) return;
		const current = read("pair.json");
		if (!record(current) || !current.key || current.current.machineId !== pair.current.machineId || current.platformRoot !== pin.platformRoot)
			throw new RunnerError("The pairing changed during the handshake.");
		if (current.maxSerial !== undefined && current.maxSerial > maxSerial) throw new RunnerError("Platform certificate serial decreased.");
		save("pair.json", { ...current, maxSerial, endpoint });
		Object.assign(pin, { maxSerial, endpoint });
	} };
}

// flock also works across Docker PID namespaces (two services can both be PID 1).
// Keep the fd open until exit. The kernel releases it even on SIGKILL; the PID is diagnostic.
let lockFd: number | undefined;
/** Setup lets go of the lock before it starts the runner service, which takes it. */
export function releaseLock() {
	if (lockFd !== undefined) closeSync(lockFd);
	lockFd = undefined;
}
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
	lockFd = fd;
	process.once("exit", releaseLock);
	ftruncateSync(fd);
	writeFileSync(fd, String(process.pid) + "\n");
	return true;
}

export function serviceRunning(): boolean {
	const path = join(directory, "lock");
	if (!existsSync(path)) return false;
	return spawnSync("flock", ["-n", "-s", path, "true"]).status === 1;
}
