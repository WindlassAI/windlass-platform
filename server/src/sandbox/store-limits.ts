// Limits and names shared by the snapshot store and the Git mirror store. This module imports
// nothing, so neither store has to import the other for them.

/** Snapshot budgets, and `free`: the free bytes disk-pressure eviction keeps and below which no store writes. */
export const snapshotLimits = { machine: 10_000_000_000, user: 2_000_000_000, free: 15_000_000_000 };

export const MIRROR_VOLUME = "wlp-git-mirrors-v1";
/** Where a session container mounts its one slot, read-only, at `<root>/<mirrorOwner>`. */
export const MIRROR_ROOT = "/var/cache/windlass-git";
/** The most one slot's mirror may hold. A save charges twice this against the floor: old and new copies coexist until the swap. */
export const MIRROR_BYTES = 512 * 1024 * 1024;
/** The whole config of a slot's `repo.git`: no remote, no alternates, nothing a clone would run. */
export const MIRROR_CONFIG = "[core]\n\tbare = true\n\trepositoryformatversion = 0";
