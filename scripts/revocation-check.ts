import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { user } from "../server/src/actors/user.js";
import { issueUserToken } from "../server/src/tokens.js";

test("a failed session disconnect is retried after the user's old token is invalid", async () => {
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
	const scheduled: string[] = [];
	const cut: number[] = [];
	const profile = { uid: "u_test", email: null, demo: false };
	const ctx = {
		key: [profile.uid], conn: { params: { token: issueUserToken(profile, 0) } }, conns: new Map(),
		vars: { tokenGen: 0, sessions: new Map([["s_test", {}]]) }, db, log: { warn() {} },
		schedule: { after: async (_delay: number, action: string) => { scheduled.push(action); return "fixture"; } },
		client: () => ({ agentSession: { get: () => ({ internalDisconnectRevoked: async (gen: number) => {
			cut.push(gen);
			if (cut.length === 1) throw new Error("temporarily unreachable");
		} }) } }),
	};
	try {
		sql.exec("CREATE TABLE token_generation(id INTEGER PRIMARY KEY, gen INTEGER NOT NULL, disconnected INTEGER NOT NULL DEFAULT 0); INSERT INTO token_generation(id,gen) VALUES (1,0)");
		await actions.signOutEverywhere(ctx as never);
		await assert.rejects(actions.signOutEverywhere(ctx as never), { code: "invalid_token" });
		assert.equal(scheduled.shift(), "retryDisconnectRevoked");
		await actions.retryDisconnectRevoked({ ...ctx, conn: null, scheduledFire: { id: "fixture" } } as never);
		assert.deepEqual(cut, [1, 1]);
		assert.equal(sql.prepare("SELECT disconnected FROM token_generation").get()?.disconnected, 1);
	} finally {
		sql.close();
	}
});

test("the generation belongs to the canonical single-uid user actor", () => {
	const profile = { uid: "u_test", email: null, demo: false };
	const params = { token: issueUserToken(profile, 0) };
	const context = { vars: { tokenGen: 0, reached: true }, key: [profile.uid] };
	const admit = (key: string[]) => user.config.onBeforeConnect!({ ...context, key } as never, params);
	assert.doesNotThrow(() => admit([profile.uid]));
	assert.throws(() => admit([profile.uid, "extra"]), { code: "forbidden" });
});
