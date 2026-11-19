/**
 * A session's conversation with a runner, carried over whichever socket is current.
 *
 * The server names a conversation in `welcome`, and each side keeps it in memory only: the session
 * actor's instance on one end, the runner process on the other. Within one, every message is numbered
 * per direction, kept by its sender until acknowledged and sent again on the next socket, and taken
 * once by its receiver, so a socket that drops loses nothing and runs nothing twice. When one side no
 * longer has the conversation the other names (the actor slept or moved, the runner restarted, either
 * side waited out the grace), both let it go: what was outstanding fails on the server and is left to
 * the orphan rule on the runner, and a new conversation starts on the same socket. Nothing is carried
 * into a new conversation, so an operation runs at most once, and on a lost conversation the server
 * cannot know whether it ran.
 *
 * A replaced socket is not listened to, so frames arrive in order and a gap means a broken peer.
 * Every method is synchronous: an actor's actions and socket handlers interleave around the channel,
 * never inside it.
 */
import { SandboxUserError } from "../sandbox/api.js";
import type { ProcessEnd } from "../sandbox/provider.js";
import {
	ACK_MS, DEAD_MS, MAX_FRAME_BYTES, MAX_MESSAGE_BYTES, MAX_OPS_IN_FLIGHT, OP_MS, PING_MS, PROTOCOL_VERSION, RUNNER_GRACE_MS, WINDOW_BYTES, WINDOW_FRAMES,
	isName, parseBody, parseFrame, protocolRefusal, validArgs, validValue,
	type Args, type Body, type Failure, type Frame, type Hello, type Name, type Operation, type Value, type Welcome,
} from "./protocol.js";

/** What either side's WebSocket has to offer: RivetKit's raw socket in an actor, the standard one in the runner. */
export interface ChannelSocket {
	send(text: string): void;
	close(): void;
	onMessage(listener: (data: unknown) => void): void;
	onClose(listener: () => void): void;
}

/** The conversation an operation was sent in has ended: whether it ran is unknown. */
export class ConversationLost extends Error {}

type Output = (fd: 1 | 2, data: string) => void;
interface Options {
	/** The conversation ended with `reason`; everything outstanding in it has been let go. */
	onReset?(reason: string): void;
}
/** A UTF-16 unit takes at most 6 bytes once escaped into a part's string. */
const PART_UNITS = MAX_FRAME_BYTES / 8;

abstract class Channel {
	protected socket: ChannelSocket | null = null;
	protected conversation: string | null = null;
	protected closed = false;
	private sent = 0;
	private acked = 0;
	private received = 0;
	private told = 0;
	private backlog = new Map<number, { text: string; bytes: number }>();
	private bytes = 0;
	private parts: string[] = [];
	private partBytes = 0;
	private heard = 0;
	private spoke = 0;
	private waiting = false;
	private strangers = new Map<ChannelSocket, ReturnType<typeof setTimeout>>();
	private clock?: ReturnType<typeof setInterval>;
	private grace?: ReturnType<typeof setTimeout>;

	constructor(private readonly base: Options & { onDrain?(): void }, private readonly graceReason: string) {}

	get connected(): boolean { return this.socket !== null; }
	/** What is held for the peer until it acknowledges it. */
	get buffered(): { bytes: number; frames: number } { return { bytes: this.bytes, frames: this.backlog.size }; }

	protected abstract deliver(body: Body): void;
	/** Lets go of everything outstanding in the conversation. */
	protected abstract drop(reason: string): void;

	/** The owner lets go of the socket; the conversation waits for the next one, up to the grace. */
	detach(): void {
		const socket = this.socket;
		this.socket = null;
		clearInterval(this.clock);
		if (!this.grace && !this.closed && this.conversation) this.grace = setTimeout(() => { this.grace = undefined; this.reset(this.graceReason); }, RUNNER_GRACE_MS);
		socket?.close();
	}

	close(reason = "The runner channel is closed."): void {
		if (this.closed) return;
		this.reset(reason);
		this.closed = true;
		this.detach();
		this.dismiss();
	}

