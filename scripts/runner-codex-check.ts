import assert from "node:assert/strict";
import test from "node:test";
import { parseRunnerFrame } from "../server/src/runner/control.js";
import { codexModes, reportedCodexModes } from "../server/src/sandbox/codex-modes.js";
import { initialSessionModes } from "../server/src/sandbox/profiles.js";
import { launchModes } from "../web/src/lib/modes.js";
Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { codex: "fixture" } });
const { devicePrompt } = await import("../runner/src/codex-login.js");

test("device login emits only the official URL and challenge, refusing foreign hosts and redirects", () => {
	const parse = devicePrompt();
	assert.equal(parse("ABCD-EFGH"), undefined);
	assert.equal(parse("https://auth.openai.com/codex/device"), undefined);
	assert.equal(parse("ABCD-EFGH"), "https://auth.openai.com/codex/device\nABCD-EFGH");
	assert.equal(parse("ABCD-EFGH"), undefined);
	for (const url of [
		"https://other.example/codex/device",
		"https://auth.openai.com/codex/device?redirect_uri=https://other.example",
		"https://auth.openai.com.example/codex/device",
	])
		assert.throws(() => devicePrompt()(url), /unexpected verification URL/);
	assert.throws(() => devicePrompt()("device code login is not enabled"), /workspace admin/);
});
test("Codex catalogs have independent model and byte limits on both frame shapes", () => {
	const options = {
		models: [{ id: "fixture", name: "Example", efforts: ["low"] }],
		defaultModel: "fixture",
		modes: codexModes("docker-hardened"),
		checkedAt: 1,
	};
	const entry = {
		id: "codex",
		adapter: "codex-acp 2.9.0",
		image: "fixture",
		signIn: "token",
		method: "api-key",
		modes: ["agent-full-access"],
	};
	const report = {
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 1,
		sandboxes: [],
	};
	for (const frame of [
		(opts: unknown) => ({ ...report, harnesses: [{ ...entry, options: opts }] }),
		(opts: unknown) => ({ kind: "catalog", id: "codex", options: opts }),
	]) {
		assert.ok(parseRunnerFrame(JSON.stringify(frame(options))));
		for (const [n, size] of [
			[40, 8],
			[32, 512],
		] as const) {
			const models = Array.from({ length: n }, (_, i) => ({
				id: i ? String(i) : "fixture",
				name: "a".repeat(size),
				efforts: ["low"],
			}));
			assert.equal(parseRunnerFrame(JSON.stringify(frame({ ...options, models }))), null);
		}
	}
});
test("the Windlass sandbox profile offers Codex only its inner sandbox modes, starting in workspace-write", () => {
	const probed = reportedCodexModes(true);
	assert.deepEqual(probed, ["agent-full-access", "read-only", "workspace-write", "agent"]);
	assert.deepEqual(reportedCodexModes(false), ["agent-full-access"]);
	const inner = codexModes("docker-windlass-sandbox", probed);
	assert.deepEqual(inner.map((m) => m.id), ["read-only", "workspace-write", "agent"]);
	assert.deepEqual(codexModes("docker-hardened", probed).map((m) => m.id), ["agent-full-access"]);
	assert.deepEqual(initialSessionModes("docker-windlass-sandbox", "codex", false, inner), { mode: "workspace-write", availableModes: inner });
	assert.equal(initialSessionModes("docker-hardened", "codex", false, codexModes("docker-hardened", probed)).mode, "agent-full-access");
	assert.equal(launchModes("codex", { id: "docker-windlass-sandbox", approval: "auto" })?.default, "workspace-write");
	assert.equal(launchModes("codex", { id: "docker-hardened", approval: "full" })?.default, "agent-full-access");
});
test("Codex reports its sign-in generation, so a usage limit ends with that sign-in", async (t) => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables } = await import("../server/src/actors/user-machines.js");
	const { recordProviderUsage, providerAccounts, loginGeneration } = await import("../server/src/actors/provider-accounts.js");
	const { compactReport } = await import("../server/src/runner/catalog.js");
	const { Executor } = await import("../runner/src/docker-executor.js");
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	type Db = Parameters<typeof machineTables>[0];
	const db = { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args), transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db) } as Db;
	await machineTables(db);
	const machineId = "m_0000000000000001";
	const runner = new Executor({ uid: "u_fixture", machineId }, {}, false, false, ["docker-hardened"], { mode: "open", allow: [] }, false, true);
	const state = runner as unknown as { dockerHealth: { ok: boolean }; codexCredential?: { harness: "codex"; provider: "openai"; generation: string } };
	state.dockerHealth = { ok: true };
	const publish = () => {
		const frame = parseRunnerFrame(JSON.stringify(compactReport(runner.report())));
		assert.ok(frame && frame.kind === "report");
		raw.prepare("INSERT OR REPLACE INTO machines(id,name,os,arch,facts) VALUES(?,'Box','linux','arm64',?)").run(machineId, JSON.stringify({ status: "online", report: frame }));
		return frame.harnesses?.find((h) => h.id === "codex");
	};
	const location = { place: machineId, harness: "codex" as const };
	const first = "a".repeat(32), second = "b".repeat(32);
	state.codexCredential = { harness: "codex", provider: "openai", generation: first };
	assert.equal(publish()?.loginGeneration, first);
	assert.equal(await loginGeneration(db, location), first);
	const at = Date.now();
	assert.ok(await recordProviderUsage(db as never, location, first, { kind: "refusal", at, resetsAt: at + 3_600_000 }));
	assert.equal((await providerAccounts(db, at)).get(machineId)?.[0]?.state, "limited");
	state.codexCredential = undefined;
	assert.equal(publish()?.signIn, "none");
	assert.equal((await providerAccounts(db, at)).size, 0, "the limit outlived logout");
	state.codexCredential = { harness: "codex", provider: "openai", generation: second };
	assert.equal(publish()?.loginGeneration, second);
	assert.equal((await providerAccounts(db, at)).size, 0, "another account inherited the limit");
	assert.equal(await recordProviderUsage(db as never, location, first, { kind: "refusal", at: at + 1, resetsAt: null }), false);
});
