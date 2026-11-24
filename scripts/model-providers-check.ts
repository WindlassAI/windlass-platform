import "./check-secret.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { format } from "node:util";
import { MODEL_PROVIDERS, type ModelProvider } from "../server/src/contract.js";
import { MODEL_PROVIDER_TABLES, modelKeyTransitSubject, modelProviderActions as actions } from "../server/src/model-providers.js";
import type { DefaultsDb } from "../server/src/repository-defaults.js";
import { createSealer, serverSealer } from "../server/src/signin/seal.js";
import { issueServiceToken, issueUserToken } from "../server/src/tokens.js";

const hex = () => randomBytes(32).toString("hex");
const makeKeys = () => ({
	openai: "sk-proj-" + hex(), anthropic: "sk-ant-api03-" + hex(),
	google: "AIza" + hex().slice(0, 35), openrouter: "sk-or-v1-" + hex(),
});

function account(uid: string) {
	const sql = new DatabaseSync(":memory:");
	for (const table of MODEL_PROVIDER_TABLES) sql.exec(table);
	const db: DefaultsDb = { async execute<Row>(query: string, ...args: unknown[]) {
		return sql.prepare(query).all(...args as SQLInputValue[]) as Row[];
	} };
	const profile = { uid, email: null, demo: false };
	const context = { db, key: [uid], vars: { tokenGen: 0 }, conn: { params: { token: issueUserToken(profile, 0) } } };
	return { sql, context, internal: { ...context, conn: { params: { token: issueServiceToken() } } } };
}

