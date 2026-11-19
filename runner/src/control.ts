import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import {
	CONTROL_DEAD_MS, CONTROL_HEARTBEAT_MS, PAIRING_POLL_MS, PAIRING_TTL_MS, REFUSED_RETRY_MS, REPORT_MS,
	RUNNER_CONNECTION_PATH, RUNNER_PAIR_PATH, RUNNER_PAIR_POLL_PATH, connectionProof, controlProof, sessionProof,
	parseConnection, parseConnectionRefusal, parsePairStarted, parsePairStatus, parseServerFrame, refuse,
	type ConnectionRequest, type PairRequest, type PairPoll, type Refusal, type RunnerFrame,
} from "../../server/src/runner/control.js";
import { audit, safeSentence } from "./audit.js";
import { Executor } from "./docker-executor.js";
import { Session } from "./session.js";
import { RunnerError, VERSION, origin, storePair } from "./state.js";

const epoch = randomUUID();

function proof(key: KeyObject, statement: string) {
	return sign(null, Buffer.from(statement), key).toString("base64url");
}

// Error messages from fetch and the gateway can include a credential-bearing URL.
export function category(error: unknown): string {
	if (error instanceof RunnerError) return error.message;
	for (let e = error; e instanceof Error; e = e.cause) {
		const code = (e as NodeJS.ErrnoException).code ?? "";
		if (["EAI_AGAIN", "ENOTFOUND"].includes(code)) return "DNS name resolution failed.";
		if (/CERT|TLS|SSL/.test(code)) return "TLS certificate or handshake failed.";
		if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOENT", "EACCES", "ENOSPC"].includes(code)) return code;
		if (e.name === "TimeoutError") return "The connection timed out.";
	}
	return "Connection or local I/O failed. Check the endpoint, Docker socket and state volume.";
}
async function post(platform: string, path: string, body: PairRequest | PairPoll | ConnectionRequest, signal: AbortSignal) {
	const response = await fetch(platform + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
		redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
	// The platform is untrusted. Even an HTTP error body must not grow without a bound.
	let bytes = 0;
	const parts: Uint8Array[] = [];
	for await (const chunk of response.body ?? []) {
		bytes += chunk.length;
		if (bytes > 16_384) throw new RunnerError("The platform sent an oversized HTTP answer.");
		parts.push(chunk);
	}
	let value: unknown;
	try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { /* Status still tells us whether to retry. */ }
	return { status: response.status, value };
}
export async function pair(platform: string, signal: AbortSignal, say: (message: string) => void) {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TTL_MS)]);
	const request: PairRequest = { publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		name: hostname().slice(0, 64), os: process.platform, arch: process.arch, runnerVersion: VERSION };
	const again = "restart the container or run `windlass-runner pair` to get a new code.";
	let response;
	for (let attempt = 1; ; attempt++) {
		try {
			response = await post(platform, RUNNER_PAIR_PATH, request, deadline);
			if (response.status < 500 || attempt === 3) break;
		} catch (error) {
			if (deadline.aborted || attempt === 3) return { idle: `Pairing could not start (${category(error)}), so ${again}` };
		}
		say("Pairing could not start yet. Trying again.");
		await wait(PAIRING_POLL_MS, undefined, { signal: deadline }).catch(() => {});
	}
	const started = parsePairStarted(response.value);
	if (response.status < 200 || response.status >= 300 || !started)
		return { idle: `Pairing was refused (HTTP ${response.status}), so ${again}` };
	const poll = { pairing: started.pairing, pollSecret: started.pollSecret };
	say(`Open ${platform}/machines/add and enter ${started.code}`);
	while (!deadline.aborted) {
		await wait(PAIRING_POLL_MS, undefined, { signal: deadline }).catch(() => {});
		if (deadline.aborted) break;
		try { response = await post(platform, RUNNER_PAIR_POLL_PATH, poll, deadline); }
		catch (error) { if (!deadline.aborted) say("Pairing: " + category(error)); continue; }
		if (response.status >= 500 || response.status === 429) { say(`Pairing: HTTP ${response.status}; trying again.`); continue; }
		const status = parsePairStatus(response.value);
		if (response.status < 200 || response.status >= 300 || !status)
			return { idle: `Pairing was refused (HTTP ${response.status}), so ${again}` };
		if (status.state === "gone") break;
		if (status.state === "approved") {
			const paired = storePair({ machineId: status.machineId, uid: status.uid }, privateKey, platform);
			say(`Paired with ${safeSentence(status.githubLogin ?? "an account without a GitHub login")}. If that is not you, run \`windlass-runner pair\` again.`);
			return { paired };
		}
	}
	return { idle: `The pairing code expired, so ${again}` };
}

