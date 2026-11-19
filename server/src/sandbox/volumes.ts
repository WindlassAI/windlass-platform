/**
 * The Docker volumes of a user:
 *
 *   wlp-user-<uid>   Windlass's data directory in the user's session containers: session logs, memory,
 *                    and the access token files of running turns. Never a sign-in.
 *
 * A sign-in is not in a volume any more: it is kept, sealed, in the user's `user` actor
 * (server/src/signin/). Two older layouts are still found on a machine that ran the platform before,
 * and are taken in the first time such a user is touched:
 *
 *   wlp-auth-<uid>   the single-machine layout: the sign-in (`auth.json`, `host-id`, and `auth.lock`
 *                    once it was refreshed) in a volume of its own. `dockerLegacySignIns` reads it for
 *                    the user's holder, which seals and saves it and then has the volume removed.
 *   wlp-user-<uid>   the layout before that: the sign-in beside Windlass's sessions in the user volume.
 *                    `migrateSignIn` moves it to wlp-auth-<uid>, from where it is taken in like any other.
 *
 * Both only exist on the one machine that has the volumes, so taking them in only happens when the
 * user's actor runs on that machine: on a server without Docker's volumes there is nothing to find.
 */

import type { LegacySignIns } from "../signin/holder.js";
import { MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, type SignInMaterial, assertName, cleanMaterial, hasSignIn } from "../signin/material.js";
import { DATA_DIR, LABEL, createVolume, helperFlags, removeVolume, runHelper, tmpName, volumeExists } from "./docker.js";
import { TOKEN_FILE_PREFIX } from "./token-file.js";

// User ids become Docker volume names, which is why they are held to a safe alphabet (signin/material.ts).
export { assertName };

export const userVolume = (uid: string) => {
	assertName(uid, "user id");
	return `wlp-user-${uid}`;
};

export const authVolume = (uid: string) => {
	assertName(uid, "user id");
	return `wlp-auth-${uid}`;
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

/** Makes sure the auth volume of the single-machine layout exists, for a sign-in found in the layout before it. Returns whether it was created now. */
export async function ensureAuthVolume(uid: string, image?: string): Promise<boolean> {
	return ensureDataVolume(authVolume(uid), { [`${LABEL}.uid`]: uid, [`${LABEL}.holds`]: "sign-in" }, image);
}

/**
 * The Docker provider's part of forgetting a sign-in (`SignInHolder.logout`): the token files of the
 * user's turns that still run are removed from the user's data volume, so Windlass has none at its next
 * model call. It works where the volume is, which is the one machine Docker sandboxes run on.
 */
export async function removeTokenFiles(uid: string, image?: string): Promise<void> {
	const sessions = userVolume(uid);
	if (!(await volumeExists(sessions))) return;
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${sessions}:${DATA_DIR}`], helper, ["sh", "-c", `rm -f -- ${DATA_DIR}/${TOKEN_FILE_PREFIX}*`], { timeoutMs: 60_000, image });
	if (result.code !== 0) throw new Error(`could not remove the access tokens handed to running turns: ${result.stderr.trim()}`);
}

// ---- the single-machine layout ----

/** Prints the sign-in's files in the volume mounted at /mnt/auth as `{"files": {name: text}}`. The output is a secret. */
const READ_SIGN_IN = `
import json, os, sys
files = {}
for name in ${JSON.stringify([...MATERIAL_FILES])}:
    path = os.path.join("/mnt/auth", name)
    if os.path.isfile(path) and not os.path.islink(path) and os.path.getsize(path) <= ${MAX_MATERIAL_FILE_BYTES}:
        with open(path) as f:
            files[name] = f.read()
json.dump({"files": files}, sys.stdout)
`;

/**
 * The sign-ins the single-machine layout left in `wlp-auth-<uid>` volumes, for the users' holders to
 * take in (signin/holder.ts). `take` first moves a sign-in of the layout before that into such a
 * volume, so both arrive the same way. What it reads is handed to the holder and to nothing else.
 */
export function dockerLegacySignIns(image?: string): LegacySignIns {
	return {
		where: (uid) => `the Docker volume ${authVolume(uid)}`,
		async take(uid): Promise<SignInMaterial | null> {
			await migrateSignIn(uid, image);
			const volume = authVolume(uid);
			if (!(await volumeExists(volume))) return null;
			const helper = tmpName();
			const result = await runHelper([...helperFlags(helper, "none"), "-v", `${volume}:/mnt/auth:ro`], helper, ["python3", "-I", "-c", READ_SIGN_IN], { timeoutMs: 60_000, image });
			if (result.code !== 0) throw new Error(`could not read the sign-in in volume ${volume}: ${result.stderr.trim()}`);
			const material = cleanMaterial((JSON.parse(result.stdout) as { files?: unknown }).files);
			// A volume without a sign-in (it was forgotten there) is still one to remove.
			return hasSignIn(material) ? material : { files: {} };
		},
		async remove(uid): Promise<void> {
			await removeVolume(authVolume(uid));
		},
	};
}

// ---- the layout before it ----

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
 * Moves a sign-in that the first layout left in the user's data volume to an auth volume, from where the
 * user's holder takes it in. Called the first time this process touches a user; costs one short helper
 * container when the user volume already existed, and a second one when there is something to move.
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
