/**
 * What the server and a runner say on a session's socket (Plans/2026-11-19 "bring your own computer",
 * section 1.4). Every WebSocket message is one JSON frame of at most MAX_FRAME_BYTES:
 *
 *   hello    runner → server  first frame on every socket: who it is, and the conversation it resumes
 *   welcome  server → runner  the answer: that conversation resumed, a new one, or a refusal to show
 *   msg      either way       one numbered message (a `Body`)
 *   part     either way       a numbered piece of a message too large for one frame
 *   ack      either way       how far the sender has received; also the heartbeat
 *
 * Validation is here and nowhere else. A type and its check are one definition, so they cannot drift
 * apart, and the `Same` assertions at the end tie the operations to the provider interfaces they carry.
 */
import type { SandboxProfileId } from "../contract.js";
import type { CreateSandboxInput, ExecOptions, ExecResult } from "../sandbox/api.js";
import { RUN_TAG, type Answer, type SandboxProcess, type StartOptions, type TurnSandbox } from "../sandbox/provider.js";
import { type Assert, type Check, type Of, type Same, anything, boolean, count, either, integer, is, json, list, nil, nullable, object, oneOf, optional, plain, string, text } from "./check.js";

// Pairing-wide operations travel on the control socket, never on an agent session's channel.
export const CLAUDE_LOGIN_MS = 10 * 60_000;
const requestId = is<string>(v => typeof v === "string" && v.length === 32 && !/[^a-f0-9]/.test(v));
export const approvalCode = is<string>(v => text(2048)(v) && !/[^A-Za-z0-9._~#%+=/-]|sk-ant-oat01-/.test(v));
// Only the public authorization parameters emitted by the pinned setup CLI can cross the socket.
const authorizeParams = new Set(["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"]);
export const authorizeUrl = is<string>(v => {
	if (!text(8192)(v) || !v.startsWith("https://claude.com/cai/oauth/authorize?") || /[^!-~]|[\\"<>#]/.test(v)) return false;
	const params = new URL(v).searchParams;
	for (const [name, value] of params) if (!authorizeParams.has(name) || value.includes("sk-ant-oat01-")) return false;
	return !!params.get("code_challenge") && !!params.get("state");
});
export const loginCommand = either(
	object({ kind: oneOf("harnessLogin.start", "harnessLogin.cancel"), requestId }),
	object({ kind: oneOf("harnessLogin.finish"), requestId, code: approvalCode }),
);
export type LoginCommand = Of<typeof loginCommand>;
const loginResult = either(
	either(object({ url: authorizeUrl, expiresAt: is<number>(v => integer(v) && v > 0) }), object({ signedIn: oneOf(true) })),
	either(object({ cancelled: oneOf(true) }), object({ error: is<string>(v => text(500)(v) && !/[\u0000-\u001f\u007f]|sk-ant-oat01-/.test(v)) })),
);
export type LoginResult = Of<typeof loginResult>;
export const loginResultFrame = object({ kind: oneOf("harnessLogin.result"), requestId, result: loginResult });

export const positiveLimit = is<number>(v => count(v) && v > 0);

export const PROTOCOL_VERSION = 1;
/** Under the 256 KiB RivetKit takes per incoming message (registry.ts); the probe measures the gateway. */
export const MAX_FRAME_BYTES = 128 * 1024;
/** The largest message, as JSON: a `run` result holds up to 4 MiB of output (sandboxes.ts, STDOUT_CAP). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Unacknowledged data past which a stream's source is asked to wait (`RunnerChannel.output`). */
export const WINDOW_BYTES = 8 * 1024 * 1024;
export const WINDOW_FRAMES = 10_000;
/** Operations one side may have outstanding: this, times MAX_MESSAGE_BYTES, bounds the answers held. */
export const MAX_OPS_IN_FLIGHT = 16;
export const ACK_MS = 1_000;
export const PING_MS = 15_000;
export const DEAD_MS = 45_000;
export const RUNNER_GRACE_MS = 600_000;
/** What an operation without a `timeoutMs` of its own may take: `create` is `docker run` and `git init`. */
export const OP_MS = 180_000;

/**
 * The longest wait an operation may name. Node fires a timer past 2^31 ms (24.8 days) after 1 ms, on
 * either end; the platform's longest is the setup command's (WLP_SETUP_TIMEOUT_MS, ten minutes unless
 * a deployment raises it), so a day refuses nothing real.
 */
const duration = is<number>((v) => count(v) && (v as number) <= 24 * 60 * 60 * 1000);
const id = text(255);
const tag = is<string>((v) => id(v) && RUN_TAG.test(v));
const env = is<Record<string, string>>((v) => plain(v) && Object.entries(v).every(([k, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof value === "string"));
/** A machine serves the two Docker profiles; E2B's and the rest are the deployment's. */
export const MACHINE_PROFILES = ["docker-hardened", "docker-windlass-sandbox"] as const;
export type MachineProfile = typeof MACHINE_PROFILES[number];
export const machineProfile = oneOf(...MACHINE_PROFILES);
export const PROFILE_DENIED = "This machine’s owner has not allowed the Windlass sandbox profile. Start the runner with --allow-profile docker-windlass-sandbox to allow it.";
const harness = optional(oneOf("claude"));
const sandbox = { id };
const startOptions = { cwd: optional(string), env: optional(env), secretEnv: optional(env) };

/**
 * The methods of `Sandboxes`, `SandboxHandle`, `TurnSandbox` and `SandboxProcess` that cross to a
 * machine, as [arguments, result]. `id` is a sandbox; `process` is the id of the `start` that made it.
 * `profiles`, `list`, `price` and the other facts come from the machine's report, not from here.
 */
const operations = {
	create: [object({ profile: machineProfile, harness, screenshots: optional(boolean) }), id],
	connect: [object(sandbox), nullable(object({ cwd: string, profile: machineProfile, harness, screenshots: optional(boolean) }))],
	state: [object(sandbox), oneOf("none", "running", "paused")],
	suspend: [object(sandbox), nil],
	destroy: [object(sandbox), nil],
	/** Its output streams as `out` with this operation's id; `cancel` is its abort signal. */
	run: [object({ ...sandbox, command: string, options: optional(object({ ...startOptions, stdin: optional(string), timeoutMs: optional(duration) })) }),
		object({ exitCode: nullable(integer), timedOut: boolean, aborted: boolean, stdout: string, stderr: string })],
	readTextFile: [object({ ...sandbox, path: string }), string],
	writeTextFile: [object({ ...sandbox, path: string, content: string }), nil],
	/** The server names the tag, so a process has it before the runner answers. Its id is the process. */
	start: [object({ ...sandbox, tag, argv: list(string), options: optional(object(startOptions)) }), nil],
	signal: [object({ process: id, sig: oneOf("INT", "TERM", "KILL"), who: oneOf("leader", "all") }), nil],
	killClient: [object({ process: id }), nil],
	ask: [object({ ...sandbox, argv: list(string), options: optional(object({ env: optional(env), timeoutMs: optional(duration) })) }),
		nullable(object({ code: nullable(integer), stdout: string, stderr: string }))],
	stopLeftovers: [object({ ...sandbox, program: string }), count],
	sweep: [object({ ...sandbox, tag, options: optional(object({ waitMs: optional(duration), files: optional(list(string)) })) }), count],
	writeSecretFile: [object({ ...sandbox, path: string, content: string }), nil],
	removeFiles: [object({ ...sandbox, paths: list(string) }), nil],
} as const satisfies Record<string, readonly [Check<unknown>, Check<unknown>]>;

export type Name = keyof typeof operations;
export type Args<N extends Name> = Of<(typeof operations)[N][0]>;
export type Value<N extends Name> = Of<(typeof operations)[N][1]>;
export type Operation = { [N in Name]: { kind: "op"; id: string; name: N; args: Args<N> } }[Name];
export const isName = (v: unknown): v is Name => typeof v === "string" && Object.hasOwn(operations, v);
export const validArgs = <N extends Name>(name: N, args: unknown): args is Args<N> => operations[name][0](args);
export const validValue = <N extends Name>(name: N, value: unknown): value is Value<N> => operations[name][1](value);

/** `user` is a SandboxUserError, a sentence fit to show; `refused` is the runner's policy saying no. */
const failure = object({ kind: oneOf("user", "sandbox", "refused"), message: string });
export type Failure = Of<typeof failure>;

/** The arguments of `op` and the value of `res` are checked against the operation by the receiver. */
const body = either(
	either(
		object({ kind: oneOf("op"), id, name: string, args: is<Record<string, unknown>>(plain) }),
		either(object({ kind: oneOf("res"), id, ok: oneOf(true), value: anything }), object({ kind: oneOf("res"), id, ok: oneOf(false), error: failure })),
	),
	either(
		either(object({ kind: oneOf("out"), id, fd: oneOf(1, 2), data: string }), object({ kind: oneOf("end"), id, code: nullable(integer), signal: nullable(string), error: nullable(string) })),
		either(object({ kind: oneOf("in"), id, data: string }), object({ kind: oneOf("close-in", "cancel"), id })),
	),
);
export type Body = Of<typeof body>;

const resume = object({ conversation: id, received: count });
const hello = object({ kind: oneOf("hello"), protocol: oneOf(PROTOCOL_VERSION), runnerVersion: text(64), machineId: id, ticket: text(1024), signature: text(1024), resume: nullable(resume) });
/** A refusal keeps this shape in every version, so a runner of any version can show it. */
const refusal = object({ kind: oneOf("welcome"), protocol: integer, refused: text(1000) });
const welcome = either(object({ kind: oneOf("welcome"), protocol: oneOf(PROTOCOL_VERSION), conversation: id, received: count, resumed: boolean }), refusal);
const seq = is<number>((v) => count(v) && v !== 0);
const frame = either(
	either(hello, welcome),
	either(either(object({ kind: oneOf("msg"), seq, ack: count, body }), object({ kind: oneOf("part"), seq, ack: count, data: text(MAX_FRAME_BYTES), last: boolean })), object({ kind: oneOf("ack"), ack: count })),
);
export type Hello = Of<typeof hello>;
export type Welcome = Of<typeof welcome>;
/** A hello in another protocol: only its number is read, to say why it is refused. */
export type Foreign = { kind: "foreign"; protocol: number };
export type Frame = Of<typeof frame> | Foreign;

/** Null for anything that is not a frame of this protocol. Nothing of a refused frame is kept. */
export function parseFrame(data: unknown): Frame | null {
	if (typeof data !== "string" || data.length > MAX_FRAME_BYTES || Buffer.byteLength(data) > MAX_FRAME_BYTES) return null;
	const v = json(data);
	if (plain(v) && v.kind === "hello" && Number.isSafeInteger(v.protocol) && v.protocol !== PROTOCOL_VERSION) return { kind: "foreign", protocol: v.protocol as number };
	return frame(v) ? v : null;
}

/** A message put back together from its parts. */
export function parseBody(data: string): Body | null {
	const v = json(data);
	return body(v) ? v : null;
}

export function protocolRefusal(runnerProtocol: number): string {
	return runnerProtocol < PROTOCOL_VERSION
		? `This machine's runner speaks protocol ${runnerProtocol}; the platform needs ${PROTOCOL_VERSION}. Update the runner.`
		: `This machine's runner speaks protocol ${runnerProtocol}, newer than the platform's ${PROTOCOL_VERSION}. Use the runner release the Machines page names.`;
}

// The wire types are the provider's, without what cannot cross a socket (callbacks, an AbortSignal).
type Drift = [
	Assert<Same<Args<"create">["harness"], CreateSandboxInput["harness"]>>,
	Assert<Same<Args<"run">["options"], Omit<ExecOptions, "onStdout" | "onStderr" | "signal"> | undefined>>,
	Assert<Same<Value<"run">, ExecResult>>,
	Assert<Same<Args<"start">["options"], Omit<StartOptions, "onStdout" | "onStderr"> | undefined>>,
	Assert<Same<Args<"ask">["options"], Parameters<TurnSandbox["ask"]>[1]>>,
	Assert<Same<Value<"ask">, Answer | null>>,
	Assert<Same<Args<"sweep">["options"], Parameters<TurnSandbox["sweep"]>[1]>>,
	Assert<Same<Args<"signal">["sig"] | Args<"signal">["who"], Parameters<SandboxProcess["signal"]>[number]>>,
	Assert<Same<Args<"create">["profile"], Extract<SandboxProfileId, `docker-${string}`>>>,
];
