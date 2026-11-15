/**
 * The sandbox layer: Docker containers for sessions, Windlass run inside them, the ChatGPT sign-in done
 * by Windlass in throwaway containers, and the one place that turns a sign-in into the short-lived
 * access token a turn is handed. See api.ts for the interface and sandbox/ for the image.
 */

import type { SandboxLayer } from "./api.js";
import { DockerChatgptLogins } from "./logins.js";
import { DockerSandboxes } from "./sandboxes.js";
import { DockerAccessTokens } from "./tokens.js";
import { DockerWindlass } from "./windlass.js";

export interface DockerSandboxLayer extends SandboxLayer {
	sandboxes: DockerSandboxes;
	windlass: DockerWindlass;
	logins: DockerChatgptLogins;
	tokens: DockerAccessTokens;
}

/** For the layer's own checks; the server takes the defaults. */
export interface SandboxLayerOptions {
	/** Another image than windlass-platform-sandbox:latest. */
	image?: string;
	/** "none": the helper that asks Windlass for an access token gets no network, so it can send nothing: a token that needs no refresh is printed all the same, and one that needs one fails. */
	tokenNetwork?: "bridge" | "none";
}

export function createSandboxLayer(options: SandboxLayerOptions = {}): DockerSandboxLayer {
	const { image } = options;
	const tokens = new DockerAccessTokens({ image, network: options.tokenNetwork });
	return {
		sandboxes: new DockerSandboxes({ image }),
		windlass: new DockerWindlass(tokens, { image }),
		// A sign-in that is replaced or forgotten takes the tokens kept of it with it.
		logins: new DockerChatgptLogins({ image, changed: (uid) => tokens.forget(uid) }),
		tokens,
	};
}

export { SandboxUserError } from "./api.js";
export type * from "./api.js";