test("model provider actions keep keys sealed and check with the provider", async t => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const keys = makeKeys(), bad = makeKeys();
	const secrets = [...Object.values(keys), ...Object.values(bad)];
	function hasSecret(value: unknown) {
		const text = format("%o", value);
		return secrets.some(key => text.includes(key) || text.includes(key.slice(-12)));
	}
	const clean = (value: unknown) => assert.ok(!hasSecret(value), "credential in answer, storage or error");
	let loggedSecret = false;
	for (const method of ["debug", "info", "log", "warn", "error"] as const) t.mock.method(console, method, (...args: unknown[]) => { loggedSecret ||= hasSecret(args); });
	const oldRoot = { id: "old", secret: Buffer.from(hex()) };
	process.env.WLP_SIGNIN_KEYS = `current:${hex()},old:${oldRoot.secret}`;
	const old = createSealer([oldRoot]);
	const a = account("model-check-a"), b = account("model-check-b");
	t.after(() => { a.sql.close(); b.sql.close(); });
	const c = a.context;
	const paths = { openai: "/v1/models", anthropic: "/v1/models", google: "/v1beta/models", openrouter: "/api/v1/models" };
	let mode: "normal" | "redirect" | "hold" | "timeout" = "normal";
	let requests = 0, followed = false;
	const gate = new EventEmitter();
	const server = createServer(async (req, res) => {
		requests++;
		if (req.url === "/redirected") { followed = true; res.end(); return; }
		const provider = MODEL_PROVIDERS.find(p => req.url?.startsWith("/" + p + "/"));
		assert.ok(provider);
		const path = req.url!.slice(provider.length + 1);
		const metadata = provider === "openrouter" && path === "/api/v1/key";
		assert.ok(req.method === "GET" && (metadata || path === paths[provider]), "wrong method or path");
		const key = provider === "google" ? req.headers["x-goog-api-key"] : provider === "anthropic" ? req.headers["x-api-key"] : req.headers.authorization?.replace(/^Bearer /, "");
		if (provider === "openai" || provider === "openrouter") assert.ok(req.headers.authorization?.startsWith("Bearer "));
		if (provider === "openrouter" && !metadata) assert.ok(key === keys.openrouter);
		if (provider === "anthropic") assert.equal(req.headers["anthropic-version"], "2023-06-01");
		if (key !== keys[provider] && (provider !== "openrouter" || metadata)) {
			res.writeHead(401, "Rejected " + key).end(JSON.stringify({ error: key }));
			return;
		}
		if (mode === "redirect") { res.writeHead(307, { location: "/redirected" }).end(); return; }
		if (mode === "timeout") return;
		if (mode === "hold") { gate.emit("started"); await once(gate, "release"); }
		const ids = ["demo-model", String(key), String(key).slice(-12), ...Array.from({ length: 45 }, (_, i) => "m" + i)];
		res.end(JSON.stringify(metadata ? { data: { label: key } } : provider === "google"
			? { models: ids.map(id => ({ name: "models/" + id })) } : { data: ids.map(id => ({ id, description: key })) }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	for (const provider of MODEL_PROVIDERS) process.env[`WLP_${provider.toUpperCase()}_BASE_URL`] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${provider}`;

	const save = (provider: ModelProvider, key: string) => actions.saveModelProvider(c, { provider, key });
	const nonce = hex();
	await assert.rejects(actions.internalModelKey(c, "openai", nonce), /internal/);
	for (const call of [
		() => actions.modelProviders(a.internal), () => actions.checkModelProvider(a.internal, "google"),
		() => actions.removeModelProvider(a.internal, "google"), () => actions.saveModelProvider(a.internal, { provider: "google", key: keys.google }),
	]) await assert.rejects(call, /for users/);
	for (const provider of MODEL_PROVIDERS) {
		const wrong = provider === "openai" ? keys.anthropic : keys.openai;
		await assert.rejects(save(provider, wrong), err => { clean(err); return err instanceof Error && err.message.includes("format"); });
		const saved = await save(provider, keys[provider]);
		clean(saved);
		assert.equal(saved.last4, keys[provider].slice(-4));
		assert.ok(saved.ok && saved.checkedAt! >= saved.addedAt && saved.models?.length === 32);
		assert.equal(saved.models[0], "demo-model");
		const checked = await actions.checkModelProvider(c, provider);
		clean(checked);
		assert.ok(checked.ok);
		clean(await actions.modelProviders(c));
		clean(await c.db.execute("SELECT * FROM model_provider"));
		const failed = await save(provider, bad[provider]);
		clean(failed);
		assert.ok(!failed.ok && failed.message?.includes("check the key") && !failed.models);
		assert.deepEqual(await actions.modelProviders(c), [{ provider, last4: bad[provider].slice(-4), addedAt: failed.addedAt, checkedAt: failed.checkedAt, ok: false }]);
		await actions.removeModelProvider(c, provider);
		assert.equal(await actions.internalModelKey(a.internal, provider, nonce), null);
	}
	assert.deepEqual(await actions.modelProviders(c), []);

	const before = requests;
	for (const call of [() => save("google", keys.google), () => actions.checkModelProvider(c, "openai")]) {
		await assert.rejects(call, err => { clean(err); return err instanceof Error && err.message.includes("next minute"); });
	}
	assert.equal(requests, before);
	assert.ok((await actions.saveModelProvider(b.context, { provider: "openai", key: keys.openai })).ok);
	now += 60_000;
	a.internal.conn.params.token = issueServiceToken();
	await save("openai", keys.openai);

	const owner = JSON.stringify([c.key[0], "openai"]);
	const oldBlob = old.seal("model-key", owner, keys.openai);
	a.sql.prepare("UPDATE model_provider SET sealed = ? WHERE provider = 'openai'").run(oldBlob);
	const sealed = await actions.internalModelKey(a.internal, "openai", nonce);
	assert.ok(sealed);
	clean(sealed);
	const transit = modelKeyTransitSubject(c.key[0], "openai", nonce);
	const payload = JSON.parse(serverSealer().open("transit", transit, sealed));
	const [row] = await c.db.execute<{ sealed: string; generation: string }>("SELECT sealed, generation FROM model_provider WHERE provider = 'openai'");
	assert.ok(serverSealer().isCurrent(row.sealed) && payload.key === keys.openai && payload.generation === row.generation);
	assert.ok(serverSealer().open("model-key", owner, row.sealed) === keys.openai);
	for (const subject of [JSON.stringify([b.context.key[0], "openai"]), JSON.stringify([c.key[0], "google"])]) {
		assert.throws(() => serverSealer().open("model-key", subject, row.sealed));
	}
	assert.throws(() => serverSealer().open("secret", owner, row.sealed));
	assert.throws(() => serverSealer().open("transit", modelKeyTransitSubject(c.key[0], "openai", hex()), sealed));

	mode = "hold";
	const started = once(gate, "started");
	const checking = actions.checkModelProvider(c, "openai");
	await started;
	await actions.removeModelProvider(c, "openai");
	mode = "normal";
	await save("openai", keys.openai);
	gate.emit("release");
	await assert.rejects(checking, /changed during the check/);

	mode = "redirect";
	const redirected = await actions.checkModelProvider(c, "openai");
	assert.ok(!redirected.ok && !followed);
	mode = "timeout";
	const timedOut = await actions.checkModelProvider(c, "openai");
	clean(timedOut);
	assert.ok(!timedOut.ok && timedOut.message);
	assert.ok(!loggedSecret, "credential in logs");
});
