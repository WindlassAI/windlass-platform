/**
 * The tokens browsers reach the actors with, on an engine that asks for one.
 *
 * A Rivet Cloud cluster is an engine of its own with one admin token, which may do everything in every
 * namespace and so never leaves the servers. What a browser holds instead is a scoped token: a JWT
 * the engine signs when it is asked with the admin token (`POST <engine>/auth/tokens`), good for one
 * namespace, for the operations it names and for a limited time, and of no use for getting another.
 * (The fixed `pk_...` tokens belong to Rivet Cloud's projects, another product; a cluster has none.)
 *
 * It is not a user's token. Whoever opens the web app gets one before signing in, because the sign-in
 * itself is an actor, and a client that sends no origin gets one too: it stands where a public token
 * would, and says only "this is a client of this deployment". Who the caller is, and what of a user's
 * they may touch, is decided by the platform's own token in every actor (auth.ts), as before.
 *
 * Nothing here knows the configuration: platform-info.ts makes the one instance a server has.
 */

import type { ConnectionToken } from "./contract.js";

/**
 * What the web app does, and no more. Each was tried against a cluster's engine (3.1.1) by taking it
 * away: without `list` or without `actor_gateway`'s `create` the sign-in fails, and without `read`
 * opening a session is refused with `auth.insufficient_permissions`.
 *
 *   actor          create, list, read   `getOrCreate` of a sign-in attempt and of the user's actor;
 *                                       finding a session's actor by its key
 *   actor_gateway  read, create         calling an actor's actions and holding a connection to it
 *
 * Not granted: updating, deleting or forking an actor, and everything about nodes and pools. A
 * session's actor is created and destroyed by the user's actor, on a server.
 */
export const CONNECTION_GRANTS = [
	{ resource: "actor", target: "any", operations: ["create", "list", "read"] },
	{ resource: "actor_gateway", target: "any", operations: ["read", "create"] },
] as const;

/** A token is handed out while it has at least this share of its life left. */
const FRESH_SHARE = 0.5;
/** When the engine cannot be asked, the token in hand is still handed out while it has this long left. */
const LAST_RESORT_MS = 30_000;
/** After a request that failed, how long until the engine is asked again. */
const RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The engine could not be asked, or refused. The message is fit for the server's log: it names the
 * engine's address and what it answered, and never holds the admin token or a token it issued.
 */
export class ConnectionTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionTokenError";
	}
}

export interface ConnectionTokensOptions {
	/** The engine's address, without a trailing slash. */
	endpoint: string;
	/** A secret: sent to the engine as a bearer, and nowhere else. */
	adminToken: string;
	namespace: string;
	/** How long a token is asked to last. The engine may issue a shorter one; what it says is what counts. */
	ttlMs: number;
	fetch?: typeof fetch;
	now?: () => number;
	/** Where failures are said; the default is the server's log. */
	log?: (line: string) => void;
}

interface Held {
	token: string;
	/** The engine's own expiry, by its clock. */
	expiresAt: number;
	/** By this server's clock: when the request for it was sent, plus how long the engine made it last. */
	goodUntil: number;
	lifetimeMs: number;
}

export class ConnectionTokens {
	private held: Held | null = null;
	private loading: Promise<Held> | null = null;
	private failed: { at: number; error: ConnectionTokenError } | null = null;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly log: (line: string) => void;

	constructor(private readonly options: ConnectionTokensOptions) {
		this.fetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((line) => console.error(line));
	}

	/**
	 * A token for a browser, with at least half of its life left: for the default hour, between thirty
	 * minutes and an hour. The engine is not asked once per visitor. A server keeps the token it was
	 * issued and hands the same one to everybody until half of its life is gone, and only then asks
	 * for the next, one request however many are waiting: with the default hour, twice an hour for
	 * each server that is being asked, and not at all while nobody visits. Half is the share because
	 * of what a browser does with it: it uses the token until it runs out and then asks again, so the
	 * answer has to be a token that lasts, and half a life is the least any answer has.
	 *
	 * Each server holds a token of its own. They need not be the same: every one is signed by the
	 * engine and good wherever the engine is, so a browser may be handed its first by one server and
	 * its next by another.
	 *
	 * How much is left is counted on this server's clock from when the token was asked for, with the
	 * lifetime the engine gave it (`expires_ts - issued_ts`, both by the engine's clock), so a server
	 * whose clock is off against the engine's still knows how old its token is.
	 *
	 * When the engine cannot be asked, or refuses, the token in hand is handed out for as long as it
	 * has thirty seconds left, and the engine is asked again five seconds later at the earliest; with
	 * no such token this throws a ConnectionTokenError, which is also logged.
	 */
	async current(): Promise<ConnectionToken> {
		const held = this.held;
		if (held && this.left(held) >= held.lifetimeMs * FRESH_SHARE) return this.answer(held);
		if (this.failed && this.now() - this.failed.at < RETRY_MS) return this.lastResort(held, this.failed.error);
		this.loading ??= this.issue()
			.then(
				(next) => {
					this.held = next;
					this.failed = null;
					return next;
				},
				(error: unknown) => {
					const failure = error instanceof ConnectionTokenError ? error : new ConnectionTokenError("the request for a connection token failed");
					this.failed = { at: this.now(), error: failure };
					this.log(`[wlp] connection.token_failed: ${failure.message}`);
					throw failure;
				},
			)
			.finally(() => {
				this.loading = null;
			});
		try {
			return this.answer(await this.loading);
		} catch (error) {
			return this.lastResort(held, error as ConnectionTokenError);
		}
	}

