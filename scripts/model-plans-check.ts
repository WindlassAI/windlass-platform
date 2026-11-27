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
type ChatgptPlan = import("../server/src/credentials/index.js").ChatgptPlan;
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
	assert.equal(
		await credentials.internalCredential(a.relay, { provider: "openai", plan: true }, nonce),
		null,
		"no ChatGPT plan without the user's sign-in holder",
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
		credentials.approvePlanConnect({ ...off.context, client: () => assert.fail() } as never, "KQ2M-8XF4", "anthropic"),
		/not available/,
	);
	const blocked = handover("plan-check-off", tokens.good);
	await assert.rejects(
		credentials.internalConnectPlan(off.route, "anthropic", blocked.digest, blocked.sealed),
		/not available/,
	);
	off.sql
		.prepare(
			"INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok) VALUES ('anthropic', ?, 'g', 'x', 0, 0, 1)",
		)
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
	// Until its agent reported models, a plan offers only the agent's default; then what was reported.
	assert.deepEqual(
		hostedCatalog("claude", [plan])?.models.map(m => m.id),
		["default"],
	);
	assert.deepEqual(
		hostedCatalog("claude", [{ ...plan, models: ["opus", "sonnet"] }])?.models.map(m => m.id),
		["default", "opus", "sonnet"],
	);
	assert.equal(hostedCatalog("opencode", [plan]), undefined);
	assert.equal(hostedAgentProblem("claude", [plan], true), null);
	assert.match(hostedAgentProblem("opencode", [plan], true) ?? "", /key on the Connections page/);
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
	/** The user actor passes its ChatGPT sign-in holder to `internalConnectPlan` (actors/user.ts); a case may give one. */
	const holders = new Map<string, ChatgptPlan>();
	const bind = <T extends object>(actions: T, context: object, chatgpt?: ChatgptPlan) =>
		new Proxy(
			{},
			{
				get:
					(_, name) =>
					(...args: unknown[]) =>
						(actions as Record<string | symbol, (...a: unknown[]) => unknown>)[name]!(
							context,
							...args,
							...(name === "internalConnectPlan" && chatgpt ? [chatgpt] : []),
						),
			},
		);
	const codes = connectCodes.config.actions!;
	const client = {
		connectCodes: {
			getOrCreate: (key: string[], { params }: { params: unknown }) => bind(codes, { db, key, conn: { params } }),
		},
		user: {
			get: ([uid]: string[], { params }: { params: unknown }) =>
				bind(credentials, { ...userOf(uid).context, client: () => client, conn: { params } }, holders.get(uid)),
		},
	};
	const engine = () => client as never;
	let address = 0;
	return {
		sql,
		holders,
		db: (uid: string) => userOf(uid).context.db,
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
	const approve = (uid: string, code: string) => credentials.approvePlanConnect(world.as(uid), code, "anthropic");
	const code = (err: unknown) => (err as { code?: string }).code;

	// start answers the code to show, the page to approve it on and the terminal's secret; nothing is signed in.
	assert.equal((await world.post(start, { provider: "gemini" })).status, 400);
	const first = await open();
	assert.equal(first.approveUrl, `${config.origins[0]}/connect?code=${first.userCode}&plan=anthropic`);
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

test("hosted Codex pays with the ChatGPT plan first, an OpenAI key otherwise, and the plans never cross", async () => {
	const { hostedPayer, hostedCatalog, hostedAgentProblem } = await import("../server/src/sandbox/harnesses.js");
	const key = { provider: "openai" as const, checkedAt: 1, models: ["gpt-5.5", "text-embedding-3-large"] };
	const chatgpt = { provider: "openai" as const, plan: true as const, checkedAt: 2, models: ["gpt-5.5-codex"] };
	const claude = { provider: "anthropic" as const, plan: true as const, checkedAt: 2 };
	assert.deepEqual(hostedPayer("codex", "gpt-5.5", [key, chatgpt]), { provider: "openai", plan: true });
	assert.deepEqual(hostedPayer("codex", "default", [chatgpt]), { provider: "openai", plan: true });
	assert.deepEqual(hostedPayer("codex", "gpt-5.5", [key]), { provider: "openai" });
	assert.equal(hostedPayer("codex", "default", [claude]), null, "a Claude plan never pays for Codex");
	assert.equal(hostedPayer("claude", "default", [chatgpt]), null, "a ChatGPT plan never pays for Claude Code");
	assert.equal(hostedPayer("opencode", "openai/gpt-5.5", [chatgpt]), null);
	assert.deepEqual(
		hostedCatalog("codex", [chatgpt])?.models.map(m => m.id),
		["default", "gpt-5.5-codex"],
	);
	assert.deepEqual(
		hostedCatalog("codex", [{ ...chatgpt, models: undefined }])?.models.map(m => m.id),
		["default"],
	);
	assert.equal(hostedCatalog("claude", [chatgpt]), undefined);
	assert.equal(hostedAgentProblem("codex", [chatgpt], true), null);
	// Windlass runs on the ChatGPT sign-in its own way: the plan adds nothing to its Settings-key models.
	assert.equal(hostedCatalog("windlass", [chatgpt]), undefined);
});

test("a terminal connects the ChatGPT plan with the sign-in Windlass saved on its computer, for any signed-in user", async t => {
	const { SignInHolder } = await import("../server/src/signin/holder.js");
	const { checkChatgptPlan } = await import("../server/src/actors/user/signin.js");
	const { loadChatgptSignIn, writeChatgptSignIn } = await import("../server/src/credentials/plans.js");
	const catalog = createServer((req, res) => {
		if (req.headers.authorization !== "Bearer chatgpt-access-for-catalog") return void res.writeHead(401).end("{}");
		res.end(JSON.stringify({ models: [{ slug: "gpt-5.5-codex", visibility: "list" }] }));
	});
	await new Promise<void>(resolve => catalog.listen(0, "127.0.0.1", resolve));
	t.after(() => catalog.close());
	process.env.WLP_OPENAI_BASE_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
	const world = connectWorld();
	t.after(() => world.close());
	await world.ready();
	// Each user's actor holds a real holder over its own `model_plan` row, and runs the same check after adopting.
	const holderOf = (uid: string) => {
		const db = world.db(uid);
		const holder = new SignInHolder({
			uid,
			sealer: serverSealer(),
			store: { load: () => loadChatgptSignIn(db), save: row => writeChatgptSignIn(db, row) },
			commands: {
				token: async (material: unknown) => ({
					ok: true,
					material,
					token: { accessToken: "chatgpt-access-for-catalog", expiresAt: Date.now() + 3_600_000 },
					shorter: false,
				}),
			} as never,
			log: () => {},
		});
		const ctx = { vars: { signIn: Promise.resolve(holder) }, db, key: [uid], keepAwake: <T>(p: Promise<T>) => p };
		const plan: ChatgptPlan = {
			token: async () => null,
			adopt: async material => {
				await holder.adoptMaterial(material);
				await checkChatgptPlan(ctx as never);
			},
			check: async () => {},
			forget: () => holder.logout(),
		};
		world.holders.set(uid, plan);
		return holder;
	};
	const { start, poll, connect } = CONNECT_PATHS;
	const code = (err: unknown) => (err as { code?: string }).code;
	const open = async () => {
		const started = await world.post(start, { provider: "openai" }, world.address());
		assert.equal(started.status, 201);
		return started.body as { userCode: string; request: string; approveUrl: string };
	};
	const state = async (request: string) => (await world.post(poll, { request })).body.state;
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString(
		"base64url",
	);
	const refresh = "chatgpt-refresh-" + hex();
	const signIn = (email: string) => ({
		files: {
			"auth.json": JSON.stringify({
				account: { sub: `sub-${email}`, email },
				accessToken: "chatgpt-access-" + hex(),
				refreshToken: refresh,
				expiresAt: Date.now() + 3_600_000,
				idToken: `h.${claims}.sig`,
			}),
			"host-id": "host-" + hex(),
		},
	});

	// plan-check-b is not in WLP_PLAN_USERS: the ChatGPT sign-in is still theirs to connect, for Windlass.
	const holderB = holderOf("plan-check-b");
	holderOf("plan-check-c");
	const first = await open();
	assert.equal(first.approveUrl, `${config.origins[0]}/connect?code=${first.userCode}&plan=openai`);
	// A page that names another plan approves nothing.
	await assert.rejects(
		credentials.approvePlanConnect(world.as("plan-check-a"), first.userCode, "anthropic"),
		err => code(err) === "connect_code_not_found",
	);
	assert.equal(await state(first.request), "pending");
	await credentials.approvePlanConnect(world.as("plan-check-b"), first.userCode, "openai");
	assert.equal(await state(first.request), "approved");

	// Not a finished sign-in, an unknown file, too large, or a Claude token: refused before the request is taken.
	const good = signIn("b@example.com");
	for (const bad of [
		{ signIn: { files: { "auth.json": "{}" } } },
		{ signIn: { files: { "host-id": "h" } } },
		{ signIn: { files: { ...good.files, "auth-pending.json": "{}" } } },
		{ signIn: { files: { ...good.files, "host-id": "x".repeat(64 * 1024 + 1) } } },
		{ signIn: "auth.json" },
	]) {
		const refused = await world.post(connect, { request: first.request, ...bad });
		assert.deepEqual([refused.status, refused.body.code], [400, "bad_sign_in"], JSON.stringify(bad).slice(0, 80));
	}
	const huge = await world.post(connect, {
		request: first.request,
		signIn: { files: { "auth.json": "x".repeat(300 * 1024) } },
	});
	assert.equal(huge.status, 413);
	assert.equal(await state(first.request), "approved");

	// The sign-in connects the approving user's ChatGPT plan through their holder, once: a new generation, its label read.
	const done = await world.post(connect, { request: first.request, ...{ signIn: good } });
	assert.deepEqual(done, { status: 200, body: { account: "b@example.com · Plus" } });
	const [plan] = (await world.plans("plan-check-b")).plans;
	assert.deepEqual([plan?.provider, plan?.account, plan?.models], ["openai", "b@example.com · Plus", undefined]);
	const stored = await loadChatgptSignIn(world.db("plan-check-b"));
	assert.ok(stored?.sealed && stored.generation, "stored by the holder under a generation");
	assert.ok(
		!stored.sealed.includes(refresh) &&
			!format("%o", world.sql.prepare("SELECT * FROM requests").all()).includes(refresh),
	);
	assert.equal((await holderB.status())?.email, "b@example.com");
	assert.deepEqual((await world.plans("plan-check-c")).plans, [], "only the approving user gets it");
	const again = await world.post(connect, { request: first.request, signIn: good });
	assert.deepEqual([again.status, again.body.code], [404, "connect_code_not_found"]);

	// Connecting again replaces it with a new generation; a plan user's catalog is read with its access token.
	holderOf("plan-check-a");
	const second = await open();
	await credentials.approvePlanConnect(world.as("plan-check-a"), second.userCode, "openai");
	assert.equal((await world.post(connect, { request: second.request, signIn: signIn("a@example.com") })).status, 200);
	const planA = (await world.plans("plan-check-a")).plans.find(p => p.provider === "openai");
	assert.deepEqual([planA?.account, planA?.models], ["a@example.com · Plus", ["gpt-5.5-codex"]]);

	// A Claude token for a ChatGPT request is refused, and the request it took is spent.
	const third = await open();
	await credentials.approvePlanConnect(world.as("plan-check-a"), third.userCode, "openai");
	const crossed = await world.post(connect, { request: third.request, token: planToken() });
	assert.deepEqual([crossed.status, crossed.body.code], [400, "bad_plan_token"]);
	assert.equal(await state(third.request), "expired");

	// In transit the sign-in is sealed to its user and request: another user's actor cannot open it.
	const digest = connectCodeDigest.ofRequest(newConnectRequest().request)!;
	const sealed = serverSealer().seal(
		"transit",
		connectTransitSubject("plan-check-b", "openai", digest),
		JSON.stringify(good),
	);
	assert.ok(!sealed.includes(refresh));
	const c = account("plan-check-c");
	t.after(() => c.sql.close());
	await assert.rejects(
		credentials.internalConnectPlan(c.route, "openai", digest, sealed, world.holders.get("plan-check-c")),
	);
	assert.deepEqual(await loadChatgptSignIn(c.context.db), null);
});

test("a ChatGPT plan is the sign-in: generation kept across refreshes, the current access token per request, behind WLP_PLAN_USERS", async t => {
	const { writeChatgptSignIn, loadChatgptSignIn, saveChatgptCheck } = await import(
		"../server/src/credentials/plans.js"
	);
	const a = account("plan-check-a"),
		off = account("plan-check-off");
	t.after(() => {
		a.sql.close();
		off.sql.close();
	});
	await writeChatgptSignIn(a.context.db, { sealed: "sealed-1", generation: "g1", shortNoted: false });
	const [first] = (await credentials.modelPlans(a.context)).plans;
	assert.deepEqual(
		{ provider: first?.provider, ok: first?.ok, account: first?.account },
		{
			provider: "openai",
			ok: true,
			account: null,
		},
	);
	await saveChatgptCheck(a.context.db, "g1", { account: "a@b.com · Plus", models: ["gpt-5.5-codex"] });
	// A refresh writes a new sealed sign-in at the same generation: what was learned stays.
	await writeChatgptSignIn(a.context.db, { sealed: "sealed-2", generation: "g1", shortNoted: true });
	const ref = { provider: "openai" as const, plan: true as const };
	assert.equal(await credentials.internalCredentialGeneration(a.relay, ref), "g1");
	const [refreshed] = (await credentials.modelPlans(a.context)).plans;
	assert.deepEqual(
		{ account: refreshed?.account, models: refreshed?.models },
		{
			account: "a@b.com · Plus",
			models: ["gpt-5.5-codex"],
		},
	);
	assert.deepEqual(await loadChatgptSignIn(a.context.db), { sealed: "sealed-2", generation: "g1", shortNoted: true });

	// The relay's request gets the holder's current access token, sealed for it, with its expiry.
	let access = "chatgpt-access-one-" + hex();
	const expiresAt = Date.now() + 40 * 60_000;
	const holder = {
		token: async () => ({ secret: access, generation: "g1", expiresAt }),
		adopt: async () => {},
		check: async () => {},
		forget: async () => {},
	};
	const nonce = hex();
	const sealed = (await credentials.internalCredential(a.relay, ref, nonce, holder))!;
	assert.ok(!sealed.includes(access));
	assert.deepEqual(openCredentialTransit("plan-check-a", ref, nonce, sealed), {
		secret: access,
		generation: "g1",
		expiresAt,
	});
	access = "chatgpt-access-two-" + hex();
	const next = hex();
	const again = (await credentials.internalCredential(a.relay, ref, next, holder))!;
	assert.equal(openCredentialTransit("plan-check-a", ref, next, again).secret, access, "the refreshed token next");
	const hosted = await credentials.internalHostedCredentials(a.relay);
	assert.ok(hosted.some(c => c.plan && c.provider === "openai" && c.generation === "g1"));

	// Another connection is another generation: the old one's learned facts go.
	await writeChatgptSignIn(a.context.db, { sealed: "sealed-3", generation: "g2", shortNoted: false });
	const [reconnected] = (await credentials.modelPlans(a.context)).plans;
	assert.deepEqual(
		{ account: reconnected?.account, models: reconnected?.models },
		{ account: null, models: undefined },
	);
	assert.equal(await credentials.internalCredentialGeneration(a.relay, ref), "g2");
	// Removing it is forgetting the sign-in; no sign-in is no plan.
	let forgot = 0;
	await credentials.removeModelPlan(a.context, "openai", { ...holder, forget: async () => void forgot++ });
	assert.equal(forgot, 1);
	await writeChatgptSignIn(a.context.db, { sealed: null, generation: "g3", shortNoted: false });
	assert.deepEqual((await credentials.modelPlans(a.context)).plans, []);

	// Off for an account: Windlass keeps its sign-in, but no turn pays with it as a plan.
	await writeChatgptSignIn(off.context.db, { sealed: "sealed-off", generation: "g1", shortNoted: false });
	assert.equal(await credentials.internalCredentialGeneration(off.relay, ref), null);
	assert.equal(await credentials.internalCredential(off.relay, ref, hex(), holder), null);
	assert.ok(!(await credentials.internalHostedCredentials(off.relay)).some(c => c.plan));
	assert.deepEqual(await loadChatgptSignIn(off.context.db), {
		sealed: "sealed-off",
		generation: "g1",
		shortNoted: false,
	});
});

test("hosted Windlass pays for its ChatGPT models with the plan, behind WLP_PLAN_USERS; a prefixed model still takes its key", async t => {
	const { turnCredential, CHATGPT_PLAN_OFF } = await import("../server/src/actors/agent-session.js");
	const { writeChatgptSignIn } = await import("../server/src/credentials/plans.js");
	const a = account("plan-check-a"),
		off = account("plan-check-off");
	t.after(() => {
		a.sql.close();
		off.sql.close();
	});
	for (const { sql } of [a, off])
		sql
			.prepare(
				"INSERT INTO model_provider(provider, sealed, generation, last4, added_at, check_ok) VALUES ('openai', 'x', 'key-g', 'abcd', 1, 1)",
			)
			.run();
	/** The session's resolver over this account's real credential actions, as the user actor serves them. */
	const resolver = (who: ReturnType<typeof account>, uid: string) => {
		const actor = {
			internalCredentialGeneration: (ref: unknown) => credentials.internalCredentialGeneration(who.relay, ref),
		};
		const ctx = { client: () => ({ user: { get: () => actor } }), vars: {} };
		return (model: string, extra: object = {}, pinned?: object) =>
			turnCredential(
				ctx as never,
				{ place: { kind: "hosted" }, uid, harness: "windlass", ...extra } as never,
				undefined,
				model,
				undefined,
				pinned as never,
			);
	};
	const turn = resolver(a, "plan-check-a");
	await assert.rejects(
		turn("gpt-5.5"),
		(error: Error & { code?: string }) =>
			/Connect your ChatGPT plan/.test(error.message) && error.code === "chatgpt_required",
		"no plan connected",
	);
	await writeChatgptSignIn(a.context.db, { sealed: "sealed-1", generation: "g1", shortNoted: false });
	const plan = { provider: "openai", plan: true, generation: "g1" };
	assert.deepEqual(await turn("gpt-5.5"), { model: "gpt-5.5", key: plan });
	assert.deepEqual(await turn("openai/gpt-5.5"), {
		model: "openai/gpt-5.5",
		key: { provider: "openai", generation: "key-g" },
	});
	// A turn paused before this pinned nothing: it pins the plan when it resumes.
	assert.deepEqual(await turn("gpt-5.5", {}, { model: "gpt-5.5" }), { model: "gpt-5.5", key: plan });
	assert.deepEqual(await turn("gpt-5.5", {}, { model: "gpt-5.5", key: plan }), { model: "gpt-5.5", key: plan });
	// A demo calls no model and an environment build runs no agent; a machine's Windlass uses the machine's sign-in.
	assert.deepEqual(await turn("gpt-5.5", { demo: true }), { model: "gpt-5.5" });
	assert.deepEqual(await turn("gpt-5.5", { environmentBuild: true }), { model: "gpt-5.5" });
	assert.deepEqual(await turn("gpt-5.5", { place: { kind: "machine", machineId: "desk" } }), { model: "gpt-5.5" });
	await writeChatgptSignIn(a.context.db, { sealed: "sealed-2", generation: "g2", shortNoted: false });
	await assert.rejects(
		turn("gpt-5.5", {}, { model: "gpt-5.5", key: plan }),
		/The plan for this turn changed or was removed/,
	);

	// Off for an account: its sign-in is still there, but no hosted Windlass turn pays with it; its key still does.
	await writeChatgptSignIn(off.context.db, { sealed: "sealed-off", generation: "g1", shortNoted: false });
	const offTurn = resolver(off, "plan-check-off");
	await assert.rejects(offTurn("gpt-5.5"), (error: Error & { code?: string }) => {
		assert.equal(error.message, CHATGPT_PLAN_OFF);
		assert.equal(error.code, "harness_signed_out");
		return true;
	});
	assert.match(CHATGPT_PLAN_OFF, /ChatGPT plan isn't enabled for hosted runs on this account/);
	await assert.rejects(offTurn("gpt-5.5", {}, { model: "gpt-5.5" }), /isn't enabled for hosted runs/);
	assert.deepEqual(await offTurn("openai/gpt-5.5"), {
		model: "openai/gpt-5.5",
		key: { provider: "openai", generation: "key-g" },
	});
	assert.deepEqual(await offTurn("gpt-5.5", { place: { kind: "machine", machineId: "desk" } }), { model: "gpt-5.5" });
});

test("the ChatGPT sign-in's old table is copied into the plan once, keeping its generation", async t => {
	const { moveSignInToPlan, loadChatgptSignIn } = await import("../server/src/credentials/plans.js");
	const a = account("plan-check-a");
	t.after(() => a.sql.close());
	a.sql.exec(`CREATE TABLE signin (id INTEGER PRIMARY KEY CHECK (id = 1), sealed TEXT, generation INTEGER NOT NULL,
		short_noted INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO signin VALUES (1, 'wlps1.legacy', 4, 1, 5)`);
	await moveSignInToPlan(a.context.db);
	assert.deepEqual(await loadChatgptSignIn(a.context.db), {
		sealed: "wlps1.legacy",
		generation: "4",
		shortNoted: true,
	});
	const [plan] = (await credentials.modelPlans(a.context)).plans;
	assert.deepEqual(
		{ provider: plan?.provider, ok: plan?.ok, addedAt: plan?.addedAt },
		{ provider: "openai", ok: true, addedAt: 5 },
	);
	assert.equal(a.sql.prepare("SELECT name FROM sqlite_master WHERE name = 'signin'").all().length, 0);
	await moveSignInToPlan(a.context.db);
	assert.equal((await credentials.modelPlans(a.context)).plans.length, 1, "a second start finds nothing to copy");
	// A signed-out row is not a plan.
	const b = account("plan-check-c");
	t.after(() => b.sql.close());
	b.sql.exec(`CREATE TABLE signin (id INTEGER PRIMARY KEY, sealed TEXT, generation INTEGER NOT NULL,
		short_noted INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO signin VALUES (1, NULL, 2, 0, 5)`);
	await moveSignInToPlan(b.context.db);
	assert.deepEqual((await credentials.modelPlans(b.context)).plans, []);
});

test("a plan's models: ChatGPT's listed catalog, a Claude plan's from its agent at the current generation", async t => {
	const { chatgptCatalogModels, recordAgentModels, writeChatgptSignIn } = await import(
		"../server/src/credentials/plans.js"
	);
	const token = "chatgpt-access-" + "Zx9Qw".repeat(8);
	assert.deepEqual(
		chatgptCatalogModels(
			{
				models: [
					{ slug: "gpt-5.5-codex", visibility: "list", display_name: "GPT-5.5 Codex" },
					{ slug: "gpt-5.5-internal", visibility: "hide" },
					{ slug: "bad slug", visibility: "list" },
					{ slug: "x-Zx9Qw-y", visibility: "list" },
					{ slug: 7, visibility: "list" },
					{ slug: "gpt-5.5-mini", visibility: "list" },
				],
			},
			token,
		),
		["gpt-5.5-codex", "gpt-5.5-mini"],
	);
	assert.deepEqual(chatgptCatalogModels({ data: [{ id: "gpt-5.5" }] }, token), []);
	assert.equal(
		chatgptCatalogModels(
			{ models: Array.from({ length: 50 }, (_, i) => ({ slug: `m-${i}`, visibility: "list" })) },
			token,
		).length,
		32,
	);

	const a = account("plan-check-a");
	t.after(() => a.sql.close());
	a.sql
		.prepare(
			"INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok) VALUES ('anthropic', 's', 'g1', 'x', 0, 0, 1)",
		)
		.run();
	assert.equal(
		await recordAgentModels(a.context.db, "anthropic", "g0", ["opus"]),
		false,
		"a turn of an older connection",
	);
	assert.equal(await recordAgentModels(a.context.db, "anthropic", "g1", ["default", "opus", "sonnet", "no way"]), true);
	const claude = (await credentials.modelPlans(a.context)).plans.find(p => p.provider === "anthropic");
	assert.deepEqual(claude?.models, ["opus", "sonnet"]);
	await writeChatgptSignIn(a.context.db, { sealed: "s", generation: "g1", shortNoted: false });
	assert.equal(
		await recordAgentModels(a.context.db, "openai", "g1", ["gpt-x"]),
		false,
		"ChatGPT's come from its catalog",
	);
	// Only a turn's own plan reaches the actor's action, and only as the relay's caller.
	await assert.rejects(
		credentials.internalPlanModels(a.context, { provider: "anthropic", plan: true, generation: "g1" }, ["x"]),
		/internal/,
	);
	assert.equal(
		await credentials.internalPlanModels(a.relay, { provider: "anthropic", generation: "g1" }, ["x"]),
		false,
	);
});

test("plan names come from the account, and an unknown one is shown as it came", async () => {
	const { claudePlanLabel, chatgptPlanLabel, accountLabel } = await import("../server/src/credentials/plan-labels.js");
	assert.equal(claudePlanLabel("claude_max"), "Max");
	assert.equal(claudePlanLabel("Claude Max 20x subscription"), "Ultra");
	assert.equal(claudePlanLabel("max5"), "Max");
	assert.equal(claudePlanLabel("claude_pro"), "Pro");
	assert.equal(claudePlanLabel("claude_team"), "Team");
	assert.equal(claudePlanLabel("claude_enterprise"), "Enterprise");
	assert.equal(claudePlanLabel("free"), "Free");
	assert.equal(claudePlanLabel("claude_galaxy_brain"), "Claude Galaxy Brain");
	assert.equal(claudePlanLabel(undefined), null);
	assert.equal(chatgptPlanLabel("plus"), "Plus");
	assert.equal(chatgptPlanLabel("pro"), "Pro");
	assert.equal(chatgptPlanLabel("go"), "Go");
	assert.equal(chatgptPlanLabel("team"), "Business");
	assert.equal(chatgptPlanLabel("edu_plus"), "Edu");
	assert.equal(chatgptPlanLabel("enterprise_cbp_usage_based"), "Enterprise");
	assert.equal(chatgptPlanLabel("unknown"), null);
	assert.equal(chatgptPlanLabel("super_duper"), "Super Duper");
	assert.equal(accountLabel("a@b.com", "Plus"), "a@b.com · Plus");
	assert.equal(accountLabel(null, null), null);

	const { accountOf } = await import("../server/src/signin/material.js");
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString(
		"base64url",
	);
	const auth = (idToken: unknown) => ({
		files: { "auth.json": JSON.stringify({ account: { sub: "s", email: "a@b.com" }, expiresAt: 1, idToken }) },
	});
	assert.equal(accountOf(auth(`h.${claims}.sig`))?.planType, "plus");
	assert.equal(accountOf(auth("not-a-jwt"))?.planType, null);
	assert.equal(accountOf(auth(undefined))?.sub, "s");
});