	/** Listens to a socket that has yet to introduce itself: its first frame goes to `introduce`, within DEAD_MS. */
	protected watch(socket: ChannelSocket, introduce: (frame: Frame) => void): void {
		this.strangers.set(socket, setTimeout(() => this.dismiss(socket), DEAD_MS));
		socket.onMessage((data) => {
			if (this.closed) return;
			if (this.socket === socket) { this.receive(parseFrame(data)); return; }
			if (!this.strangers.has(socket)) return;
			clearTimeout(this.strangers.get(socket));
			this.strangers.delete(socket);
			const frame = parseFrame(data);
			if (frame) introduce(frame);
			else socket.close();
		});
		socket.onClose(() => {
			if (this.socket === socket) this.detach();
			else this.dismiss(socket);
		});
	}

	/** Closes sockets that have not been adopted: one, or all of them. */
	protected dismiss(socket?: ChannelSocket): void {
		for (const s of socket ? [socket] : [...this.strangers.keys()]) {
			const timer = this.strangers.get(s);
			if (timer === undefined) continue;
			clearTimeout(timer);
			this.strangers.delete(s);
			s.close();
		}
	}

	protected resumable(peerReceived: number): boolean {
		return peerReceived >= this.acked && peerReceived <= this.sent;
	}
	protected get delivered(): number { return this.received; }

	/** Makes `socket` the current one, after the introduction, and sends what the peer has not received. */
	protected adopt(socket: ChannelSocket, introduction: Hello | Welcome | null, peerReceived: number): void {
		const old = this.socket;
		this.socket = socket;
		old?.close();
		clearTimeout(this.grace);
		this.grace = undefined;
		clearInterval(this.clock);
		this.clock = setInterval(() => this.tick(), ACK_MS);
		this.heard = Date.now();
		if (introduction) this.transmit(JSON.stringify(introduction));
		this.told = this.received;
		this.release(peerReceived);
		for (const frame of this.backlog.values()) this.transmit(frame.text);
	}

	/** Queues a message, in one frame or several. Throws when it is larger than MAX_MESSAGE_BYTES. */
	protected send(body: Body): void {
		const json = JSON.stringify(body);
		if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) throw new Error("The message is larger than the runner channel carries.");
		const whole = JSON.stringify({ kind: "msg", seq: this.sent + 1, ack: this.received, body });
		if (Buffer.byteLength(whole) <= MAX_FRAME_BYTES) { this.push(whole); return; }
		for (let at = 0; at < json.length; at += PART_UNITS) {
			const data = json.slice(at, at + PART_UNITS);
			this.push(JSON.stringify({ kind: "part", seq: this.sent + 1, ack: this.received, data, last: at + PART_UNITS >= json.length }));
		}
	}

	/** Whether a stream's source may go on; when not, `onDrain` says when it may again. */
	protected room(): boolean {
		if (this.bytes < WINDOW_BYTES && this.backlog.size < WINDOW_FRAMES) return true;
		this.waiting = true;
		return false;
	}

	/** Ends the conversation (a lost peer, the grace, a broken message); the socket, if any, stays. */
	protected reset(reason: string): void {
		const had = this.conversation !== null;
		this.drop(reason);
		this.conversation = null;
		this.sent = this.acked = this.received = this.told = this.bytes = this.partBytes = 0;
		this.backlog.clear();
		this.parts = [];
		this.waiting = false;
		clearTimeout(this.grace);
		this.grace = undefined;
		if (had) this.base.onReset?.(reason);
	}

	/** The peer broke the protocol: nothing it says can be trusted, so the conversation ends with the socket. */
	protected fail(reason: string): void {
		this.reset(reason);
		this.detach();
	}

	private push(text: string): void {
		const bytes = Buffer.byteLength(text);
		this.backlog.set(++this.sent, { text, bytes });
		this.bytes += bytes;
		this.told = this.received;
		if (this.socket) this.transmit(text);
	}

	private transmit(text: string): void {
		try {
			this.socket?.send(text);
			this.spoke = Date.now();
		} catch { this.detach(); }
	}

	private release(ack: number): void {
		if (ack <= this.acked) return;
		this.acked = ack;
		for (const [seq, frame] of this.backlog) {
			if (seq > ack) break;
			this.bytes -= frame.bytes;
			this.backlog.delete(seq);
		}
		if (this.waiting && this.bytes < WINDOW_BYTES && this.backlog.size < WINDOW_FRAMES) {
			this.waiting = false;
			this.base.onDrain?.();
		}
	}

	private receive(frame: Frame | null): void {
		this.heard = Date.now();
		if (!frame || (frame.kind !== "msg" && frame.kind !== "part" && frame.kind !== "ack")) return this.fail("The other side sent a frame this conversation does not have.");
		if (frame.ack > this.sent) return this.fail("The other side acknowledged what was never sent.");
		this.release(frame.ack);
		if (frame.kind === "ack" || frame.seq <= this.received) return;
		if (frame.seq !== this.received + 1) return this.fail("A frame is missing.");
		this.received = frame.seq;
		if (frame.kind === "msg") {
			if (this.parts.length) return this.fail("A message ended before its last part.");
			return this.deliver(frame.body);
		}
		this.partBytes += Buffer.byteLength(frame.data);
		if (this.partBytes > MAX_MESSAGE_BYTES) return this.fail("A message is larger than the runner channel carries.");
		this.parts.push(frame.data);
		if (!frame.last) return;
		const body = parseBody(this.parts.join(""));
		this.parts = [];
		this.partBytes = 0;
		if (!body) return this.fail("A message could not be read.");
		this.deliver(body);
	}

	private tick(): void {
		const now = Date.now();
		if (now - this.heard >= DEAD_MS) { this.detach(); return; }
		if (this.received > this.told || now - this.spoke >= PING_MS) {
			this.told = this.received;
			this.transmit(JSON.stringify({ kind: "ack", ack: this.received }));
		}
	}
}

