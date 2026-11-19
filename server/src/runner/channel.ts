/**
 * Sequence 1 introduces an epoch. A new socket repeats that introduction with today's receipt;
 * only a matching pair of epochs can replay work. A replaced socket has no say in this one.
 * A receipt covers a contiguous prefix. A gap waits, a duplicate has no effect, and an operation
 * and its answer each take effect once, even when the socket broke between them.
 * The sender owns each frame until its receipt. A send that cannot fit takes nothing: the caller
 * stops its source and retries on onFull(false). There is always room for a receipt in each direction.
 * Losing a socket starts one grace period. Closing the channel settles its waiters and stops its clocks.
 */
import type { ProcessEnd } from "../sandbox/provider.js";
import {
	ACK_MS, DEAD_MS, MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, MAX_UNACKED_BYTES, MAX_UNACKED_FRAMES, PING_MS, PROTOCOL_VERSION, RUNNER_GRACE_MS,
	parseFrame, validArgs, validResult, type Body, type Ending, type Failure, type Fragment, type Frame, type Hello,
	type Name, type Operation, type Operations, type Resume, type Welcome,
} from "./protocol.js";

export interface ChannelSocket {
	send(text: string): void;
	onMessage(listener: (text: unknown) => void): void;
	onClose(listener: () => void): void;
	close(): void;
	/** Raw Rivet sockets expose neither; on those the heartbeat is an ack. */
	ping?(): void;
	onPong?(listener: () => void): void;
}

type Identity = Pick<Hello, "runnerVersion" | "machineId" | "signature" | "ticket">;
type OutputListener = (fd: 1 | 2, data: string) => void;
interface Options {
	role: "runner" | "server";
	epoch?: string;
	onOperation?(op: Operation): void;
	onInput?(id: string, data: string): void;
	onCloseIn?(id: string): void;
	onFull?(paused: boolean): void;
	onGraceExpired?(): void;
	onClose?(reason: string): void;
	onWelcome?(answer: Welcome): void;
	/** The owner checks the ticket and signature before any saved work is sent. */
	acceptHello?(hello: Hello): boolean;
}
type Sent = { text: string; bytes: number };
type Waiting = { name: Name; resolve(value: unknown): void; reject(error: Error): void; output?: OutputListener; timer?: ReturnType<typeof setTimeout> };
const RECEIPT_BYTES = 128;
const FULL = "The runner channel is full. Retry when the sender resumes.";

function frameText(body: Body, seq: number, ack: number): Sent {
	const text = JSON.stringify({ ...body, seq, ack });
	return { text, bytes: Buffer.byteLength(text) };
}

/** Keep both halves of a character in the same message. */
function split(text: string, at: number): [string, string] {
	if (at > 0 && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff) at--;
	return [text.slice(0, at), text.slice(at)];
}

export class ReliableChannel {
	readonly epoch: string;
	private peer: string | null = null;
	private socket: ChannelSocket | null = null;
	private ready = false;
	private closed = false;
	private joined = false;
	private sent = 1;
	private transmitted = 0;
	private received = 0;
	private acknowledged = 0;
	private backlog = new Map<number, Sent>();
	private bytes = 0;
	private gaps = new Map<number, { frame: Frame; bytes: number }>();
	private gapBytes = 0;
	private piece: { first: Fragment; texts: string[]; bytes: number } | null = null;
	private pending = new Map<string, Waiting>();
	private streams = new Map<string, { output: OutputListener; finish(end: ProcessEnd): void }>();
	private blocked: { bytes: number; count: number } | null = null;
	private receipt = 0;
	private lastRead = 0;
	private lastPing = 0;
	private receiptDue = false;
	private clock?: ReturnType<typeof setInterval>;
	private grace?: ReturnType<typeof setTimeout>;
	private deadline = 0;

	constructor(private readonly options: Options) {
		this.epoch = options.epoch ?? crypto.randomUUID();
	}

