/// <reference lib="es2024.promise" />
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
