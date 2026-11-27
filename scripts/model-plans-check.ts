import "./check-secret.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { format } from "node:util";

// Read once at import (config.ts): one user may connect plans, everyone else may not.
process.env.WLP_PLAN_USERS = "plan-check-a";

const { modelKeyCaller, planConnectCaller } = await import("../server/src/actors/internal.js");
const { credentialActions: credentials, CREDENTIAL_TABLES } = await import("../server/src/credentials/index.js");
const { connectCodeDigest, connectTransitSubject } = await import("../server/src/credentials/connect-code.js");
const { openCredentialTransit } = await import("../server/src/credentials/transit.js");
const { validPlanToken, validModelKey } = await import("../server/src/contract.js");
const { serverSealer } = await import("../server/src/signin/seal.js");
const { issueServiceToken, issueUserToken } = await import("../server/src/tokens.js");

const hex = () => randomBytes(24).toString("hex");
const planToken = () => "sk-ant-oat01-" + hex();

function account(uid: string) {
	const sql = new DatabaseSync(":memory:");
	for (const table of CREDENTIAL_TABLES) sql.exec(table);
	const db = {
		async execute<Row>(query: string, ...args: unknown[]) {
			return sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
		},
	};
	const context = {
		db,
		key: [uid],
		vars: { tokenGen: 0 },
		conn: { params: { token: issueUserToken({ uid, email: null, demo: false }, 0) } },
	};
	const as = (subject: string) => ({ ...context, conn: { params: { token: issueServiceToken(subject) } } });
	return { sql, context, relay: as(modelKeyCaller(uid)), route: as(planConnectCaller(uid)) };
}

/** What the connect route sends the actor for a redeemed code. */
function handover(uid: string, token: string) {
	const digest = connectCodeDigest.of("wl_" + "A".repeat(16))!;
	return { digest, sealed: serverSealer().seal("transit", connectTransitSubject(uid, "anthropic", digest), token) };
}

test("plan tokens and connect codes have their own shapes", () => {
	assert.ok(validPlanToken("anthropic", planToken()));
	assert.ok(!validPlanToken("anthropic", "sk-ant-api03-" + hex()));
	assert.ok(!validModelKey("anthropic", planToken()), "a setup token is never saved as an API key");
	const code = "wl_7KQ2M8XF4R0ABCDE";
	assert.equal(connectCodeDigest.of(code), connectCodeDigest.of(" wl_7kq2-m8xf-4r0a-bcde "));
	for (const bad of ["wl_7KQ2M8XF4R0ABCD", "wl_7KQ2M8XF4R0ABCDU", "", 7, null])
		assert.equal(connectCodeDigest.of(bad), null);
	assert.throws(() => connectCodeDigest.parse("x".repeat(64)));
});

