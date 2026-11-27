import "./check-secret.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { beginOAuth, finishOAuth, googleCredentials } from "../server/src/platform-login.js";
import { identityTables, resolveIdentity } from "../server/src/actors/account-identities.js";

test("Google code exchange, ID token verification and explicit identity ownership", async t => {
	const origin = "http://localhost:5173";
	delete process.env.WLP_GOOGLE_CLIENT_ID;
	delete process.env.WLP_GOOGLE_CLIENT_SECRET;
	assert.equal(googleCredentials(), null);
	assert.throws(() => beginOAuth("google", origin), { code: "provider_off" });
	process.env.WLP_GOOGLE_CLIENT_ID = "test-client";
	assert.equal(googleCredentials(), null);
	process.env.WLP_GOOGLE_CLIENT_SECRET = "test-secret";
	assert.throws(() => beginOAuth("google", "https://elsewhere.invalid"));
	const { url, pending } = beginOAuth("google", origin);
	const query = new URL(url).searchParams;
	assert.equal(query.get("code_challenge_method"), "S256");
	assert.equal(query.get("scope"), "openid email profile");
	const callback = pending.redirect + "?code=one&state=" + query.get("state");

	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "google-test", alg: "RS256" };
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		sub: "12345",
		iss: "https://accounts.google.com",
		aud: "test-client",
		exp: now + 3600,
		iat: now,
		nonce: query.get("nonce"),
		email: "owner@example.invalid",
		email_verified: true,
		hd: "example.invalid",
		name: "Ada Owner",
		picture: "https://lh3.googleusercontent.com/a/ada",
	};
	let overrides: Record<string, unknown> = {};
	let corrupt = false;
	const tokenBody = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const requests = t.mock.method(
		globalThis,
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(input) === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
			assert.equal(String(input), "https://oauth2.googleapis.com/token");
			const body = init?.body as URLSearchParams;
			assert.equal(body.get("client_secret"), "test-secret");
			assert.equal(body.get("grant_type"), "authorization_code");
			assert.equal(body.get("redirect_uri"), query.get("redirect_uri"));
			assert.equal(body.get("code"), "one");
			assert.equal(
				createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
				query.get("code_challenge"),
			);
			const parts = tokenBody({ alg: "RS256", kid: jwk.kid }) + "." + tokenBody({ ...claims, ...overrides });
			const signature = sign("sha256", Buffer.from(parts), privateKey);
			if (corrupt) signature[0] ^= 1;
			return Response.json({ id_token: parts + "." + signature.toString("base64url") });
		},
	);
	await assert.rejects(finishOAuth(pending, callback.replace(pending.state, "wrong")), { code: "invalid_callback" });
	assert.equal(requests.mock.callCount(), 0);

	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	const db = {
		execute: async (sql: string, ...args: SQLInputValue[]) => sqlite.prepare(sql).all(...args),
	} as Parameters<typeof identityTables>[0];
	await identityTables(db);
	const identity = await finishOAuth(pending, callback);
	const uid = await resolveIdentity(db, identity);
	assert.ok(uid);
	assert.equal(identity.display, claims.email);
	assert.equal(identity.name, "Ada Owner");
	assert.equal(identity.avatar, claims.picture);
	assert.notEqual(await resolveIdentity(db, { ...identity, sub: "different" }), uid);
	overrides = { email: "changed@gmail.com" };
	assert.equal(await resolveIdentity(db, await finishOAuth(pending, callback)), uid);
	assert.equal(sqlite.prepare("SELECT display FROM login_identity WHERE uid=?").get(uid)?.display, "changed@gmail.com");
	overrides = { picture: "http://insecure.invalid/a.png" };
	assert.equal((await finishOAuth(pending, callback)).avatar, null);

	for (const patch of [{ email_verified: false }, { email_verified: "true" }, { hd: undefined }]) {
		overrides = { sub: "another-" + JSON.stringify(patch), ...patch };
		const separate = await finishOAuth(pending, callback);
		assert.equal(separate.email, null);
		assert.equal(separate.display, claims.email);
		assert.notEqual(await resolveIdentity(db, separate), uid);
	}
	for (const patch of [
		{ iss: "wrong" },
		{ aud: "wrong" },
		{ azp: "wrong" },
		{ exp: now - 1 },
		{ nonce: "another attempt" },
		{ sub: "" },
	]) {
		overrides = patch;
		await assert.rejects(finishOAuth(pending, callback));
	}
	overrides = {};
	corrupt = true;
	await assert.rejects(finishOAuth(pending, callback));
});

test("GitHub numeric subjects belong to one instance", async t => {
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	const db = {
		execute: async (sql: string, ...args: SQLInputValue[]) => sqlite.prepare(sql).all(...args),
	} as Parameters<typeof identityTables>[0];
	await identityTables(db);
	const identity = { provider: "github" as const, issuer: "https://api.github.com", sub: "42", email: null };
	const uid = await resolveIdentity(db, identity);
	assert.notEqual(await resolveIdentity(db, { ...identity, issuer: "https://enterprise.invalid" }), uid);
});

test("GitHub callback registration error identifies the configured redirect", async () => {
	const redirect = "http://localhost:5173/signin";
	const pending = {
		provider: "github" as const,
		issuer: "https://api.github.com",
		redirect,
		state: "abc",
		nonce: "",
		verifier: "",
	};
	await assert.rejects(finishOAuth(pending, redirect + "?state=abc&error=redirect_uri_mismatch"), {
		message: "Add " + redirect + " to the GitHub App's callback URLs",
	});
});

test("malformed provider replies expose only a fixed error code in diagnostics", async t => {
	process.env.WLP_GOOGLE_CLIENT_ID = "test-client";
	process.env.WLP_GOOGLE_CLIENT_SECRET = "test-secret";
	const { pending } = beginOAuth("google", "http://localhost:5173");
	t.mock.method(globalThis, "fetch", async () => new Response("person@example.invalid"));
	const diagnostics: string[] = [];
	t.mock.method(console, "warn", (line: string) => {
		diagnostics.push(line);
	});
	await assert.rejects(finishOAuth(pending, pending.redirect + "?code=one&state=" + pending.state), {
		code: "invalid_callback",
	});
	assert.deepEqual(diagnostics, ["[wlp] login.google code=invalid_response"]);
});

test("the preview's email index and unproven identity assignments cannot select an owner", async t => {
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	sqlite.exec(`CREATE TABLE legacy (uid TEXT PRIMARY KEY, email TEXT NOT NULL);
		CREATE TABLE identity (provider TEXT, sub TEXT, uid TEXT NOT NULL UNIQUE, PRIMARY KEY(provider, sub));
		INSERT INTO legacy VALUES ('u_owner','owner@example.invalid');
		INSERT INTO identity VALUES ('google','previous','u_other')`);
	const db = {
		execute: async (sql: string, ...args: SQLInputValue[]) => sqlite.prepare(sql).all(...args),
	} as Parameters<typeof identityTables>[0];
	await identityTables(db);
	const identity = {
		provider: "google" as const,
		issuer: "https://accounts.google.com",
		sub: "fresh",
		email: "owner@example.invalid",
	};
	assert.notEqual(await resolveIdentity(db, identity), "u_owner");
	assert.notEqual(await resolveIdentity(db, { ...identity, sub: "previous" }), "u_other");
});
