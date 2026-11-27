import type { SandboxLayer } from "../api.js";
import { hostedLayer } from "../hosted.js";
import type { TurnOptions } from "../turn.js";
import type { E2bClient } from "./client.js";
import { type E2bSettings, readE2bKey, readE2bSettings } from "./config.js";
import { E2bProvider, type E2bProviderOptions } from "./sandboxes.js";
import { createE2bSdkClient } from "./sdk.js";

type LayerParts = Pick<SandboxLayer, "tokens" | "logins" | "backups">;

interface E2bLayerOptions extends Pick<E2bProviderOptions, "log" | "now" | "sleep"> {
	client?: E2bClient;
	settings?: E2bSettings;
	turn?: TurnOptions;
}

export function createE2bSandboxLayer(parts: LayerParts, options: E2bLayerOptions = {}) {
	const client = options.client ?? createE2bSdkClient(readE2bKey());
	const settings = options.settings ?? readE2bSettings();
	let version = settings.windlassVersion;
	const provider = new E2bProvider(client, settings, {
		...options,
		onVersion: value => {
			version ??= value;
		},
	});
	return hostedLayer(parts, provider, async () => version, options.turn);
}
