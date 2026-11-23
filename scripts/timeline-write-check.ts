/// <reference lib="es2023.array" />
// Real session recorder, sleep/stop hooks and SQLite, with a clock and a stalled turn.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { applyDelta, emptyView, fromSnapshot } from "../web/src/lib/timeline.js";
import type { AcpUpdate } from "../server/src/contract.js";

process.env.WLP_SECRET = randomBytes(32).toString("hex");
process.env.WLP_DEMO = "1";
process.env.WLP_SANDBOX = "fake";
const { agentSession } = await import("../server/src/actors/agent-session.js");
const { timelineFixture: fixture } = await import("../fixtures/acp-agent/timeline.js");
const next = () => new Promise<void>(r => setImmediate(r));

const textOf = (update: AcpUpdate) => update.sessionUpdate === "agent_message_chunk" && update.content?.text;

for (const action of ["sleep", "stop"] as const) test(action + " saves an unfinished ACP message even if the harness never acknowledges cancel", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		const words = ["one", " two", " three"];
		for (const word of words) f.chunk(word);
		assert.deepEqual(f.deltas.map(d => "acp" in d && textOf(d.acp)), words);
		const stopped = action === "sleep" ? agentSession.config.onSleep!(f.c as never) : agentSession.config.actions!.stop(f.c as never);
		await next();
		t.mock.timers.tick(10_000);
		await stopped;
		const stored = f.stored();
		assert.equal(stored.length, 1, "one durable row for the open message");
		const item = stored[0]!;
		assert.ok(item.kind === "acp" && textOf(item.update) === words.join(""));
		const live = f.deltas.reduce(applyDelta, emptyView());
		const reload = fromSnapshot({ timeline: stored, pending: [], windlassSessionId: null });
		const messages = (view: typeof live) => view.turns.flatMap(turn => turn.blocks.flatMap(b => b.kind === "text" ? [[b.messageId, b.text]] : []));
		assert.deepEqual(messages(reload), messages(live));
		assert.equal(f.items.length, 0, "storage checkpoint emitted an extra live item");
		if (action === "stop") {
			f.chunk(" four");
			f.recorder.flush();
			f.failInsert();
			const snap = await agentSession.config.actions!.snapshot(f.c as never);
			assert.deepEqual(snap.timeline, f.items, "snapshot must prefer the completed message in memory after a failed write");
			t.mock.timers.tick(401);
			await f.vars.serial;
			assert.equal(f.stored().length, 1);
			const final = f.stored()[0]!;
			assert.ok(final.kind === "acp" && final.messageKey === item.messageKey && textOf(final.update) === "one two three four");
		}
	} finally { f.sql.close(); }
});

test("a one-second burst broadcasts immediately and uses at most three SQLite inserts", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		for (let i = 0; i < 20; i++) {
			f.recorder.update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "in_progress" });
			assert.equal(f.items.length, i + 1);
			t.mock.timers.tick(50);
			await f.vars.serial;
		}
		t.mock.timers.tick(400);
		await f.vars.serial;
		assert.equal(f.stored().length, 20);
		assert.ok(f.writes() <= 3, `burst used ${f.writes()} SQLite inserts`);
	} finally { f.sql.close(); }
});

