// Limits and names shared by the snapshot store and the Git mirror store. This module imports
// nothing, so neither store has to import the other for them.

/**
 * Snapshot budgets in bytes: `machine` for all snapshots on one Docker daemon, `user` for one user's,
 * and `free`: the free bytes disk-pressure eviction keeps and below which no store (snapshots or Git
 * mirrors) writes.
 */
export type StoreLimits = { machine: number; user: number; free: number };
/** What a deployment holds its machines to (WLP_SNAPSHOT_MACHINE_MAX_GB and the others): a ceiling on the sizes, a floor on `free`. Absent: not capped. */
export type StoreCaps = Partial<StoreLimits>;

/** The defaults: the platform's own Docker without its settings, and a runner without its flags. */
export const DEFAULT_STORE_LIMITS: Readonly<StoreLimits> = Object.freeze({ machine: 10_000_000_000, user: 2_000_000_000, free: 40_000_000_000 });
/** What runner 0.3.1 and older apply on their own: they take no flags and report nothing of it. */
export const BUILT_IN_STORE_LIMITS: Readonly<StoreLimits> = Object.freeze({ machine: 10_000_000_000, user: 2_000_000_000, free: 15_000_000_000 });

/** The limits a store uses where it is given none. The checks change it in place. */
export const snapshotLimits: StoreLimits = { ...DEFAULT_STORE_LIMITS };

const UNITS: Record<string, number> = { mb: 1e6, gb: 1e9, tb: 1e12 };
/** The most any limit may be: 1 PB, far beyond any disk, and well inside a safe integer. */
export const MAX_STORE_BYTES = 1e15;

/** A size such as `20GB`, `512MB` or `1.5TB` (decimal units, any case) in bytes; null for anything else. */
export function parseStoreSize(text: string): number | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(mb|gb|tb)\s*$/i.exec(text);
	if (!match) return null;
	const bytes = Math.round(Number(match[1]) * (UNITS[(match[2] ?? "").toLowerCase()] ?? NaN));
	return Number.isSafeInteger(bytes) && bytes <= MAX_STORE_BYTES ? bytes : null;
}

/**
 * The limits a machine applies: its owner's (`requested`), held to the deployment's caps. A machine can
 * choose less space or more free disk than the deployment allows, never more space or less free disk.
 */
export function clampStoreLimits(requested: StoreLimits, caps: StoreCaps = {}): StoreLimits {
	return {
		machine: caps.machine === undefined ? requested.machine : Math.min(requested.machine, caps.machine),
		user: caps.user === undefined ? requested.user : Math.min(requested.user, caps.user),
		free: caps.free === undefined ? requested.free : Math.max(requested.free, caps.free),
	};
}

/**
 * v2: slots keyed as `mirrorSlot` keys them, written only by the save helper. v1 slots came from
 * the earlier design and were never rehashed, so nothing reads that volume.
 */
export const MIRROR_VOLUME = "wlp-git-mirrors-v2";
/** Where a session container mounts its one slot, read-only, at `<root>/<mirrorOwner>`. */
export const MIRROR_ROOT = "/var/cache/windlass-git";
/** The most one slot's mirror may hold. A save charges twice this against the floor: old and new copies coexist until the swap. */
export const MIRROR_BYTES = 512 * 1024 * 1024;
/** The whole config of a slot's `repo.git`: no remote, no alternates, nothing a clone would run. */
export const MIRROR_CONFIG = "[core]\n\tbare = true\n\trepositoryformatversion = 0";

/** The deployment's settings of the stores, in GB (decimal): WLP_SNAPSHOT_MACHINE_MAX_GB, WLP_SNAPSHOT_USER_MAX_GB, WLP_KEEP_FREE_MIN_GB. */
export const STORE_SETTINGS = { machine: "WLP_SNAPSHOT_MACHINE_MAX_GB", user: "WLP_SNAPSHOT_USER_MAX_GB", free: "WLP_KEEP_FREE_MIN_GB" } as const;

/**
 * The stores' limits on the platform's own Docker (`own`: each setting, or its default), and the caps the
 * deployment holds its machines to (`caps`: only the settings that are set). A setting that is not a number
 * of GB (above 0 for the two sizes, 0 or more for keep-free, at most 1,000,000) goes into `problems` and
 * counts as not set.
 */
export function storeSettings(env: Record<string, string | undefined>): { own: StoreLimits; caps: StoreCaps; problems: string[] } {
	const own: StoreLimits = { ...DEFAULT_STORE_LIMITS }, caps: StoreCaps = {}, problems: string[] = [];
	for (const key of ["machine", "user", "free"] as const) {
		const name = STORE_SETTINGS[key], text = (env[name] ?? "").trim();
		if (text === "") continue;
		const gb = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
		const bytes = Math.round(gb * 1e9);
		if (!Number.isSafeInteger(bytes) || bytes > MAX_STORE_BYTES || (key !== "free" && bytes <= 0)) {
			problems.push(`${name} must be a number of GB ${key === "free" ? "of 0 or more" : "above 0"}, at most 1000000, or not set for ${DEFAULT_STORE_LIMITS[key] / 1e9}`);
			continue;
		}
		own[key] = caps[key] = bytes;
	}
	return { own, caps, problems };
}
