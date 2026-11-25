import { HOSTED_SIZES, type HostedSize, isHostedSize } from "../contract.js";

const warned = new Set<string>();

/** Select the operator's explicit setting, keeping the E2B deployment names in use. */
export function hostedName(env: NodeJS.ProcessEnv, suffix: string, e2bSuffix = suffix): string {
	const name = "WLP_HOSTED_" + suffix;
	const old = "WLP_E2B_" + e2bSuffix;
	if (env[name] === undefined) return env[old] === undefined ? name : old;
	const oldValue = suffix === "IDLE_ACTION" ? ({ "0": "destroy", "1": "pause" }[env[old]?.trim() ?? ""]) : env[old]?.trim();
	if (env[old] !== undefined && oldValue !== env[name]?.trim() && !warned.has(name)) {
		warned.add(name);
		console.warn(`[wlp] ${name} overrides ${old}`);
	}
	return name;
}

export function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, least: number, most = Number.MAX_SAFE_INTEGER): number {
	const raw = env[name]?.trim();
	const value = raw ? Number(raw) : fallback;
	if (!Number.isSafeInteger(value) || value < least || value > most) throw new Error(`${name} must be a whole number from ${least} to ${most}; got "${raw ?? fallback}"`);
	return value;
}

export const DEFAULT_SNAPSHOT_LIMITS = { maxTotal: 10, maxPerUser: 3, maxBytes: 4 * 2 ** 30, ttlMs: 14 * 86_400_000 };
export type SnapshotLimits = typeof DEFAULT_SNAPSHOT_LIMITS;

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = (env[name] ?? "").trim();
	if (raw === "") return fallback;
	if (raw === "1" || raw === "0") return raw === "1";
	throw new Error(`${name} must be 1 or 0; got "${raw}"`);
}

function enabledSizes(env: NodeJS.ProcessEnv): HostedSize[] {
	const name = hostedName(env, "SIZES");
	const named = (env[name] ?? "").split(",").map(part => part.trim()).filter(Boolean);
	const wrong = named.find(part => !isHostedSize(part));
	if (wrong !== undefined) throw new Error(`${name} must list sizes among ${HOSTED_SIZES.join(", ")}, separated by commas; got "${wrong}"`);
	return HOSTED_SIZES.filter(size => size === "small" || named.includes(size));
}

export function offeredSize(settings: { sizes: readonly HostedSize[] }, wanted: HostedSize = "small"): HostedSize {
	return [...settings.sizes].reverse().find(size => HOSTED_SIZES.indexOf(size) <= HOSTED_SIZES.indexOf(wanted)) ?? "small";
}

export function readHostedSettings(env: NodeJS.ProcessEnv) {
	const name = (suffix: string, old = suffix) => hostedName(env, suffix, old);
	const deployment = (env[name("DEPLOYMENT")] ?? "default").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deployment)) throw new Error(`${name("DEPLOYMENT")} must be 1 to 64 letters, digits, "_" or "-"; got "${deployment}"`);
	const idleName = name("IDLE_ACTION", "PAUSE");
	const idleAction = idleName === "WLP_E2B_PAUSE" ? (flag(env, idleName, true) ? "pause" : "destroy") : (env[idleName]?.trim() || "pause");
	if (idleAction !== "pause" && idleAction !== "destroy") throw new Error(`${idleName} must be pause or destroy for E2B`);
	const switchName = name("SNAPSHOTS");
	const snapshotSwitch = env[switchName]?.trim() || "off";
	if (snapshotSwitch !== "on" && snapshotSwitch !== "off") throw new Error(`${switchName} must be on or off`);
	const snapshots: SnapshotLimits | undefined = snapshotSwitch === "off" ? undefined : {
		maxTotal: wholeNumber(env, name("SNAPSHOT_MAX"), DEFAULT_SNAPSHOT_LIMITS.maxTotal, 1, 1000),
		maxPerUser: wholeNumber(env, name("SNAPSHOT_USER_MAX"), DEFAULT_SNAPSHOT_LIMITS.maxPerUser, 1, 100),
		maxBytes: wholeNumber(env, name("SNAPSHOT_MAX_GIB", "SNAPSHOT_MAX_GB"), DEFAULT_SNAPSHOT_LIMITS.maxBytes / 2 ** 30, 1, 64) * 2 ** 30,
		ttlMs: wholeNumber(env, "WLP_HOSTED_SNAPSHOT_TTL_MS", DEFAULT_SNAPSHOT_LIMITS.ttlMs, 1),
	};
	const turnLimit = Math.floor(Number(env.WLP_TURN_TIMEOUT_MS));
	return {
		deployment, sizes: enabledSizes(env), snapshots,
		maxRunning: wholeNumber(env, name("MAX_RUNNING"), 3, 1),
		idleTimeoutMs: wholeNumber(env, name("IDLE_TIMEOUT_MS"), 120_000, 30_000, 30 * 60_000),
		turnLeaseMs: wholeNumber(env, name("TURN_LEASE_MS"), 180_000, 60_000, 30 * 60_000),
		maxRuntimeMs: wholeNumber(env, name("MAX_CONTINUOUS_MS", "MAX_RUNTIME_MS"), 3_600_000, 10 * 60_000),
		turnLimitMs: Number.isFinite(turnLimit) && turnLimit >= 1000 ? turnLimit : 45 * 60_000,
		pause: idleAction === "pause",
		windlassSandbox: flag(env, name("INNER_SANDBOX", "WINDLASS_SANDBOX"), false),
		openProfile: flag(env, name("OPEN_PROFILE"), false),
		windlassVersion: env[name("WINDLASS_VERSION")]?.trim() || null,
	};
}