test("a running turn updates a single durable refusal row and flushes once more on exit", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { observeNetwork } = await import("../server/src/actors/agent-session.js");
	const f = fixture();
	const replacements: import("../server/src/contract.js").NetworkBlockedItem[] = [];
	const c = {
		...f.c,
		db: { ...f.c.db, transaction: (run: (db: typeof f.c.db) => Promise<void>) => run(f.c.db) },
		broadcast(name: string, value: never) {
			if (name === "networkBlocked") replacements.push(value);
			f.c.broadcast(name, value);
		},
	};
	Object.assign(f.vars.meta, { place: { kind: "machine", machineId: "m_test" }, machineName: "Build box" });
	const reasons = ["machine_policy", "private", "provider", "malformed"] as const;
	let reads = 0;
	const read = async () => {
		reads++;
		return { broker: reads <= 2 ? "first" : "replacement", hosts: reasons.map((reason, i) => ({ reason, host: "test" + i + ".example", port: 443, firstAt: 12, lastAt: 12 + reads, count: reads <= 2 ? reads : 1 })), overflow: reads <= 2 ? reads : 1 };
	};
	try {
		const finish = await observeNetwork(c as never, f.vars.meta as never, 1, { blockedNetwork: read } as never, {} as never);
		assert.ok(finish);
		assert.equal(reads, 1);
		const first = f.items[0];
		assert.ok(first?.kind === "network.blocked");
		assert.deepEqual(first.hosts.map(h => [h.reason, h.allow]), [["machine_policy", "machine"], ["private", "never"], ["provider", "never"], ["malformed", "never"]]);
		assert.deepEqual(first.hosts[0]?.machineNames, ["Build box"]);
		for (const h of first.hosts) await assert.rejects(agentSession.config.actions!.allowHost(c as never, { host: h.host! }), /runner.*egress/);
		t.mock.timers.tick(4999);
		assert.equal(reads, 1);
		t.mock.timers.tick(1);
		await next();
		assert.equal(replacements.length, 1);
		await finish();
		t.mock.timers.tick(10000);
		assert.equal(reads, 3);
		assert.equal(f.items.length, 1);
		assert.deepEqual([first, ...replacements].map(i => i.revision), [1, 2, 3]);
		assert.deepEqual(replacements.map(item => [item.seq, item.hosts[0]?.count, item.overflow]), [[first.seq, 2, 2], [first.seq, 3, 3]]);
		assert.deepEqual(f.stored(), [replacements[1]]);
		const legacy = fromSnapshot({ timeline: [...f.stored(), { seq: first.seq + 1, at: 16, turn: 1, kind: "platform", level: "info", text: "still running" }], pending: [], windlassSessionId: null });
		assert.equal(legacy.gap, false);
		assert.equal(legacy.lastSeq, first.seq + 1);
	} finally { f.sql.close(); }
});

test("a restricted hosted DNS observation can be allowed before its turn ends", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { observeNetwork } = await import("../server/src/actors/agent-session.js");
	const { getLayer } = await import("../server/src/layer.js");
	const layer = await getLayer();
	const f = fixture();
	const applied: string[] = [], requested: string[] = [];
	const host = "registry.example";
	const user = {
		internalTokenGeneration: async () => 0,
		internalNetworkRequests: async ({ hosts }: { hosts: string[] }) => { requested.push(...hosts); return { full: [] }; },
		internalAllowHost: async () => ({ allowed: true, hosts: [host], network: {} }),
	};
	const c = {
		...f.c, client: () => ({ user: { get: () => user } }),
		db: { ...f.c.db, transaction: (run: (db: typeof f.c.db) => Promise<void>) => run(f.c.db) },
	};
	Object.assign(f.vars.meta, { repo: { id: 1, owner: "acme", name: "repo" }, sandboxId: "box", sessionId: "s_test", turns: 1 });
	Object.assign(f.vars, { hostsAllowed: new Map() });
	const prior = { egress: layer.sandboxes.egress, setNetwork: layer.sandboxes.setNetwork };
	Object.assign(layer.sandboxes, {
		egress: () => "restricted",
		setNetwork: async (_id: string, hosts: string[]) => { applied.push(...hosts); return true; },
	});
	try {
		let found: string[] = [];
		const finish = await observeNetwork(c as never, f.vars.meta as never, 1, { blockedHosts: async () => found } as never, layer);
		assert.ok(finish);
		found = [host];
		t.mock.timers.tick(5000);
		await next();
		const row = f.stored().find(item => item.kind === "network.blocked");
		assert.ok(row?.kind === "network.blocked");
		assert.deepEqual(row.hosts.map(h => [h.host, h.port, h.count, h.allow]), [[host, null, 1, "repository"]]);
		const allowed = await agentSession.config.actions!.allowHost(c as never, { host });
		assert.equal(allowed.applied, true);
		assert.deepEqual(applied, [host]);
		await finish();
		assert.deepEqual(requested, [host], "a repeated scan must not file another request");
		assert.equal(f.stored().filter(item => item.kind === "network.blocked").length, 1);
	} finally {
		Object.assign(layer.sandboxes, prior);
		f.sql.close();
	}
});
