import { randomBytes } from "node:crypto";
import { serviceParams } from "../auth.js";
import type { PlanProvider } from "../contract.js";
import type { HasClient } from "../actors/internal.js";
import { keyedDigest } from "../signatures.js";

// Crockford-style: no I, L, O or U, so a code read aloud or retyped survives.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 16; // 80 bits

/** `wl_` and 16 characters. The connect command sends it once, with the plan's token. */
function newConnectCode(): string {
	return "wl_" + [...randomBytes(LENGTH)].map(n => ALPHABET[n & 31]).join("");
}

export const connectCodeDigest = {
	/** The digest kept for a code, or null when it is not one. Case, spaces and dashes don't matter. */
	of(raw: unknown): string | null {
		if (typeof raw !== "string" || raw.length > 40) return null;
		const body = raw.trim().replace(/^wl_/i, "").toUpperCase().replace(/[ -]/g, "");
		if (body.length !== LENGTH || ![...body].every(ch => ALPHABET.includes(ch))) return null;
		return keyedDigest("connect-code", body).toString("hex");
	},
	/** Checks a digest passed between the route and an actor. */
	parse(digest: unknown): string {
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid connect code digest");
		return digest;
	},
};

/** What the token is sealed to between the connect route and its user's actor. */
export const connectTransitSubject = (uid: string, provider: PlanProvider, digest: string) =>
	JSON.stringify(["plan-connect", uid, provider, digest]);

/** A fresh code for this user, kept by its digest only. Null when the user holds too many live codes. */
export async function issueConnectCode(
	c: HasClient,
	uid: string,
	provider: PlanProvider,
): Promise<{ code: string; expiresAt: number } | null> {
	const code = newConnectCode();
	const expiresAt = await c
		.client()
		.connectCodes.getOrCreate(["codes"], { params: serviceParams() })
		.internalIssue(connectCodeDigest.of(code)!, uid, provider);
	return expiresAt === null ? null : { code, expiresAt };
}
