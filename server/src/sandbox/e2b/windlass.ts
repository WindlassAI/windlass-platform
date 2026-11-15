/**
 * Windlass in the E2B sandboxes. The turn itself is turn.ts, which knows no provider; a turn's process
 * is, on this provider, the command
 *
 *   wlp-run exec <tag> windlass acp
 *
 * started through E2B's command API in /workspace as the user `agent`, with its standard input kept
 * open and WINDLASS_WAKE, WINDLASS_ACP_LOG and WINDLASS_ACP_SCRIPT or WINDLASS_ACCESS_TOKEN_FILE in the
 * command's environment (e2b/sandboxes.ts, `E2bSandboxHandle.start`). The access token file is written
 * with the same script as on Docker, the token on the command's standard input.
 *
 * What is E2B's here is what cannot be seen from a sandbox:
 *
 *   the version   of the Windlass in the template. Asking E2B would mean starting a sandbox, so it is
 *                 what the first sandbox this server made reported, or WLP_E2B_WINDLASS_VERSION; null
 *                 until one of them is known.
 *   the problem   The template's Windlass is checked per sandbox, as on Docker (does it read a handed-in
 *                 token at all). What fetches the tokens is not in a sandbox and not this provider's:
 *                 the sign-in code runs it (server/src/signin/), and says so itself when it is too old,
 *                 at the moment a turn asks for a token (`WindlassOutdatedError`, which a turn reports
 *                 as `windlass_outdated`). What keeps the server from fetching tokens at all is passed
 *                 in (`problem`) and said when the server starts.
 */

import type { AccessTokens } from "../api.js";
import { SandboxWindlass, type TurnOptions, type WindlassHost } from "../turn.js";

export interface E2bWindlassOptions extends TurnOptions {
	/** WLP_E2B_WINDLASS_VERSION, when set. */
	version?: string | null;
	/** `Windlass.problem()`: what keeps this server from running turns on a ChatGPT sign-in, from whoever knows (the sign-in code). Default: nothing. */
	problem?: () => Promise<string | null>;
}

export class E2bWindlass extends SandboxWindlass {
	private readonly seen: { version: string | null };

	constructor(tokens: AccessTokens, options: E2bWindlassOptions = {}) {
		const seen = { version: options.version ?? null };
		const host: WindlassHost = {
			version: async () => seen.version,
			problem: async () => (await options.problem?.()) ?? null,
			// The token source reports its own Windlass when it is asked for a token; there is no image of this provider's to look at first.
			tokenSourceProblem: async () => null,
		};
		super(tokens, host, options);
		this.seen = seen;
	}

	/** A sandbox made from the template said which Windlass is in it. What the owner configured stands. */
	noteVersion(version: string): void {
		this.seen.version ??= version;
	}
}
