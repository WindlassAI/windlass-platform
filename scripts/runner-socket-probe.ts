/**
 * A raw socket to one actor, through the engine's gateway. The node doing the answering is a
 * child of this check, so a drain reaches just that node. The actor answers with a byte count.
 *
 *   cd server && npx tsx ../scripts/runner-socket-probe.ts
 *
 * WLP_CHECK_ENGINE selects an existing engine. On a cluster give RIVET_ADMIN_TOKEN and a
 * RIVET_POOL reserved for this node. WLP_PROBE_IDLE_MS sets the wait without any messages.
 */
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { ConnectionTokens } from "../server/src/connection-tokens.js";

// The gateway may put credentials in a URL. Only the probe prints results.
process.env.RIVET_LOG_LEVEL = "silent";
const server = fileURLToPath(new URL("../server/", import.meta.url));
const require = createRequire(new URL("../server/package.json", import.meta.url));
function registry() {
	const { actor, setup } = require("rivetkit") as typeof import("../server/node_modules/rivetkit/dist/tsup/mod.js");
	const runnerSocketProbe = actor({
		onWebSocket: (_c, ws) => {
			ws.addEventListener("message", ({ data }) => {
				if (typeof data === "string") ws.send(`${process.pid} ${Buffer.byteLength(data)}`);
			});
		},
	});
	return setup({ use: { runnerSocketProbe }, startServices: false, maxIncomingMessageSize: 256 * 1024, shutdown: { gracePeriodMs: 20_000 } });
}

async function node(): Promise<void> {
	const probe = registry();
	probe.start();
	await probe.startAndWait();
	process.send?.("ready");
}

class ProbeError extends Error {}
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new ProbeError(what)), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createServer();
		socket.once("error", () => resolve(false));
		socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
	});
}