test("a connected Claude plan is checked, sealed and opened only for the relay", async t => {
	const tokens = { good: planToken(), refused: planToken() };
	const seen: string[] = [];
	const server = createServer((req, res) => {
		assert.equal(req.method, "GET");
		assert.equal(req.url, "/api/oauth/profile");
		assert.equal(req.headers["anthropic-beta"], "oauth-2025-04-20");
		const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		seen.push(token);
		if (token !== tokens.good) return void res.writeHead(401).end(JSON.stringify({ error: token }));
		res.end(
			JSON.stringify({ account: { email: "a@b.com", echo: token }, organization: { organization_type: "claude_max" } }),
		);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	process.env.WLP_ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const a = account("plan-check-a"),
		off = account("plan-check-off");
	t.after(() => {
		a.sql.close();
		off.sql.close();
	});
	const clean = (value: unknown) =>
		assert.ok(!Object.values(tokens).some(tok => format("%o", value).includes(tok)), "token in answer or storage");

	// Only the connect route's caller may hand a token over, and only sealed for this user and code.
	const good = handover("plan-check-a", tokens.good);
	await assert.rejects(credentials.internalConnectPlan(a.context, "anthropic", good.digest, good.sealed), /internal/);
	await assert.rejects(credentials.internalConnectPlan(a.relay, "anthropic", good.digest, good.sealed), /internal/);
	const other = handover("plan-check-b", tokens.good);
	await assert.rejects(credentials.internalConnectPlan(a.route, "anthropic", other.digest, other.sealed));

	const refused = handover("plan-check-a", tokens.refused);
	await assert.rejects(credentials.internalConnectPlan(a.route, "anthropic", refused.digest, refused.sealed), err => {
		clean(err);
		return (err as { code?: string }).code === "plan_refused";
	});
	assert.deepEqual((await credentials.modelPlans(a.context)).plans, []);

	const plan = await credentials.internalConnectPlan(a.route, "anthropic", good.digest, good.sealed);
	assert.deepEqual({ account: plan.account, ok: plan.ok }, { account: "a@b.com · Max", ok: true });
	clean(plan);
	clean(a.sql.prepare("SELECT * FROM model_plan").all());
	assert.deepEqual(await credentials.modelPlans(a.context), { allowed: true, plans: [plan] });

	// The relay pins the generation without the token, then opens the token per request.
	const ref = { provider: "anthropic" as const, plan: true as const };
	await assert.rejects(credentials.internalCredentialGeneration(a.context, ref), /internal/);
	const generation = await credentials.internalCredentialGeneration(a.relay, ref);
	assert.ok(generation);
	assert.equal(await credentials.internalCredentialGeneration(a.relay, { provider: "anthropic" }), null, "no API key");
	const nonce = hex();
	const sealed = (await credentials.internalCredential(a.relay, ref, nonce))!;
	clean(sealed);
	assert.deepEqual(openCredentialTransit("plan-check-a", ref, nonce, sealed), { secret: tokens.good, generation });
	assert.throws(
		() => openCredentialTransit("plan-check-a", { provider: "anthropic" }, nonce, sealed),
		"a key's subject",
	);
	assert.throws(() => openCredentialTransit("plan-check-a", ref, hex(), sealed), "another request");
	await assert.rejects(
		credentials.internalCredential(a.relay, { provider: "openai", plan: true }, nonce),
		/Unknown plan/,
	);

	// Connecting again replaces the generation, so every lease of the old one ends.
	const again = handover("plan-check-a", tokens.good);
	await credentials.internalConnectPlan(a.route, "anthropic", again.digest, again.sealed);
	assert.notEqual(await credentials.internalCredentialGeneration(a.relay, ref), generation);
	await credentials.removeModelPlan(a.context, "anthropic");
	assert.equal(await credentials.internalCredential(a.relay, ref, nonce), null);

	// Off for an account (WLP_PLAN_USERS): no codes, no connect, and a saved plan is never used.
	assert.equal((await credentials.modelPlans(off.context)).allowed, false);
	await assert.rejects(
		credentials.startPlanConnect({ ...off.context, client: () => assert.fail() } as never, "anthropic"),
		/not available/,
	);
	const blocked = handover("plan-check-off", tokens.good);
	await assert.rejects(
		credentials.internalConnectPlan(off.route, "anthropic", blocked.digest, blocked.sealed),
		/not available/,
	);
	off.sql
		.prepare("INSERT INTO model_plan VALUES ('anthropic', ?, 'g', 'x', 0, 0, 1)")
		.run(serverSealer().seal("model-plan", JSON.stringify(["plan-check-off", "anthropic"]), tokens.good));
	assert.equal(await credentials.internalCredentialGeneration(off.relay, ref), null);
	assert.equal(await credentials.internalCredential(off.relay, ref, nonce), null);
	assert.equal(seen.filter(tok => tok === tokens.good).length, 2, "one check per connect, none per use");
});

test("hosted turns pay with the plan first, and only Claude Code takes a Claude plan", async () => {
	const { hostedPayer, hostedCatalog, hostedAgentProblem } = await import("../server/src/sandbox/harnesses.js");
	const key = { provider: "anthropic" as const, checkedAt: 1, models: ["claude-haiku-5-5"] };
	const plan = { provider: "anthropic" as const, plan: true as const, checkedAt: 2 };
	assert.deepEqual(hostedPayer("claude", "opus", [key, plan]), { provider: "anthropic", plan: true });
	assert.deepEqual(hostedPayer("claude", "opus", [plan]), { provider: "anthropic", plan: true });
	assert.deepEqual(hostedPayer("claude", "haiku", [key]), { provider: "anthropic" });
	assert.equal(hostedPayer("claude", "opus", []), null);
	// A Claude plan never pays for another agent, even one that runs on Anthropic keys.
	assert.equal(hostedPayer("opencode", "anthropic/claude-haiku-5-5", [plan]), null);
	assert.deepEqual(hostedPayer("opencode", "anthropic/claude-haiku-5-5", [key, plan]), { provider: "anthropic" });
	assert.equal(hostedPayer("codex", "default", [plan]), null);
	// A plan lists no models: Claude Code offers its fixed families on it.
	assert.deepEqual(
		hostedCatalog("claude", [plan])?.models.map(m => m.id),
		["default", "sonnet", "opus", "haiku", "fable"],
	);
	assert.equal(hostedCatalog("opencode", [plan]), undefined);
	assert.equal(hostedAgentProblem("claude", [plan], true), null);
	assert.match(hostedAgentProblem("opencode", [plan], true) ?? "", /key in Settings/);
});
