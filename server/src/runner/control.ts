/**
 * What a runner and its machine's actor say on the machine's control socket, and what a runner asks
 * the platform's HTTP routes before it has one (Plans/2026-11-19 "bring your own computer", section 3).
 * Imported by the `machine` actor, the routes, the runner and the stand-ins of both, so it imports
 * nothing of the server's: no RivetKit, no configuration, only types.
 *
 * The control socket (`machine.get([uid, machineId]).webSocket("control")`). Every WebSocket message is
 * one JSON frame of at most MAX_CONTROL_FRAME_BYTES. Nothing is numbered or resent: a new socket starts
 * over with a new challenge, and what the actor still wants done (a removal) it asks again.
 *
 *   challenge  actor → runner   first frame on every socket: a nonce for the runner to sign
 *   hello      runner → actor   the signature, the runner's release, its process epoch and its clock
 *   welcome    actor → runner   accepted: the idle time the runner applies to sandboxes on its own
 *   refused    actor → runner   not accepted, or no longer (the machine was removed), with a sentence to
 *                               show; the actor then closes the socket
 *   report     runner → actor   what the machine has: Docker, the probe, free disk, its sandboxes. Sent
 *                               after welcome and whenever what it says changed, at most every REPORT_MS
 *   heartbeat  either way       sent every CONTROL_HEARTBEAT_MS; a socket that is silent for CONTROL_DEAD_MS is closed
 *   attach     actor → runner   a session wants its sandbox: open that session's socket with the ticket
 *   remove     actor → runner   remove one sandbox (its session was deleted); answered with `removed`
 *   removed    runner → actor   that sandbox is gone, or was never this machine's
 *   logout     actor → runner   the user's ChatGPT sign-in was forgotten: remove the access token files
 *                               of running turns
 *
 * What a refusal leads to on the runner: it says the sentence, never exits (a container that exits is
 * started again by Docker, which would only repeat the refusal), and asks again after REFUSED_RETRY_MS.
 * "removed" is the one exception: it forgets its key, removes its sandboxes and its data volume first
 * when `removeSandboxes` says so, and waits to be paired again.
 *
 * Validation is here and nowhere else, built with the session protocol's checks (check.ts); no stream
 * field of that protocol is used here. A frame that does not pass is null: the actor refuses the socket
 * ("bad-frame"), the runner drops the socket and connects again.
 */
import type { MachineProbe, PlatformConnection } from "../contract.js";
import { type Assert, type Of, type Same, boolean, count, either, integer, is, json, list, nullable, object, oneOf, optional, plain, text } from "./check.js";

/** The oldest runner release this server serves: raise it when the server stops reading what older runners send. */
export const MIN_RUNNER_VERSION = "0.1.0";
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
/** A slow heartbeat: it costs no write on either side. */
export const CONTROL_HEARTBEAT_MS = 30_000;
export const CONTROL_DEAD_MS = 90_000;
/** A socket heard from within this is live (it sends a heartbeat every CONTROL_HEARTBEAT_MS): see `secondHello`. */
export const LIVE_MS = CONTROL_HEARTBEAT_MS + 10_000;
/** The least time between two scheduled reports: a change within it goes with the next one. A sandbox made or removed is the exception: the runner reports that at once, since the page and a session that lost a `create` read the newest report. */
export const REPORT_MS = 60_000;
export const REFUSED_RETRY_MS = 10 * 60_000;
/** How far a runner's clock may be from the platform's: a signed time further off is refused (and signed again with the offset), and the page warns about one. */
export const CLOCK_TOLERANCE_MS = 60_000;
/** The most sandboxes one report lists. */
export const MAX_REPORTED_SANDBOXES = 100;

/** `m_` and 16 hex digits, made by the platform when a machine is confirmed. */
export const MACHINE_ID = /^m_[0-9a-f]{16}$/;
/** User and session ids, as the platform makes them (`u_…`, `s_…`): letters, digits, `_` and `-`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A pairing code as the platform makes it: eight Crockford base32 digits in two groups. */
export const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** How long a pairing code and its poll secret are good for. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** How often a runner asks whether its code was confirmed. */
export const PAIRING_POLL_MS = 2_000;

