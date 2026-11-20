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
 *   the problem   The server checks its sign-in executable at startup. Each turn checks the
 *                 template's host tools in its own initialization response.
 */

import type { AccessTokens } from "../api.js";
import { SandboxWindlass, type TurnOptions, type WindlassHost } from "../turn.js";

export interface E2bWindlassOptions extends TurnOptions {
	/** WLP_E2B_WINDLASS_VERSION, when set. */
	version?: string | null;
}

export class E2bWindlass extends SandboxWindlass {
	private readonly seen: { version: string | null };

	constructor(tokens: AccessTokens, options: E2bWindlassOptions = {}) {
		const seen = { version: options.version ?? null };
		const host: WindlassHost = {
			version: async () => seen.version,
			problem: async () => null,

		};
		super(tokens, host, options);
		this.seen = seen;
	}

	/** A sandbox made from the template said which Windlass is in it. What the owner configured stands. */
	noteVersion(version: string): void {
		this.seen.version ??= version;
	}
}
