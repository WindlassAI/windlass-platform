import type { CredentialRef } from "../contract.js";
import { MINUTE_MS } from "../http-limits.js";
import { serverSealer } from "../signin/seal.js";

type Saved = Omit<CredentialRef, "generation">;

// Keys keep their original subject, so the relay's request nonce binds the same blob as before.
const transitSubject = (uid: string, ref: Saved, nonce: string) =>
	JSON.stringify(ref.plan ? ["model-plan", uid, ref.provider, nonce] : ["model-key", uid, ref.provider, nonce]);

/** Seals a saved secret for one relay request: it opens only for this user, credential and nonce, for a minute. */
export function sealCredentialTransit(uid: string, ref: Saved, nonce: string, secret: string, generation: string) {
	return serverSealer().seal(
		"transit",
		transitSubject(uid, ref, nonce),
		JSON.stringify({ key: secret, generation, exp: Date.now() + MINUTE_MS }),
	);
}

/** Opens what `sealCredentialTransit` sealed; throws for another user, credential or nonce, and once expired. */
export function openCredentialTransit(
	uid: string,
	ref: Saved,
	nonce: string,
	blob: string,
): { secret: string; generation: string } {
	const { key, generation, exp } = JSON.parse(serverSealer().open("transit", transitSubject(uid, ref, nonce), blob));
	if (!Number.isSafeInteger(exp) || exp <= Date.now()) throw new Error("Credential transit expired");
	return { secret: key, generation };
}
