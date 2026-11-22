/** The user volume holds Windlass session data. Older servers also put token files there. */

import { assertName } from "../signin/material.js";
import { DATA_DIR, LABEL, createVolume, helperFlags, runHelper, tmpName, volumeExists } from "./docker.js";
import { removeRunningTokenFiles } from "./sandboxes.js";
import { TOKEN_FILE_PREFIX } from "./token-file.js";

// User ids become Docker volume names, which is why they are held to a safe alphabet (signin/material.ts).
export { assertName };

export const userVolume = (uid: string) => {
	assertName(uid, "user id");
	return `wlp-user-${uid}`;
};

/**
 * Creates the volume and has it mounted once at the data directory, so Docker copies the image
 * directory's owner (`agent`) and mode (0700) onto it before anything else mounts it.
 */
export async function ensureDataVolume(name: string, labels: Record<string, string>, image?: string): Promise<void> {
	if (await volumeExists(name)) return;
	await createVolume(name, labels);
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${name}:${DATA_DIR}`], helper, ["true"], { timeoutMs: 60_000, image });
	if (result.code !== 0) throw new Error(`could not initialise volume ${name}: ${result.stderr.trim()}`);
}

export function ensureUserVolume(uid: string, image?: string): Promise<void> {
	return ensureDataVolume(userVolume(uid), { [`${LABEL}.uid`]: uid }, image);
}

/**
 * The Docker provider's part of forgetting a sign-in (`SignInHolder.logout`): the token files of the
 * user's running turns are removed from each container, then any old files on the volume are removed.
 */
export async function removeTokenFiles(uid: string, image?: string): Promise<void> {
	await removeRunningTokenFiles(uid, "");
	// Also clean files left on disk by older servers.
	const sessions = userVolume(uid);
	if (!(await volumeExists(sessions))) return;
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${sessions}:${DATA_DIR}`], helper, ["sh", "-c", `rm -f -- ${DATA_DIR}/${TOKEN_FILE_PREFIX}*`], { timeoutMs: 60_000, image });
	if (result.code !== 0) throw new Error(`could not remove the access tokens handed to running turns: ${result.stderr.trim()}`);
}
