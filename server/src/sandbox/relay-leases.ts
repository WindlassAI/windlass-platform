/**
 * Windlass's model relay on E2B (docs/model-relay.md): the turns' leases of this server process, and the
 * limits on what goes through the relay route (model-relay-route.ts).
 *
 * A lease is opened when a turn's token file is first written (`TokenFile.start`) and closed when the
 * turn ends. Its placeholder is a payload signed by this deployment (signatures.ts, purpose `model-relay`)
 * that names the user, the session and the lease's nonce. Any server process can check the signature,
 * but only the process whose session actor runs the turn holds the lease: another one asks that actor
 * (`internalModelRelay`). The lease holds the turn's current token, which `hand` replaces. A closed lease
 * is gone, whatever its placeholder's signature says: `close` stops the lease's requests still running,
 * and its nonce is remembered as ended until its placeholder expires (`endedLease`), so a placeholder of
 * a turn that is over costs no lookup.
 *
 * Every limit here is of one server process: a deployment of several has each of them once per process.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { forwardProof } from "../../../sandbox/relay/wires.cjs";
import { modelBasePath } from "../model-relay-url.js";
import type { AccessToken } from "./api.js";
import { config } from "../config.js";
import { serverSealer } from "../signin/seal.js";
import type { ForwardedKeyLease, KeyTurnRelay, ModelKeyLease, TurnModelRelay } from "./provider.js";
import { keyedDigest, readSignedPayload, signedPayload } from "../signatures.js";

/** All model routes live under this prefix on the dedicated relay host. */
export const RELAY_PREFIX = "/model-relay";
const PREFIX = "wlpm1";

export type RelayToken = (AccessToken & { kind: "access" }) | (ModelKeyLease & { kind: "key" });

interface Lease {
	uid: string;
	sessionId: string;
	token: RelayToken | null;
	/** When its placeholder's signature stops counting. */
	expiresAt: number;
	/** Its requests running in this process: `close` aborts them. */
	requests: Set<AbortController>;
}

/** The leases of the turns this process runs, by nonce. */
const leases = new Map<string, Lease>();

/** Nonces of leases known to have ended, with when their placeholder expires: until then they are refused without a lookup. */
const ended = new Map<string, number>();
const ENDED_KEPT = 65_536;

/** Remembers that the lease of `nonce` has ended, until `until` (its placeholder's expiry). */
export function endLease(nonce: string, until: number, now = Date.now()): void {
	if (until <= now) return;
	if (ended.size >= ENDED_KEPT) {
		for (const [key, at] of ended) if (at <= now) ended.delete(key);
		// Still full: the oldest go first. A placeholder forgotten here is looked up again, never let through.
		for (const key of ended.keys()) {
			if (ended.size < ENDED_KEPT) break;
			ended.delete(key);
		}
	}
	ended.set(nonce, until);
}

/** Whether the lease of `nonce` is known to have ended. */
export function endedLease(nonce: string, now = Date.now()): boolean {
	const until = ended.get(nonce);
	if (until === undefined) return false;
	if (until > now) return true;
	ended.delete(nonce);
	return false;
}

/** What a placeholder names, once its signature and expiry are checked. */
export interface Placeholder {
	machine?: string;
	uid: string;
	sessionId: string;
	nonce: string;
	/** When the signature stops counting, ms since the epoch. */
	expiresAt: number;
}

/** A placeholder's payload, or null for anything this deployment did not sign, or signed for something else, or that expired. */
export function readPlaceholder(bearer: string, now = Date.now()): Placeholder | null {
	const payload = readSignedPayload(bearer, PREFIX, 1024, (kind) => (kind === "m" || kind === "f" ? "model-relay" : null));
	if (payload === null) return null;
	const { u, s, n, exp, machine } = payload;
	if (typeof u !== "string" || typeof s !== "string" || typeof n !== "string" || !/^[a-f0-9]{32}$/.test(n) || typeof exp !== "number" || exp <= now) return null;
	const placeholder = { uid: u, sessionId: s, nonce: n, expiresAt: exp };
	if (payload.k === "m") return machine === undefined ? placeholder : null;
	return typeof machine === "string" && machine ? { ...placeholder, machine } : null;
}

