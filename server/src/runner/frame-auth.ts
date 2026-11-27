/** Protocol 2. One handshake and two independent counter spaces per physical socket. */
import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	sign,
	timingSafeEqual,
	verify,
	type KeyObject,
} from "node:crypto";
import { count, is, json, list, object, oneOf, optional, plain, text, type Of } from "./check.js";

const binary = (bytes: number) =>
	is<string>(
		v =>
			typeof v === "string" &&
			v.length === Math.ceil((bytes * 4) / 3) &&
			Buffer.from(v, "base64url").toString("base64url") === v,
	);
const nonce = binary(32);
const spki = text(80);
const positive = is<number>(n => count(n) && n > 0);
const certShape = object({ v: oneOf(1), key: spki, serial: positive, notAfter: positive, sig: binary(64) });
export const removalFields = { cert: certShape, sig: binary(64) };
export const endpointShape = object({ endpoint: text(2048), serial: positive, sig: binary(64) });
export const helloFields = { runnerEph: spki, runnerNonce: nonce };
export const welcomeFields = {
	platformEph: spki,
	cert: certShape,
	sig: binary(64),
	endpointChange: optional(endpointShape),
};
type Cert = Of<typeof certShape>;
type Change = Of<typeof endpointShape>;
export type PlatformIdentity = { root: string; key: KeyObject; cert: Cert; endpointChange?: Change };
export type Pin = { platformRoot: string; endpoint: string; maxSerial: number };
export type Trust = { pin: Pin; commit(serial: number, endpoint: string): void };
export type Context = { uid: string; machineId: string; challenge: string; sessionId?: string; ticket?: string };
type Eph = { runnerEph: string; runnerNonce: string };
type Greeting = { platformEph: string; cert: Cert; sig: string; endpointChange?: Change };
export const endpointChanged = "The platform's gateway address changed since pairing. Pair again if you expected this.";

export class FrameAuthError extends Error {
	constructor(readonly category: string) {
		super("frame_auth_failed " + category);
	}
}
function bad(category: string): never {
	throw new FrameAuthError(category);
}
export function authFailure(error: unknown) {
	return error instanceof FrameAuthError ? error.message : "frame_auth_failed handshake";
}

function pub(key: KeyObject) {
	return (key.type === "private" ? createPublicKey(key) : key)
		.export({ format: "der", type: "spki" })
		.toString("base64");
}
function readPublic(encoded: string, type: "x25519" | "ed25519") {
	try {
		const k = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
		if (k.asymmetricKeyType === type && pub(k) === encoded) return k;
	} catch {}
	return bad("key");
}
export function fingerprint(root: string) {
	const hash = createHash("sha256")
		.update(readPublic(root, "ed25519").export({ type: "spki", format: "der" }))
		.digest()
		.subarray(0, 16);
	let bits = 0,
		value = 0,
		result = "";
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	for (const byte of hash) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			result += alphabet[(value >>> bits) & 31];
		}
	}
	if (bits) result += alphabet[(value << (5 - bits)) & 31];
	return result.match(/.{1,4}/g)!.join("-");
}
export const rootFingerprint = (key: KeyObject) => fingerprint(pub(key));
function signature(key: KeyObject, statement: string) {
	return sign(null, Buffer.from(statement), key).toString("base64url");
}
function checkSig(key: KeyObject, statement: string, sig: string, category: string) {
	if (!verify(null, Buffer.from(statement), key, Buffer.from(sig, "base64url"))) bad(category);
}
const certStatement = (c: Omit<Cert, "sig">) => `wlp-platform-cert/1|${c.key}|${c.serial}|${c.notAfter}`;
const changeStatement = (e: Omit<Change, "sig">) => `wlp-platform-endpoint/1|${e.endpoint}|${e.serial}`;
function onlineKey(root: string, cert: Cert, min: number) {
	if (!certShape(cert)) bad("certificate");
	checkSig(readPublic(root, "ed25519"), certStatement(cert), cert.sig, "certificate");
	if (cert.notAfter <= Date.now()) bad("expired");
	if (cert.serial < min) bad("serial");
	return readPublic(cert.key, "ed25519");
}
export function authorizeEndpoint(pin: Pin, endpoint: string, change?: Change) {
	if (pin.endpoint === endpoint) return;
	if (!change || change.endpoint !== endpoint || change.serial < pin.maxSerial) bad("endpoint");
	checkSig(readPublic(pin.platformRoot, "ed25519"), changeStatement(change), change.sig, "endpoint");
}
export function certify(root: KeyObject, serial: number, notAfter: number, endpoint?: string) {
	if (root.asymmetricKeyType !== "ed25519" || !positive(serial) || !positive(notAfter))
		throw new Error("Invalid certification parameters.");
	const { privateKey } = generateKeyPairSync("ed25519");
	const cert = { v: 1 as const, key: pub(privateKey), serial, notAfter };
	const change = endpoint ? { endpoint, serial } : undefined;
	return Buffer.from(
		JSON.stringify({
			root: pub(root),
			pem: privateKey.export({ format: "pem", type: "pkcs8" }),
			cert: { ...cert, sig: signature(root, certStatement(cert)) },
			endpointChange: change && { ...change, sig: signature(root, changeStatement(change)) },
		}),
	).toString("base64url");
}
export function readPlatformKey(raw: string | undefined): PlatformIdentity {
	try {
		const bundle = object({ root: spki, pem: text(512), cert: certShape, endpointChange: optional(endpointShape) });
		const bytes = raw && raw.length < 8192 ? Buffer.from(raw, "base64url") : undefined;
		const value = bytes && bytes.toString("base64url") === raw && json(bytes.toString("utf8"));
		if (bundle(value)) {
			const key = createPrivateKey(value.pem);
			const online = onlineKey(value.root, value.cert, 1);
			if (pub(key) !== pub(online) || pub(key) === value.root) bad("key");
			if (value.endpointChange) {
				if (value.endpointChange.serial !== value.cert.serial) bad("serial");
				checkSig(
					readPublic(value.root, "ed25519"),
					changeStatement(value.endpointChange),
					value.endpointChange.sig,
					"endpoint",
				);
			}
			return { root: value.root, key, cert: value.cert, endpointChange: value.endpointChange };
		}
	} catch {}
	throw new Error("WLP_PLATFORM_KEY needs a valid, unexpired certified online key.");
}

