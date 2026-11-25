import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { UserError } from "rivetkit";
import { normalizeEmail } from "./access.js";
import { config } from "./config.js";
import type { LoginProvider } from "./contract.js";
import { newCodeVerifier } from "./github/state.js";
import { GithubError, githubApp } from "./github/app.js";

export interface Identity {
	provider: LoginProvider;
	issuer: string;
	sub: string;
	email: string | null;
	emailPermissionMissing?: boolean;
}

export interface OAuthAttempt {
	provider: LoginProvider;
	issuer: string;
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

export function loginIssuer(provider: LoginProvider): string | null {
	if (provider === "google") return googleCredentials() ? "https://accounts.google.com" : null;
	const app = provider === "github" && githubApp();
	return app ? new URL(app.settings.apiUrl).origin : null;
}

const callbackMismatch = (redirect: string) => new UserError("Add " + redirect + " to the GitHub App's callback URLs", { code: "callback_mismatch" });
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const unavailable = () => new UserError("This sign-in provider is unavailable.", { code: "provider_off" });
const invalid = () => new UserError("This sign-in could not be verified. Start again.", { code: "invalid_callback" });

export function beginOAuth(provider: LoginProvider, origin: string) {
	if (!config.origins.includes(origin)) throw invalid();
	const redirect = origin + "/signin";
	const state = randomBytes(32).toString("base64url");
	const { verifier, challenge } = newCodeVerifier();
	const nonce = randomBytes(32).toString("base64url");
	const issuer = loginIssuer(provider);
	if (!issuer) throw unavailable();
	const pending: OAuthAttempt = { provider, issuer, redirect, state, verifier, nonce };
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

export async function finishOAuth(pending: OAuthAttempt, address: string, readEmail = !!config.access.allowed?.emails.size): Promise<Identity> {
	const url = URL.parse(address);
	if (!url) throw invalid();
	if (url.origin + url.pathname !== pending.redirect || url.searchParams.get("state") !== pending.state) throw invalid();
	if (pending.provider === "github" && url.searchParams.get("error") === "redirect_uri_mismatch") throw callbackMismatch(pending.redirect);
	if (loginIssuer(pending.provider) !== pending.issuer) throw invalid();
	const code = url.searchParams.get("code");
	if (!code || url.searchParams.has("error")) throw invalid();
	if (pending.provider === "github") {
		const app = githubApp();
		if (!app) throw unavailable();
		let token: string | undefined;
		try {
			token = await app.exchangeCode(code, pending.verifier, pending.redirect);
			const viewer = await app.viewer(token);
			let email: string | null = null;
			let emailPermissionMissing = false;
			if (readEmail) {
				try { email = normalizeEmail(await app.verifiedPrimaryEmail(token)); }
				catch (error) {
					if (!(error instanceof GithubError) || error.status !== 403) throw error;
					emailPermissionMissing = true;
					console.warn("[wlp] login.github email_status=403");
				}
			}
			return { provider: "github", issuer: pending.issuer, sub: String(viewer.id), email, emailPermissionMissing };
		} catch (error) {
			console.warn(`[wlp] login.github status=${error instanceof GithubError ? error.status : 0}`);
			if (error instanceof GithubError && error.oauthCode === "redirect_uri_mismatch") throw callbackMismatch(pending.redirect);
			throw invalid();
		} finally {
			if (token) await app.forgetUserToken(token);
		}
	}
	const google = googleCredentials();
	if (pending.provider !== "google" || !google) throw unavailable();
	try {
		const response = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
			body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: pending.redirect, code_verifier: pending.verifier, client_id: google.clientId, client_secret: google.clientSecret }),
		});
		if (!response.ok) {
			console.warn(`[wlp] login.google status=${response.status}`);
			throw invalid();
		}
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
		return { provider: "google", issuer: pending.issuer, sub: payload.sub, email };
	} catch (error) {
		if (error instanceof UserError) throw error;
		console.warn("[wlp] login.google code=invalid_response");
		throw invalid();
	}
}