// ---- Versions ----

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Whether release `version` ("1.2.3") is `minimum` or later. A version that is not one is not. */
export function versionAtLeast(version: string, minimum: string): boolean {
	const a = VERSION.exec(version);
	const b = VERSION.exec(minimum);
	if (a === null || b === null) return false;
	for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
	return true;
}

// ---- What is signed with the machine's key (Ed25519, the signature in base64url) ----

/** Over the control socket's challenge. */
export const controlProof = (uid: string, machineId: string, nonce: string) => `wlp-runner-control/1|${uid}|${machineId}|${nonce}`;
/** With the session socket's hello (protocol.ts), over the ticket the `attach` frame carried, which the runner does not read. */
export const sessionProof = (uid: string, sessionId: string, machineId: string, ticket: string) => `wlp-runner-session/1|${uid}|${sessionId}|${machineId}|${ticket}`;
/** With POST RUNNER_CONNECTION_PATH, over the runner's time corrected by the offset it was last told. */
export const connectionProof = (uid: string, machineId: string, time: number) => `wlp-runner-connection/1|${uid}|${machineId}|${time}`;

// ---- Checks ----

/** One line of text: what a machine says of itself, or a reason, shown on the page as it is. */
const line = (max: number) => is<string>((v) => text(max)(v) && !/[\u0000-\u001f\u007f]/.test(v as string));
const name = is<string>((v) => typeof v === "string" && NAME.test(v));
const machineId = is<string>((v) => typeof v === "string" && MACHINE_ID.test(v));
const version = is<string>((v) => typeof v === "string" && VERSION.test(v));
const base64url = (length: number) => is<string>((v) => typeof v === "string" && v.length === length && /^[A-Za-z0-9_-]+$/.test(v));
/** 32 random bytes. */
const nonce = base64url(43);
/** An Ed25519 signature: 64 bytes. */
const signature = base64url(86);
const epoch = is<string>((v) => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v));
const time = is<number>((v) => count(v) && (v as number) > 0);
const sandboxId = line(255);
const probe = either(object({ ok: oneOf(true) }), object({ ok: oneOf(false), reason: line(500) }));

// ---- Actor → runner ----

const refusal = either(
	either(
		object({ kind: oneOf("refused"), reason: oneOf("outdated"), minimum: version, message: line(500) }),
		object({ kind: oneOf("refused"), reason: oneOf("removed"), removeSandboxes: boolean, message: line(500) }),
	),
	/**
	 * "key-in-use": another runner with this key is connected (`secondHello`). "unknown": the signature
	 * is not this machine's key's. "bad-frame": the runner sent what this server does not read.
	 * "other": a reason of a newer server's, made by `parseServerFrame`; only its sentence is read.
	 */
	object({ kind: oneOf("refused"), reason: oneOf("key-in-use", "unknown", "bad-frame", "other"), message: line(500) }),
);
const serverFrame = either(
	either(
		either(object({ kind: oneOf("challenge"), nonce }), object({ kind: oneOf("welcome"), idleSuspendMs: count })),
		either(refusal, object({ kind: oneOf("heartbeat", "logout") })),
	),
	either(
		/** `ticket` goes into the session socket's hello as it is (protocol.ts limits it to 1024). */
		object({ kind: oneOf("attach"), sessionId: name, ticket: text(1024) }),
		object({ kind: oneOf("remove"), sandbox: sandboxId }),
	),
);
export type Refusal = Of<typeof refusal>;
export type ServerFrame = Of<typeof serverFrame>;

// ---- Runner → actor ----

/**
 * The hello keeps this shape in every release, so an actor can tell any runner that it is outdated.
 * `epoch` is made once per runner process; `time` is the runner's clock when it sent this, for the
 * offset the page warns about (a frame's travel time is well inside CLOCK_TOLERANCE_MS). The actor
 * checks it in this order, and records nothing before the first passes: the signature over
 * `controlProof` (else "unknown"; a removed machine's key is kept to check it before "removed" is
 * said), the release (else "outdated", recorded for the page), then `secondHello`.
 */