export function leaseToken(nonce: string, uid: string, sessionId: string, now = Date.now()): RelayToken | null {
	const lease = leases.get(nonce);
	if (!lease || lease.uid !== uid || lease.sessionId !== sessionId || lease.expiresAt <= now) return null;
	const token = lease.token;
	return token && (token.kind === "key" || token.expiresAt > now) ? token : null;
}

export interface RemoteLease {
	held: boolean;
	token: string | ModelKeyLease | null;
}

export const relayTransitSubject = (uid: string, session: string, lease: string, request: string) =>
	JSON.stringify(["model-relay", uid, session, lease, request]);

export function remoteLease(nonce: string, uid: string, sessionId: string, request: string): RemoteLease {
	if (!/^[a-f0-9]{32}$/.test(request)) throw new Error("Invalid relay request nonce");
	const lease = leases.get(nonce);
	if (!lease || lease.uid !== uid || lease.sessionId !== sessionId) return { held: false, token: null };
	const token = leaseToken(nonce, uid, sessionId);
	return { held: true, token: token?.kind === "access"
		? serverSealer().seal("transit", relayTransitSubject(uid, sessionId, nonce, request), JSON.stringify({ ...token, exp: Date.now() + 60_000 }))
		: token };
}

/** Whether this process has the lease at all (live or not yet handed a token). */
export function holdsLease(nonce: string): boolean {
	return leases.has(nonce);
}

/**
 * Counts a request of a lease this process holds, so that the lease's end aborts it; returns what to call
 * when it is over. False when this process does not hold the lease (the route then watches it itself).
 */
export function trackRequest(nonce: string, controller: AbortController): (() => void) | false {
	const lease = leases.get(nonce);
	if (!lease) return false;
	lease.requests.add(controller);
	return () => lease.requests.delete(controller);
}

/**
 * A turn's lease. `origin`: WLP_PUBLIC_URL, the address the sandbox reaches the route at. `ttlMs`: how long
 * the placeholder's signature counts, at most; the lease itself ends with the turn, before that.
 */
type LeaseInput = { uid: string; sessionId: string; origin: string; ttlMs: number };

function closeLease(nonce: string, lease: Lease) {
	leases.delete(nonce);
	lease.token = null;
	endLease(nonce, lease.expiresAt);
	for (const controller of lease.requests) controller.abort(new Error("the turn's model relay lease has ended"));
}

export function openRelayLease(input: LeaseInput & { key?: undefined }): TurnModelRelay;
export function openRelayLease(input: LeaseInput & { key: ModelKeyLease; machine?: string }): KeyTurnRelay;
export function openRelayLease(input: LeaseInput & { key?: ModelKeyLease; machine?: string }): TurnModelRelay | KeyTurnRelay {
	const now = Date.now();
	for (const [nonce, lease] of leases) if (lease.expiresAt <= now) closeLease(nonce, lease);
	const nonce = randomBytes(16).toString("hex");
	const expiresAt = now + input.ttlMs;
	const lease: Lease = { uid: input.uid, sessionId: input.sessionId, token: input.key ? { ...input.key, kind: "key" } : null, expiresAt, requests: new Set() };
	leases.set(nonce, lease);
	const relay = {
		// An older platform process cannot accept a machine lease without verifying its proof.
		placeholder: signedPayload(PREFIX, "model-relay", { k: input.machine ? "f" : "m", u: input.uid, s: input.sessionId, n: nonce, exp: expiresAt, machine: input.machine }),
		env: { WINDLASS_MODEL_BASE_URL: input.origin + RELAY_PREFIX + modelBasePath(input.key?.provider), WINDLASS_MODEL_ALLOWED_ORIGIN: input.origin },
		close: async () => closeLease(nonce, lease),
	};
	if (input.key) return relay;
	return { ...relay, hand: async (token: AccessToken) => {
		if (!leases.has(nonce)) throw new Error("This relay lease has ended.");
		lease.token = { kind: "access", accessToken: token.accessToken, expiresAt: token.expiresAt };
	} };
}

// Only used with a placeholder we just signed or verified. Its signing-key id survives key rotation.
function proofKey(placeholder: string): string {
	return keyedDigest("model-relay", "forward-proof/" + placeholder, placeholder.split(".")[1]!).toString("base64url");
}

