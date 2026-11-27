/**
 * Who is calling an actor, decided from the connection parameter `{ token }` and nothing else.
 *
 * RivetKit runs `onBeforeConnect` for WebSocket connections and for every stateless action call (the
 * handle's `params` arrive in a header and a short-lived connection is made for the call), so both
 * are rejected there. Every action then checks its caller again from `c.conn.params`: deny by default,
 * and a token that expires while a connection is open stops working.
 */

import { UserError } from "rivetkit";
import { isActorGone, isSessionGone } from "./actor-errors.js";
import { mayUse } from "./access.js";
import { config } from "./config.js";
import type { UserProfile } from "./contract.js";
import { SandboxUserError } from "./sandbox/api.js";
import { type Caller, issueServiceToken, verifyToken } from "./tokens.js";
import { errorText } from "./util.js";

interface HasRequest {
	request?: Request;
}

interface HasCaller {
	key: string[];
	conn?: { params: unknown } | null;
}

/** Browsers send their origin; only the web app's may connect. Other clients send none. */
export function assertOrigin(c: HasRequest): void {
	const origin = c.request?.headers.get("origin");
	if (!origin) return;
	if (!config.origins.includes(origin.replace(/\/+$/, ""))) {
		throw new UserError("This origin is not allowed to connect.", { code: "origin_not_allowed" });
	}
}

function tokenOf(params: unknown): unknown {
	return typeof params === "object" && params !== null ? (params as { token?: unknown }).token : undefined;
}

/** The verified caller of an actor whose key starts with a uid. Throws a UserError otherwise. */
export function authenticate(key: string[], params: unknown): Caller {
	const token = tokenOf(params);
	if (token === undefined || token === null || token === "") {
		throw new UserError("Sign in first.", { code: "unauthorized" });
	}
	const caller = verifyToken(token);
	if (!caller) throw new UserError("Your sign-in is not valid any more. Sign in again.", { code: "invalid_token" });
	if (caller.kind === "user" && caller.profile.uid !== key[0]) {
		throw new UserError("This belongs to another user.", { code: "forbidden" });
	}
	// Taken off the list, or the demo switched off, since the token was issued: said as an ended sign-in,
	// so the web app returns to the sign-in page, where the next attempt is told why.
	if (caller.kind === "user" && !mayUse(caller.profile, config.access)) {
		throw new UserError("Your sign-in is not valid any more. Sign in again.", { code: "invalid_token" });
	}
	return caller;
}

function callerOf(c: HasCaller): Caller {
	if (!c.conn) throw new UserError("Sign in first.", { code: "unauthorized" });
	return authenticate(c.key, c.conn.params);
}

export function checkGeneration(caller: Caller, generation: number): void {
	if (caller.kind === "user" && caller.generation !== generation) {
		throw new UserError("Your sign-in is not valid any more. Sign in again.", { code: "invalid_token" });
	}
}

/** Only [uid] owns the generation for uid. A longer key is a different database. */
export function userActorCaller(c: { key: string[]; vars: { tokenGen: number } }, params: unknown): Caller {
	if (c.key.length !== 1 || !c.key[0]) throw new UserError("Invalid user actor key.", { code: "forbidden" });
	const caller = authenticate(c.key, params);
	checkGeneration(caller, c.vars.tokenGen);
	return caller;
}

export function requireUser(c: HasCaller & { vars: { tokenGen: number } }): UserProfile {
	const caller = userActorCaller(c, c.conn?.params);
	if (caller.kind !== "user") throw new UserError("This action is for users.", { code: "forbidden" });
	return caller.profile;
}

export async function disconnectRevoked(
	conns: ReadonlyMap<string, { params: unknown; disconnect(reason: string): Promise<void> }>,
	generation: number,
): Promise<void> {
	const closing: Promise<void>[] = [];
	for (const conn of conns.values()) {
		const token = tokenOf(conn.params);
		if (typeof token !== "string") continue;
		const caller = verifyToken(token);
		if (!caller || (caller.kind === "user" && caller.generation < generation))
			closing.push(conn.disconnect("user.invalid_token"));
	}
	await Promise.all(closing);
}

/** For the actions actors call on each other: the caller holds a service token. */
export function requireService(c: HasCaller): void {
	const caller = callerOf(c);
	if (caller.kind !== "service") throw new UserError("This action is internal.", { code: "forbidden" });
}

/**
 * For an action that one caller alone may call: the service token was made for exactly this purpose
 * (`issueServiceToken(subject)`), so a token made for another call, or for another user's session, is refused.
 */
export function requireServiceFor(c: HasCaller, subject: string): void {
	const caller = callerOf(c);
	if (caller.kind !== "service" || caller.subject !== subject)
		throw new UserError("This action is internal.", { code: "forbidden" });
}

export function internalConnection(c: HasRequest & { key: string[] }, params: unknown) {
	assertOrigin(c);
	requireServiceFor({ key: c.key, conn: { params } }, "call");
}

/** For `canSubscribe`: true only for the actor's own user. */
export function maySubscribe(c: HasCaller & { vars: { tokenGen: number } }): boolean {
	try {
		requireUser(c);
		return true;
	} catch {
		return false;
	}
}

/** Connection parameters for a call from one actor to another. */
export function serviceParams(): { token: string } {
	return { token: issueServiceToken("call") };
}

export function isSandboxUserError(error: unknown): error is Error {
	return error instanceof SandboxUserError || (error instanceof Error && error.name === "SandboxUserError");
}

/**
 * What to throw to the client for a failure: a UserError passes through, a SandboxUserError becomes
 * one with its message, a missing actor is a lookup miss, and unexpected failures use `fallback`.
 */
export function clientError(
	log: { debug?: (entry: unknown) => void; error: (entry: unknown) => void },
	error: unknown,
	fallback: string,
	code = "internal_error",
): UserError {
	if (error instanceof UserError) return error;
	if (isSessionGone(error)) {
		const session = !isActorGone(error);
		log.debug?.({ msg: "A requested actor no longer exists." });
		return new UserError(session ? "This agent was deleted." : "The requested resource no longer exists.", {
			code: session ? "session_not_found" : "not_found",
		});
	}
	if (isSandboxUserError(error)) return new UserError(error.message, { code: "sandbox_error" });
	if (error instanceof Error && error.name === "RepositoryLimit")
		return new UserError(error.message, { code: "limit" });
	log.error({ msg: fallback, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
	return new UserError(fallback, { code });
}

/** A short, single-paragraph rendering of an error for a timeline message. */
export function describeError(error: unknown): string {
	const message = errorText(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 600) || "unknown error";
}
