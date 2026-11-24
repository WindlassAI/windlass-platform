/**
 * The platform's own HTTP routes, and what the web app connects to the actors with.
 *
 * The web app is built with one address, the platform's (`VITE_WLP_API`). Where the Rivet engine is,
 * which namespace the actors live in and the token the engine asks a browser for come from the server
 * (`GET PLATFORM_CONNECTION_PATH`), so no token is built into the app. That token is short-lived: the
 * server issues it for an hour and hands it out with at least half of that left.
 *
 * What happens when it runs out, read from the engine (3.1.1) and RivetKit's client (3.1.1):
 * - The engine checks a token when a request arrives and when a WebSocket is opened, and not again on
 *   a socket that is open (pegboard-gateway `routes.rs`, `acquire.rs`; `websocket_tunnel.rs` has no
 *   check, and `Credential::expires_ts` in guard-core `auth.rs` is called nowhere). So a feed that is
 *   open stays open past its token's expiry, and only the next request or reconnect needs a new one.
 *   A token is accepted until thirty seconds after its `exp` (auth-jwt `PROTOCOL_CLOCK_SKEW`).
 * - RivetKit's client takes its token from a function, `createClient({ getToken })`
 *   (`client/token-provider.ts`), so the client is never made again. It asks before every request and
 *   every WebSocket open, keeps the answer until five seconds before the `exp` it reads in the JWT,
 *   by the browser's clock, and asks again with `forceRefresh` when the engine refused the token
 *   (`auth.invalid_token`, `auth.token_expired`: `engine-client/mod.ts`). A refused WebSocket open is
 *   tried once more with the new token (`client/actor-conn.ts`); a refused action is not sent again
 *   by RivetKit, so rivet.ts sends it once more itself.
 * - If that function throws while a feed reconnects, RivetKit gives the connection up for good
 *   (`client.connection_open_failed`, status "idle"), where a network that is down is otherwise
 *   retried. A laptop that wakes with an expired token and no network yet would lose its feeds. So
 *   `token` below does not throw for what waiting can mend: it keeps asking the server, more and more
 *   slowly, and the feed shows "reconnecting" meanwhile, as it does while the engine is unreachable.
 */
import { PLATFORM_CONNECTION_PATH, type PlatformConnection } from "@contract";
import { PlatformError } from "./client";
import { isRivetError, RESTARTING_MESSAGE, toPlatformError } from "./errors";

/** How long a request to the platform's HTTP routes may take. */
export const CONNECT_PATIENCE_MS = 12_000;

/** A token in hand is used until this long before it runs out, or a quarter of what it had when it came, if that is less. */
const RENEW_MARGIN_MS = 60_000;
/** The waits between attempts to reach a server that does not answer; the last one repeats. */
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

/** What a route answered, or that it could not be asked: thrown as a PlatformError, with whether asking again may help. */
class RouteFailure {
	constructor(
		readonly error: PlatformError,
		readonly transient: boolean,
	) {}
}

/** One `GET` of a platform route. Throws a RouteFailure. */
async function request(api: string, path: string, fetcher: typeof fetch): Promise<unknown> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), CONNECT_PATIENCE_MS);
	let response: Response;
	let body: unknown;
	try {
		response = await fetcher(`${api}${path}`, { signal: abort.signal, headers: { accept: "application/json" }, cache: "no-store" });
		body = await response.json().catch(() => null);
	} catch (error) {
		if (abort.signal.aborted) throw new RouteFailure(new PlatformError("network", `The server at ${api} did not answer.`, { cause: error }), true);
		throw new RouteFailure(toPlatformError(error, api), true);
	} finally {
		clearTimeout(timer);
	}
	if (response.ok) return body;
	// Refusals and failures have the shape of RivetKit's errors, and are read as those are.
	// 502, 503 and 504 without a body of RivetKit's are the proxy's while the server behind it restarts.
	let error: PlatformError;
	if (isRivetError(body)) error = toPlatformError(body, api);
	else if ([502, 503, 504].includes(response.status)) error = new PlatformError("restarting", RESTARTING_MESSAGE);
	else error = new PlatformError("internal", `The server at ${api} answered ${response.status}.`);
	// A server that is starting, restarting or cannot reach the engine may answer the next time; a refusal will not.
	throw new RouteFailure(error, response.status >= 500 || response.status === 429);
}

/** `GET` of a platform route, as the screens want it: the answer, or a PlatformError. */
export async function getPlatform<T>(api: string, path: string, fetcher: typeof fetch = fetch): Promise<T> {
	try {
		return (await request(api, path, fetcher)) as T;
	} catch (failure) {
		throw failure instanceof RouteFailure ? failure.error : failure;
	}
}

