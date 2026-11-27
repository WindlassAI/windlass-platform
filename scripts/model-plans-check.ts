import "./check-secret.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { format } from "node:util";

// Read once at import (config.ts): two users may connect plans, everyone else may not.
process.env.WLP_PLAN_USERS = "plan-check-a,plan-check-c";
process.env.WLP_CLIENT_IP_HEADER = "x-check-address";

const { modelKeyCaller, planConnectCaller } = await import("../server/src/actors/internal.js");
const { credentialActions: credentials, CREDENTIAL_TABLES } = await import("../server/src/credentials/index.js");
const { connectCodeDigest, connectTransitSubject, newConnectRequest } = await import(
	"../server/src/credentials/connect-code.js"
);
const { connectCodes } = await import("../server/src/actors/connect-codes.js");
const { connectResponse } = await import("../server/src/connect-route.js");
const { config } = await import("../server/src/config.js");
const { openCredentialTransit } = await import("../server/src/credentials/transit.js");
const { validPlanToken, validModelKey, CONNECT_PATHS } = await import("../server/src/contract.js");
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

/** What the connect route sends the actor for an approved request it took. */
function handover(uid: string, token: string) {
	const digest = connectCodeDigest.ofRequest(newConnectRequest().request)!;
	return { digest, sealed: serverSealer().seal("transit", connectTransitSubject(uid, "anthropic", digest), token) };
}