async function openSocket(opening: Promise<WebSocket>, signal: AbortSignal) {
	const limit = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
	return new Promise<WebSocket>((resolve, reject) => {
		let socket: WebSocket | undefined;
		const done = () => { limit.removeEventListener("abort", abort); socket?.removeEventListener("open", opened); socket?.removeEventListener("close", closed); };
		const opened = () => { done(); resolve(socket!); };
		const closed = (e: CloseEvent) => { done(); reject(new RunnerError(`Socket closed during open (code ${e.code}).`)); };
		const abort = () => { done(); socket?.close(); reject(new RunnerError("The gateway socket did not open in time.")); };
		limit.addEventListener("abort", abort);
		opening.then(ws => {
			socket = ws;
			if (limit.aborted) return abort();
			if (ws.readyState === 1) return opened();
			if (ws.readyState > 1) { done(); reject(new RunnerError("The gateway closed before opening the socket.")); return; }
			ws.addEventListener("close", closed);
			ws.addEventListener("open", opened);
		}, error => { done(); reject(error); });
	});
}

export async function control(owner: Executor, key: KeyObject, platform: string, signal: AbortSignal, saveStatus: (connection: string, idleSuspendMs?: number) => void, initialIdle: number | undefined) {
	// Gateway diagnostics can contain the access URL. Only our categorised errors go to the owner.
	process.env.RIVET_LOG_LEVEL = "silent";
	const { createClient } = await import("rivetkit/client");
	const { uid, machineId } = owner.identity;
	const sessions = new Map<string, Session>();
	let idle = initialIdle;
	let state = "";
	let offset = 0;
	let backoff = 1000;
	let lastSent = 0;
	function status(connection: string) {
		if (connection !== state) saveStatus(connection, idle);
		state = connection;
		console.log(connection);
		audit(null, null, "control", connection);
	}
	// A refused copy of the key must never idle-stop a sandbox used by the accepted runner.
	let removed = false;
	let mayMaintain = false;
	let maintaining = false;
	let lastRefresh = 0;
	const maintain = async () => {
		if (maintaining || !mayMaintain) return;
		maintaining = true;
		try {
			await owner.serial(async () => {
				if (!mayMaintain) return;
				if (Date.now() - lastRefresh >= REPORT_MS) { await owner.refresh(); lastRefresh = Date.now(); }
				if (mayMaintain && idle !== undefined) await owner.idle(idle, id => sessions.get(id)?.channel.connected === true);
			});
			if (Date.now() - lastSent >= REPORT_MS) owner.publishReport?.();
		} catch (error) { audit(null, null, "maintenance", category(error)); }
		finally { maintaining = false; }
	};
	const timer = setInterval(() => void maintain(), 1000);
	async function stopSessions() {
		const current = [...sessions.values()];
		for (const s of current) s.channel.close();
		await Promise.all(current.map(s => s.orphaned));
		sessions.clear();
	}
	try {
		status("Connecting");
		while (!signal.aborted) {
			let refusal: Refusal | undefined;
			let discarding: Promise<void> | undefined;
			let slow = false;
			let reason = "Disconnected";
			const attempt = new AbortController();
			const active = AbortSignal.any([signal, attempt.signal]);
			try {
				async function connectGateway(correctClock = true): Promise<{ refreshAt: number; client: ReturnType<typeof createClient> }> {
					// The lease ages even while a laptop is asleep. Apply server clock
					// correction only to the signed timestamp, not to its relative lifetime.
					const started = Date.now();
					const time = started + offset;
					const response = await post(platform, RUNNER_CONNECTION_PATH, { uid, machineId, time, signature: proof(key, connectionProof(uid, machineId, time)) }, active);
					if (response.status !== 200) {
						const r = parseConnectionRefusal(response.value);
						if (response.status === 403 && r?.reason === "clock" && correctClock) {
							offset = r.serverTime - Date.now();
							audit(null, null, "control", "HTTP 403; signing with corrected time");
							return connectGateway(false);
						}
						if (response.status === 410 && r?.reason === "removed") refusal = refuse("removed", r);
						else if (response.status === 403 && r?.reason === "unknown") refusal = refuse("unknown");
						slow = response.status >= 400 && response.status < 500;
						throw new RunnerError(`HTTP ${response.status}`);
					}
					const info = parseConnection(response.value);
					if (!info) throw new RunnerError("Invalid HTTP connection answer.");
					const endpoint = origin(info.endpoint ?? platform);
					if (platform.startsWith("https:") && !endpoint.startsWith("https:")) throw new RunnerError("The gateway needs HTTPS.");
					return { refreshAt: info.token ? started + info.token.validForMs * 0.8 : Infinity,
						client: createClient({ endpoint, namespace: info.namespace, token: info.token?.token, disableMetadataLookup: true }) };
				}
				let gateway = await connectGateway();
				let refreshing: Promise<void> | undefined;
				async function currentClient() {
					if (Date.now() >= gateway.refreshAt) {
						refreshing ??= connectGateway().then(next => { gateway = next; }).finally(() => { refreshing = undefined; });
						await refreshing;
					}
					return gateway.client;
				}
				const ws = await openSocket(gateway.client.machine.get([uid, machineId]).webSocket("control"), active);
				const send = (f: RunnerFrame) => ws.send(JSON.stringify(f));
				let phase: "challenge" | "welcome" | "online" = "challenge";
				let heard = Date.now();
				lastSent = Date.now();
				let lastReport = "";
				owner.publishReport = () => {
					if (phase !== "online" || ws.readyState !== 1) return;
					const report = owner.report();
					const next = JSON.stringify(report);
					if (next !== lastReport) { send(report); lastReport = next; lastSent = Date.now(); }
				};
				const attaching = new Map<string, string>();
				const disconnect = () => ws.close();
				const closed = new Promise<void>(resolve => ws.addEventListener("close", e => {
					if (e.code === 1008 || e.code >= 4000 && e.code < 5000) slow = true;
					reason += ` (socket close ${e.code})`; resolve();
				}));
				const heartbeat = setInterval(() => {
					if (Date.now() - heard >= CONTROL_DEAD_MS) disconnect();
					else if (phase === "online" && ws.readyState === 1) send({ kind: "heartbeat" });
				}, CONTROL_HEARTBEAT_MS);
				active.addEventListener("abort", disconnect);
				const message = async (data: unknown) => {
					const f = parseServerFrame(data);
					if (!f || refusal) { disconnect(); return; }
					heard = Date.now();
					if (f.kind === "refused") {
						mayMaintain = false; refusal = f;
						discarding = stopSessions();
						disconnect(); return;
					}
					if (phase === "challenge" && f.kind === "challenge") {
						phase = "welcome";
						send({ kind: "hello", runnerVersion: VERSION, epoch, time: Date.now(), signature: proof(key, controlProof(uid, machineId, f.nonce)) });
					} else if (phase === "welcome" && f.kind === "welcome") {
						phase = "online"; idle = f.idleSuspendMs; backoff = 1000;
						mayMaintain = true;
						status("Online");
						lastRefresh = Date.now();
						await owner.welcome(active);
						if (!active.aborted) owner.publishReport?.();
					} else if (phase !== "online") { reason = "Unexpected control handshake"; disconnect(); }
					else if (f.kind === "attach") {
						if (sessions.get(f.sessionId)?.refused) return;
						attaching.set(f.sessionId, f.ticket);
						try {
							const client = await currentClient();
							if (active.aborted || attaching.get(f.sessionId) !== f.ticket) return;
							const socket = await openSocket(client.agentSession.get([uid, f.sessionId]).webSocket("runner"), active);
							if (active.aborted || refusal || ws.readyState !== 1 || attaching.get(f.sessionId) !== f.ticket) { socket.close(); return; }
							socket.addEventListener("close", e => audit(f.sessionId, null, "session", `socket close ${e.code}`));
							let session = sessions.get(f.sessionId);
							if (session?.refused) { socket.close(); return; }
							if (!session) {
								session = new Session(f.sessionId, owner, () => { if (sessions.get(f.sessionId) === session) sessions.delete(f.sessionId); });
								sessions.set(f.sessionId, session);
							}
							session.attach(socket, { machineId, runnerVersion: VERSION, ticket: f.ticket, signature: proof(key, sessionProof(uid, f.sessionId, machineId, f.ticket)) });
						} catch (error) {
							audit(f.sessionId, null, "attach", category(error));
							if (refusal || slow) { reason = category(error); disconnect(); }
						}
						finally { if (attaching.get(f.sessionId) === f.ticket) attaching.delete(f.sessionId); }
					} else if (f.kind === "remove") {
						await owner.serial(() => owner.requestedRemoval(f.sandbox));
						audit(null, /^mm_[0-9a-f]{16}-[0-9a-f]{12}$/.test(f.sandbox) ? f.sandbox : null, "remove", "done");
						if (ws.readyState === 1) send({ kind: "removed", sandbox: f.sandbox });
					} else if (f.kind === "logout") { await owner.serial(() => owner.logout()); audit(null, null, "logout", "done"); }
					else if (f.kind !== "heartbeat") { reason = "Unexpected control frame"; disconnect(); }
				};
				ws.addEventListener("message", e => { void message(e.data).catch(error => { reason = category(error); disconnect(); }); });
				try { if (active.aborted) disconnect(); await closed; }
				finally { clearInterval(heartbeat); active.removeEventListener("abort", disconnect); }
			} catch (error) { reason = category(error); }
			finally { attempt.abort(); owner.publishReport = undefined; }
			if (signal.aborted) break;
			if (refusal || slow) {
				mayMaintain = false; idle = undefined;
				await (discarding ?? stopSessions());
				if (refusal?.reason === "removed") {
					removed = true;
					audit(null, null, "control", reason);
					const action = refusal.removeSandboxes ? "prune" : "suspend";
					let warning = "";
					try { await owner.serial(() => action === "prune" ? owner.prune() : owner.suspendAll()); }
					catch (error) {
						audit(null, null, action, category(error));
						warning = ` Docker could not ${action} all of its sandboxes. Check the runner log.`;
					}
					return "This machine was removed from its account, so run `windlass-runner pair` to pair it again with a new key." + warning;
				}
				if (refusal) reason = `${refusal.reason}: ${safeSentence(refusal.message)} (${reason})`;
				status(reason);
			} else {
				// A restarted runner can lose the network before its first welcome. The last
				// accepted idle time is still the dead-man switch for its existing containers.
				mayMaintain = idle !== undefined;
				status("Offline: " + reason);
			}
			await wait(refusal || slow ? REFUSED_RETRY_MS : Math.min(60_000, backoff * (0.8 + Math.random() * 0.4)), undefined, { signal }).catch(() => {});
			backoff = Math.min(60_000, backoff * 2);
		}
	} finally { mayMaintain = false; clearInterval(timer); await stopSessions(); if (!removed) status("Stopped"); }
}