type Pending = { name: Name; resolve(value: unknown): void; reject(error: Error): void; output?: Output; timer: ReturnType<typeof setTimeout>; forget(): void };
type Process = { output: Output; finish(end: ProcessEnd): void; open: boolean };

/** The session actor's end. It lives as long as the actor's instance, in `c.vars`. */
export class ServerChannel extends Channel {
	private pending = new Map<string, Pending>();
	private processes = new Map<string, Process>();

	/** `accept` checks a hello's ticket and signature before it can resume anything. */
	constructor(private readonly options: Options & { accept(hello: Hello): boolean }) {
		super(options, "The machine did not come back within ten minutes.");
	}

	/** A socket from the gateway. It counts once its hello is accepted; one that says nothing goes after DEAD_MS. */
	attach(socket: ChannelSocket): void {
		if (this.closed) { socket.close(); return; }
		this.watch(socket, (hello) => {
			if (hello.kind === "foreign") {
				try { socket.send(JSON.stringify({ kind: "welcome", protocol: PROTOCOL_VERSION, refused: protocolRefusal(hello.protocol) })); } catch {}
				socket.close();
				return;
			}
			if (hello.kind !== "hello" || !this.accepts(hello)) { socket.close(); return; }
			const resumes = hello.resume !== null && hello.resume.conversation === this.conversation && this.resumable(hello.resume.received);
			// Only the runner that holds the conversation may replace a live socket: it has given up on that one.
			if (this.socket && !resumes) { socket.close(); return; }
			if (!resumes) {
				if (this.conversation) this.reset("The machine's runner restarted, or gave up on this session's work after a long disconnection.");
				this.conversation = crypto.randomUUID();
			}
			const welcome: Welcome = { kind: "welcome", protocol: PROTOCOL_VERSION, conversation: this.conversation!, received: this.delivered, resumed: resumes };
			this.adopt(socket, welcome, resumes ? hello.resume!.received : 0);
		});
	}

	private accepts(hello: Hello): boolean {
		try { return this.options.accept(hello); } catch { return false; }
	}

	/** Rejects with ConversationLost when the conversation ends first, and with an Error for the runner's own failure. */
	request<N extends Exclude<Name, "start">>(name: N, args: Args<N>, options: { onOutput?: Output; signal?: AbortSignal } = {}): Promise<Value<N>> {
		return this.call(crypto.randomUUID(), name, args, options) as Promise<Value<N>>;
	}