	get bufferedBytes(): number { return this.bytes; }
	get bufferedFrames(): number { return this.backlog.size; }
	/** Out-of-order input stays here until its missing prefix arrives. */
	get reorderedBytes(): number { return this.gapBytes; }
	get paused(): boolean { return this.blocked !== null; }
	get resume(): Resume | null {
		return this.options.role === "runner" && this.joined ? { runnerEpoch: this.epoch, serverEpoch: this.peer, lastReceived: this.received } : null;
	}

	/** The runner supplies a new signature and ticket for each socket. The server waits for hello. */
	attach(socket: ChannelSocket, identity?: Identity): void {
		if (this.deadline && Date.now() >= this.deadline) this.expire();
		if (this.closed || this.socket) { socket.close(); return; }
		const runner = this.options.role === "runner";
		if (runner && !identity) throw new Error("A runner socket needs a hello.");
		this.socket = socket;
		this.lastRead = this.lastPing = Date.now();
		this.clock = setInterval(() => this.tick(), ACK_MS);
		socket.onClose(() => { if (this.socket === socket) this.detach(Math.min(Date.now(), this.lastRead + DEAD_MS)); });
		socket.onMessage((text) => {
			if (this.socket !== socket || this.silent()) return;
			const frame = parseFrame(text);
			if (!frame) { this.invalid(); return; }
			this.lastRead = Date.now();
			try { this.receive(frame, Buffer.byteLength(text as string)); }
			catch { this.invalid(); }
		});
		socket.onPong?.(() => { if (this.socket === socket && !this.silent()) this.lastRead = Date.now(); });
		if (runner) {
			const hello: Hello = { ...identity!, kind: "hello", protocol: PROTOCOL_VERSION, runnerEpoch: this.epoch, resume: this.resume };
			this.joined = true;
			this.introduce(hello);
		}
	}

	private invalid(): void {
		// An unrecognised visitor cannot end work waiting for the real runner.
		if (!this.ready && this.options.role === "server") this.detach();
		else this.close("Invalid runner conversation.");
	}

	private introduce(body: Hello | Welcome): void {
		const frame = frameText(body, 1, this.received);
		if (!parseFrame(frame.text)) { this.close("Invalid runner introduction."); return; }
		this.send(frame.text, 1);
	}

	private handshake(frame: Frame): void {
		const through = this.sent;
		let welcome: Welcome | undefined;
		if (frame.kind === "hello" && this.options.role === "server") {
			if (this.options.acceptHello && !this.options.acceptHello(frame)) {
				this.detach();
				return;
			}
			const restarted = this.peer !== null && this.peer !== frame.runnerEpoch;
			const lost = frame.resume?.serverEpoch != null && frame.resume.serverEpoch !== this.epoch;
			const refused = frame.protocol !== PROTOCOL_VERSION ? "Update the machine's runner to a version that speaks protocol 1."
				: restarted ? "The machine's runner restarted during the turn." : undefined;
			const fresh = !this.peer || lost || !!refused;
			if (!lost && !refused) this.checkReceipt(frame.ack);
			this.received = Math.max(this.received, 1);
			this.peer = frame.runnerEpoch;
			const owned = new Set([...this.pending.keys(), ...this.streams.keys()]);
			const answer: Welcome = { kind: "welcome", serverEpoch: this.epoch, lastReceived: this.received, ...(fresh ? { fresh: true } : { keep: [...owned] }), refused };
			if (refused || lost) {
				this.introduce(answer);
				this.close(refused ?? "The session's server restarted.");
				return;
			}
			welcome = answer;
		} else if (frame.kind === "welcome" && this.options.role === "runner") {
			this.options.onWelcome?.(frame);
			if (frame.refused || (this.peer && (frame.serverEpoch !== this.peer || "fresh" in frame))) {
				this.close(frame.refused ?? "The session's server restarted.");
				return;
			}
			this.checkReceipt(frame.ack);
			this.received = Math.max(this.received, 1);
			this.peer = frame.serverEpoch;
		} else throw new Error();
		if (!this.socket || this.closed) return;
		clearTimeout(this.grace);
		this.deadline = 0;
		this.ready = true;
		if (welcome) this.introduce(welcome);
		// Only these frames predate the join. A producer woken by this receipt sends its own.
		this.acknowledge(frame.ack);
		for (const [seq, held] of this.backlog) {
			if (!this.ready || seq > through) break;
			this.send(held.text, seq);
		}
	}

