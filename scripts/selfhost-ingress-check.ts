// Offline cloudflared rule matching, with real HTTP and WebSocket traffic to a loopback demo stack.
import { loginHttp } from "./login-http.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:http";
import { createClient, type Registry } from "../server/src/client.js";
import { StandInRunner, until } from "./runner-standin.js";

const [config, webHost, engineHost] = process.argv.slice(2);
assert(config && webHost && engineHost, "usage: selfhost-ingress-check.ts CONFIG WEB_HOST ENGINE_HOST");
const cf = (...args: string[]) => execFileSync("cloudflared", ["tunnel", "--config", config, "ingress", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
cf("validate");
const services = new Map<string, string>();
function match(host: string, path: string) {
	const url = "https://" + host + path;
	let service = services.get(url);
	if (!service) {
		service = /^\s*service: (\S+)$/m.exec(cf("rule", url))?.[1];
		assert(service, "Missing ingress service");
		services.set(url, service);
	}
	return service;
}
function loopback(service: string) {
	const url = new URL(service);
	assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === service, "Expected a loopback HTTP service");
	return url;
}
for (const path of ["/namespaces", "/namespaces/default", "/pools", "/pools/default", "/nodes", "/envoys/connect", "/auth/tokens", "/actors", "/actors/id/fork", "/metadata", "/gateway/other/connect", "/unknown"]) {
	assert.equal(match(engineHost, path), "http_status:404", path + " must return an ingress 404");
}
assert.equal(match("unconfigured.invalid", "/"), "http_status:404");
const web = loopback(match(webHost, "/")).origin;
for (const path of ["/health", "/platform/info", "/platform/connection", "/runner/pair", "/runner/pair/poll", "/runner/connection"]) {
	assert.equal(match(webHost, path), web, path + " must reach the app");
}
assert.equal(match(engineHost, "/gateway/login/action/start"), "http_status:404");
const gateway = loopback(match(engineHost, "/gateway/user/action/me")).origin;
assert((await (await fetch(web + "/platform/info")).json()).demoEnabled, "Requires a demo stack");
const discovery = async () => (await (await fetch(web + "/platform/connection")).json());
const info = await discovery();
assert.equal(info.endpoint, gateway, "Run against the selected loopback gateway");

// Resolve each incoming path with cloudflared. Keep credentials (query and protocols) out of its argv.
const edge = createServer();
function target(path: string) {
	const service = match(engineHost, new URL(path, gateway).pathname);
	assert.equal(service, gateway, "Gateway path was refused by ingress");
	return new URL(service);
}
edge.on("request", (req, res) => {
	if (match(engineHost, new URL(req.url!, gateway).pathname) === "http_status:404") { res.writeHead(404).end(); return; }
	const upstream = request(target(req.url!), { path: req.url, method: req.method, headers: req.headers }, reply => {
		res.writeHead(reply.statusCode!, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => res.destroy());
	req.pipe(upstream);
});
edge.on("upgrade", (req, client, head) => {
	const upstream = request(target(req.url!), { path: req.url, headers: req.headers });
	upstream.on("upgrade", (reply, socket, rest) => {
		client.write("HTTP/1.1 101 Switching Protocols\r\n");
		for (let i = 0; i < reply.rawHeaders.length; i += 2) client.write(reply.rawHeaders[i] + ": " + reply.rawHeaders[i + 1] + "\r\n");
		client.write("\r\n");
		if (rest.length) client.write(rest);
		if (head.length) socket.write(head);
		socket.on("error", () => client.destroy());
		client.on("error", () => socket.destroy());
		client.on("close", () => socket.destroy());
		socket.pipe(client).pipe(socket);
	});
	upstream.on("response", reply => { reply.resume(); client.destroy(); });
	upstream.on("error", () => client.destroy());
	upstream.end();
});
await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
const address = edge.address();
assert(address && typeof address !== "string");
const endpoint = "http://127.0.0.1:" + address.port;
const credentials = { namespace: info.namespace, getToken: async () => (await discovery()).token.token };
const client = createClient<Registry>({ endpoint, ...credentials, disableMetadataLookup: true });
const runner = new StandInRunner(web, endpoint, { ...credentials, claude: true });
// Staging advertises its direct loopback address. Dial the same gateway through the test edge.
const connect = runner.fake.connect.bind(runner.fake);
runner.fake.connect = (connection, id, opts) => {
	assert.equal(connection.endpoint, gateway);
	return connect({ ...connection, endpoint }, id, opts);
};
try {
	const admin = process.env.RIVET_ADMIN_TOKEN;
	const options = admin ? { headers: { authorization: "Bearer " + admin } } : {};
	for (const path of ["/namespaces", "/pools", "/auth/tokens", "/envoys/connect", "/actors"]) {
		assert.equal((await fetch(endpoint + path, options)).status, 404);
	}
	const { profile: { uid }, token } = await loginHttp(web).demo();
	const user = client.user.get([uid], { params: { token } });
	await runner.pair(user);
	try {
		await runner.connectControl();
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		await until("machine report", async () => (await user.machines()).some(m => m.machineId === place.machineId && m.commandSandbox));
		const { id } = await user.createSession({ harness: "claude", profile: "docker-hardened", place });
		const socket = client.agentSession.get([uid, id], { params: { token } }).connect();
		try {
			const { turn } = await socket.prompt({ text: "stream" });
			await until("successful runner turn", async () => (await socket.snapshot()).timeline.some(i => i.kind === "turn.ended" && i.turn === turn && i.outcome === "succeeded"));
		} finally { await socket.dispose(); await user.freeSandbox(id); }
	} finally { await user.removeMachine({ machineId: runner.id.machineId, removeSandboxes: true }); }
	console.log("PASS ingress 404s, demo login, actor actions, control socket and streamed runner session");
} finally {
	await runner.setOffline(true);
	await client.dispose();
	edge.close();
}
// The SDK keeps reconnect timers alive after the check.
process.exit(0);
