/**
 * Two channels, with every message held until the check delivers it. The clock moves by hand,
 * so the ten-minute grace and a silent socket take no longer to check than a lost receipt.
 *
 *   cd server && npx tsx ../scripts/runner-protocol-check.ts
 */
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { ReliableChannel, type ChannelSocket } from "../server/src/runner/channel.js";
import { ACK_MS, DEAD_MS, MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, MAX_UNACKED_BYTES, MAX_UNACKED_FRAMES, PING_MS, RUNNER_GRACE_MS, parseFrame } from "../server/src/runner/protocol.js";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const hello = { runnerVersion: "0.1.0", machineId: "machine", signature: "test signature" };
const success = { code: 0, signal: null, error: null };
const state = { kind: "op", id: "one", name: "state", args: { id: "box" } } as const;
type Options = ConstructorParameters<typeof ReliableChannel>[0];
const channels: ReliableChannel[] = [];
function channel(options: Options): ReliableChannel {
	const ch = new ReliableChannel(options);
	channels.push(ch);
	return ch;
}

class Wire implements ChannelSocket {
	peer!: Wire;
	queue: string[] = [];
	closed = false;
	message: (text: unknown) => void = () => {};
	private gone = () => {};
	send(text: string): void { this.queue.push(text); }
	onMessage(fn: (text: unknown) => void): void { this.message = fn; }
	onClose(fn: () => void): void { this.gone = fn; }
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.gone();
	}
	drop(): void {
		this.close();
		this.peer.close();
	}
	flush(): void {
		for (const text of this.queue.splice(0)) this.peer.message(text);
		if (this.closed) this.peer.close();
	}
}
function join(server: ReliableChannel, runner: ReliableChannel, deliver = true) {
	const s = new Wire();
	const r = new Wire();
	s.peer = r;
	r.peer = s;
	server.attach(s);
	runner.attach(r, hello);
	if (deliver) { r.flush(); s.flush(); r.flush(); }
	return { s, r };
}
function stopped(promise: Promise<unknown>): Promise<string> {
	return promise.then(() => "", (error: Error) => error.message);
}

async function replay(): Promise<void> {
	const input: string[] = [];
	const output: string[] = [];
	let executions = 0;
	let owned: string[] = [];
	const server = channel({ role: "server" });
	const runner = channel({
		role: "runner",
		onOperation(op) { executions++; if (op.name === "state") runner.respond(op, "running"); },
		onInput: (_, data) => input.push(data), onCloseIn: () => input.push("EOF"),
		onWelcome: (answer) => { if ("keep" in answer) owned = answer.keep; },
	});
	const old = join(server, runner);
	const ended = server.stream("process", (fd, text) => output.push(`${fd} ${text}`));
	const result: Promise<"none" | "running" | "paused"> = server.request(state);
	old.r.message(old.s.queue[0]);
	old.s.flush();
	const lost = old.r.queue.shift()!;
	runner.output("process", 1, "first");
	old.r.flush(); // The response before this output is still missing.
	old.r.drop();
	runner.output("process", 2, "second");
	runner.end("process", success);
	server.write("process", "answer");
	server.closeIn("process");
	const next = join(server, runner, false);
	next.r.flush();
	const welcome = next.s.queue.shift()!;
	next.r.message(welcome);
	expect("a resumed welcome names the open process and request", owned.includes("process") && owned.includes("one"));
	old.s.message(lost);
	old.r.message(welcome);
	expect("late deliveries from the old socket cannot fill the gap", !output.length);
	const replies = next.r.queue.splice(0);
	expect("a lost response is resent once, with its original sequence", replies.filter((text) => text === lost).length === 1);
	for (const text of replies.reverse()) { next.s.message(text); next.s.message(text); }
	for (const text of next.s.queue.splice(0).reverse()) { next.r.message(text); next.r.message(text); }
	expect("one request runs once and resolves with its lost answer", await result === "running" && executions === 1);
	expect("both output streams arrive once, in order, before end", (await ended).code === 0 && output.join("|") === "1 first|2 second");
	expect("a write held over the break precedes EOF, once each", input.join("|") === "answer|EOF");

	const second = join(server, channel({ role: "runner" }), false);
	expect("a second socket cannot displace the live socket", second.s.closed && !next.s.closed);
	mock.timers.tick(ACK_MS);
	next.r.flush(); next.s.flush();
	expect("a quiet receiver sends its cumulative receipt", next.r.queue.length === 0 && runner.bufferedFrames <= 1 && server.bufferedFrames <= 1);
	server.close(); runner.close();
}

