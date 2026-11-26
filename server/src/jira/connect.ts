import { config } from "../config.js";
import { JIRA_SCOPES, jiraApp, type JiraApp } from "./app.js";

export const JIRA_CALLBACK_PATH = "/jira/callback";

export type JiraClaim = { uid: string; origin: string; nonce: string };
export interface JiraConnectStore {
	/** Atomically consume a live, owner-bound state. Null for invalid, used or expired states. */
	claim(state: string): Promise<JiraClaim | null>;
	/** Keep the grant on the server pending site selection. Seal tokens before persisting them. */
	complete(claim: JiraClaim, token: Awaited<ReturnType<JiraApp["exchangeCode"]>>, sites: Awaited<ReturnType<JiraApp["sites"]>>): Promise<void>;
}

export async function jiraCallbackResponse(request: Request, deps: { store: JiraConnectStore; app?: JiraApp | null; origins?: string[] }): Promise<Response> {
	const app = deps.app === undefined ? jiraApp() : deps.app;
	if (!app) return new Response("Not found\n", { status: 404 });
	if (request.method !== "GET") return new Response("Use GET.\n", { status: 405, headers: { allow: "GET" } });
	const params = new URL(request.url).searchParams;
	const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
	const invalid = () => new Response("Invalid or expired Jira connection. Connect again in Settings.\n", { status: 400, headers });
	const state = params.get("state");
	if (!state || state.length > 8192) return invalid();
	let claim: JiraClaim | null;
	try {
		claim = await deps.store.claim(state);
	} catch {
		return new Response("Jira connection unavailable.\n", { status: 503, headers });
	}
	if (!claim || !(deps.origins ?? config.origins).includes(claim.origin)) return invalid();
	const back = (fragment: string) => new Response(null, { status: 302, headers: { ...headers, location: `${claim.origin}/settings#${fragment}` } });
	if (params.has("error")) return back(params.get("error") === "access_denied" ? "jira-error=denied" : "jira-error=failed");
	const code = params.get("code");
	if (!code || code.length > 4096) return back("jira-error=code");
	try {
		const token = await app.exchangeCode(code);
		if (!token.refreshToken) return back("jira-error=scope");
		const required = JIRA_SCOPES.filter(scope => scope !== "offline_access");
		const sites = (await app.sites(token.accessToken)).filter(site => required.every(scope => site.scopes.includes(scope)));
		if (!sites.length) return back("jira-error=sites");
		await deps.store.complete(claim, token, sites);
		return back("jira=select-site");
	} catch {
		// Provider and storage errors may contain credentials. Only send a fixed reason.
		return back("jira-error=failed");
	}
}
