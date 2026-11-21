import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";

process.env.WLP_SANDBOX = "fake";
process.env.WLP_SIGNIN_RUNNER = "";
process.env.WLP_DEMO = "1";
process.env.WLP_FAKE_SIGNIN_GRANTS = JSON.stringify({ handover: { email: null } });
const { login } = await import("../server/src/actors/login.js");
const { getLayer } = await import("../server/src/layer.js");
const { verifyToken } = await import("../server/src/tokens.js");

assert.ok("createVars" in login.config);
const { createVars } = login.config;

for (const action of ["finish", "demo"] as const) {
	test(action + " can retry a failed generation lookup before handing over the sign-in", async t => {
		const sql = new DatabaseSync(":memory:");
		t.after(() => sql.close());
		sql.exec("CREATE TABLE attempt (id INTEGER PRIMARY KEY, state TEXT, expires_at INTEGER, sealed TEXT, schedule_id TEXT)");
		const db = { execute: async (query: string, ...args: SQLInputValue[]) => sql.prepare(query).all(...args) };
		let unavailable = true;
		const user = { internalTokenGeneration: async () => {
			if (unavailable) throw new Error("generation lookup unavailable");
			return 7;
		} };
		const actor = {
			key: ["attempt_handover"], db, log: { error() {} },
			client: () => ({ user: { getOrCreate: () => user } }),
			schedule: { after: async () => "job", cancel: async () => true },
		};
		await login.config.onCreate!(actor as never, undefined);
		const ctx = { ...actor, vars: await createVars(actor as never, undefined) };
		const { logins } = await getLayer();
		const handover = t.mock.method(logins, action === "demo" ? "ensureUserVolume" : "adopt", async () => {});
		const callback = action === "finish" ? (await login.config.actions!.start(ctx as never)).redirectPrefix + "?code=handover" : "";
		const finish = () => action === "finish" ? login.config.actions!.finish(ctx as never, callback) : login.config.actions!.demo(ctx as never);
		await assert.rejects(finish(), { code: "internal_error" });
		assert.equal(handover.mock.callCount(), 0);
		// Restart the attempt actor from its saved row and retry the same callback.
		ctx.vars = await createVars(actor as never, undefined);
		unavailable = false;
		const caller = verifyToken((await finish()).token);
		assert.equal(caller?.kind === "user" && caller.generation, 7);
		assert.equal(handover.mock.callCount(), 1);
	});
}
