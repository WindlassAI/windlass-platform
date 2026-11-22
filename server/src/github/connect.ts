/**
 * Connecting GitHub: the route GitHub sends a user's browser back to, `GET /github/callback`, on any
 * server's own HTTP port. It is the app's "Callback URL".
 *
 * How a connection goes:
 *
 *   1. The web app asks the user's `user` actor to begin (`user.githubConnect`). The actor makes a state
 *      for that user (state.ts) and a PKCE verifier, keeps both, and answers with GitHub's authorization
 *      address: `<github>/login/oauth/authorize?client_id&state&code_challenge`.
 *   2. The user authorizes the app at GitHub, which sends the browser here with `code` and `state`.
 *   3. This route checks the state, has the user's actor take it out of its list (so it works once),
 *      exchanges the code for a user access token, and asks GitHub two things with it: who this is, and
 *      which installations of the app they can reach. A successful ticket carries a grant sealed for this user.
 *   4. With no installation yet, the browser goes on to the app's installation page with a new state.
 *      The app asks for the user's authorization during installation, so GitHub sends the browser here
 *      again afterwards, with a `code`, the `state` and an `installation_id`; step 3 runs again, and the
 *      installation it names must be among those GitHub lists for this user.
 *   5. The browser is sent back to the web app with a ticket in the address's fragment
 *      (`#github=<ticket>`), which the web app hands to the user's actor (`user.githubComplete`), and
 *      that is what records the connection. With a failure it is sent back with `#github-error=<code>`.
 *
 * Step 1 is the authorization and not the installation page, because a browser sent to the
 * installation page of an account that has the app already ends on that installation's settings and is
 * never sent back: a second user of an organization, or anyone connecting again, would be stuck there.
 *
 * An `installation_id` in the address proves nothing: anyone can type one. GitHub says so itself
 * (https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url),
 * and what it says to do instead is what step 3 does. Nothing is recorded from the address: only what
 * GitHub answered for the user who authorized.
 *
 * Nothing here is kept on the server: the state's number is in the user's actor, and the ticket carries
 * the rest, so the two visits of one connection can be served by different servers.
 */

import { createClient } from "rivetkit/client";
import { isActorGone } from "../actors/internal.js";
import { serviceParams } from "../auth.js";
import { config, ownEngineEndpoint } from "../config.js";
import { GithubApp, GithubError, githubApp, type GithubUserGrant } from "./app.js";
import { activeInstallations, issueTicket, sealGithubGrant, verifyState } from "./state.js";

export const GITHUB_CALLBACK_PATH = "/github/callback";

/** Why a connection did not come about: what the web app is sent back with, and turns into a sentence. */
export type ConnectFailure =
	/** The state is missing, forged or expired. */
	| "state"
	/** The state was used before. */
	| "used"
	/** The user declined at GitHub. */
	| "denied"
	/** GitHub did not accept the code. */
	| "code"
	/** The installation the address names is not one GitHub lists for this user. */
	| "not_yours"
	/** The app is not installed: the installation waits on an owner's approval, or was not finished. */
	| "pending"
	/** GitHub could not be reached. */
	| "unreachable"
	| "failed";

/** What the route needs of the user's actor. The server's own asks the actor; the checks have one in memory. */
export interface ConnectStore {
	/** Takes the state's number out of the user's list. `ok` is false when it is not there (any more). */
	claim(uid: string, nonce: string): Promise<{ ok: boolean; verifier: string | null }>;
	/** A new state for the same user, for the visit to the installation page. */
	next(uid: string, origin: string): Promise<string>;
}

interface UserGithubActions {
	internalGithubClaim(nonce: string): Promise<{ ok: boolean; verifier: string | null }>;
	internalGithubState(origin: string): Promise<{ state: string }>;
}

let client: { user: { get(key: string[], options: { params: unknown }): unknown } } | null = null;

/** The user's actor, through a client of this server's own engine, as signin/directory.ts reaches it. */
function userActor(uid: string): UserGithubActions {
	client ??= createClient({ endpoint: ownEngineEndpoint() }) as unknown as NonNullable<typeof client>;
	return client.user.get([uid], { params: serviceParams() }) as UserGithubActions;
}

