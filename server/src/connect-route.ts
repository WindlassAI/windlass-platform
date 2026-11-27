/**
 * The connect command's HTTP routes (`CONNECT_PATHS`), `gh auth login`-style and without signing in:
 * `start` opens a request and answers the code the terminal shows; the user approves that code on the web
 * page (credentials/index.ts `approvePlanConnect`); the terminal polls `poll`, and only once approved runs
 * `claude setup-token` and posts the token to `connect`, which takes the approved request once and hands the
 * token, sealed, to the approving user's actor. A body that is not a token at all is refused before the
 * request is taken, so a typo does not cost it.
 */

import { createClient } from "rivetkit/client";
import { isActorGone, planConnectActor } from "./actors/internal.js";
import { assertOrigin, serviceParams } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import {
	CONNECT_PATHS,
	type ConnectRequestState,
	type ConnectStart,
	isPlanProvider,
	PLAN_PROVIDERS,
	type PlanProvider,
	validPlanToken,
} from "./contract.js";
import { connectCodeDigest, connectTransitSubject, newConnectRequest } from "./credentials/connect-code.js";
import { AddressBudget, clientAddress, rateLimited, readJsonBody } from "./http-limits.js";
import type { Registry } from "./registry.js";
import { serverSealer } from "./signin/seal.js";

export const CONNECT_ROUTE_PATHS: readonly string[] = Object.values(CONNECT_PATHS);
/** How often the terminal polls, like a runner's pairing poll. */
const POLL_INTERVAL_MS = 2_000;
const REFUSALS = /^(bad_plan_token|plan_refused|plan_check_unavailable|plans_off)$/;

const budget = new AddressBudget(config.httpLimits.connect);
const polls = new AddressBudget(config.httpLimits.connectPoll);
const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
const expired = () =>
	json(404, {
		code: "connect_code_not_found",
		message: "This connect request expired or was already used. Run the command again.",
	});

type Engine = () => ReturnType<typeof createClient<Registry>>;
let client: ReturnType<Engine> | undefined;
const ownEngine: Engine = () => (client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() }));
const requests = (engine: Engine) => engine().connectCodes.getOrCreate(["codes"], { params: serviceParams() });

const plansOff = () => config.plans !== "all" && config.plans.size === 0;

/** `engine` is the actor client; checks pass a stand-in. */
export async function connectResponse(request: Request, engine: Engine = ownEngine): Promise<Response> {
	if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
	try {
		assertOrigin({ request });
	} catch {
		return json(403, { code: "origin_not_allowed" });
	}
	const { pathname } = new URL(request.url);
	const admission = (pathname === CONNECT_PATHS.poll ? polls : budget).take(clientAddress(request));
	if (admission) return rateLimited(admission, "Too many connect attempts from this address. Try again later.");
	const body = await readJsonBody(request, 4096);
	if (body instanceof Response) return body;
	const input = body.value as { provider?: unknown; request?: unknown; token?: unknown } | null;
	try {
		if (pathname === CONNECT_PATHS.start) return await start(engine, input?.provider);
		const digest = connectCodeDigest.ofRequest(input?.request);
		if (!digest) return json(400, { code: "bad_input" });
		if (pathname === CONNECT_PATHS.poll) {
			const state: ConnectRequestState = await requests(engine).internalPoll(digest);
			return json(200, { state });
		}
		return await connect(engine, digest, input?.token);
	} catch (error) {
		const refused = error as { code?: unknown; message?: unknown } | null;
		if (typeof refused?.code === "string" && REFUSALS.test(refused.code))
			return json(refused.code === "plan_check_unavailable" ? 503 : 400, {
				code: refused.code,
				message: String(refused.message),
			});
		if (isActorGone(error)) return expired();
		console.error(`[wlp] plan_connect.failed (${error instanceof Error ? error.name : "unknown"})`);
		return json(500, { code: "internal_error", message: "The plan could not be connected. Try again." });
	}
}

async function start(engine: Engine, provider: unknown): Promise<Response> {
	if (!isPlanProvider(provider)) return json(400, { code: "bad_input" });
	if (plansOff())
		return json(404, { code: "plans_off", message: "Connecting a plan is not available on this platform." });
	const opened = newConnectRequest();
	const expiresAt: number | null = await requests(engine).internalStart(
		connectCodeDigest.ofRequest(opened.request)!,
		connectCodeDigest.ofUserCode(opened.userCode)!,
		provider,
	);
	if (expiresAt === null)
		return rateLimited(60, "Too many connect requests are open. Try again in a minute.", "too_many_connects");
	const approveUrl = `${config.origins[0]}/connect?${new URLSearchParams({ code: opened.userCode })}`;
	const answer: ConnectStart = { ...opened, approveUrl, expiresAt, interval: POLL_INTERVAL_MS };
	return json(201, answer);
}

async function connect(engine: Engine, digest: string, token: unknown): Promise<Response> {
	if (!PLAN_PROVIDERS.some(provider => validPlanToken(provider, token)))
		return json(400, { code: "bad_plan_token", message: "That's not a setup token. It starts with sk-ant-oat01-." });
	const owner: { uid: string; provider: PlanProvider } | null = await requests(engine).internalTake(digest);
	if (!owner) return expired();
	if (!validPlanToken(owner.provider, token))
		return json(400, { code: "bad_plan_token", message: "That token is not for this plan." });
	const sealed = serverSealer().seal("transit", connectTransitSubject(owner.uid, owner.provider, digest), token);
	const plan = await planConnectActor({ client: engine }, owner.uid).internalConnectPlan(
		owner.provider,
		digest,
		sealed,
	);
	return json(200, { account: plan.account });
}
