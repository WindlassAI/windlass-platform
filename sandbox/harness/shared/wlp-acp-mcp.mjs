#!/usr/bin/env node
// Runs an ACP agent (OpenCode, Codex) and serves it the MCP servers its client declares with "type": "acp"
// (MCP-over-ACP): the client answers each MCP request as an `mcp/message` request on the same ACP
// connection, so the server's tools run in the client, never in this container. OpenCode's MCP client
// takes a URL, so each such server gets a loopback HTTP endpoint here, as Claude Code's adapter gives it
// one (claude-agent-acp, `McpOverAcp`). Everything else on the connection passes through unchanged.
//
// WLP_ACP_MCP_PORT fixes the endpoint's port (Codex): Codex starts an MCP server only if requirements.toml
// allows it by its exact URL, and codex-acp's own bridge listens on a random one. A port another process
// holds is not shared: the session then starts without the client's servers. The answer to `initialize`
// says this bridge is in front (`_meta["windlass-platform/acpMcp"]`), so the client can tell it from an
// adapter's own.
//
// Shared by the harness images (sandbox/harness/build.sh passes this directory as the `shared` context).
//
// What any process in the container can reach is that endpoint, on 127.0.0.1 only, from the first
// session that declares a server until this process ends with its turn. A request needs the bearer token
// of its server: an HMAC of a random secret this process keeps in memory, handed to the agent in its
// session's parameters only. The client bounds every call itself; the token keeps out a process that did
// not get it, and is worth nothing once this process is gone.
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const [command, ...args] = process.argv.slice(2);
if (!command) {
	process.stderr.write("usage: wlp-acp-mcp <agent> [args...]\n");
	process.exit(2);
}

const PROTOCOL = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
const MAX_ACTIVE = 8;
const ID_PREFIX = "wlp-mcp:";
const PORT = /^\d{1,5}$/.test(process.env.WLP_ACP_MCP_PORT ?? "") ? Number(process.env.WLP_ACP_MCP_PORT) : 0;

const secret = randomBytes(32);
const servers = new Map(); // route -> { serverId, name, token }
const pending = new Map(); // our request id -> resolve
const initialize = new Set(); // JSON ids of the client's initialize requests
let nextId = 1;
let active = 0;
let listening = null;

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
const toClient = line => process.stdout.write(line + "\n");
const toAgent = line => child.stdin.write(line + "\n");

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
	listening?.then(server => server.close()).catch(() => {});
	for (const resolve of pending.values()) resolve({ error: { code: -32603, message: "The agent ended." } });
	process.exitCode = code ?? (signal ? 1 : 0);
	setImmediate(() => process.exit());
});
child.on("error", error => {
	process.stderr.write(`wlp-acp-mcp: ${error.message}\n`);
	process.exit(127);
});
child.stdin.on("error", () => {});

const token = serverId => createHmac("sha256", secret).update(`wlp-acp-mcp\0${serverId}`).digest("base64url");
const route = serverId => `mcp-${Buffer.from(serverId, "utf8").toString("base64url")}`;
const isObject = value => typeof value === "object" && value !== null && !Array.isArray(value);
const parse = line => { try { return JSON.parse(line); } catch { return undefined; } };

function lines(stream, onLine) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", chunk => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			onLine(buffer.slice(0, at));
			buffer = buffer.slice(at + 1);
		}
	});
	stream.on("end", () => {
		if (buffer) onLine(buffer);
		buffer = "";
	});
}

function listen() {
	listening ??= new Promise((resolve, reject) => {
		const server = createServer((req, res) => void serve(req, res).catch(() => {
			if (!res.headersSent) reply(res, 500, rpcError(null, -33002, "MCP bridge failure"));
			else res.destroy();
		}));
		server.once("error", reject);
		server.listen({ port: PORT, host: "127.0.0.1", exclusive: true }, () => {
			server.off("error", reject);
			server.on("error", () => {});
			resolve(server);
		});
	});
	return listening;
}

/** The client's `acp` servers of a session, as HTTP servers of this endpoint. */
async function adapt(list) {
	if (!Array.isArray(list) || !list.some(s => isObject(s) && s.type === "acp")) return list;
	const port = (await listen()).address().port;
	return list.map(server => {
		if (!isObject(server) || server.type !== "acp") return server;
		if (typeof server.serverId !== "string" || typeof server.name !== "string") return server;
		const path = route(server.serverId);
		servers.set(path, { serverId: server.serverId, name: server.name, token: token(server.serverId) });
		return { type: "http", name: server.name, url: `http://127.0.0.1:${port}/${path}`, headers: [{ name: "Authorization", value: `Bearer ${token(server.serverId)}` }] };
	});
}

