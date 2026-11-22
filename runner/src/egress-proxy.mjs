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
function broker(allow, denied, device = false) {
	const target = async url => {
		const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
		if (device && (host !== "auth.openai.com" || url.port !== "443")) throw Error("blocked");
		if (!host || url.username || url.password) throw Error("blocked");
		return selectAddress(host, allow, lookup, networkInterfaces(), denied);
	};
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url);
			if (device || url.protocol !== "http:") throw Error("blocked");
			const ip = await target(url);
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
			const ip = await target(url);
			if (client.destroyed) return;
			const out = net.connect(Number(url.port || 80), ip);
			client.on("close", () => out.destroy());
			out.setTimeout(300_000, () => out.destroy());
			out.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
			out.once("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) out.write(head);
				pipes(client, out);
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
if (process.argv[1] === "wlp-egress-broker") broker(JSON.parse(process.argv[2]), JSON.parse(process.argv[3] ?? "[]"));
// Only the trusted forwarder mounts these sockets. Write its fixed-width identity before
// connecting the agent byte stream so even a second HTTP request has the same identity.
function forward(port, path, nonce, signedOutOnDisconnect = false) {
	const server = net.createServer(client => {
		const upstream = net.connect(path);
		if (signedOutOnDisconnect) {
			// The login volume and relay disappear at logout; the local endpoint survives.
			const signedOut = () => client.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			client.on("error", () => upstream.destroy());
			client.on("close", () => upstream.destroy());
			upstream.once("error", signedOut);
			upstream.once("connect", () => {
				upstream.write(nonce);
				client.pipe(upstream);
				// If logout closes an outstanding request before its HTTP response,
				// the CLI can still receive the authentication status.
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
	server.listen(port, "127.0.0.1");
}
if (process.argv[1] === "wlp-egress-forward") {
	if (process.argv[2] === "restricted") forward(17891, socket);
	if (process.argv[3]) forward(17892, "/run/wlp-relay/relay.sock", process.argv[3], process.argv[4] === "codex");
}
