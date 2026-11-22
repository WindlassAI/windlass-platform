import { isIP } from "node:net";
import { egressMode } from "../../server/src/runner/control.js";
import type { EgressMode } from "../../server/src/contract.js";
import { MODEL_HOSTS, PRESETS } from "../../server/src/sandbox/e2b/network.js";
import { PUBLIC_SUFFIX_RULES } from "./public-suffixes.js";
import { RunnerError } from "./state.js";

/**
 * `allow`: private-network names the proxy may connect to. `domains` (absent: any public host): the owner's
 * public hosts, presets expanded, matched by name before any DNS lookup; `*.name` is any subdomain. The
 * platform's hosts are not saved with them: `listedHosts` adds them where the list is used.
 */
export interface Egress { mode: EgressMode; allow: string[]; domains?: string[] }
export const restricted: Egress = { mode: "restricted", allow: [] };
export const open: Egress = { mode: "open", allow: [] };
/** The git host of a platform that names none (one older than the welcome's `gitHost`): hosted's default WLP_GITHUB_URL. */
export const DEFAULT_GIT_HOST = "github.com";
/**
 * The hosts a list always has, as the hosted list does (e2b/network.ts): the platform's own clone, fetch and
 * push use the same proxy, against the git host the platform names in its welcome (`gitHost`), and so do
 * Windlass's model requests from the sandbox. Sorted, each once.
 */
export function listedHosts(domains: readonly string[], gitHost = DEFAULT_GIT_HOST): string[] {
	return [...new Set([...domains, ...MODEL_HOSTS, gitHost])].sort();
}
/** The note `status` prints after each of the platform's hosts. */
export function platformHostNote(host: string, gitHost?: string): string | undefined {
	if (MODEL_HOSTS.includes(host)) return "always: Windlass's model requests use it; refused to commands in Codex and OpenCode sessions";
	if (host === (gitHost ?? DEFAULT_GIT_HOST)) return gitHost ? "always: the platform's git host" : "always until the platform names its git host: the platform's git uses it";
}
const MAX_HOSTS = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dnsName = (host: string, labels = 1) => host.length <= 253 && host.split(".").length >= labels
	&& host.split(".").every(label => LABEL.test(label)) && !isIP(host) && !/^\d+$/.test(host.split(".").at(-1)!);
export const DOMAINS_REFUSED = `Use --egress-domains with restricted and up to ${MAX_HOSTS - MODEL_HOSTS.length - 1} comma-separated public DNS names, *.name for any subdomain, or the presets ${Object.keys(PRESETS).join(", ")}.`;

/**
 * The names under which different owners' sites live (publicsuffix.org, ICANN and private sections): a
 * country's `co.uk`, and a hosting service's `github.io`, `s3.amazonaws.com` or `workers.dev`.
 */
let suffixes: { exact: Set<string>; wild: Set<string>; except: Set<string>; above: Set<string> } | undefined;
function suffixRules() {
	if (suffixes) return suffixes;
	suffixes = { exact: new Set(), wild: new Set(), except: new Set(), above: new Set() };
	for (const rule of PUBLIC_SUFFIX_RULES.split(" ")) {
		if (rule.startsWith("!")) { suffixes.except.add(rule.slice(1)); continue; }
		const name = rule.startsWith("*.") ? rule.slice(2) : rule;
		(rule.startsWith("*.") ? suffixes.wild : suffixes.exact).add(name);
		for (let at = name.indexOf("."); at !== -1; at = name.indexOf(".", at + 1)) suffixes.above.add(name.slice(at + 1));
	}
	return suffixes;
}
/**
 * The public suffix at or under `base`, if any: `*.base` would then take names that belong to different
 * owners. `amazonaws.com` is no suffix itself, but `s3.amazonaws.com` under it is.
 */
export function sharedSuffix(base: string): string | undefined {
	const { exact, wild, except, above } = suffixRules();
	const parent = base.slice(base.indexOf(".") + 1);
	if (exact.has(base) || (wild.has(parent) && !except.has(base))) return base;
	if (wild.has(base) || above.has(base))
		return [...exact, ...[...wild].map(name => "*." + name)].find(name => name.endsWith("." + base)) ?? base;
}
/** The entries of --egress-domains, presets (the hosted list's, `WLP_E2B_NETWORK_ALLOW`) expanded. */
export function domainList(raw: string): string[] {
	const out: string[] = [];
	for (const entry of raw.toLowerCase().split(",").map(item => item.trim().replace(/\.$/, "")).filter(Boolean)) {
		const preset = PRESETS[entry];
		if (preset) { out.push(...preset); continue; }
		if (!(entry.startsWith("*.") ? dnsName(entry.slice(2), 2) : dnsName(entry, 2))) throw new RunnerError(DOMAINS_REFUSED);
		const shared = entry.startsWith("*.") ? sharedSuffix(entry.slice(2)) : undefined;
		if (shared) throw new RunnerError(`--egress-domains: ${entry} is refused. ${shared === entry.slice(2) ? shared + " is" : shared + ", under it, is"} a public suffix (publicsuffix.org): different owners' sites live under it, so the wildcard would let commands reach anyone's site there. Name the exact hosts instead.`);
		out.push(entry);
	}
	const unique = [...new Set(out)].sort();
	// One place is kept for the git host the platform names, which may not be github.com.
	if (new Set([...unique, ...MODEL_HOSTS]).size + 1 > MAX_HOSTS) throw new RunnerError(DOMAINS_REFUSED);
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