function startNode(env: NodeJS.ProcessEnv) {
	const child = fork(fileURLToPath(import.meta.url), ["--node"], { cwd: server, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const ready = within(Promise.race([
		new Promise<void>((done) => child.once("message", () => done())),
		exited.then(() => { throw new ProbeError("The probe node stopped before it registered."); }),
	]), 90_000, "The probe node did not register.");
	let draining = false;
	const drain = () => {
		if (!draining) child.kill("SIGTERM");
		draining = true;
	};
	return { pid: child.pid, ready, drain, async stop() {
		drain();
		await within(exited, 25_000, "The probe node did not exit.").catch(() => child.kill("SIGKILL"));
		await exited;
	} };
}

async function main(): Promise<void> {
	const given = process.env.WLP_CHECK_ENGINE;
	const port = Number(process.env.RIVET_RUN_ENGINE_PORT ?? 6740);
	const endpoint = given ?? `http://127.0.0.1:${port}`;
	const url = new URL(endpoint);
	const local = !given || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	const idle = Number(process.env.WLP_PROBE_IDLE_MS ?? 60_000);
	const ceiling = Number(process.env.WLP_PROBE_MAX_BYTES ?? 32 * 1024 * 1024);
	if (!Number.isSafeInteger(idle) || idle < 0 || idle > 86_400_000 || !Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 32 * 1024 * 1024)
		throw new ProbeError("Invalid idle duration or frame ceiling.");
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || (local && url.protocol === "http:")))
		throw new ProbeError("Give the engine origin without credentials.");
	const admin = given ? process.env.RIVET_ADMIN_TOKEN : undefined;
	const pool = given ? process.env.RIVET_POOL : "runner-socket-probe";
	const namespace = given ? process.env.RIVET_NAMESPACE ?? "default" : "default";
	if (!pool || pool === "default" || (!local && !admin)) throw new ProbeError("An existing engine needs a dedicated RIVET_POOL and a cluster needs RIVET_ADMIN_TOKEN.");
	if (!given) {
		for (const bind of [port, port + 1, port + 10]) {
			if ([6420, 6421, 6430, 6440].includes(bind) || !(await portFree(bind))) throw new ProbeError("The local probe ports must be free and outside the end-to-end suite.");
		}
	}
	const storage = await mkdtemp(join(tmpdir(), "wlp-runner-probe-"));
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("RIVET") || key.startsWith("WLP_")) delete env[key];
	Object.assign(env, { RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(port), RIVET_NAMESPACE: namespace });
	let keeper: ReturnType<typeof startNode> | undefined;
	let node: ReturnType<typeof startNode> | undefined;
	let id: string | undefined;
	let stage = "registering the probe node";
	let socket: WebSocket | undefined;
	const interrupted = new AbortController();
	const stop = () => interrupted.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		if (!given) {
			// RivetKit stops the local engine with the node that started it. Give the engine its own node.
			keeper = startNode({ ...env, RIVET_POOL: "default", NODE_ENV: "development" });
			await keeper.ready;
			const response = await fetch(`${endpoint}/pools/${pool}?namespace=default`, {
				method: "PUT", headers: { Authorization: "Bearer default", "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new ProbeError(`Could not make the probe's local pool (HTTP ${response.status}).`);
		}
		node = startNode({ ...env, RIVET_ENDPOINT: endpoint, RIVET_TOKEN: (given && process.env.RIVET_TOKEN) || admin || "default", RIVET_POOL: pool, NODE_ENV: "production" });
		await node.ready;
		const pid = node.pid;
		stage = "creating the probe actor";
		const tokens = admin ? new ConnectionTokens({ endpoint, namespace, adminToken: admin, ttlMs: 3_600_000, log: () => {} }) : null;
		const { createClient } = await import("../server/src/client.js");
		const client = createClient<ReturnType<typeof registry>>({ endpoint, namespace, ...(tokens ? { getToken: async () => (await tokens.current()).token } : { token: "default" }) });
		const handle = client.runnerSocketProbe.getOrCreate([crypto.randomUUID()], { poolName: pool });
		id = await within(handle.resolve(), 30_000, "Could not resolve the probe actor.");
		const open = async (): Promise<WebSocket> => {
			socket?.close();
			socket = await within<WebSocket>(handle.webSocket("runner"), 20_000, "Could not reach the gateway.");
			const ws = socket;
			if (ws.readyState !== 1) await within(new Promise<void>((done, fail) => {
				ws.addEventListener("open", () => done(), { once: true });
				ws.addEventListener("close", () => fail(new ProbeError("Socket closed during open.")), { once: true });
			}), 15_000, "Socket did not open.");
			return ws;
		};
		const takes = async (bytes: number, ws: WebSocket): Promise<boolean> => {
			if (ws.readyState !== 1) return false;
			let message!: (e: MessageEvent) => void;
			let close!: () => void;
			try {
				return await within(new Promise<boolean>((done) => {
					message = (e) => done(e.data === `${pid} ${bytes}`);
					close = () => done(false);
					ws.addEventListener("message", message);
					ws.addEventListener("close", close);
					ws.send("x".repeat(bytes));
				}), 5_000, "Frame received no answer.").catch(() => false);
			} finally {
				ws.removeEventListener("message", message);
				ws.removeEventListener("close", close);
			}
		};
		stage = "measuring frames";
		let low = 0;
		let high = Math.min(65536, ceiling);
		let ws = await open();
		if (!await takes(1, ws)) throw new ProbeError("The actor did not answer a one-byte message.");
		let sent = 1;
		const trySize = async (size: number) => {
			interrupted.signal.throwIfAborted();
			sent += size;
			const ok = await takes(size, ws);
			if (!ok) {
				ws = await open();
				if (!await takes(1, ws)) throw new ProbeError("The control message after a failed frame also failed.");
				sent++;
			}
			return ok;
		};
		while (await trySize(high)) {
			low = high;
			if (low === ceiling) break;
			high = Math.min(ceiling, high * 2);
		}
		while (high - low > 1) {
			const mid = Math.floor((high + low) / 2);
			if (await trySize(mid)) low = mid;
			else high = mid;
		}
		console.log(`Largest acknowledged text message: ${low} bytes (${low === ceiling ? "test ceiling reached" : `${high} bytes went unanswered`}). Sent ${sent} payload bytes in the size test.`);
		stage = "measuring idle time";
		await wait(idle, undefined, { signal: interrupted.signal });
		const survived = await takes(1, ws);
		console.log(`After ${idle} ms idle: ${survived ? "one byte answered" : "no answer"}.`);
		if (!survived) ws = await open();
		if (!await takes(1, ws)) throw new ProbeError("No live socket before drain.");
		stage = "draining the probe node";
		const start = Date.now();
		const close = new Promise<number>((done) => ws.addEventListener("close", (e) => done(e.code), { once: true }));
		node.drain();
		const code = await within(close, 45_000, "Socket still open 45 s after SIGTERM.");
		console.log(`After SIGTERM: socket closed with code ${code} in ${Date.now() - start} ms.`);
		const alive = await fetch(`${url.origin}/actors/${encodeURIComponent(id)}?namespace=${encodeURIComponent(namespace)}`, {
			headers: { Authorization: `Bearer ${admin ?? "default"}` }, signal: AbortSignal.timeout(5_000),
		}).then((response) => response.ok, () => false);
		console.log(`Engine answered for the actor after the socket closed: ${alive ? "yes" : "no"}.`);
	} catch (error) {
		if (interrupted.signal.aborted) throw new ProbeError("Probe interrupted.");
		throw error instanceof ProbeError ? error : new ProbeError(`Probe failed while ${stage}.`);
	} finally {
		socket?.close();
		await node?.stop();
		try {
			if (id && given) {
				const response = await fetch(`${url.origin}/actors/${encodeURIComponent(id)}?namespace=${encodeURIComponent(namespace)}`, {
					method: "DELETE", headers: { Authorization: `Bearer ${admin ?? "default"}` }, signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok && response.status !== 404) throw new ProbeError("The engine refused to remove the probe actor.");
			}
			if (keeper) {
				await keeper.stop();
				const state = join(storage, ".rivetkit/var/engine/runtime.json");
				const saved = await readFile(state, "utf8").catch(() => "");
				if (saved) {
					const { pid } = JSON.parse(saved);
					if (Number.isInteger(pid) && pid > 1) {
						try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
					}
				}
			}
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			await rm(storage, { recursive: true, force: true });
		}
	}
}

(process.argv.includes("--node") ? node() : main()).catch((error) => {
	console.error(error instanceof ProbeError ? error.message : "Probe failed.");
	process.exitCode = 1;
});
