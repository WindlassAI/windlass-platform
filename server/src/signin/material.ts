/**
 * What Windlass keeps of a ChatGPT sign-in, as the platform carries it between a store and a run of
 * `windlass login ...`: the text of the files in Windlass's data directory that belong to the sign-in
 * (Windlass's packages/core/src/auth/chatgpt.ts, `credentialsPath`, `pendingPath`, `hostIdPath`):
 *
 *   auth.json           the sign-in itself: the account, the access token and its expiry, the refresh
 *                       token (which the sign-in service replaces at every refresh), the ID token
 *   host-id             the identifier this "host" registered with; a refresh sends none, a sign-in does
 *   auth-pending.json   a sign-in that was started and not finished: the PKCE verifier, state and nonce
 *
 * Nothing else in that directory is part of it: `auth.lock` is an empty lock database Windlass makes
 * for a refresh, and `*.tmp` is a file on its way to being renamed. The platform reads `auth.json` for
 * three fields only (who signed in, and when the access token expires); every token in it is
 * Windlass's to read.
 *
 * Material is a secret from end to end. It is never logged and never part of an error message: the
 * functions here that fail say which file was wrong, never what was in it.
 */

import type { ChatgptAccount } from "../sandbox/api.js";

/** The files of a sign-in, by their names in Windlass's data directory. No other name is ever written or read back. */
export const MATERIAL_FILES = ["auth.json", "host-id", "auth-pending.json"] as const;
export type MaterialFile = (typeof MATERIAL_FILES)[number];

/** More than any of these files holds by far (an `auth.json` is a few kilobytes): what is larger is not one. */
export const MAX_MATERIAL_FILE_BYTES = 64 * 1024;

export interface SignInMaterial {
	files: Partial<Record<MaterialFile, string>>;
}

export const NO_MATERIAL: SignInMaterial = { files: {} };

/** The known files among `files`, each a string of a sane size: what may be sealed, stored and written back. */
export function cleanMaterial(files: unknown): SignInMaterial {
	const clean: SignInMaterial = { files: {} };
	if (typeof files !== "object" || files === null) return clean;
	for (const name of MATERIAL_FILES) {
		const text = (files as Record<string, unknown>)[name];
		if (typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_MATERIAL_FILE_BYTES) clean.files[name] = text;
	}
	return clean;
}

export function sameMaterial(a: SignInMaterial, b: SignInMaterial): boolean {
	return MATERIAL_FILES.every((name) => a.files[name] === b.files[name]);
}

/** Whether the material holds a finished sign-in. */
export function hasSignIn(material: SignInMaterial): boolean {
	return typeof material.files["auth.json"] === "string";
}

/** What a user keeps of a finished attempt: the sign-in and its host id. A pending sign-in is never kept. */
export function signInOnly(material: SignInMaterial): SignInMaterial {
	const { "auth.json": auth, "host-id": host } = material.files;
	return { files: { ...(auth === undefined ? {} : { "auth.json": auth }), ...(host === undefined ? {} : { "host-id": host }) } };
}

/**
 * Who the material's sign-in is for and when its access token expires: `account.sub`, `account.email`
 * and `expiresAt` of `auth.json`, and nothing else of it. Null when there is no sign-in in it, or its
 * `auth.json` names no account.
 */
export function accountOf(material: SignInMaterial): ChatgptAccount | null {
	const text = material.files["auth.json"];
	if (text === undefined) return null;
	let parsed: { account?: { sub?: unknown; email?: unknown }; expiresAt?: unknown };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		return null;
	}
	const sub = parsed?.account?.sub;
	if (typeof sub !== "string" || sub === "") return null;
	const email = parsed.account?.email;
	const expiresAt = parsed.expiresAt;
	return { sub, email: typeof email === "string" ? email : null, accessExpiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null };
}

/** User ids and attempt ids name things at the providers and in a sealed blob's binding: letters, digits, `_` and `-`, starting with a letter or digit, at most 64. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertName(value: string, what: string): void {
	if (typeof value !== "string" || !NAME.test(value)) throw new Error(`invalid ${what}: it must be 1 to 64 letters, digits, "_" or "-", starting with a letter or digit`);
}