/** What the RivetKit client is made with. It does not change while the page is open; the token does. */
export interface Connection {
	/** The Rivet endpoint, or null when the server names none: the one the app was built with is used. */
	endpoint: string | null;
	namespace: string;
	/** Whether the engine asks for a token: `ConnectionSource.token` is then where RivetKit gets it. */
	tokens: boolean;
}

export interface ConnectionSourceOptions {
	/** The platform's address. */
	api: string;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

function readConnection(body: unknown): PlatformConnection | null {
	if (typeof body !== "object" || body === null) return null;
	const { endpoint, namespace, token } = body as { endpoint?: unknown; namespace?: unknown; token?: unknown };
	if ((endpoint !== null && typeof endpoint !== "string") || typeof namespace !== "string") return null;
	if (token === null) return { endpoint, namespace, token: null };
	if (typeof token !== "object") return null;
	const { token: value, expiresAt, validForMs } = token as { token?: unknown; expiresAt?: unknown; validForMs?: unknown };
	if (typeof value !== "string" || value === "" || typeof expiresAt !== "number" || typeof validForMs !== "number" || !Number.isFinite(validForMs)) return null;
	return { endpoint, namespace, token: { token: value, expiresAt, validForMs } };
}

export class ConnectionSource {
	private readonly api: string;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private first: Connection | null = null;
	private held: { token: string; goodUntil: number; margin: number } | null = null;
	private loading: Promise<PlatformConnection> | null = null;
	private problem: PlatformError | null = null;
	private closed = false;

	constructor(options: ConnectionSourceOptions) {
		this.api = options.api;
		// Called bare: a browser's `fetch` refuses any other `this`.
		this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
	}

	/**
	 * The server's first answer. While the server does not answer it is asked again and again (see
	 * `token`), so whoever waits sets its own limit; `failure` says what the last attempt met. A refusal
	 * is thrown at once, and the next call asks anew.
	 */
	async connection(): Promise<Connection> {
		while (this.first === null) await this.load();
		return this.first;
	}

	/**
	 * RivetKit's `getToken`: the token in hand while it is good for a while yet, and otherwise the
	 * server's next. `forceRefresh` says the engine refused the one in hand, so the server is asked
	 * whatever is left of it.
	 *
	 * How long a token is good for is counted from when it was asked for, with the duration the server
	 * gave (`validForMs`), and never by comparing an expiry with the browser's clock, which may be off
	 * by more than a token lasts. RivetKit does compare (the JWT's `exp`): with a clock that runs ahead
	 * it asks here before every request, and gets the token in hand without a request to the server;
	 * with one that runs behind it uses a token that ran out, the engine refuses it, and the token is
	 * renewed then.
	 *
	 * Any number of callers share one request. A server that cannot be reached, does not answer or says
	 * to try again (5xx) is asked again after a wait, for as long as the page is open; only a refusal
	 * throws (403 for an origin that is not allowed, an answer that is not a connection).
	 */
	readonly token = async (options: { forceRefresh: boolean }): Promise<string> => {
		const held = this.held;
		if (!options.forceRefresh && held && this.now() < held.goodUntil - held.margin) return held.token;
		const answer = await this.load();
		if (answer.token === null) throw new PlatformError("internal", `The server at ${this.api} handed out no connection token.`);
		return answer.token.token;
	};

	/** What the last attempt to reach the server met, while it is still being tried; null otherwise. */
	failure(): PlatformError | null {
		return this.problem;
	}

	/** Stops asking a server that does not answer. */
	close(): void {
		this.closed = true;
	}

	private load(): Promise<PlatformConnection> {
		if (!this.loading) {
			const mine = this.attempts().finally(() => {
				if (this.loading === mine) this.loading = null;
			});
			this.loading = mine;
		}
		return this.loading;
	}

	private async attempts(): Promise<PlatformConnection> {
		for (let attempt = 0; ; attempt++) {
			if (this.closed) throw new PlatformError("network", `The server at ${this.api} is not being asked any more.`);
			const sentAt = this.now();
			try {
				const answer = readConnection(await request(this.api, PLATFORM_CONNECTION_PATH, this.fetch));
				if (answer === null) throw new RouteFailure(new PlatformError("internal", `The server at ${this.api} did not say how to connect.`), false);
				this.problem = null;
				this.first ??= { endpoint: answer.endpoint, namespace: answer.namespace, tokens: answer.token !== null };
				if (answer.token) {
					const { token, validForMs } = answer.token;
					this.held = { token, goodUntil: sentAt + validForMs, margin: Math.min(RENEW_MARGIN_MS, validForMs / 4) };
				}
				return answer;
			} catch (failure) {
				if (!(failure instanceof RouteFailure)) throw failure;
				if (!failure.transient) {
					this.problem = null;
					throw failure.error;
				}
				this.problem = failure.error;
				await this.sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
			}
		}
	}
}