	private checkReceipt(ack: number): void {
		if (ack > this.transmitted || ack < this.acknowledged) throw new Error();
	}

	private receive(frame: Frame, bytes: number): void {
		if (!this.ready) { this.handshake(frame); return; }
		if (frame.ack > this.transmitted) throw new Error();
		if (frame.kind === "hello" || frame.kind === "welcome") {
			// The transport may deliver the same introduction twice.
			if (frame.kind === "hello" ? frame.runnerEpoch !== this.peer : frame.serverEpoch !== this.peer) throw new Error();
		} else if (frame.seq === 1) throw new Error();
		this.acknowledge(frame.ack);
		if (frame.seq <= this.received) return;
		if (frame.seq > this.received + 1) {
			if (!this.gaps.has(frame.seq)) {
				if (frame.seq - this.received > MAX_UNACKED_FRAMES || this.gaps.size >= MAX_UNACKED_FRAMES || this.gapBytes + bytes > MAX_UNACKED_BYTES) throw new Error();
				this.gaps.set(frame.seq, { frame, bytes });
				this.gapBytes += bytes;
			}
			return;
		}
		for (;;) {
			this.received = frame.seq;
			if (frame.kind !== "ack") this.receiptDue = true;
			this.deliver(frame);
			const next = this.gaps.get(this.received + 1);
			if (!next || this.closed) break;
			this.gaps.delete(next.frame.seq);
			this.gapBytes -= next.bytes;
			frame = next.frame;
		}
	}

	private deliver(body: Body): void {
		if ("part" in body) {
			this.fragment(body);
			return;
		}
		if (this.piece && body.kind !== "ack") throw new Error();
		switch (body.kind) {
			case "op":
				if (this.options.role !== "runner") throw new Error();
				this.options.onOperation?.(body);
				break;
			case "res": {
				if (this.options.role !== "server") throw new Error();
				const waiting = this.pending.get(body.id);
				if (!waiting) return;
				if (body.ok && (!validResult(waiting.name, body.value) || (waiting.name === "start" && (body.value as { id: string }).id !== body.id))) throw new Error();
				clearTimeout(waiting.timer);
				this.pending.delete(body.id);
				if (body.ok) waiting.resolve(body.value);
				else waiting.reject(Object.assign(new Error(body.error.message), { kind: body.error.kind }));
				break;
			}
			case "out":
				if (this.options.role !== "server") throw new Error();
				(this.streams.get(body.id)?.output ?? this.pending.get(body.id)?.output)?.(body.fd, body.data);
				break;
			case "end":
				if (this.options.role !== "server") throw new Error();
				this.streams.get(body.id)?.finish({ code: body.code, signal: body.signal, error: body.error === null ? null : new Error(body.error) });
				this.streams.delete(body.id);
				break;
			case "in":
				if (this.options.role !== "runner") throw new Error();
				this.options.onInput?.(body.id, body.data);
				break;
			case "close-in":
				if (this.options.role !== "runner") throw new Error();
				this.options.onCloseIn?.(body.id);
				break;
		}
	}

	private fragment(body: Fragment): void {
		const piece = this.piece ??= { first: body, texts: [], bytes: 0 };
		const first = piece.first;
		if (body.kind !== first.kind || body.id !== first.id || (first.kind === "op" && body.kind === "op" && first.name !== body.name)) throw new Error();
		const text = body.kind === "op" ? body.args : body.value;
		piece.bytes += Buffer.byteLength(text);
		if (!text.length || piece.bytes > MAX_UNACKED_BYTES || piece.texts.length >= MAX_UNACKED_FRAMES) throw new Error();
		piece.texts.push(text);
		if (body.part === "more") return;
		this.piece = null;
		const value: unknown = JSON.parse(piece.texts.join(""));
		if (body.kind === "op") {
			if (!validArgs(body.name, value)) throw new Error();
			this.deliver({ kind: "op", id: body.id, name: body.name, args: value } as Operation);
		} else this.deliver({ kind: "res", id: body.id, ok: true, value });
	}