// Input is a parsed JSON value. Sort object names by UTF-16 code unit and retain array order.
function canonical(v: unknown): string {
	if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
	if (plain(v))
		return (
			"{" +
			Object.keys(v)
				.filter(k => v[k] !== undefined)
				.sort()
				.map(k => JSON.stringify(k) + ":" + canonical(v[k]))
				.join(",") +
			"}"
		);
	return JSON.stringify(v);
}
function digest(v: unknown) {
	return createHash("sha256").update(canonical(v)).digest("base64url");
}
function context(c: Context) {
	return `wlp-ctl/2|${c.sessionId === undefined ? "control" : "session"}|${c.uid}|${c.machineId}|${c.challenge}`;
}
function suffix(c: Context) {
	return c.sessionId === undefined ? "" : `|${c.sessionId}|${c.ticket}`;
}
export function machineStatement(c: Context, hello: object & Eph & { signature?: string }) {
	const { signature: _, ...fields } = hello;
	return context(c) + "|" + hello.runnerNonce + "|" + hello.runnerEph + suffix(c) + "|hello|" + digest(fields);
}
function transcript(c: Context, hello: Eph, platformEph: string, welcome: object) {
	return (
		context(c) +
		"|" +
		hello.runnerNonce +
		"|" +
		hello.runnerEph +
		"|" +
		platformEph +
		suffix(c) +
		"|" +
		digest(hello) +
		"|" +
		digest(welcome)
	);
}

export function runnerHandshake<T extends object>(c: Context, base: T, machine: KeyObject) {
	const { privateKey } = generateKeyPairSync("x25519");
	const fields = {
		...base,
		protocol: 2 as const,
		runnerEph: pub(privateKey),
		runnerNonce: randomBytes(32).toString("base64url"),
	};
	const hello = { ...fields, signature: signature(machine, machineStatement(c, fields)) };
	return {
		hello,
		finish(welcome: object & Greeting, trust: Trust, endpoint: string) {
			const { sig, ...fields } = welcome;
			const key = onlineKey(trust.pin.platformRoot, welcome.cert, trust.pin.maxSerial);
			const statement = transcript(c, hello, welcome.platformEph, fields);
			checkSig(key, statement, sig, "signature");
			authorizeEndpoint(trust.pin, endpoint, welcome.endpointChange);
			if (endpoint !== trust.pin.endpoint && welcome.endpointChange?.serial !== welcome.cert.serial) bad("endpoint");
			const auth = socketKeys(privateKey, welcome.platformEph, statement, false);
			trust.commit(welcome.cert.serial, endpoint);
			return auth;
		},
	};
}
export function platformWelcome<T extends object>(c: Context, hello: Eph, base: T, identity: PlatformIdentity) {
	if (identity.cert.notAfter <= Date.now()) bad("expired");
	const { privateKey } = generateKeyPairSync("x25519");
	const fields = {
		...base,
		platformEph: pub(privateKey),
		cert: identity.cert,
		endpointChange: identity.endpointChange,
	};
	const statement = transcript(c, hello, fields.platformEph, fields);
	return {
		welcome: { ...fields, sig: signature(identity.key, statement) },
		auth: socketKeys(privateKey, hello.runnerEph, statement, true),
	};
}
// A tombstoned machine cannot obtain a gateway lease. Authenticate its final HTTP
// instruction using the fresh nonce from the machine-signed discovery request.
function removalStatement(uid: string, machineId: string, nonce: string, remove: boolean, cert: Cert) {
	return `wlp-platform-removal/2|${uid}|${machineId}|${nonce}|${Number(remove)}|${digest(cert)}`;
}
export function signRemoval(
	uid: string,
	machineId: string,
	nonce: string,
	removeSandboxes: boolean,
	identity: PlatformIdentity,
) {
	if (identity.cert.notAfter <= Date.now()) bad("expired");
	return {
		reason: "removed" as const,
		removeSandboxes,
		cert: identity.cert,
		sig: signature(identity.key, removalStatement(uid, machineId, nonce, removeSandboxes, identity.cert)),
	};
}
export function verifyRemoval(
	uid: string,
	machineId: string,
	nonce: string,
	answer: ReturnType<typeof signRemoval>,
	trust: Trust,
) {
	const key = onlineKey(trust.pin.platformRoot, answer.cert, trust.pin.maxSerial);
	checkSig(key, removalStatement(uid, machineId, nonce, answer.removeSandboxes, answer.cert), answer.sig, "signature");
	trust.commit(answer.cert.serial, trust.pin.endpoint);
}
export const RETENTION_PATH = "/runner/snapshot-retention";
export const retentionRequest = (uid: string, machineId: string, time: number, nonce: string) =>
	JSON.stringify(["wlp-snapshot-retention-request/2", uid, machineId, time, nonce]);
