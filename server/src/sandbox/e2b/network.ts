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

import { type EgressMode, NETWORK_PRESETS, type NetworkPreset } from "../../contract.js";

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

/**
 * The deployment's network with the hosts a session's repositories allow added (repository-network.ts):
 * only in `restricted`, where a repository's list applies; `open` and `none` are as the deployment has
 * them. The platform's and the deployment's hosts come first: when the whole would pass MAX_HOSTS, the
 * repository's hosts that do not fit are left out and named in `dropped` (a save refuses a list that
 * cannot fit, so this happens only when the deployment's own list grew after it).
 */
export function withHosts(network: E2bNetwork, extra: readonly string[] | undefined): { network: E2bNetwork; dropped: string[] } {
	if (network.mode !== "restricted" || !extra || extra.length === 0) return { network, dropped: [] };
	const hosts = new Set(network.hosts);
	const dropped: string[] = [];
	for (const host of [...new Set(extra)].sort()) {
		if (hosts.has(host) || !isHostName(host)) continue;
		if (hosts.size >= MAX_HOSTS) dropped.push(host);
		else hosts.add(host);
	}
	return { network: { mode: network.mode, hosts: [...hosts].sort() }, dropped };
}

/** What E2B is asked for. Null in `open`: nothing is sent, as before network modes. */
export function networkConfig(network: E2bNetwork): E2bNetworkConfig | null {
	if (network.mode === "open") return null;
	return { denyOut: ["0.0.0.0/0"], allowOut: [...network.hosts], dnsServers: [] };
}

/** Where the sandbox's lookup stub writes the names it was asked for (`DNS_STUB`), one line each, the first time each is asked. */
export const DNS_LOG = "/var/log/wlp-dns.log";
/** The most the stub writes to DNS_LOG, give or take its last line. */
export const DNS_LOG_BYTES = 262_144;

/**
 * The lookup stub of a sandbox out of `open`: a resolver on 127.0.0.1:53 that answers every question
 * NXDOMAIN at once and writes the name asked for to DNS_LOG. Every name it is asked for is one that
 * /etc/hosts does not pin: glibc, Go, Python, Node and curl all read the names file first and ask the
 * resolver of /etc/resolv.conf only for what is not in it, and E2B lets nothing else out, so a name
 * here is a host a command wanted and could not reach. That is the signal the session's timeline
 * names a blocked host by (docs/operating.md, "E2B", "Network").
 *
 * It is started as root, so it can bind port 53, opens the log as root, then runs as `nobody` (where
 * root may not change its user, as in a container without capabilities, it stays root): the agent can
 * neither write the log nor stop the stub. It is a reporter, not a fence: what a sandbox
 * reaches is E2B's filter's to decide, and the stub's answer is the same failure an empty resolver
 * gave. Each name is written once, at most 2,000 names and 256 KiB; a name with anything but letters,
 * digits, "-" and "_" in a label is not written. It answers one question at a time, so a TCP connection
 * has one second in all to send its question and take the answer: a client that sends a byte now and
 * then cannot hold the stub, and every lookup behind it, for longer than that.
 *
 * The guest script writes it to /run/wlp-dns.py, which root owns everywhere (a directory a tarball made,
 * such as /usr/local/lib, may not be root's, and root without capabilities cannot write there).
 *
 *   python3 -I wlp-dns.py <port> <log file>
 */
export const DNS_STUB = `import os, re, select, socket, sys, time
port, log = int(sys.argv[1]), sys.argv[2]
fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
udp.bind(("127.0.0.1", port))
tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
tcp.bind(("127.0.0.1", port))
tcp.listen(16)
if os.getuid() == 0:
    try:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
    except OSError:
        pass
LABEL = re.compile(rb"[A-Za-z0-9_-]{1,63}")
seen = set()
written = 0
def question(m):
    if len(m) < 12 or m[4] != 0 or m[5] != 1:
        return None
    i, labels = 12, []
    while True:
        if i >= len(m):
            return None
        n = m[i]
        i += 1
        if n == 0:
            break
        if n > 63 or i + n > len(m):
            return None
        labels.append(m[i:i + n])
        i += n
        if sum(len(x) + 1 for x in labels) > 254:
            return None
    if i + 4 > len(m):
        return None
    name = b".".join(labels).lower() if all(LABEL.fullmatch(x) for x in labels) else b""
    return name.decode("ascii"), (m[i] << 8) | m[i + 1], i + 4
def note(name, qtype):
    global written
    if not name or name in seen or len(seen) >= 2000 or written > ${DNS_LOG_BYTES}:
        return
    seen.add(name)
    line = ("%d %d %s\\n" % (int(time.time()), qtype, name)).encode("ascii")
    written += len(line)
    try:
        os.write(fd, line)
    except OSError:
        pass
def reply(m):
    if len(m) < 12:
        return None
    q = question(m)
    if q is None:
        return m[:2] + bytes([0x80 | (m[2] & 0x79), 0x81]) + bytes(8)
    note(q[0], q[1])
    return m[:2] + bytes([0x80 | (m[2] & 0x79), 0x83, 0, 1]) + bytes(6) + m[12:q[2]]
def exactly(c, n, deadline):
    data = b""
    while len(data) < n:
        left = deadline - time.monotonic()
        if left <= 0:
            raise OSError("slow")
        c.settimeout(left)
        part = c.recv(n - len(data))
        if not part:
            raise OSError("closed")
        data += part
    return data
while True:
    ready, _, _ = select.select([udp, tcp], [], [])
    for s in ready:
        if s is udp:
            try:
                m, a = udp.recvfrom(4096)
                out = reply(m)
                if out:
                    udp.sendto(out, a)
            except OSError:
                pass
        else:
            try:
                c, _ = tcp.accept()
            except OSError:
                continue
            try:
                deadline = time.monotonic() + 1
                n = int.from_bytes(exactly(c, 2, deadline), "big")
                out = reply(exactly(c, n, deadline))
                left = deadline - time.monotonic()
                if out and left > 0:
                    c.settimeout(left)
                    c.sendall(len(out).to_bytes(2, "big") + out)
            except (OSError, ValueError):
                pass
            finally:
                c.close()
`;

