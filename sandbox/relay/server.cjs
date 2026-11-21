// Runs in the trusted relay container. Only this process opens the login file.
// The trusted namespace forwarder prefixes each Unix stream with its fixed session nonce.
const { createPublicKey, verify } = require('node:crypto');
const net = require('node:net');
const { rmSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');

const messages = new Set(['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true']);
const requestHeaders = new Set(['accept', 'content-type', 'anthropic-beta', 'anthropic-version', 'user-agent', 'x-app',
	'anthropic-dangerous-direct-browser-access', 'x-client-request-id', 'x-claude-code-session-id']);

function reject(res, status) {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error',
		message: 'Claude credential relay refused the request.' } }));
}

exports.createRelay = function createRelay({ publicKey, machine,
	readToken = () => readFile('/run/wlp-harness/claude/token', 'utf8'), forward = https.request }) {
	const sessions = new WeakMap();
	const httpServer = http.createServer(async (req, res) => {
		try {
			if (req.headers.host !== '127.0.0.1:17892' || req.method !== 'POST' || !messages.has(req.url))
				return reject(res, 403);
			const match = /^Bearer ([a-f0-9]{32})\.([A-Za-z0-9_-]{86})$/.exec(req.headers.authorization ?? '');
			if (!match || !verify(null, Buffer.from('windlass-claude-relay-v2\n' + machine + '\n' + match[1]),
				publicKey, Buffer.from(match[2], 'base64url'))) return reject(res, 401);
			if (sessions.get(req.socket) !== match[1]) return reject(res, 401);
			const token = await readToken().catch(() => undefined);
			if (!token || token.length > 512 || !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token)) return reject(res, 401);

			const headers = { authorization: 'Bearer ' + token };
			for (const [key, value] of Object.entries(req.headers)) {
				if (requestHeaders.has(key) || key.startsWith('x-stainless-')) headers[key] = value;
			}
			if (res.destroyed) return;
			const up = forward({ hostname: 'api.anthropic.com', port: 443, method: 'POST', path: req.url, headers }, reply => {
				// No redirects, reflected upstream error bodies, cookies, or diagnostic headers.
				if (reply.statusCode !== 200) {
					reject(res, reply.statusCode >= 400 && reply.statusCode < 600 ? reply.statusCode : 502);
					reply.destroy();
					return;
				}
				const type = reply.headers['content-type']?.split(';')[0];
				if (type !== 'text/event-stream' && type !== 'application/json') {
					reject(res, 502); reply.destroy(); return;
				}
				res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
				reply.on('error', () => res.destroy());
				res.on('close', () => reply.destroy());
				reply.pipe(res);
			});
			up.on('error', () => {
				if (res.destroyed || res.writableEnded) return;
				if (res.headersSent) res.destroy(); else reject(res, 502);
			});
			up.setTimeout?.(600_000, () => up.destroy());
			res.on('close', () => up.destroy());
			req.on('error', () => up.destroy());
			req.pipe(up);
		} catch { if (!res.headersSent) reject(res, 502); else res.destroy(); }
	});
	// Consume exactly one identity before the HTTP parser sees this connection. The
	// remainder may already contain HTTP bytes or may arrive in subsequent packets.
	const ingress = net.createServer(socket => {
		socket.setTimeout(5000, () => socket.destroy());
		socket.on('error', () => socket.destroy());
		function identify() {
			const bytes = socket.read(32);
			if (!bytes) return;
			socket.removeListener('readable', identify);
			const nonce = bytes.toString('latin1');
			if (!/^[0-9a-f]{32}$/.test(nonce)) return socket.destroy();
			socket.setTimeout(0);
			sessions.set(socket, nonce);
			httpServer.emit('connection', socket);
			socket.resume();
		}
		socket.on('readable', identify);
	});
	// The HTTP parser receives sockets from ingress. Give it the matching server
	// lifecycle so Node enforces native header and request deadlines and clears its timer.
	ingress.on('listening', () => httpServer.emit('listening'));
	ingress.on('close', () => httpServer.close());
	ingress.maxConnections = 256;
	return ingress;
};

if (process.env.WLP_CLAUDE_RELAY_PUBLIC_KEY) {
	const publicKey = createPublicKey({ key: Buffer.from(process.env.WLP_CLAUDE_RELAY_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
	const socket = '/workspace/relay.sock';
	rmSync(socket, { force: true });
	exports.createRelay({ publicKey, machine: process.env.WLP_CLAUDE_RELAY_MACHINE }).listen(socket);
}
