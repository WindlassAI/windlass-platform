import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { clientError } from "../server/src/auth.js";
import { user } from "../server/src/actors/user.js";
import { issueUserToken } from "../server/src/tokens.js";

assert.ok("db" in user.config && "createVars" in user.config);
const { db: schema, createVars } = user.config;

function fixture(fails: (id: string, attempt: number) => boolean) {
	const sql = new DatabaseSync(":memory:");
	const execute = async (query: string, ...args: SQLInputValue[]) => sql.prepare(query).all(...args);
	const db = { execute, transaction: async <T>(step: (tx: { execute: typeof execute }) => Promise<T>) => {
		sql.exec("BEGIN");
		try {
			const result = await step({ execute });
			sql.exec("COMMIT");
			return result;
		} catch (error) {
			sql.exec("ROLLBACK");
			throw error;
		}
	} };
	const actions = user.config.actions!;
	type Job = { id: string; delay: number; action: string; args: [number?] };
	const jobs: Job[] = [];
	const calls: string[] = [];
	const warnings: unknown[] = [];
	let serial = 0;
	const ids = ["healthy", "unreachable"];
	const profile = { uid: "u_test", email: null, demo: false };
	const ctx = {
		key: [profile.uid], conn: { params: { token: issueUserToken(profile, 0) } }, conns: new Map(),
		vars: { tokenGen: 0, sessions: new Map(ids.map(id => [id, {}])) }, db,
		log: { warn: (entry: unknown) => warnings.push(entry) },
		schedule: { after: async (delay: number, action: string, ...args: [number?]) => {
			const id = String(++serial);
			jobs.push({ id, delay, action, args });
			return id;
		} },
		client: () => ({ agentSession: { get: ([, id]: string[]) => ({ internalDisconnectRevoked: async (gen: number) => {
			calls.push(id);
			assert.equal(gen, 1);
			if (fails(id, calls.filter(called => called === id).length)) throw new Error("temporarily unreachable");
		} }) } }),
	};
	const start = async () => {
		await schema.onMigrate(db as never);
		for (const id of ids) sql.prepare("INSERT INTO sessions(id, created_at, summary) VALUES (?, 0, ?)").run(id, JSON.stringify({ id }));
		await actions.signOutEverywhere(ctx as never);
		await assert.rejects(actions.signOutEverywhere(ctx as never), { code: "invalid_token" });
	};
	const fire = async (job: Job) => {
		assert.equal(job.action, "retryDisconnectRevoked");
		const vars = await createVars(ctx as never, undefined);
		await actions.retryDisconnectRevoked({ ...ctx, vars, conn: null, scheduledFire: { id: job.id } } as never, ...job.args);
	};
	return { sql, db, start, fire, calls, jobs, warnings };
}

test("only failed session disconnects are retried, even after the user actor reloads", async t => {
	const f = fixture((id, attempt) => id === "unreachable" && attempt === 1);
	t.after(() => f.sql.close());
	await f.start();
	assert.deepEqual(f.calls.sort(), ["healthy", "unreachable"]);
	const job = f.jobs.shift()!;
	await f.fire({ ...job, id: "superseded" });
	assert.equal(f.calls.length, 2);
	f.sql.prepare("INSERT INTO sessions(id, created_at, summary) VALUES (?, 0, ?)").run("new", JSON.stringify({ id: "new" }));
	await f.fire(job);
	assert.deepEqual(f.calls, ["healthy", "unreachable", "unreachable"]);
	assert.equal(f.sql.prepare("SELECT disconnected FROM token_generation").get()?.disconnected, 1);
});

test("disconnect retries back off and stop for a persistently unreachable session", async t => {
	const f = fixture(id => id === "unreachable");
	t.after(() => f.sql.close());
	await f.start();
	const delays: number[] = [];
	while (f.jobs.length && delays.length < 12) {
		const job = f.jobs.shift()!;
		delays.push(job.delay);
		await f.fire(job);
	}
	assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 480_000, 900_000]);
	assert.equal(f.jobs.length, 0);
	assert.equal(f.calls.filter(id => id === "healthy").length, 1);
	assert.equal(f.calls.filter(id => id === "unreachable").length, 7);
	assert.equal(f.sql.prepare("SELECT disconnected FROM token_generation").get()?.disconnected, 0);
	assert.match(JSON.stringify(f.warnings.at(-1)), /exhausted/i);
});

test("an outstanding pre-upgrade timer picks up existing sessions once", async t => {
	const f = fixture(() => false);
	t.after(() => f.sql.close());
	f.sql.exec(`
		CREATE TABLE token_generation(id INTEGER PRIMARY KEY, gen INTEGER NOT NULL, disconnected INTEGER NOT NULL);
		INSERT INTO token_generation VALUES (1, 1, 0);
		CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at INTEGER, summary TEXT, key TEXT, sent TEXT, launch_until INTEGER);
		INSERT INTO sessions(id, created_at, summary) VALUES ('old', 0, '{"id":"old"}')
	`);
	await schema.onMigrate(f.db as never);
	const legacy = { id: "legacy", action: "retryDisconnectRevoked", delay: 30_000, args: [] as [] };
	await f.fire(legacy);
	await f.fire(legacy);
	assert.deepEqual(f.calls, ["old"]);
	assert.equal(f.sql.prepare("SELECT disconnected FROM token_generation").get()?.disconnected, 1);
});

test("the generation belongs to the canonical single-uid user actor", () => {
	const profile = { uid: "u_test", email: null, demo: false };
	const params = { token: issueUserToken(profile, 0) };
	const context = { vars: { tokenGen: 0, reached: true }, key: [profile.uid] };
	const admit = (key: string[]) => user.config.onBeforeConnect!({ ...context, key } as never, params);
	assert.doesNotThrow(() => admit([profile.uid]));
	assert.throws(() => admit([profile.uid, "extra"]), { code: "forbidden" });
});

test("a deleted session is forgotten after one launch check, including after the actor reloads", async t => {
	const f = fixture(() => false);
	t.after(() => f.sql.close());
	await schema.onMigrate(f.db as never);
	const id = "deleted", until = Date.now(), summary = { id, status: "starting", turns: 0 };
	f.sql.prepare("INSERT INTO sessions(id, created_at, summary, launch_until) VALUES (?, 0, ?, ?)").run(id, JSON.stringify(summary), until);
	let calls = 0;
	const ctx = {
		key: ["u_test"], db: f.db, broadcast() {}, scheduledFire: { id: "launch" },
		client: () => ({ agentSession: { get: () => ({ internalSummary: async () => {
			calls++;
			throw { group: "actor", code: "not_found" };
		} }) } }),
	};
	for (let i = 0; i < 2; i++) {
		const vars = await createVars(ctx as never, undefined);
		await user.config.actions!.internalCheckLaunch({ ...ctx, vars } as never, id, until);
		assert.equal(vars.sessions.has(id), false);
	}
	assert.equal(calls, 1);
});

test("a stray actor lookup answers not_found at debug level", () => {
	const errors: unknown[] = [], debug: unknown[] = [];
	const log = { debug: (entry: unknown) => debug.push(entry), error: (entry: unknown) => errors.push(entry) };
	assert.equal(clientError(log, { group: "actor", code: "not_found" }, "Lookup failed").code, "not_found");
	assert.equal(debug.length, 1);
	assert.equal(errors.length, 0);
	assert.equal(clientError(log, new Error("storage failed"), "Lookup failed").code, "internal_error");
	assert.equal(errors.length, 1);
});
