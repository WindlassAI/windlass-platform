// Runs as agent in the immutable base image. Only the broker has an uplink.
// Both ends of the filesystem socket live in helpers, outside every agent mount namespace.
import { lookup } from "node:dns/promises";
import { existsSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";

const socket = "/workspace/egress.sock";
function subnets(cidrs) {
	const list = new net.BlockList();
	for (const cidr of cidrs) {
		const [ip, prefix] = cidr.split("/");
		list.addSubnet(ip, Number(prefix), net.isIPv4(ip) ? "ipv4" : "ipv6");
	}
	return list;
}
const lan = subnets(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]);
const blocked = subnets(["0.0.0.0/8", "127.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "168.63.129.16/32",
	"192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4", "fd00:ec2::/32", "fd20:ce::254/128", "2001::/23", "2001:db8::/32", "2002::/16"]);
const globalV6 = subnets(["2000::/3"]);
export async function selectAddress(host, allow, resolve = lookup, interfaces = networkInterfaces(), denied = []) {
	if (denied.length && (net.isIP(host) || denied.includes(host.toLowerCase().replace(/\.$/, "")))) throw Error("blocked");
	const answers = net.isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
	const hostAndBridges = new net.BlockList();
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const { address, cidr } of entries ?? []) {
			const family = net.isIPv4(address) ? "ipv4" : "ipv6";
			hostAndBridges.addAddress(address, family);
			if (cidr && existsSync("/sys/class/net/" + name + "/bridge"))
				hostAndBridges.addSubnet(address, Number(cidr.split("/")[1]), family);
		}
	}
	for (const { address } of answers) {
		const family = net.isIPv4(address) ? "ipv4" : "ipv6";
		const privateLan = lan.check(address, family);
		if (!net.isIP(address) || blocked.check(address, family) || hostAndBridges.check(address, family)
			|| (privateLan && !allow.includes(host)) || (family === "ipv6" && !privateLan && !globalV6.check(address, family))
			|| (family === "ipv6" && address.toLowerCase().startsWith("::ffff:")))
			throw Error("blocked");
	}
	if (!answers.length) throw Error("unresolved");
	// Dial the checked IP. A second DNS lookup, even inside http.request, would reopen rebinding.
	return (answers.find(a => net.isIPv4(a.address)) ?? answers[0]).address;
}
// With an owner's list of public hosts (--egress-domains): the name is matched before any DNS lookup,
// so an unlisted name never reaches the machine's resolver. `*.name` is any subdomain, not the name.
export function listedHost(host, domains, allow = []) {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (!name || net.isIP(name)) return false;
	return allow.includes(name) || domains.some(entry => entry.startsWith("*.") ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : name === entry);
}
const MAX_RECORD = 16384;
// The one server_name of the ClientHello in the first TLS record. Undefined while the record is still
// incomplete; null for anything refused: not TLS, a hello split across records, a malformed length,
// no name, two names, a duplicated extension or Encrypted Client Hello (its outer name says nothing).
export function clientHelloName(data) {
	if (data.length < 1) return undefined;
	if (data[0] !== 0x16) return null;
	if (data.length < 5) return undefined;
	const length = data.readUInt16BE(3);
	if (data[1] !== 3 || length < 4 || length > MAX_RECORD) return null;
	if (data.length < 5 + length) return undefined;
	const record = data.subarray(5, 5 + length);
	if (record[0] !== 1) return null;
	const size = (record[1] << 16) | (record[2] << 8) | record[3];
	if (4 + size > record.length) return null;
	const hello = record.subarray(4, 4 + size);
	let at = 0;
	const take = n => {
		if (n < 0 || at + n > hello.length) throw Error("short");
		const part = hello.subarray(at, at + n);
		at += n;
		return part;
	};
	const u8 = () => take(1)[0], u16 = () => take(2).readUInt16BE(0);
	try {
		take(2 + 32);
		const session = u8();
		if (session > 32) return null;
		take(session);
		const suites = u16();
		if (suites < 2 || suites % 2) return null;
		take(suites);
		const compression = u8();
		if (compression < 1) return null;
		take(compression);
		const extensions = take(u16());
		if (at !== hello.length) return null;
		const seen = new Set();
		let name = null;
		for (let p = 0; p < extensions.length;) {
			if (p + 4 > extensions.length) return null;
			const type = extensions.readUInt16BE(p), len = extensions.readUInt16BE(p + 2);
			p += 4;
			if (p + len > extensions.length || seen.has(type)) return null;
			seen.add(type);
			const body = extensions.subarray(p, p + len);
			p += len;
			if (type === 0xfe0d || type === 0xffce) return null;
			if (type !== 0) continue;
			if (len < 2 || body.readUInt16BE(0) !== len - 2 || len < 5 || body[2] !== 0) return null;
			const nameLength = body.readUInt16BE(3);
			if (5 + nameLength !== len || nameLength < 1 || nameLength > 253) return null;
			name = body.subarray(5).toString("latin1").toLowerCase();
			if (!/^[a-z0-9.-]+$/.test(name)) return null;
		}
		return name;
	} catch {
		return null;
	}
}
function pipes(a, b) {
	a.on("error", () => b.destroy());
	b.on("error", () => a.destroy());
	a.on("close", () => b.destroy());
	b.on("close", () => a.destroy());
	a.pipe(b).pipe(a);
}
function headers(input) {
	const result = { ...input };
	for (const key of ["connection", "proxy-connection", "proxy-authenticate", "proxy-authorization", "keep-alive",
		"transfer-encoding", "te", "trailer", "upgrade", ...(input.connection ?? "").toLowerCase().split(",").map(s => s.trim())])
		delete result[key];
	return result;
}
// The address a request may go to. `tunnel`: a CONNECT (whose port is always explicit) rather than plain HTTP.
export async function targetAddress(url, tunnel, allow, denied, domains = null, device = false, resolve = lookup, interfaces = networkInterfaces()) {
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (device && (host !== "auth.openai.com" || url.port !== "443")) throw Error("blocked");
	if (!host || url.username || url.password) throw Error("blocked");
	// A list also limits the ports: HTTPS tunnels to 443, plain HTTP to 80.
	if (domains && (!listedHost(host, domains, allow) || url.port !== (tunnel ? "443" : ""))) throw Error("blocked");
	return selectAddress(host, allow, resolve, interfaces, denied);
}
function broker(allow, denied, device = false, domains = null) {
	const target = (url, tunnel) => targetAddress(url, tunnel, allow, denied, domains, device);
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url);
			if (device || url.protocol !== "http:") throw Error("blocked");
			const ip = await target(url, false);
			if (res.destroyed) return;
			const out = http.request({ hostname: ip, port: url.port || 80, method: req.method,
				path: url.pathname + url.search, headers: { ...headers(req.headers), host: url.host }, agent: false }, upstream => {
				res.writeHead(upstream.statusCode, headers(upstream.headers));
				upstream.on("error", () => res.destroy());
				upstream.pipe(res);
			});
			out.setTimeout(60_000, () => out.destroy());
			out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
			res.on("close", () => out.destroy());
			req.pipe(out);
		} catch (error) {
			res.writeHead(error.message === "blocked" ? 403 : 502);
			res.end(error.message === "blocked" ? "blocked by runner egress policy\n" : "upstream unavailable\n");
		}
	});
	server.on("connect", async (req, client, head) => {
		client.on("error", () => client.destroy());
		try {
			if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):[0-9]{1,5}$/i.test(req.url)) throw Error("blocked");
			const url = new URL("http://" + req.url);
			const ip = await target(url, true);
			if (client.destroyed) return;
			const out = net.connect(Number(url.port || 80), ip);
			client.on("close", () => out.destroy());
			out.setTimeout(300_000, () => out.destroy());
			out.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
			out.once("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (!domains) {
					if (head.length) out.write(head);
					return pipes(client, out);
				}
				// Only a TLS ClientHello naming the tunnel's own host is sent on.
				const host = url.hostname.replace(/\.$/, "").toLowerCase();
				let data = head;
				const refuse = () => { clearTimeout(timer); client.destroy(); out.destroy(); };
				const timer = setTimeout(refuse, 5_000);
				const read = chunk => {
					if (chunk) data = Buffer.concat([data, chunk]);
					const name = clientHelloName(data);
					if (name === undefined) return;
					client.off("data", read);
					client.pause();
					clearTimeout(timer);
					if (name !== host) return refuse();
					out.write(data);
					pipes(client, out);
				};
				client.on("close", () => clearTimeout(timer));
				client.on("data", read);
				read();
			});
		} catch (error) {
			client.end(error.message === "blocked" ? "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
		}
	});
	server.maxConnections = 256;
	rmSync(socket, { force: true });
	server.listen(socket);
}
if (process.argv[1] === "wlp-egress-device") broker([], [], true);
if (process.argv[1] === "wlp-egress-broker") broker(JSON.parse(process.argv[2]), JSON.parse(process.argv[3] ?? "[]"), false, JSON.parse(process.argv[4] ?? "null"));
// Only the trusted forwarder mounts these sockets. Write its fixed-width identity before
// connecting the agent byte stream so even a second HTTP request has the same identity.
export function forward(port, path, nonce, signedOutOnDisconnect = false) {
	const marker = path.replace(/[^/]+$/, "signed-out");
	const server = net.createServer(client => {
		const upstream = net.connect(path);
		if (signedOutOnDisconnect) {
			// The login volume and relay disappear at logout; the local endpoint survives. A relay that is
			// replaced (update, re-pair, new login) also goes away for a moment: only a logout leaves the marker.
			const signedOut = () => client.end(existsSync(marker)
				? "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
				: "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			client.on("error", () => upstream.destroy());
			client.on("close", () => upstream.destroy());
			upstream.once("error", signedOut);
			upstream.once("connect", () => {
				upstream.write(nonce);
				client.pipe(upstream);
				// If logout closes an outstanding request before its HTTP response,
				// the CLI can still receive the authentication status. The relay closes each connection after
				// one reply, so no reply on this connection means none to the request on it.
				let started = false;
				upstream.on("data", () => { started = true; });
				upstream.pipe(client, {end:false});
				upstream.off("error", signedOut);
				upstream.on("error", () => {});
				upstream.on("close", () => { if (started) client.end(); else signedOut(); });
			});
		} else {
			if (nonce) upstream.write(nonce);
			pipes(client, upstream);
		}
	});
	server.maxConnections = 128;
	return server.listen(port, "127.0.0.1");
}
if (process.argv[1] === "wlp-egress-forward") {
	if (process.argv[2] === "restricted") forward(17891, socket);
	if (process.argv[3]) forward(17892, "/run/wlp-relay/relay.sock", process.argv[3], process.argv[4] === "codex");
}
