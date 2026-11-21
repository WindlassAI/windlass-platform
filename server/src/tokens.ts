/** Versioned actor tokens. User and service claims are signed with separate HKDF keys. */
import { readSignedPayload, signedPayload } from "./signatures.js";
import type { AuthToken, UserProfile } from "./contract.js";

export const USER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SERVICE_TOKEN_TTL_MS = 60 * 1000;

interface UserPayload {
	k: "u";
	uid: string;
	email: string | null;
	demo: boolean;
	exp: number;
}

interface ServicePayload {
	k: "s";
	/** What the token is for: "call", or "create:<actor kind>:<actor key>". */
	sub: string;
	exp: number;
}

type Payload = UserPayload | ServicePayload;

export type Caller = { kind: "user"; profile: UserProfile; expiresAt: number } | { kind: "service"; subject: string };

function encode(payload: Payload): string {
	return signedPayload("v2", payload.k === "u" ? "user-token" : "service-token", payload);
}

export function issueUserToken(profile: UserProfile, now = Date.now()): AuthToken {
	return encode({ k: "u", uid: profile.uid, email: profile.email, demo: profile.demo, exp: now + USER_TOKEN_TTL_MS });
}

export function issueServiceToken(subject = "call", now = Date.now()): string {
	return encode({ k: "s", sub: subject, exp: now + SERVICE_TOKEN_TTL_MS });
}

/** The caller a token stands for, or null when it is malformed, forged or expired. */
export function verifyToken(token: unknown, now = Date.now()): Caller | null {
	const payload = readSignedPayload(token, "v2", 2048, kind => kind === "u" ? "user-token" : kind === "s" ? "service-token" : null);
	if (!payload) return null;
	if (typeof payload.exp !== "number" || payload.exp <= now) return null;

	if (payload.k === "u") {
		if (typeof payload.uid !== "string" || payload.uid === "") return null;
		const email = typeof payload.email === "string" ? payload.email : null;
		return { kind: "user", profile: { uid: payload.uid, email, demo: payload.demo === true }, expiresAt: payload.exp };
	}
	if (payload.k === "s") {
		if (typeof payload.sub !== "string") return null;
		return { kind: "service", subject: payload.sub };
	}
	return null;
}
