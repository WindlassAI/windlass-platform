import { parseModelRelayUrl, readsModelRelay } from "../../model-relay-url.js";
import { readHostedSettings, readHostedRates } from "../hosted-settings.js";
import { MAX_HOSTS } from "../hosted-network.js";

const publicRates = { usdPerVcpuSecond: 0.000014, usdPerGiBSecond: 0.0000045, usdPerDiskGiBSecond: 0.00000003 };
export const diskGiB = { small: 3, standard: 8, large: 10 };

export function readDaytonaSettings(env: NodeJS.ProcessEnv = process.env) {
	const shared = readHostedSettings(env, "daytona");
	if (shared.snapshots) throw new Error("Daytona prepared environments are unavailable. Set WLP_HOSTED_SNAPSHOTS=off.");
	if (shared.windlassSandbox || (env.WLP_HOSTED_NETWORK?.trim() || "open") !== "open" || env.WLP_HOSTED_NETWORK_ALLOW?.trim())
		throw new Error("Daytona tier 1 offers Open isolation only and cannot enforce a network allow-list.");
	const relay = parseModelRelayUrl(env.WLP_MODEL_RELAY_URL);
	if (!relay || "problem" in relay || env.WLP_MODEL_RELAY?.trim().toLowerCase() === "off")
		throw new Error("Daytona requires WLP_MODEL_RELAY_URL and an enabled model relay.");
	if (shared.windlassVersion && !readsModelRelay(shared.windlassVersion)) throw new Error("Daytona requires a relay-capable Windlass (0.6.0+).");
	return {
		...shared, provider: "daytona" as const,
		apiUrl: env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api", target: env.DAYTONA_TARGET?.trim() || undefined,
		snapshot: env.WLP_DAYTONA_SNAPSHOT?.trim() || "windlass-platform-sandbox",
		network: { mode: "open" as const, hosts: [], maxHosts: MAX_HOSTS },
		modelRelayOrigin: relay.origin, rates: readHostedRates(env, "daytona", "linux-vm", publicRates),
	};
}
export type DaytonaSettings = ReturnType<typeof readDaytonaSettings>;