const hello = object({ kind: oneOf("hello"), runnerVersion: version, epoch, time, signature });
const cap = is<number>((v) => Number.isSafeInteger(v) && (v as number) >= 1);
const harnesses = list(object({ id: oneOf("claude"), adapter: line(64), image: line(128), signIn: oneOf("token", "none", "unknown") }), 4);
const report = object({
	harnesses: optional(harnesses),
	kind: oneOf("report"),
	docker: probe,
	/** The bubblewrap probe (BWRAP_PROBE) in a container of the "docker-windlass-sandbox" profile. */
	commandSandbox: probe,
	/** The runner was started with --screenshots and has a pinned screenshots image. */
	screenshots: optional(boolean),
	freeDiskBytes: nullable(count),
	/** `usedAt` by the runner's clock: the actor corrects it by the offset from the hello. */
	sandboxes: list(object({ id: sandboxId, sessionId: name, state: oneOf("running", "paused"), usedAt: count }), MAX_REPORTED_SANDBOXES),
	/** The caps its owner set (`--max-running`, `--max-sandboxes`), left out where none is set. */
	maxRunning: optional(cap),
	maxSandboxes: optional(cap),
});
const runnerFrame = either(either(hello, report), either(object({ kind: oneOf("heartbeat") }), object({ kind: oneOf("removed"), sandbox: sandboxId })));
export type Hello = Of<typeof hello>;
export type Report = Of<typeof report>;
export type RunnerFrame = Of<typeof runnerFrame>;

function frameText(data: unknown): unknown {
	if (typeof data !== "string" || data.length > MAX_CONTROL_FRAME_BYTES || Buffer.byteLength(data) > MAX_CONTROL_FRAME_BYTES) return undefined;
	return json(data);
}

/** For the actor: null for anything a runner sent that is not a frame of this module. */
export function parseRunnerFrame(data: unknown): RunnerFrame | null {
	const v = frameText(data);
	return runnerFrame(v) ? v : null;
}

/** For the runner: null for anything that is not a frame; a refusal it does not know is "other", so its sentence still shows. */
export function parseServerFrame(data: unknown): ServerFrame | null {
	const v = frameText(data);
	if (serverFrame(v)) return v;
	if (plain(v) && v.kind === "refused" && line(500)(v.message)) return { kind: "refused", reason: "other", message: v.message };
	return null;
}

/** The refusal, with the sentence the runner prints: made here so the actor and its stand-in say the same. */
export function refuse(reason: "outdated" | "removed" | "key-in-use" | "unknown" | "bad-frame", detail: { runnerVersion?: string; removeSandboxes?: boolean } = {}): Refusal {
	switch (reason) {
		case "outdated":
			return { kind: "refused", reason, minimum: MIN_RUNNER_VERSION, message: `This runner is ${detail.runnerVersion ?? "too old"}; the platform needs ${MIN_RUNNER_VERSION} or later. Update it with the command on the Machines page.` };
		case "removed":
			return { kind: "refused", reason, removeSandboxes: detail.removeSandboxes === true, message: detail.removeSandboxes ? "This machine was removed from its account. Its sandboxes and data volume are being removed; run `windlass-runner pair` to add it again." : "This machine was removed from its account; its sandboxes stay. Run `windlass-runner pair` to add it again." };
		case "key-in-use":
			return { kind: "refused", reason, message: "Another runner with this machine's key is connected. If you copied the key, stop the other runner; if you did not, remove the machine on the Machines page." };
		case "unknown":
			return { kind: "refused", reason, message: "The platform does not know this machine's key. Run `windlass-runner pair` to add the machine again." };
		case "bad-frame":
			return { kind: "refused", reason, message: "The platform could not read what this runner sent. Use the runner release the Machines page names." };
	}
}

/**
 * What the actor does with an accepted hello while it may hold a socket already: "accept" with none,
 * "replace" (close the old one, keep the new, and record nothing) when the hello comes from the same
 * runner process, or from another while the old socket has gone quiet past LIVE_MS (a runner that
 * restarted while its old socket was half open), and "refuse" ("key-in-use", recorded for the page's
 * warning) for a second runner process while the first is live.
 */
