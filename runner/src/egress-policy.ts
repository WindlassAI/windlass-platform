import { isIP } from "node:net";
import { egressMode } from "../../server/src/runner/control.js";
import type { EgressMode } from "../../server/src/contract.js";
import { MODEL_HOSTS, PRESETS } from "../../server/src/sandbox/e2b/network.js";
import { RunnerError } from "./state.js";

/**
 * `allow`: private-network names the proxy may connect to. `domains` (absent: any public host): the only
 * hosts the proxy connects to at all, matched by name before any DNS lookup; `*.name` is any subdomain.
 */
export interface Egress { mode: EgressMode; allow: string[]; domains?: string[] }
export const restricted: Egress = { mode: "restricted", allow: [] };
export const open: Egress = { mode: "open", allow: [] };
/**
 * The hosts a list always has, as the hosted list does (e2b/network.ts): the platform's own clone, fetch and
 * push use the same proxy, and so do Windlass's model requests from the sandbox. Each with the note `status` prints.
 */
export const PLATFORM_HOSTS: Readonly<Record<string, string>> = {
	"github.com": "the platform's git uses it",
	...Object.fromEntries(MODEL_HOSTS.map(host => [host, "Windlass's model requests use it"])),
};
const MAX_HOSTS = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dnsName = (host: string, labels = 1) => host.length <= 253 && host.split(".").length >= labels
	&& host.split(".").every(label => LABEL.test(label)) && !isIP(host) && !/^\d+$/.test(host.split(".").at(-1)!);
export const DOMAINS_REFUSED = `Use --egress-domains with restricted and up to ${MAX_HOSTS} comma-separated public DNS names, *.name for any subdomain, or the presets ${Object.keys(PRESETS).join(", ")}.`;
/** The entries of --egress-domains, presets (the hosted list's, `WLP_E2B_NETWORK_ALLOW`) expanded and the platform's hosts added. */
export function domainList(raw: string): string[] {
	const out = Object.keys(PLATFORM_HOSTS);
	for (const entry of raw.toLowerCase().split(",").map(item => item.trim().replace(/\.$/, "")).filter(Boolean)) {
		const preset = PRESETS[entry];
		if (preset) out.push(...preset);
		else if (entry.startsWith("*.") ? dnsName(entry.slice(2), 2) : dnsName(entry, 2)) out.push(entry);
		else throw new RunnerError(DOMAINS_REFUSED);
	}
	const unique = [...new Set(out)].sort();
	if (unique.length > MAX_HOSTS) throw new RunnerError(DOMAINS_REFUSED);
	return unique;
}
export function egressFlags(mode?: string, hosts?: string, domains?: string): Egress | undefined {
	if (mode === undefined && hosts === undefined && domains === undefined) return;
	mode ??= "restricted";
	if (!egressMode(mode)) throw new RunnerError("Use --egress open, restricted or none.");
	const allow = hosts === undefined ? [] : hosts.toLowerCase().split(",").map(host => host.trim());
	if (hosts !== undefined && (mode !== "restricted" || allow.length > MAX_HOSTS || allow.some(host => !dnsName(host))))
		throw new RunnerError("Use --egress-allow with restricted and up to 64 comma-separated DNS hostnames.");
	if (domains !== undefined && mode !== "restricted") throw new RunnerError(DOMAINS_REFUSED);
	return { mode, allow: [...new Set(allow)].sort(), ...(domains !== undefined && { domains: domainList(domains) }) };
}