	/** `ended` never rejects: a process that could not be started has ended with an error. */
	start(args: Args<"start">, onOutput: Output): { id: string; ended: Promise<ProcessEnd> } {
		const id = crypto.randomUUID();
		const ended = new Promise<ProcessEnd>((finish) => this.processes.set(id, { output: onOutput, finish, open: true }));
		this.call(id, "start", args, {}).catch((error: Error) => this.finish(id, { code: null, signal: null, error }));
		return { id, ended };
	}

	/** False once the process has ended or its stdin was closed, as `SandboxProcess.write`. */
	write(process: string, data: string): boolean {
		const p = this.processes.get(process);
		if (!p?.open) return false;
		this.send({ kind: "in", id: process, data });
		return true;
	}

	closeIn(process: string): void {
		const p = this.processes.get(process);
		if (!p?.open) return;
		p.open = false;
		this.send({ kind: "close-in", id: process });
	}

	private call(id: string, name: Name, args: unknown, { onOutput, signal }: { onOutput?: Output; signal?: AbortSignal }): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new ConversationLost("The runner channel is closed."));
			if (!validArgs(name, args)) return reject(new Error(`Invalid arguments for the runner's ${name}.`));
			if (this.pending.size >= MAX_OPS_IN_FLIGHT) return reject(new Error("Too many operations are waiting on the machine."));
			const own = (args as { options?: { timeoutMs?: number } }).options?.timeoutMs;
			const timer = setTimeout(() => this.settle(id, new ConversationLost("The machine did not answer in time.")), (own ?? OP_MS) + RUNNER_GRACE_MS);
			const cancel = () => { if (this.pending.has(id)) this.send({ kind: "cancel", id }); };
			signal?.addEventListener("abort", cancel, { once: true });
			this.pending.set(id, { name, resolve, reject, output: onOutput, timer, forget: () => signal?.removeEventListener("abort", cancel) });
			try { this.send({ kind: "op", id, name, args: args as Record<string, unknown> }); }
			catch (error) { this.settle(id, error as Error); return; }
			if (signal?.aborted) cancel();
		});
	}

	private settle(id: string, outcome: { value: unknown } | Error): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		p.forget();
		if (outcome instanceof Error) p.reject(outcome);
		else p.resolve(outcome.value);
	}

	private finish(id: string, end: ProcessEnd): void {
		const p = this.processes.get(id);
		if (!p) return;
		this.processes.delete(id);
		p.finish(end);
	}

	protected deliver(body: Body): void {
		switch (body.kind) {
			case "res": {
				const p = this.pending.get(body.id);
				if (!p) return; // It stopped waiting.
				if (!body.ok) return this.settle(body.id, body.error.kind === "user" ? new SandboxUserError(body.error.message) : new Error(body.error.message));
				if (!validValue(p.name, body.value)) return this.settle(body.id, new Error(`The machine's answer to ${p.name} could not be read.`));
				return this.settle(body.id, { value: body.value });
			}
			case "out":
				(this.processes.get(body.id)?.output ?? this.pending.get(body.id)?.output)?.(body.fd, body.data);
				return;
			case "end":
				return this.finish(body.id, { code: body.code, signal: body.signal, error: body.error === null ? null : new Error(body.error) });
			default:
				return this.fail("The machine's runner sent a message that only the platform sends.");
		}
	}

	protected drop(reason: string): void {
		for (const id of [...this.pending.keys()]) this.settle(id, new ConversationLost(reason));
		for (const id of [...this.processes.keys()]) this.finish(id, { code: null, signal: null, error: new ConversationLost(reason) });
	}
}

/** The runner's end, one per session it serves. */
export class RunnerChannel extends Channel {
	private serving = new Map<string, Name>();
	private processes = new Set<string>();

	/**
	 * `onOperation` must answer each operation once with `respond` or `refuse`, and a `start` before
	 * that process's output; `onReset` must stop what the ended conversation had running (the orphan rule).
	 */
	constructor(private readonly options: Options & {
		onOperation(op: Operation): void;
		onInput(process: string, data: string): void;
		onCloseIn(process: string): void;
		/** The abort signal of a `run` in progress. */
		onCancel(id: string): void;
		/** A stream's source may go on after `output` said to wait. */
		onDrain(): void;
		/** The platform will not talk to this runner: the sentence says why. Reconnecting will not help. */
		onRefused(reason: string): void;
	}) {
		super(options, "The platform did not come back within ten minutes.");
	}