export function secondHello(live: { epoch: string; heardAt: number } | null, hello: Pick<Hello, "epoch">, now: number): "accept" | "replace" | "refuse" {
	if (live === null) return "accept";
	if (live.epoch === hello.epoch || now - live.heardAt > LIVE_MS) return "replace";
	return "refuse";
}

// ---- HTTP, before the runner has a socket ----

/**
 * POST RUNNER_PAIR_PATH, unsigned: a runner with no key asks to be paired. `PairRequest` in,
 * `PairStarted` out. The runner prints the code and polls with the pairing id and the poll secret.
 */
export const RUNNER_PAIR_PATH = "/runner/pair";
/** POST: `PairPoll` in, `PairStatus` out, every PAIRING_POLL_MS for PAIRING_TTL_MS. A 5xx is tried again. */
export const RUNNER_PAIR_POLL_PATH = "/runner/pair/poll";
/**
 * POST, signed: `ConnectionRequest` in. 200: the platform's `PlatformConnection`, with which the runner
 * opens the control socket. Otherwise a `ConnectionRefusal`: 403 "clock" (sign again with the offset to
 * `serverTime`), 403 "unknown", 410 "removed". A removed machine's key is checked before it is told.
 */
export const RUNNER_CONNECTION_PATH = "/runner/connection";

const pairRequest = object({
	/** The machine's Ed25519 public key, SPKI PEM. */
	publicKey: text(512),
	name: line(64),
	os: line(32),
	arch: line(32),
	runnerVersion: version,
});
const pairStarted = object({ code: is<string>((v) => typeof v === "string" && PAIRING_CODE.test(v)), pairing: base64url(43), pollSecret: base64url(43) });
const pairPoll = object({ pairing: base64url(43), pollSecret: base64url(43) });
const pairStatus = either(
	object({ state: oneOf("waiting", "gone") }),
	/** `githubLogin`: the account's GitHub login, for the runner to print; null when it has no GitHub connection. */
	object({ state: oneOf("approved"), uid: name, machineId, githubLogin: nullable(line(64)) }),
);
const connectionRequest = object({ uid: name, machineId, time, signature });
const connectionRefusal = either(either(object({ reason: oneOf("clock"), serverTime: time }), object({ reason: oneOf("removed"), removeSandboxes: boolean })), object({ reason: oneOf("unknown") }));

export type PairRequest = Of<typeof pairRequest>;
export type PairStarted = Of<typeof pairStarted>;
export type PairPoll = Of<typeof pairPoll>;
export type PairStatus = Of<typeof pairStatus>;
export type ConnectionRequest = Of<typeof connectionRequest>;
export type ConnectionRefusal = Of<typeof connectionRefusal>;

/** Each null for a body that is not one: the route answers 400, the runner treats it as a failed request. */
export const parsePairRequest = (body: unknown): PairRequest | null => (pairRequest(body) ? body : null);
export const parsePairStarted = (body: unknown): PairStarted | null => (pairStarted(body) ? body : null);
export const parsePairPoll = (body: unknown): PairPoll | null => (pairPoll(body) ? body : null);
export const parsePairStatus = (body: unknown): PairStatus | null => (pairStatus(body) ? body : null);
export const parseConnectionRequest = (body: unknown): ConnectionRequest | null => (connectionRequest(body) ? body : null);
export const parseConnectionRefusal = (body: unknown): ConnectionRefusal | null => (connectionRefusal(body) ? body : null);

const connection = object({
	endpoint: nullable(text(2048)),
	namespace: text(255),
	token: nullable(object({ token: text(8192), expiresAt: integer, validForMs: count })),
});
/** For the runner: the 200 answer of RUNNER_CONNECTION_PATH. */
export const parseConnection = (body: unknown): PlatformConnection | null => (connection(body) ? body : null);

type Drift = [Assert<Same<Of<typeof probe>, MachineProbe>>, Assert<Same<Of<typeof connection>, PlatformConnection>>];