async function epochs(): Promise<void> {
	for (const who of ["server", "runner"] as const) {
		const reasons: string[] = [];
		const server = channel({ role: "server", onClose: (s) => reasons.push(s) });
		const runner = channel({ role: "runner", onClose: (s) => reasons.push(s) });
		const old = join(server, runner);
		const result = stopped(server.request(state));
		const ended = server.stream("process", () => {});
		old.r.drop();
		const next = channel({ role: who, onClose: (s) => reasons.push(s) });
		const { r, s } = join(who === "server" ? next : server, who === "runner" ? next : runner, false);
		r.flush();
		const welcome = s.queue[0];
		expect(`a changed ${who} epoch gets a fresh welcome before any saved work`, !!welcome && "fresh" in JSON.parse(welcome) && s.queue.length === 1);
		s.flush();
		const why = who === "runner" ? "runner restarted" : "server restarted";
		expect(`both peers stop on the changed ${who} epoch`, reasons.length === 2 && reasons.every((reason) => reason.includes(why)));
		if (who === "runner") expect("runner restart fails the waiting operation and ends its stream", (await result).includes(why) && (await ended).error?.message.includes(why) === true);
		server.close(); runner.close(); next.close();
		await result;
	}

	const server = channel({ role: "server" });
	const runner = channel({ role: "runner" });
	const first = join(server, runner, false);
	first.r.flush();
	first.s.drop(); // Even the first welcome can get lost.
	const next = join(server, runner);
	expect("a lost first welcome can be recovered", !!runner.resume?.serverEpoch && !next.s.closed);
	server.close(); runner.close();
}

async function stream(): Promise<void> {
	const received = createHash("sha256");
	const sent = createHash("sha256");
	const pauses: boolean[] = [];
	const size = 20 * 1024 * 1024;
	let bytes = 0, peakBytes = 0, peakFrames = 0, peakReordered = 0;
	const server = channel({ role: "server" });
	const runner = channel({ role: "runner", onFull: (paused) => pauses.push(paused) });
	let link = join(server, runner);
	const ended = server.stream("p", (_, data) => { received.update(data); bytes += Buffer.byteLength(data); });
	for (let offset = 0; offset < size; offset += MAX_OUTPUT_BYTES) {
		const data = String(offset).padEnd(MAX_OUTPUT_BYTES, "x");
		if (!runner.output("p", 1, data)) {
			expect("the source is paused with its unsent chunk still in hand", runner.paused);
			link.r.drop();
			link = join(server, runner, false);
			link.r.flush(); link.s.flush();
			for (const text of link.r.queue.splice(0).reverse()) {
				link.s.message(text);
				peakReordered = Math.max(peakReordered, server.reorderedBytes);
			}
			mock.timers.tick(ACK_MS);
			link.s.flush(); link.r.flush();
			if (!runner.output("p", 1, data)) throw new Error("sender did not resume");
		}
		sent.update(data);
		peakBytes = Math.max(peakBytes, runner.bufferedBytes);
		peakFrames = Math.max(peakFrames, runner.bufferedFrames);
	}
	runner.end("p", success);
	link.r.flush();
	expect("20 MiB arrives whole and in order across the drops", (await ended).code === 0 && bytes === size && received.digest("hex") === sent.digest("hex"), `${bytes} bytes`);
	expect("the replay buffer stays within both caps and the source resumes", peakBytes <= MAX_UNACKED_BYTES && peakFrames <= MAX_UNACKED_FRAMES && pauses.join() === "true,false,true,false", `peak ${peakBytes} bytes in ${peakFrames} frames`);
	expect("the receiver bounds a reversed window and releases it once the gap closes", peakReordered > 0 && peakReordered <= MAX_UNACKED_BYTES && server.reorderedBytes === 0, `peak ${peakReordered} bytes`);
	server.close(); runner.close();
}

function full(): void {
	let input = 0, output = 0;
	const server = channel({ role: "server" });
	const runner = channel({ role: "runner", onInput: () => input++ });
	const link = join(server, runner);
	void server.stream("p", () => output++);
	for (let i = 0; i < MAX_UNACKED_FRAMES - 1; i++) {
		if (!runner.output("p", 1, "x") || !server.write("p", "y")) throw new Error("paused early");
	}
	expect("a full frame window refuses the next write in either direction", !runner.output("p", 1, "x") && !server.write("p", "y") && runner.paused && server.paused);
	link.s.flush(); link.r.flush();
	mock.timers.tick(ACK_MS);
	expect("even when both pipes are full a receipt fits", Math.max(server.bufferedFrames, runner.bufferedFrames) <= MAX_UNACKED_FRAMES);
	link.s.flush(); link.r.flush();
	expect("the full pipes drain without losing a frame or deadlocking", input === MAX_UNACKED_FRAMES - 1 && output === input && !server.paused && !runner.paused);
	server.close(); runner.close();
}

