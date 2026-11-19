/** One text message is one frame. Sizes on the wire are in UTF-8 bytes. */
import type { SandboxProfile, SandboxProfileId } from "../contract.js";
import type { CreateSandboxInput, ExecOptions, ExecResult, ListedSandbox, SandboxHandle, SandboxPrice } from "../sandbox/api.js";
import type { Answer, ProcessEnd, SandboxProcess, StartOptions, TurnSandbox } from "../sandbox/provider.js";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_UNACKED_BYTES = 8 * 1024 * 1024;
export const MAX_UNACKED_FRAMES = 10_000;
export const ACK_MS = 1_000;
export const PING_MS = 15_000;
export const DEAD_MS = 45_000;
export const RUNNER_GRACE_MS = 600_000;

type Sandbox = { id: string };
type Path = Sandbox & { path: string };
type FileWrite = Path & { content: string };
type Nothing = Record<string, never>;
type Exec = Omit<ExecOptions, "onStdout" | "onStderr" | "signal">;
type Start = Omit<StartOptions, "onStdout" | "onStderr">;
type Call<A, V> = { args: A; value: V };
export interface Operations {
	create: Call<CreateSandboxInput, string>;
	connect: Call<Sandbox, Pick<SandboxHandle, "id" | "cwd" | "profile"> | null>;
	state: Call<Sandbox, "none" | "running" | "paused">;
	suspend: Call<Sandbox, null>;
	destroy: Call<Sandbox, null>;
	list: Call<{ uid: string }, ListedSandbox[]>;
	/** A provider can also answer these from the machine's last report. */
	profiles: Call<Nothing, SandboxProfile[]>;
	profile: Call<{ id: SandboxProfileId }, SandboxProfile>;
	price: Call<Nothing, SandboxPrice | null>;
	idleStopMs: Call<Nothing, number | null>;
	sessionsLiveInSandbox: Call<Nothing, boolean>;
	run: Call<Sandbox & { command: string; options?: Exec }, ExecResult>;
	readTextFile: Call<Path, string>;
	writeTextFile: Call<FileWrite, null>;
	start: Call<Sandbox & { argv: string[]; options?: Start }, { id: string; tag: string }>;
	signal: Call<{ id: string; sig: Parameters<SandboxProcess["signal"]>[0]; who: Parameters<SandboxProcess["signal"]>[1] }, null>;
	killClient: Call<Sandbox, null>;
	ask: Call<Sandbox & { argv: string[]; options?: Parameters<TurnSandbox["ask"]>[1] }, Answer | null>;
	stopLeftovers: Call<Sandbox & { program: string }, number>;
	sweep: Call<Sandbox & { tag: string; options?: Parameters<TurnSandbox["sweep"]>[1] }, number>;
	writeSecretFile: Call<FileWrite, null>;
	removeFiles: Call<Sandbox & { paths: string[] }, null>;
	/** The request id names the hold, so two callers can release their own. */
	holdForTurn: Call<Sandbox, null>;
	releaseTurn: Call<Sandbox & { hold: string }, null>;
	/** Remove this user's turn token files on the machine. The sign-in lives on the server. */
	logout: Call<{ uid: string }, null>;
}

export type Name = keyof Operations;
export type Operation<N extends Name = Name> = { [K in N]: { kind: "op"; id: string; name: K; args: Operations[K]["args"] } }[N];
export type Failure = { kind: "user" | "sandbox" | "refused"; message: string };
export type Ending = Omit<ProcessEnd, "error"> & { error: string | null };
export type Resume = { runnerEpoch: string; serverEpoch: string | null; lastReceived: number };
export type Hello = { kind: "hello"; protocol: number; runnerVersion: string; machineId: string; signature: string; ticket?: string; runnerEpoch: string; resume: Resume | null };
export type Welcome = { kind: "welcome"; serverEpoch: string; lastReceived: number; refused?: string } & ({ fresh: true } | { keep: string[] });
export type Response = { kind: "res"; id: string } & ({ ok: true; value: unknown } | { ok: false; error: Failure });
export type Output = { kind: "out"; id: string; fd: 1 | 2; data: string };
export type End = { kind: "end"; id: string } & Ending;
/** Consecutive pieces of one JSON argument or result. The operation runs only after the last. */
export type Fragment = { part: "more" | "last"; id: string } & ({ kind: "op"; name: Name; args: string } | { kind: "res"; ok: true; value: string });
export type Body = Hello | Welcome | Operation | Response | Fragment | Output | End | { kind: "in"; id: string; data: string } | { kind: "close-in"; id: string } | { kind: "ack" };
export type Frame = Body & { seq: number; ack: number };

