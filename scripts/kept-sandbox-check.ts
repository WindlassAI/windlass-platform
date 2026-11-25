/// <reference lib="es2024.promise" />
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { localListeners } from "./check-listeners.js";
import { FakeAcpAgent } from "./acp-agent-fake.js";
import type { E2bCommandOptions } from "../server/src/sandbox/e2b/client.js";

test("a hosted Claude Code prompt can use the place freed during a provider sweep", { timeout: 90_000 }, async t => {
	const storage = await mkdtemp(join(tmpdir(), "wlp-kept-"));
	const { engine } = await localListeners(0);
	for (const key of Object.keys(process.env)) if (/^(WLP_|RIVET)/.test(key)) delete process.env[key];
	Object.assign(process.env, { RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(engine), RIVET_LOG_LEVEL: "warn",
		WLP_SECRET: randomBytes(32).toString("hex"), WLP_SANDBOX: "fake", WLP_MAX_KEPT_SANDBOXES: "1", WLP_DEMO: "1", WLP_IDLE_SUSPEND_MS: "1000",
		WLP_ANTHROPIC_BASE_URL: "https://models.invalid" });
	const { getLayer } = await import("../server/src/layer.js");
	const { FakeE2b, ScriptedMachine } = await import("../server/src/sandbox/e2b/fake.js");
	const { E2bSandboxes } = await import("../server/src/sandbox/e2b/sandboxes.js");
	const { readE2bSettings } = await import("../server/src/sandbox/e2b/config.js");
	class ClaudeMachine extends ScriptedMachine {
		override async start(command: string, options: E2bCommandOptions) {
			const started = await super.start(command, options);
			if (command.includes("wlp-claude-acp")) {
				const agent = new FakeAcpAgent(line => options.onStdout!(line), storage);
				started.sendStdin = async data => agent.input(data);
			}
			return started;
		}
	}
	const fake = new FakeE2b({ machine: () => new ClaudeMachine() });
	const sandboxes = new E2bSandboxes(fake, { ...readE2bSettings({}), openProfile: true, modelRelayOrigin: "https://relay.invalid" });
	(await getLayer()).sandboxes = sandboxes;
	const originalFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		String(input) === "https://models.invalid/v1/models" ? Response.json({ data: [{ id: "sonnet" }] }) : originalFetch(input, init));

	const { registry } = await import("../server/src/registry.js");
	const { createClient } = await import("../server/src/client.js");
	const { issueUserToken } = await import("../server/src/tokens.js");
	const { serviceParams } = await import("../server/src/auth.js");
	registry.start();
	await registry.startAndWait();
	const client = createClient<typeof registry>({ endpoint: "http://127.0.0.1:" + engine });
	t.after(async () => {
		await client.dispose();
		await registry.shutdown();
		await rm(storage, { recursive: true, force: true });
	});
	const uid = "u_kept";
	const params = { token: issueUserToken({ uid, email: null, demo: true }, 0) };
	const user = client.user.getOrCreate([uid], { params });
	const service = client.user.get([uid], { params: serviceParams() });
	const key = await user.saveModelProvider({ provider: "anthropic", key: "sk-ant-api03-" + randomBytes(32).toString("hex") });
	assert.ok(key.ok);
	const make = () => user.createSession({ profile: "e2b-open", harness: "claude" });
	const run = async (id: string) => {
		const session = client.agentSession.get([uid, id], { params });
		const { turn } = await session.prompt({ text: "plain" });
		for (;;) {
			t.signal.throwIfAborted();
			const snap = await session.snapshot();
			const ended = snap.timeline.find(row => row.turn === turn && row.kind === "turn.ended");
			if (ended?.kind === "turn.ended") {
				assert.equal(ended.outcome, "succeeded", ended.message ?? undefined);
				if (snap.summary.status === "idle" && snap.summary.sandbox === "paused") return;
			}
			await delay(50);
		}
	};
	const first = await make();
	await run(first.id);
	assert.equal((await user.usage()).sandboxes.kept, 1);
	const next = await make();
	await assert.rejects(client.agentSession.get([uid, next.id], { params }).prompt({ text: "plain" }), { code: "too_many_sandboxes" });

	// Return the inventory as it was before the action, after the action has finished.
	async function duringSweep(action: () => Promise<void>) {
		const captured = Promise.withResolvers<void>();
		const deliver = Promise.withResolvers<void>();
		const list = sandboxes.list.bind(sandboxes);
		t.mock.method(sandboxes, "list", async (owner: string) => {
			const rows = await list(owner);
			captured.resolve();
			await deliver.promise;
			return rows;
		}, { times: 1 });
		const sweep = service.internalSweepSandboxes();
		try {
			await captured.promise;
			await action();
		} finally {
			deliver.resolve();
			await sweep;
		}
	}
	await duringSweep(async () => {
		assert.equal((await user.freeSandbox(first.id)).sandboxes.kept, 0);
		assert.equal(fake.sandboxes.size, 0);
	});
	assert.equal((await user.usage()).sandboxes.kept, 0, "a late listing restored the freed sandbox");
	await duringSweep(() => run(next.id));
	assert.deepEqual((await user.usage()).kept.map(k => k.sessionId), [next.id]);
	// A provider removal whose release never reached the account left a fresh, settled claim.
	const [box] = await sandboxes.list(uid);
	assert.equal(box.sessionId, next.id);
	await fake.kill(box.id);
	await service.internalSweepSandboxes();
	assert.equal((await user.usage()).sandboxes.kept, 0);
});

