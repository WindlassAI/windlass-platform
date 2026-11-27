/**
 * `POST /platform/connect`: the connect command hands a plan's token to the user whose one-time code it
 * carries (credentials/connect-code.ts). The code is the only authorization, so it is taken on first use;
 * a body that is not a token at all is refused before that, so a typo does not cost the code.
 */

import { createClient } from "rivetkit/client";
import { isActorGone, planConnectActor } from "./actors/internal.js";
import { assertOrigin, serviceParams } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import { isPlanProvider, validPlanToken } from "./contract.js";
import { connectCodeDigest, connectTransitSubject } from "./credentials/connect-code.js";
import { AddressBudget, clientAddress, rateLimited, readJsonBody } from "./http-limits.js";
import type { Registry } from "./registry.js";
import { serverSealer } from "./signin/seal.js";

export const CONNECT_PATH = "/platform/connect";

const budget = new AddressBudget(config.httpLimits.connect);
const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

let client: ReturnType<typeof createClient<Registry>> | undefined;
const engine = () => (client ??= createClient<Registry>({ endpoint: ownEngineEndpoint() }));

export async function connectResponse(request: Request): Promise<Response> {
	if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
	try {
		assertOrigin({ request });
	} catch {
		return json(403, { code: "origin_not_allowed" });
	}
	const admission = budget.take(clientAddress(request));
	if (admission) return rateLimited(admission, "Too many connect attempts from this address. Try again later.");
	const body = await readJsonBody(request, 4096);
	if (body instanceof Response) return body;
	const input = body.value as { code?: unknown; provider?: unknown; token?: unknown } | null;
	const digest = connectCodeDigest.of(input?.code);
	if (!digest || !isPlanProvider(input?.provider)) return json(400, { code: "bad_input" });
	const provider = input.provider;
	if (!validPlanToken(provider, input.token))
		return json(400, { code: "bad_plan_token", message: "That's not a setup token. It starts with sk-ant-oat01-." });
	const token = input.token;
	try {
		const owner = await engine()
			.connectCodes.getOrCreate(["codes"], { params: serviceParams() })
			.internalRedeem(digest);
		if (!owner || owner.provider !== provider)
			return json(404, {
				code: "connect_code_not_found",
				message: "That code expired or was already used. Copy a new command from the page.",
			});
		const sealed = serverSealer().seal("transit", connectTransitSubject(owner.uid, provider, digest), token);
		const plan = await planConnectActor({ client: engine }, owner.uid).internalConnectPlan(provider, digest, sealed);
		return json(200, { account: plan.account });
	} catch (error) {
		const refused = error as { code?: unknown; message?: unknown } | null;
		if (
			typeof refused?.code === "string" &&
			/^(bad_plan_token|plan_refused|plan_check_unavailable|plans_off)$/.test(refused.code)
		)
			return json(refused.code === "plan_check_unavailable" ? 503 : 400, {
				code: refused.code,
				message: String(refused.message),
			});
		if (isActorGone(error)) return json(404, { code: "connect_code_not_found" });
		console.error(`[wlp] plan_connect.failed (${error instanceof Error ? error.name : "unknown"})`);
		return json(500, { code: "internal_error", message: "The plan could not be connected. Try again." });
	}
}
