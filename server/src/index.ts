/**
 * The server: `registry.start()` serves the Rivet endpoint at http://127.0.0.1:6420 with the local
 * engine. See config.ts for the environment variables.
 */

import { config } from "./config.js";
import { getLayer } from "./layer.js";
import { registry } from "./registry.js";

process.on("unhandledRejection", (reason) => {
	console.error("[wlp] unhandled promise rejection:", reason);
});

try {
	await getLayer();
} catch (error) {
	console.error(`[wlp] the ${config.sandbox} sandbox layer could not be loaded:`, error);
	console.error("[wlp] start with WLP_SANDBOX=fake to run without it.");
	process.exit(1);
}

console.log(`[wlp] sandbox layer: ${config.sandbox}; demo sign-in: ${config.demo ? "on" : "off"}; web origins: ${config.origins.join(", ")}`);
console.log(`[wlp] actor data: ${config.storagePath}/.rivetkit`);

registry.start();