export function verifiedMachine(placeholder: string, machine: string, proof: string | undefined, method: string, path: string, now: number): string | undefined {
	if (!proof || !/^[1-9]\d{12}\.[A-Za-z0-9_-]{43}$/.test(proof)) return;
	const time = Number(proof.split(".")[0]);
	if (Math.abs(now - time) > 60_000) return;
	const expected = forwardProof(proofKey(placeholder), machine, method, path, time);
	if (timingSafeEqual(Buffer.from(expected), Buffer.from(proof))) return machine;
}

/** Keep the Settings key on the platform. The Docker relay forwards with a second, turn-scoped placeholder. */
export async function forwardKeyLease(uid: string, sessionId: string, key: ModelKeyLease, machine: string | undefined,
	open: (forward: ForwardedKeyLease) => Promise<KeyTurnRelay>): Promise<KeyTurnRelay> {
	const url = config.modelRelay.url;
	if (!config.modelRelay.on || !url || !sessionId) throw new Error("A saved provider key requires a platform model relay.");
	const ttlMs = config.turnTimeoutMs + 60_000;
	const expiresAt = Date.now() + ttlMs;
	const platform = openRelayLease({ uid, sessionId, key, machine, origin: url.origin, ttlMs });
	try {
		const local = await open({ provider: key.provider, host: url.host, placeholder: platform.placeholder, expiresAt,
			...(machine && { proofKey: proofKey(platform.placeholder) }) });
		return { env: local.env, placeholder: local.placeholder, close: async () => { await platform.close(); await local.close(); } };
	} catch (error) {
		await platform.close();
		throw error;
	}
}

/** The limits of the relay route in one server process (docs/model-relay.md, "Limits"). */
export interface RelayLimits {
	/** In flight per lease (turn), and waiting per lease: the machine relay's 8 and 32. */
	sessionRequests: number;
	sessionWaiting: number;
	/** In flight per user. */
	userRequests: number;
	/** In flight in all, and waiting in all. */
	totalRequests: number;
	totalWaiting: number;
	/** How long a request waits for a slot before it is refused. */
	waitMs: number;
	/** Requests a user may start per minute, after a burst of `userBurst`: counted before any lookup. */
	userPerMinute: number;
	userBurst: number;
	/** The largest request body, and the request bodies being sent upstream at once in all. */
	bodyBytes: number;
	totalBodyBytes: number;
}

export const ROUTE_LIMITS: RelayLimits = {
	sessionRequests: 8, sessionWaiting: 32, userRequests: 16, totalRequests: 64, totalWaiting: 256, waitMs: 90_000,
	userPerMinute: 300, userBurst: 100, bodyBytes: 32 * 1024 * 1024, totalBodyBytes: 256 * 1024 * 1024,
};

/** A user's requests per minute, as a bucket that refills: what a placeholder that keeps being sent costs is bounded before it is looked up. */
export class UserRate {
	private readonly buckets = new Map<string, { tokens: number; at: number }>();

	constructor(private readonly limits: Pick<RelayLimits, "userPerMinute" | "userBurst"> = ROUTE_LIMITS) {}

	/** Takes one request of `uid`'s; false when it has none left now. */
	take(uid: string, now = Date.now()): boolean {
		const rate = this.limits.userPerMinute / 60_000;
		const bucket = this.buckets.get(uid) ?? { tokens: this.limits.userBurst, at: now };
		bucket.tokens = Math.min(this.limits.userBurst, bucket.tokens + (now - bucket.at) * rate);
		bucket.at = now;
		if (this.buckets.size > 65_536 && !this.buckets.has(uid)) {
			// Full buckets say nothing: they go first.
			for (const [key, b] of this.buckets) if (Math.min(this.limits.userBurst, b.tokens + (now - b.at) * rate) >= this.limits.userBurst) this.buckets.delete(key);
		}
		this.buckets.delete(uid);
		this.buckets.set(uid, bucket);
		if (bucket.tokens < 1) return false;
		bucket.tokens -= 1;
		return true;
	}
}

/** The request bodies being sent upstream at once, in bytes. */
export class BodyBudget {
	private used = 0;

	constructor(private readonly total: number = ROUTE_LIMITS.totalBodyBytes) {}

