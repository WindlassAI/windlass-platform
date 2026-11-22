/**
 * Windlass's model relay for E2B sandboxes (docs/model-relay.md): `GET /model-relay/v1/models` and
 * `POST /model-relay/v1/responses` on WLP_MODEL_RELAY_URL, a hostname of the relay's own on which the
 * server answers nothing else (`modelRelayRoute`). The bearer is a turn's placeholder
 * (sandbox/relay-leases.ts); the request goes to `https://api.openai.com/v1/...` with the turn's current
 * token in its place, and the answer comes back with every token taken out of it. What the provider's
 * error says is cut down to its code, type and message (sandbox/relay/windlass.cjs `errorBody`).
 *
 * The relay's own refusals of a lease carry the code `relay_lease_ended`, so that the platform does not
 * take them for the provider turning the user's token down (sandbox/handoff.ts `relayRefused`).
 */

import { createRequire } from "node:module";
import { Readable, Transform, pipeline } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createClient } from "rivetkit/client";
import { isActorGone } from "./actors/internal.js";
import { serviceParams } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import { requestHost } from "./model-relay-url.js";
import type { Registry } from "./registry.js";
import type { AccessToken } from "./sandbox/api.js";
import {
	BodyBudget,
	RELAY_BASE_PATH,
	RelayLimiter,
	ROUTE_LIMITS,
	UserRate,
	endLease,
	endedLease,
	holdsLease,
	leaseToken,
	readPlaceholder,
	trackRequest,
} from "./sandbox/relay-leases.js";

const require = createRequire(import.meta.url);
const { scrubStream, limitHeaders } = require("../../sandbox/relay/server.cjs") as {
	scrubStream: (secrets: Iterable<string>, type: string, responses?: boolean) => NodeJS.ReadWriteStream;
	limitHeaders: (headers: Record<string, string>, secrets?: Iterable<string>) => Record<string, string>;
};
const { errorBody, LEASE_ENDED } = require("../../sandbox/relay/windlass.cjs") as { errorBody: (status: number, text: string, secrets?: string[]) => string; LEASE_ENDED: string };

export const MODEL_RELAY_PATHS = new Map([[`${RELAY_BASE_PATH}/models`, "GET"], [`${RELAY_BASE_PATH}/responses`, "POST"]]);
/** The request headers Windlass sends besides its authorization, and the only ones passed on. */
const PASSED = ["content-type", "accept", "session-id", "user-agent"];
const UPSTREAM = "https://api.openai.com/v1";
/** How long a token fetched from another server process's lease is used before it is asked again; also how often a request of such a lease looks whether it has ended. */
const REMOTE_CACHE_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 600_000;

function refusal(status: number, message: string, headers: Record<string, string> = {}, code: string | null = null): Response {
	const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 429 ? "rate_limit_error" : "api_error";
	return Response.json({ error: { type, code, message } }, { status, headers: { ...headers, "cache-control": "no-store" } });
}
/** The relay has no live lease for the placeholder: never the provider's refusal of the user's token. */
const leaseEnded = (message = "The session placeholder is no longer valid: its turn has ended.") => refusal(401, message, {}, LEASE_ENDED);

/** What the session's actor answers about a lease another server process holds. */
export interface RemoteLease {
	held: boolean;
	token: AccessToken | null;
}

export interface RelayRouteDeps {
	/** The lease another server process holds: its session's actor answers. Null when the actor is gone. */
	remote(uid: string, sessionId: string, nonce: string): Promise<RemoteLease | null>;
	fetch: typeof fetch;
	limiter: RelayLimiter;
	rate: UserRate;
	bodies: BodyBudget;
	now: () => number;
	/** The largest request body (ROUTE_LIMITS.bodyBytes). */
	bodyBytes?: number;
}

let client: ReturnType<typeof createClient<Registry>> | undefined;
const defaults: RelayRouteDeps = {
	remote: async (uid, sessionId, nonce) => {
		client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() });
		try {
			return await client.agentSession.get([uid, sessionId], { params: serviceParams() }).internalModelRelay({ nonce });
		} catch (error) {
			if (isActorGone(error)) return null;
			throw error;
		}
	},
	fetch: (input, init) => fetch(input, init),
	limiter: new RelayLimiter({ ...ROUTE_LIMITS, totalRequests: config.modelRelay.requests }),
	rate: new UserRate(),
	bodies: new BodyBudget(),
	now: () => Date.now(),
};

const cached = new Map<string, { token: AccessToken; until: number }>();

