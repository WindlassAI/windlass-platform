/** What the server says when it starts: a configuration it refuses, and a sandbox layer that cannot do all it should. */

import type { Config } from "./config.js";
import type { SandboxLayer } from "./sandbox/api.js";
import type { SignIns } from "./signin/index.js";

/**
 * The one sentence the server stops with when it must not start, or null. With a remote engine the
 * server is one of several, and a token one of them signs must be accepted by all the others: a
 * secret each would make up for itself, or keep in its own `.data/secret`, would not be.
 */
export function startupProblem(config: Pick<Config, "engine" | "secretConfigured">): string | null {
	if (config.engine.remote && !config.secretConfigured) {
		return "[wlp] WLP_SECRET is not set: with a remote Rivet engine (RIVET_ENDPOINT) every server must sign tokens with the same secret, so set WLP_SECRET to one value of at least 16 characters on all of them.";
	}
	return null;
}

/**
 * Prints `[wlp] WARNING: ...` when the sandbox image is missing or its Windlass is too old to hand a
 * session an access token (`Windlass.problem()`): it has no `windlass login token`, or that command
 * has no `--valid-for`, which the platform asks for every token with. The line says which and what to
 * do about it. The server starts all the same: demo turns need no sign-in. Every other turn would fail,
 * and says the same when it does.
 * Returns what it printed, or null.
 */
export async function warnAboutWindlass(layer: Pick<SandboxLayer, "windlass">, print: (line: string) => void = (line) => console.error(line)): Promise<string | null> {
	const problem = await layer.windlass.problem().catch((error: unknown) => `The sandbox image could not be checked: ${error instanceof Error ? error.message : String(error)}`);
	if (problem === null) return null;
	const line = `[wlp] WARNING: ${problem}`;
	print(line);
	return line;
}

/**
 * Says where this server runs Windlass's sign-in commands (signin/index.ts), and prints
 * `[wlp] WARNING: ...` when it cannot run them there: the Windlass named by WLP_WINDLASS_BIN is missing
 * or too old. `warn` is false where the sandbox layer says that itself (the E2B layer's
 * `Windlass.problem()` is this same check), so it is said once. Returns the warning, or null.
 */
export async function reportSignIns(signIns: () => Promise<Pick<SignIns, "describe" | "check">>, warn: boolean, print: (line: string) => void = (line) => console.error(line)): Promise<string | null> {
	let problem: string | null;
	try {
		const found = await signIns();
		console.log(`[wlp] sign-in commands run in ${found.describe}`);
		problem = warn ? await found.check() : null;
	} catch (error) {
		problem = error instanceof Error ? error.message : String(error);
	}
	if (problem === null) return null;
	const line = `[wlp] WARNING: ${problem}`;
	print(line);
	return line;
}
