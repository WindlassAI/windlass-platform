/**
 * Connecting Linear: the route Linear sends the owner's browser back to, `GET /linear/callback`, on any
 * server's own HTTP port. It is the OAuth app's callback URL (WLP_LINEAR_REDIRECT_URL).
 *
 *   1. The web app asks the user's actor to begin. The actor makes a signed state naming the user and
 *      the web app's origin, keeps a PKCE verifier, and answers with `LinearApp.authorizeUrl`.
 *   2. The owner authorizes the app at Linear as the app's own user (`actor=app`, `app:assignable`),
 *      and Linear sends the browser here with `code` and `state`.
 *   3. This route has the store check the state and take it out of the user's list (so it works once),
 *      exchanges the code, and asks Linear who the token is, which workspace it is in, and which teams
 *      it reaches. The token must be the app user's (`LinearApp.identity`), and must have been
 *      granted `app:assignable`.
 *   4. The store keeps the connection, the token among it. Nothing secret goes back to the browser:
 *      it is sent to the web app with `#linear=connected`, or with `#linear-error=<code>`.
 *
 * The human who authorized is not established: the app's token cannot say who they are. The connection
 * is for the platform user the state names, and authorship of issues stays untrusted.
 *
 * What the route needs of the actors is `LinearConnectStore`; the server's own is made where the actors
 * are wired, and the checks use one in memory.
 */

import { config } from "../config.js";
import { LINEAR_SCOPES, LinearApp, LinearError, type LinearIdentity, type LinearTeam, type LinearToken, linearApp, redactLinear } from "./app.js";

export const LINEAR_CALLBACK_PATH = "/linear/callback";

/** Why a connection did not come about: what the web app is sent back with, and turns into a sentence. */
export type LinearConnectFailure =
	/** The state is missing, forged or expired. */
	| "state"
	/** The state was used before. */
	| "used"
	/** The owner declined at Linear. */
	| "denied"
	/** Linear did not accept the code. */
	| "code"
	/** Linear did not grant what the app needs: being assignable. */
	| "scope"
	/** The token Linear gave is a person's, not the app user's. */
	| "not_app"
	/** Linear could not be reached. */
	| "unreachable"
	| "failed";

/** What Linear confirmed. The token is a secret: only the store sees it, and it never reaches a browser or a log. */
export interface LinearConnection {
	token: LinearToken;
	identity: LinearIdentity;
	teams: LinearTeam[];
}

export type LinearClaim =
	| { ok: true; uid: string; origin: string; verifier: string | null }
	| { ok: false; reason: "state" | "used"; /** The web app's address, when the state was readable enough to name one. */ origin: string | null };

/** What the route needs of the user's actor. */
export interface LinearConnectStore {
	/** Checks the signed state and takes its number out of the user's list; it works once. */
	claim(state: string): Promise<LinearClaim>;
	/** Records the connection for the user the claimed state named. */
	complete(uid: string, connection: LinearConnection): Promise<void>;
}

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** Back to the web app, with what happened in the fragment: it is not sent to any server, and not kept in a log. */
const back = (origin: string, fragment: string) => redirect(`${origin}/#${fragment}`);
const failed = (origin: string, code: LinearConnectFailure) => back(origin, `linear-error=${code}`);

export interface LinearConnectDeps {
	store: LinearConnectStore;
	app?: LinearApp | null;
	origins?: string[];
	log?: (line: string) => void;
}

/** `GET /linear/callback`. Always answers with a redirect to the web app; without a Linear app the route does not exist. */
export async function linearCallbackResponse(request: Request, deps: LinearConnectDeps): Promise<Response> {
	const app = deps.app === undefined ? linearApp() : deps.app;
	const origins = deps.origins ?? config.origins;
	const log = deps.log ?? ((line: string) => console.log(line));
	if (!app) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET.\n", { status: 405, headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" } });

	const params = new URL(request.url).searchParams;
	const home = origins[0] ?? "";
	const unreadable = () => home === ""
		? new Response("This link to connect Linear is not valid any more. Go back to Windlass and connect again.\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } })
		: failed(home, "state");
	const state = params.get("state");
	if (state === null || state === "" || state.length > 8192) return unreadable();

	let claimed: LinearClaim;
	try {
		claimed = await deps.store.claim(state);
	} catch (error) {
		console.error(`[wlp] linear.connect.failed: ${redactLinear(error instanceof Error ? error.message : "unknown error")}`);
		return unreadable();
	}
	if (!claimed.ok) {
		const origin = claimed.origin !== null && origins.includes(claimed.origin) ? claimed.origin : home;
		return origin === "" ? unreadable() : failed(origin, claimed.reason);
	}
	if (!origins.includes(claimed.origin)) return unreadable();
	const { uid, origin } = claimed;

	let token: LinearToken | null = null;
	try {
		if (params.get("error") !== null) return failed(origin, params.get("error") === "access_denied" ? "denied" : "failed");
		const code = params.get("code");
		if (code === null || code === "" || code.length > 2048) return failed(origin, "code");

		try {
			token = await app.exchangeCode(code, claimed.verifier);
		} catch (error) {
			if (error instanceof LinearError && !error.unreachable) {
				log(`[wlp] linear.connect.refused uid=${uid}: ${error.message}`);
				return failed(origin, "code");
			}
			throw error;
		}
		const missing = LINEAR_SCOPES.filter((scope) => !token!.scopes.includes(scope));
		if (missing.length > 0) {
			log(`[wlp] linear.connect.scope uid=${uid}: not granted: ${missing.join(",")}`);
			return failed(origin, "scope");
		}

		let identity: LinearIdentity;
		try {
			identity = await app.identity(token.accessToken);
		} catch (error) {
			if (error instanceof LinearError && error.code === "not_app_user") {
				log(`[wlp] linear.connect.not_app uid=${uid}`);
				return failed(origin, "not_app");
			}
			throw error;
		}
		const teams = await app.teams(token.accessToken);
		await deps.store.complete(uid, { token, identity, teams });
		log(`[wlp] linear.connect.confirmed uid=${uid} workspace=${identity.workspace.id} teams=${teams.length}`);
		return back(origin, "linear=connected");
	} catch (error) {
		const unreachable = error instanceof LinearError && error.unreachable;
		console.error(`[wlp] linear.connect.failed uid=${uid}: ${redactLinear(error instanceof Error ? error.message : "unknown error", [token?.accessToken, token?.refreshToken])}`);
		return failed(origin, unreachable ? "unreachable" : "failed");
	}
}
