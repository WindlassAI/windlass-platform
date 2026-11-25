import { hostedName, wholeNumber } from "./hosted-env.js";
import { MODEL_RELAY_WINDLASS, parseModelRelayUrl, readsModelRelay } from "../model-relay-url.js";
import { type EgressMode, NETWORK_PRESETS, type NetworkPreset } from "../contract.js";

/** Windlass's engine sends its model requests here (light-harness packages/core/src/provider/openai-responses.ts, RESPONSES_BASE_URL). */
export const MODEL_HOSTS: readonly string[] = ["api.openai.com"];

/**
 * The presets: what WLP_E2B_NETWORK_ALLOW and a repository's own list (repository-network.ts) may name
 * besides single hosts. The list is the contract's (`NETWORK_PRESETS`), so the web app shows the same.
 */
export const PRESET_LIST: readonly NetworkPreset[] = NETWORK_PRESETS;

/** The presets by id. */
export const PRESETS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(PRESET_LIST.map((preset) => [preset.id, preset.hosts]));
export const DEFAULT_ALLOW = "@npm,@pypi,@github";
/** E2B's network configuration is one request; a long list is a sign of a mistake. Every host a sandbox may reach counts: the platform's, the deployment's and a repository's. */
export const MAX_HOSTS = 64;

export interface HostedNetwork {
	mode: EgressMode;
	/** The names E2B allows, sorted, each once. Empty in `open`. */
	hosts: string[];
	maxHosts?: number;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** An exact DNS name, lower case, with no trailing dot: at least two labels, the last not all digits (no address). */
export function isHostName(host: string): boolean {
	const labels = host.split(".");
	return host.length <= 253 && labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels.at(-1)!);
}

/** The name of an https address on the default port, or a refusal naming the variable. */
function platformHost(name: string, raw: string, extra = ""): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${name} is not an address`);
	}
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || url.port !== "" || !isHostName(host))
		throw new Error(`WLP_E2B_NETWORK=restricted and none allow hosts by name, which E2B matches only for HTTPS on port 443: ${name} must be an https address with a DNS name and no port${extra}`);
	return host;
}

/** The bucket's host, when a bucket is configured (the four variables of config.ts `backupConfig`). */
function bucketName(env: NodeJS.ProcessEnv): string | null {
	const read = (name: string) => (env[name] ?? "").trim();
	if (["WLP_BUCKET_ENDPOINT", "WLP_BUCKET_NAME", "WLP_BUCKET_ACCESS_KEY_ID", "WLP_BUCKET_SECRET_ACCESS_KEY"].some((name) => read(name) === "")) return null;
	let endpoint: URL;
	try {
		endpoint = new URL(read("WLP_BUCKET_ENDPOINT"));
	} catch {
		// The value is not repeated: an endpoint may carry an account's id. config.ts refuses it too.
		throw new Error("WLP_BUCKET_ENDPOINT is not a URL");
	}
	// As bucket/s3.ts names the host of a signed link: the bucket before the endpoint's host in virtual style.
	const host = read("WLP_BUCKET_STYLE").toLowerCase() === "virtual" ? `${read("WLP_BUCKET_NAME")}.${endpoint.host}` : endpoint.host;
	return platformHost("WLP_BUCKET_ENDPOINT", `${endpoint.protocol}//${host}`, " (with WLP_BUCKET_STYLE=virtual, the bucket's name must be a DNS label)");
}

/** The entries of WLP_E2B_NETWORK_ALLOW, presets expanded. Throws with the entry that is wrong. */
export function allowList(raw: string): string[] {
	const out: string[] = [];
	for (const entry of raw.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean)) {
		const preset = PRESETS[entry];
		if (preset) out.push(...preset);
		else if (entry.startsWith("@")) throw new Error(`WLP_E2B_NETWORK_ALLOW: "${entry}" is no preset; the presets are ${Object.keys(PRESETS).join(", ")}`);
		else if (!isHostName(entry.replace(/\.$/, ""))) throw new Error(`WLP_E2B_NETWORK_ALLOW: "${entry}" is not a DNS name. Give exact host names or presets, comma-separated: no addresses, ports or wildcards`);
		else out.push(entry.replace(/\.$/, ""));
	}
	return out;
}

/**
 * Whether E2B sandboxes send Windlass's model requests to the relay route instead of api.openai.com
 * (docs/model-relay.md), and where: the origin of WLP_MODEL_RELAY_URL, a hostname of the relay's own. Off,
 * and the turn's token goes into the sandbox as before, with WLP_MODEL_RELAY=off, without
 * WLP_MODEL_RELAY_URL (never the platform's whole public host instead), or when the template's Windlass
 * (WLP_E2B_WINDLASS_VERSION) is not known to be 0.6.0 or later, the first release that routes ChatGPT through the relay.
 */
