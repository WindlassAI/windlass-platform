import { createClient } from "rivetkit/client";
import { assertOrigin, serviceParams } from "./auth.js";
import { createGrant } from "./actors/internal.js";
import { config, ownEngineEndpoint } from "./config.js";
import type { AuthResult } from "./contract.js";
import { clientAddress } from "./http-limits.js";
import type { Registry } from "./registry.js";
import { loginIssuer } from "./platform-login.js";
import { verifyToken } from "./tokens.js";

let client: ReturnType<typeof createClient<Registry>> | undefined;

export async function loginResponse(request: Request, step: string): Promise<Response> {
	const origin = request.headers.get("origin");
	const headers = new Headers({ vary: "Origin", "cache-control": "no-store" });
	const json = (status: number, body: unknown) => Response.json(body, { status, headers });
	try {
		assertOrigin({ request });
	} catch {
		return json(403, { code: "origin_not_allowed" });
	}
	if (origin) headers.set("access-control-allow-origin", origin);
	if (request.method === "OPTIONS") {
		headers.set("access-control-allow-methods", "POST");
		headers.set("access-control-allow-headers", "authorization, content-type");
		return new Response(null, { status: 204, headers });
	}
	if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
	if (!["start", "finish", "demo"].includes(step)) return json(404, { code: "not_found" });
	client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() });
	try {
		const directory = client.accountIdentities.getOrCreate(["platform"], { params: serviceParams() });
		if (!(await directory.internalAdmit(clientAddress(request) ?? ""))) {
			headers.set("retry-after", String(60 - (Math.floor(Date.now() / 1000) % 60)));
			return json(429, { code: "rate_limited", message: "Too many sign-in requests. Try again in a minute." });
		}
		// The native listener bounds the body before creating the Request.
		const raw = await request.text();
		if (raw.length > 16_384) return json(413, { code: "body_too_large" });
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			return json(400, { code: "bad_input" });
		}
		if (typeof data?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(data.id))
			return json(400, { code: "bad_attempt_id" });
		if (step === "start") {
			if (!origin) return json(400, { code: "origin_required" });
			if (!loginIssuer(data.provider))
				return json(400, { code: "provider_off", message: "This sign-in provider is unavailable." });
			if (typeof data.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.secret))
				return json(400, { code: "bad_browser", message: "Start sign-in in this tab." });
		}
		const key = [data.id];
		let session: AuthResult | null = null;
		const authorization = request.headers.get("authorization");
		if (authorization !== null) {
			const token = authorization.replace(/^Bearer /, "");
			const caller = verifyToken(token);
			if (caller?.kind !== "user" || caller.profile.demo)
				return json(403, { code: "invalid_token", message: "Sign in to link a login method." });
			const profile = await client.user.get([caller.profile.uid], { params: { token } }).me();
			session = { token, profile };
		}
		const params = serviceParams();
		if (step === "finish")
			return json(200, await client.login.get(key, { params }).finish(data.callback, data.secret, session));
		if (step === "demo" && !config.demo) return json(403, { code: "demo_disabled" });
		const attempt = client.login.getOrCreate(key, { params, createWithInput: { grant: createGrant("login", key) } });
		return json(
			200,
			step === "demo"
				? await attempt.demo()
				: await attempt.start(data.provider, origin!, data.secret, session?.profile.uid ?? null),
		);
	} catch (error) {
		const e = error as { group?: string; code?: string; message?: string };
		if (e.group === "user") return json(400, { code: e.code, message: e.message });
		if (e.group === "actor" && e.code === "not_found")
			return json(404, { code: "not_found", message: "This attempt has expired. Start again." });
		return json(503, { code: "login_unavailable", message: "Sign-in is temporarily unavailable." });
	}
}
