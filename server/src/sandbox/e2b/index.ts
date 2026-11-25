/**
 * The sandbox layer of a deployment on E2B (WLP_SANDBOX=e2b): sessions' sandboxes are E2B microVMs, and
 * Windlass runs in them as it does in a container. E2B holds no sign-in: a turn is handed a short-lived
 * access token, as on Docker, so the sign-in parts of the layer (`ChatgptLogins`, `AccessTokens`) are
 * not this provider's and are passed in by whoever puts the layer together (server/src/sandbox/index.ts).
 *
 * Loading this module loads E2B's SDK, so it is imported only where a server or a script is configured
 * for E2B.
 */

import type { TurnOptions } from "../turn.js";
import type { E2bClient } from "./client.js";
import { type E2bSettings, readE2bKey, readE2bSettings } from "./config.js";
import { E2bProvider, type E2bProviderOptions } from "./sandboxes.js";
import { createE2bSdkClient } from "./sdk.js";
import { hostedSandboxLayer, type HostedLayerParts } from "../hosted-layer.js";

export interface E2bLayerOptions extends Pick<E2bProviderOptions, "log" | "now" | "sleep"> {
	/** Another client than E2B's SDK: the in-memory one of the provider's tests. With it no API key is read. */
	client?: E2bClient;
	/** With `client`: the settings. Without: read from the environment, with the API key. */
	settings?: E2bSettings;
	turn?: TurnOptions;
}

/**
 * Puts the layer together. Without `options.client` it reads the E2B settings from the environment and
 * throws, with what to set, when E2B_API_KEY is missing: a server configured for E2B without a key must
 * not start as if it could run agents.
 */
export function createE2bSandboxLayer(parts: HostedLayerParts, options: E2bLayerOptions = {}) {
	const client = options.client ?? createE2bSdkClient(readE2bKey());
	const settings = options.settings ?? readE2bSettings();
	return hostedSandboxLayer(parts, onVersion => new E2bProvider(client, settings, { ...options, onVersion }), settings.windlassVersion, options.turn);
}
