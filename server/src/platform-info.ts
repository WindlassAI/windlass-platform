/**
 * The facts of this deployment, cached: asking the sandbox layer can mean starting a container.
 *
 * Served over plain HTTP by every server (`GET /platform/info`, see index.ts), not by an actor: they
 * hold no state, and one actor that every visitor asks first would be a hot spot and a single point
 * of failure. Each server answers from its own cache.
 */

import { UserError } from "rivetkit";
import { assertOrigin } from "./auth.js";
import { config } from "./config.js";
import { PLATFORM_INFO_PATH, type PlatformInfo } from "./contract.js";
import { getLayer } from "./layer.js";

/** The reasoning efforts `windlass --effort` accepts (Windlass's user guide, "Models and effort"). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const FRESH_MS = 5 * 60 * 1000;
/** A missing image or a failed lookup is asked about again sooner. */
const RETRY_MS = 15 * 1000;

interface Slow {
	windlassVersion: string | null;
	models: string[];
	at: number;
	complete: boolean;
}

let cached: Slow | null = null;
let loading: Promise<Slow> | null = null;

async function loadSlow(): Promise<Slow> {
	const layer = await getLayer();
	const [version, models] = await Promise.allSettled([layer.windlass.version(), layer.windlass.models()]);
	const windlassVersion = version.status === "fulfilled" ? version.value : null;
	const list = models.status === "fulfilled" ? models.value.filter((model) => typeof model === "string" && model !== "") : [];
	return { windlassVersion, models: list, at: Date.now(), complete: windlassVersion !== null && list.length > 0 };
}

async function slow(): Promise<Slow> {
	if (cached && Date.now() - cached.at < (cached.complete ? FRESH_MS : RETRY_MS)) return cached;
	if (!loading) {
		loading = loadSlow()
			.then((value) => {
				cached = value;
				return value;
			})
			.finally(() => {
				loading = null;
			});
	}
	return loading;
}

/** The models a session may use, the default first. */
export async function platformModels(): Promise<string[]> {
	return (await slow()).models;
}

export async function platformInfo(): Promise<PlatformInfo> {
	const layer = await getLayer();
	const { windlassVersion, models } = await slow();
	return {
		demoEnabled: config.demo,
		windlassVersion,
		profiles: layer.sandboxes.profiles(),
		models,
		efforts: EFFORTS,
	};
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

/**
 * `GET /platform/info`. The origin check is the one the actors make (`assertOrigin`): a browser on
 * another site is refused, and a client that sends no origin is let through. An allowed browser gets
 * the CORS header it needs to read the answer. Errors have the shape of RivetKit's (`group`, `code`,
 * `message`), so the web app reads them the same way.
 */
export async function platformInfoResponse(request: Request): Promise<Response> {
	const origin = request.headers.get("origin");
	const cors: Record<string, string> = { vary: "Origin" };
	try {
		assertOrigin({ request });
	} catch (error) {
		const message = error instanceof UserError ? error.message : "This origin is not allowed to connect.";
		return json(403, { group: "user", code: "origin_not_allowed", message }, cors);
	}
	if (origin) cors["access-control-allow-origin"] = origin;
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "600" } });
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json(405, { group: "user", code: "method_not_allowed", message: `Use GET for ${PLATFORM_INFO_PATH}.` }, { ...cors, allow: "GET" });
	}
	try {
		return json(200, await platformInfo(), cors);
	} catch (error) {
		console.error("[wlp] the platform's information could not be read:", error);
		return json(500, { group: "rivetkit", code: "internal_error", message: "The platform's information could not be read." }, cors);
	}
}
