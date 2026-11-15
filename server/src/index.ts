/**
 * The server: one Rivet node, and the platform's own HTTP routes beside it.
 *
 * `registry.listen({ application })` (RivetKit 3.1.1, registry/index.ts) starts the node as
 * `registry.start()` does, waits until it has registered with the engine, and then serves every HTTP
 * request on its own port with the application's `fetch`. Actor traffic does not come through that
 * port: browsers reach actors through the engine's gateway, and the node keeps an outbound connection
 * to the engine. What a browser needs for that, the engine's address and a token, it asks this port
 * for (`/platform/connection`, platform-info.ts). Without RIVET_ENDPOINT RivetKit starts a local
 * engine on http://127.0.0.1:6420; with it this server joins that engine as one node among several.
 * See config.ts for the variables.
 */

import { config } from "./config.js";
import { PLATFORM_CONNECTION_PATH, PLATFORM_INFO_PATH } from "./contract.js";
import { getLayer } from "./layer.js";
import { connectionTokens, platformConnectionResponse, platformInfoResponse } from "./platform-info.js";
import { webFiles } from "./web.js";
import { registry } from "./registry.js";
import type { SandboxLayer } from "./sandbox/api.js";
import { getSignIns } from "./signin/index.js";
import { reportSignIns, startupProblem, warnAboutConnectionTokens, warnAboutWindlass } from "./startup.js";

process.on("unhandledRejection", (reason) => {
	console.error("[wlp] unhandled promise rejection:", reason);
});

const problem = startupProblem(config);
if (problem) {
	console.error(problem);
	process.exit(1);
}

let layer: SandboxLayer;
try {
	layer = await getLayer();
} catch (error) {
	console.error(`[wlp] the ${config.sandbox} sandbox layer could not be loaded:`, error);
	console.error("[wlp] start with WLP_SANDBOX=fake to run without it.");
	process.exit(1);
}

console.log(`[wlp] sandbox layer: ${config.sandbox}; demo sign-in: ${config.demo ? "on" : "off"}; web origins: ${config.origins.join(", ")}`);
if (config.engine.remote) {
	console.log(`[wlp] engine: ${config.engine.endpoint}, namespace ${config.engine.namespace}, pool ${config.engine.pool}; actor data is kept there`);
} else {
	console.log(`[wlp] engine: local; actor data: ${config.storagePath}/.rivetkit`);
}
console.log(`[wlp] http: ${PLATFORM_INFO_PATH}, ${PLATFORM_CONNECTION_PATH} and /health on http://${config.httpHost}:${config.httpPort}`);
if (config.browsers.tokens) {
	console.log(`[wlp] browsers: ${config.browsers.endpoint}, namespace ${config.engine.namespace}, with tokens this server issues, each for ${Math.round(config.browsers.tokenTtlMs / 60_000)} minutes`);
} else {
	console.log(`[wlp] browsers: ${config.browsers.endpoint ?? "the endpoint the web app was built with"}, with no token (RIVET_ADMIN_TOKEN is not set)`);
}
// A sandbox image without Windlass, or with one too old to hand a session an access token: said now, not at the first turn.
void warnAboutWindlass(layer);
void reportSignIns(getSignIns, config.sandbox !== "e2b");
// An admin token the engine refuses: said now, not to the first visitor.
void warnAboutConnectionTokens(connectionTokens());

// The web app, where this server serves it too (WLP_WEB_DIR): its files, and its page for every address of the app.
const web = config.webDir ? webFiles(config.webDir) : null;
if (config.webDir) console.log(`[wlp] web app: served from ${config.webDir}`);

async function route(request: Request): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === PLATFORM_INFO_PATH) return platformInfoResponse(request);
	if (pathname === PLATFORM_CONNECTION_PATH) return platformConnectionResponse(request);
	// For a load balancer or the host's health check: the node's own view of its connection to the engine.
	if (pathname === "/health") return registry.routes.health();
	const page = web ? await web(request) : null;
	if (page) return page;
	return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

registry.listen({ port: config.httpPort, host: config.httpHost, application: { fetch: route } }).catch((error: unknown) => {
	console.error("[wlp] the server could not start:", error instanceof Error ? error.message : error);
	process.exit(1);
});