/**
 * The sandbox's own name files, as root: `$1` is the mode, `$2` the address the names point at, the rest
 * the names. Lines it wrote end in `# wlp-network`, and only those are replaced. The resolver file is
 * kept beside it before it is replaced, and put back for `open`. Out of `open` the resolver is the
 * lookup stub on 127.0.0.1 (`DNS_STUB`), started once and kept running across connects; `open` stops
 * it. Without python3 the resolver file names the stub all the same and nothing answers there, so every
 * lookup still fails at once, as an empty one did. Writes in place, since a container's name files are
 * bind mounts. Prints `network <mode>` when done.
 *
 * Two runs at once (a turn's connect and a host allowed from the session) would otherwise read the
 * names file while the other is rewriting it, and could write it back empty, without localhost. So the
 * whole script holds a lock, /run/wlp-network.lock (root's alone: the agent cannot open it to hold it),
 * and stages the new file under a name of its own in /run, never a fixed one in /tmp where the agent
 * could put a file first. E2bSandboxes also runs one change per sandbox at a time (`E2bSandboxes.serial`),
 * so E2B's list and this file are changed in the same order.
 */
export const GUEST_DNS_SCRIPT = `set -eu
mode=$1; addr=$2; shift 2
umask 077
exec 9>>/run/wlp-network.lock
flock -w 25 9 || { echo "another change of the sandbox's network held its lock for 25 s" >&2; exit 1; }
umask 022
tmp=$(mktemp /run/wlp-hosts.XXXXXX)
trap 'rm -f "$tmp"' EXIT
{ grep -v ' # wlp-network$' /etc/hosts || true; for host in "$@"; do printf '%s %s # wlp-network\\n' "$addr" "$host"; done; } > "$tmp"
cat "$tmp" > /etc/hosts
running() { [ -f /run/wlp-dns.pid ] && kill -0 "$(cat /run/wlp-dns.pid)" 2>/dev/null; }
if [ "$mode" = open ]; then
  if running; then kill "$(cat /run/wlp-dns.pid)" 2>/dev/null || true; fi
  rm -f /run/wlp-dns.pid
  if [ -f /etc/resolv.conf.wlp ]; then cat /etc/resolv.conf.wlp > /etc/resolv.conf; rm -f /etc/resolv.conf.wlp; fi
else
  [ -f /etc/resolv.conf.wlp ] || cp /etc/resolv.conf /etc/resolv.conf.wlp
  printf 'nameserver 127.0.0.1\\noptions timeout:1 attempts:1\\n' > /etc/resolv.conf
  if ! running && command -v python3 >/dev/null 2>&1; then
    cat > /run/wlp-dns.py <<'WLP_DNS_STUB'
${DNS_STUB}WLP_DNS_STUB
    setsid python3 -I /run/wlp-dns.py 53 ${DNS_LOG} </dev/null >/dev/null 2>&1 9>&- &
    echo $! > /run/wlp-dns.pid
  fi
fi
echo "network $mode"`;

/**
 * The names a sandbox's lookup stub wrote to DNS_LOG, from the log's text: each once, in the order
 * first asked, lower case, without reverse lookups, single labels and the names `skip` has (the allowed
 * ones, since a command may ask for an allowed name's IPv6 address, which /etc/hosts does not pin, and
 * the ones the caller named already). At most `limit`, counted after those are left out, so names
 * named already never hide one that was not.
 */
export function blockedLookups(log: string, skipped: Iterable<string>, limit = 50): string[] {
	const skip = new Set(skipped);
	const out: string[] = [];
	for (const line of log.split("\n")) {
		const name = /^\d+ \d+ (\S+)$/.exec(line.trim())?.[1]?.toLowerCase().replace(/\.$/, "");
		if (!name || skip.has(name) || out.includes(name) || /\.(in-addr|ip6)\.arpa$/.test(name) || name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || !isHostName(name)) continue;
		out.push(name);
		if (out.length >= limit) break;
	}
	return out;
}

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
