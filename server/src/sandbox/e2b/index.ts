import type { ChatgptLogins, SandboxLayer } from "../api.js";
import { HostedSandboxes } from "../hosted.js";
import { SandboxWindlass, type TurnOptions } from "../turn.js";
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
	const provider = new E2bProvider(client, settings, { ...options, onVersion: value => { version ??= value; } });
	const windlass = new SandboxWindlass(parts.tokens, { version: async () => version, problem: async () => null }, options.turn);
	const logins: ChatgptLogins = {
		start: (...args) => parts.logins.start(...args),
		finish: (...args) => parts.logins.finish(...args),
		adopt: (...args) => parts.logins.adopt(...args),
		status: uid => parts.logins.status(uid),
		ensureUserVolume: uid => parts.logins.ensureUserVolume(uid),
		async logout(uid) {
			await parts.logins.logout(uid);
			// Each running microVM holds its own token file after the sign-in is forgotten.
			await provider.forgetTokenFiles(uid).catch((error: unknown) => console.warn(`[wlp] e2b.token_files_left uid=${uid}: the access token files of the user's running turns could not be removed (${error instanceof Error ? error.message : String(error)}); each expires within the hour`));
		},
	};
	return { sandboxes: new HostedSandboxes(provider), windlass, logins, tokens: parts.tokens, backups: parts.backups ?? null };
}
