import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { Agent, createServer, request } from "node:http";
import { codexProvider, persist } from "../sandbox/relay/codex.cjs";
import { createRelay, Stopping } from "../sandbox/relay/server.cjs";
import { forward } from "../runner/src/egress-proxy.mjs";

test("Codex allows only the Responses and versioned model-list routes", async () => {
	const provider = codexProvider("openai", "generation", {
		load: async () => ({ generation: "generation", provider: "openai", key: "sk-fixture" }),
	});
	for (const url of ["/codex/v1/models", "/codex/v1/models?client_version=0.171.0"])
		assert.equal(provider.methodFor(url), "GET");
	assert.equal(provider.methodFor("/codex/v1/responses"), "POST");
	for (const url of [
		"/codex/v1/models?redirect_uri=x",
		"/codex/v1/responses?x",
		"/codex/v1/chat/completions",
		"https://example.com",
	])
		assert.equal(provider.accepts(url), false);
	const target = await provider.target("/codex/v1/models", {
		authorization: "Bearer ignored",
		host: "example.com",
		cookie: "ignored",
	});
	assert.deepEqual(
		[target.hostname, target.path, target.headers.authorization],
		["api.openai.com", "/v1/models", "Bearer sk-fixture"],
	);
	assert.equal(target.headers.cookie, undefined);
});
test("two expired sessions share one refresh and the rotated token", async () => {
	let calls = 0,
		saves = 0,
		record = { generation: "g", provider: "chatgpt", access: "expired", refresh: "old", expires: 1 };
	const auth = codexProvider("chatgpt", "g", {
		load: async () => record,
		persist: async value => {
			saves++;
			record = value;
		},
		exchange: async (url, opts) => {
			assert.equal(url, "https://auth.openai.com/oauth/token");
			assert.equal(opts.body.get("refresh_token"), "old");
			calls++;
			await new Promise(resolve => setTimeout(resolve, 10));
			return {
				ok: true,
				json: async () => ({ access_token: "new-access", refresh_token: "rotated", expires_in: 300 }),
			};
		},
	});
	const targets = await Promise.all(["/codex/v1/responses", "/codex/v1/models"].map(url => auth.target(url, {})));
	assert.equal(calls, 1);
	assert.equal(saves, 1);
	assert.equal(record.refresh, "rotated");
	assert.deepEqual(
		targets.map(t => t.headers.authorization),
		["Bearer new-access", "Bearer new-access"],
	);
	assert.equal(targets[1].path, "/backend-api/codex/models?client_version=0.171.0");
});
test("killing the refresh writer before rename preserves the previous credential", async t => {
	const dir = await mkdtemp(join(tmpdir(), "codex-atomic-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "login.json");
	await writeFile(path, "old", { mode: 0o400 });
	// Intercept only the rename syscall. The real persist function has written its temp file.
	const script = `require('node:fs/promises').rename=async()=>{process.send('ready');setInterval(()=>{},1000);};
	require(process.argv[1]).persist({refresh:'new'},process.argv[2]).catch(()=>process.exit(1));`;
	const child = spawn(
		process.execPath,
		["-e", script, new URL("../sandbox/relay/codex.cjs", import.meta.url).pathname, path],
		{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
	);
	const exit = once(child, "exit");
	t.after(() => child.kill("SIGKILL"));
	await Promise.race([
		once(child, "message"),
		exit.then(() => {
			throw Error("writer exited before rename");
		}),
	]);
	child.kill("SIGKILL");
	await exit;
	assert.equal(await readFile(path, "utf8"), "old");
	await persist({ refresh: "new" }, path);
	assert.equal((await stat(path)).mode & 0o777, 0o400);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { refresh: "new" });
});

test("owner validation forces exactly one rotation after the first Responses request", async () => {
	let record = {
		provider: "chatgpt",
		generation: "g",
		access: "initial",
		refresh: "first-refresh",
		expires: Date.now() + 600000,
		verifyRefreshAfterTurn: true,
	};
	let calls = 0;
	const relay = codexProvider("chatgpt", "g", {
		load: async () => record,
		persist: async next => {
			record = next;
		},
		exchange: async () => {
			calls++;
			return {
				ok: true,
				json: async () => ({ access_token: "rotated", refresh_token: "second-refresh", expires_in: 600 }),
			};
		},
	});
	for (const [route, token] of [
		["models", "initial"],
		["responses", "initial"],
		["models", "rotated"],
		["responses", "rotated"],
	])
		assert.equal((await relay.target("/codex/v1/" + route, {})).headers.authorization, "Bearer " + token);
	assert.equal(calls, 1);
	assert.equal(record.verifyRefreshAfterTurn, undefined);
});
test("interleaved Responses deltas scrub a split credential and preserve other output", async () => {
	const key = "sk-canary-0123456789";
	const provider = codexProvider("openai", "g", { load: async () => ({ provider: "openai", generation: "g", key }) });
	await provider.target("/codex/v1/responses", {});
	const filter = provider.responseFilter("text/event-stream");
	let result = "";
	filter.on("data", chunk => (result += chunk));
	const finished = once(filter, "end");
	for (const [id, delta] of [
		["one", key.slice(0, 8)],
		["two", "hello"],
		["one", key.slice(8)],
	])
		filter.write("data: " + JSON.stringify({ type: "response.output_text.delta", item_id: id, delta }) + "\n\n");
	filter.end();
	await finished;
	const content = result
		.split("\n")
		.filter(s => s.startsWith("data: "))
		.map(s => JSON.parse(s.slice(6)).delta)
		.join("");
	assert.ok(content.includes("hello"));
	assert.ok(!content.includes(key.slice(0, 8)));
	assert.ok(!content.includes(key.slice(8)));
});
test("the catalog filter keeps model ids whose UTF-8 bytes are split across chunks", async () => {
	const auth = codexProvider("openai", "g", {
		load: async () => ({ provider: "openai", generation: "g", key: "sk-x" }),
	});
	const bytes = Buffer.from(JSON.stringify({ data: [{ id: "gpt-é-π-模型" }, { id: "plain" }] }));
	const out = await text(Readable.from(Array.from(bytes, b => Buffer.from([b]))).pipe(auth.catalogFilter()));
	assert.deepEqual(JSON.parse(out), { data: [{ id: "gpt-é-π-模型" }, { id: "plain" }] });
});
test("a refresh reply without a refresh token keeps the current one", async () => {
	let record = { generation: "g", provider: "chatgpt", access: "expired", refresh: "kept", expires: 1 };
	const auth = codexProvider("chatgpt", "g", {
		load: async () => record,
		persist: async value => {
			record = value;
		},
		exchange: async () => ({ ok: true, json: async () => ({ access_token: "new-access", expires_in: 300 }) }),
	});
	assert.equal((await auth.target("/codex/v1/responses", {}))?.headers.authorization, "Bearer new-access");
	assert.equal(record.refresh, "kept");
	assert.equal(record.access, "new-access");
});
test("SIGTERM during a refresh exits only after the rotated token is saved", async t => {
	const dir = await mkdtemp(join(tmpdir(), "codex-stop-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "login.json");
	await writeFile(
		path,
		JSON.stringify({ generation: "g", provider: "chatgpt", access: "expired", refresh: "spent", expires: 1 }),
		{ mode: 0o400 },
	);
	const script = `const relay = require(process.argv[1]), { stopOnSignal } = require(process.argv[2]), fs = require('node:fs/promises');
	const path = process.argv[3];
	const provider = relay.codexProvider('chatgpt', 'g', {
		load: async () => JSON.parse(await fs.readFile(path, 'utf8')),
		persist: (record) => relay.persist(record, path),
		exchange: async () => { process.send('exchanging'); await new Promise((r) => setTimeout(r, 500));
			return { ok: true, json: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated', expires_in: 300 }) }; },
	});
	stopOnSignal(require('node:net').createServer().listen(0), provider);
	provider.target('/codex/v1/responses', {});`;
	const child = spawn(
		process.execPath,
		[
			"-e",
			script,
			new URL("../sandbox/relay/codex.cjs", import.meta.url).pathname,
			new URL("../sandbox/relay/server.cjs", import.meta.url).pathname,
			path,
		],
		{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
	);
	t.after(() => child.kill("SIGKILL"));
	const exit = once(child, "exit");
	await once(child, "message");
	child.kill("SIGTERM");
	assert.deepEqual(await exit, [0, null]);
	assert.equal(JSON.parse(await readFile(path, "utf8")).refresh, "rotated");
});
test("a stopping relay starts no new refresh", async () => {
	let calls = 0;
	const auth = codexProvider("chatgpt", "g", {
		load: async () => ({ generation: "g", provider: "chatgpt", access: "expired", refresh: "old", expires: 1 }),
		persist: async () => {},
		exchange: async () => {
			calls++;
			return { ok: true, json: async () => ({ access_token: "a", refresh_token: "b", expires_in: 300 }) };
		},
	});
	await auth.drain();
	await assert.rejects(auth.target("/codex/v1/responses", {}), Stopping);
	assert.equal(calls, 0);
});

/** A Codex relay on a Unix socket, as in the relay container, with the session's forwarder in front of it. */
async function relayAndForwarder(t, { stopping = false, modelsType = "application/json" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "codex-forward-"));
	const socket = join(dir, "relay.sock"),
		marker = join(dir, "signed-out"),
		notes = join(dir, "relay-notes.json");
	const held = [];
	const origin = createServer((req, res) => {
		if (req.url.endsWith("/responses")) return held.push(res);
		res.writeHead(200, modelsType ? { "content-type": modelsType } : {});
		res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
	});
	await new Promise(done => origin.listen(0, "127.0.0.1", done));
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const nonce = "c".repeat(32);
	const bearer =
		"Bearer " + nonce + "." + sign(null, Buffer.from("test\nmachine\n" + nonce), privateKey).toString("base64url");
	// A stopping relay still serves an API key; it refuses only a ChatGPT token that needs a refresh.
	const provider = stopping
		? codexProvider("chatgpt", "g", {
				load: async () => ({ generation: "g", provider: "chatgpt", access: "expired", refresh: "r", expires: 1 }),
			})
		: codexProvider("openai", "g", { load: async () => ({ generation: "g", provider: "openai", key: "sk-fixture" }) });
	if (stopping) await provider.drain();
	const relay = createRelay({
		publicKey,
		machine: "machine",
		domain: "test",
		provider,
		signedOut: () => existsSync(marker),
		notesFile: notes,
		forward: (options, cb) => request({ ...options, hostname: "127.0.0.1", port: origin.address().port }, cb),
	});
	const sockets = new Set();
	relay.on("connection", s => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise(done => relay.listen(socket, done));
	const forwarder = forward(0, socket, nonce, true);
	await once(forwarder, "listening");
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	const call = (method, path) =>
		new Promise((ok, fail) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: forwarder.address().port,
					method,
					path,
					agent,
					headers: { host: "127.0.0.1:17892", authorization: bearer, "content-type": "application/json" },
				},
				res => {
					res.resume();
					res.on("end", () =>
						ok({
							status: res.statusCode,
							connection: res.headers.connection,
							reused: req.reusedSocket,
							headers: res.headers,
						}),
					);
				},
			);
			req.on("error", fail);
			req.end(method === "POST" ? "{}" : undefined);
		});
	/** A Responses request whose upstream answer the check writes. */
	const answer = async (status, headers, body, requestBody = "{}") => {
		const turn = new Promise((ok, fail) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: forwarder.address().port,
					method: "POST",
					path: "/codex/v1/responses",
					agent,
					headers: { host: "127.0.0.1:17892", authorization: bearer, "content-type": "application/json" },
				},
				res => {
					text(res).then(body => ok({ status: res.statusCode, type: res.headers["content-type"], body }), fail);
				},
			);
			req.on("error", fail);
			req.end(requestBody);
		});
		while (!held.length) await new Promise(r => setTimeout(r, 10));
		held.shift().writeHead(status, headers).end(body);
		return turn;
	};
	/** The relay process exits: its listener and every connection close, as at SIGTERM after drain. */
	const exit = () => {
		relay.close();
		for (const s of sockets) s.destroy();
	};
	t.after(async () => {
		agent.destroy();
		forwarder.close();
		exit();
		origin.closeAllConnections();
		origin.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { call, answer, exit, held, marker, notes };
}
test("logout during a request on a warm connection still answers the signed-out status", {
	timeout: 10_000,
}, async t => {
	const relay = await relayAndForwarder(t);
	const warm = await relay.call("GET", "/codex/v1/models");
	assert.equal(warm.status, 200);
	// The relay closes every connection after its reply, so the next request cannot reuse an answered one.
	assert.equal(warm.connection, "close");
	const turn = relay.call("POST", "/codex/v1/responses");
	while (!relay.held.length) await new Promise(r => setTimeout(r, 10));
	await writeFile(relay.marker, "");
	relay.exit();
	const { headers, ...signedOut } = await turn;
	assert.deepEqual(signedOut, { status: 401, connection: "close", reused: false });
});
test("a relay that is being replaced answers retryable, and signed out only after a logout", {
	timeout: 10_000,
}, async t => {
	const stopping = await relayAndForwarder(t, { stopping: true });
	const replacing = await stopping.call("POST", "/codex/v1/responses");
	assert.equal(replacing.status, 503);
	await writeFile(stopping.marker, "");
	assert.equal((await stopping.call("POST", "/codex/v1/responses")).status, 401);
	const gone = await relayAndForwarder(t);
	gone.exit();
	assert.equal((await gone.call("GET", "/codex/v1/models")).status, 503);
	await writeFile(gone.marker, "");
	assert.equal((await gone.call("GET", "/codex/v1/models")).status, 401);
	const cut = await relayAndForwarder(t);
	const pending = cut.call("POST", "/codex/v1/responses");
	while (!cut.held.length) await new Promise(r => setTimeout(r, 10));
	cut.exit();
	assert.equal((await pending).status, 503);
});
test("Codex rate-limit headers reach the client through the forwarder, on success and on a 429", {
	timeout: 10_000,
}, async t => {
	const relay = await relayAndForwarder(t);
	const limits = {
		"x-codex-primary-used-percent": "91.5",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": "1763800000",
		"x-codex-secondary-used-percent": "40",
		"x-codex-credits-has-credits": "false",
		"x-codex-credits-unlimited": "false",
		"x-codex-rate-limit-reached-type": "primary",
		"x-ratelimit-remaining-requests": "3",
	};
	const hidden = {
		"x-request-id": "r",
		"openai-organization": "o",
		"set-cookie": "c",
		"x-codex-turn-state": "s",
		"x-codex-promo-message": "p",
		"x-codex-secondary-reset-at": "sk-fixture",
	};
	for (const [status, extra] of [
		[200, { "content-type": "text/event-stream" }],
		[429, { "retry-after": "30" }],
	]) {
		const turn = relay.call("POST", "/codex/v1/responses");
		while (!relay.held.length) await new Promise(r => setTimeout(r, 10));
		relay.held
			.shift()
			.writeHead(status, { ...limits, ...hidden, ...extra })
			.end(status === 200 ? "data: {}\n\n" : '{"error":{"type":"usage_limit_reached"}}');
		const { headers, ...reply } = await turn;
		assert.equal(reply.status, status);
		for (const [name, value] of Object.entries(limits)) assert.equal(headers[name], value, name);
		for (const name of Object.keys(hidden)) assert.equal(headers[name], undefined, name);
		if (status === 429) assert.equal(headers["retry-after"], "30");
	}
});
test("an untyped 200 on the Responses route is passed as an event stream, and any other untyped or foreign answer is refused and noted", {
	timeout: 10_000,
}, async t => {
	const relay = await relayAndForwarder(t, { modelsType: null });
	const stream = 'data: {"type":"response.completed"}\n\n';
	// chatgpt.com/backend-api answers a ChatGPT-token stream with no content type, or as text/plain.
	for (const headers of [{}, { "content-type": "text/plain; charset=utf-8" }]) {
		const reply = await relay.answer(200, headers, stream);
		assert.deepEqual(reply, { status: 200, type: "text/event-stream", body: stream }, JSON.stringify(headers));
	}
	// A page on the streaming route is no model answer.
	const page = await relay.answer(200, { "content-type": "text/html" }, "<html>sk-fixture</html>");
	assert.equal(page.status, 502);
	assert.doesNotMatch(page.body, /html|sk-fixture/);
	// Only the streaming route: an untyped model list is still refused.
	assert.equal((await relay.call("GET", "/codex/v1/models")).status, 502);
	// Each refusal is noted with the upstream status and type, and nothing of the request's credential or body.
	let noted = [];
	for (let i = 0; i < 100 && noted.filter(n => n.event === "refused_200").length < 2; i++) {
		await new Promise(r => setTimeout(r, 20));
		noted = JSON.parse(await readFile(relay.notes, "utf8").catch(() => "[]"));
	}
	const refused = noted.filter(n => n.event === "refused_200");
	assert.deepEqual(
		refused.map(n => [n.route, n.upstream, n.contentType, n.answered]),
		[
			["POST /codex/v1/responses", 200, "text/html", 502],
			["GET /codex/v1/models", 200, "none", 502],
		],
	);
	assert.deepEqual(
		noted.filter(n => n.event === "untyped_200").map(n => n.contentType),
		["none", "text/plain"],
	);
	assert.doesNotMatch(JSON.stringify(noted), /sk-fixture|Bearer|html>/);
});
test("relay diagnostics omit credentials, bodies and arbitrary upstream header values", async t => {
	const relay = await relayAndForwarder(t);
	const lines = [];
	t.mock.method(console, "error", line => lines.push(line));
	await relay.answer(
		403,
		{ "content-type": "text/html; secret=sk-fixture", "content-encoding": "request-marker" },
		"upstream-marker",
		"request-marker",
	);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /event=upstream_error .*upstream=403/);
	assert.doesNotMatch(lines[0], /sk-fixture|request-marker|upstream-marker|Bearer/);
});

test("the OpenCode relay reads only a ChatGPT sign-in's Responses answer as an event stream", async () => {
	const { providerFor } = await import("../sandbox/relay/opencode.cjs");
	const chatgpt = providerFor(["chatgpt"], "g", { load: async () => ({}) });
	assert.equal(chatgpt.untyped("POST", "/openai/responses"), "text/event-stream");
	assert.equal(chatgpt.untyped("GET", "/openai/responses"), null);
	assert.equal(chatgpt.untyped("POST", "/openai/chat/completions"), null);
	const keyed = providerFor(["openai"], "g", { load: async () => ({}) });
	assert.equal(keyed.untyped("POST", "/openai/responses"), null);
});
