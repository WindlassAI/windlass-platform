import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { UserError } from "rivetkit";
import { normalizeEmail } from "./access.js";
import { config } from "./config.js";
import type { LoginProvider } from "./contract.js";
import { githubApp } from "./github/app.js";

export interface Identity {
	provider: LoginProvider;
	sub: string;
	email: string | null;
}

export interface OAuthAttempt {
	provider: LoginProvider;
	redirect: string;
	state: string;
	verifier: string;
	nonce: string;
}

export function googleCredentials() {
	const clientId = process.env.WLP_GOOGLE_CLIENT_ID?.trim();
	const clientSecret = process.env.WLP_GOOGLE_CLIENT_SECRET?.trim();
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const unavailable = () => new UserError("This sign-in provider is unavailable.", { code: "provider_off" });
const invalid = () => new UserError("This sign-in could not be verified. Start again.", { code: "invalid_callback" });

export function beginOAuth(provider: LoginProvider, origin: string) {
	if (!config.origins.includes(origin)) throw invalid();
	const redirect = origin + "/signin";
	const state = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const pending: OAuthAttempt = { provider, redirect, state, verifier, nonce };
	if (provider === "github") {
		const app = githubApp();
		if (!app) throw unavailable();
		return { pending, url: app.authorizeUrl(state, challenge, redirect) };
	}
	const google = googleCredentials();
	if (provider !== "google" || !google) throw unavailable();
	const params = new URLSearchParams({ client_id: google.clientId, redirect_uri: redirect, response_type: "code", scope: "openid email", state, nonce, code_challenge: challenge, code_challenge_method: "S256" });
	return { pending, url: "https://accounts.google.com/o/oauth2/v2/auth?" + params };
}

export async function finishOAuth(pending: OAuthAttempt, address: string): Promise<Identity> {
	const url = new URL(address);
	if (url.origin + url.pathname !== pending.redirect || url.searchParams.get("state") !== pending.state) throw invalid();
	const code = url.searchParams.get("code");
	if (!code || url.searchParams.has("error")) throw invalid();
	if (pending.provider === "github") {
		const app = githubApp();
		if (!app) throw unavailable();
		const token = await app.exchangeCode(code, pending.verifier, pending.redirect);
		try {
			const viewer = await app.viewer(token);
			return { provider: "github", sub: String(viewer.id), email: normalizeEmail(await app.verifiedPrimaryEmail(token)) };
		} finally {
			await app.forgetUserToken(token);
		}
	}
	const google = googleCredentials();
	if (pending.provider !== "google" || !google) throw unavailable();
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
		body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: pending.redirect, code_verifier: pending.verifier, client_id: google.clientId, client_secret: google.clientSecret }),
	});
	if (!response.ok) throw invalid();
	const { id_token } = await response.json() as { id_token?: string };
	if (typeof id_token !== "string") throw invalid();
	const { payload } = await jwtVerify(id_token, googleKeys, {
		algorithms: ["RS256"], issuer: ["https://accounts.google.com", "accounts.google.com"], audience: google.clientId, requiredClaims: ["exp", "iat", "sub"],
	});
	if (payload.nonce !== pending.nonce || typeof payload.sub !== "string" || !payload.sub ||
		((Array.isArray(payload.aud) && payload.aud.length > 1 || payload.azp !== undefined) && payload.azp !== google.clientId)) throw invalid();
	const verified = payload.email_verified === true ? normalizeEmail(payload.email) : null;
	// For third-party mailboxes Google may still attest to an earlier owner's verification.
	const hosted = typeof payload.hd === "string" && payload.hd.length > 0;
	const email = hosted || verified?.endsWith("@gmail.com") ? verified : null;
	return { provider: "google", sub: payload.sub, email };
}
