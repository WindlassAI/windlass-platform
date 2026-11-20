/**
 * The sandbox layer of a deployment on E2B (WLP_SANDBOX=e2b): sessions' sandboxes are E2B microVMs, and
 * Windlass runs in them as it does in a container. E2B holds no sign-in: a turn is handed a short-lived
 * access token, as on Docker, so the sign-in parts of the layer (`ChatgptLogins`, `AccessTokens`) are
 * not this provider's and are passed in by whoever puts the layer together (server/src/sandbox/index.ts).
 *
 * Loading this module loads E2B's SDK, so it is imported only where a server or a script is configured
 * for E2B.
 */

import type { AccessTokens, ChatgptLogins, SandboxLayer, SessionBackups } from "../api.js";
import type { TurnOptions } from "../turn.js";
import type { E2bClient } from "./client.js";
import { type E2bSettings, readE2bConfig } from "./config.js";
import { E2bSandboxes, type E2bSandboxesOptions } from "./sandboxes.js";
import { createE2bSdkClient } from "./sdk.js";
import { E2bWindlass } from "./windlass.js";

export interface E2bSandboxLayer extends SandboxLayer {
	sandboxes: E2bSandboxes;
	windlass: E2bWindlass;
}

export interface E2bLayerParts {
	logins: ChatgptLogins;
	tokens: AccessTokens;
	/**
	 * Where the copies of Windlass's session data go (../backup.ts). On E2B that data is on the microVM's
	 * own disk and goes with it; with this, a session whose sandbox is lost goes on in the same Windlass
	 * session in the next one. Null or absent: no bucket, and such a session starts a new one.
	 */
	backups?: SessionBackups | null;
}

export interface E2bLayerOptions extends Pick<E2bSandboxesOptions, "log" | "now" | "sleep"> {
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
export function createE2bSandboxLayer(parts: E2bLayerParts, options: E2bLayerOptions = {}): E2bSandboxLayer {
	let client = options.client;
	let settings = options.settings;
	if (client === undefined || settings === undefined) {
		const config = readE2bConfig();
		const { apiKey, ...rest } = config;
		client ??= createE2bSdkClient(apiKey);
		settings ??= rest;
	}
	const windlass = new E2bWindlass(parts.tokens, { ...options.turn, version: settings.windlassVersion });
	const sandboxes = new E2bSandboxes(client, settings, { log: options.log, now: options.now, sleep: options.sleep, onVersion: (version) => windlass.noteVersion(version) });
	return { sandboxes, windlass, logins: withTokenFiles(parts.logins, sandboxes), tokens: parts.tokens, backups: parts.backups ?? null };
}

/**
 * `ChatgptLogins.logout` promises that the token files of turns still running are removed. On Docker
 * they are in the user's data volume, which the sign-in code reaches; on E2B each is in its session's
 * sandbox, so this layer removes them there once the sign-in itself is forgotten.
 */
function withTokenFiles(logins: ChatgptLogins, sandboxes: E2bSandboxes): ChatgptLogins {
	const logout = async (uid: string) => {
		await logins.logout(uid);
		await sandboxes.forgetTokenFiles(uid).catch((error: unknown) => console.warn(`[wlp] e2b.token_files_left uid=${uid}: the access token files of the user's running turns could not be removed (${error instanceof Error ? error.message : String(error)}); each expires within the hour`));
	};
	// Everything else is the sign-in code's own, called on its own object.
	return new Proxy(logins, {
		get(target, property) {
			if (property === "logout") return logout;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

export { E2bSandboxes, E2bWindlass };
export type { E2bClient, E2bSettings };