test("plan tokens, user codes and request secrets have their own shapes", () => {
	assert.ok(validPlanToken("anthropic", planToken()));
	assert.ok(!validPlanToken("anthropic", "sk-ant-api03-" + hex()));
	assert.ok(!validModelKey("anthropic", planToken()), "a setup token is never saved as an API key");
	const { userCode, request } = newConnectRequest();
	assert.match(userCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
	assert.equal(connectCodeDigest.ofUserCode("KQ2M-8XF4"), connectCodeDigest.ofUserCode(" kq2m 8xf4 "));
	for (const bad of ["KQ2M-8XF", "KQ2M-8XFU", "", 7, null]) assert.equal(connectCodeDigest.ofUserCode(bad), null);
	assert.ok(connectCodeDigest.ofRequest(request));
	assert.notEqual(connectCodeDigest.ofRequest(request), connectCodeDigest.ofUserCode(userCode));
	for (const bad of [userCode, request.slice(1), "", null]) assert.equal(connectCodeDigest.ofRequest(bad), null);
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

	// Off for an account (WLP_PLAN_USERS): no approving, no connect, and a saved plan is never used.
	assert.equal((await credentials.modelPlans(off.context)).allowed, false);
	await assert.rejects(
		credentials.approvePlanConnect({ ...off.context, client: () => assert.fail() } as never, "KQ2M-8XF4"),
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

/**
 * The connect routes and the connect-codes actor with an in-memory stand-in for the actor client: users'
 * actors (credentials) and the requests table, each reached with the params the caller passes.
 */
function connectWorld() {
	const sql = new DatabaseSync(":memory:");
	const db = {
		async execute<Row>(query: string, ...args: unknown[]) {
			return sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
		},
	};
	// The migration runs in a transaction; one at a time here, so a plain pass-through is enough.
	const migrating = { ...db, transaction: <T>(run: (tx: typeof db) => Promise<T>) => run(db) };
	const users = new Map<string, ReturnType<typeof account>>();
	const userOf = (uid: string) => {
		if (!users.has(uid)) users.set(uid, account(uid));
		return users.get(uid)!;
	};
	const bind = <T extends object>(actions: T, context: object) =>
		new Proxy(
			{},
			{
				get:
					(_, name) =>
					(...args: unknown[]) =>
						(actions as Record<string | symbol, (...a: unknown[]) => unknown>)[name]!(context, ...args),
			},
		);
	const codes = connectCodes.config.actions!;
	const client = {
		connectCodes: {
			getOrCreate: (key: string[], { params }: { params: unknown }) => bind(codes, { db, key, conn: { params } }),
		},
		user: {
			get: ([uid]: string[], { params }: { params: unknown }) =>
				bind(credentials, { ...userOf(uid).context, client: () => client, conn: { params } }),
		},
	};
	const engine = () => client as never;
	let address = 0;
	return {
		sql,
		ready: async () => {
			if (!("db" in connectCodes.config)) throw new Error("Missing connect-codes database");
			await connectCodes.config.db.onMigrate(migrating as never);
		},
		/** A user's own call to the web actions. */
		as: (uid: string) => ({ ...userOf(uid).context, client: () => client }) as never,
		plans: (uid: string) => credentials.modelPlans(userOf(uid).context),
		/** A fresh client address per scenario, so the per-address budget is only met where a case means it. */
		address: () => `198.51.100.${++address}`,
		async post(path: string, body: unknown, from = "203.0.113.9") {
			const request = new Request(`http://platform.test${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-check-address": from },
				body: JSON.stringify(body),
			});
			const response = await connectResponse(request, engine);
			return { status: response.status, body: (await response.json()) as Record<string, unknown> };
		},
		close() {
			sql.close();
			for (const user of users.values()) user.sql.close();
		},
	};
}

test("a terminal connects a plan only after its user approves the code, once", async t => {
	const good = planToken(),
		refused = planToken();
	const server = createServer((req, res) => {
		const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (token !== good) return void res.writeHead(401).end("{}");
		res.end(JSON.stringify({ account: { email: "a@b.com" }, organization: { organization_type: "claude_max" } }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	process.env.WLP_ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const world = connectWorld();
	t.after(() => world.close());
	await world.ready();
	const { start, poll, connect } = CONNECT_PATHS;
	const open = async (from = world.address()) => {
		const started = await world.post(start, { provider: "anthropic" }, from);
		assert.equal(started.status, 201);
		return started.body as { userCode: string; request: string; approveUrl: string; interval: number };
	};
	const state = async (request: string) => (await world.post(poll, { request })).body.state;
	const approve = (uid: string, code: string) => credentials.approvePlanConnect(world.as(uid), code);
	const code = (err: unknown) => (err as { code?: string }).code;

	// start answers the code to show, the page to approve it on and the terminal's secret; nothing is signed in.
	assert.equal((await world.post(start, { provider: "openai" })).status, 400);
	const first = await open();
	assert.equal(first.approveUrl, `${config.origins[0]}/connect?code=${first.userCode}`);
	assert.equal(first.interval, 2_000);
	assert.equal(await state(first.request), "pending");
	assert.equal((await world.post(poll, { request: "nope" })).status, 400);
	assert.equal(await state(newConnectRequest().request), "expired", "an unknown request reads as expired");

	// Nothing connects while the request waits for approval, and the wait goes on.
	assert.equal((await world.post(connect, { request: first.request, token: good })).status, 404);
	assert.equal(await state(first.request), "pending");

	// The page: a malformed or wrong code is refused; a user without plans cannot approve.
	await assert.rejects(approve("plan-check-a", "not a code"), err => code(err) === "bad_input");
	await assert.rejects(approve("plan-check-a", "AAAA-AAAA"), err => code(err) === "connect_code_not_found");
	await assert.rejects(approve("plan-check-b", first.userCode), err => code(err) === "plans_off");
	await approve("plan-check-a", first.userCode.toLowerCase().replace("-", " "));
	assert.equal(await state(first.request), "approved");
	// Decided once: neither the same user again nor another user can take it over.
	await assert.rejects(approve("plan-check-c", first.userCode), err => code(err) === "connect_code_not_found");
	await assert.rejects(approve("plan-check-a", first.userCode), err => code(err) === "connect_code_not_found");

	// A typo is refused before the request is taken; the real token connects the approving user's plan, once.
	const typo = await world.post(connect, { request: first.request, token: "sk-ant-oat01-short" });
	assert.deepEqual([typo.status, typo.body.code], [400, "bad_plan_token"]);
	assert.equal(await state(first.request), "approved");
	const done = await world.post(connect, { request: first.request, token: good });
	assert.deepEqual(done, { status: 200, body: { account: "a@b.com · Max" } });
	assert.equal((await world.plans("plan-check-a")).plans[0]?.account, "a@b.com · Max");
	assert.deepEqual((await world.plans("plan-check-c")).plans, []);
	const again = await world.post(connect, { request: first.request, token: good });
	assert.deepEqual([again.status, again.body.code], [404, "connect_code_not_found"]);
	assert.equal(await state(first.request), "expired");
	assert.ok(!format("%o", world.sql.prepare("SELECT * FROM requests").all()).includes(good));

	// Denied: the terminal hears so and can never connect with it.
	const denied = await open();
	await credentials.denyPlanConnect(world.as("plan-check-a"), denied.userCode);
	assert.equal(await state(denied.request), "denied");
	assert.equal((await world.post(connect, { request: denied.request, token: good })).status, 404);

	// Refused by Anthropic: the request is spent, and the terminal starts again.
	const spent = await open();
	await approve("plan-check-a", spent.userCode);
	const no = await world.post(connect, { request: spent.request, token: refused });
	assert.deepEqual([no.status, no.body.code], [400, "plan_refused"]);
	assert.equal(await state(spent.request), "expired");

	// Out of time: neither approved nor connected.
	const late = await open();
	world.sql.prepare("UPDATE requests SET expires = 1").run();
	assert.equal(await state(late.request), "expired");
	await assert.rejects(approve("plan-check-a", late.userCode), err => code(err) === "connect_code_not_found");

	// A user who keeps getting codes wrong is stopped, even with a right one afterwards.
	const guessed = await open();
	// One miss above (taking over a decided code), nine here: ten a TTL.
	for (let i = 0; i < 9; i++) await assert.rejects(approve("plan-check-c", "ZZZZ-ZZZZ"));
	await assert.rejects(approve("plan-check-c", guessed.userCode), err => code(err) === "rate_limited");
	assert.equal(await state(guessed.request), "pending");
	await approve("plan-check-a", guessed.userCode);

	// One address gets WLP_CONNECT_PER_MINUTE starts and handovers a minute; polls have their own budget.
	const busy = world.address();
	for (let i = 0; i < config.httpLimits.connect; i++) await open(busy);
	const limited = await world.post(start, { provider: "anthropic" }, busy);
	assert.equal(limited.status, 429);
	assert.equal((await world.post(poll, { request: guessed.request }, busy)).status, 200);
});
