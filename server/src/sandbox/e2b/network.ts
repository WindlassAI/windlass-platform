/**
 * The network of a deployment's E2B sandboxes (WLP_E2B_NETWORK): `open`, `restricted` or `none`, the
 * hosted counterpart of a machine's `--egress` (docs/operating.md, "E2B", "Network").
 *
 * Everything is enforced by E2B outside the microVM, with the options of its own network configuration
 * (https://docs.e2b.dev/network/internet-access.md): nothing inside the sandbox can change it, and the
 * agent's commands, Windlass's engine and the platform's own steps all share it, since all of them run in
 * the same microVM. So the hosts the platform's own steps need are always in the list, computed from the
 * server's configuration and never typed by hand:
 *
 *   the model API      Windlass's engine calls api.openai.com (its RESPONSES_BASE_URL) from the sandbox
 *   the git host       clone, fetch and push run in the sandbox as the transport user, against
 *                      WLP_GITHUB_URL (github.com): `restricted` only, `none` refuses repositories
 *   the bucket         memory backups and screenshots are sent from the sandbox with a signed link to
 *                      WLP_BUCKET_ENDPOINT's host (with the bucket before it in virtual style)
 *
 * What E2B is asked for, in `restricted` and `none`: every destination denied (`0.0.0.0/0`), the hosts
 * allowed by name (E2B matches the TLS server name on 443 and the Host header on 80, and connects to
 * the name itself, whatever address the sandbox dialled), and no DNS server allowed (`dnsServers: []`).
 * Without that last part E2B lets all traffic to 8.8.8.8 through, which carries any name a command
 * wants to look up. Inside the sandbox the allowed names are written into /etc/hosts and the resolver
 * file is emptied, as root, at create and at every resume (`guestDnsScript`), so allowed names resolve
 * and every other lookup fails at once.
 *
 * `open` is today's sandbox: no network option is sent at all. E2B blocks private and link-local ranges
 * towards its own network in every sandbox and mode, so what a machine calls `restricted` (no private
 * network, no cloud metadata) already holds there; the stricter step on E2B is a list of hosts.
 */

import type { EgressMode } from "../../contract.js";

/** Windlass's engine sends its model requests here (light-harness packages/core/src/provider/openai-responses.ts, RESPONSES_BASE_URL). */
export const MODEL_HOSTS: readonly string[] = ["api.openai.com"];

/** What WLP_E2B_NETWORK_ALLOW may name besides single hosts. Exact names only: a wildcard cannot be pinned in /etc/hosts. */
export const PRESETS: Readonly<Record<string, readonly string[]>> = {
	"@npm": ["registry.npmjs.org", "registry.yarnpkg.com"],
	"@pypi": ["pypi.org", "files.pythonhosted.org"],
	"@github": ["github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com"],
	"@crates": ["crates.io", "index.crates.io", "static.crates.io"],
	"@go": ["proxy.golang.org", "sum.golang.org"],
};
export const DEFAULT_ALLOW = "@npm,@pypi,@github";
/** E2B's network configuration is one request; a long list is a sign of a mistake. */
const MAX_HOSTS = 64;
/** Where the pinned names point. E2B routes an allowed request by its name, so any public address works (its "Resolving names with no DNS server"). */
export const PIN_ADDRESS = "1.1.1.1";

export interface E2bNetwork {
	mode: EgressMode;
	/** The names E2B allows, sorted, each once. Empty in `open`. */
	hosts: string[];
}

/** What is sent to E2B: `network` of `Sandbox.create`, and the body of `updateNetwork`. Null: no option (open). */
export interface E2bNetworkConfig {
	denyOut: string[];
	allowOut: string[];
	dnsServers: string[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function isHostName(host: string): boolean {
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

/** WLP_E2B_NETWORK and WLP_E2B_NETWORK_ALLOW, with the platform's own hosts added. */
export function readE2bNetwork(env: NodeJS.ProcessEnv = process.env): E2bNetwork {
	const raw = (env.WLP_E2B_NETWORK ?? "").trim().toLowerCase();
	const mode: EgressMode = raw === "" ? "open" : raw === "open" || raw === "restricted" || raw === "none" ? raw : (() => { throw new Error(`WLP_E2B_NETWORK must be open, restricted or none; got "${raw}"`); })();
	const allow = env.WLP_E2B_NETWORK_ALLOW;
	if (allow !== undefined && allow.trim() !== "" && mode !== "restricted") throw new Error("WLP_E2B_NETWORK_ALLOW applies only with WLP_E2B_NETWORK=restricted");
	if (mode === "open") return { mode, hosts: [] };
	const hosts = [...MODEL_HOSTS];
	const bucket = bucketName(env);
	if (bucket !== null) hosts.push(bucket);
	if (mode === "restricted") {
		hosts.push(platformHost("WLP_GITHUB_URL", (env.WLP_GITHUB_URL ?? "").trim() || "https://github.com"));
		hosts.push(...allowList(allow === undefined || allow.trim() === "" ? DEFAULT_ALLOW : allow));
	}
	const unique = [...new Set(hosts)].sort();
	if (unique.length > MAX_HOSTS) throw new Error(`WLP_E2B_NETWORK_ALLOW names ${unique.length} hosts with the platform's own; at most ${MAX_HOSTS}`);
	return { mode, hosts: unique };
}

/** What E2B is asked for. Null in `open`: nothing is sent, as before network modes. */
export function networkConfig(network: E2bNetwork): E2bNetworkConfig | null {
	if (network.mode === "open") return null;
	return { denyOut: ["0.0.0.0/0"], allowOut: [...network.hosts], dnsServers: [] };
}

/**
 * The sandbox's own name files, as root: `$1` is the mode, `$2` the address the names point at, the rest
 * the names. Lines it wrote end in `# wlp-network`, and only those are replaced. The resolver file is
 * kept beside it before it is emptied, and put back for `open`. Writes in place, since a container's
 * name files are bind mounts. Prints `network <mode>` when done.
 */
export const GUEST_DNS_SCRIPT = `set -eu
mode=$1; addr=$2; shift 2
umask 022
{ grep -v ' # wlp-network$' /etc/hosts || true; for host in "$@"; do printf '%s %s # wlp-network\\n' "$addr" "$host"; done; } > /tmp/wlp-hosts
cat /tmp/wlp-hosts > /etc/hosts; rm -f /tmp/wlp-hosts
if [ "$mode" = open ]; then
  if [ -f /etc/resolv.conf.wlp ]; then cat /etc/resolv.conf.wlp > /etc/resolv.conf; rm -f /etc/resolv.conf.wlp; fi
else
  [ -f /etc/resolv.conf.wlp ] || cp /etc/resolv.conf /etc/resolv.conf.wlp
  : > /etc/resolv.conf
fi
echo "network $mode"`;

export function guestDnsArgv(network: E2bNetwork, address = PIN_ADDRESS): string[] {
	return ["/bin/sh", "-c", GUEST_DNS_SCRIPT, "wlp-network", network.mode, address, ...network.hosts];
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