/** The lease's current token; null when it has none (ended, or not yet handed one). An ended lease is remembered as such until its placeholder expires. */
async function tokenFor(deps: RelayRouteDeps, uid: string, sessionId: string, nonce: string, placeholderExpires: number): Promise<AccessToken | null> {
	const now = deps.now();
	if (endedLease(nonce, now)) return null;
	// This process runs the turn: what it holds is the answer, and a lease it no longer holds has ended.
	if (holdsLease(nonce)) return leaseToken(nonce, uid, sessionId, now);
	const hit = cached.get(nonce);
	if (hit && hit.until > now && hit.token.expiresAt > now) return hit.token;
	const answer = await deps.remote(uid, sessionId, nonce);
	if (cached.size > 4096) cached.clear();
	if (answer === null || !answer.held) {
		// Ended: refused from now on without asking the actor again.
		cached.delete(nonce);
		endLease(nonce, placeholderExpires, now);
		return null;
	}
	if (answer.token === null) {
		cached.delete(nonce);
		return null;
	}
	cached.set(nonce, { token: answer.token, until: now + REMOTE_CACHE_MS });
	return answer.token.expiresAt > now ? answer.token : null;
}

/**
 * Requests of leases another server process holds: that process's `close` cannot reach them, so each such
 * lease is looked at every REMOTE_CACHE_MS while it has a request running, and its requests are aborted
 * once it has ended.
 */
const watched = new Map<string, { uid: string; sessionId: string; expires: number; deps: RelayRouteDeps; requests: Set<AbortController> }>();
let watching: NodeJS.Timeout | null = null;
function watchRemote(nonce: string, uid: string, sessionId: string, expires: number, deps: RelayRouteDeps, controller: AbortController): () => void {
	let entry = watched.get(nonce);
	if (!entry) watched.set(nonce, (entry = { uid, sessionId, expires, deps, requests: new Set() }));
	entry.requests.add(controller);
	watching ??= setInterval(() => {
		for (const [key, lease] of watched) {
			void tokenFor(lease.deps, lease.uid, lease.sessionId, key, lease.expires).then((token) => {
				if (token === null && endedLease(key)) for (const request of lease.requests) request.abort(new Error("the turn's model relay lease has ended"));
			}, () => undefined);
		}
	}, REMOTE_CACHE_MS);
	watching.unref?.();
	const mine = entry;
	return () => {
		mine.requests.delete(controller);
		if (mine.requests.size === 0 && watched.get(nonce) === mine) watched.delete(nonce);
		if (watched.size === 0 && watching) {
			clearInterval(watching);
			watching = null;
		}
	};
}

/**
 * The relay's answer to a request of the server's port, or null when it is not the relay's. On
 * WLP_MODEL_RELAY_URL's host only the relay's two paths are answered, and everything else is refused; on
 * any other host the relay's paths are not served. Without WLP_MODEL_RELAY_URL there is no relay route.
 */
export function modelRelayRoute(request: Request, pathname: string, relayHost: string | null, deps: RelayRouteDeps = defaults): Promise<Response> | Response | null {
	const onRelayHost = relayHost !== null && requestHost(request.headers.get("host") ?? new URL(request.url).host) === relayHost;
	if (onRelayHost) return MODEL_RELAY_PATHS.has(pathname) ? modelRelayResponse(request, deps) : refusal(404, "The model relay answers only its two routes.");
	if (MODEL_RELAY_PATHS.has(pathname)) return refusal(404, "The model relay is not served on this host.");
	return null;
}

/** A counter of the request body's bytes: past `max` in this request, or past the budget of all, it fails the body. */
function counted(max: number, budget: BodyBudget): { stream: Transform; over: () => "large" | "busy" | null; done: () => void } {
	let size = 0;
	let over: "large" | "busy" | null = null;
	let given = false;
	const done = () => {
		if (given) return;
		given = true;
		budget.give(size);
	};
	const stream = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			if (size + chunk.length > max) {
				over = "large";
				return callback(new Error("the request body is too large for the relay"));
			}
			if (!budget.take(chunk.length)) {
				over = "busy";
				return callback(new Error("the relay is sending too many request bodies at once"));
			}
			size += chunk.length;
			callback(null, chunk);
		},
		flush(callback) {
			done();
			callback();
		},
	});
	stream.on("close", done);
	return { stream, over: () => over, done };
}

