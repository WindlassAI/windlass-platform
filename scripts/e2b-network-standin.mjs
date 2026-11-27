// A stand-in of E2B's egress filter and of the hosts behind it, for scripts/e2b-provider-test.ts --docker.
// It runs in a throwaway container of the sandbox image on an internal Docker network, beside the fake
// sandboxes, and does to their traffic what E2B's documentation says E2B does
// (https://docs.e2b.dev/network/internet-access.md): with no configuration everything passes; with one, a
// TLS connection on 443 passes when its server name is allowed and an HTTP request on 80 when its Host is,
// and E2B, not the sandbox, connects to the name; nothing else passes. A resolver answers every name with
// this container's address while the sandbox may reach one (no configuration, or `dnsServers` other than []).
//
// Behind the filter, one TLS server answers for every name (a fixture certificate the sandboxes trust):
// github.com serves the bare repository /tmp/git/acme/demo.git through git http-backend (a CGI on
// 127.0.0.1:8081), api.openai.com answers 401 as the model API does without a key, a PUT is stored and
// answered 200 (the bucket), and any other name answers 200 "fixture <name>", so an unfiltered request
// is visible. The configuration of each sandbox is read per connection from /tmp/policies/<its address>.json.
//
//   node --input-type=module -e "<this file>" -- wlp-e2b-standin <own address> <key file> <cert file>
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const [address, keyFile, certFile] = process.argv.slice(2);
const policy = source => {
	try {
		return {
			known: true,
			config: JSON.parse(readFileSync(`/tmp/policies/${source.replace(/^::ffff:/, "")}.json`, "utf8")),
		};
	} catch {
		return { known: false, config: undefined };
	}
};
const allowed = (config, name) => {
	if (config === null) return true;
	if (!config || !name) return false;
	const host = name.toLowerCase().replace(/\.$/, "");
	return (config.allowOut ?? []).some(
		rule => rule === "*" || rule === host || (rule.startsWith("*.") && host.endsWith(rule.slice(1))),
	);
};

// The server name of a TLS ClientHello, or null. Every length is checked against what is there.
export function serverName(buffer) {
	let at = 5;
	if (buffer.length < 9 || buffer[0] !== 22 || buffer[at] !== 1) return null;
	at += 4 + 2 + 32;
	const skip = size => {
		if (at + size > buffer.length) return false;
		const length = size === 1 ? buffer[at] : buffer.readUInt16BE(at);
		at += size + length;
		return at <= buffer.length;
	};
	if (!skip(1) || !skip(2) || !skip(1) || at + 2 > buffer.length) return null;
	const end = at + 2 + buffer.readUInt16BE(at);
	at += 2;
	while (at + 4 <= Math.min(end, buffer.length)) {
		const type = buffer.readUInt16BE(at);
		const length = buffer.readUInt16BE(at + 2);
		at += 4;
		if (type === 0 && at + 5 <= buffer.length && buffer[at + 2] === 0) {
			const size = buffer.readUInt16BE(at + 3);
			return at + 5 + size <= buffer.length ? buffer.subarray(at + 5, at + 5 + size).toString("ascii") : null;
		}
		at += length;
	}
	return null;
}

// The filter: read the start of a connection, decide by name, hand it on to the fixture or drop it.
function filter(port, upstream, nameOf) {
	net
		.createServer(socket => {
			const { config } = policy(socket.remoteAddress ?? "");
			let head = Buffer.alloc(0);
			const timer = setTimeout(() => socket.destroy(), 5000);
			socket.on("error", () => {});
			const onData = chunk => {
				head = Buffer.concat([head, chunk]);
				const name = nameOf(head);
				if (name === undefined && head.length < 16384) return;
				socket.off("data", onData);
				clearTimeout(timer);
				if (!allowed(config, name ?? null)) return socket.destroy();
				const out = net.connect(upstream, "127.0.0.1", () => {
					out.write(head);
					socket.pipe(out).pipe(socket);
				});
				out.on("error", () => socket.destroy());
			};
			socket.on("data", onData);
		})
		.listen(port, address);
}
// undefined: not enough bytes yet.
const tlsName = head => {
	if (head.length < 5) return undefined;
	if (head.length < 5 + head.readUInt16BE(3)) return undefined;
	return serverName(head);
};
const hostHeader = head => {
	const text = head.toString("latin1");
	if (!text.includes("\r\n\r\n")) return undefined;
	return /\r\nhost:\s*([^\r\n:]+)/i.exec(text)?.[1] ?? null;
};
filter(443, 8443, tlsName);
filter(80, 8080, hostHeader);

// The hosts behind it.
function answer(request, response) {
	const host = (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
	if (host === "github.com" && request.url.startsWith("/acme/")) {
		const forward = http.request(
			{
				host: "127.0.0.1",
				port: 8081,
				method: request.method,
				path: "/cgi-bin/git" + request.url,
				headers: request.headers,
			},
			reply => {
				response.writeHead(reply.statusCode ?? 502, reply.headers);
				reply.pipe(response);
			},
		);
		forward.on("error", () => response.destroy());
		request.pipe(forward);
		return;
	}
	let size = 0;
	request.on("data", chunk => (size += chunk.length));
	request.on("end", () => {
		if (host === "api.openai.com") {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "fixture api.openai.com: no key" } }));
		} else if (request.method === "PUT") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(`stored ${size} at ${host}\n`);
		} else {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(`fixture ${host}\n`);
		}
	});
}
https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, answer).listen(8443, "127.0.0.1");
http.createServer(answer).listen(8080, "127.0.0.1");

// The resolver a sandbox may or may not reach: every name is this container.
const dns = dgram.createSocket("udp4");
dns.on("message", (query, from) => {
	const { known, config } = policy(from.address);
	if (!known || (config && Array.isArray(config.dnsServers) && config.dnsServers.length === 0)) return;
	if (query.length < 12) return;
	let at = 12;
	while (at < query.length && query[at] !== 0) at += query[at] + 1;
	const question = query.subarray(12, at + 5);
	const type = query.readUInt16BE(at + 1);
	const header = Buffer.from(query.subarray(0, 12));
	header.writeUInt16BE(0x8180, 2);
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(type === 1 ? 1 : 0, 6);
	header.writeUInt32BE(0, 8);
	const record =
		type === 1
			? Buffer.concat([
					Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4]),
					Buffer.from(address.split(".").map(Number)),
				])
			: Buffer.alloc(0);
	dns.send(Buffer.concat([header, question, record]), from.port, from.address);
});
dns.bind(53, address);
console.log("standin ready");