	private left(held: Held): number {
		return held.goodUntil - this.now();
	}

	private answer(held: Held): ConnectionToken {
		return { token: held.token, expiresAt: held.expiresAt, validForMs: Math.max(0, Math.floor(this.left(held))) };
	}

	private lastResort(held: Held | null, error: ConnectionTokenError): ConnectionToken {
		if (held && this.left(held) >= LAST_RESORT_MS) return this.answer(held);
		throw error;
	}

	/** One `POST /auth/tokens`. Everything it throws is a ConnectionTokenError. */
	private async issue(): Promise<Held> {
		const { endpoint, adminToken, namespace, ttlMs } = this.options;
		const sentAt = this.now();
		let response: Response;
		try {
			response = await this.fetch(`${endpoint}/auth/tokens`, {
				method: "POST",
				headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ namespace, duration: Math.max(1, Math.round(ttlMs / 1000)), grants: CONNECTION_GRANTS }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				// An answer to the admin token is never to be taken from anywhere else.
				redirect: "error",
			});
		} catch (error) {
			throw new ConnectionTokenError(`the Rivet engine at ${endpoint} could not be asked for a connection token (${this.scrub(reasonOf(error))})`);
		}
		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) throw new ConnectionTokenError(`the Rivet engine at ${endpoint} refused to issue a connection token: ${response.status}${this.scrub(refusalOf(body))}`);
		const issued = readIssued(body);
		if (!issued) throw new ConnectionTokenError(`the Rivet engine at ${endpoint} answered a request for a connection token with something else`);
		const lifetimeMs = issued.expiresAt - issued.issuedAt;
		if (lifetimeMs <= 0) throw new ConnectionTokenError(`the Rivet engine at ${endpoint} issued a connection token that had already expired`);
		return { token: issued.token, expiresAt: issued.expiresAt, goodUntil: sentAt + lifetimeMs, lifetimeMs };
	}

	/** Whatever the engine or the network said, without the admin token should it ever be repeated back. */
	private scrub(text: string): string {
		return text.split(this.options.adminToken).join("<admin token>");
	}
}

function readIssued(body: unknown): { token: string; issuedAt: number; expiresAt: number } | null {
	if (typeof body !== "object" || body === null) return null;
	const { token, issued_ts: issuedAt, expires_ts: expiresAt } = body as { token?: unknown; issued_ts?: unknown; expires_ts?: unknown };
	if (typeof token !== "string" || token === "" || typeof issuedAt !== "number" || typeof expiresAt !== "number") return null;
	if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
	return { token, issuedAt, expiresAt };
}

/** The engine's own words for a refusal (`group`, `code`, `message`), short; nothing else of the body. */
function refusalOf(body: unknown): string {
	if (typeof body !== "object" || body === null) return "";
	const { group, code, message } = body as { group?: unknown; code?: unknown; message?: unknown };
	const name = typeof group === "string" && typeof code === "string" ? ` ${group}.${code}` : "";
	const said = typeof message === "string" && message !== "" ? ` (${message.replace(/\s+/g, " ").slice(0, 200)})` : "";
	return `${name}${said}`;
}

function reasonOf(error: unknown): string {
	if (!(error instanceof Error)) return "unknown error";
	if (error.name === "TimeoutError" || error.name === "AbortError") return `no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`;
	// Node's fetch says "fetch failed" and keeps the reason (ECONNREFUSED, ENOTFOUND, ...) in `cause`.
	const cause = (error as { cause?: unknown }).cause;
	const code = typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : null;
	return code ?? (error.message.replace(/\s+/g, " ").slice(0, 200) || "unknown error");
}