export const actorConnectStore: ConnectStore = {
	async claim(uid, nonce) {
		try {
			return await userActor(uid).internalGithubClaim(nonce);
		} catch (error) {
			// A user whose actor is gone started nothing.
			if (isActorGone(error)) return { ok: false, verifier: null };
			throw error;
		}
	},
	async next(uid, origin) {
		return (await userActor(uid).internalGithubState(origin)).state;
	},
};

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** Back to the web app, with what happened in the fragment: it is not sent to any server, and not kept in a log. */
function back(origin: string, fragment: string): Response {
	return redirect(`${origin}/#${fragment}`);
}

const failed = (origin: string, code: ConnectFailure) => back(origin, `github-error=${code}`);

export interface ConnectDeps {
	app: GithubApp | null;
	store: ConnectStore;
	origins: string[];
	log?: (line: string) => void;
}

/**
 * `GET /github/callback`. Always answers with a redirect: to the web app, or to GitHub's installation
 * page. Without a GitHub App the route does not exist.
 */
export async function githubCallbackResponse(request: Request, deps: ConnectDeps = { app: githubApp(), store: actorConnectStore, origins: config.origins }): Promise<Response> {
	const { app, store, origins } = deps;
	const log = deps.log ?? ((line: string) => console.log(line));
	if (!app) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET.\n", { status: 405, headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" } });

	const params = new URL(request.url).searchParams;
	// A state that cannot be read names no address to go back to: the web app's own is the one there is.
	const home = origins[0] ?? "";
	const state = verifyState(params.get("state"));
	if (!state || !origins.includes(state.origin)) {
		if (home === "") return new Response("This link to connect GitHub is not valid any more. Go back to Windlass and connect again.\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
		return failed(home, "state");
	}
	const { uid, origin } = state;

	try {
		const claimed = await store.claim(uid, state.nonce);
		if (!claimed.ok) return failed(origin, "used");

		if (params.get("error") !== null) return failed(origin, params.get("error") === "access_denied" ? "denied" : "failed");
		const code = params.get("code");
		// A request to install that an organization's owner has yet to approve comes back without a code.
		if (code === null || code === "") return failed(origin, params.get("setup_action") === "request" ? "pending" : "code");

		let grant: GithubUserGrant;
		try {
			grant = await app.exchangeCode(code, claimed.verifier);
		} catch (error) {
			if (error instanceof GithubError && !error.unreachable) {
				log(`[wlp] github.connect.refused uid=${uid}: ${error.message}`);
				return failed(origin, "code");
			}
			throw error;
		}

		let issued = false;
		try {
			const [user, installations] = await Promise.all([app.viewer(grant.accessToken), app.userInstallations(grant.accessToken)]);
			const confirmed = { user, installations: activeInstallations(installations) };
			const named = params.get("installation_id");
			if (named !== null && !confirmed.installations.some((installation) => String(installation.id) === named)) {
				log(`[wlp] github.connect.not_theirs uid=${uid} github=${confirmed.user.login} installation=${named.slice(0, 20).replace(/[^0-9]/g, "?")}`);
				return failed(origin, "not_yours");
			}
			if (confirmed.installations.length === 0) {
				// Back from the installation page with nothing installed: it was not finished, or waits on an owner.
				if (params.get("setup_action") !== null || named !== null) return failed(origin, "pending");
				return redirect(app.installUrl(await store.next(uid, origin)));
			}
			log(`[wlp] github.connect.confirmed uid=${uid} github=${confirmed.user.login} installations=${confirmed.installations.map((installation) => installation.id).join(",")}`);
			const ticket = issueTicket(uid, { ...confirmed, sealedGrant: sealGithubGrant(uid, user.id, grant) });
			issued = true;
			return back(origin, `github=${ticket}`);
		} finally {
			if (!issued) await app.forgetUserToken(grant.accessToken);
		}
	} catch (error) {
		const unreachable = error instanceof GithubError && error.unreachable;
		console.error(`[wlp] github.connect.failed uid=${uid}: ${error instanceof Error ? error.message : "unknown error"}`);
		return failed(origin, unreachable ? "unreachable" : "failed");
	}
}