	/** A new socket, opened because the last one was given up on. Its ticket and signature are new. */
	attach(socket: ChannelSocket, identity: Pick<Hello, "runnerVersion" | "machineId" | "ticket" | "signature">): void {
		if (this.closed) { socket.close(); return; }
		this.detach();
		this.dismiss();
		const asked = this.conversation;
		const hello: Hello = { kind: "hello", protocol: PROTOCOL_VERSION, ...identity, resume: asked ? { conversation: asked, received: this.delivered } : null };
		const text = JSON.stringify(hello);
		if (parseFrame(text)?.kind !== "hello") throw new Error("Invalid runner identity.");
		this.watch(socket, (welcome) => {
			if (welcome.kind !== "welcome") { socket.close(); return; }
			if ("refused" in welcome) { socket.close(); this.options.onRefused(welcome.refused); return; }
			if (welcome.resumed) {
				if (welcome.conversation !== asked || asked !== this.conversation || !this.resumable(welcome.received)) {
					return this.fail("The platform resumed a conversation this runner does not have.");
				}
				return this.adopt(socket, null, welcome.received);
			}
			if (this.conversation) this.reset("The platform no longer has this session's work: its server restarted, or gave up after a long disconnection.");
			this.conversation = welcome.conversation;
			this.adopt(socket, null, 0);
		});
		try { socket.send(text); } catch { socket.close(); }
	}

	/** Throws for a value that is not the operation's result: that is the runner's own mistake. */
	respond<O extends Operation>(op: O, value: Value<O["name"]>): void {
		const name = this.serving.get(op.id);
		if (!name) return; // Its conversation has ended.
		if (!validValue(name, value)) throw new Error(`Invalid result for ${name}.`);
		this.serving.delete(op.id);
		if (name === "start") this.processes.add(op.id);
		try { this.send({ kind: "res", id: op.id, ok: true, value }); }
		catch { this.send({ kind: "res", id: op.id, ok: false, error: { kind: "sandbox", message: `The answer to ${name} is larger than a runner can send.` } }); }
	}

	refuse(op: Operation, error: Failure): void {
		if (this.serving.delete(op.id)) this.send({ kind: "res", id: op.id, ok: false, error });
	}

	/** Output of a `run` in progress or of a started process. False: stop reading until `onDrain`. */
	output(id: string, fd: 1 | 2, data: string): boolean {
		if (!this.serving.has(id) && !this.processes.has(id)) return true;
		this.send({ kind: "out", id, fd, data });
		return this.room();
	}

	end(process: string, end: ProcessEnd): void {
		if (this.processes.delete(process)) this.send({ kind: "end", id: process, code: end.code, signal: end.signal, error: end.error?.message ?? null });
	}

	protected deliver(body: Body): void {
		switch (body.kind) {
			case "op": {
				if (this.serving.has(body.id) || this.processes.has(body.id)) return this.fail("The platform used an operation id twice.");
				const refusal = !isName(body.name) || !validArgs(body.name, body.args) ? "This runner does not serve that operation."
					: this.serving.size >= MAX_OPS_IN_FLIGHT ? "Too many operations are waiting on this machine." : null;
				if (refusal) return this.send({ kind: "res", id: body.id, ok: false, error: { kind: "refused", message: refusal } });
				this.serving.set(body.id, body.name as Name);
				return this.options.onOperation(body as Operation);
			}
			case "in":
				if (this.processes.has(body.id)) this.options.onInput(body.id, body.data);
				return;
			case "close-in":
				if (this.processes.has(body.id)) this.options.onCloseIn(body.id);
				return;
			case "cancel":
				if (this.serving.has(body.id)) this.options.onCancel(body.id);
				return;
			default:
				return this.fail("The platform sent a message that only a runner sends.");
		}
	}

	protected drop(): void {
		this.serving.clear();
		this.processes.clear();
	}
}