export function hostedModelRelay(env: NodeJS.ProcessEnv = process.env): { origin: string; host: string } | { off: string } {
	if ((env.WLP_MODEL_RELAY ?? "").trim().toLowerCase() === "off") return { off: "WLP_MODEL_RELAY=off" };
	const url = parseModelRelayUrl(env.WLP_MODEL_RELAY_URL);
	if (url === null) return { off: "WLP_MODEL_RELAY_URL is not set" };
	if ("problem" in url) return { off: url.problem };
	const version = (env[hostedName(env, "WINDLASS_VERSION")] ?? "").trim();
	if (!readsModelRelay(version))
		return { off: `WLP_E2B_WINDLASS_VERSION is ${version === "" ? "not set" : version}, and the relay needs Windlass ${MODEL_RELAY_WINDLASS} or later in the template` };
	return url;
}

/** `hostedModelRelay`'s origin, or null when the relay is off for E2B. */
export function hostedModelRelayOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
	const relay = hostedModelRelay(env);
	return "origin" in relay ? relay.origin : null;
}

/** WLP_E2B_NETWORK and WLP_E2B_NETWORK_ALLOW, with the platform's own hosts added. */
export function readHostedNetwork(env: NodeJS.ProcessEnv = process.env, relay = hostedModelRelay(env)): HostedNetwork {
	const modeName = hostedName(env, "NETWORK");
	const allowName = hostedName(env, "NETWORK_ALLOW");
	const raw = (env[modeName] ?? "").trim().toLowerCase();
	const mode: EgressMode = raw === "" ? "open" : raw === "open" || raw === "restricted" || raw === "none" ? raw : (() => { throw new Error(`${modeName} must be open, restricted or none; got "${raw}"`); })();
	const allow = env[allowName];
	const maxHosts = wholeNumber(env, "WLP_HOSTED_NETWORK_MAX_HOSTS", MAX_HOSTS, 1, MAX_HOSTS);
	if (allow !== undefined && allow.trim() !== "" && mode !== "restricted") throw new Error(`${allowName} applies only with ${modeName}=restricted`);
	if (mode === "open") return { mode, hosts: [], maxHosts };
	// With the model relay, its own host in place of the model API's, in `none` too: Windlass's requests go
	// there (docs/model-relay.md), and nothing in the sandbox has a token api.openai.com would take.
	const hosts = "host" in relay ? [relay.host] : [...MODEL_HOSTS];
	const bucket = bucketName(env);
	if (bucket !== null) hosts.push(bucket);
	if (mode === "restricted") {
		hosts.push(platformHost("WLP_GITHUB_URL", (env.WLP_GITHUB_URL ?? "").trim() || "https://github.com"));
		hosts.push(...allowList(allow === undefined || allow.trim() === "" ? DEFAULT_ALLOW : allow));
	}
	const unique = [...new Set(hosts)].sort();
	if (unique.length > maxHosts) throw new Error(`${allowName} names ${unique.length} hosts with the platform's own; at most ${maxHosts}`);
	return { mode, hosts: unique, maxHosts };
}

/**
 * The deployment's network with the hosts a session's repositories allow added (repository-network.ts):
 * only in `restricted`, where a repository's list applies; `open` and `none` are as the deployment has
 * them. The platform's and the deployment's hosts come first: when the whole would pass MAX_HOSTS, the
 * repository's hosts that do not fit are left out and named in `dropped` (a save refuses a list that
 * cannot fit, so this happens only when the deployment's own list grew after it).
 */
export function withHosts(network: HostedNetwork, extra: readonly string[] | undefined): { network: HostedNetwork; dropped: string[] } {
	if (network.mode !== "restricted" || !extra || extra.length === 0) return { network, dropped: [] };
	const hosts = new Set(network.hosts);
	const dropped: string[] = [];
	for (const host of [...new Set(extra)].sort()) {
		if (hosts.has(host) || !isHostName(host)) continue;
		if (hosts.size >= (network.maxHosts ?? MAX_HOSTS)) dropped.push(host);
		else hosts.add(host);
	}
	return { network: { ...network, hosts: [...hosts].sort() }, dropped };
}

/** What a command with the microVM's network reaches, in the words of the profiles' facts (web Layers.tsx `commandNetworkFact`). */
export function hostedNetworkText(mode: EgressMode): string {
	switch (mode) {
		case "open": return "commands can reach the network";
		case "restricted": return "commands can reach only the model API, GitHub and the hosts this deployment allows";
		case "none": return "commands can reach only the model API";
	}
}

/** The same, as a sentence for a profile's summary. */
export function hostedNetworkSentence(mode: EgressMode): string {
	switch (mode) {
		case "open": return "";
		case "restricted": return " This deployment limits the microVM's network to the model API, GitHub and the hosts its operator allows; every other host is refused.";
		case "none": return " This deployment gives the microVM no network but the model API, so a session here cannot have a repository.";
	}
}

/** Refused at launch and when a turn starts, as `OFFLINE_REPOSITORY` is on a machine with --egress none. */
export const HOSTED_OFFLINE_REPOSITORY = "This deployment's hosted sandboxes have no network for repositories (WLP_E2B_NETWORK=none). Start the session without a repository, or on a machine of yours.";