async function buildProvider(t: TestContext, now = Date.now) {
	process.env.WLP_SANDBOX = "fake";
	process.env.WLP_SECRET ||= randomBytes(32).toString("hex");
	const { FakeE2b } = await import("../server/src/sandbox/e2b/fake.js");
	const { E2bSandboxes, META } = await import("../server/src/sandbox/e2b/sandboxes.js");
	const { readE2bSettings } = await import("../server/src/sandbox/e2b/config.js");
	const { getLayer } = await import("../server/src/layer.js");
	const settings = readE2bSettings({});
	const fake = new FakeE2b({ now });
	const layer = await getLayer();
	const original = layer.sandboxes;
	layer.sandboxes = new E2bSandboxes(fake, settings, { now });
	t.after(() => { layer.sandboxes = original; });
	return { fake, settings, META };
}

test("a sweep frees expired snapshot builders and counts only retained sessions", async t => {
	let now = Date.now();
	const { fake, settings, META } = await buildProvider(t, () => now);
	const { BUILD_LOST_MS } = await import("../server/src/environments.js");
	const { SNAP_META } = await import("../server/src/sandbox/e2b/snapshots.js");
	const { user } = await import("../server/src/actors/user.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { UsageBook } = await import("../server/src/usage.js");
	const { effectiveUserLimits } = await import("../server/src/user-limits.js");
	const uid = "u_builds";
	now -= BUILD_LOST_MS;
	const plant = (session: string, candidate: string) => fake.plant({
		[META.deployment]: settings.deployment, [META.uid]: uid, [META.session]: session, [META.profile]: "e2b", [META.size]: "standard",
		[SNAP_META.attempt]: "a".repeat(32), [SNAP_META.build]: "standard-build", [SNAP_META.variant]: "base", [SNAP_META.candidate]: candidate,
	}, "paused");
	const ids = ["s_personal", "s_item", "s_reader"];
	const sessions = new Map(ids.map(id => [id, { id, createdAt: now, environmentBuild: false }]));
	for (const id of ids) await plant(id, "");
	const deleted = await plant("s_deleted", "b".repeat(64));
	const stale = await plant("s_hidden", "c".repeat(64));
	sessions.set("s_hidden", { id: "s_hidden", createdAt: now, environmentBuild: true });
	const usage = new UsageBook(effectiveUserLimits({ maxKept: 5 }).usage);
	for (const id of [...ids, "s_deleted", "s_hidden"]) usage.reserve(Date.now(), { id, session: id, keep: true });
	assert.equal(usage.numbers(Date.now()).sandboxes.kept, 5);
	now = Date.now();
	const active = await plant("s_active", "d".repeat(64));
	sessions.set("s_active", { id: "s_active", createdAt: now, environmentBuild: true });
	const young = await plant("s_missing", "e".repeat(64));
	const vars = { sessions, usage, items: { limits: { overrides: { maxKept: 5 } } }, keptGeneration: 0, listed: null };
	const ctx = { vars, key: [uid], conn: { params: serviceParams() }, broadcast() {}, log: console,
		db: { transaction: (run: (tx: object) => Promise<void>) => run({ execute: async () => [] }) } } as never;
	const actions = user.config.actions!;
	await actions.internalSweepSandboxes(ctx);
	assert.deepEqual(usage.kept().map(k => k.session).sort(), [...ids].sort());
	assert.ok(!fake.sandboxes.has(deleted) && !fake.sandboxes.has(stale));
	assert.ok(fake.sandboxes.has(active) && fake.sandboxes.has(young));

	const reserve = await actions.internalReserve(ctx, { sessionId: "s_active", id: "build-time", keep: true });
	assert.ok(reserve.ok && usage.holdOf("s_active"), "build time is metered");
	assert.ok((await actions.internalClaimPlace(ctx, "s_active")).ok);
	assert.equal(usage.numbers(now).sandboxes.kept, 3);
	const next = "s_next";
	sessions.set(next, { id: next, createdAt: now, environmentBuild: false });
	assert.ok((await actions.internalClaimPlace(ctx, next)).ok);
	assert.equal(usage.numbers(now).sandboxes.kept, 4);
});

test("a failed environment turn destroys its source before reporting the result", async t => {
	const { fake } = await buildProvider(t);
	const { DatabaseSync } = await import("node:sqlite");
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { createGrant } = await import("../server/src/actors/internal.js");
	const sql = new DatabaseSync(":memory:");
	t.after(() => sql.close());
	const db = { execute: async (query: string, ...args: (string | number | null)[]) => sql.prepare(query).all(...args),
		transaction: (run: (tx: object) => Promise<void>) => run(db) };
	let remainingAtReport: number | undefined;
	const owner = {
		internalSessionSecrets: async () => ({ secrets: [] }), internalSessionChanged: async () => {},
		internalAcquireRun: async () => ({ known: true, ok: true }), internalReserve: async () => ({ ok: true, hold: { id: "time", seconds: 600 } }),
		internalClaimPlace: async () => ({ ok: true }), internalSettle: async () => ({ known: true }), internalRelease: async () => {},
		internalEnvironmentResult: async () => { remainingAtReport = fake.sandboxes.size; throw new Error("result delivery interrupted"); },
	};
	const key = ["u_build", "s_build"];
	const base = { key, db, client: () => ({ user: { get: () => owner } }), conn: { params: serviceParams() }, broadcast() {}, log: console,
		keepAwake: <T>(p: Promise<T>) => p };
	const actor = agentSession.config;
	if (!("db" in actor && "createVars" in actor)) throw new Error("Missing session database");
	await actor.db.onMigrate(db as never);
	await actor.onCreate!(base as never, { grant: createGrant("agentSession", key), title: "Build", profile: "e2b", model: "demo", titleIsTyped: true, repoUrl: null,
		place: { kind: "hosted" }, demo: true, createdAt: Date.now(), environmentBuild: { project: "github:1", place: "hosted", screenshots: false } });
	const vars = await actor.createVars(base as never, undefined);
	await actor.actions!.internalBuildEnvironment({ ...base, vars } as never);
	await vars.turn?.done;
	assert.equal(fake.calls.filter(call => call.startsWith("kill ")).length, 1);
	assert.equal(remainingAtReport, 0);
});
