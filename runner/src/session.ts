import { basename } from "node:path";
import { RunnerChannel, type ChannelSocket } from "../../server/src/runner/channel.js";
import type { Hello, Operation, Value } from "../../server/src/runner/protocol.js";
import { SandboxUserError } from "../../server/src/sandbox/api.js";
import { DockerSandboxHandle, type DockerProcess, type StartOptions } from "../../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../../server/src/sandbox/token-file.js";
import { audit, safeSentence } from "./audit.js";
import { type Box, Executor } from "./docker-executor.js";
import { Refusal } from "./state.js";

// run() uses this same start() internally. Capture its pipes without reimplementing the
// Docker provider's stdin handling, cancellation, signal escalation or output truncation.
class Handle extends DockerSandboxHandle {
	constructor(box: Box, uid: string, private readonly track: (p: DockerProcess) => void) {
		super(box.raw, box.profile, uid);
	}
	override start(argv: string[], options?: StartOptions, tag?: string) {
		const p = super.start(argv, options, tag);
		this.track(p);
		return p;
	}
}

class Conversation {
	private active = true;
	private paused = false;
	private pipes = new Set<DockerProcess>();
	private processes = new Map<string, { p: DockerProcess; acp: boolean; handle: Handle; id: string }>();
	private runs = new Map<string, AbortController>();
	constructor(private owner: Executor, private session: string, private channel: RunnerChannel) {}
	input(id: string, data: string) { this.processes.get(id)?.p.write(data); }
	eof(id: string) { this.processes.get(id)?.p.closeStdin(); }
	cancel(id: string) { this.runs.get(id)?.abort(); }
	pause(paused: boolean) {
		this.paused = paused;
		for (const p of this.pipes) p.pauseOutput(paused);
	}
	async orphan() {
		this.active = false;
		this.pause(false);
		const stops = [...this.processes.values()].map(async ({ p, acp, handle, id }) => {
			p.closeStdin();
			if (acp) {
				const path = tokenFilePath(id);
				await handle.sweep(p.tag, { waitMs: 3000, files: [path, path + ".tmp"] });
			}
		});
		await Promise.all(stops);
	}
	private output(id: string, fd: 1 | 2, text: string) {
		if (this.active && !this.channel.output(id, fd, text)) this.pause(true);
	}
	private requireActive() {
		if (!this.active) throw new Refusal("The session conversation ended.");
	}
	private async execute(op: Operation, abort?: AbortController): Promise<Value<Operation["name"]>> {
		const o = this.owner;
		switch (op.name) {
			case "create": {
				const existing = await o.serial(() => { this.requireActive(); return o.existing(this.session); });
				if (existing) return existing;
				await o.ensureImage();
				return o.serial(() => { this.requireActive(); return o.create(this.session, op.args.profile); });
			}
			case "connect": case "suspend": case "destroy": case "state":
				return o.serial(async () => {
					this.requireActive();
					return o.lifecycle(op.name, op.args.id, this.session);
				});
			case "killClient": case "signal": {
				const run = this.processes.get(op.args.process);
				if (!run) throw new Refusal("This process does not belong to this session.");
				if (op.name === "signal") await run.p.signal(op.args.sig, op.args.who);
				else run.p.killClient();
				return null;
			}
		}
		const id = op.args.id;
		const box = o.running(id, this.session);
		const h = new Handle(box, o.identity.uid, p => {
			this.pipes.add(p);
			if (this.paused) p.pauseOutput(true);
			void p.ended.then(() => this.pipes.delete(p));
		});
		const streams = { onStdout: (s: string) => this.output(op.id, 1, s), onStderr: (s: string) => this.output(op.id, 2, s) };
		box.busy++;
		try {
			switch (op.name) {
				case "start": {
					const p = h.start(op.args.argv, { ...op.args.options, ...streams }, op.args.tag);
					const acp = basename(op.args.argv[0] ?? "") === "windlass" && op.args.argv.includes("acp");
					this.processes.set(op.id, { p, acp, handle: h, id });
					box.busy++;
					// start() returns synchronously. Answer in this stack, before any pipe event can run.
					this.channel.respond(op, null);
					void p.ended.then(end => {
						box.busy--; box.usedAt = Date.now();
						this.processes.delete(op.id);
						if (this.active) this.channel.end(op.id, end);
					});
					return null;
				}
				case "run": {
					const { exitCode, timedOut, aborted, stdout, stderr } = await h.run(op.args.command, { ...op.args.options, ...streams, signal: abort!.signal });
					return { exitCode, timedOut, aborted, stdout, stderr };
				}
				case "ask": return await h.ask(op.args.argv, op.args.options);
				case "readTextFile": return await h.readTextFile(op.args.path);
				case "writeTextFile": case "writeSecretFile": await h[op.name](op.args.path, op.args.content); return null;
				case "removeFiles": await h.removeFiles(op.args.paths); return null;
				case "stopLeftovers": return await h.stopLeftovers(op.args.program);
				case "sweep": return await h.sweep(op.args.tag, op.args.options);
			}
		} finally { box.busy--; box.usedAt = Date.now(); }
	}
	async serve(op: Operation, orphaned: Promise<void>) {
		const abort = op.name === "run" ? new AbortController() : undefined;
		if (abort) this.runs.set(op.id, abort);
		let id = "id" in op.args && this.owner.boxes.has(op.args.id) ? op.args.id : null;
		let outcome = "done";
		try {
			// Finish the previous turn's tagged cleanup before a new turn writes its token.
			await orphaned;
			if (!this.active) return;
			const value = await this.execute(op, abort);
			if (op.name === "create" && typeof value === "string") id = value;
			if (this.active && op.name !== "start") this.channel.respond(op, value);
		} catch (error) {
			const kind = error instanceof Refusal ? "refused" : error instanceof SandboxUserError ? "user" : "sandbox";
			outcome = kind;
			if (this.active) this.channel.refuse(op, { kind, message: error instanceof Error ? error.message : String(error) });
		} finally { this.runs.delete(op.id); audit(this.session, id, op.name, outcome); }
	}
}