async function files(): Promise<void> {
	const file = ('雪\u0000"\\😀').repeat(55_000);
	let saved = "";
	const server = channel({ role: "server" });
	const runner = channel({ role: "runner", onOperation(op) {
		if (op.name === "writeTextFile") { saved = op.args.content; runner.respond(op, null); }
		if (op.name === "readTextFile") runner.respond(op, saved);
	} });
	const link = join(server, runner);
	const put = server.request({ kind: "op", name: "writeTextFile", id: "write", args: { id: "box", path: "/workspace/a", content: file } });
	const get = server.request({ kind: "op", name: "readTextFile", id: "read", args: { id: "box", path: "/workspace/a" } });
	const bounded = (frames: string[]) => frames.length > 1 && frames.every((text) => Buffer.byteLength(text) <= MAX_FRAME_BYTES);
	const writes = bounded(link.s.queue);
	link.s.flush();
	const reads = bounded(link.r.queue);
	link.r.flush();
	expect("large file arguments and results fit the wire and preserve escaped and multibyte text", await put === null && await get === file && saved === file && writes && reads);
	server.close(); runner.close();
}

async function refusals(): Promise<void> {
	const server = channel({ role: "server", acceptHello: (h) => h.signature === hello.signature });
	const runner = channel({ role: "runner", onOperation(op) {
		if (op.name === "start") runner.refuse(op.id, { kind: "sandbox", message: "Could not start." });
		else if (op.name === "state") runner.respond(op, "paused");
	} });
	const link = join(server, runner);
	const ended = server.stream("failed", () => {});
	const refused = stopped(server.request({ kind: "op", name: "start", id: "failed", args: { id: "box", argv: ["true"] } }));
	link.s.flush(); link.r.flush();
	expect("a refused start settles its request and its process ending", (await refused) === "Could not start." && (await ended).error?.message === "Could not start.");
	link.r.drop();
	const waiting = server.request(state);
	const visitor = channel({ role: "runner" });
	const stray = join(server, visitor, false);
	const forged = JSON.parse(stray.r.queue.shift()!);
	stray.s.message(JSON.stringify({ ...forged, signature: "wrong" }));
	expect("a refused introduction cannot read saved work", stray.s.closed && stray.s.queue.length === 0);
	const again = join(server, runner);
	again.s.flush(); again.r.flush();
	expect("work survives a refused visitor and reaches the original runner", await waiting === "paused");
	const bad = stopped(server.request({ ...state, id: "wrong-type" }));
	again.s.message(JSON.stringify({ kind: "res", id: "wrong-type", ok: true, value: false, seq: runner.bufferedFrames + 100_000, ack: 1 }));
	expect("an impossible receive gap ends the conversation", (await bad).includes("Invalid") && again.s.closed);
	server.close(); runner.close(); visitor.close();
}

async function time(): Promise<void> {
	let expired = 0;
	const server = channel({ role: "server", onGraceExpired: () => expired++ });
	const runner = channel({ role: "runner" });
	const link = join(server, runner);
	mock.timers.tick(PING_MS);
	expect("the four-method socket sends a heartbeat after 15 seconds", link.s.queue.some((s) => JSON.parse(s).kind === "ack"));
	const result = stopped(server.request(state));
	mock.timers.tick(DEAD_MS - PING_MS);
	expect("45 seconds of silence detaches the socket", link.s.closed);
	mock.timers.tick(RUNNER_GRACE_MS - 1);
	expect("the full grace is available after the socket dies", expired === 0);
	join(server, runner, false); // A half-open replacement earns no extra time.
	mock.timers.tick(1);
	expect("the grace expires once and fails the waiting request", expired === 1 && (await result).includes("grace"));
	const count = link.s.queue.length;
	server.close(); runner.close();
	mock.timers.tick(2 * RUNNER_GRACE_MS);
	expect("closed channels send nothing and never expire again", expired === 1 && link.s.queue.length === count);

	const a = channel({ role: "server" }), b = channel({ role: "runner" });
	const { s } = join(a, b);
	const timed = stopped(a.request({ kind: "op", name: "ask", id: "time", args: { id: "box", argv: ["true"], options: { timeoutMs: 70 } } }));
	for (let ms = 0; ms < RUNNER_GRACE_MS; ms += PING_MS) {
		mock.timers.tick(PING_MS);
		s.flush(); s.peer.flush();
	}
	mock.timers.tick(70);
	expect("an unanswered request with a timeout has its timeout plus the grace", (await timed).includes("timed out"));
	a.close(); b.close();
}

