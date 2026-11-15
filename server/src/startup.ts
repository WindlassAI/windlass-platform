/** What the server says when it starts about a sandbox layer that cannot do all it should. */

import type { SandboxLayer } from "./sandbox/api.js";

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
