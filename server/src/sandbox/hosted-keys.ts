import type { AcpProfile } from "./harnesses.js";
import type { KeyTurnRelay, ModelKeyLease } from "./provider.js";

/** The hosted CLI receives one turn's placeholder, in the format its adapter expects. */
export function hostedKeyEnv(id: AcpProfile["id"], provider: ModelKeyLease["provider"], lease: KeyTurnRelay): Record<string, string> {
	const base = lease.env.WINDLASS_MODEL_BASE_URL!;
	switch (id) {
		case "claude":
			return { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: lease.placeholder };
		case "codex":
			return { WLP_CODEX_BASE_URL: base, WLP_SESSION_BEARER: lease.placeholder, CODEX_HOME: "/opt/wlp-codex/home",
				CODEX_SQLITE_HOME: "/opt/wlp-codex/home/sqlite", INITIAL_AGENT_MODE: "agent-full-access" };
		case "opencode": {
			const version = provider === "anthropic" ? "/v1" : provider === "google" ? "/v1beta" : "";
			return {
				OPENCODE_AUTH_CONTENT: JSON.stringify({ [provider]: { type: "api", key: lease.placeholder } }),
				OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [provider], provider: { [provider]: { options: { baseURL: base + version } } } }),
			};
		}
	}
}
