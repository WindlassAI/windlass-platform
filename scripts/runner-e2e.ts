/**
 * Sessions on a user's own machine, end to end: the real server (fake Windlass layer for hosted
 * sessions, WLP_MACHINES=1), the real pairing routes, the real `machine` actor and the real session
 * actor, against a runner stood in for in this process. The stand-in speaks the control socket with
 * `FakeRunner` (runner-fake.ts) and serves each session's socket on the real `RunnerChannel`, with
 * sandboxes in memory and a small `windlass acp` that replays a recorded turn. The turn code that
 * speaks to it is the server's own (turn.ts). Before the server starts, the session's link to its runner
 * (runner-layer.ts) is checked in this process, against a stand-in machine actor, on a clock it moves by
 * hand: the interleavings of hellos, answers, deadlines and closes that a real run meets only by chance.
 *
 *   cd server && npx tsx ../scripts/runner-e2e.ts
 *
 * The engine and HTTP server use OS-assigned ports. Nothing runs in
 * Docker. Prints one PASS/FAIL line per check and exits 1 if any failed.
 */
import { localListeners } from "./check-listeners.js";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import type { SessionSnapshot, SessionSummary, TimelineItem } from "../server/src/contract.js";
import { type ChannelSocket, RunnerChannel } from "../server/src/runner/channel.js";
import { MIN_RUNNER_VERSION, sessionProof } from "../server/src/runner/control.js";
import { DEAD_MS, PROTOCOL_VERSION, type Operation } from "../server/src/runner/protocol.js";
import { StandInRunner, assert, until, opened } from "./runner-standin.js";
import { FakeRunner } from "./runner-fake.js";

