import { config } from "../config.js";
import { serverSealer } from "../signin/seal.js";
import { slackApp, SlackError, type SlackApp, type SlackInstall } from "./app.js";

export const SLACK_CALLBACK_PATH = "/slack/callback";

export const SLACK_STATE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 5 * 60_000;
interface SlackState { uid: string; nonce: string; origin: string; expiresAt: number }
/** The store keeps the nonce under uid until the callback atomically claims it. */
export function issueSlackState(uid: string, nonce: string, origin: string, now = Date.now()): string {
	const state: SlackState = { uid, nonce, origin, expiresAt: now + SLACK_STATE_TTL_MS };
	return serverSealer().seal("transit", "slack-oauth-state", JSON.stringify(state));
}

export function readSlackState(token: string, now = Date.now()): SlackState | null {
	if (!token || token.length > 8192) return null;
	try {
		const state: SlackState = JSON.parse(serverSealer().open("transit", "slack-oauth-state", token));
		return state.uid && state.nonce && state.origin && Number.isSafeInteger(state.expiresAt) && state.expiresAt > now ? state : null;
	} catch { return null; }
}

export interface SlackConnectStore {
	/** Atomically remove a pending nonce from this account; false if absent or already claimed. */
	claim(uid: string, nonce: string): Promise<boolean>;
}

export interface SlackConnectDeps {
	store: SlackConnectStore;
	app?: Pick<SlackApp, "exchangeCode"> | null;
	origins?: readonly string[];
	/** If specified, must be the same configured URI used when authorizing. */
	redirectUri?: string;
}

const subject = (uid: string) => `slack-connect\n${uid}`;
export interface SlackTicket { nonce: string; expiresAt: number; install: SlackInstall }
export function openSlackTicket(uid: string, ticket: string): SlackTicket {
	const opened: SlackTicket = JSON.parse(serverSealer().open("transit", subject(uid), ticket));
	if (!Number.isSafeInteger(opened.expiresAt) || opened.expiresAt <= Date.now()) throw new Error("Slack connection ticket expired");
	return opened;
}

function back(origin: string, fragment: string) {
	return new Response(null, { status: 302, headers: { location: `${origin}/settings#${fragment}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function slackCallbackResponse(request: Request, deps: SlackConnectDeps): Promise<Response> {
	const app = deps.app === undefined ? slackApp() : deps.app;
	if (!app) return new Response("Not found\n", { status: 404 });
	if (request.method !== "GET") return new Response("Use GET.\n", { status: 405, headers: { allow: "GET" } });
	const origins = deps.origins ?? config.origins;
	const params = new URL(request.url).searchParams;
	const invalid = () => origins[0] ? back(origins[0], "slack-error=state") : new Response("Invalid Slack connection state.\n", { status: 400 });
	const state = readSlackState(params.get("state") ?? "");
	if (!state || !origins.includes(state.origin)) return invalid();
	const { origin, uid, nonce } = state;
	try {
		if (!await deps.store.claim(uid, nonce)) return back(origin, "slack-error=used");
	} catch { return invalid(); }
	if (params.has("error")) return back(origin, `slack-error=${params.get("error") === "access_denied" ? "denied" : "failed"}`);
	const code = params.get("code");
	if (!code || code.length > 2048) return back(origin, "slack-error=code");
	try {
		const install = await app.exchangeCode(code, deps.redirectUri);
		const ticket: SlackTicket = { nonce, expiresAt: Date.now() + TICKET_TTL_MS, install };
		return back(origin, `slack=${serverSealer().seal("transit", subject(uid), JSON.stringify(ticket))}`);
	} catch (error) {
		let reason = "failed";
		if (error instanceof SlackError) {
			if (error.unreachable) reason = "unreachable";
			else if (error.code === "missing_scope") reason = "scope";
			else if (error.code === "not_bot") reason = "not_bot";
			else if (error.code === "invalid_code") reason = "code";
		}
		return back(origin, `slack-error=${reason}`);
	}
}