export class Session {
	readonly channel: RunnerChannel;
	private conversation: Conversation;
	private socket?: WebSocket;
	refused = false;
	orphaned: Promise<void> = Promise.resolve();
	constructor(private id: string, private owner: Executor, private forget: () => void) {
		this.channel = new RunnerChannel({
			onOperation: op => { void this.conversation.serve(op, this.orphaned); },
			onInput: (id, data) => this.conversation.input(id, data),
			onCloseIn: id => this.conversation.eof(id),
			onCancel: id => this.conversation.cancel(id),
			onDrain: () => this.conversation.pause(false),
			onReset: () => {
				this.orphaned = this.conversation.orphan();
				this.conversation = new Conversation(this.owner, this.id, this.channel);
				// During a fresh handshake the new socket is already here. After the
				// detached channel's grace, only the orphaned processes need to outlive it.
				void this.orphaned.then(() => { if (!this.socket && !this.refused) this.forget(); });
			},
			onRefused: reason => {
				this.refused = true;
				audit(this.id, null, "session", safeSentence(reason));
				this.channel.close();
			},
		});
		this.conversation = new Conversation(owner, id, this.channel);
	}
	attach(ws: WebSocket, identity: Pick<Hello, "runnerVersion" | "machineId" | "ticket" | "signature">) {
		this.socket = ws;
		ws.addEventListener("close", () => { if (this.socket === ws) this.socket = undefined; });
		const socket: ChannelSocket = { send: text => ws.send(text), close: () => ws.close(),
			onMessage: fn => ws.addEventListener("message", e => fn(e.data)), onClose: fn => ws.addEventListener("close", fn) };
		this.channel.attach(socket, identity);
	}
}
