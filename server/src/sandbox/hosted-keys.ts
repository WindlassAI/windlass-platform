import { SecretRedactor, type Redactor } from "../repo-secrets.js";
import type { HarnessId } from "../contract.js";
import type { KeyTurnRelay, ModelKeyLease } from "./provider.js";

type KeyEnv = (provider: ModelKeyLease["provider"], base: string, placeholder: string) => Record<string, string>;

const WINDLASS_KEY_VARIABLES: Record<ModelKeyLease["provider"], string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY" };

/** Each harness's placeholder env, in the format its adapter expects. */
const KEY_ENV: Record<HarnessId, KeyEnv> = {
	windlass: (provider, base, placeholder) => ({ WINDLASS_MODEL_BASE_URL: base, WINDLASS_MODEL_ALLOWED_ORIGIN: new URL(base).origin, WINDLASS_PROVIDER: provider, [WINDLASS_KEY_VARIABLES[provider]]: placeholder }),
	claude: (_provider, base, placeholder) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: placeholder }),
	codex: (_provider, base, placeholder) => ({ WLP_CODEX_BASE_URL: base, WLP_SESSION_BEARER: placeholder, CODEX_HOME: "/opt/wlp-codex/home",
		CODEX_SQLITE_HOME: "/opt/wlp-codex/home/sqlite", INITIAL_AGENT_MODE: "agent-full-access" }),
	opencode: (provider, base, placeholder) => {
		const version = provider === "anthropic" ? "/v1" : provider === "google" ? "/v1beta" : "";
		return {
			OPENCODE_AUTH_CONTENT: JSON.stringify({ [provider]: { type: "api", key: placeholder } }),
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [provider], provider: { [provider]: { options: { baseURL: base + version } } } }),
		};
	},
};

/** The hosted CLI receives one turn's placeholder, in the format its adapter expects. */
export function hostedKeyEnv(id: HarnessId, provider: ModelKeyLease["provider"], lease: KeyTurnRelay): Record<string, string> {
	return KEY_ENV[id](provider, lease.env.WINDLASS_MODEL_BASE_URL!, lease.placeholder);
}

export function redactKeyLease(secrets: Redactor, placeholder: string): Redactor {
	const relay = new SecretRedactor([{ name: "model-relay", value: placeholder }]);
	return { active: true, text: s => secrets.text(relay.text(s)), deep: v => secrets.deep(relay.deep(v)),
		held: s => Math.max(secrets.held(s), relay.held(s)) };
}
