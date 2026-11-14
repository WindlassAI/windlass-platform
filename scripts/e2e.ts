/**
 * End-to-end check of the server's four actors, through RivetKit's client, as the web app uses them.
 *
 *   cd server && npx tsx ../scripts/e2e.ts                 starts its own server on fresh state
 *   cd server && npx tsx ../scripts/e2e.ts --endpoint URL  uses a server that is already running
 *
 * WLP_SANDBOX chooses the sandbox layer of the server it starts (default here: fake). The server is
 * always started with WLP_DEMO=1; with --endpoint the server must have it too. Some checks need the
 * server's own output or a restart and are skipped with --endpoint; some are for one layer only.
 * With the Docker layer, WLP_E2E_REPO=<https git address> adds a check that clones that repository.
 * The server's state and log go to a new directory under WLP_E2E_DIR (default: the system's temporary
 * directory), removed when everything passed unless WLP_E2E_KEEP=1.
 *
 * Prints one PASS/FAIL/SKIP line per check and exits 1 if any failed.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import {
	type AuthResult,
	type LiveDelta,
	MAX_PROMPT_CHARS,
	MAX_RUNNING_SESSIONS,
	type PendingQuestion,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
} from "../server/src/contract.js";

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../server");
const args = process.argv.slice(2);
const endpointArg = args.includes("--endpoint") ? args[args.indexOf("--endpoint") + 1] : undefined;
const ENDPOINT = endpointArg ?? "http://127.0.0.1:6420";
const MODE = (process.env.WLP_SANDBOX ?? "fake") as "fake" | "docker";
const OWN_SERVER = endpointArg === undefined;
const FAKE = MODE === "fake";
/** How long one turn may take. A Docker turn creates a container and runs real commands. */
const TURN_MS = FAKE ? 30_000 : 240_000;
/** How long the server this script starts lets a question wait before it declines it: short, so the wait can be watched. */
const QUESTION_MS = FAKE ? 8_000 : 20_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// A browser sends its origin on the WebSocket handshake. Node's WebSocket can be told to as well, which
// lets this script play a page from an origin the server does not allow.
const NativeWebSocket = globalThis.WebSocket;
let webSocketOrigin: string | null = null;
class OriginWebSocket extends NativeWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		// biome-ignore lint/suspicious/noExplicitAny: undici's WebSocket takes an options object here
		super(url, (webSocketOrigin ? { protocols, headers: { Origin: webSocketOrigin } } : protocols) as any);
	}
}
globalThis.WebSocket = OriginWebSocket as typeof WebSocket;

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(name: string, detail = ""): void {
	passed += 1;
	console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
}

function fail(name: string, detail: string): void {
	failed += 1;
	console.log(`FAIL  ${name}  -- ${detail}`);
}

function skip(name: string, why: string): void {
	skipped += 1;
	console.log(`SKIP  ${name}  (${why})`);
}

function describe(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const { code, message } = error as { code?: unknown; message?: unknown };
		if (code !== undefined) return `${String(code)}: ${String(message)}`;
		if (message !== undefined) return String(message);
	}
	return String(error);
}

/** Runs one check: PASS with what it returns, FAIL with what it throws. */
async function check(name: string, body: () => Promise<string | undefined> | string | undefined): Promise<boolean> {
	try {
		pass(name, (await body()) ?? "");
		return true;
	} catch (error) {
		fail(name, describe(error));
		return false;
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Expects `call` to fail with a RivetKit error of this code; returns its message. */
async function refused(call: () => Promise<unknown>, code: string | string[]): Promise<string> {
	const codes = Array.isArray(code) ? code : [code];
	let result: unknown;
	try {
		result = await call();
	} catch (error) {
		const got = (error as { code?: unknown }).code;
		assert(typeof got === "string" && codes.includes(got), `expected error ${codes.join(" or ")}, got ${describe(error)}`);
		return String((error as { message?: unknown }).message);
	}
	throw new Error(`expected error ${codes.join(" or ")}, but the call succeeded with ${JSON.stringify(result)?.slice(0, 200)}`);
}

async function waitFor<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs: number, everyMs = 25): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== null && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(everyMs);
	}
}