type Check = (v: unknown) => boolean;
const str: Check = (v) => typeof v === "string";
const nonempty: Check = (v) => typeof v === "string" && v.length > 0;
const id: Check = (v) => typeof v === "string" && v.length > 0 && v.length <= 255;
const bool: Check = (v) => typeof v === "boolean";
const integer: Check = (v) => Number.isSafeInteger(v);
const count: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nil: Check = (v) => v === null;
const nullable = (check: Check): Check => (v) => v === null || check(v);
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const list = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);
const one = (...values: (string | number | boolean)[]): Check => (v) => values.some((value) => v === value);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function shape(fields: Record<string, Check>): Check {
	return (v) => record(v) && Object.keys(v).every((k) => Object.hasOwn(fields, k)) && Object.entries(fields).every(([k, check]) => check(Object.hasOwn(v, k) ? v[k] : undefined));
}
const strings = list(str);
const env = optional((v) => record(v) && Object.entries(v).every(([k, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && str(value)));
const profileId = one("docker-windlass-sandbox", "docker-hardened", "e2b", "e2b-open", "daytona", "firecracker", "agentos");
const profile = shape({ id: profileId, name: str, summary: str, layers: strings, approval: one("auto", "full"), commandNetwork: bool, commandsCanReadAccessToken: bool, available: bool, unavailableReason: optional(str) });
const sandbox = shape({ id });
const path = shape({ id, path: str });
const writeFile = shape({ id, path: str, content: str });
const nothing = shape({});
const started = { cwd: optional(str), env, secretEnv: env };
const endedCode = nullable(integer);
const answer = { stdout: str, stderr: str };
const calls: Record<Name, [Check, Check]> = {
	create: [shape({ uid: id, sessionId: id, profile: profileId }), id],
	connect: [sandbox, nullable(shape({ id, cwd: str, profile: profileId }))],
	state: [sandbox, one("none", "running", "paused")],
	suspend: [sandbox, nil], destroy: [sandbox, nil],
	list: [shape({ uid: id }), list(shape({ id, sessionId: id, state: one("running", "paused") }))],
	profiles: [nothing, list(profile)], profile: [shape({ id: profileId }), profile],
	price: [nothing, nullable(shape({ usdPerSecond: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0, basis: str }))],
	idleStopMs: [nothing, nullable(count)], sessionsLiveInSandbox: [nothing, bool],
	run: [shape({ id, command: str, options: optional(shape({ ...started, stdin: optional(str), timeoutMs: optional(count) })) }), shape({ ...answer, exitCode: endedCode, timedOut: bool, aborted: bool })],
	readTextFile: [path, str], writeTextFile: [writeFile, nil],
	start: [shape({ id, argv: strings, options: optional(shape(started)) }), shape({ id, tag: id })],
	signal: [shape({ id, sig: one("INT", "TERM", "KILL"), who: one("leader", "all") }), nil],
	killClient: [sandbox, nil],
	ask: [shape({ id, argv: strings, options: optional(shape({ env, timeoutMs: optional(count) })) }), nullable(shape({ ...answer, code: endedCode }))],
	stopLeftovers: [shape({ id, program: str }), count],
	sweep: [shape({ id, tag: id, options: optional(shape({ waitMs: optional(count), files: optional(strings) })) }), count],
	writeSecretFile: [writeFile, nil], removeFiles: [shape({ id, paths: strings }), nil],
	holdForTurn: [sandbox, nil], releaseTurn: [shape({ id, hold: id }), nil], logout: [shape({ uid: id }), nil],
};
export function validResult(name: Name, value: unknown): boolean { return calls[name][1](value); }
export function validArgs(name: Name, args: unknown): boolean { return calls[name][0](args); }
const known = (v: unknown): v is Name => typeof v === "string" && Object.hasOwn(calls, v);
const header = { seq: (v: unknown) => count(v) && v !== 0, ack: count, kind: str };
const fields = (more: Record<string, Check>) => shape({ ...header, ...more });
const resume = shape({ runnerEpoch: id, serverEpoch: nullable(id), lastReceived: count });
const failure = shape({ kind: one("user", "sandbox", "refused"), message: str });
const part = one("more", "last");
const frames = {
	hello: fields({ protocol: count, runnerVersion: id, machineId: id, signature: nonempty, ticket: optional(nonempty), runnerEpoch: id, resume: nullable(resume) }),
	fresh: fields({ serverEpoch: id, lastReceived: count, fresh: one(true), refused: optional(str) }),
	keep: fields({ serverEpoch: id, lastReceived: count, keep: list(id) }),
	op: fields({ id, name: known, args: record }),
	opPart: fields({ id, name: known, part, args: str }),
	res: fields({ id, ok: one(true), value: (v) => v !== undefined && Object.values(calls).some(([, check]) => check(v)) }),
	resPart: fields({ id, ok: one(true), part, value: str }),
	error: fields({ id, ok: one(false), error: failure }),
	out: fields({ id, fd: one(1, 2), data: (v) => typeof v === "string" && Buffer.byteLength(v) <= MAX_OUTPUT_BYTES }),
	input: fields({ id, data: str }), closeIn: fields({ id }),
	end: fields({ id, code: endedCode, signal: nullable(str), error: nullable(str) }),
	ack: fields({}),
};

/** Nothing from a refused message goes into a log or an error. */
export function parseFrame(text: unknown): Frame | null {
	if (typeof text !== "string" || text.length > MAX_FRAME_BYTES || Buffer.byteLength(text) > MAX_FRAME_BYTES) return null;
	let v: unknown;
	try { v = JSON.parse(text); } catch { return null; }
	if (!record(v)) return null;
	let valid: boolean;
	switch (v.kind) {
		case "hello": valid = frames.hello(v) && v.seq === 1 && (v.resume === null ? v.ack === 0 : record(v.resume) && v.resume.runnerEpoch === v.runnerEpoch && v.resume.lastReceived === v.ack && (v.resume.serverEpoch === null ? v.ack === 0 : v.ack !== 0)); break;
		case "welcome": valid = (frames.fresh(v) || frames.keep(v)) && v.seq === 1 && v.lastReceived === v.ack; break;
		case "op": valid = "part" in v ? frames.opPart(v) : frames.op(v) && known(v.name) && validArgs(v.name, v.args); break;
		case "res": valid = "part" in v ? frames.resPart(v) : frames.res(v) || frames.error(v); break;
		case "out": valid = frames.out(v); break;
		case "in": valid = frames.input(v); break;
		case "close-in": valid = frames.closeIn(v); break;
		case "end": valid = frames.end(v); break;
		case "ack": valid = frames.ack(v); break;
		default: return null;
	}
	return valid && (v.seq !== 1 || v.kind === "hello" || v.kind === "welcome") ? v as Frame : null;
}
