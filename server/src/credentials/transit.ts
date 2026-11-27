import { randomBytes } from "node:crypto";
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

/**
 * The secret behind a saved credential while it is still at `generation`: `credential` asks the user's actor
 * (`internalCredential`) to seal it for a fresh nonce, and it is opened here. Null when it changed or is gone.
 * The relay route asks per request; a plan's relay inside a sandbox once per turn (`TurnSandbox.localPlanRelay`).
 */
export async function openSavedCredential(
	uid: string,
	ref: Pick<CredentialRef, "provider" | "plan" | "generation">,
	credential: (uid: string, ref: Saved, nonce: string) => Promise<string | null>,
): Promise<string | null> {
	const nonce = randomBytes(16).toString("hex");
	const saved = { provider: ref.provider, ...(ref.plan && { plan: true as const }) };
	const sealed = await credential(uid, saved, nonce);
	const opened = sealed && openCredentialTransit(uid, saved, nonce, sealed);
	return opened && opened.generation === ref.generation ? opened.secret : null;
}
