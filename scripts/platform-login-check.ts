import "./check-secret.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { beginOAuth, finishOAuth, googleCredentials } from "../server/src/platform-login.js";
import { identityTables, resolveIdentity } from "../server/src/actors/account-identities.js";

test("Google code exchange, ID token verification and legacy account carry-over", async t => {
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
	assert.equal(query.get("scope"), "openid email");
	const callback = pending.redirect + "?code=one&state=" + query.get("state");

	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "google-test", alg: "RS256" };
	const now = Math.floor(Date.now() / 1000);
	const claims = { sub: "12345", iss: "https://accounts.google.com", aud: "test-client", exp: now + 3600, iat: now, nonce: query.get("nonce"), email: "owner@example.invalid", email_verified: true, hd: "example.invalid" };
	let overrides: Record<string, unknown> = {};
	let corrupt = false;
	const tokenBody = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const requests = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (String(input) === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
		assert.equal(String(input), "https://oauth2.googleapis.com/token");
		const body = init?.body as URLSearchParams;
		assert.equal(body.get("client_secret"), "test-secret");
		assert.equal(body.get("grant_type"), "authorization_code");
		assert.equal(body.get("redirect_uri"), query.get("redirect_uri"));
		assert.equal(body.get("code"), "one");
		assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), query.get("code_challenge"));
		const parts = tokenBody({ alg: "RS256", kid: jwk.kid }) + "." + tokenBody({ ...claims, ...overrides });
		const signature = sign("sha256", Buffer.from(parts), privateKey);
		if (corrupt) signature[0] ^= 1;
		return Response.json({ id_token: parts + "." + signature.toString("base64url") });
	});
	await assert.rejects(finishOAuth(pending, callback.replace(pending.state, "wrong")), { code: "invalid_callback" });
	assert.equal(requests.mock.callCount(), 0);

	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	const db = { execute: async (sql: string, ...args: SQLInputValue[]) => sqlite.prepare(sql).all(...args) } as Parameters<typeof identityTables>[0];
	await identityTables(db);
	await db.execute("INSERT INTO legacy VALUES (?,?)", "u_owner", claims.email);
	const identity = await finishOAuth(pending, callback);
	assert.equal(await resolveIdentity(db, identity), "u_owner");
	assert.notEqual(await resolveIdentity(db, { ...identity, provider: "github" }), "u_owner");
	overrides = { email: "changed@gmail.com" };
	assert.equal(await resolveIdentity(db, await finishOAuth(pending, callback)), "u_owner");

	for (const patch of [{ email_verified: false }, { email_verified: "true" }, { hd: undefined }]) {
		overrides = { sub: "another-" + JSON.stringify(patch), ...patch };
		const separate = await finishOAuth(pending, callback);
		assert.equal(separate.email, null);
		assert.notEqual(await resolveIdentity(db, separate), "u_owner");
	}
	for (const patch of [{ iss: "wrong" }, { aud: "wrong" }, { azp: "wrong" }, { exp: now - 1 }, { nonce: "another attempt" }, { sub: "" }]) {
		overrides = patch;
		await assert.rejects(finishOAuth(pending, callback));
	}
	overrides = {};
	corrupt = true;
	await assert.rejects(finishOAuth(pending, callback));
});
