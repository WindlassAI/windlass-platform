// What the runner does differently per machine harness, one record each, so callers read a field instead of comparing ids.
import type { ModelProvider } from "../../server/src/contract.js";
import { innerModesReason } from "../../server/src/sandbox/codex-modes.js";
import { keyRelayUrl, openCodeCredentials, prepareRelay, type ProviderLogin } from "./claude-relay.js";
import { changeCodexLogin, codexLogin } from "./codex-login.js";
import { changeClaudeLogin } from "./harness-login.js";
import { changeProviderLogin, currentProvider } from "./opencode-login.js";
import { providerHosts } from "./opencode-providers.js";
import type { MachineDocker, MachineHarness } from "./policy.js";
import { HARNESSES } from "./setup-choices.js";

type Keys = Partial<Record<ModelProvider, string>>;
type Credentials = { env: Record<string, string>; close?: () => Promise<void> };

export interface MachineHarnessRecord {
	/** Refusal when the runner was started without this harness. */
	notEnabled: string;
	/** Whether it may also run on the Windlass sandbox profile once its inner sandbox probe passed (Codex); otherwise docker-hardened only. */
	innerProfile: boolean;
	/** Refusal for a profile it cannot run on. */
	profileRefusal: string;
	/** Refusal replacing a missing pinned image's error; without one, the image error is passed on. */
	missingImage?: string;
	/** Whether its sandbox names may lack the harness prefix: Claude's predate it (`migrateClaudeNames`). */
	unprefixedNames: boolean;
	/** Hosts its sandbox may not reach under restricted egress: its provider must be reached through the relay. */
	deniedHosts: () => readonly string[];
	/** Whether its key relay shares the relay's port 17892 (the forwarder's "codex" mode); others take keys on 17894. */
	keysOnRelayPort: boolean;
	/** The machine's own sign-in the relay serves; none where the relay reads the login volume itself (Claude). */
	machineLogin: (m: MachineDocker) => ProviderLogin | undefined;
	/** Whether a turn needs a machine sign-in or a key: Claude's relay can start without either. */
	needsLogin: boolean;
	/** A Settings key handed straight to the agent, bypassing the session relay. */
	keyEnv: (keys: Keys) => Record<string, string> | undefined;
	/** The session relay's credentials for a turn. */
	credentials: (m: MachineDocker, nonce: string, login: ProviderLogin | undefined, keys: Keys) => Promise<Credentials>;
	/** `login` / `logout <agent>`. */
	changeLogin: (m: MachineDocker, login: boolean, signal: AbortSignal, provider?: string) => Promise<unknown>;
	/** Whether `login` takes `--provider`. */
	takesProvider: boolean;
	/** The line after a successful logout. */
	signedOut: string;
}

const relayCredentials = (m: MachineDocker, nonce: string, login: ProviderLogin | undefined) =>
	prepareRelay(m, login, nonce);

export const MACHINE_HARNESSES: Record<MachineHarness, MachineHarnessRecord> = {
	claude: {
		notEnabled: "Claude Code is not turned on on this machine: start the runner with --harness claude.",
		innerProfile: false,
		profileRefusal: "Claude Code requires the docker-hardened profile.",
		missingImage:
			"The pinned Claude Code image is missing on this machine. Update the runner and start it with --harness claude.",
		unprefixedNames: true,
		deniedHosts: () => [],
		keysOnRelayPort: false,
		machineLogin: () => undefined,
		needsLogin: false,
		keyEnv: keys =>
			keys.anthropic ? { ANTHROPIC_BASE_URL: keyRelayUrl, ANTHROPIC_API_KEY: keys.anthropic } : undefined,
		credentials: relayCredentials,
		changeLogin: changeClaudeLogin,
		takesProvider: false,
		signedOut: "signed out.",
	},
	codex: {
		notEnabled: "Start the runner with --harness codex.",
		innerProfile: true,
		profileRefusal: innerModesReason,
		unprefixedNames: false,
		deniedHosts: () => ["api.openai.com", "auth.openai.com", "chatgpt.com"],
		keysOnRelayPort: true,
		machineLogin: codexLogin,
		needsLogin: true,
		keyEnv: keys => (keys.openai ? { WLP_SESSION_BEARER: keys.openai } : undefined),
		credentials: relayCredentials,
		changeLogin: changeCodexLogin,
		takesProvider: false,
		signedOut: "signed out on this machine; OpenAI-side revocation not available.",
	},
	opencode: {
		notEnabled: "Start the runner with --harness opencode.",
		innerProfile: false,
		profileRefusal: "OpenCode requires the docker-hardened profile.",
		unprefixedNames: false,
		deniedHosts: () => providerHosts,
		keysOnRelayPort: false,
		machineLogin: currentProvider,
		needsLogin: true,
		keyEnv: () => undefined,
		credentials: openCodeCredentials,
		changeLogin: changeProviderLogin,
		takesProvider: true,
		signedOut: "signed out.",
	},
};

/** The harness whose prefix a sandbox's raw id carries ("codex-…"); undefined for a Windlass or legacy Claude name. */
export function harnessOfRaw(raw: string): MachineHarness | undefined {
	return HARNESSES.find(id => raw.startsWith(id + "-"));
}

/** A session container's name: wlp-session-, an optional harness prefix, then 12 hex digits (the raw id). */
export const SESSION_NAME = new RegExp(`^wlp-session-((?:(?:${HARNESSES.join("|")})-)?[a-f0-9]{12})$`);