export async function modelRelayResponse(request: Request, deps: RelayRouteDeps = defaults): Promise<Response> {
	if (!config.modelRelay.on) return refusal(404, "The model relay is off.");
	const url = new URL(request.url);
	const method = MODEL_RELAY_PATHS.get(url.pathname);
	if (method === undefined || url.search !== "" || request.method !== method) return refusal(403, "This request is not allowed by the relay.");
	const bearer = /^Bearer (\S{1,1024})$/.exec(request.headers.get("authorization") ?? "")?.[1];
	const placeholder = bearer === undefined ? null : readPlaceholder(bearer, deps.now());
	if (placeholder === null) return leaseEnded("The session placeholder is not valid.");
	// Before any lookup: a placeholder that keeps being sent costs at most this much.
	if (!deps.rate.take(placeholder.uid, deps.now())) return refusal(503, `Too many model requests from your sessions (${ROUTE_LIMITS.userPerMinute} a minute).`, { "retry-after": "2" });
	const lookup = () => tokenFor(deps, placeholder.uid, placeholder.sessionId, placeholder.nonce, placeholder.expiresAt);
	let token: AccessToken | null;
	try {
		token = await lookup();
	} catch {
		return refusal(503, "The relay could not reach the session. Try again.", { "retry-after": "1" });
	}
	if (token === null) return leaseEnded();
	const maxBody = deps.bodyBytes ?? ROUTE_LIMITS.bodyBytes;
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > maxBody) return refusal(413, "The request is too large for the relay.");
	const slot = await deps.limiter.acquire(placeholder.nonce, placeholder.uid, request.signal);
	if ("refused" in slot) return refusal(503, slot.refused, { "retry-after": "2" });
	// The lease's end (`close`, here or in the process that holds it) aborts the request from here on.
	const ended = new AbortController();
	const untrack = trackRequest(placeholder.nonce, ended) || watchRemote(placeholder.nonce, placeholder.uid, placeholder.sessionId, placeholder.expiresAt, deps, ended);
	let body: ReturnType<typeof counted> | null = null;
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			untrack();
			body?.done();
			slot.release();
		}
	};
	try {
		// Read again after the wait: a token replaced meanwhile is the one sent, and a turn that ended meanwhile sends nothing.
		let current: AccessToken | null;
		try {
			current = await lookup();
		} catch {
			release();
			return refusal(503, "The relay could not reach the session. Try again.", { "retry-after": "1" });
		}
		if (current === null || ended.signal.aborted) {
			release();
			return leaseEnded();
		}
		token = current;
		const secrets = [token.accessToken];
		const headers: Record<string, string> = { authorization: `Bearer ${token.accessToken}` };
		for (const name of PASSED) {
			const value = request.headers.get(name);
			if (value !== null) headers[name] = value;
		}
		const signal = AbortSignal.any([request.signal, ended.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
		// The body streams upstream as it arrives, counted: never whole in memory.
		let upstreamBody: ReadableStream | undefined;
		if (method === "POST" && request.body !== null) {
			body = counted(maxBody, deps.bodies);
			const source = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);
			pipeline(source, body.stream, () => undefined);
			upstreamBody = Readable.toWeb(body.stream) as unknown as ReadableStream;
		}
		let reply: Response;
		try {
			reply = await deps.fetch(UPSTREAM + url.pathname.slice(RELAY_BASE_PATH.length), {
				method, headers, body: upstreamBody, redirect: "manual", signal, ...(upstreamBody && { duplex: "half" }),
			} as RequestInit);
		} catch {
			const over = body?.over() ?? null;
			release();
			if (over === "large") return refusal(413, "The request is too large for the relay.");
			if (over === "busy") return refusal(503, "The relay is sending too many request bodies at once. Try again.", { "retry-after": "2" });
			if (ended.signal.aborted) return leaseEnded();
			return refusal(502, "The provider failed or couldn't be reached.");
		}
		const replyHeaders = Object.fromEntries(reply.headers.entries());
		if (reply.status !== 200) {
			const status = reply.status >= 400 && reply.status < 600 ? reply.status : 502;
			const text = status === 502 ? "" : await reply.text().then((t) => t.slice(0, 65_536), () => "");
			if (status === 502) await reply.body?.cancel().catch(() => undefined);
			release();
			return new Response(errorBody(status, text, secrets), {
				status,
				headers: { ...([429, 503, 529].includes(status) ? limitHeaders(replyHeaders, secrets) : {}), "content-type": "application/json", "cache-control": "no-store" },
			});
		}
		const type = reply.headers.get("content-type")?.split(";")[0];
		if ((type !== "text/event-stream" && type !== "application/json") || reply.body === null) {
			await reply.body?.cancel().catch(() => undefined);
			release();
			return refusal(502, "The provider failed or couldn't be reached.");
		}
		// fetch has decoded the body already. Every token is taken out before a byte goes back.
		const scrubbed = scrubStream(secrets, type, true);
		// One pipeline: the client going away stops the provider's stream too, and the slot is freed once either ends.
		pipeline(Readable.fromWeb(reply.body as WebReadableStream<Uint8Array>), scrubbed, () => release());
		(scrubbed as unknown as Readable).on("close", release);
		const stop = () => (scrubbed as unknown as Readable).destroy();
		request.signal.addEventListener("abort", stop, { once: true });
		ended.signal.addEventListener("abort", stop, { once: true });
		return new Response(Readable.toWeb(scrubbed as unknown as Readable) as unknown as ReadableStream, {
			status: 200,
			headers: { ...limitHeaders(replyHeaders, secrets), "content-type": type, "cache-control": "no-store" },
		});
	} catch (error) {
		release();
		throw error;
	}
}