const retentionStatement = (request: string, generations: string[], cert: Cert) =>
	JSON.stringify(["wlp-snapshot-retention-answer/2", request, generations, digest(cert)]);

export function signRetention(request: string, generations: string[], identity: PlatformIdentity) {
	if (identity.cert.notAfter <= Date.now()) bad("expired");
	return {
		generations,
		cert: identity.cert,
		sig: signature(identity.key, retentionStatement(request, generations, identity.cert)),
	};
}
const retentionAnswer = object({
	...removalFields,
	generations: list(
		is<string>(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)),
		500,
	),
});
export function verifyRetention(request: string, answer: unknown, trust: Trust) {
	if (!retentionAnswer(answer)) bad("retention");
	const key = onlineKey(trust.pin.platformRoot, answer.cert, trust.pin.maxSerial);
	checkSig(key, retentionStatement(request, answer.generations, answer.cert), answer.sig, "signature");
	trust.commit(answer.cert.serial, trust.pin.endpoint);
	return new Set(answer.generations);
}
function socketKeys(own: KeyObject, peer: string, statement: string, server: boolean) {
	const shared = diffieHellman({ privateKey: own, publicKey: readPublic(peer, "x25519") });
	const salt = createHash("sha256").update(statement).digest();
	const keys = Buffer.from(hkdfSync("sha256", shared, salt, "wlp-ctl/2 keys", 64));
	const s2r = keys.subarray(0, 32),
		r2s = keys.subarray(32);
	return new FrameAuth(server ? s2r : r2s, server ? r2s : s2r);
}
export const AUTH_OVERHEAD = 80; // Enough for a base64url MAC and a safe-integer counter.
export class FrameAuth {
	private sent = 0;
	private received = 0;
	constructor(
		private readonly tx: Buffer,
		private readonly rx: Buffer,
	) {}
	private tag(key: Buffer, ctr: number, frame: object) {
		const counter = Buffer.alloc(8);
		counter.writeBigUInt64BE(BigInt(ctr));
		return createHmac("sha256", key)
			.update(counter)
			.update(canonical({ ...frame, ctr }))
			.digest();
	}
	seal(frame: object) {
		const ctr = this.sent++;
		if (!count(ctr)) bad("counter");
		return JSON.stringify({ ...frame, ctr, mac: this.tag(this.tx, ctr, frame).toString("base64url") });
	}
	open(data: unknown, max: number): string {
		if (typeof data !== "string" || data.length > max + AUTH_OVERHEAD || Buffer.byteLength(data) > max + AUTH_OVERHEAD)
			bad("size");
		const value = json(data);
		if (!plain(value) || !nonce(value.mac)) bad("mac");
		const { ctr, mac, ...frame } = value;
		if (ctr !== this.received || !count(ctr)) bad("counter");
		let expected: Buffer;
		try {
			expected = this.tag(this.rx, ctr, frame);
		} catch {
			return bad("schema");
		}
		if (!timingSafeEqual(expected, Buffer.from(mac, "base64url"))) bad("mac");
		this.received++;
		return JSON.stringify(frame);
	}
}
