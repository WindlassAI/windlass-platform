/**
 * The volumes of a user:
 *
 *   wlp-auth-<uid>   the ChatGPT sign-in (`auth.json`, `host-id`, and `auth.lock` once it was refreshed).
 *                    Mounted at Windlass's data directory in helper containers only: the sign-in steps
 *                    (logins.ts) and `windlass login token` (tokens.ts). Made when a sign-in is adopted.
 *   wlp-user-<uid>   Windlass's data directory in the user's session containers: session logs, memory,
 *                    and the access token files of running turns. Never a sign-in.
 *
 * Before sign-ins had a volume of their own they were in the user volume. `migrateSignIn` moves one
 * that is still there.
 */

import { DATA_DIR, LABEL, createVolume, helperFlags, runHelper, tmpName, volumeExists } from "./docker.js";

/** User ids and attempt ids become Docker volume names: letters, digits, `_` and `-`, starting with a letter or digit, at most 64. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertName(value: string, what: string): void {
	if (typeof value !== "string" || !NAME.test(value)) throw new Error(`invalid ${what}: it must be 1 to 64 letters, digits, "_" or "-", starting with a letter or digit`);
}

export const userVolume = (uid: string) => {
	assertName(uid, "user id");
	return `wlp-user-${uid}`;
};

export const authVolume = (uid: string) => {
	assertName(uid, "user id");
	return `wlp-auth-${uid}`;
};

export const loginVolume = (attemptId: string) => {
	assertName(attemptId, "sign-in attempt id");
	return `wlp-login-${attemptId}`;
};

/**
 * Creates the volume and has it mounted once at the data directory, so Docker copies the image
 * directory's owner (`agent`) and mode (0700) onto it before anything else mounts it. Returns whether
 * it was created now.
 */
export async function ensureDataVolume(name: string, labels: Record<string, string>, image?: string): Promise<boolean> {
	if (await volumeExists(name)) return false;
	await createVolume(name, labels);
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${name}:${DATA_DIR}`], helper, ["true"], { timeoutMs: 60_000, image });
	if (result.code !== 0) throw new Error(`could not initialise volume ${name}: ${result.stderr.trim()}`);
	return true;
}

/** Makes sure the user's data volume exists, and that no sign-in of the old layout is left in it. */
export async function ensureUserVolume(uid: string, image?: string): Promise<void> {
	const created = await ensureDataVolume(userVolume(uid), { [`${LABEL}.uid`]: uid }, image);
	// A volume made just now has nothing in it to move.
	if (created && !checked.has(uid)) checked.set(uid, Promise.resolve());
	else await migrateSignIn(uid, image);
}

/** Makes sure the user's auth volume exists. Returns whether it was created now. */
export async function ensureAuthVolume(uid: string, image?: string): Promise<boolean> {
	return ensureDataVolume(authVolume(uid), { [`${LABEL}.uid`]: uid, [`${LABEL}.holds`]: "sign-in" }, image);
}

/** The name of a turn's access token file in the user volume: one per sandbox (see windlass.ts). */
export const TOKEN_FILE_PREFIX = "access-token-";

// ---- the old layout ----

/**
 * Exit 0: nothing to move. 10: the sign-in was moved. 11: the auth volume already had a newer sign-in,
 * so the old one was only removed. `auth.lock` and `auth-pending.json` belong to the sign-in and go too.
 */
const MIGRATE = `
set -eu
src=/mnt/user
dst=${DATA_DIR}
[ -f "$src/auth.json" ] || exit 0
status=11
if [ ! -f "$dst/auth.json" ]; then
  for f in auth.json host-id; do
    [ -f "$src/$f" ] || continue
    cp "$src/$f" "$dst/.$f.moved"
    chmod 600 "$dst/.$f.moved"
    mv -f "$dst/.$f.moved" "$dst/$f"
  done
  status=10
fi
rm -f "$src/auth.json" "$src/host-id" "$src/auth.lock" "$src/auth-pending.json"
exit "$status"
`;

/** The users this process has looked at, each once (a failed look is tried again). */
const checked = new Map<string, Promise<void>>();

/**
 * Moves a sign-in that an earlier version of the platform left in the user's data volume to the user's
 * auth volume. Called the first time this process touches a user; costs one short helper container
 * when the user volume already existed, and a second one when there is something to move.
 */
export function migrateSignIn(uid: string, image?: string): Promise<void> {
	let pending = checked.get(uid);
	if (pending === undefined) {
		pending = moveOldSignIn(uid, image).catch((error: unknown) => {
			checked.delete(uid);
			throw error;
		});
		checked.set(uid, pending);
	}
	return pending;
}

async function moveOldSignIn(uid: string, image?: string): Promise<void> {
	const user = userVolume(uid);
	if (!(await volumeExists(user))) return;
	const looking = tmpName();
	const look = await runHelper([...helperFlags(looking, "none"), "-v", `${user}:/mnt/user:ro`], looking, ["sh", "-c", "if [ -f /mnt/user/auth.json ]; then echo old; else echo none; fi"], { timeoutMs: 60_000, image });
	if (look.code !== 0) throw new Error(`could not look into volume ${user}: ${look.stderr.trim()}`);
	if (look.stdout.trim() !== "old") return;
	const auth = authVolume(uid);
	await ensureAuthVolume(uid, image);
	const moving = tmpName();
	const moved = await runHelper([...helperFlags(moving, "none"), "-v", `${user}:/mnt/user`, "-v", `${auth}:${DATA_DIR}`], moving, ["sh", "-c", MIGRATE], { timeoutMs: 60_000, image });
	if (moved.code === 10) console.log(`[wlp] sign-in.moved uid=${uid}: the ChatGPT sign-in found in the data volume ${user} (the old layout) was moved to ${auth}; session containers no longer hold it`);
	else if (moved.code === 11) console.log(`[wlp] sign-in.moved uid=${uid}: an old ChatGPT sign-in found in the data volume ${user} was removed; ${auth} already holds a newer one`);
	else if (moved.code !== 0) throw new Error(`could not move the sign-in out of volume ${user}: ${moved.stderr.trim()}`);
}
