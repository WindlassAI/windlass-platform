/// <reference lib="es2023.array" />
// Real session recorder, sleep/stop hooks and SQLite, with a clock and a stalled turn.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { applyDelta, emptyView, fromSnapshot } from "../web/src/lib/timeline.js";
import type { AcpUpdate, LiveDelta, TimelineItem } from "../server/src/contract.js";

process.env.WLP_SECRET = randomBytes(32).toString("hex");
process.env.WLP_DEMO = "1";
process.env.WLP_SANDBOX = "fake";
const { agentSession, acpRecorder } = await import("../server/src/actors/agent-session.js");
const { issueUserToken } = await import("../server/src/tokens.js");
const next = () => new Promise<void>(r => setImmediate(r));

const textOf = (update: AcpUpdate) => update.sessionUpdate === "agent_message_chunk" && update.content?.text;

function fixture() {
	const sql = new DatabaseSync(":memory:");
	sql.exec("CREATE TABLE timeline (seq INTEGER PRIMARY KEY, turn, kind, at, item); CREATE TABLE meta(id PRIMARY KEY, data); INSERT INTO meta VALUES (1, '{}')");
	const deltas: LiveDelta[] = [], items: TimelineItem[] = [];
	let writes = 0, failNextInsert = false;
	const vars = { nextSeq: 1, unwritten: [], serial: Promise.resolve(), pending: [], turn: { controller: new AbortController(), done: new Promise<void>(() => {}) },
		meta: { uid: "u_fixture", status: "running", profile: "docker-hardened", place: { kind: "hosted" } }, arming: Promise.resolve() };
	const c = { vars, key: ["u_fixture", "s_test"], conn: { params: { token: issueUserToken({ uid: "u_fixture", email: null, demo: true }) } },
		client: () => ({ user: { get: () => ({ internalSessionChanged: async () => {} }) } }), log: console,
		broadcast: (name: string, value: never) => { if (name === "delta") deltas.push(value); if (name === "item") items.push(value); },
		keepAwake: <T>(p: Promise<T>) => p,
		db: { async execute(query: string, ...args: SQLInputValue[]) {
			if (query.includes("INTO timeline")) {
				if (failNextInsert) { failNextInsert = false; throw new Error("fixture interrupted write"); }
				writes++;
			}
			return sql.prepare(query).all(...args);
		} },
	};
	const recorder = acpRecorder(c as never, 1);
	return { c, recorder, vars, deltas, items, sql, writes: () => writes, failInsert() { failNextInsert = true; },
		stored: () => sql.prepare("SELECT item FROM timeline ORDER BY seq").all().map(row => JSON.parse(String(row.item)) as TimelineItem),
		chunk: (text: string) => recorder.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }) };
}

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
