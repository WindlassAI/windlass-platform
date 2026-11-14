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

export const loginVolume = (attemptId: string) => {
	assertName(attemptId, "sign-in attempt id");
	return `wlp-login-${attemptId}`;
};

/**
 * Creates the volume and has it mounted once at the data directory, so Docker copies the image
 * directory's owner (`agent`) and mode (0700) onto it before anything else mounts it.
 */
export async function ensureDataVolume(name: string, labels: Record<string, string>): Promise<void> {
	if (await volumeExists(name)) return;
	await createVolume(name, labels);
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${name}:${DATA_DIR}`], helper, ["true"], { timeoutMs: 60_000 });
	if (result.code !== 0) throw new Error(`could not initialise volume ${name}: ${result.stderr.trim()}`);
}

export async function ensureUserVolume(uid: string): Promise<void> {
	await ensureDataVolume(userVolume(uid), { [`${LABEL}.uid`]: uid });
}