function withTimeout<T>(what: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((done, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms: ${what}`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				done(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// ---------------------------------------------------------------------------------------------
// The server under test
// ---------------------------------------------------------------------------------------------

class Server {
	private child: ChildProcess | null = null;
	output = "";
	readonly storage = mkdtempSync(join(process.env.WLP_E2E_DIR ?? tmpdir(), "wlp-e2e-"));
	readonly logFile = join(this.storage, "server.log");
	private readonly secret = randomBytes(24).toString("hex");

	async start(extraEnv: Record<string, string> = {}): Promise<void> {
		const log = createWriteStream(this.logFile, { flags: "a" });
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
			cwd: SERVER_DIR,
			env: {
				...process.env,
				WLP_DEMO: "1",
				WLP_SANDBOX: MODE,
				WLP_SECRET: this.secret,
				RIVETKIT_STORAGE_PATH: this.storage,
				WLP_FAKE_DELAY_MS: process.env.WLP_FAKE_DELAY_MS ?? "15",
				WLP_QUESTION_TIMEOUT_MS: String(QUESTION_MS),
				...extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		const keep = (chunk: Buffer) => {
			this.output += chunk.toString("utf8");
			log.write(chunk);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("exit", (code, signal) => {
			if (this.child === child) this.child = null;
			log.write(`\n[e2e] server exited: code ${code} signal ${signal}\n`);
		});

		const client = createClient<Registry>(ENDPOINT);
		try {
			await waitFor(
				"the server to answer",
				async () => {
					if (!this.child) throw new Error(`the server exited while starting; see ${this.logFile}\n${this.output.slice(-1500)}`);
					try {
						await client.platform.getOrCreate(["main"]).info();
						return true;
					} catch {
						return false;
					}
				},
				120_000,
				400,
			);
		} finally {
			await client.dispose().catch(() => undefined);
		}
	}

	/** Stops the server as Ctrl-C would. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGTERM");
		await waitFor("the server to exit", () => this.child === null, 40_000, 100).catch(() => child.kill("SIGKILL"));
		await sleep(300);
		this.reapEngine();
	}

	/** Kills the server with no chance to shut down, as a crash would. */
	async crash(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill("SIGKILL");
		await waitFor("the server to die", () => this.child === null, 10_000, 50);
		// The engine is a child of the server; make sure it does not outlive it and keep the port.
		await sleep(500);
		this.reapEngine();
		await waitFor("port 6420 to be free", portFree, 20_000, 200);
	}

	private reapEngine(): void {
		try {
			const runtime = JSON.parse(readFileSync(join(this.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8")) as { pid?: number };
			if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
		} catch {
			// No engine left, which is the point.
		}
	}

	remove(): void {
		if (failed === 0 && process.env.WLP_E2E_KEEP !== "1") rmSync(this.storage, { recursive: true, force: true });
		else console.log(`\nserver log and state kept in ${this.storage}`);
	}
}

function portFree(): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(6420, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

function sandboxContainers(): string[] {
	const out = execFileSync("docker", ["ps", "-a", "--filter", "label=dev.windlass-platform=1", "--format", "{{.Names}}"], { encoding: "utf8" });
	return out.split("\n").filter((name) => name.startsWith("wlp-session-"));
}

/** How long the server under test accepts a sign-in attempt. Shortened when this script restarts its server. */
let loginTtlMs = 10 * 60 * 1000;
const SHORT_LOGIN_TTL_MS = 15_000;

function loginVolumes(): string[] {
	return execFileSync("docker", ["volume", "ls", "-q", "--filter", "label=dev.windlass-platform=1"], { encoding: "utf8" })
		.split("\n")
		.filter((name) => name.startsWith("wlp-login-"));
}

async function controlPlane(path: string, method = "GET"): Promise<Response> {
	return fetch(`${ENDPOINT}${path}`, {
		method,
		headers: { Authorization: "Bearer default", "Content-Type": "application/json" },
		body: method === "GET" ? undefined : "{}",
	});
}

/** Puts a session's actor to sleep through the control plane, as the lifecycle documentation describes. */
async function forceSleep(sid: string): Promise<void> {
	const list = (await (await controlPlane("/actors?namespace=default&name=agentSession")).json()) as { actors: Array<{ actor_id: string; key: string }> };
	const record = list.actors.find((entry) => entry.key.includes(sid));
	assert(record, `the control plane does not list the session's actor: ${plain(list).slice(0, 300)}`);
	const slept = await controlPlane(`/actors/${record.actor_id}/sleep?namespace=default`, "POST");
	assert(slept.ok, `the control plane refused the sleep: ${slept.status} ${await slept.text()}`);
}

/** The demo users this run signed in. With the Docker layer each has a data volume, removed at the end. */
const demoUids: string[] = [];

/** Removes this run's volumes, and only those: other work may be using the same Docker. */
function removeDemoVolumes(): string[] {
	const failures: string[] = [];
	const existing = execFileSync("docker", ["volume", "ls", "-q", "--filter", "label=dev.windlass-platform=1"], { encoding: "utf8" }).split("\n");
	for (const uid of demoUids) {
		const name = `wlp-user-${uid}`;
		if (!existing.includes(name)) continue;
		try {
			execFileSync("docker", ["volume", "rm", name], { stdio: "pipe" });
		} catch (error) {
			failures.push(`${name}: ${describe(error).split("\n")[0]}`);
		}
	}
	return failures;
}

// ---------------------------------------------------------------------------------------------
// Watching a session
// ---------------------------------------------------------------------------------------------

type Client = ReturnType<typeof createClient<Registry>>;
type WindlassItem = Extract<TimelineItem, { kind: "windlass" }>;

function newClient(options: { origin?: string } = {}): Client {
	return createClient<Registry>({ endpoint: ENDPOINT, headers: options.origin ? { Origin: options.origin } : undefined });
}

/** A connection to one session that records every event in the order it arrived. */
class Watch {
	readonly items: TimelineItem[] = [];
	readonly deltas: LiveDelta[] = [];
	readonly summaries: SessionSummary[] = [];
	/** Every `question` event: the question when one is asked, null when it is settled. */
	readonly questions: Array<PendingQuestion | null> = [];
	/** Arrival order across both streams: "i<seq>" for an item, "d" for a delta. */
	readonly order: string[] = [];
	readonly conn;

	constructor(client: Client, uid: string, id: string, token: string) {
		this.conn = client.agentSession.get([uid, id], { params: { token } }).connect();
		// RivetKit 3.1.1's client types event payloads as `unknown`, hence the casts.
		this.conn.on("item", (payload: unknown) => {
			const item = payload as TimelineItem;
			this.items.push(item);
			this.order.push(`i${item.seq}`);
		});
		this.conn.on("delta", (payload: unknown) => {
			this.deltas.push(payload as LiveDelta);
			this.order.push("d");
		});
		this.conn.on("summary", (payload: unknown) => {
			this.summaries.push(payload as SessionSummary);
		});
		this.conn.on("question", (payload: unknown) => {
			this.questions.push(payload as PendingQuestion | null);
		});
	}

	/** The question the turn is waiting on, once it has been announced. */
	async untilQuestion(turn: number, timeoutMs = TURN_MS): Promise<PendingQuestion> {
		return waitFor(
			`turn ${turn} to ask its question`,
			() => {
				const last = this.questions.at(-1);
				if (last && last.turn === turn) return last;
				const ended = this.ended(turn);
				if (ended) throw new Error(`turn ${turn} ended (${ended.outcome}${ended.message ? `: ${ended.message}` : ""}) without asking anything`);
				return undefined;
			},
			timeoutMs,
		);
	}

	/** The stored Windlass events of one type in a turn, oldest first. */
	windlass(turn: number, type: string): WindlassItem[] {
		return this.items.filter((item): item is WindlassItem => item.kind === "windlass" && item.turn === turn && item.event.type === type);
	}

	/** The stored Windlass events of one type about one tool call. */
	ofCall(turn: number, type: string, call: { messageId: string; callId: string }): WindlassItem[] {
		return this.windlass(turn, type).filter((item) => item.event.data?.messageId === call.messageId && item.event.data?.callId === call.callId);
	}

	/** The statuses the session went through from the summary event at `from` on. */
	statusesFrom(from: number): string {
		return this.summaries
			.slice(from)
			.map((summary) => summary.status)
			.filter((status, index, all) => index === 0 || status !== all[index - 1])
			.join(" > ");
	}

	ended(turn: number): Extract<TimelineItem, { kind: "turn.ended" }> | undefined {
		return this.items.find((item): item is Extract<TimelineItem, { kind: "turn.ended" }> => item.kind === "turn.ended" && item.turn === turn);
	}

	async untilEnded(turn: number, timeoutMs = TURN_MS): Promise<Extract<TimelineItem, { kind: "turn.ended" }>> {
		const ended = await waitFor(`turn ${turn} to end`, () => this.ended(turn), timeoutMs);
		await waitFor(`the session to be idle after turn ${turn}`, () => this.summaries.at(-1)?.status === "idle", 15_000);
		return ended;
	}

	statuses(): string {
		return this.summaries
			.map((summary) => summary.status)
			.filter((status, index, all) => index === 0 || status !== all[index - 1])
			.join(" > ");
	}
}

function plain(value: unknown): string {
	return JSON.stringify(value);
}

/** Checks that seqs are 1, 2, 3, ... with no gap and no repeat. */
function dense(items: TimelineItem[], from = 1): void {
	items.forEach((item, index) => {
		assert(item.seq === from + index, `seq ${item.seq} at position ${index}, expected ${from + index}`);
	});
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

async function main(server: Server | null): Promise<void> {
	const client = newClient();
	const attempt = () => `e2e-${randomBytes(8).toString("hex")}`;
	/** A prompt whose turn asks before it runs a command: both layers choose that scenario by these words. */
	const ASK = "Fetch the response headers of example.com";
	/** A prompt whose turn runs one command for a while: the turn to steer, and to stop one call of. */
	const LONG = "Run the long build and report its progress (slow)";
	const demoSignIn = async (id = attempt()): Promise<AuthResult> => {
		const result = await client.login.getOrCreate([id]).demo();
		demoUids.push(result.profile.uid);
		return result;
	};

	// --- platform ---------------------------------------------------------------------------------

	let availableProfile = "docker-windlass-sandbox";
	let models: string[] = [];
	await check("platform.info", async () => {
		const info = await client.platform.getOrCreate(["main"]).info();
		assert(info.demoEnabled === true, "demoEnabled is not true: start the server with WLP_DEMO=1");
		assert(info.profiles.length >= 2, "fewer than two profiles");
		const available = info.profiles.filter((profile) => profile.available);
		assert(available.length >= 1, "no available profile");
		assert(info.profiles.some((profile) => !profile.available && profile.unavailableReason), "no unavailable profile with a reason");
		assert(info.models.length >= 1, "no models");
		assert(plain(info.efforts) === plain(["low", "medium", "high", "xhigh", "max"]), `efforts are ${plain(info.efforts)}`);
		if (!FAKE) assert(typeof info.windlassVersion === "string" && info.windlassVersion !== "", "windlassVersion is null: is the sandbox image built?");
		availableProfile = available[0].id;
		models = info.models;
		return `windlass ${info.windlassVersion}, ${available.length}/${info.profiles.length} profiles available, models ${info.models.join(", ")}`;
	});

	// --- sign-in ----------------------------------------------------------------------------------

	let a: AuthResult | null = null;
	let b: AuthResult | null = null;
	await check("demo sign-in", async () => {
		a = await demoSignIn();
		b = await demoSignIn();
		assert(/^demo_[0-9a-f]{12}$/.test(a.profile.uid), `uid is ${a.profile.uid}`);
		assert(a.profile.demo === true && a.profile.email === null, "profile is not a demo profile");
		assert(a.profile.uid !== b.profile.uid, "two demo sign-ins gave the same uid");
		assert(typeof a.token === "string" && a.token.split(".").length === 3, "the token has an unexpected shape");
		const me = await client.user.getOrCreate([a.profile.uid], { params: { token: a.token } }).me();
		assert(plain(me) === plain(a.profile), `user.me() is ${plain(me)}`);
		const chatgpt = await client.user.getOrCreate([a.profile.uid], { params: { token: a.token } }).chatgpt();
		assert(chatgpt.connected === false, "a demo user is reported as connected to ChatGPT");
		return a.profile.uid;
	});
	if (!a || !b) throw new Error("no demo users: the remaining checks cannot run");
	const userA: AuthResult = a;
	const userB: AuthResult = b;
	const uid = userA.profile.uid;
	const token = userA.token;
	const userHandle = client.user.getOrCreate([uid], { params: { token } });

	// --- authentication ---------------------------------------------------------------------------

	await check("auth: a call without a token is rejected", async () => {
		await refused(() => client.user.getOrCreate([uid]).me(), "unauthorized");
		await refused(() => client.user.getOrCreate([uid], { params: {} }).listSessions(), "unauthorized");
		return "stateless action";
	});
	await check("auth: a tampered token is rejected", async () => {
		const [version, payload, signature] = token.split(".");
		const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), uid: userB.profile.uid }), "utf8").toString("base64url");
		const flipped = `${version}.${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
		await refused(() => client.user.getOrCreate([uid], { params: { token: flipped } }).me(), "invalid_token");
		await refused(() => client.user.getOrCreate([userB.profile.uid], { params: { token: `${version}.${forgedPayload}.${signature}` } }).me(), "invalid_token");
		await refused(() => client.user.getOrCreate([uid], { params: { token: "v1.e30.x" } }).me(), "invalid_token");
		return "flipped signature, swapped payload, garbage";
	});
	await check("auth: user A's token against user B's key is rejected", async () => {
		await refused(() => client.user.getOrCreate([userB.profile.uid], { params: { token } }).listSessions(), "forbidden");
		await refused(() => client.user.getOrCreate([userB.profile.uid], { params: { token } }).createSession({ profile: availableProfile as never }), "forbidden");
		return "user actor";
	});
	await check("auth: a WebSocket connection is rejected the same way", async () => {
		for (const [params, code] of [
			[undefined, "unauthorized"],
			[{ token: `${token}x` }, "invalid_token"],
		] as const) {
			const conn = client.user.getOrCreate([uid], { params }).connect();
			conn.onError(() => undefined);
			try {
				await refused(() => withTimeout("an action over a rejected connection", conn.me(), 10_000), code);
			} finally {
				await conn.dispose().catch(() => undefined);
			}
		}
		const wrong = client.user.getOrCreate([userB.profile.uid], { params: { token } }).connect();
		wrong.onError(() => undefined);
		try {
			await refused(() => withTimeout("an action over a rejected connection", wrong.me(), 10_000), "forbidden");
		} finally {
			await wrong.dispose().catch(() => undefined);
		}
		return "no token, bad token, another user's key";
	});
	await check("auth: internal actions refuse a user's token", async () => {
		const fake: SessionSummary = { id: "s_x", title: "x", profile: "docker-hardened", model: "m", repoUrl: null, createdAt: 0, updatedAt: 0, status: "idle", turns: 0, lastOutcome: null, sandbox: "none" };
		await refused(() => userHandle.internalSessionChanged(fake), "forbidden");
		await refused(() => userHandle.internalAcquireRun("s_x"), "forbidden");
		return "user.internalSessionChanged, user.internalAcquireRun";
	});
	await check("auth: an actor made by an unauthenticated call does not stay", async () => {
		const stranger = `u_${randomBytes(10).toString("hex")}`;
		await refused(() => client.user.getOrCreate([stranger]).me(), "unauthorized");
		await waitFor(
			"the empty user actor to be removed",
			async () => {
				try {
					await client.user.get([stranger]).me();
					return false;
				} catch (error) {
					return (error as { code?: string }).code === "not_found";
				}
			},
			10_000,
			200,
		);
		return "user actor removed";
	});
	await check("auth: a session cannot be created around the user actor", async () => {
		const forged = `s_${randomBytes(8).toString("hex")}`;
		const input = { grant: token, title: "forged", titleIsDefault: false, profile: availableProfile, model: models[0], repoUrl: null, demo: true, createdAt: Date.now() };
		try {
			const handle = await client.agentSession.create([uid, forged], { input: input as never, params: { token } });
			await handle.snapshot();
			throw new Error("the forged session answered a snapshot");
		} catch (error) {
			const code = (error as { code?: string }).code;
			assert(code === "session_not_found" || code === "not_found" || code === "destroying" || code === "destroyed", `unexpected: ${describe(error)}`);
		}
		await waitFor(
			"the forged session actor to be removed",
			async () => {
				try {
					await client.agentSession.get([uid, forged], { params: { token } }).snapshot();
					return false;
				} catch (error) {
					return (error as { code?: string }).code === "not_found";
				}
			},
			10_000,
			200,
		);
		return "actor without a grant removed itself";
	});
	await check("origin: only the web app's origin may connect", async () => {
		const evil = newClient({ origin: "http://evil.example" });
		const good = newClient({ origin: "http://localhost:5173" });
		try {
			await refused(() => evil.platform.getOrCreate(["main"]).info(), "origin_not_allowed");
			await refused(() => evil.user.getOrCreate([uid], { params: { token } }).me(), "origin_not_allowed");
			await good.platform.getOrCreate(["main"]).info();
			await good.user.getOrCreate([uid], { params: { token } }).me();

			webSocketOrigin = "http://evil.example";
			const conn = client.user.getOrCreate([uid], { params: { token } }).connect();
			conn.onError(() => undefined);
			try {
				await refused(() => withTimeout("an action over a rejected connection", conn.me(), 10_000), "origin_not_allowed");
			} finally {
				await conn.dispose().catch(() => undefined);
			}
			webSocketOrigin = "http://127.0.0.1:5173";
			const allowed = client.user.getOrCreate([uid], { params: { token } }).connect();
			try {
				await withTimeout("an action over an allowed connection", allowed.me(), 10_000);
			} finally {
				await allowed.dispose().catch(() => undefined);
			}
		} finally {
			webSocketOrigin = null;
			await evil.dispose().catch(() => undefined);
			await good.dispose().catch(() => undefined);
		}
		return "http actions and WebSocket, allowed and not";
	});

	// --- sessions ---------------------------------------------------------------------------------

	const userConn = userHandle.connect();
	const sessionLists: SessionSummary[][] = [];
	userConn.on("sessions", (list: unknown) => {
		sessionLists.push(list as SessionSummary[]);
	});
	await userConn.me();

	await check("createSession refuses bad input", async () => {
		await refused(() => userConn.createSession({ profile: "nope" as never }), "bad_profile");
		await refused(() => userConn.createSession({ profile: "e2b" }), "profile_unavailable");
		await refused(() => userConn.createSession({ profile: availableProfile as never, model: "gpt-nope" }), "bad_model");
		for (const repoUrl of ["https://user:secret@github.com/a/b.git", "https://token@github.com/a/b.git", "http://github.com/a/b.git", "git@github.com:a/b.git", "https://github.com/a/b.git; rm -rf /", "--upload-pack=x"]) {
			await refused(() => userConn.createSession({ profile: availableProfile as never, repoUrl }), "bad_repo_url");
		}
		assert((await userConn.listSessions()).length === 0, "a refused createSession left a session behind");
		return "profile, model, repository address";
	});

	let session: SessionSummary | null = null;
	await check("createSession", async () => {
		const before = sessionLists.length;
		const created = await userConn.createSession({ profile: availableProfile as never });
		assert(/^s_[0-9a-f]{16}$/.test(created.id), `id is ${created.id}`);
		assert(created.title === "New agent" && created.status === "idle" && created.turns === 0 && created.sandbox === "none", `summary is ${plain(created)}`);
		assert(created.model === models[0], `model is ${created.model}, expected the default ${models[0]}`);
		session = created;
		const list = await waitFor("the sessions event", () => (sessionLists.length > before ? sessionLists.at(-1) : undefined), 5_000);
		assert(list.length === 1 && list[0].id === created.id, `sessions event carried ${plain(list.map((entry) => entry.id))}`);
		assert(plain(await userConn.listSessions()) === plain([created]), "listSessions differs from the created summary");
		return `${created.id} on ${created.profile}`;
	});
	if (!session) throw new Error("no session: the remaining checks cannot run");
	const first: SessionSummary = session;
	const sid = first.id;

	await check("auth: user B cannot reach user A's session", async () => {
		await refused(() => client.agentSession.get([uid, sid], { params: { token: userB.token } }).snapshot(), "forbidden");
		await refused(() => client.agentSession.get([uid, sid]).snapshot(), "unauthorized");
		await refused(() => client.agentSession.get([uid, sid], { params: { token } }).internalDestroy(), "forbidden");
		await refused(() => client.agentSession.get([uid, sid], { params: { token } }).internalRename("hijacked"), "forbidden");
		return "snapshot, internalDestroy, internalRename";
	});

	const watch = new Watch(client, uid, sid, token);
	const sessionHandle = client.agentSession.get([uid, sid], { params: { token } });

	await check("snapshot of a new session", async () => {
		const snapshot = await watch.conn.snapshot();
		assert(snapshot.timeline.length === 0 && snapshot.pending.length === 0, "a new session has a timeline");
		assert(snapshot.question === null, "a new session has a pending question");
		assert(snapshot.profile.id === first.profile && snapshot.windlassSessionId === null, "profile or windlassSessionId is off");
		assert(plain(await watch.conn.changes()) === "[]" && (await watch.conn.diff()) === "", "changes/diff are not empty without a sandbox");
		return "empty timeline; changes() and diff() empty without a sandbox";
	});

	await check("prompt refuses bad input", async () => {
		await refused(() => watch.conn.prompt({ text: "   " }), "empty_prompt");
		await refused(() => watch.conn.prompt({ text: "x".repeat(MAX_PROMPT_CHARS + 1) }), "prompt_too_long");
		await refused(() => watch.conn.prompt({ text: "hello", effort: "extreme" }), "bad_effort");
		await refused(() => watch.conn.prompt({ text: "hello", model: "gpt-nope" }), "bad_model");
		assert(watch.items.length === 0, "a refused prompt left items in the timeline");
		return "empty, too long, effort, model";
	});

	// --- first turn -------------------------------------------------------------------------------

	const promptOne = "Write a small Python program that prints prime numbers, then run it";
	await check("prompt: returns at once and the turn streams to its end", async () => {
		const started = Date.now();
		const { turn, steered } = await watch.conn.prompt({ text: promptOne, effort: "low" });
		const took = Date.now() - started;
		assert(turn === 1 && steered === false, `prompt() returned ${plain({ turn, steered })}`);
		const ended = await watch.untilEnded(1);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		assert(took < 15_000, `prompt() took ${took} ms to return`);
		return `prompt() returned in ${took} ms; turn took ${Date.now() - started} ms; ${watch.items.length} items, ${watch.deltas.length} deltas; exit code ${ended.exitCode}, steps ${ended.steps}`;
	});
	await check("prompt: items arrive in seq order, deltas in between", async () => {
		dense(watch.items);
		const [user] = watch.items;
		assert(user.kind === "user" && user.text === promptOne && user.effort === "low" && user.turn === 1, `first item is ${plain(user).slice(0, 200)}`);
		assert(watch.items.at(-1)?.kind === "turn.ended", "the last item is not turn.ended");
		assert(watch.items.filter((item) => item.kind === "turn.ended").length === 1, "more than one turn.ended");
		assert(watch.items.some((item) => item.kind === "platform" && item.text === "Creating sandbox"), 'no "Creating sandbox" item');
		const windlass = watch.items.filter((item) => item.kind === "windlass");
		assert(windlass.length > 5, `only ${windlass.length} windlass items`);
		assert(watch.deltas.length > 0, "no delta events");
		assert(watch.deltas.every((delta) => delta.turn === 1 && ["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"].includes(delta.event.type)), "a delta of another kind or turn");
		assert(!windlass.some((item) => item.kind === "windlass" && ["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"].includes(item.event.type)), "a delta was stored as an item");
		const firstDelta = watch.order.indexOf("d");
		const lastDelta = watch.order.lastIndexOf("d");
		assert(firstDelta > watch.order.indexOf("i1") && lastDelta < watch.order.length - 1, "deltas arrived outside the turn's items");

		// Each finished text must equal the deltas that streamed before it, which holds only if nothing was lost or reordered.
		let texts = 0;
		const streamed = new Map<string, string>();
		let cursor = 0;
		for (const entry of watch.order) {
			if (entry === "d") {
				const { event } = watch.deltas[cursor];
				cursor += 1;
				if (event.type === "text.delta") streamed.set(String(event.messageId), (streamed.get(String(event.messageId)) ?? "") + String(event.text));
				continue;
			}
			const item = watch.items.find((candidate) => `i${candidate.seq}` === entry);
			if (item?.kind === "windlass" && item.event.type === "text.ended") {
				const messageId = String(item.event.data?.messageId);
				assert(streamed.get(messageId) === item.event.data?.text, `text.ended of ${messageId} differs from its deltas`);
				streamed.delete(messageId);
				texts += 1;
			}
		}
		assert(texts > 0, "no text.ended to compare with its deltas");
		return `${windlass.length} windlass items, ${texts} texts equal to their deltas, statuses ${watch.statuses()}`;
	});
	await check("prompt: summary follows the turn", async () => {
		const last = watch.summaries.at(-1);
		assert(last, "no summary event");
		assert(watch.statuses() === "starting > running > idle", `statuses were ${watch.statuses()}`);
		assert(last.turns === 1 && last.lastOutcome === "succeeded" && last.sandbox === "running", `summary is ${plain(last)}`);
		assert(last.title.startsWith("Write a small Python program") && last.title !== "New agent", `title is "${last.title}"`);
		assert(last.updatedAt > first.updatedAt, "updatedAt did not move");
		const listed = await waitFor("the user's list to show the turn", async () => {
			const [entry] = await userConn.listSessions();
			return entry.turns === 1 && entry.status === "idle" ? entry : undefined;
		}, 5_000);
		assert(plain(listed) === plain(last), `user's list has ${plain(listed)}`);
		assert(sessionLists.some((list) => list[0]?.status !== "idle"), "the user's sessions event never showed the session as busy");
		return `title "${last.title}"; the user's list followed`;
	});

	let afterOne: SessionSnapshot | null = null;
	await check("snapshot returns the same timeline", async () => {
		const snapshot = await sessionHandle.snapshot();
		assert(plain(snapshot.timeline) === plain(watch.items), `snapshot has ${snapshot.timeline.length} items, the events gave ${watch.items.length}`);
		assert(snapshot.pending.length === 0, "pending is not empty after the turn");
		assert(typeof snapshot.windlassSessionId === "string" && snapshot.windlassSessionId.startsWith("ses_"), `windlassSessionId is ${snapshot.windlassSessionId}`);
		assert(plain(snapshot.summary) === plain(watch.summaries.at(-1)), "snapshot.summary differs from the last summary event");
		afterOne = snapshot;
		return `${snapshot.timeline.length} items, ${snapshot.windlassSessionId}`;
	});

	await check("changes and diff show the workspace", async () => {
		const changes = await watch.conn.changes();
		assert(changes.length > 0, "no changed files after a turn that writes one");
		assert(changes.every((file) => file.status.length === 2 && file.path !== ""), `odd entries: ${plain(changes)}`);
		const diff = await watch.conn.diff();
		assert(diff.includes(`+++ b/${changes[0].path}`), `the diff does not mention ${changes[0].path}`);
		return `${changes.map((file) => `${file.status} ${file.path}`).join(", ")}; diff ${diff.length} chars`;
	});

	// --- second turn ------------------------------------------------------------------------------

	await check("a second prompt continues the session", async () => {
		const { turn } = await watch.conn.prompt({ text: "Explore the workspace and describe what is there" });
		assert(turn === 2, `turn is ${turn}`);
		const ended = await watch.untilEnded(2);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		dense(watch.items);
		const second = watch.items.filter((item) => item.turn === 2);
		assert(second[0].kind === "user" && second.at(-1)?.kind === "turn.ended", "turn 2 does not run from its user item to its turn.ended");
		assert(!second.some((item) => item.kind === "platform" && item.text === "Creating sandbox"), "turn 2 created a sandbox again");
		const snapshot = await sessionHandle.snapshot();
		assert(snapshot.windlassSessionId === afterOne?.windlassSessionId, `Windlass session changed from ${afterOne?.windlassSessionId} to ${snapshot.windlassSessionId}`);
		assert(plain(snapshot.timeline) === plain(watch.items), "snapshot differs from the events");
		assert(snapshot.summary.turns === 2 && snapshot.summary.title === watch.summaries[0].title, "turns or title are off");
		const sessionIds = new Set(second.flatMap((item) => (item.kind === "windlass" && typeof item.event.sessionId === "string" ? [item.event.sessionId] : [])));
		assert(sessionIds.size === 1 && sessionIds.has(String(afterOne?.windlassSessionId)), `turn 2's events carry sessions ${[...sessionIds].join(", ")}`);
		return `${second.length} items in turn 2, same Windlass session, title unchanged`;
	});

	// --- stop -------------------------------------------------------------------------------------

	// (A second prompt during a turn used to be refused here. It steers the turn now: see the steering checks.)
	await check("a snapshot taken mid-turn carries what streamed; stop() ends the turn as interrupted", async () => {
		const deltasBefore = watch.deltas.length;
		const { turn, steered } = await watch.conn.prompt({ text: "Fix the failing test (slow)" });
		assert(turn === 3 && steered === false, `prompt() returned ${plain({ turn, steered })}`);

		// A client that connects now must be able to catch up: what streamed so far is in `pending`.
		await waitFor("the turn to stream", () => watch.deltas.length > deltasBefore, TURN_MS);
		let sawPending = 0;
		// Texts arrive whole in the demo, so what stays pending for a while is a running command's output:
		// keep looking until one shows, for as long as the turn runs.
		for (let tries = 0; tries < 400 && sawPending === 0; tries += 1) {
			const live = await sessionHandle.snapshot();
			assert(live.pending.every((delta) => delta.turn === 3), "pending holds deltas of another turn");
			if (live.summary.status === "idle") break;
			sawPending = live.pending.length;
			if (sawPending === 0) await sleep(40);
		}
		assert(sawPending > 0, "no snapshot taken during the turn had anything in pending");

		await watch.conn.stop();
		const ended = await watch.untilEnded(3);
		assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		assert(watch.summaries.some((summary) => summary.status === "stopping"), "status never became stopping");
		assert(watch.items.filter((item) => item.turn === 3 && item.kind === "user").length === 1, "turn 3 has more than its one user item");
		const after = await sessionHandle.snapshot();
		assert(after.pending.length === 0 && after.question === null && after.summary.status === "idle" && after.summary.lastOutcome === "interrupted", `after the stop: ${plain(after.summary)}`);
		await watch.conn.stop();
		return `${sawPending} deltas pending mid-turn; statuses ${watch.statuses()}`;
	});
	await check("the session works after a stop", async () => {
		const { turn } = await watch.conn.prompt({ text: "Write a short program" });
		const ended = await watch.untilEnded(turn);
		assert(turn === 4 && ended.outcome === "succeeded", `turn ${turn} ended ${ended.outcome}: ${ended.message ?? ""}`);
		dense(watch.items);
		return `turn ${turn} ${ended.outcome}`;
	});

	// --- rename -----------------------------------------------------------------------------------

	await check("rename", async () => {
		const lists = sessionLists.length;
		const summaries = watch.summaries.length;
		await refused(() => userConn.renameSession(sid, "   "), "bad_title");
		await refused(() => userConn.renameSession("s_0000000000000000", "x"), "session_not_found");
		const renamed = await userConn.renameSession(sid, "  Primes,   renamed ");
		assert(renamed.title === "Primes, renamed", `title is "${renamed.title}"`);
		const event = await waitFor("the session's summary event", () => (watch.summaries.length > summaries ? watch.summaries.at(-1) : undefined), 5_000);
		assert(event.title === "Primes, renamed", "the session's summary event has another title");
		const list = await waitFor("the user's sessions event", () => (sessionLists.length > lists ? sessionLists.at(-1) : undefined), 5_000);
		assert(list.find((entry) => entry.id === sid)?.title === "Primes, renamed", "the sessions event has another title");
		const long = await userConn.renameSession(sid, "x".repeat(200));
		assert(long.title.length === 80, `a long title was kept at ${long.title.length} characters`);
		await userConn.renameSession(sid, "Primes, renamed");
		return "trimmed, announced on both actors, capped at 80";
	});

	// --- sleep and wake ---------------------------------------------------------------------------

	const beforeSleep = watch.items.slice();
	await check("the timeline survives an actor sleep and wake", async () => {
		await watch.conn.dispose();
		await forceSleep(sid);
		await sleep(2_500);
		const woken = await sessionHandle.snapshot();
		assert(plain(woken.timeline) === plain(beforeSleep), `after waking the timeline has ${woken.timeline.length} items, before ${beforeSleep.length}`);
		assert(woken.summary.sandbox === "paused", `the sandbox is "${woken.summary.sandbox}" after a sleep, expected "paused"`);
		assert(woken.summary.status === "idle" && woken.summary.title === "Primes, renamed" && woken.summary.turns === 4, `summary after waking: ${plain(woken.summary)}`);
		assert(woken.windlassSessionId === afterOne?.windlassSessionId, "windlassSessionId was lost");
		const listed = await waitFor("the user's list to show the paused sandbox", async () => {
			const entry = (await userConn.listSessions()).find((candidate) => candidate.id === sid);
			return entry?.sandbox === "paused" ? entry : undefined;
		}, 5_000);
		return `${woken.timeline.length} items intact; sandbox ${listed.sandbox}`;
	});

	const watchTwo = new Watch(client, uid, sid, token);
	await check("a prompt after waking resumes the sandbox and keeps counting", async () => {
		const { turn } = await watchTwo.conn.prompt({ text: "Explore the workspace again" });
		assert(turn === 5, `turn is ${turn}`);
		const ended = await watchTwo.untilEnded(5);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		dense(watchTwo.items, beforeSleep.length + 1);
		assert(watchTwo.items.some((item) => item.kind === "platform" && item.text === "Resuming sandbox"), 'no "Resuming sandbox" item');
		assert(watchTwo.summaries.at(-1)?.sandbox === "running", "the sandbox is not running after the turn");
		const snapshot = await sessionHandle.snapshot();
		assert(plain(snapshot.timeline) === plain([...beforeSleep, ...watchTwo.items]), "snapshot differs from what was seen before and after the sleep");
		return `seq continued at ${beforeSleep.length + 1}; same files: ${(await watchTwo.conn.changes()).length} changed`;
	});

	await check("an actor shutdown during a turn stops the turn and closes it as interrupted", async () => {
		const { turn } = await watchTwo.conn.prompt({ text: "Fix the failing test (slow)" });
		await waitFor("the turn to stream", () => watchTwo.deltas.some((delta) => delta.turn === turn), TURN_MS);
		await forceSleep(sid);
		// The connection drops with the actor and the client reconnects, which wakes it again.
		const snapshot = await waitFor(
			"the turn to be closed",
			async () => {
				const now = await sessionHandle.snapshot().catch(() => undefined);
				return now && now.summary.status === "idle" && now.timeline.at(-1)?.turn === turn && now.timeline.at(-1)?.kind === "turn.ended" ? now : undefined;
			},
			60_000,
			300,
		);
		const last = snapshot.timeline.at(-1);
		assert(last?.kind === "turn.ended" && last.outcome === "interrupted", `the turn ended as ${plain(last).slice(0, 200)}`);
		assert(!snapshot.timeline.some((item) => item.turn === turn && item.kind === "platform" && item.level === "warn"), "the turn was closed by the recovery on wake, not by the shutdown itself");
		assert(snapshot.pending.length === 0 && snapshot.summary.lastOutcome === "interrupted", `summary is ${plain(snapshot.summary)}`);
		dense(snapshot.timeline);
		return `turn ${turn} interrupted by the shutdown; ${snapshot.timeline.length} items`;
	});

	// --- a server that dies mid-turn --------------------------------------------------------------

	const askedBeforeCrash: { id: string; turn: number; questionId: string; problem: string | null } = { id: "", turn: 0, questionId: "", problem: "the crash check did not get that far" };

	if (server) {
		await check("a turn lost to a server crash is closed as interrupted on wake", async () => {
			const { turn } = await watchTwo.conn.prompt({ text: "Fix the failing test (slow)" });
			await waitFor("the turn to stream", () => watchTwo.deltas.some((delta) => delta.turn === turn), TURN_MS);
			const seen = watchTwo.items.length;
			// A second session, waiting on a question when the server dies: see the check after this one.
			try {
				const created = await userConn.createSession({ profile: availableProfile as never, title: "Asked before the crash" });
				askedBeforeCrash.id = created.id;
				const handle = client.agentSession.get([uid, created.id], { params: { token } });
				askedBeforeCrash.turn = (await handle.prompt({ text: ASK })).turn;
				askedBeforeCrash.questionId = (await waitFor("the question before the crash", async () => (await handle.snapshot()).question, TURN_MS, 100)).id;
				askedBeforeCrash.problem = null;
			} catch (error) {
				askedBeforeCrash.problem = describe(error);
			}
			await watchTwo.conn.dispose().catch(() => undefined);
			await userConn.dispose().catch(() => undefined);
			await server.crash();
			await server.start({ WLP_LOGIN_TTL_MS: String(SHORT_LOGIN_TTL_MS) });
			loginTtlMs = SHORT_LOGIN_TTL_MS;

			const snapshot = await withTimeout("the first snapshot after the restart", sessionHandle.snapshot(), 90_000);
			const last = snapshot.timeline.at(-1);
			assert(last?.kind === "turn.ended" && last.turn === turn && last.outcome === "interrupted", `the last item is ${plain(last).slice(0, 200)}`);
			assert(snapshot.timeline.some((item) => item.turn === turn && item.kind === "platform" && item.level === "warn"), "no warning item about the lost turn");
			assert(snapshot.summary.status === "idle" && snapshot.summary.lastOutcome === "interrupted", `summary is ${plain(snapshot.summary)}`);
			dense(snapshot.timeline);
			assert(snapshot.pending.length === 0, "pending survived a restart");
			const listed = await waitFor("the user's list to show the session idle", async () => {
				const entry = (await userHandle.listSessions()).find((candidate) => candidate.id === sid);
				return entry?.status === "idle" ? entry : undefined;
			}, 10_000, 200);
			return `${snapshot.timeline.length} items (${seen + beforeSleep.length} seen before the crash); the user's list shows ${listed.status}`;
		});

		await check("a question pending when the server died is gone on wake, and its turn is closed as interrupted", async () => {
			const lost = askedBeforeCrash;
			assert(lost.problem === null, `no session was waiting on a question before the crash: ${lost.problem}`);
			const handle = client.agentSession.get([uid, lost.id], { params: { token } });
			const snapshot = await withTimeout("the first snapshot after the restart", handle.snapshot(), 90_000);
			assert(snapshot.question === null, `a question survived the restart: ${plain(snapshot.question)}`);
			const last = snapshot.timeline.at(-1);
			assert(last?.kind === "turn.ended" && last.turn === lost.turn && last.outcome === "interrupted", `the last item is ${plain(last).slice(0, 200)}`);
			assert(snapshot.summary.status === "idle" && snapshot.summary.lastOutcome === "interrupted", `summary is ${plain(snapshot.summary)}`);
			assert(snapshot.timeline.some((item) => item.kind === "windlass" && item.event.type === "approval.requested"), "the question's approval.requested is not in the timeline");
			dense(snapshot.timeline);
			await refused(() => handle.answer({ questionId: lost.questionId, choice: "once" }), "no_question");
			const listed = await waitFor("the user's list to show the session idle", async () => {
				const entry = (await userHandle.listSessions()).find((candidate) => candidate.id === lost.id);
				return entry?.status === "idle" ? entry : undefined;
			}, 10_000, 200);
			return `status ${listed.status}, no question, an answer is refused with no_question`;
		});
		if (askedBeforeCrash.id) await userHandle.deleteSession(askedBeforeCrash.id).catch(() => undefined);

		const watchThree = new Watch(client, uid, sid, token);
		await check(FAKE ? "a sandbox that is gone is replaced, with a warning" : "the session works after a server crash", async () => {
			const { turn } = await watchThree.conn.prompt({ text: "Write a short program" });
			const ended = await watchThree.untilEnded(turn);
			assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			if (FAKE) {
				// The fake layer's sandboxes lived in the server that was killed.
				const warning = watchThree.items.find((item) => item.kind === "platform" && item.level === "warn");
				assert(warning?.kind === "platform" && warning.text.includes("no longer exists"), "no warning that the earlier sandbox is gone");
				assert(watchThree.items.some((item) => item.kind === "platform" && item.text === "Creating sandbox"), "no new sandbox was created");
			}
			return `turn ${turn} ${ended.outcome}`;
		});
		await watchThree.conn.dispose().catch(() => undefined);
	} else {
		skip("a turn lost to a server crash is closed as interrupted on wake", "needs its own server");
		skip("a question pending when the server died is gone on wake, and its turn is closed as interrupted", "needs its own server");
		await watchTwo.conn.dispose().catch(() => undefined);
		await userConn.dispose().catch(() => undefined);
	}

	// --- delete -----------------------------------------------------------------------------------

	const userConnTwo = userHandle.connect();
	const listsTwo: SessionSummary[][] = [];
	userConnTwo.on("sessions", (list: unknown) => {
		listsTwo.push(list as SessionSummary[]);
	});
	await userConnTwo.me();

	await check("delete", async () => {
		const created = server ? [...server.output.matchAll(/\[wlp\] sandbox\.created id=(\S+) session=(\S+)/g)].filter((match) => match[2] === sid).map((match) => match[1]) : [];
		const current = created.at(-1);
		if (!FAKE && current) assert(sandboxContainers().includes(`wlp-session-${current}`), `container wlp-session-${current} does not exist before the delete`);
		await refused(() => userConnTwo.deleteSession("s_0000000000000000"), "session_not_found");
		await userConnTwo.deleteSession(sid);
		const list = await waitFor("the sessions event", () => listsTwo.at(-1), 5_000);
		assert(!list.some((entry) => entry.id === sid), "the sessions event still lists the session");
		assert(!(await userConnTwo.listSessions()).some((entry) => entry.id === sid), "listSessions still lists the session");
		await refused(() => sessionHandle.snapshot(), ["not_found", "session_not_found", "destroying", "destroyed"]);
		await refused(() => userConnTwo.deleteSession(sid), "session_not_found");

		if (!server) return "session and actor gone (sandbox not checked: needs the server's output)";
		assert(current, "the server never logged a sandbox for this session");
		await waitFor("the sandbox to be destroyed", () => server.output.includes(`[wlp] sandbox.destroyed id=${current} session=${sid}`), 20_000, 100);
		if (!FAKE) assert(!sandboxContainers().includes(`wlp-session-${current}`), `container wlp-session-${current} still exists`);
		return `session, actor and sandbox ${current} gone${FAKE ? "" : " (docker ps agrees)"}`;
	});

	// --- a real clone (Docker layer, on request: it needs the network) ----------------------------

	const repo = process.env.WLP_E2E_REPO;
	if (!FAKE && repo) {
		await check("a repository is cloned into the workspace", async () => {
			const cloned = await userConnTwo.createSession({ profile: availableProfile as never, repoUrl: repo });
			const clonedWatch = new Watch(client, uid, cloned.id, token);
			try {
				await clonedWatch.conn.snapshot();
				const { turn } = await clonedWatch.conn.prompt({ text: "Explore the workspace and write notes" });
				const ended = await clonedWatch.untilEnded(turn);
				assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				assert(clonedWatch.items.some((item) => item.kind === "platform" && item.text === `Cloning ${cloned.repoUrl}`), 'no "Cloning" item');
				const changes = await clonedWatch.conn.changes();
				const diff = await clonedWatch.conn.diff();
				// The repository's own files are committed, so only what the agent wrote shows up.
				assert(changes.length >= 1 && changes.length <= 3, `changes are ${plain(changes)}`);
				assert(diff.includes("README"), "the agent's notes do not list the repository's README");
				return `${cloned.repoUrl}: ${changes.map((file) => `${file.status} ${file.path}`).join(", ")}`;
			} finally {
				await clonedWatch.conn.dispose().catch(() => undefined);
				await userConnTwo.deleteSession(cloned.id).catch(() => undefined);
			}
		});
	} else {
		skip("a repository is cloned into the workspace", FAKE ? "the fake layer clones nothing; its Cloning step is checked below" : "set WLP_E2E_REPO to an https git address to run it");
	}

	// --- questions --------------------------------------------------------------------------------

	const asking = await userConnTwo.createSession({ profile: availableProfile as never, title: "Questions" });
	const askWatch = new Watch(client, uid, asking.id, token);
	const askHandle = client.agentSession.get([uid, asking.id], { params: { token } });
	await askWatch.conn.snapshot();
	/** The question of the first turn, which the next few checks look at before one of them answers it. */
	const first_: { question: PendingQuestion | null } = { question: null };
	const pendingQuestion = (): PendingQuestion => {
		assert(first_.question, "no question is pending: the check that asks one failed");
		return first_.question;
	};
	/** Starts a turn that asks, and returns its question once it is announced. */
	const ask = async (): Promise<PendingQuestion> => {
		await waitFor("the session to be idle", () => askWatch.summaries.length === 0 || askWatch.summaries.at(-1)?.status === "idle", TURN_MS);
		const { turn, steered } = await askWatch.conn.prompt({ text: ASK });
		assert(steered === false, "the prompt steered a turn instead of starting one");
		const asked = await askWatch.untilQuestion(turn);
		// The question is announced first, then the summary that says the session waits.
		await waitFor("the summary event to say waiting", () => askWatch.summaries.at(-1)?.status === "waiting", 5_000);
		return asked;
	};
	const settledOf = (question: PendingQuestion) => askWatch.ofCall(question.turn, "tool.settled", question).at(-1);
	const answeredOf = (question: PendingQuestion) => askWatch.ofCall(question.turn, "approval.answered", question);

	await check("a question is asked: the session waits, the question is announced and is in the snapshot", async () => {
		const asked = await ask();
		assert(/^q_[0-9a-f]{16}$/.test(asked.id) && asked.turn === 1, `the question's id or turn is off: ${plain(asked).slice(0, 200)}`);
		assert(asked.title !== "" && asked.subject !== "" && asked.messageId !== "" && asked.callId !== "", `the question lacks a field: ${plain(asked).slice(0, 300)}`);
		assert(Array.isArray(asked.details) && asked.details.every((detail) => typeof detail === "string"), "details is not a list of sentences");
		assert(asked.choices.some((choice) => choice.id === "once" && choice.approve) && asked.choices.some((choice) => choice.id === "deny" && !choice.approve), `choices are ${plain(asked.choices)}`);
		assert(asked.choices.every((choice) => choice.label !== "" && (choice.remembers === null || (typeof choice.remembers === "string" && choice.remembers !== ""))), `a choice is malformed: ${plain(asked.choices)}`);
		assert(asked.subagent === null, `subagent is ${plain(asked.subagent)}`);
		assert(Math.abs(Date.now() - asked.askedAt) < 60_000 && asked.expiresAt > asked.askedAt, "askedAt or expiresAt is off");
		if (OWN_SERVER) assert(asked.expiresAt - asked.askedAt === QUESTION_MS, `the question expires after ${asked.expiresAt - asked.askedAt} ms, the server was started with ${QUESTION_MS}`);
		first_.question = asked;

		await waitFor("the summary event to say waiting", () => askWatch.summaries.at(-1)?.status === "waiting", 5_000);
		const requested = await waitFor("the approval.requested item", () => askWatch.ofCall(asked.turn, "approval.requested", asked).at(-1), 5_000);
		assert(askWatch.ofCall(asked.turn, "tool.called", asked).length === 1, "the question's call is not the one tool.called names");
		const snapshot = await askHandle.snapshot();
		assert(plain(snapshot.question) === plain(asked), `snapshot().question is ${plain(snapshot.question).slice(0, 200)}`);
		assert(snapshot.summary.status === "waiting", `snapshot().summary.status is ${snapshot.summary.status}`);
		assert(snapshot.timeline.some((item) => item.seq === requested.seq), "the snapshot's timeline lacks the approval.requested item");
		await waitFor("the user's list to show the session waiting", async () => (await userConnTwo.listSessions()).find((entry) => entry.id === asking.id && entry.status === "waiting"), 5_000);
		assert(askWatch.questions.length === 1, `${askWatch.questions.length} question events arrived`);
		return `"${asked.title}" about \`${asked.subject}\`; choices ${asked.choices.map((choice) => choice.id).join(", ")}; statuses ${askWatch.statuses()}; the user's list says waiting`;
	});

	await check("a client that connects while a question is pending sees it", async () => {
		const asked = pendingQuestion();
		const late = new Watch(client, uid, asking.id, token);
		try {
			const snapshot = await late.conn.snapshot();
			assert(plain(snapshot.question) === plain(asked), `the late client's snapshot has question ${plain(snapshot.question).slice(0, 200)}`);
			assert(snapshot.summary.status === "waiting", `the late client's snapshot says ${snapshot.summary.status}`);
			assert(snapshot.timeline.some((item) => item.kind === "windlass" && item.event.type === "approval.requested" && item.event.data?.callId === asked.callId), "its timeline lacks the approval.requested item");
		} finally {
			await late.conn.dispose().catch(() => undefined);
		}
		return `question ${asked.id}, status waiting`;
	});

	// User B listens on user A's session from here until the question has been answered.
	const intruder = client.agentSession.get([uid, asking.id], { params: { token: userB.token } });
	const intruderConn = intruder.connect();
	const overheard: unknown[] = [];
	intruderConn.onError(() => undefined);
	for (const name of ["question", "summary", "item"] as const) intruderConn.on(name, (payload: unknown) => overheard.push(payload));
	await check("user B cannot answer, stop a call of, or steer user A's session", async () => {
		const asked = pendingQuestion();
		await refused(() => intruder.answer({ questionId: asked.id, choice: "once" }), "forbidden");
		await refused(() => intruder.stopCall({ messageId: asked.messageId, callId: asked.callId }), "forbidden");
		await refused(() => intruder.prompt({ text: "A message from user B" }), "forbidden");
		await refused(() => client.agentSession.get([uid, asking.id]).answer({ questionId: asked.id, choice: "once" }), "unauthorized");
		await refused(() => client.agentSession.get([uid, asking.id], { params: { token: `${token}x` } }).stopCall({ messageId: asked.messageId, callId: asked.callId }), "invalid_token");
		await refused(() => withTimeout("an action over user B's connection", intruderConn.answer({ questionId: asked.id, choice: "deny" }), 10_000), "forbidden");
		const snapshot = await askHandle.snapshot();
		assert(snapshot.question?.id === asked.id && snapshot.summary.status === "waiting", "the question did not stay pending");
		assert(!snapshot.timeline.some((item) => item.kind === "user" && item.text === "A message from user B"), "user B's message is in the timeline");
		return "answer, stopCall and prompt: forbidden; no token: unauthorized; a bad token: invalid_token";
	});

	await check("an unknown question id or a choice the question lacks is refused", async () => {
		const asked = pendingQuestion();
		const unknown = await refused(() => askWatch.conn.answer({ questionId: "q_0000000000000000", choice: "once" }), "no_question");
		const lacking = await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "always" }), "bad_choice");
		await refused(() => askWatch.conn.answer({ questionId: asked.id } as never), "bad_answer");
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "deny", note: 7 } as never), "bad_answer");
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "deny", note: "x".repeat(MAX_PROMPT_CHARS + 1) }), "note_too_long");
		const snapshot = await askHandle.snapshot();
		assert(snapshot.question?.id === asked.id && snapshot.summary.status === "waiting", "a refused answer settled the question");
		assert(askWatch.questions.length === 1, "a refused answer was announced");
		return `unknown id: "${unknown}"; missing choice: "${lacking}"`;
	});

	await check("allow once: the call runs, and the status returns to running and then idle", async () => {
		const asked = pendingQuestion();
		await askWatch.conn.answer({ questionId: asked.id, choice: "once" });
		await waitFor("the question event to say null", () => askWatch.questions.at(-1) === null, 5_000);
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		const [answered] = answeredOf(asked);
		assert(answered && answered.event.data?.choice === "once" && answered.event.data.approve === true, `approval.answered is ${plain(answered?.event.data)}`);
		assert(answeredOf(asked).length === 1, "the call was answered more than once");
		const [started] = askWatch.ofCall(asked.turn, "tool.started", asked);
		assert(started && started.seq > answered.seq, "the call did not start after the answer");
		const settled = settledOf(asked);
		assert(settled && settled.seq > started.seq && !String(settled.event.data?.output).includes("declined"), `the call settled as ${plain(settled?.event.data).slice(0, 200)}`);
		assert(askWatch.statuses() === "starting > running > waiting > running > idle", `statuses were ${askWatch.statuses()}`);
		assert(askWatch.questions.length === 2, `${askWatch.questions.length} question events arrived for one question`);
		const snapshot = await askHandle.snapshot();
		assert(snapshot.question === null && snapshot.summary.status === "idle" && snapshot.summary.turns === 1, `after the turn: ${plain(snapshot.summary)}`);
		assert(plain(snapshot.timeline) === plain(askWatch.items), "the snapshot differs from the events");
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
		dense(askWatch.items);
		return `the call settled ${settled.event.data?.outcome}; statuses ${askWatch.statuses()}`;
	});

	await check("user B's connection received nothing of user A's question", async () => {
		// Every event of the turn above went to user A's connection; none may have reached user B's.
		assert(askWatch.questions.length >= 2 && askWatch.summaries.length > 0 && askWatch.items.length > 0, "user A's connection saw no events to compare with");
		await sleep(300);
		assert(overheard.length === 0, `user B's connection received ${overheard.length} events, the first: ${String(plain(overheard[0])).slice(0, 200)}`);
		return `user A saw ${askWatch.questions.length} question, ${askWatch.summaries.length} summary and ${askWatch.items.length} item events; user B none`;
	});
	await intruderConn.dispose().catch(() => undefined);

	await check("deny with a note: the call is not run and the note reaches the model", async () => {
		const asked = await ask();
		assert(asked.turn === 2 && asked.id !== first_.question?.id, `the second question is ${plain({ id: asked.id, turn: asked.turn })}`);
		await askHandle.answer({ questionId: asked.id, choice: "deny", note: "  not now, use the cached copy  " });
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		const [answered] = answeredOf(asked);
		assert(answered && answered.event.data?.choice === "deny" && answered.event.data.approve === false, `approval.answered is ${plain(answered?.event.data)}`);
		assert(answered.event.data.note === "not now, use the cached copy", `the note arrived as ${plain(answered.event.data.note)}`);
		assert(askWatch.ofCall(asked.turn, "tool.started", asked).length === 0, "the declined call was started");
		const settled = settledOf(asked);
		assert(settled && settled.event.data?.outcome === "error" && String(settled.event.data.output).includes("not now, use the cached copy"), `the call settled as ${plain(settled?.event.data).slice(0, 300)}`);
		assert(askWatch.questions.at(-1) === null && (await askHandle.snapshot()).question === null, "the question is still pending");
		return `the model was told: "${String(settled.event.data.output)}"`;
	});

	await check("two answers at once: exactly one is taken, the other is refused with no_question", async () => {
		const asked = await ask();
		const sent = ["deny", "once"];
		const results = await Promise.allSettled([askWatch.conn.answer({ questionId: asked.id, choice: sent[0] }), askHandle.answer({ questionId: asked.id, choice: sent[1] })]);
		const taken = results.flatMap((result, index) => (result.status === "fulfilled" ? [sent[index]] : []));
		const refusals = results.flatMap((result) => (result.status === "rejected" ? [(result.reason as { code?: unknown }).code] : []));
		assert(taken.length === 1 && refusals.length === 1 && refusals[0] === "no_question", `fulfilled: ${plain(taken)}; refused with: ${plain(refusals)}`);
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		const answers = answeredOf(asked);
		assert(answers.length === 1 && answers[0].event.data?.choice === taken[0], `Windlass recorded ${plain(answers.map((item) => item.event.data?.choice))}, the answer taken was ${taken[0]}`);
		return `"${taken[0]}" was taken; the other answer got no_question`;
	});

	if (OWN_SERVER) {
		await check("a question nobody answers is declined by the platform when its time is up", async () => {
			const asked = await ask();
			const from = askWatch.summaries.length - 1;
			await waitFor("the platform to decline the question", () => askWatch.questions.at(-1) === null, QUESTION_MS + 20_000);
			const waited = Date.now() - asked.askedAt;
			assert(waited >= QUESTION_MS - 200 && waited < QUESTION_MS + 10_000, `the question was settled after ${waited} ms; its time was ${QUESTION_MS} ms`);
			const ended = await askWatch.untilEnded(asked.turn);
			assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			const said = askWatch.items.find((item) => item.kind === "platform" && item.turn === asked.turn && item.text.includes("Nobody answered"));
			assert(said?.kind === "platform" && said.level === "warn", "no platform item says that nobody answered");
			const [answered] = answeredOf(asked);
			assert(answered && answered.event.data?.choice === "deny" && answered.event.data.approve === false && String(answered.event.data.note).includes("Nobody answered"), `approval.answered is ${plain(answered?.event.data)}`);
			assert(answered.seq > said.seq, "the platform's item does not come before the answer it explains");
			assert(askWatch.ofCall(asked.turn, "tool.started", asked).length === 0, "the call was started although nobody allowed it");
			assert(askWatch.statusesFrom(from) === "waiting > running > idle", `statuses from the question on were ${askWatch.statusesFrom(from)}`);
			await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
			return `declined after ${waited} ms: "${said.text}"; the model was told: "${String(answered.event.data.note)}"`;
		});
	} else {
		skip("a question nobody answers is declined by the platform when its time is up", "needs its own server, started with a short time for questions");
	}

	await check("stop() during a question withdraws it and ends the turn as interrupted", async () => {
		const asked = await ask();
		const from = askWatch.summaries.length - 1;
		await askWatch.conn.stop();
		await waitFor("the question event to say null", () => askWatch.questions.at(-1) === null, 10_000);
		const ended = await askWatch.untilEnded(asked.turn);
		assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		await refused(() => askWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
		assert(askWatch.ofCall(asked.turn, "tool.started", asked).length === 0, "the call was started although the turn was stopped");
		const snapshot = await askHandle.snapshot();
		assert(snapshot.question === null && snapshot.summary.status === "idle" && snapshot.summary.lastOutcome === "interrupted", `after the stop: ${plain(snapshot.summary)}`);
		assert(askWatch.statusesFrom(from) === "waiting > stopping > idle", `statuses from the question on were ${askWatch.statusesFrom(from)}`);
		return `statuses ${askWatch.statusesFrom(from)}; an answer afterwards is refused with no_question`;
	});

	await check("a question does not survive the actor's sleep", async () => {
		const asked = await ask();
		await forceSleep(asking.id);
		// The connection drops with the actor and the client reconnects, which wakes it again.
		const snapshot = await waitFor(
			"the turn to be closed",
			async () => {
				const now = await askHandle.snapshot().catch(() => undefined);
				return now && now.summary.status === "idle" && now.timeline.at(-1)?.turn === asked.turn && now.timeline.at(-1)?.kind === "turn.ended" ? now : undefined;
			},
			60_000,
			300,
		);
		const last = snapshot.timeline.at(-1);
		assert(last?.kind === "turn.ended" && last.outcome === "interrupted", `the turn ended as ${plain(last).slice(0, 200)}`);
		assert(snapshot.question === null, `a question survived the sleep: ${plain(snapshot.question)}`);
		assert(!snapshot.timeline.some((item) => item.turn === asked.turn && item.kind === "windlass" && item.event.type === "approval.answered"), "the question was answered by something");
		await refused(() => askHandle.answer({ questionId: asked.id, choice: "once" }), "no_question");
		dense(snapshot.timeline);
		return `turn ${asked.turn} interrupted by the shutdown; no question after waking`;
	});
	await askWatch.conn.dispose().catch(() => undefined);
	await userConnTwo.deleteSession(asking.id).catch(() => undefined);

	// --- steering a turn, stopping one call -------------------------------------------------------

	// A new session is `starting` for a while: the fake layer's clone of this address takes a second
	// and a half, and the Docker layer creates a container.
	const steering = await userConnTwo.createSession({ profile: availableProfile as never, repoUrl: FAKE ? "https://example.com/org/slow-clone.git" : undefined });
	const steerWatch = new Watch(client, uid, steering.id, token);
	await steerWatch.conn.snapshot();
	const STEER = "Also, keep the report short.";
	const longCall = { messageId: "", callId: "" };

	await check("a message sent while the turn is starting is refused; one sent while it runs steers it", async () => {
		const { turn, steered } = await steerWatch.conn.prompt({ text: LONG });
		assert(turn === 1 && steered === false, `prompt() returned ${plain({ turn, steered })}`);
		const early = await refused(() => steerWatch.conn.prompt({ text: "Too early" }), "turn_running");
		assert(/try again in a moment/i.test(early), `the refusal does not say to try again: "${early}"`);
		assert((await steerWatch.conn.snapshot()).summary.status === "starting", "the turn was not starting when the message was refused");

		const started = await waitFor("the long command to start", () => steerWatch.windlass(1, "tool.started")[0], TURN_MS);
		longCall.messageId = String(started.event.data?.messageId);
		longCall.callId = String(started.event.data?.callId);
		const titleBefore = steerWatch.summaries.at(-1)?.title;
		// `model` and `effort` are ignored for a steer, so values that a new turn would refuse do no harm.
		const reply = await steerWatch.conn.prompt({ text: `  ${STEER}  `, model: "gpt-nope", effort: "extreme" });
		assert(reply.turn === 1 && reply.steered === true, `the steer returned ${plain(reply)}`);
		const stored = await waitFor("the steer's user item", () => steerWatch.items.find((item) => item.kind === "user" && item.steer === true), 5_000);
		assert(stored.kind === "user" && stored.turn === 1 && stored.text === STEER, `the steer was stored as ${plain(stored)}`);
		const [opening] = steerWatch.items;
		assert(opening.kind === "user" && !opening.steer && opening.text === LONG, `the turn's first item is ${plain(opening).slice(0, 200)}`);
		assert(!steerWatch.items.some((item) => item.kind === "user" && item.text === "Too early"), "the refused message was stored");
		const textOf = (item: WindlassItem) => plain(item.event.data?.content);
		await waitFor("Windlass to take the message in", () => steerWatch.windlass(1, "inbox.enqueued").find((item) => textOf(item).includes(STEER)), 10_000);
		const summary = steerWatch.summaries.at(-1);
		assert(summary?.turns === 1 && summary.status === "running" && summary.title === titleBefore && summary.title.startsWith("Run the long build"), `after the steer the summary is ${plain(summary)}`);
		assert(!steerWatch.items.some((item) => item.kind === "turn.ended"), "the turn ended before it could be steered");
		return `refused while starting: "${early}"; then steered: turn ${reply.turn}, stored with steer: true, title and turn count unchanged`;
	});

	await check("stopCall stops the long command and the turn goes on to its end", async () => {
		assert(longCall.callId !== "", "no running call is known: the check before this one failed");
		const begun = steerWatch.windlass(1, "tool.started")[0].at;
		const other = await steerWatch.conn.stopCall({ messageId: longCall.messageId, callId: "call_that_does_not_exist" });
		assert(other.stopped === false && typeof other.message === "string" && other.message !== "", `stopping an unknown call returned ${plain(other)}`);
		await refused(() => steerWatch.conn.stopCall({ messageId: "", callId: longCall.callId }), "bad_call");
		const result = await steerWatch.conn.stopCall(longCall);
		assert(result.stopped === true, `stopCall returned ${plain(result)}`);
		const ended = await steerWatch.untilEnded(1);
		assert(ended.outcome === "succeeded", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
		assert(steerWatch.ofCall(1, "tool.cancel_requested", longCall).length === 1, "no tool.cancel_requested for the call");
		const settled = steerWatch.ofCall(1, "tool.settled", longCall).at(-1);
		assert(settled && settled.event.data?.outcome === "error" && /stopped/i.test(String(settled.event.data.output)), `the call settled as ${plain(settled?.event.data).slice(0, 300)}`);
		const ran = settled.at - begun;
		assert(ran < (FAKE ? 4_000 : 10_000), `the call ran for ${ran} ms: it was not stopped early`);
		// The steered message of the check before: delivered to the model at the step after the stopped call.
		const enqueued = steerWatch.windlass(1, "inbox.enqueued").find((item) => plain(item.event.data?.content).includes(STEER));
		const delivered = steerWatch.windlass(1, "inbox.delivered").find((item) => item.event.data?.messageId === enqueued?.event.data?.messageId);
		assert(enqueued && delivered && delivered.seq > settled.seq && delivered.seq < ended.seq, "the steered message was not delivered between the stopped call and the turn's end");
		assert(steerWatch.windlass(1, "step.started").some((item) => item.seq > delivered.seq), "no step followed the stopped call");
		assert(steerWatch.items.filter((item) => item.kind === "user").length === 2 && steerWatch.items.filter((item) => item.kind === "turn.ended").length === 1, "the steer made a turn of its own");
		assert(steerWatch.summaries.at(-1)?.turns === 1, `the session counts ${steerWatch.summaries.at(-1)?.turns} turns`);
		const idle = await refused(() => steerWatch.conn.stopCall(longCall), "no_turn");
		dense(steerWatch.items);
		const snapshot = await steerWatch.conn.snapshot();
		assert(plain(snapshot.timeline) === plain(steerWatch.items), "the snapshot differs from the events");
		return `an unknown call: "${other.message}"; the command was stopped after ${ran} ms and settled "${String(settled.event.data.output).split("\n").at(-1)}"; the steer was delivered next; with no turn: "${idle}"`;
	});

	if (FAKE) {
		await check("a message sent while the turn is stopping is refused", async () => {
			const { turn } = await steerWatch.conn.prompt({ text: "Wait for the slow build (slow) (slow-stop)" });
			await waitFor("the command to start", () => steerWatch.windlass(turn, "tool.started")[0], TURN_MS);
			await steerWatch.conn.stop();
			const late = await refused(() => steerWatch.conn.prompt({ text: "Too late" }), "turn_running");
			assert(/being stopped/.test(late) && /try again in a moment/i.test(late), `the refusal is "${late}"`);
			await refused(() => steerWatch.conn.prompt({ text: "   " }), "empty_prompt");
			const ended = await steerWatch.untilEnded(turn);
			assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
			assert(!steerWatch.items.some((item) => item.kind === "user" && item.text === "Too late"), "the refused message was stored");
			const again = await steerWatch.conn.prompt({ text: "Write a short program" });
			assert(again.turn === turn + 1 && again.steered === false, `the prompt after the stop returned ${plain(again)}`);
			assert((await steerWatch.untilEnded(again.turn)).outcome === "succeeded", "the turn after the stop did not succeed");
			return `"${late}"; the next prompt started turn ${again.turn}`;
		});
	} else {
		skip("a message sent while the turn is stopping is refused", "uses the fake layer's slow stop");
	}
	await steerWatch.conn.dispose().catch(() => undefined);
	await userConnTwo.deleteSession(steering.id).catch(() => undefined);

	// --- the limit on running sessions ------------------------------------------------------------

	if (FAKE) {
		await check(`at most ${MAX_RUNNING_SESSIONS} sessions of a user run at once`, async () => {
			const created: SessionSummary[] = [];
			for (let index = 0; index <= MAX_RUNNING_SESSIONS; index += 1) created.push(await userConnTwo.createSession({ profile: availableProfile as never, title: `limit ${index}` }));
			const handles = created.map((entry) => client.agentSession.get([uid, entry.id], { params: { token } }));
			// The first of them waits on a question: a waiting session holds its place like a running one.
			await handles[0].prompt({ text: ASK });
			for (const handle of handles.slice(1, MAX_RUNNING_SESSIONS)) await handle.prompt({ text: "Run the long build (slow)" });
			await waitFor("the first session to wait on its question", async () => (await handles[0].snapshot()).summary.status === "waiting", 15_000, 50);
			const message = await refused(() => handles[MAX_RUNNING_SESSIONS].prompt({ text: "One too many" }), "too_many_running");
			assert((await userConnTwo.listSessions()).find((entry) => entry.id === created[0].id)?.status === "waiting", "the user's list does not show the first session as waiting");
			assert((await handles[MAX_RUNNING_SESSIONS].snapshot()).timeline.length === 0, "the refused prompt left a timeline");
			await handles[0].stop();
			await waitFor("the stopped session to be idle", async () => (await handles[0].snapshot()).summary.status === "idle", 15_000, 100);
			const { turn } = await handles[MAX_RUNNING_SESSIONS].prompt({ text: "Now there is room" });
			assert(turn === 1, "the prompt was not accepted once a session had stopped");
			assert(created[0].title === "limit 0" && (await handles[0].snapshot()).summary.title === "limit 0", "a given title was replaced by the prompt");
			for (const entry of created) await userConnTwo.deleteSession(entry.id);
			assert((await userConnTwo.listSessions()).length === 0, "sessions remain after deleting them");
			return `the fourth was refused while one of the three was waiting on a question: "${message}"; deleting running sessions works`;
		});
	} else {
		skip(`at most ${MAX_RUNNING_SESSIONS} sessions of a user run at once`, "four containers at once is too much for this machine; run in fake mode");
	}

	// --- endings other than success, and the repository clone (fake layer's switches) ---------------

	if (FAKE) {
		const scratch = await userConnTwo.createSession({ profile: availableProfile as never, repoUrl: "https://example.com/org/project.git", model: models.at(-1) });
		const scratchWatch = new Watch(client, uid, scratch.id, token);
		await scratchWatch.conn.snapshot();
		await check("failures end the turn with a readable message and leave the session usable", async () => {
			const run = async (text: string) => {
				const { turn } = await scratchWatch.conn.prompt({ text });
				return scratchWatch.untilEnded(turn);
			};
			const crashed = await run("please (crash)");
			assert(crashed.outcome === "error" && crashed.exitCode === 1 && crashed.message?.includes("simulated crash"), `crash: ${plain(crashed)}`);
			assert(scratchWatch.items.some((item) => item.kind === "platform" && item.text === "Cloning https://example.com/org/project.git"), 'no "Cloning" item');
			const thrown = await run("please (throw)");
			assert(thrown.outcome === "error" && thrown.exitCode === null && thrown.message?.startsWith("The sandbox failed"), `throw: ${plain(thrown)}`);
			const signedOut = await run("please (auth-fail)");
			assert(signedOut.outcome === "error" && /sign in with chatgpt again/i.test(signedOut.message ?? ""), `auth-fail: ${plain(signedOut)}`);
			const failed = await run("please (exec-fail)");
			assert(failed.outcome === "failed" && failed.message === null && failed.steps === 1, `exec-fail: ${plain(failed)}`);
			assert(scratchWatch.windlass(failed.turn, "execution.failed").some((item) => String(item.event.data?.message).includes("failed 4 times")), "the failed turn's events do not say how it failed");
			const busy = await run("please (session-busy)");
			assert(busy.outcome === "error" && busy.message?.includes("another Windlass process"), `session-busy: ${plain(busy)}`);
			const kept = (await scratchWatch.conn.snapshot()).windlassSessionId;
			assert(typeof kept === "string" && kept.startsWith("ses_"), `the Windlass session after the failures so far is ${kept}`);
			const gone = await run("please (session-gone)");
			assert(gone.outcome === "error" && gone.message?.includes(kept) && gone.message.includes("starts a new Windlass session"), `session-gone: ${plain(gone)}`);
			assert((await scratchWatch.conn.snapshot()).windlassSessionId === null, "the lost Windlass session is still stored");
			const fine = await run("and now a normal one");
			assert(fine.outcome === "succeeded", `after the failures: ${plain(fine)}`);
			const renewed = (await scratchWatch.conn.snapshot()).windlassSessionId;
			assert(typeof renewed === "string" && renewed !== kept, `the prompt after a lost session continued ${renewed}`);
			assert(scratchWatch.windlass(fine.turn, "session.created").length === 1, "the prompt after a lost session did not start a new Windlass session");
			assert(scratchWatch.items.filter((item) => item.kind === "platform" && item.text.startsWith("Cloning")).length === 1, "the repository was cloned more than once");
			dense(scratchWatch.items);
			assert(scratch.model === models.at(-1) && scratch.repoUrl === "https://example.com/org/project.git", "the session's model or repository is off");
			return `crash: "${crashed.message?.split("\n")[0]}"; throw: "${thrown.message}"; auth-fail: "${signedOut.message}"; exec-fail: failed, the events say how; session-busy: "${busy.message}"; session-gone: "${gone.message?.split("\n").join(" / ")}"; then succeeded in a new Windlass session`;
		});
		await scratchWatch.conn.dispose();
		await userConnTwo.deleteSession(scratch.id);

		await check("a clone that fails ends the turn as an error", async () => {
			const broken = await userConnTwo.createSession({ profile: availableProfile as never, repoUrl: "https://example.com/org/fail-clone.git" });
			const brokenWatch = new Watch(client, uid, broken.id, token);
			await brokenWatch.conn.snapshot();
			await brokenWatch.conn.prompt({ text: "hello" });
			const ended = await brokenWatch.untilEnded(1);
			assert(ended.outcome === "error" && ended.message?.includes("Cloning https://example.com/org/fail-clone.git failed") && ended.message.includes("not found"), `ended: ${plain(ended)}`);
			await brokenWatch.conn.dispose();
			await userConnTwo.deleteSession(broken.id);
			return ended.message ?? "";
		});
	} else {
		skip("failures end the turn with a readable message and leave the session usable", "uses the fake layer's switches");
		skip("a clone that fails ends the turn as an error", "uses the fake layer's switches");
	}
	await userConnTwo.dispose().catch(() => undefined);

	// --- ChatGPT sign-in --------------------------------------------------------------------------

	if (FAKE) {
		await check("ChatGPT sign-in: start, finish, token, and the actor goes away", async () => {
			const id = attempt();
			const handle = client.login.getOrCreate([id]);
			await refused(() => handle.finish("http://127.0.0.1:1455/auth/callback?code=early"), "attempt_not_started");
			const started = await handle.start();
			assert(started.url.startsWith("https://") && started.redirectPrefix.startsWith("http://127.0.0.1"), `start gave ${plain(started)}`);
			assert(Math.abs(started.expiresAt - (Date.now() + loginTtlMs)) < 5_000, `the attempt does not expire in ${loginTtlMs} ms`);
			const wrong = await refused(() => handle.finish("https://example.com/nope"), "sandbox_error");
			const refusedByOpenAi = await refused(() => handle.finish(`${started.redirectPrefix}?code=refused`), "sandbox_error");
			const internal = await refused(() => handle.finish(`${started.redirectPrefix}?code=explode`), "internal_error");
			assert(!internal.includes("docker") && !internal.includes("/var/run"), `an internal error leaked: "${internal}"`);
			const result = await handle.finish(`${started.redirectPrefix}?code=alice&state=x`);
			const expected = `u_${createHash("sha256").update("fake|alice").digest("hex").slice(0, 20)}`;
			assert(result.profile.uid === expected && result.profile.email === "alice@example.com" && result.profile.demo === false, `profile is ${plain(result.profile)}`);
			await refused(() => handle.finish(`${started.redirectPrefix}?code=alice`), "attempt_done");
			await refused(() => handle.start(), "attempt_done");

			const alice = client.user.getOrCreate([result.profile.uid], { params: { token: result.token } });
			assert(plain(await alice.me()) === plain(result.profile), "user.me() differs from the sign-in's profile");
			const chatgpt = await alice.chatgpt();
			assert(chatgpt.connected && chatgpt.email === "alice@example.com" && typeof chatgpt.accessExpiresAt === "number", `chatgpt() is ${plain(chatgpt)}`);
			await refused(() => client.user.getOrCreate([uid], { params: { token: result.token } }).me(), "forbidden");

			await waitFor(
				"the login actor to remove itself",
				async () => {
					try {
						await client.login.get([id]).start();
						return false;
					} catch (error) {
						return (error as { code?: string }).code === "not_found";
					}
				},
				15_000,
				300,
			);
			return `uid ${result.profile.uid}; refusals: "${wrong}" / "${refusedByOpenAi}" / "${internal}"`;
		});

		await check("a user without a ChatGPT sign-in is told to sign in; with one, turns run unscripted", async () => {
			const signIn = async (code: string) => {
				const handle = client.login.getOrCreate([attempt()]);
				const started = await handle.start();
				return handle.finish(`${started.redirectPrefix}?code=${code}`);
			};
			const without = await signIn("nosignin");
			const withoutUser = client.user.getOrCreate([without.profile.uid], { params: { token: without.token } });
			assert((await withoutUser.chatgpt()).connected === false, "a user with no saved sign-in is reported as connected");
			const blocked = await withoutUser.createSession({ profile: availableProfile as never });
			const blockedHandle = client.agentSession.get([without.profile.uid, blocked.id], { params: { token: without.token } });
			const message = await refused(() => blockedHandle.prompt({ text: "hello" }), "chatgpt_required");
			const snapshot = await blockedHandle.snapshot();
			assert(snapshot.timeline.length === 0 && snapshot.summary.status === "idle" && snapshot.summary.turns === 0, "the refused prompt changed the session");
			await withoutUser.deleteSession(blocked.id);

			const bob = await signIn("bob");
			const bobUser = client.user.getOrCreate([bob.profile.uid], { params: { token: bob.token } });
			const session = await bobUser.createSession({ profile: availableProfile as never });
			const bobWatch = new Watch(client, bob.profile.uid, session.id, bob.token);
			await bobWatch.conn.prompt({ text: "hello there" });
			const ended = await bobWatch.untilEnded(1);
			assert(ended.outcome === "succeeded", `a signed-in user's turn ended ${ended.outcome}`);
			await bobWatch.conn.dispose();
			await bobUser.deleteSession(session.id);
			return `refusal: "${message}"`;
		});
	} else {
		skip("ChatGPT sign-in: start, finish, token, and the actor goes away", "a real sign-in is never completed by this script; run in fake mode");
		skip("a user without a ChatGPT sign-in is told to sign in; with one, turns run unscripted", "needs a signed-in account; run in fake mode");
	}

	if (server && loginTtlMs === SHORT_LOGIN_TTL_MS) {
		await check("an unfinished sign-in attempt is discarded when it expires", async () => {
			const id = attempt();
			const handle = client.login.getOrCreate([id]);
			const started = await handle.start();
			assert(started.url.startsWith("https://") && started.redirectPrefix.startsWith("http://"), `start gave ${plain(started)}`);
			assert(Math.abs(started.expiresAt - (Date.now() + loginTtlMs)) < 8_000, "expiresAt is off");
			// Neither layer contacts OpenAI for an address that is not the loopback one.
			const wrong = await refused(() => handle.finish("https://example.com/not-the-callback"), "sandbox_error");
			if (!FAKE) assert(loginVolumes().includes(`wlp-login-${id}`), "the attempt has no data volume");
			await waitFor("the attempt to be discarded", () => server.output.includes(`[wlp] login.discarded attempt=${id}`), loginTtlMs + 20_000, 250);
			if (!FAKE) assert(!loginVolumes().includes(`wlp-login-${id}`), "the attempt's data volume still exists");
			await refused(() => client.login.get([id]).finish(`${started.redirectPrefix}?code=late&state=x`), "not_found");
			return `after ${Math.round(loginTtlMs / 1000)} s the actor and the attempt${FAKE ? "" : "'s volume"} were gone; a wrong address was answered with "${wrong}"`;
		});
	} else {
		skip("an unfinished sign-in attempt is discarded when it expires", "needs its own server, restarted with a short expiry");
	}

	await check("the demo sign-in's login actor goes away", async () => {
		const id = attempt();
		await demoSignIn(id);
		await refused(() => client.login.get([id]).demo(), "attempt_done");
		await waitFor(
			"the login actor to remove itself",
			async () => {
				try {
					await client.login.get([id]).demo();
					return false;
				} catch (error) {
					return (error as { code?: string }).code === "not_found";
				}
			},
			15_000,
			300,
		);
		await refused(() => client.login.getOrCreate(["bad id!"]).start(), "bad_attempt_id");
		return "destroyed a few seconds after issuing its token";
	});

	// --- the turn's time limit, on a server restarted with a short one ------------------------------

	if (server && FAKE) {
		await check("the turn's time limit applies while a question waits", async () => {
			const limitMs = 3_000;
			await server.stop();
			await waitFor("port 6420 to be free", portFree, 20_000, 200);
			await server.start({ WLP_TURN_TIMEOUT_MS: String(limitMs), WLP_LOGIN_TTL_MS: String(loginTtlMs) });
			const limited = await userHandle.createSession({ profile: availableProfile as never, title: "Limited" });
			const limitedWatch = new Watch(client, uid, limited.id, token);
			try {
				const { turn } = await limitedWatch.conn.prompt({ text: ASK });
				const asked = await limitedWatch.untilQuestion(turn);
				assert(asked.expiresAt - asked.askedAt === QUESTION_MS && QUESTION_MS > limitMs, "the question would expire before the turn's limit");
				const ended = await limitedWatch.untilEnded(turn, limitMs + 20_000);
				assert(ended.outcome === "interrupted", `outcome is ${ended.outcome}: ${ended.message ?? ""}`);
				const said = limitedWatch.items.find((item) => item.kind === "platform" && item.level === "warn" && item.text.includes("which is the limit"));
				assert(said?.kind === "platform", "no platform item says that the turn reached its limit");
				const ran = ended.at - limitedWatch.items[0].at;
				assert(ran >= limitMs - 200 && ran < limitMs + 8_000, `the turn ran for ${ran} ms; its limit was ${limitMs} ms`);
				assert(limitedWatch.questions.at(-1) === null, "the question was not withdrawn");
				assert(limitedWatch.ofCall(turn, "approval.answered", asked).length === 0 && limitedWatch.ofCall(turn, "tool.started", asked).length === 0, "the question was answered, or its call run, by something");
				const snapshot = await limitedWatch.conn.snapshot();
				assert(snapshot.question === null && snapshot.summary.status === "idle", `after the limit: ${plain(snapshot.summary)}`);
				await refused(() => limitedWatch.conn.answer({ questionId: asked.id, choice: "once" }), "no_question");
				return `"${said.text}" after ${ran} ms, while waiting; statuses ${limitedWatch.statuses()}`;
			} finally {
				await limitedWatch.conn.dispose().catch(() => undefined);
				await userHandle.deleteSession(limited.id).catch(() => undefined);
			}
		});
	} else {
		skip("the turn's time limit applies while a question waits", "needs its own server with the fake layer, restarted with a short limit");
	}

	await client.dispose().catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------

let server: Server | null = null;
let crashed = false;
try {
	console.log(`e2e: sandbox layer ${MODE}; ${OWN_SERVER ? "starting a server on fresh state" : `using ${ENDPOINT}`}`);
	if (OWN_SERVER) {
		if (!(await portFree())) throw new Error("port 6420 is in use: stop the running server, or pass --endpoint to test it");
		if (!existsSync(join(SERVER_DIR, "src", "index.ts"))) throw new Error(`run this from ${SERVER_DIR}`);
		server = new Server();
		await server.start();
	}
	await main(server);
} catch (error) {
	crashed = true;
	console.log(`FAIL  the run stopped early  -- ${describe(error)}`);
	if (error instanceof Error && error.stack) console.log(error.stack.split("\n").slice(1, 6).join("\n"));
} finally {
	if (server) {
		await server.stop().catch(() => undefined);
		const unhandled = server.output.split("\n").filter((line) => line.includes("unhandled promise rejection"));
		if (unhandled.length > 0) fail("no unhandled promise rejections in the server", `${unhandled.length}: ${unhandled[0]}`);
		else pass("no unhandled promise rejections in the server");
		if (!FAKE) {
			// Only what this run's server made: other work may be using the same Docker.
			const made = [...server.output.matchAll(/\[wlp\] sandbox\.created id=(\S+)/g)].map((match) => `wlp-session-${match[1]}`);
			const left = sandboxContainers().filter((name) => made.includes(name));
			if (left.length > 0) fail("no sandbox containers left behind", left.join(", "));
			else pass("no sandbox containers left behind", `${made.length} created and removed`);
			const stuck = removeDemoVolumes();
			if (stuck.length > 0) fail("the demo users' data volumes are removed", stuck.join("; "));
			else pass("the demo users' data volumes are removed", `${demoUids.length} demo users`);
		}
	}
}
if (crashed) failed += 1;
console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILED"}: ${passed} passed, ${failed} failed, ${skipped} skipped (sandbox layer: ${MODE})`);
server?.remove();
process.exit(failed === 0 ? 0 : 1);
