/**
 * The two signed strings of connecting GitHub, both `gh1.<payload>.<signature>` in base64url, an
 * HMAC-SHA256 under the server's secret as the platform's own tokens are (tokens.ts). The prefix keeps
 * them apart from those: neither passes as the other.
 *
 *   state    goes to GitHub with the user and comes back to the server's callback route. It names the
 *            platform user it was made for, a number used once, and the web app's address to send the
 *            browser back to. Ten minutes
 *   ticket   what the callback route sends the browser back to the web app with, after GitHub has said
 *            who authorized and which installations they can reach. It carries that answer, for the
 *            one platform user the state named. Five minutes
 *
 * Why two. The callback route is reached by a browser coming from GitHub, which carries nothing that
 * says who is signed in to the platform: the web app keeps its token in the page, not in a cookie. So a
 * state proves which user a connection was started for, and nothing about whose browser finished it:
 * someone could start a connection for their own platform account and get another person to go through
 * GitHub with that state, which would attach that person's repositories to their account. The ticket
 * closes this. It is handed to the browser that came back from GitHub, and only the `user` actor of
 * the user it names takes it, from a caller signed in as that user (`user.githubComplete`): a browser
 * that is signed in as someone else, or not at all, can do nothing with it, and whoever started the
 * connection never sees it.
 *
 * Each is used once. The `user` actor keeps the numbers of the states it issued and takes each out when
 * the callback claims it, and remembers the numbers of the tickets it took until they have expired.
 */

import type { GithubId } from "../contract.js";
import { isGithubId } from "./ids.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export const STATE_TTL_MS = 10 * 60 * 1000;
export const TICKET_TTL_MS = 5 * 60 * 1000;

const PREFIX = "gh1";

export interface StatePayload {
	k: "state";
	uid: string;
	/** Used once: the `user` actor issued it and takes it out when it is claimed. */
	nonce: string;
	/** The web app's address the browser goes back to; one of the server's allowed origins. */
	origin: string;
	exp: number;
}

/** What GitHub confirmed about the user who authorized: who they are, and the installations they can reach. */
export interface ConfirmedConnection {
	user: { id: GithubId; login: string };
	installations: Array<{ id: GithubId; account: { id: GithubId; login: string; type: "User" | "Organization" }; htmlUrl: string }>;
}

export interface TicketPayload extends ConfirmedConnection {
	k: "ticket";
	uid: string;
	nonce: string;
	exp: number;
}

function sign(body: string): string {
	return createHmac("sha256", config.secret).update(body).digest("base64url");
}

function encode(payload: StatePayload | TicketPayload): string {
	const body = `${PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
	return `${body}.${sign(body)}`;
}

function decode(token: unknown, now: number): Record<string, unknown> | null {
	if (typeof token !== "string" || token.length > 8192) return null;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== PREFIX) return null;
	const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`), "utf8");
	const given = Buffer.from(parts[2] as string, "utf8");
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null) return null;
	const fields = payload as Record<string, unknown>;
	if (typeof fields.exp !== "number" || fields.exp <= now) return null;
	if (typeof fields.uid !== "string" || fields.uid === "" || typeof fields.nonce !== "string" || fields.nonce === "") return null;
	return fields;
}

export function newNonce(): string {
	return randomBytes(18).toString("base64url");
}

export function issueState(uid: string, nonce: string, origin: string, now = Date.now()): string {
	return encode({ k: "state", uid, nonce, origin, exp: now + STATE_TTL_MS });
}

/** The state's payload, or null when it is malformed, forged or expired. */
export function verifyState(token: unknown, now = Date.now()): StatePayload | null {
	const fields = decode(token, now);
	if (!fields || fields.k !== "state" || typeof fields.origin !== "string") return null;
	return fields as unknown as StatePayload;
}

export function issueTicket(uid: string, confirmed: ConfirmedConnection, now = Date.now()): string {
	return encode({ k: "ticket", uid, nonce: newNonce(), exp: now + TICKET_TTL_MS, user: confirmed.user, installations: confirmed.installations });
}

/** The ticket's payload, or null when it is malformed, forged or expired. Whose it is, the caller checks. */
export function verifyTicket(token: unknown, now = Date.now()): TicketPayload | null {
	const fields = decode(token, now);
	if (!fields || fields.k !== "ticket") return null;
	const user = fields.user as { id?: unknown; login?: unknown } | undefined;
	if (typeof user !== "object" || user === null || !isGithubId(user.id) || typeof user.login !== "string" || !Array.isArray(fields.installations)) return null;
	return fields as unknown as TicketPayload;
}

/** A PKCE verifier and the challenge GitHub is given for it (RFC 7636, S256). */
export function newCodeVerifier(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