const { engine: PORT, http: [HTTP] } = process.argv[2] === "node"
	? { engine: Number(process.env.RIVET_RUN_ENGINE_PORT), http: [Number(process.env.WLP_HTTP_PORT)] }
	: await localListeners();
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${HTTP}`;
const SERVER_DIR = fileURLToPath(new URL("../server/", import.meta.url));
/** The person's ceiling on agents working at once (WLP_FACTORY_RUNNING_TURNS): one, so that a second hosted turn is refused. */
const CEILING = 1;
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
		// The server is this file in its "node" role (`serverNode` below): the real server, with one hook.
		const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "node"], {
			cwd: SERVER_DIR,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...env, WLP_SECRET: this.secret, WLP_DEMO: "1", WLP_SANDBOX: "fake", WLP_MACHINES: "1", WLP_FACTORY_RUNNING_TURNS: String(CEILING), WLP_PUBLIC_URL: ORIGIN, WLP_HTTP_PORT: String(HTTP), RIVET_RUN_ENGINE_PORT: String(PORT), RIVETKIT_STORAGE_PATH: this.storage, RIVET_LOG_LEVEL: "warn" },
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

	/** While this file exists, the machine's actor fails to record a sandbox's removal (`serverNode`). */
	get refusal(): string {
		return join(this.storage, "refuse-removal");
	}
}

/**
 * The server's process: the real server, whose machine actor fails `internalRemoveSandbox` while
 * `Server.refusal` exists, as one whose storage is away; and whose session has one action more,
 * `e2eMeta`, which reads its stored meta for a check (no page shows the machine's name kept at launch).
 */
async function serverNode(): Promise<void> {
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	Object.assign(agentSession.config.actions!, { e2eMeta: (c: { vars: { meta: unknown } }) => c.vars.meta });
	const { machine } = await import("../server/src/actors/machine.js");
	const actions = machine.config.actions!;
	Object.assign(actions, { e2eDestroy: (c: { destroy(): void }) => c.destroy() });
	const remove = actions.internalRemoveSandbox;
	const refusal = join(process.env.RIVETKIT_STORAGE_PATH!, "refuse-removal");
	actions.internalRemoveSandbox = async (c, input) => {
		if (existsSync(refusal)) throw new Error("the machine's storage is away (runner-e2e)");
		return remove(c, input);
	};
	await import("../server/src/index.js");
}

function free(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

type Client = ReturnType<typeof createClient<Registry>>;

class Watch {
	readonly items: TimelineItem[] = [];
	/** Each `machine` event: what the banner says of the machine, when it changes. */
	readonly machines: Array<{ state: string; since: number; at: number }> = [];
	readonly conn;
	constructor(client: Client, uid: string, id: string, token: string) {
		this.conn = client.agentSession.get([uid, id], { params: { token } }).connect();
		this.conn.on("item", (item: unknown) => this.items.push(item as TimelineItem));
		this.conn.on("machine", (reach: unknown) => this.machines.push({ ...(reach as { state: string; since: number }), at: Date.now() }));
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

// ---------------------------------------------------------------------------------------------
// The session's link, in this process: a stand-in machine actor, the real channels, a clock moved by hand
// ---------------------------------------------------------------------------------------------

type LinkModule = typeof import("../server/src/sandbox/runner-layer.js");
type Facts = import("../server/src/actors/machine.js").MachineFacts;
type Attachment = import("../server/src/actors/machine.js").Attachment;

const LINK_WHO = { uid: "u_link", sessionId: "s_link", machineId: "m_0123456789abcdef" };
const LINK_SANDBOX = `${LINK_WHO.machineId}-000000000001`;
const turnOver = () => new Promise<void>((done) => setImmediate(done));
/** Moves the hand-held clock, letting what each step makes due run before the next. */
async function advance(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 50) {
		mock.timers.tick(Math.min(left, 50));
		await turnOver();
	}
}
/** Follows `p` from the moment it is made: `at` is its value, its error, or "pending". */
function track<T>(p: Promise<T>): { at: T | Error | "pending" } {
	const followed: { at: T | Error | "pending" } = { at: "pending" };
	p.then((value) => { followed.at = value; }, (error: Error) => { followed.at = error; });
	return followed;
}

/** A socket between the link (RivetKit's raw socket, as `onWebSocket` hands it) and the runner's channel; what is sent arrives a moment later. */
function socketPair() {
	const server = { message: [] as Array<(event: { data: unknown }) => void>, close: [] as Array<() => void> };
	const runner = { message: [] as Array<(data: unknown) => void>, close: [] as Array<() => void> };
	let open = true;
	let silent = false;
	const close = () => {
		if (!open) return;
		open = false;
		if (silent) return;
		queueMicrotask(() => {
			for (const listener of [...server.close, ...runner.close]) listener();
		});
	};
	return {
		silence: () => { silent = true; },
		server: {
			send: (text: string) => {
				if (!open) throw new Error("closed");
				queueMicrotask(() => open && !silent && runner.message.forEach((listener) => listener(text)));
			},
			close,
			addEventListener: (type: "message" | "close", listener: never) => (type === "message" ? server.message : server.close).push(listener),
		},
		runner: {
			send: (text: string) => {
				if (!open) throw new Error("closed");
				queueMicrotask(() => open && !silent && server.message.forEach((listener) => listener({ data: text })));
			},
			close,
			onMessage: (listener: (data: unknown) => void) => runner.message.push(listener),
			onClose: (listener: () => void) => runner.close.push(listener),
		} satisfies ChannelSocket,
	};
}

/**
 * The machine's actor as a session sees it, and the machine's runner behind it. `hello` is when the
 * runner answers an `attach`: "now" (before the actor's reply reaches the session), after a number of
 * ms, or "never"; `reply` is what the actor's answer waits for first.
 */
function bench(layer: LinkModule, options: { report?: Facts["report"]; facts?: () => Promise<void>; serve?: (op: Operation, channel: RunnerChannel) => void } = {}) {
	const key = generateKeyPairSync("ed25519");
	const report: Facts["report"] = options.report ?? { kind: "report", docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: 10e9, sandboxes: [] };
	const facts: Facts = { status: "online", name: "Bench", publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"), report };
	const log = { calls: [] as string[], attaches: [] as number[], tickets: [] as string[], ops: [] as string[], reaches: [] as string[], inFlight: 0, mostInFlight: 0 };
	const mode: { hello: "now" | "never" | number; reply: () => Promise<void>; answer: Attachment } = {
		hello: "now",
		reply: async () => undefined,
		answer: { ok: true },
	};
	const serve = options.serve ?? ((op: Operation, channel: RunnerChannel) => {
		if (op.name === "connect") channel.respond(op, { cwd: "/workspace", profile: "docker-hardened" });
		else if (op.name === "state") channel.respond(op, "running");
		else if (op.name === "run") channel.respond(op, { exitCode: 0, timedOut: false, aborted: false, stdout: "", stderr: "" });
		else if (op.name === "suspend") channel.respond(op, null);
	});
	const runner: RunnerChannel = new RunnerChannel({
		onOperation: (op) => {
			log.ops.push(op.name);
			serve(op, runner);
		},
		onInput: () => undefined,
		onCloseIn: () => undefined,
		onCancel: () => undefined,
		onDrain: () => undefined,
		onReset: () => undefined,
		onRefused: () => undefined,
	});
	let current: ReturnType<typeof socketPair> | null = null;
	const hello = (ticket: string) => {
		current = socketPair();
		link.socket(current.server);
		runner.attach(current.runner, { runnerVersion: MIN_RUNNER_VERSION, machineId: LINK_WHO.machineId, ticket, signature: sign(null, Buffer.from(sessionProof(LINK_WHO.uid, LINK_WHO.sessionId, LINK_WHO.machineId, ticket)), key.privateKey).toString("base64url") });
	};
	const link = new layer.RunnerLink(
		LINK_WHO,
		{
			facts: async () => {
				log.calls.push("facts");
				await options.facts?.();
				return facts;
			},
			attach: async (_sessionId, ticket) => {
				log.calls.push("attach");
				log.attaches.push(Date.now());
				log.tickets.push(ticket);
				log.mostInFlight = Math.max(log.mostInFlight, ++log.inFlight);
				try {
					if (mode.answer.ok) {
						if (mode.hello === "now") hello(ticket);
						else if (typeof mode.hello === "number") setTimeout(() => hello(ticket), mode.hello);
					}
					await mode.reply();
					return mode.answer;
				} finally {
					log.inFlight -= 1;
				}
			},
			removeSandbox: async () => undefined,
		},
		() => undefined,
		(reach) => log.reaches.push(reach.state),
	);
	const hosted = { windlass: { problem: () => null }, tokens: {}, logins: {}, backups: null } as never;
	return {
		link,
		sandboxes: layer.machineLayer(link, hosted).sandboxes,
		log,
		mode,
		hello,
		/** The session's socket drops, as when the runner's network goes. */
		drop: () => current?.server.close(),
		silence: () => current?.silence(),
		close: () => {
			link.close();
			runner.close();
		},
	};
}
const never = () => new Promise<void>(() => undefined);
const after = (ms: number) => () => new Promise<void>((done) => setTimeout(done, ms));

async function linkChecks(): Promise<void> {
	const layer: LinkModule = await import("../server/src/sandbox/runner-layer.js");
	const { ATTACH_WAIT_MS, IDLE_DETACH_MS, MachineUnreachable } = layer;
	const benches: Array<ReturnType<typeof bench>> = [];
	const fresh = (options?: Parameters<typeof bench>[1]) => {
		const made = bench(layer, options);
		benches.push(made);
		return made;
	};
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 10, 19) });
	try {
		await check("link: a runner whose hello comes before the machine actor's answer is let in, with the key had first", async () => {
			const b = fresh();
			b.mode.reply = after(200);
			const connected = track(b.sandboxes.connect(LINK_SANDBOX));
			await advance(300);
			const handle = connected.at;
			assert(handle !== "pending" && !(handle instanceof Error) && handle !== undefined, `connect came to ${handle instanceof Error ? handle.message : String(handle)}`);
			assert(b.log.calls.join() === "facts,attach", `calls: ${b.log.calls.join()}`);
			return "hello at once, answer at 200 ms: connected at once, facts asked once and before the ticket";
		});

		await check("link: Stop while a command waits for the socket ends it at once, and the runner never has it", async () => {
			const b = fresh();
			const handle = await (async () => {
				const connecting = b.sandboxes.connect(LINK_SANDBOX);
				await advance(50);
				return await connecting;
			})();
			assert(handle, "no handle");
			await advance(IDLE_DETACH_MS + 100);
			assert(!b.link.channel.connected, "the idle socket was kept");
			b.mode.hello = 1_000;
			const stop = new AbortController();
			const run = track(handle.run("pwd", { signal: stop.signal }));
			await turnOver();
			stop.abort();
			await turnOver();
			const at = run.at;
			await advance(1_100);
			assert(at !== "pending" && !(at instanceof Error) && at.aborted, `run came to ${at instanceof Error ? at.message : JSON.stringify(at)} when stopped`);
			assert(b.link.channel.connected && !b.log.ops.includes("run"), `connected ${b.link.channel.connected}, runner had: ${b.log.ops.join()}`);
			// With the socket there: stopped in the same moment it was asked, before the link has handed it over.
			const now = new AbortController();
			const quick = track(handle.run("pwd", { signal: now.signal }));
			now.abort();
			await advance(100);
			assert(quick.at !== "pending" && !(quick.at instanceof Error) && quick.at.aborted && !b.log.ops.includes("run"), `stopped as it was asked: ${JSON.stringify(quick.at)}, runner had: ${b.log.ops.join()}`);
			return "aborted at once; the socket came a second later and carried no run, nor did one stopped as it was asked";
		});

		await check("link: suspend on a machine that cannot be reached fails, so the session keeps the state it had", async () => {
			const b = fresh();
			b.mode.answer = { ok: false, reason: "offline" };
			const suspended = track(b.sandboxes.suspend(LINK_SANDBOX));
			await advance(50);
			const at = suspended.at;
			assert(at instanceof MachineUnreachable && at.reason === "offline", `suspend came to ${at instanceof Error ? at.message : String(at)}`);
			return at.message;
		});

		await check(`link: the offline wait is ${ATTACH_WAIT_MS / 1000} s from the first ask, for every caller that joins it, even with the machine's actor stalled`, async () => {
			const b = fresh();
			b.mode.hello = "never";
			b.mode.reply = never;
			const first = track(b.sandboxes.connect(LINK_SANDBOX));
			await advance(5_000);
			const second = track(b.sandboxes.connect(LINK_SANDBOX));
			await advance(ATTACH_WAIT_MS - 5_000 - 100);
			const early = [first.at, second.at];
			await advance(200);
			const late = [first.at, second.at];
			assert(early.every((at) => at === "pending"), `gave up early: ${early.map((at) => (at instanceof Error ? at.message : String(at))).join(" | ")}`);
			assert(late.every((at) => at instanceof MachineUnreachable && at.message.startsWith('Your machine "Bench" is offline')), `at ${ATTACH_WAIT_MS / 1000} s: ${late.map((at) => (at instanceof Error ? at.message : String(at))).join(" | ")}`);
			const c = fresh({ facts: never });
			const stalled = track(c.sandboxes.connect(LINK_SANDBOX));
			await advance(ATTACH_WAIT_MS + 100);
			const unnamed = stalled.at;
			assert(unnamed instanceof MachineUnreachable && unnamed.message.startsWith("Your machine is offline"), `with the facts stalled: ${unnamed instanceof Error ? unnamed.message : String(unnamed)}`);
			return `both callers at ${ATTACH_WAIT_MS / 1000} s, named; with no name had: "${unnamed.message.split(".")[0]}"`;
		});

		await check("link: while work waits on a lost socket a ticket goes every 5 s, one call to the machine's actor at a time", async () => {
			const b = fresh({ serve: (op, channel) => op.name === "connect" && channel.respond(op, { cwd: "/workspace", profile: "docker-hardened" }) });
			const handle = await (async () => {
				const connecting = b.sandboxes.connect(LINK_SANDBOX);
				await advance(50);
				return await connecting;
			})();
			assert(handle, "no handle");
			const waiting = b.link.request("state", { id: LINK_SANDBOX }).catch(() => undefined);
			await advance(50);
			b.mode.hello = "never";
			const from = b.log.attaches.length;
			b.drop();
			await advance(16_000);
			const times = b.log.attaches.slice(from);
			const gaps = times.slice(1).map((t, i) => t - times[i]!);
			assert(times.length >= 4 && gaps.every((gap) => gap === 5_000), `asked at +${times.map((t) => t - times[0]!).join(", +")} ms`);
			const c = fresh();
			c.mode.hello = "never";
			c.mode.reply = after(7_000);
			const slow = c.sandboxes.connect(LINK_SANDBOX).catch(() => undefined);
			await advance(ATTACH_WAIT_MS + 100);
			assert(c.log.mostInFlight === 1, `${c.log.mostInFlight} calls to the machine's actor at once`);
			b.close();
			await waiting;
			await slow;
			return `${times.length} tickets 5 s apart; at most one actor call at a time with 7 s answers`;
		});

		await check("link: a silent socket with no close event gets a new ticket and the pending operation resumes", async () => {
			const b = fresh();
			const ready = b.link.ready();
			await advance(50);
			await ready;
			b.silence();
			b.mode.hello = "never";
			const before = b.log.attaches.length;
			const state = track(b.link.request("state", { id: LINK_SANDBOX }));
			await advance(DEAD_MS + 5_000);
			const retries = b.log.attaches.slice(before);
			assert(b.link.reach()?.state === "not_answering" && b.log.reaches.at(-1) === "not_answering", `banner: ${b.log.reaches.join(", ")}`);
			assert(retries.length === 2 && retries[1]! - retries[0]! === 5_000, `retry times: ${retries.join(", ")}`);
			b.hello(b.log.tickets.at(-1)!);
			await advance(100);
			assert(state.at === "running" && b.log.ops.join() === "state" && b.link.reach()?.state === "answering", `state: ${String(state.at)}, operations: ${b.log.ops.join()}`);
			return "two tickets five seconds apart; one completed operation on the resumed socket";
		});

		await check("link: once closed it settles its waiters and asks nothing more; a socket that comes after the work gave up is let go", async () => {
			const b = fresh();
			b.mode.hello = "never";
			const waiting = track(b.sandboxes.connect(LINK_SANDBOX));
			await advance(100);
			const calls = b.log.calls.length;
			b.link.close();
			b.link.close();
			await turnOver();
			const at = waiting.at;
			await advance(30_000);
			assert(at instanceof Error && !(at instanceof MachineUnreachable), `at close: ${at instanceof Error ? at.message : String(at)}`);
			assert(b.log.calls.length === calls, `${b.log.calls.length - calls} calls to the machine's actor after close`);
			const c = fresh();
			c.mode.hello = "never";
			const gaveUp = c.sandboxes.connect(LINK_SANDBOX).catch((error: Error) => error);
			await advance(ATTACH_WAIT_MS + 100);
			assert((await gaveUp) instanceof MachineUnreachable, "the connect did not give up");
			await advance(36_000 - ATTACH_WAIT_MS - 100);
			c.hello(c.log.tickets.at(-1)!);
			await advance(100);
			const late = c.link.channel.connected;
			await advance(IDLE_DETACH_MS + 100);
			assert(late && !c.link.channel.connected && c.log.ops.length === 0, `late socket taken ${late}, still held ${c.link.channel.connected}`);
			return `closed: "${at.message}", no call after; a late socket went after ${IDLE_DETACH_MS / 1000} s idle`;
		});

		await check("link: a machine session's profile is the machine's own, with its real availability", async () => {
			const b = fresh({ report: { kind: "report", docker: { ok: true }, commandSandbox: { ok: false, reason: "Bubblewrap could not start" }, freeDiskBytes: 10e9, sandboxes: [] } });
			await advance(50);
			assert(b.log.calls.join() === "facts", `calls: ${b.log.calls.join()}`);
			const profile = b.sandboxes.profile("docker-windlass-sandbox");
			assert(profile.name.includes('"Bench"') && !profile.available, `profile: ${profile.name}, available ${profile.available}`);
			return `${profile.name}: ${profile.unavailableReason}`;
		});

		await check("link: losing an idle socket pushes the offline banner without inviting the runner back", async () => {
			const b = fresh();
			await b.link.ready();
			b.drop();
			await advance(IDLE_DETACH_MS + 100);
			assert(b.log.reaches.join() === "answering,offline", `pushed: ${b.log.reaches.join()}`);
			assert(b.link.reach()?.state === "offline" && b.log.attaches.length === 1, "idle socket loss must wait for new work");
			await b.link.ready();
			assert(b.link.reach()?.state === "answering", "the next operation did not restore the banner");
			return b.log.reaches.join(", ");
		});

		await check("link: what the banner reads is pushed each time it changes", async () => {
			const b = fresh({ serve: (op, channel) => op.name === "connect" && channel.respond(op, { cwd: "/workspace", profile: "docker-hardened" }) });
			const connecting = b.sandboxes.connect(LINK_SANDBOX);
			await advance(50);
			await connecting;
			const waiting = b.link.request("state", { id: LINK_SANDBOX }).catch(() => undefined);
			await advance(50);
			b.mode.hello = "never";
			b.drop();
			await advance(100);
			b.mode.answer = { ok: false, reason: "removed" };
			await advance(5_000);
			await waiting;
			const c = fresh();
			c.mode.answer = { ok: false, reason: "offline" };
			await c.sandboxes.connect(LINK_SANDBOX).catch(() => undefined);
			const seen = [...b.log.reaches, ...c.log.reaches].join(", ");
			assert(seen === "answering, not_answering, removed, offline", `pushed: ${seen}`);
			return seen;
		});
	} finally {
		for (const b of benches) b.close();
		mock.timers.reset();
	}
}