	/** Takes `n` bytes; false, and nothing taken, when that would pass the total. */
	take(n: number): boolean {
		if (this.used + n > this.total) return false;
		this.used += n;
		return true;
	}

	give(n: number): void {
		this.used = Math.max(0, this.used - n);
	}

	get inFlight(): number {
		return this.used;
	}
}

interface Waiter {
	lease: string;
	uid: string;
	grant: () => void;
}

/**
 * Slots for requests in flight, as `createRelay` of sandbox/relay/server.cjs gives them: one FIFO for the
 * whole route, in which a waiter whose turn or user is at its ceiling does not hold up the others.
 */
export class RelayLimiter {
	private readonly leaseInFlight = new Map<string, number>();
	private readonly leaseWaiting = new Map<string, number>();
	private readonly userInFlight = new Map<string, number>();
	private total = 0;
	private readonly waiting: Waiter[] = [];

	constructor(private readonly limits: Pick<RelayLimits, "sessionRequests" | "sessionWaiting" | "userRequests" | "totalRequests" | "totalWaiting" | "waitMs"> = ROUTE_LIMITS) {}

	private add(map: Map<string, number>, key: string, n: number): void {
		const value = (map.get(key) ?? 0) + n;
		if (value) map.set(key, value);
		else map.delete(key);
	}

	private room(lease: string, uid: string): boolean {
		return (this.leaseInFlight.get(lease) ?? 0) < this.limits.sessionRequests && (this.userInFlight.get(uid) ?? 0) < this.limits.userRequests && this.total < this.limits.totalRequests;
	}

	private full(lease: string, uid: string): string {
		if ((this.leaseInFlight.get(lease) ?? 0) >= this.limits.sessionRequests) return `Too many model requests at once from this session (${this.limits.sessionRequests}).`;
		if ((this.userInFlight.get(uid) ?? 0) >= this.limits.userRequests) return `Too many model requests at once from your sessions (${this.limits.userRequests}).`;
		return `Too many model requests at once on this server (${this.limits.totalRequests}).`;
	}

	private drain(): void {
		for (let i = 0; i < this.waiting.length && this.total < this.limits.totalRequests; ) {
			const entry = this.waiting[i];
			if (this.room(entry.lease, entry.uid)) {
				this.waiting.splice(i, 1);
				this.add(this.leaseWaiting, entry.lease, -1);
				entry.grant();
			} else i++;
		}
	}

	/** A slot, released once by what is returned; or why there is none. An aborted wait leaves the queue. */
	acquire(lease: string, uid: string, signal?: AbortSignal): Promise<{ release: () => void } | { refused: string }> {
		const take = () => {
			this.add(this.leaseInFlight, lease, 1);
			this.add(this.userInFlight, uid, 1);
			this.total++;
			let released = false;
			return {
				release: () => {
					if (released) return;
					released = true;
					this.add(this.leaseInFlight, lease, -1);
					this.add(this.userInFlight, uid, -1);
					this.total--;
					this.drain();
				},
			};
		};
		if (this.room(lease, uid)) return Promise.resolve(take());
		if ((this.leaseWaiting.get(lease) ?? 0) >= this.limits.sessionWaiting) return Promise.resolve({ refused: `Too many model requests waiting from this session (${this.limits.sessionWaiting}).` });
		if (this.waiting.length >= this.limits.totalWaiting) return Promise.resolve({ refused: `Too many model requests waiting on this server (${this.limits.totalWaiting}).` });
		return new Promise((resolve) => {
			const leave = () => {
				const at = this.waiting.indexOf(entry);
				if (at < 0) return false;
				this.waiting.splice(at, 1);
				this.add(this.leaseWaiting, lease, -1);
				return true;
			};
			const timer = setTimeout(() => {
				if (leave()) {
					signal?.removeEventListener("abort", gone);
					resolve({ refused: this.full(lease, uid) });
				}
			}, this.limits.waitMs);
			const gone = () => {
				if (leave()) {
					clearTimeout(timer);
					resolve({ refused: "The request was cancelled while it waited." });
				}
			};
			const entry: Waiter = {
				lease,
				uid,
				grant: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", gone);
					resolve(take());
				},
			};
			signal?.addEventListener("abort", gone, { once: true });
			this.waiting.push(entry);
			this.add(this.leaseWaiting, lease, 1);
		});
	}
}
