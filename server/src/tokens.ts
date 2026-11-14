/**
 * Tokens: an HMAC-SHA256 signature over a small JSON payload, `v1.<payload>.<signature>` in base64url.
 *
 * Two kinds share the secret and are told apart by a field inside the signed payload:
 *
 *   user     issued by the `login` actor, valid for 30 days: who the caller is
 *   service  issued by an actor for one call to another actor, valid for a minute: "this is the server"
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
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
	/** What the token is for: "call", or "create:<uid>/<sessionId>". */
	sub: string;
	exp: number;
}

type Payload = UserPayload | ServicePayload;

export type Caller = { kind: "user"; profile: UserProfile; expiresAt: number } | { kind: "service"; subject: string };

function sign(body: string): string {
	return createHmac("sha256", config.secret).update(body).digest("base64url");
}

function encode(payload: Payload): string {
	const body = `v1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
	return `${body}.${sign(body)}`;
}

export function issueUserToken(profile: UserProfile, now = Date.now()): AuthToken {
	return encode({ k: "u", uid: profile.uid, email: profile.email, demo: profile.demo, exp: now + USER_TOKEN_TTL_MS });
}

export function issueServiceToken(subject = "call", now = Date.now()): string {
	return encode({ k: "s", sub: subject, exp: now + SERVICE_TOKEN_TTL_MS });
}

/** The caller a token stands for, or null when it is malformed, forged or expired. */
export function verifyToken(token: unknown, now = Date.now()): Caller | null {
	if (typeof token !== "string" || token.length > 2048) return null;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") return null;
	const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`), "utf8");
	const given = Buffer.from(parts[2], "utf8");
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

	let payload: Payload;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Payload;
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null) return null;
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
