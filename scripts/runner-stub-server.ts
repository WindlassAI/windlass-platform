// Only the pairing routes and two socket endpoints. The real session channel owns replay,
// receipts, operation ids, timers, and result validation on this side of the TCP proxy.
import { checkPort } from "./ports.js";
import { randomBytes, verify } from "node:crypto";
import { createServer as http } from "node:http";
import { createRequire } from "node:module";
import { createServer, connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import { ServerChannel } from "../server/src/runner/channel.js";
import { parseFrame } from "../server/src/runner/protocol.js";
import {
	CLOCK_TOLERANCE_MS, CONTROL_HEARTBEAT_MS, RUNNER_CONNECTION_PATH, RUNNER_PAIR_PATH, RUNNER_PAIR_POLL_PATH,
	connectionProof, controlProof, sessionProof, parseRunnerFrame, parseConnectionRequest, parsePairPoll, parsePairRequest,
	refuse, secondHello, type PairStatus, type PairStarted, type Refusal, type Report, type ServerFrame,
} from "../server/src/runner/control.js";

export async function until(test: () => boolean | Promise<boolean>, message: string, ms = 45_000) {
	const deadline = Date.now() + ms;
	while (!await test()) { if (Date.now() >= deadline) throw new Error(message); await wait(50); }
}
const random = () => randomBytes(32).toString("base64url");
type WS = import("../server/node_modules/rivetkit/dist/tsup/mod.js").UniversalWebSocket;
const send = (ws: WS, f: ServerFrame) => ws.send(JSON.stringify(f));

export async function stub(storage: string) {
	for (const k of Object.keys(process.env)) if (k.startsWith("RIVET")) delete process.env[k];
	const port = checkPort(7020);
	// Rivet starts two companion listeners. Never attach to an engine that was already there.
	for (const p of [port, port + 1, port + 10]) await new Promise<void>((resolve, reject) => {
		const test = createServer(); test.once("error", reject); test.listen(p, "127.0.0.1", () => test.close(() => resolve()));
	});
	Object.assign(process.env, { RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(port), RIVET_LOG_LEVEL: "silent", NODE_ENV: "development" });
	const require = createRequire(new URL("../server/package.json", import.meta.url));
	const { actor, setup } = require("rivetkit") as typeof import("../server/node_modules/rivetkit/dist/tsup/mod.js");
	const { createClient } = await import("../server/src/client.js");
	const uid = "u_" + randomBytes(6).toString("hex");
	const machineId = "m_" + randomBytes(8).toString("hex");
	const sessionId = "s_" + randomBytes(8).toString("hex");
	const other = sessionId + "_other";
	let publicKey = "";
	const signed = (statement: string, signature: string) => verify(null, Buffer.from(statement), publicKey, Buffer.from(signature, "base64url"));
	let live: { ws: WS; epoch: string; heardAt: number } | null = null;
	const state = {
		report: null as Report | null, reports: 0, gatewayLifetime: 0, epoch: "", connections: 0, connectionRequests: 0, pairStarts: 0, pairingMode: "approve" as "approve" | "gone" | "refused" | "waiting", startFailures: 0, pollFailures: 0, clockRefusals: 0,
		refusal: null as Refusal | null, httpRefusal: null as "removed" | "unknown" | null, idleMs: 600_000, removed: "", lastErrorKind: "",
	};
	const tickets = new Map<string, string>();
	const joined = new Map<string, number>();
	const opened = new Map<string, number>();
	let incompatible: string | undefined;
	const channels = new Map<string, ServerChannel>();
	const wanted = new Set<string>();
	let holdAcks = false;
	let corrupt: "unknown" | "create" | undefined;
	function channel(session: string) {
		let ch = channels.get(session);
		if (!ch) {
			ch = new ServerChannel({ accept(h) {
				if (h.machineId !== machineId || tickets.get(session) !== h.ticket || !signed(sessionProof(uid, session, machineId, h.ticket), h.signature)) return false;
				tickets.delete(session); joined.set(session, (joined.get(session) ?? 0) + 1); return true;
			} });
			channels.set(session, ch);
		}
		return ch;
	}
	function ticket(session: string) {
		if (!live) return;
		const ticket = random();
		tickets.set(session, ticket); send(live.ws, { kind: "attach", sessionId: session, ticket });
	}
	const machine = actor({ onWebSocket(_c, ws) {
		const nonce = random();
		ws.addEventListener("message", e => {
			const f = parseRunnerFrame(e.data);
			if (!f) { ws.close(); return; }
			if (f.kind === "hello") {
				if (!signed(controlProof(uid, machineId, nonce), f.signature)) { ws.close(); return; }
				const refused = state.refusal ?? (secondHello(live, f, Date.now()) === "refuse" ? refuse("key-in-use") : null);
				if (refused) { send(ws, refused); ws.close(); return; }
				live?.ws.close(); live = { ws, epoch: f.epoch, heardAt: Date.now() };
				state.connections++; state.epoch = f.epoch;
				send(ws, { kind: "welcome", idleSuspendMs: state.idleMs });
				for (const s of wanted) ticket(s);
			} else if (live?.ws === ws) {
				live.heardAt = Date.now();
				if (f.kind === "report") { state.report = f; state.reports++; }
				if (f.kind === "removed") state.removed = f.sandbox;
			}
		});
		ws.addEventListener("close", () => { if (live?.ws === ws) live = null; });
		send(ws, { kind: "challenge", nonce });
	} });
	const agentSession = actor({ onWebSocket(c, ws) {
		const session = c.key[1]!;
		opened.set(session, (opened.get(session) ?? 0) + 1);
		channel(session).attach({
			send(text) {
				const f = parseFrame(text);
				if (holdAcks && f?.kind === "ack") return;
				if (corrupt && f?.kind === "msg" && f.body.kind === "op") {
					if (corrupt === "unknown") f.body.name = "unsupported";
					else Object.assign(f.body.args, { uid: "somebody_else", sessionId: other });
					corrupt = undefined;
					ws.send(JSON.stringify(f)); return;
				}
				ws.send(text);
			},
			close: () => ws.close(), onMessage(fn) { ws.addEventListener("message", e => {
				const frame = parseFrame(e.data);
				if (frame?.kind === "hello" && session === incompatible) { fn(JSON.stringify({ ...frame, protocol: 0 })); return; }
				if (frame?.kind === "msg" && frame.body.kind === "res" && !frame.body.ok) state.lastErrorKind = frame.body.error.kind;
				fn(e.data);
			}); }, onClose(fn) { ws.addEventListener("close", () => {
				fn();
				if (wanted.has(session) && !channel(session).connected && !tickets.has(session)) ticket(session);
			}); },
		});
	} });
	const registry = setup({ use: { machine, agentSession }, startServices: false, maxIncomingMessageSize: 256 * 1024 });
	registry.start(); await registry.startAndWait();
	const endpoint = "http://127.0.0.1:" + port;
	const client = createClient<typeof registry>({ endpoint, namespace: "default" });
	await client.machine.getOrCreate([uid, machineId]).resolve();

	const pipes = new Set<Duplex>();
	let credential: { token: string; expiresAt: number; validForMs: number } | null = null;
	let offline: "all" | "gateway" | undefined;
	const proxy = http();
	proxy.on("upgrade", (req, incoming, head) => {
		if (offline) { incoming.destroy(); return; }
		const url = new URL(req.url!, "http://localhost");
		if (credential) {
			if (url.searchParams.get("rvt-token") !== credential.token || Date.now() >= credential.expiresAt) {
				incoming.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				return;
			}
			url.searchParams.set("rvt-token", "default"); // The local Rivet engine uses its own development credential.
		}
		const outgoing = connect(port, "127.0.0.1");
		const headers = Object.entries(req.headers).map(([k, v]) => k + ": " + v);
		outgoing.write([`GET ${url.pathname}${url.search} HTTP/1.1`, ...headers, "", ""].join("\r\n"));
		if (head.length) outgoing.write(head);
		const close = () => { incoming.destroy(); outgoing.destroy(); pipes.delete(incoming); };
		pipes.add(incoming); incoming.on("error", close); outgoing.on("error", close);
		incoming.on("close", close); outgoing.on("close", close);
		incoming.pipe(outgoing).pipe(incoming);
	});
	await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
	const advertised = "http://127.0.0.1:" + (proxy.address() as AddressInfo).port;
	let started: PairStarted | undefined;
	let pendingKey = "";
	const api = http(async (req, res) => {
		const answer = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
		try {
			const chunks = []; for await (const chunk of req) chunks.push(chunk);
			const b: unknown = JSON.parse(Buffer.concat(chunks).toString());
			if (req.method !== "POST") return answer(405, {});
			if (req.url === RUNNER_PAIR_PATH) {
				state.pairStarts++;
				if (state.startFailures > 0) { state.startFailures--; return answer(503, {}); }
				if (state.pairingMode === "refused") return answer(429, {});
				const p = parsePairRequest(b); if (!p) return answer(400, {});
				pendingKey = p.publicKey;
				const digits = randomBytes(4).toString("hex").toUpperCase();
				started = { pairing: random(), pollSecret: random(), code: digits.slice(0, 4) + "-" + digits.slice(4) };
				return answer(201, started);
			}
			if (req.url === RUNNER_PAIR_POLL_PATH) {
				const p = parsePairPoll(b);
				if (!started || p?.pollSecret !== started.pollSecret || p.pairing !== started.pairing) return answer(403, {});
				if (!state.pollFailures++) return answer(503, {});
				if (state.pairingMode !== "approve") return answer(200, { state: state.pairingMode });
				publicKey = pendingKey;
				return answer(200, { state: "approved", uid, machineId, githubLogin: "runner-check" } satisfies PairStatus);
			}
			if (req.url === RUNNER_CONNECTION_PATH) {
				state.connectionRequests++;
				const p = parseConnectionRequest(b);
				if (!p || p.uid !== uid || p.machineId !== machineId || !signed(connectionProof(uid, machineId, p.time), p.signature)) return answer(403, { reason: "unknown" });
				const now = Date.now() + 30 * 60_000;
				if (Math.abs(now - p.time) > CLOCK_TOLERANCE_MS) { state.clockRefusals++; return answer(403, { reason: "clock", serverTime: now }); }
				if (state.httpRefusal === "unknown") return answer(403, { reason: "unknown" });
				if (state.httpRefusal === "removed") return answer(410, { reason: "removed", removeSandboxes: false });
				if (offline === "all") return answer(503, {});
				credential = state.gatewayLifetime ? { token: random(), expiresAt: Date.now() + state.gatewayLifetime, validForMs: state.gatewayLifetime } : null;
				return answer(200, { endpoint: advertised, namespace: "default", token: credential });
			}
			answer(404, {});
		} catch { answer(400, {}); }
	});
	await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
	const heartbeat = setInterval(() => { if (live) send(live.ws, { kind: "heartbeat" }); }, CONTROL_HEARTBEAT_MS);
	return { state, uid, machineId, sessionId, other, platform: "http://127.0.0.1:" + (api.address() as AddressInfo).port,
		channel, ticket, opened, incompatible(s: string) { incompatible = s; }, online: () => !!live, send: (f: ServerFrame) => { if (!live) throw new Error("Control is offline"); send(live.ws, f); },
		async attach(s = sessionId) {
			await client.agentSession.getOrCreate([uid, s]).resolve();
			const prior = joined.get(s) ?? 0;
			wanted.add(s); ticket(s);
			await until(() => (joined.get(s) ?? 0) > prior && channel(s).connected, "The session did not attach.");
		},
		detach(s = sessionId) { wanted.delete(s); channel(s).detach(); },
		reset(s = sessionId) { wanted.delete(s); channel(s).close(); channels.delete(s); },
		cut(link: "all" | "gateway" = "all") { offline = link; for (const p of pipes) p.destroy(); },
		restore() { offline = undefined; },
		acks(enabled: boolean) { holdAcks = !enabled; }, corruptNext(value: typeof corrupt) { corrupt = value; },
		async close() {
			clearInterval(heartbeat); wanted.clear(); for (const ch of channels.values()) ch.close();
			live?.ws.close(); for (const p of pipes) p.destroy();
			api.closeAllConnections(); api.close(); proxy.close(); await registry.shutdown();
		},
	};
}