	private acknowledge(ack: number): void {
		if (ack <= this.acknowledged) return;
		this.acknowledged = ack;
		for (const [seq, entry] of this.backlog) {
			if (seq > ack) break;
			this.bytes -= entry.bytes;
			this.backlog.delete(seq);
		}
		if (this.blocked && this.fits(this.blocked.bytes, this.blocked.count)) {
			this.blocked = null;
			this.options.onFull?.(false);
		}
	}

	private fits(bytes: number, count: number): boolean {
		return this.bytes + bytes <= MAX_UNACKED_BYTES - RECEIPT_BYTES && this.backlog.size + count <= MAX_UNACKED_FRAMES - 1;
	}

	private send(text: string, seq: number): void {
		this.transmitted = Math.max(this.transmitted, seq);
		try { this.socket?.send(text); } catch { this.detach(); }
	}

	private enqueue(body: Exclude<Body, Hello | Welcome | Fragment>): boolean {
		if (this.closed) throw new Error("The runner channel is closed.");
		const parts: Sent[] = [];
		let bytes = 0;
		const add = (frame: Sent) => {
			if (!parseFrame(frame.text)) throw new Error("Invalid outgoing runner frame.");
			parts.push(frame);
			bytes += frame.bytes;
			if (bytes > MAX_UNACKED_BYTES - RECEIPT_BYTES || parts.length >= MAX_UNACKED_FRAMES) throw new Error("The runner message exceeds the replay buffer.");
		};
		const frame = frameText(body, this.sent + 1, this.received);
		if (frame.bytes <= MAX_FRAME_BYTES && !(body.kind === "out" && Buffer.byteLength(body.data) > MAX_OUTPUT_BYTES)) {
			add(frame);
		} else if (body.kind === "in" || body.kind === "out" || body.kind === "op" || (body.kind === "res" && body.ok)) {
			const data = body.kind === "op" ? JSON.stringify(body.args) : body.kind === "res" ? JSON.stringify(body.value) : body.data;
			// Even a character escaped as six ASCII bytes fits in one of these pieces.
			let rest = data;
			while (rest.length) {
				const [text, tail] = rest.length <= 16_384 ? [rest, ""] : split(rest, 16_384);
				const part = tail ? "more" : "last";
				const piece: Body = body.kind === "op" ? { ...body, part, args: text } : body.kind === "res" ? { ...body, part, value: text } : { ...body, data: text };
				add(frameText(piece, this.sent + parts.length + 1, this.received));
				rest = tail;
			}
		} else throw new Error("The runner frame is too large.");
		if (!this.fits(bytes, parts.length)) {
			this.pause(bytes, parts.length);
			return false;
		}
		const start = this.sent;
		this.bytes += bytes;
		for (const part of parts) this.backlog.set(++this.sent, part);
		this.receiptDue = false;
		if (this.ready) {
			for (let i = 0; i < parts.length && this.ready; i++) {
				if (this.backlog.has(start + i + 1)) this.send(parts[i].text, start + i + 1);
			}
		}
		if (!this.fits(1, 1)) this.pause(1, 1);
		return true;
	}

	private pause(bytes: number, count: number): void {
		const already = this.paused;
		this.blocked = { bytes: Math.max(this.blocked?.bytes ?? 0, bytes), count: Math.max(this.blocked?.count ?? 0, count) };
		if (!already) this.options.onFull?.(true);
	}

	request<N extends Name>(op: Operation<N>, output?: OutputListener, timeoutMs?: number): Promise<Operations[N]["value"]> {
		return new Promise((resolve, reject) => {
			if (this.pending.has(op.id)) throw new Error("Runner request id already in use.");
			if (!validArgs(op.name, op.args)) throw new Error("Invalid runner operation.");
			const fail = (error: Error) => {
				if (op.name === "start") {
					this.streams.get(op.id)?.finish({ code: null, signal: null, error });
					this.streams.delete(op.id);
				}
				reject(error);
			};
			const waiting: Waiting = { name: op.name, resolve: (v) => resolve(v as Operations[N]["value"]), reject: fail, output };
			this.pending.set(op.id, waiting);
			try {
				const timeout = timeoutMs ?? ((op.name === "ask" || op.name === "run") ? (op as Operation<"ask" | "run">).args.options?.timeoutMs : undefined);
				if (timeout !== undefined) {
					waiting.timer = setTimeout(() => {
						this.pending.delete(op.id);
						fail(new Error("The runner operation timed out."));
					}, timeout + RUNNER_GRACE_MS);
				}
				if (!this.enqueue(op as Operation)) throw new Error(FULL);
			} catch (error) {
				clearTimeout(waiting.timer);
				this.pending.delete(op.id);
				fail(error instanceof Error ? error : new Error("Could not send the runner operation."));
			}
		});
	}