async function main(): Promise<void> {
	const server = new Server();
	// Before anything imports auth.js, which reads it once: the service tokens this process makes are the server's.
	process.env.WLP_SECRET = server.secret;
	// First, and on a clock of their own: nothing of the server is needed for them.
	await linkChecks();
	const runner = new StandInRunner(ORIGIN, ENDPOINT);
	try {
		await server.start();
		const client = createClient<Registry>({ endpoint: ENDPOINT, token: "default", namespace: "default" });
		const auth = await client.login.getOrCreate([randomUUID()]).demo();
		const { uid } = auth.profile;
		const token = auth.token;
		const user = client.user.getOrCreate([uid], { params: { token } });
		await runner.pair(user);
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		const newSession = (repoUrl?: string): Promise<SessionSummary> => user.createSession({ place, profile: "docker-hardened", ...(repoUrl ? { repoUrl } : {}) });
		const refusal = (p: Promise<unknown>) => p.then(() => "accepted", (error) => String((error as { code?: unknown }).code));

		await check("launch on a paired machine that has never reported is refused", async () => {
			const code = await refusal(newSession());
			assert(code === "machine_not_connected", `launch was ${code}`);
			return code;
		});

		await check("launch on a machine with an outdated runner is refused", async () => {
			const old = await runner.openControl("0.0.9");
			try {
				await until("the outdated version in the user's list", async () => (await user.machines()).some((m) => m.machineId === place.machineId && m.warnings.some((w) => w.kind === "outdated")));
				const code = await refusal(newSession());
				assert(code === "runner_outdated", `launch was ${code}`);
				return code;
			} finally {
				old.ws.close();
			}
		});

		await runner.connectControl();
		// What the machine's own actor says of it now (the user's list may be behind, as after a restart).
		const { serviceParams } = await import("../server/src/auth.js");
		const machineIs = (status: string) => until(`the machine's actor to say it is ${status}`, async () => (await client.machine.get([uid, runner.id.machineId], { params: serviceParams() }).internalFacts()).status === status, 60_000);
		await machineIs("online");
		// A launch reads the machine's profiles from its report in the user's list.
		await until("the machine's report in the user's list", async () => (await user.machines()).some((machine) => machine.commandSandbox !== null));
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
		await check("the first snapshot after a sandbox-less machine session wakes shows its machine profile", async () => {
			// Instantiate the link before sleep too, so the wake must build a fresh one.
			await snapshotOf(client, uid, main.id, token);
			await forceSleep(main.id);
			const before = runner.attaches;
			const snapshot = await snapshotOf(client, uid, main.id, token);
			assert(snapshot.summary.sandbox === "none" && snapshot.profile.available && snapshot.profile.name.includes(runner.fake.details.name), `profile: ${snapshot.profile.name} (available: ${snapshot.profile.available})`);
			assert(runner.attaches === before, "reading the profile opened a runner socket");
			return snapshot.profile.name;
		});

		let plainEvents = 0;
		await check("a turn on the machine completes, with its sandbox on the machine, and is not metered", async () => {
			const { watch, ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
			plainEvents = watch.windlass(ended.turn);
			assert(plainEvents > 10, `${plainEvents} Windlass events`);
			assert(boxesOf(main.id).length === 1, `${boxesOf(main.id).length} sandboxes on the machine`);
			const usage = await user.usage();
			assert(usage.usedSeconds === 0 && usage.heldSeconds === 0 && usage.today.length === 0 && usage.kept.length === 0, "the machine's sandbox counted against the user's sandbox time");
			// What its server question and its pull request name the machine by, kept from the launch.
			const meta = (await (client.agentSession.get([uid, main.id], { params: { token } }) as unknown as { e2eMeta(): Promise<{ machineName?: string | null }> }).e2eMeta());
			assert(meta.machineName === runner.fake.details.name, `the session kept the machine's name as ${JSON.stringify(meta.machineName)}`);
			return `${plainEvents} events, one sandbox, nothing held; the machine's name "${meta.machineName}" kept`;
		});

		await check("a hosted session of the same person still takes its hold and its kept place; the machine's takes neither", async () => {
			const hosted = await user.createSession({ place: { kind: "hosted" }, profile: "docker-hardened" });
			try {
				const { ended } = await turn(hosted.id, "Write the primes");
				assert(ended.outcome === "succeeded", `the hosted turn ended ${ended.outcome}: ${ended.message}`);
				const usage = await user.usage();
				assert(usage.today.length === 1 && usage.today[0]?.sessionId === hosted.id && usage.today[0].heldSeconds > 0, `today: ${JSON.stringify(usage.today)}`);
				assert(usage.sandboxes.kept === 1 && usage.kept.length === 1 && usage.kept[0]?.sessionId === hosted.id, `kept: ${usage.sandboxes.kept}, ${JSON.stringify(usage.kept.map((k) => k.sessionId))}`);
			} finally {
				await user.deleteSession(hosted.id);
			}
			return "one hold and one kept place, both the hosted session's, beside a running machine sandbox";
		});

		await check(`a session on the machine takes no running slot: with the ceiling at ${CEILING} and a hosted turn running it starts, a second hosted one is refused, and a hosted one starts beside a machine turn`, async () => {
			const hosted = await user.createSession({ place: { kind: "hosted" }, profile: "docker-hardened" });
			const second = await user.createSession({ place: { kind: "hosted" }, profile: "docker-hardened" });
			try {
				const busy = new Watch(client, uid, hosted.id, token);
				try {
					const { turn: number } = await busy.conn.prompt({ text: "Fix the failing test (slow)" });
					await until("the hosted turn to run", () => busy.windlass(number) >= 3, 30_000);
					const { ended } = await turn(main.id, "Write the primes");
					assert(ended.outcome === "succeeded", `the machine's turn beside a hosted one ended ${ended.outcome}: ${ended.message}`);
					const refused = await refusal(client.agentSession.get([uid, second.id], { params: { token } }).prompt({ text: "Write the primes" }));
					assert(refused === "too_many_running", `a second hosted turn was ${refused}`);
					await busy.untilEnded(number);
				} finally {
					await busy.conn.dispose();
				}
				const onMachine = new Watch(client, uid, main.id, token);
				try {
					const { turn: number } = await onMachine.conn.prompt({ text: "Write the primes (slow)" });
					await until("the machine's turn to run", () => onMachine.windlass(number) >= 3);
					const { ended } = await turn(second.id, "Write the primes");
					assert(ended.outcome === "succeeded", `a hosted turn beside the machine's ended ${ended.outcome}: ${ended.message}`);
					await onMachine.untilEnded(number);
				} finally {
					await onMachine.conn.dispose();
				}
			} finally {
				await user.deleteSession(hosted.id);
				await user.deleteSession(second.id);
			}
			// What bounds the machine is its runner's own cap: the turn says the runner's sentence.
			const capped = await newSession();
			runner.full = true;
			try {
				const { ended } = await turn(capped.id, "Write the primes");
				assert(ended.outcome === "error" && ended.message === "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.", `at the machine's cap the turn ended ${ended.outcome}: ${ended.message}`);
				return `machine turn beside a hosted one: succeeded; second hosted: too_many_running; hosted beside a machine turn: succeeded; at the machine's cap: "${ended.message}"`;
			} finally {
				runner.full = false;
				await user.deleteSession(capped.id);
			}
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

		await check("a message sent into a turn while the machine is not answering is refused at once, is not kept, and the turn goes on when the machine is back", async () => {
			const watch = new Watch(client, uid, main.id, token);
			const STEER = "And print the squares too";
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				await until("the turn's first events", () => watch.windlass(number) >= 3);
				// The socket goes, and the runner does not come back until it is let.
				runner.attachMode = "ignore";
				runner.served.get(main.id)?.ws?.close();
				await sleep(1_000);
				const at = Date.now();
				const said = await Promise.race([
					watch.conn.prompt({ text: STEER }).then(
						() => ({ code: "taken" as unknown, message: "" }),
						(error) => ({ code: (error as { code?: unknown }).code, message: String((error as { message?: unknown }).message ?? "") }),
					),
					sleep(8_000).then(() => ({ code: "still waiting" as unknown, message: "" })),
				]);
				const ms = Date.now() - at;
				runner.attachMode = "serve";
				assert(said.code === "turn_running" && said.message === "Your machine is not answering, so the message was not sent. Send it again when it is back.", `the message sent with the machine away: ${String(said.code)} after ${ms} ms ${said.message}`);
				assert(ms < 3_000, `refused after ${ms} ms`);
				const ended = await watch.untilEnded(number);
				assert(ended.outcome === "succeeded", `the turn ended ${ended.outcome} once the machine was back: ${ended.message}`);
				const timeline = (await snapshotOf(client, uid, main.id, token)).timeline;
				assert(!timeline.some((item) => item.kind === "user" && item.text === STEER), "the refused message is in the timeline");
				return `refused in ${ms} ms: "${said.message}"; the turn then ${ended.outcome}`;
			} finally {
				runner.attachMode = "serve";
				await watch.conn.dispose();
			}
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

		await check("a server restart during a machine turn interrupts it, ends its engine and lets the next prompt run", async () => {
			const watch = new Watch(client, uid, main.id, token);
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				const box = await until("the turn's engine to stream", () => watch.windlass(number) >= 3 && boxesOf(main.id).find((box) => box.engines.size === 1));
				await server.stop();
				await server.start();
				await machineIs("online");
				// The server may have closed the turn while the watcher was disconnected.
				const snapshot = await snapshotOf(client, uid, main.id, token);
				const cut = snapshot.timeline.find((item) => item.turn === number && item.kind === "turn.ended");
				assert(cut?.kind === "turn.ended" && cut.outcome === "interrupted", `turn ${number} after restart: ${cut?.kind === "turn.ended" ? cut.outcome : "no ending"}`);
				await until("the runner to end the interrupted turn's engine", () => box.engines.size === 0);
				const { ended } = await turn(main.id, "Write the primes");
				assert(ended.outcome === "succeeded", `next turn ended ${ended.outcome}: ${ended.message}`);
				return `turn ${number} interrupted, its engine stopped; turn ${ended.turn} succeeded`;
			} finally {
				await watch.conn.dispose();
			}
		});

		await check("a machine session put to sleep with its sandbox running is not suspended through a runner its sleep refuses, and its next prompt runs", async () => {
			const lines = (what: string) => server.log().split("\n").filter((line) => line.includes(what) && line.includes(`session=${main.id}`)).length;
			const before = { slow: lines("sandbox.suspend_slow"), skipped: lines("sandbox.suspend_skipped") };
			assert(boxesOf(main.id)[0]?.state === "running", `the sandbox is ${boxesOf(main.id)[0]?.state}`);
			await forceSleep(main.id);
			// The sleep says one or the other: skipped at once, or slow after the suspend's wait (SUSPEND_WAIT_MS).
			await until("the sleep to say what it did with the sandbox", () => lines("sandbox.suspend_skipped") > before.skipped || lines("sandbox.suspend_slow") > before.slow, 20_000);
			assert(lines("sandbox.suspend_slow") === before.slow, "the sleep asked the runner to suspend, and waited for a socket it refused");
			const { ended } = await turn(main.id, "Write the primes");
			assert(ended.outcome === "succeeded", `the next turn ended ${ended.outcome}: ${ended.message}`);
			return `sandbox left to the runner's idle rule (${boxesOf(main.id)[0]?.state}); the next turn succeeded`;
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

		await check("create in a conversation that is lost, before any report, is asked again and makes no second sandbox", async () => {
			const fresh = await newSession();
			const creates = runner.creates;
			runner.loseCreates = 1;
			const { ended } = await turn(fresh.id, "Write the primes");
			assert(ended.outcome === "succeeded", `ended ${ended.outcome}: ${ended.message}`);
			assert(boxesOf(fresh.id).length === 1, `${boxesOf(fresh.id).length} sandboxes for the session`);
			assert(runner.creates === creates + 2, `${runner.creates - creates} creates reached the runner`);
			return "two creates, one sandbox: the runner answered the repeat with the one it had made";
		});

		await check("delete removes all reported sandboxes of a session that lost both create replies", async () => {
			const doomed = await newSession();
			runner.loseCreates = 2;
			const { ended } = await turn(doomed.id, "Write the primes");
			const [orphan] = boxesOf(doomed.id);
			assert(ended.outcome === "error" && orphan && runner.loseCreates === 0, "both creates should lose their replies");
			assert((await snapshotOf(client, uid, doomed.id, token)).summary.sandbox === "none", "the session saved its sandbox");
			const otherId = `${place.machineId}-${randomBytes(6).toString("hex")}`;
			runner.boxes.set(otherId, { ...orphan, id: otherId });
			runner.report();
			await until("both unrecorded sandboxes in the machine's report", async () => (await user.machines()).some(m => m.sandboxes.filter(s => s.sessionId === doomed.id).length === 2));
			await runner.setOffline(true);
			try {
				await machineIs("offline");
				await user.deleteSession(doomed.id);
				assert(boxesOf(doomed.id).length === 2, "the offline runner acted on a removal");
			} finally {
				await runner.setOffline(false);
			}
			await until("both reported sandboxes to be removed", () => boxesOf(doomed.id).length === 0, 5_000);
			assert(boxesOf(main.id).length === 1, "the main session lost its sandbox");
			return "both removed on reconnect, the other session's sandbox kept";
		});

		await check("a delete whose machine cannot record the sandbox's removal is refused and keeps the session; once the machine answers it goes through", async () => {
			const doomed = await newSession();
			const { ended } = await turn(doomed.id, "Write the primes");
			assert(ended.outcome === "succeeded" && boxesOf(doomed.id).length === 1, `ended ${ended.outcome}, ${boxesOf(doomed.id).length} sandboxes`);
			writeFileSync(server.refusal, "");
			let code: unknown;
			try {
				code = await user.deleteSession(doomed.id).then(() => "resolved", (error) => (error as { code?: unknown }).code);
				assert(code === "machine_unreachable", `the delete ${code === "resolved" ? "went through with nothing recorded to remove its sandbox" : `failed with ${String(code)}`}`);
				assert((await user.listSessions()).some((s) => s.id === doomed.id), "the session left the list");
			} finally {
				rmSync(server.refusal, { force: true });
			}
			await user.deleteSession(doomed.id);
			assert(!(await user.listSessions()).some((s) => s.id === doomed.id), "the second delete left the session listed");
			await until("the machine's runner to remove the sandbox", () => boxesOf(doomed.id).length === 0, 15_000);
			return `refused with ${String(code)}, still listed; the second delete removed it and its sandbox`;
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
			let pushedMs = 0;
			let first: Extract<TimelineItem, { kind: "turn.ended" }>;
			try {
				const { turn: number } = await watch.conn.prompt({ text: "Write the primes (slow)" });
				await until("the turn's first events", () => watch.windlass(number) >= 3);
				const removedAt = Date.now();
				await user.removeMachine({ machineId: runner.id.machineId, removeSandboxes: false });
				first = await watch.untilEnded(number);
				ms = Date.now() - removedAt;
				// The open page is told, not only a page opened afterwards.
				const told = await until("the open session to be told the machine was removed", () => watch.machines.find((m) => m.state === "removed"), 5_000);
				pushedMs = told.at - removedAt;
				assert(pushedMs < 2_000, `told ${pushedMs} ms after the removal`);
			} finally {
				await watch.conn.dispose();
			}
			assert(first.outcome !== "succeeded" && ms < 10_000, `ended ${first.outcome} after ${ms} ms: ${first.message}`);
			// Platform diagnostics can follow the reason on a separate line.
			const reason = first.message?.split("\n")[0];
			assert(reason === "This agent's machine was removed. Its files were there. Start a new agent to go on.", `removed mid-turn: ${reason}`);
			const next = await turn(main.id, "Write the primes");
			assert(next.ended.outcome === "error" && /was removed/.test(next.ended.message ?? ""), `next turn ended ${next.ended.outcome}: ${next.ended.message}`);
			const snapshot = await snapshotOf(client, uid, main.id, token);
			assert(snapshot.machine?.state === "removed" && snapshot.timeline.length > 0, `snapshot: ${JSON.stringify(snapshot.machine)}`);
			return `the running turn ended ${ms} ms after the removal (${reason}), the open page told in ${pushedMs} ms; the next refused in ${next.ms} ms`;
		});

		await check("deleting a session whose machine actor is gone succeeds", async () => {
			const machine = client.machine.get([uid, place.machineId], { params: serviceParams() });
			const { isActorGone } = await import("../server/src/actors/internal.js");
			await (machine as unknown as { e2eDestroy(): Promise<void> }).e2eDestroy();
			await until("the machine actor to disappear", () => machine.internalFacts().then(() => false, isActorGone));
			await user.deleteSession(main.id);
			assert(!(await user.listSessions()).some(s => s.id === main.id), "the session is still listed");
			return "the session with a saved sandbox id left the list";
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

/** Puts a session's actor to sleep through the engine's control plane, as e2e.ts does. */
async function forceSleep(sessionId: string): Promise<void> {
	const plane = (path: string, method = "GET") => fetch(`${ENDPOINT}${path}`, { method, headers: { Authorization: "Bearer default", "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
	const list = (await (await plane("/actors?namespace=default&name=agentSession")).json()) as { actors: Array<{ actor_id: string; key: string }> };
	const record = list.actors.find((entry) => entry.key.includes(sessionId));
	assert(record, "the control plane does not list the session's actor");
	const slept = await plane(`/actors/${record.actor_id}/sleep?namespace=default`, "POST");
	assert(slept.ok, `the control plane refused the sleep: ${slept.status} ${await slept.text()}`);
}

function snapshotOf(client: Client, uid: string, id: string, token: string): Promise<SessionSnapshot> {
	return client.agentSession.get([uid, id], { params: { token } }).snapshot();
}

if (process.argv[2] === "node") await serverNode();
else await main();