// Client -> agent. One at a time, so a session's servers are ready before the agent reads its request.
let order = Promise.resolve();
lines(process.stdin, line => {
	order = order.then(async () => {
		const message = parse(line);
		if (!isObject(message)) return toAgent(line);
		if (message.method === undefined && typeof message.id === "string" && message.id.startsWith(ID_PREFIX)) {
			const resolve = pending.get(message.id);
			pending.delete(message.id);
			resolve?.(isObject(message.result) ? message.result : { error: { code: -33002, message: isObject(message.error) && typeof message.error.message === "string" ? message.error.message : "The client did not serve the request." } });
			return;
		}
		if (message.method === "initialize" && message.id !== undefined) initialize.add(JSON.stringify(message.id));
		if (["session/new", "session/load", "session/resume"].includes(message.method) && isObject(message.params) && Array.isArray(message.params.mcpServers)) {
			try {
				return toAgent(JSON.stringify({ ...message, params: { ...message.params, mcpServers: await adapt(message.params.mcpServers) } }));
			} catch {
				// No endpoint: the session starts without the client's servers, as one Claude Code cannot reach.
				return toAgent(JSON.stringify({ ...message, params: { ...message.params, mcpServers: message.params.mcpServers.filter(s => !isObject(s) || s.type !== "acp") } }));
			}
		}
		toAgent(line);
	});
});
process.stdin.on("end", () => order.then(() => child.stdin.end()));

// Agent -> client: its answer to `initialize` says that it takes `acp` servers.
lines(child.stdout, line => {
	const message = parse(line);
	if (isObject(message) && message.method === undefined && initialize.delete(JSON.stringify(message.id)) && isObject(message.result)) {
		const caps = isObject(message.result.agentCapabilities) ? message.result.agentCapabilities : {};
		const mcp = isObject(caps.mcpCapabilities) ? caps.mcpCapabilities : {};
		const meta = isObject(message.result._meta) ? message.result._meta : {};
		return toClient(JSON.stringify({ ...message, result: { ...message.result, agentCapabilities: { ...caps, mcpCapabilities: { ...mcp, acp: true } }, _meta: { ...meta, "windlass-platform/acpMcp": 1 } } }));
	}
	toClient(line);
});

function rpcError(id, code, message) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function reply(res, status, body, headers = {}) {
	if (body === undefined) {
		res.writeHead(status, headers);
		return res.end();
	}
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

function authorized(header, expected) {
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	const given = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function body(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** One MCP request as the client takes it: an `mcp/message` request on the ACP connection. */
function forward(server, id, method, params) {
	const ours = `${ID_PREFIX}${nextId++}`;
	const meta = isObject(params?._meta) ? params._meta : {};
	const inner = { ...(isObject(params) ? params : {}), _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": PROTOCOL, "io.modelcontextprotocol/clientCapabilities": {} } };
	return new Promise(resolve => {
		pending.set(ours, resolve);
		toClient(JSON.stringify({ jsonrpc: "2.0", id: ours, method: "mcp/message", params: { serverId: server.serverId, requestId: `${ours}:${JSON.stringify(id)}`, method, params: inner } }));
	});
}

async function serve(req, res) {
	const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(1);
	const server = servers.get(path);
	if (!server || !authorized(req.headers.authorization, server.token)) {
		req.resume();
		return reply(res, server ? 401 : 404, undefined, server ? { "www-authenticate": "Bearer" } : {});
	}
	// No server-to-client stream and no session to end: requests only.
	if (req.method !== "POST") {
		req.resume();
		return reply(res, 405, undefined, { allow: "POST" });
	}
	const text = await body(req);
	if (text === null) return reply(res, 413, rpcError(null, -32600, "Request too large"));
	const message = parse(text);
	if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return reply(res, 400, rpcError(null, -32600, "Invalid request"));
	const { id, method, params } = message;
	if (id === undefined || id === null) return reply(res, 202);
	if (method === "initialize") {
		const asked = isObject(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : LEGACY[1];
		return reply(res, 200, { jsonrpc: "2.0", id, result: { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: server.name, version: "1" } } });
	}
	if (method === "ping") return reply(res, 200, { jsonrpc: "2.0", id, result: {} });
	if (active >= MAX_ACTIVE) return reply(res, 429, rpcError(id, -33000, "Too many requests at once"));
	active++;
	try {
		const outcome = await forward(server, id, method, params);
		if (isObject(outcome.error)) return reply(res, 200, { jsonrpc: "2.0", id, error: outcome.error });
		return reply(res, 200, { jsonrpc: "2.0", id, result: outcome.result ?? {} });
	} finally {
		active--;
	}
}