	respond<N extends Name>(op: Operation<N>, value: Operations[N]["value"]): boolean {
		if (!validResult(op.name, value) || (op.name === "start" && (value as { id: string }).id !== op.id)) throw new Error("Invalid runner response.");
		return this.enqueue({ kind: "res", id: op.id, ok: true, value });
	}
	refuse(id: string, error: Failure): boolean { return this.enqueue({ kind: "res", id, ok: false, error }); }

	/** Subscribe before asking for start. Its request id is also the id of its stream. */
	stream(id: string, output: OutputListener): Promise<ProcessEnd> {
		if (this.closed || this.streams.has(id)) throw new Error("Cannot open this runner stream.");
		return new Promise((finish) => this.streams.set(id, { output, finish }));
	}
	output(id: string, fd: 1 | 2, data: string): boolean { return this.enqueue({ kind: "out", id, fd, data }); }
	end(id: string, end: ProcessEnd): boolean {
		const wire: Ending = { code: end.code, signal: end.signal, error: end.error?.message ?? null };
		return this.enqueue({ kind: "end", id, ...wire });
	}
	write(id: string, data: string): boolean { return this.enqueue({ kind: "in", id, data }); }
	closeIn(id: string): boolean { return this.enqueue({ kind: "close-in", id }); }

	private ack(): void {
		// Both pipes can be full at once. Repeating an outstanding receipt with a newer ack frees either.
		const seq = this.backlog.has(this.receipt) ? this.receipt : ++this.sent;
		const frame = frameText({ kind: "ack" }, seq, this.received);
		this.bytes += frame.bytes - (this.backlog.get(seq)?.bytes ?? 0);
		this.receipt = seq;
		this.backlog.set(seq, frame);
		this.receiptDue = false;
		this.send(frame.text, seq);
	}
	private silent(): boolean {
		const now = Date.now();
		if (this.deadline && now >= this.deadline) { this.expire(); return true; }
		if (now - this.lastRead < DEAD_MS) return false;
		this.detach(this.lastRead + DEAD_MS);
		return true;
	}

	private tick(): void {
		if (this.silent()) return;
		const now = Date.now();
		if (now - this.lastPing >= PING_MS) {
			this.lastPing = now;
			if (this.socket?.ping && this.socket.onPong) {
				try { this.socket.ping(); } catch { this.detach(); return; }
			}
			// The other adapter may see data messages only, even when ours can send native pings.
			if (this.ready) this.ack();
		}
		if (this.ready && this.receiptDue) this.ack();
	}

	detach(since = Date.now()): void {
		const socket = this.socket;
		this.socket = null;
		this.ready = false;
		clearInterval(this.clock);
		if (!this.closed && !this.deadline) {
			this.deadline = since + RUNNER_GRACE_MS;
			const left = this.deadline - Date.now();
			if (left <= 0) this.expire();
			else this.grace = setTimeout(() => this.expire(), left);
		}
		socket?.close();
	}

	private expire(): void {
		if (this.closed) return;
		this.close("The machine did not answer within the grace period.");
		this.options.onGraceExpired?.();
	}

	close(reason = "The runner channel is closed."): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.grace);
		this.detach();
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error(reason));
		}
		for (const stream of this.streams.values()) stream.finish({ code: null, signal: null, error: new Error(reason) });
		this.pending.clear();
		this.streams.clear();
		this.backlog.clear();
		this.gaps.clear();
		this.piece = this.blocked = null;
		this.bytes = this.gapBytes = 0;
		this.options.onClose?.(reason);
	}
}
