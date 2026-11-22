/**
 * Windlass in the Docker sandboxes. The turn itself is turn.ts, which knows no provider; here is what
 * is Docker's: where the image's Windlass is looked at, and what a turn's process is on this provider:
 *
 *   docker exec -i -w /workspace -e WINDLASS_WAKE=off -e WINDLASS_ACP_LOG=warn \
 *     -e WINDLASS_ACP_SCRIPT=/tmp/.wlp-script-<random>.json                                        a scripted (demo) turn
 *     -e WINDLASS_ACCESS_TOKEN_FILE=<session-private path>/access-token-<id>.json       any other turn
 *     wlp-session-<id> wlp-run exec <tag> windlass acp
 *
 * The turn's access token is written with
 *
 *   docker exec -i wlp-session-<id> sh -c 'set -eu; umask 077; tmp="$1.tmp"; trap ... EXIT; cat > "$tmp"; mv -f -- "$tmp" "$1"' sh <file>
 *
 * (the token on standard input). The server checks the image version at startup.
 */

import type { AccessTokens } from "./api.js";
import { IMAGE } from "./docker.js";
import { windlassVersionProblem } from "../startup.js";
import { probeImage } from "./tokens.js";
import { SandboxWindlass, type TurnOptions, type WindlassHost } from "./turn.js";

export { START_TIMEOUT_MS } from "./turn.js";

export interface DockerWindlassOptions extends TurnOptions {
	/** The image whose Windlass `version()` and `problem()` are about. Default the server's. */
	image?: string;
}

/** The Windlass of a Docker image: sandboxes are made from it, and the helper that fetches access tokens runs it. */
export function dockerWindlassHost(image: string = IMAGE): WindlassHost {
	return {
		version: () => probeImage(image),
		problem: async () => windlassVersionProblem(await probeImage(image), "sandbox image " + image),
	};
}

export class DockerWindlass extends SandboxWindlass {
	/** `tokens`: where a turn that is not scripted gets its user's access token. */
	constructor(tokens: AccessTokens, options: DockerWindlassOptions = {}) {
		super(tokens, dockerWindlassHost(options.image ?? IMAGE), options);
	}
}