function versionAndPong(): void {
	const server = channel({ role: "server" });
	const runner = channel({ role: "runner" });
	const old = join(server, runner, false);
	const frame = JSON.parse(old.r.queue.shift()!);
	old.s.message(JSON.stringify({ ...frame, protocol: 0 }));
	const welcome = parseFrame(old.s.queue[0]);
	expect("an older protocol gets an update refusal in welcome", welcome?.kind === "welcome" && !!welcome.refused?.includes("Update") && old.s.closed);
	server.close(); runner.close();

	let pings = 0;
	let pong = () => {};
	const a = channel({ role: "server" }), b = channel({ role: "runner" });
	const s = Object.assign(new Wire(), { ping: () => { pings++; pong(); }, onPong: (fn: () => void) => { pong = fn; } });
	const r = new Wire();
	s.peer = r; r.peer = s;
	a.attach(s); b.attach(r, hello); r.flush(); s.flush();
	for (let i = 0; i < 4; i++) { mock.timers.tick(PING_MS); s.flush(); r.flush(); }
	expect("native pongs keep an otherwise quiet receiving socket alive", pings === 4 && !s.closed);
	a.close(); b.close();
}

function timerCleanup(): void {
	const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	const before = timers();
	const a = channel({ role: "server" }), b = channel({ role: "runner" });
	const link = join(a, b);
	void stopped(a.request(state, undefined, 100_000));
	link.r.drop();
	a.close(); b.close();
	expect("closing clears the real heartbeat, grace and request timers", timers() === before);
}

function malformed(): void {
	const header = { seq: 2, ack: 1 };
	const bad = (body: unknown) => JSON.stringify({ ...header, ...(body as object) });
	const inputs = [
		null, {}, new Uint8Array(3), "[]", "{", "null", "0", bad({ kind: "__proto__" }), bad({ kind: "ack", seq: 1.1 }), bad({ kind: "ack", ack: -1 }),
		bad({ kind: "ack", seq: Number.MAX_SAFE_INTEGER + 1 }), bad({ ...state, name: "toString" }), bad({ ...state, args: { id: 3 } }),
		bad({ kind: "op", name: "run", id: "1", args: { id: "box", command: "true", options: { signal: {}, secretEnv: [] } } }),
		bad({ kind: "res", ok: false, id: "1", error: { kind: "other", message: "x" } }), bad({ kind: "res", ok: true, id: "1", value: { unknown: true } }),
		bad({ kind: "end", id: "1", code: "0", signal: null, error: null }), bad({ kind: "close-in", id: "1", extra: true }),
		bad({ kind: "out", id: "1", fd: 3, data: "x" }), bad({ kind: "out", id: "1", fd: 1, data: "é".repeat(32769) }),
		bad({ kind: "in", id: "1", data: "雪".repeat(50_000) }), " ".repeat(MAX_FRAME_BYTES + 1),
		bad({ kind: "hello", ...hello, protocol: 1, runnerEpoch: "r", resume: null }),
	];
	expect("hostile frames are refused without throwing, including oversized UTF-8", inputs.every((v) => parseFrame(v) === null), `${inputs.length} cases`);
	const raw = { ...header, kind: "in", id: "p", data: "" };
	const padded = JSON.stringify({ ...raw, data: "x".repeat(MAX_FRAME_BYTES - JSON.stringify(raw).length) });
	expect("exactly 128 KiB fits, one more byte does not", !!parseFrame(padded) && !parseFrame(padded + " "));
	const server = channel({ role: "server" }), runner = channel({ role: "runner" });
	const link = join(server, runner);
	link.s.message(bad({ kind: "ack", ack: 123 }));
	expect("a receipt for unsent work closes the conversation", link.s.closed);
	server.close(); runner.close();
}

async function main(): Promise<void> {
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
	try {
		await replay(); await epochs(); await stream(); full(); await files(); await refusals(); await time(); versionAndPong(); malformed();
	} finally {
		for (const ch of channels) ch.close();
		mock.timers.reset();
	}
	timerCleanup();
	console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
	process.exitCode = failures ? 1 : 0;
}
// An unresolved promise alone would let Node exit successfully before the last check.
const watchdog = setTimeout(() => { console.error("FAIL  check did not finish"); process.exit(1); }, 30_000);
main().catch((error: Error) => { console.error(`FAIL  ${error.message}`); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
