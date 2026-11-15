/**
 * Lists the sandboxes a deployment has at E2B, running and paused, and with --kill removes them. For
 * when the servers are gone, or the credit matters more than the sessions: a killed sandbox takes its
 * session's files and its Windlass session with it (the timeline in the actor stays).
 *
 *   cd server && E2B_API_KEY=... npx tsx ../scripts/e2b-cleanup.ts                      a dry run: lists, changes nothing
 *   cd server && E2B_API_KEY=... npx tsx ../scripts/e2b-cleanup.ts --kill               removes them
 *   ... --deployment <label>                                                           another deployment than WLP_E2B_DEPLOYMENT
 *                                                                                      (default "default"); scripts/e2b-check.ts
 *                                                                                      prints the label of its own
 *
 * Only sandboxes whose metadata carries the deployment's mark (`wlp_deployment`) are listed or killed:
 * nothing else on the account is touched. Each line says what a running sandbox has cost at most in its
 * current stretch, by E2B's published prices: an estimate. Listing is a few requests and costs nothing.
 *
 * Exit code 0 when everything that was to be killed was; 1 when something could not be; 2 without a key.
 */

import { cleanupDeployment } from "../server/src/sandbox/e2b/cleanup.js";
import { readE2bSettings } from "../server/src/sandbox/e2b/config.js";

const args = process.argv.slice(2);
const kill = args.includes("--kill");
const named = args.indexOf("--deployment");

async function main(): Promise<number> {
	const apiKey = (process.env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") {
		console.error("e2b-cleanup: E2B_API_KEY is not set. It needs the API key of the E2B account the deployment runs on.");
		return 2;
	}
	const deployment = named === -1 ? readE2bSettings().deployment : (args[named + 1] ?? "");
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deployment)) {
		console.error('e2b-cleanup: --deployment needs a label: 1 to 64 letters, digits, "_" or "-"');
		return 2;
	}
	// Loaded here and not before: without a key E2B's SDK is not needed.
	const { createE2bSdkClient } = await import("../server/src/sandbox/e2b/sdk.js");
	const report = await cleanupDeployment(createE2bSdkClient(apiKey), deployment, { kill });
	for (const line of report.lines) console.log(line);
	return report.failed.length === 0 ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(`e2b-cleanup: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
