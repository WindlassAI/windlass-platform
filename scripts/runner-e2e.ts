/**
 * Sessions on a user's own machine, end to end: the real server (fake Windlass layer for hosted
 * sessions, WLP_MACHINES=1), the real pairing routes, the real `machine` actor and the real session
 * actor, against a runner stood in for in this process. The stand-in speaks the control socket with
 * `FakeRunner` (runner-fake.ts) and serves each session's socket on the real `RunnerChannel`, with
 * sandboxes in memory and a small `windlass acp` that replays a recorded turn. The turn code that
 * speaks to it is the server's own (turn.ts).
 *
 *   cd server && npx tsx ../scripts/runner-e2e.ts
 *
 * Its ports are its own (engine 6950, +1 and +10; HTTP 6970), so it needs no lock. Nothing runs in
 * Docker. Prints one PASS/FAIL line per check and exits 1 if any failed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import type { SessionSnapshot, SessionSummary, TimelineItem, WindlassEvent } from "../server/src/contract.js";
import { type ChannelSocket, RunnerChannel } from "../server/src/runner/channel.js";
import { MIN_RUNNER_VERSION, parseConnection, parseServerFrame, sessionProof } from "../server/src/runner/control.js";
import { PROTOCOL_VERSION, type Operation } from "../server/src/runner/protocol.js";
import { FakeRunner } from "./runner-fake.js";

const PORT = 6950;
const HTTP = 6970;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${HTTP}`;
const SERVER_DIR = fileURLToPath(new URL("../server/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/windlass-events/demo-several-steps-in-one-turn.jsonl", import.meta.url));
/** The design's numbers (Plans/2026-11-19, section 1.4): how long a session waits for its runner's socket. */
const OFFLINE_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let failed = 0;
async function check(name: string, body: () => Promise<string>): Promise<void> {
	try {
		console.log(`PASS  ${name}  (${await body()})`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL  ${name}  -- ${error instanceof Error ? error.message : String(error)}`);
	}
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function until<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== null && value !== false) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}
function opened(ws: WebSocket): Promise<void> {
	if (ws.readyState === 1) return Promise.resolve();
	return new Promise((done, fail) => {
		ws.addEventListener("open", () => done(), { once: true });
		ws.addEventListener("close", () => fail(new Error("the socket closed while opening")), { once: true });
	});
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

class Server {
	readonly storage = mkdtempSync(join(tmpdir(), "wlp-runner-e2e-"));
	private child: ChildProcess | null = null;
	readonly secret = randomBytes(24).toString("hex");

	async start(): Promise<void> {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WLP_|RIVET|E2B_)/.test(key)));
		const log = createWriteStream(join(this.storage, "server.log"), { flags: "a" });
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
			cwd: SERVER_DIR,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...env, WLP_SECRET: this.secret, WLP_DEMO: "1", WLP_SANDBOX: "fake", WLP_MACHINES: "1", WLP_PUBLIC_URL: ORIGIN, WLP_HTTP_PORT: String(HTTP), RIVET_RUN_ENGINE_PORT: String(PORT), RIVETKIT_STORAGE_PATH: this.storage, RIVET_LOG_LEVEL: "warn" },
		});
		child.stdout?.pipe(log);
		child.stderr?.pipe(log);
		this.child = child;
		child.on("exit", () => {
			if (this.child === child) this.child = null;
		});
		await until("the server to answer", async () => {
			if (!this.child) throw new Error(`the server exited; see ${this.storage}/server.log`);
			return (await fetch(`${ORIGIN}/health`).catch(() => null))?.ok === true;
		}, 120_000);
	}

	/** As a node being replaced: SIGTERM, so every actor goes to sleep. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGTERM");
		await until("the server to exit", () => this.child === null, 40_000).catch(() => child.kill("SIGKILL"));
		await until("the engine's ports to be free", async () => (await free(PORT)) && (await free(HTTP)), 20_000);
	}

	log(): string {
		return readFileSync(join(this.storage, "server.log"), "utf8");
	}
}

function free(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

// ---------------------------------------------------------------------------------------------
// The stand-in runner
// ---------------------------------------------------------------------------------------------

const RECORDED: WindlassEvent[] = readFileSync(FIXTURE, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as WindlassEvent).filter((event) => event.type !== "cli.summary");

/** `windlass acp`, as little of it as a turn needs: it replays one recorded turn. "(slow)" in the prompt spaces its events out. */
class Engine {
	private session = `ses_standin${randomBytes(6).toString("hex")}`;
	private buffer = "";
	private timers: ReturnType<typeof setTimeout>[] = [];
	private prompt: unknown = null;

	constructor(private readonly say: (line: string) => void) {}

	input(data: string): void {
		this.buffer += data;
		for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, at);
			this.buffer = this.buffer.slice(at + 1);
			if (line.trim() !== "") this.handle(JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> });
		}
	}

	stop(): void {
		for (const timer of this.timers) clearTimeout(timer);
	}

	private send(message: Record<string, unknown>): void {
		this.say(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	private handle(m: { id?: unknown; method?: string; params?: Record<string, unknown> }): void {
		const reply = (result: unknown) => this.send({ id: m.id, result });
		switch (m.method) {
			case "initialize":
				return reply({ protocolVersion: 1, agentCapabilities: { _meta: { windlass: { notifications: ["_windlass/event"] } } } });
			case "session/new":
				return reply({ sessionId: this.session });
			case "_windlass/resolve":
				this.session = String(m.params?.session);
				return reply({ sessionId: this.session, cwd: "/workspace" });
			case "session/resume":
			case "session/close":
				return reply({});
			case "session/prompt": {
				this.prompt = m.id;
				const text = JSON.stringify(m.params?.prompt ?? "");
				const gap = text.includes("(slow)") ? 120 : 5;
				RECORDED.forEach((event, index) => {
					this.timers.push(setTimeout(() => this.send({ method: "_windlass/event", params: { sessionId: this.session, event: { ...event, sessionId: this.session } } }), gap * (index + 1)));
				});
				this.timers.push(setTimeout(() => this.answer("end_turn", "succeeded"), gap * (RECORDED.length + 1)));
				return;
			}
			case "session/cancel":
				this.stop();
				this.send({ method: "_windlass/event", params: { sessionId: this.session, event: { type: "execution.interrupted", v: 1, data: { executionId: "exe_1" }, sessionId: this.session, seq: 999, time: Date.now() } } });
				return this.answer("cancelled", "interrupted");
			default:
				if (m.id !== undefined && m.method !== undefined) this.send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
		}
	}

	private answer(stopReason: string, outcome: string): void {
		if (this.prompt === null) return;
		this.send({ id: this.prompt, result: { stopReason, _meta: { windlass: { executionId: "exe_1", outcome } } } });
		this.prompt = null;
	}
}

interface Box {
	id: string;
	sessionId: string;
	profile: "docker-windlass-sandbox" | "docker-hardened";
	state: "running" | "paused";
	files: Map<string, string>;
	/** The engines running in it, which outlive the runner process that started them, as in a container. */
	engines: Set<Engine>;
}

/** What the runner holds for one session: its channel, in memory only. */
interface Served {
	channel: RunnerChannel;
	ws: WebSocket | null;
	resets: string[];
	processes: Map<string, { engine: Engine | null; box: Box }>;
	runs: Map<string, Operation>;
}

class StandInRunner {
	readonly fake = new FakeRunner();
	id!: { uid: string; machineId: string };
	readonly boxes = new Map<string, Box>();
	served = new Map<string, Served>();
	control: { ws: WebSocket; send(frame: never): void } | null = null;
	epoch = randomUUID();
	/** What an `attach` frame does: "serve" it, "ignore" it, or "hold" its ticket for the check to use. */
	attachMode: "serve" | "ignore" | "hold" = "serve";
	held: Array<{ sessionId: string; ticket: string }> = [];
	attaches = 0;
	usedTickets: Array<{ sessionId: string; ticket: string }> = [];
	cancels: string[] = [];
	leftovers = 0;
	/** The next `create` makes its container and then the runner dies before it answers. */
	loseNextCreate = false;
	offline = false;
	removed = false;

	async pair(user: { claimMachine(input: { code: string }): Promise<unknown>; confirmMachine(input: { code: string }): Promise<{ machineId: string }> }): Promise<void> {
		const pairing = await this.fake.pair(ORIGIN);
		await user.claimMachine({ code: pairing.code });
		await user.confirmMachine({ code: pairing.code });
		const status = await this.fake.poll(ORIGIN, pairing);
		assert(status?.state === "approved", `pairing ended ${JSON.stringify(status)}`);
		this.id = { uid: status.uid, machineId: status.machineId };
		await this.connectControl();
	}

	private client() {
		return createClient<Registry>({ endpoint: ENDPOINT, token: "default", namespace: "default" });
	}

	/** The control socket, again whenever it closes, unless the machine is offline or removed. */
	async connectControl(): Promise<void> {
		const answer = await this.fake.connection(ORIGIN, this.id);
		const connection = parseConnection(await answer.json());
		assert(connection, `no connection (HTTP ${answer.status})`);
		const control = await this.fake.connect(connection, this.id, { epoch: this.epoch });
		// One begun before the machine went off the network does not bring it back.
		if (this.offline || this.removed || this.control) {
			control.ws.close();
			return;
		}
		this.control = control as never;
		await opened(control.ws);
		await until("the machine's welcome", () => {
			if (control.ws.readyState > 1) {
				if (this.control?.ws === control.ws) this.control = null;
				throw new Error("the control socket was refused");
			}
			return control.frames.some((frame) => frame.kind === "welcome");
		}, 15_000);
		control.ws.addEventListener("message", ({ data }) => {
			const frame = parseServerFrame(data);
			if (frame?.kind === "attach") this.attach(frame.sessionId, frame.ticket);
			if (frame?.kind === "remove") this.boxes.delete(frame.sandbox);
			// What a real runner does when its machine is removed: it serves no session any more.
			if (frame?.kind === "refused" && frame.reason === "removed") {
				this.removed = true;
				for (const served of this.served.values()) served.ws?.close();
			}
		});
		control.ws.addEventListener("close", () => {
			if (this.control?.ws !== control.ws) return;
			this.control = null;
			if (!this.offline && !this.removed) void this.reconnect();
		});
	}

	private async reconnect(): Promise<void> {
		for (;;) {
			await sleep(500);
			if (this.offline || this.removed || this.control) return;
			try {
				await this.connectControl();
				return;
			} catch {
				// The server is restarting.
			}
		}
	}

	report(): void {
		this.fake.report.sandboxes = [...this.boxes.values()].map(({ id, sessionId, state }) => ({ id, sessionId, state, usedAt: Date.now() }));
		this.control?.send(this.fake.report as never);
	}

	/** The machine goes off the network (control socket closed, and no reconnection), or comes back. */
	async setOffline(off: boolean): Promise<void> {
		this.offline = off;
		if (off) {
			const control = this.control;
			this.control = null;
			control?.ws.close();
			for (const served of this.served.values()) served.ws?.close();
		} else {
			await this.connectControl();
		}
	}

	/** The runner process dies and starts again: every channel is gone, the containers and what runs in them are not. */
	async restartProcess(): Promise<void> {
		const served = [...this.served.values()];
		this.served = new Map();
		for (const s of served) s.ws?.close();
		const control = this.control;
		this.control = null;
		this.epoch = randomUUID();
		control?.ws.close();
		await sleep(200);
		await this.connectControl();
	}

	private async attach(sessionId: string, ticket: string): Promise<void> {
		this.attaches += 1;
		if (this.attachMode === "ignore") return;
		if (this.attachMode === "hold") {
			this.held.push({ sessionId, ticket });
			return;
		}
		let served = this.served.get(sessionId);
		if (!served) {
			served = this.serve(sessionId);
			this.served.set(sessionId, served);
		}
		const ws = (await this.client().agentSession.get([this.id.uid, sessionId]).webSocket("runner")) as WebSocket;
		await opened(ws);
		served.ws = ws;
		this.usedTickets.push({ sessionId, ticket });
		served.channel.attach(socketOf(ws), { runnerVersion: MIN_RUNNER_VERSION, machineId: this.id.machineId, ticket, signature: this.fake.sign(sessionProof(this.id.uid, sessionId, this.id.machineId, ticket)) });
	}

	private serve(sessionId: string): Served {
		const served: Served = {
			ws: null,
			resets: [],
			processes: new Map(),
			runs: new Map(),
			channel: new RunnerChannel({
				onOperation: (op) => this.operation(served, sessionId, op),
				onInput: (process, data) => served.processes.get(process)?.engine?.input(data),
				onCloseIn: (process) => this.end(served, process, { code: 0, signal: null, error: null }),
				onCancel: (id) => {
					const op = served.runs.get(id);
					if (!op) return;
					served.runs.delete(id);
					this.cancels.push(id);
					served.channel.respond(op, { exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" });
				},
				onDrain: () => undefined,
				// The orphan rule: what the ended conversation started gets its stdin closed.
				onReset: (reason) => {
					served.resets.push(reason);
					for (const id of [...served.processes.keys()]) this.end(served, id, { code: 0, signal: null, error: null });
				},
				onRefused: (reason) => served.resets.push(`refused: ${reason}`),
			}),
		};
		return served;
	}

	private end(served: Served, process: string, end: { code: number | null; signal: string | null; error: null }): void {
		const p = served.processes.get(process);
		if (!p) return;
		served.processes.delete(process);
		if (p.engine) {
			p.engine.stop();
			p.box.engines.delete(p.engine);
		}
		served.channel.end(process, end);
	}

	private operation(served: Served, sessionId: string, op: Operation): void {
		const { channel } = served;
		const box = "id" in op.args ? this.boxes.get(op.args.id as string) : undefined;
		const mine = box !== undefined && box.sessionId === sessionId;
		switch (op.name) {
			case "create": {
				const made: Box = { id: `${this.id.machineId}-${randomBytes(6).toString("hex")}`, sessionId, profile: op.args.profile, state: "running", files: new Map(), engines: new Set() };
				this.boxes.set(made.id, made);
				this.report();
				if (this.loseNextCreate) {
					this.loseNextCreate = false;
					void sleep(300).then(() => this.restartProcess());
					return;
				}
				return channel.respond(op, made.id);
			}
			case "connect":
				if (!mine) return channel.respond(op, null);
				box.state = "running";
				return channel.respond(op, { cwd: "/workspace", profile: box.profile });
			case "state":
				return channel.respond(op, mine ? box.state : "none");
			case "suspend":
				if (mine) box.state = "paused";
				return channel.respond(op, null);
			case "destroy":
				if (mine) this.boxes.delete(box.id);
				this.report();
				return channel.respond(op, null);
			case "run":
				if (!mine) return channel.refuse(op, { kind: "refused", message: "No such sandbox." });
				// A clone that goes on until it is cancelled, for the stopped turn.
				if (op.args.command.includes("slow-clone")) {
					served.runs.set(op.id, op);
					return;
				}
				return channel.respond(op, { exitCode: 0, timedOut: false, aborted: false, stdout: "", stderr: "" });
			case "readTextFile": {
				const content = box?.files.get(op.args.path);
				if (!mine || content === undefined) return channel.refuse(op, { kind: "sandbox", message: `no such file: ${op.args.path}` });
				return channel.respond(op, content);
			}
			case "writeTextFile":
			case "writeSecretFile":
				if (mine) box.files.set(op.args.path, op.args.content);
				return channel.respond(op, null);
			case "removeFiles":
				for (const path of op.args.paths) box?.files.delete(path);
				return channel.respond(op, null);
			case "start": {
				if (!mine) return channel.refuse(op, { kind: "refused", message: "No such sandbox." });
				const isEngine = op.args.argv[0] === "windlass" && op.args.argv[1] === "acp";
				const engine = isEngine ? new Engine((line) => channel.output(op.id, 1, line)) : null;
				if (engine) box.engines.add(engine);
				served.processes.set(op.id, { engine, box });
				return channel.respond(op, null);
			}
			case "signal":
				this.end(served, op.args.process, { code: null, signal: `SIG${op.args.sig}`, error: null });
				return channel.respond(op, null);
			case "killClient":
				this.end(served, op.args.process, { code: null, signal: "SIGKILL", error: null });
				return channel.respond(op, null);
			case "ask":
				// No shell here: an answer of a program that is not there, which the turn reads as "nothing to read".
				return channel.respond(op, { code: 127, stdout: "", stderr: "stand-in runner: no shell" });
			case "stopLeftovers": {
				// Engines a dead runner process left running, which no channel serves any more.
				const live = new Set([...served.processes.values()].map((p) => p.engine));
				const left = mine ? [...box.engines].filter((engine) => !live.has(engine)) : [];
				for (const engine of left) {
					engine.stop();
					box?.engines.delete(engine);
				}
				this.leftovers += left.length;
				return channel.respond(op, left.length);
			}
			case "sweep":
				return channel.respond(op, 0);
			case "holdForTurn":
			case "releaseTurn":
				return channel.respond(op, null);
		}
	}
}

function socketOf(ws: WebSocket): ChannelSocket {
	return {
		send: (text) => ws.send(text),
		close: () => ws.close(),
		onMessage: (listener) => ws.addEventListener("message", (event) => listener(event.data)),
		onClose: (listener) => ws.addEventListener("close", () => listener()),
	};
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

type Client = ReturnType<typeof createClient<Registry>>;

class Watch {
	readonly items: TimelineItem[] = [];
	readonly conn;
	constructor(client: Client, uid: string, id: string, token: string) {
		this.conn = client.agentSession.get([uid, id], { params: { token } }).connect();
		this.conn.on("item", (item: unknown) => this.items.push(item as TimelineItem));
	}
	ended(turn: number) {
		return this.items.find((item): item is Extract<TimelineItem, { kind: "turn.ended" }> => item.kind === "turn.ended" && item.turn === turn);
	}
	untilEnded(turn: number, ms = 60_000) {
		return until(`turn ${turn} to end`, () => this.ended(turn), ms);
	}
	windlass(turn: number): number {
		return this.items.filter((item) => item.kind === "windlass" && item.turn === turn).length;
	}
	warnings(turn: number): string[] {
		return this.items.filter((item) => item.kind === "platform" && item.turn === turn && (item as { level?: string }).level === "warn").map((item) => (item as { text?: string }).text ?? "");
	}
}

/** A hello made by hand: whether the session answers it with a welcome before closing the socket. */
async function welcomed(client: Client, uid: string, sessionId: string, hello: Record<string, unknown>): Promise<boolean> {
	const ws = (await client.agentSession.get([uid, sessionId]).webSocket("runner")) as WebSocket;
	await opened(ws);
	return await new Promise<boolean>((done) => {
		const timer = setTimeout(() => {
			ws.close();
			done(false);
		}, 5_000);
		ws.addEventListener("message", ({ data }) => {
			clearTimeout(timer);
			ws.close();
			done(String(data).includes('"kind":"welcome"') && !String(data).includes("refused"));
		});
		ws.addEventListener("close", () => {
			clearTimeout(timer);
			done(false);
		});
		ws.send(JSON.stringify({ kind: "hello", protocol: PROTOCOL_VERSION, runnerVersion: MIN_RUNNER_VERSION, resume: null, ...hello }));
	});
}

async function main(): Promise<void> {
	for (const port of [PORT, PORT + 1, PORT + 10, HTTP]) assert(await free(port), `port ${port} is in use`);
	const server = new Server();
	const runner = new StandInRunner();
	try {
		await server.start();
		const client = createClient<Registry>({ endpoint: ENDPOINT, token: "default", namespace: "default" });
		const auth = await client.login.getOrCreate([randomUUID()]).demo();
		const { uid } = auth.profile;
		const token = auth.token;
		const user = client.user.getOrCreate([uid], { params: { token } });
		await runner.pair(user);
		// What the machine's own actor says of it now (the user's list may be behind, as after a restart).
		process.env.WLP_SECRET = server.secret;
		const { serviceParams } = await import("../server/src/auth.js");
		const machineIs = (status: string) => until(`the machine's actor to say it is ${status}`, async () => (await client.machine.get([uid, runner.id.machineId], { params: serviceParams() }).internalFacts()).status === status, 60_000);
		await machineIs("online");
		// A launch reads the machine's profiles from its report in the user's list.
		await until("the machine's report in the user's list", async () => (await user.machines()).some((machine) => machine.commandSandbox !== null));
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		const newSession = (repoUrl?: string): Promise<SessionSummary> => user.createSession({ place, profile: "docker-hardened", ...(repoUrl ? { repoUrl } : {}) });
		const boxesOf = (sessionId: string) => [...runner.boxes.values()].filter((box) => box.sessionId === sessionId);
		const turn = async (sessionId: string, text: string): Promise<{ watch: Watch; ended: Extract<TimelineItem, { kind: "turn.ended" }>; ms: number }> => {
			const watch = new Watch(client, uid, sessionId, token);
			try {
				const started = Date.now();
				const { turn: number } = await watch.conn.prompt({ text });
				const ended = await watch.untilEnded(number);
				return { watch, ended, ms: Date.now() - started };
			} finally {
				await watch.conn.dispose();
			}
		};

		const main = await newSession();
		let plainEvents = 0;
		await check("a turn on the machine completes, with its sandbox on the machine, and is not metered", async () => {
			const { watch, ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
			plainEvents = watch.windlass(ended.turn);
			assert(plainEvents > 10, `${plainEvents} Windlass events`);
			assert(boxesOf(main.id).length === 1, `${boxesOf(main.id).length} sandboxes on the machine`);
			const usage = await user.usage();
			assert(usage.usedSeconds === 0 && usage.heldSeconds === 0 && usage.today.length === 0 && usage.kept.length === 0, "the machine's sandbox counted against the user's sandbox time");
			return `${plainEvents} events, one sandbox, nothing held`;
		});

		await check("a link cut in the middle of a turn resumes, and the person sees nothing of it", async () => {
			const before = runner.attaches;
			const watch = new Watch(client, uid, main.id, token);
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				await until("the turn's first events", () => watch.windlass(number) >= 3);
				runner.served.get(main.id)?.ws?.close();
				const ended = await watch.untilEnded(number);
				assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
				assert(watch.windlass(number) === plainEvents, `${watch.windlass(number)} events, ${plainEvents} without the cut`);
				assert(watch.warnings(number).length === 0, `warnings: ${watch.warnings(number).join("; ")}`);
				assert(runner.attaches > before, "the session did not have the runner attach again");
				assert((runner.served.get(main.id)?.resets.length ?? 0) === 0, "the conversation was reset");
			} finally {
				await watch.conn.dispose();
			}
			return `the runner was asked to attach ${runner.attaches - before} time(s) after the cut; every event once`;
		});

		await check("the session's actor going to sleep and waking ends the conversation, and the next turn works", async () => {
			const resets = runner.served.get(main.id)?.resets.length ?? 0;
			await server.stop();
			await server.start();
			await machineIs("online");
			const { ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
			const now = runner.served.get(main.id)?.resets ?? [];
			assert(now.length === resets + 1, `${now.length - resets} resets on the runner`);
			return `runner told: ${now.at(-1)}`;
		});

		await check("the runner restarting mid-turn ends that turn, and the next turn stops what it left and works", async () => {
			const watch = new Watch(client, uid, main.id, token);
			let first: Extract<TimelineItem, { kind: "turn.ended" }>;
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				await until("the turn's first events", () => watch.windlass(number) >= 3);
				await runner.restartProcess();
				first = await watch.untilEnded(number);
			} finally {
				await watch.conn.dispose();
			}
			assert(first.outcome !== "succeeded", "the cut turn succeeded");
			const left = runner.leftovers;
			const { ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `next turn ended ${ended.outcome}: ${ended.message}`);
			assert(runner.leftovers === left + 1, `${runner.leftovers - left} leftover engines stopped`);
			return `cut turn ${first.outcome}: ${first.message?.split("\n")[0]}`;
		});

		await check("create in a conversation that is lost makes no second sandbox", async () => {
			const fresh = await newSession();
			runner.loseNextCreate = true;
			const { ended } = await turn(fresh.id, "Write the primes");
			assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
			assert(boxesOf(fresh.id).length === 1, `${boxesOf(fresh.id).length} sandboxes for the session`);
			return "one sandbox, found in the machine's report";
		});

		await check("a stopped turn cancels the command running on the machine", async () => {
			const cloning = await newSession("https://example.com/org/slow-clone.git");
			const cancels = runner.cancels.length;
			const watch = new Watch(client, uid, cloning.id, token);
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes" });
				await until("the clone to run on the machine", () => [...runner.served.values()].some((served) => served.runs.size > 0));
				await watch.conn.stop();
				const ended = await watch.untilEnded(number);
				assert(runner.cancels.length === cancels + 1, "the runner was not told to cancel the clone");
				assert(ended.outcome === "interrupted", `ended ${ended.outcome}: ${ended.message}`);
			} finally {
				await watch.conn.dispose();
			}
			return "cancel reached the runner; the turn ended interrupted";
		});

		await check("a used ticket, a wrong signature and a hello for another machine are refused", async () => {
			const used = runner.usedTickets.filter((t) => t.sessionId === main.id).at(-1);
			assert(used, "no ticket was used");
			const signed = (ticket: string, machineId = runner.id.machineId, key = runner.fake) => key.sign(sessionProof(uid, main.id, machineId, ticket));
			// Without a socket, so that a hello would be taken if it were good.
			runner.served.get(main.id)?.ws?.close();
			await sleep(300);
			assert(!(await welcomed(client, uid, main.id, { machineId: runner.id.machineId, ticket: used.ticket, signature: signed(used.ticket) })), "a used ticket was taken");
			runner.attachMode = "hold";
			const watch = new Watch(client, uid, main.id, token);
			try {
				await watch.conn.prompt({ text: "Write the primes" });
				const first = await until("a held ticket", () => runner.held.shift());
				const stranger = new FakeRunner();
				assert(!(await welcomed(client, uid, main.id, { machineId: runner.id.machineId, ticket: first.ticket, signature: signed(first.ticket, runner.id.machineId, stranger) })), "a wrong signature was taken");
				assert(!(await welcomed(client, uid, main.id, { machineId: runner.id.machineId, ticket: first.ticket, signature: signed(first.ticket) })), "a ticket shown once with a wrong signature was taken after");
			} finally {
				await watch.conn.dispose();
			}
			await until("the waiting turn to give up", async () => ((await snapshotOf(client, uid, main.id, token)).summary.status === "idle"), 30_000);
			const watch2 = new Watch(client, uid, main.id, token);
			try {
				await watch2.conn.prompt({ text: "Write the primes" });
				const second = await until("a held ticket", () => runner.held.shift());
				const other = `m_${randomBytes(8).toString("hex")}`;
				assert(!(await welcomed(client, uid, main.id, { machineId: other, ticket: second.ticket, signature: signed(second.ticket, other) })), "a hello for another machine was taken");
			} finally {
				await watch2.conn.dispose();
			}
			runner.attachMode = "serve";
			await until("the waiting turn to give up", async () => ((await snapshotOf(client, uid, main.id, token)).summary.status === "idle"), 30_000);
			const { ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `a turn after them ended ${ended.outcome}: ${ended.message}`);
			return "each refused; the genuine runner is served after them";
		});

		await check(`a machine that is offline is refused at once, one that does not answer within ${OFFLINE_WAIT_MS / 1000} s, and the session stays readable`, async () => {
			await runner.setOffline(true);
			let off: Awaited<ReturnType<typeof turn>>;
			let changes: unknown[];
			try {
				await machineIs("offline");
				off = await turn(main.id, "Write the primes");
				assert(off.ended.outcome === "error" && /is offline/.test(off.ended.message ?? ""), `ended ${off.ended.outcome}: ${off.ended.message}`);
				assert(off.ms < 5_000, `with the machine's actor saying offline it took ${off.ms} ms`);
				const snapshot = await snapshotOf(client, uid, main.id, token);
				assert(snapshot.machine?.state === "offline" && snapshot.timeline.length > 0, `snapshot: ${JSON.stringify(snapshot.machine)}`);
				changes = await client.agentSession.get([uid, main.id], { params: { token } }).changes();
			} finally {
				await runner.setOffline(false);
				await machineIs("online");
			}
			// Online, but its runner never opens the socket.
			runner.attachMode = "ignore";
			let silent: Awaited<ReturnType<typeof turn>>;
			try {
				silent = await turn(main.id, "Write the primes");
				// The failed turn has the session look at its sandbox's state, which waits for a socket the same way: let that run out too.
				await sleep(OFFLINE_WAIT_MS + 2_000);
			} finally {
				runner.attachMode = "serve";
			}
			assert(silent.ended.outcome === "error" && /is offline/.test(silent.ended.message ?? ""), `ended ${silent.ended.outcome}: ${silent.ended.message}`);
			assert(silent.ms >= OFFLINE_WAIT_MS - 1_000 && silent.ms < OFFLINE_WAIT_MS + 10_000, `took ${silent.ms} ms`);
			return `machine offline: ${off.ms} ms, "${off.ended.message}"; snapshot and ${changes.length} changes read; no hello: ${silent.ms} ms`;
		});

		await check("a machine removed during a turn ends that turn at once, later prompts get the removed sentence, and the session stays readable", async () => {
			const watch = new Watch(client, uid, main.id, token);
			let ms = 0;
			let first: Extract<TimelineItem, { kind: "turn.ended" }>;
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				await until("the turn's first events", () => watch.windlass(number) >= 3);
				const removedAt = Date.now();
				await user.removeMachine({ machineId: runner.id.machineId, removeSandboxes: false });
				first = await watch.untilEnded(number);
				ms = Date.now() - removedAt;
			} finally {
				await watch.conn.dispose();
			}
			// At once, not after the ten-minute grace. Its sentence is turn.ts's for an engine cut off; the next prompt and the banner say why.
			assert(first.outcome !== "succeeded" && ms < 10_000, `ended ${first.outcome} after ${ms} ms: ${first.message}`);
			const next = await turn(main.id, "Write the primes");
			assert(next.ended.outcome === "error" && /was removed/.test(next.ended.message ?? ""), `next turn ended ${next.ended.outcome}: ${next.ended.message}`);
			const snapshot = await snapshotOf(client, uid, main.id, token);
			assert(snapshot.machine?.state === "removed" && snapshot.timeline.length > 0, `snapshot: ${JSON.stringify(snapshot.machine)}`);
			return `the running turn ended ${ms} ms after the removal (${first.message?.split("\n")[0]}); the next refused in ${next.ms} ms`;
		});
	} catch (error) {
		failed += 1;
		console.log(`FAIL  setting up  -- ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		runner.offline = true;
		runner.control?.ws.close();
		for (const served of runner.served.values()) served.ws?.close();
		await server.stop();
		if (failed === 0) rmSync(server.storage, { recursive: true, force: true });
		else console.log(`\nserver log and state kept in ${server.storage}`);
	}
	process.exit(failed === 0 ? 0 : 1);
}

function snapshotOf(client: Client, uid: string, id: string, token: string): Promise<SessionSnapshot> {
	return client.agentSession.get([uid, id], { params: { token } }).snapshot();
}

await main();
