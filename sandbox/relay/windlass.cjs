// Windlass's model relay (docs/model-relay.md). A Settings-key record holds a scoped platform
// placeholder; only the platform relay resolves the saved key. This container runs outside every
// session's namespaces. Each turn's ChatGPT access token is written into this container's private tmpfs,
// one file per turn's nonce: `{"accessToken", "expiresAt", "lease", "user"}`. The session gets only the
// lease (`wlp-model.<32 hex>`) as the bearer in its token file. The trusted forwarder in the session's
// network namespace prefixes each connection with the turn's nonce, so the bearer counts only on that
// turn's connections, and only while its file is here. When the file goes (the turn ended) or its token
// expires, the turn's requests still running are stopped, and an expired file is deleted.
const { timingSafeEqual } = require('node:crypto');
const { readFile, readdir, unlink } = require('node:fs/promises');
const { rmSync, watch } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { createRelay, scrubStream, stopOnSignal } = require('./server.cjs');

const TOKENS = '/run/wlp-model/tokens';
// The socket volume is mounted at /workspace, which the image gives to agent, so the relay can make its socket there.
const SOCKET = '/workspace/relay.sock';
/** What Windlass sends as Host to `WINDLASS_MODEL_BASE_URL=http://127.0.0.1:17893/v1`. */
const HOST = '127.0.0.1:17893';
const LEASE = /^wlp-model\.[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const { wires, wirePath, wireMethod: methodFor, forwardHost, forwardPlaceholder, validProofKey, forwardProof, proofHeader } = require('./wires.cjs');
function anyMethod(path) {
	for (const provider of Object.keys(wires)) {
		const method = methodFor(provider, path);
		if (method) return method;
	}
}
function placeholderOf(headers) {
	const auth = [headers.authorization, headers['x-api-key'], headers['x-goog-api-key']].filter(value => value !== undefined);
	if (auth.length !== 1 || typeof auth[0] !== 'string') return;
	return headers.authorization ? /^Bearer (\S+)$/.exec(auth[0])?.[1] : auth[0];
}
// Transport, proxy and SDK metadata is discarded at the relay.
const transport = new Set(['content-type', 'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'accept-language',
	'via', 'forwarded', 'cdn-loop', 'traceparent', 'tracestate', 'x-real-ip', 'sec-fetch-mode', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']);
function wireTarget(provider, path, incoming, credential) {
	const method = methodFor(provider, path);
	if (!method) return;
	const wire = wires[provider];
	const auth = wire.auth ?? 'authorization';
	if (!(incoming[auth] || incoming.authorization) || !placeholderOf(incoming)) return;
	const headers = { [auth]: wire.auth ? credential : 'Bearer ' + credential };
	for (const [name, value] of Object.entries(wire.fixed ?? {})) {
		if (incoming[name] !== undefined && incoming[name] !== value) return;
		headers[name] = value;
	}
	if (wire.betas && incoming['anthropic-beta'] !== undefined) {
		const beta = incoming['anthropic-beta'];
		if (method !== 'POST' || typeof beta !== 'string') return;
		const values = beta.split(',').map(value => value.trim());
		if (!values.every(value => wire.betas.includes(value))) return;
		headers['anthropic-beta'] = values.join(',');
	}
	if (provider === 'openai' && method === 'POST' && incoming['content-encoding'] === 'zstd') headers['content-encoding'] = 'zstd';
	for (const [name, value] of Object.entries(incoming)) {
		if ((name === 'accept' || name === 'user-agent' || (name === 'content-type' && method === 'POST') || wire.passed?.includes(name)) && typeof value === 'string') headers[name] = value;
		else if (!wire.dropUnknown && !wire.drop?.includes(name) && name !== 'authorization' && !Object.hasOwn(headers, name) && !transport.has(name)
			&& !/^(?:cf-|x-forwarded-|x-stainless-)/.test(name)) return;
	}
	return { hostname: wire.host, path: wirePath(provider, path), headers };
}
// Room for a long code or message, never a body of its own.
const CODE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The provider's error, as Windlass classifies it (openai-responses-error.ts `readErrorBody`): the code,
 * the type, the parameter and a message, each from the provider's body, scrubbed of every token and cut
 * short. Nothing else of the body (request ids, account names) is passed on.
 */
function errorBody(status, text, secrets = []) {
	let code = null, type = null, param = null, message = '';
	try {
		const parsed = JSON.parse(text);
		const error = parsed && typeof parsed === 'object' ? (parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed) : {};
		if (typeof error.code === 'string' && CODE.test(error.code)) code = error.code;
		if (typeof error.type === 'string' && CODE.test(error.type)) type = error.type;
		if (typeof error.param === 'string' && CODE.test(error.param)) param = error.param;
		message = typeof error.message === 'string' ? error.message : typeof parsed?.detail === 'string' ? parsed.detail : '';
	} catch {
		message = text.trim();
	}
	if ((status === 401 || status === 403) && /api key/i.test(message)) message = 'The provider rejected the API key.';
	for (const secret of secrets) {
		if (!secret) continue;
		message = message.split(secret).join('[redacted]');
		if (code?.includes(secret)) code = null;
		if (type?.includes(secret)) type = null;
		if (param?.includes(secret)) param = null;
	}
	// eslint-disable-next-line no-control-regex
	message = message.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 1000) || `The provider answered HTTP ${status}.`;
	return JSON.stringify({ error: { message, type, code, ...(param && { param }) } });
}

/** What a relay refusal of its own says, so that the platform tells it from the provider turning the token down. */
const LEASE_ENDED = 'relay_lease_ended';
/** How often the relay looks at the leases of the requests it runs, and at expired files. */
const WATCH_MS = 1000, SWEEP_MS = 60_000;

/** Constant-time comparison of two short strings. */
function same(a, b) {
	const x = Buffer.from(String(a)), y = Buffer.from(String(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * `load(nonce)`: the turn's record, or a rejection when there is none. `upstream`: where the requests go,
 * `api.openai.com:443` but in the relay's own checks.
 */
function windlassProvider({ load = nonce => readFile(`${TOKENS}/${nonce}.json`, 'utf8').then(JSON.parse),
	upstream, machine = process.env.WLP_MODEL_RELAY_MACHINE, now = Date.now,
	list = () => readdir(TOKENS), remove = name => unlink(`${TOKENS}/${name}`), changes = onChange => watch(TOKENS, onChange),
	watchMs = WATCH_MS, sweepMs = SWEEP_MS } = {}) {
	/** The record of a turn whose lease is live: its file is here, well-formed and not expired. */
	async function lease(nonce) {
		if (!NONCE.test(nonce ?? '')) return;
		const record = await load(nonce).catch(() => undefined);
		if (!record || typeof record.lease !== 'string' || !LEASE.test(record.lease)
			|| !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now()) return;
		const forward = record.forward;
		if (forward) {
			if (!Object.hasOwn(wires, forward.provider) || forward.provider === 'chatgpt') return;
			if (!forwardHost(forward.host) || !forwardPlaceholder(forward.placeholder)) return;
			if (machine && !validProofKey(forward.proofKey)) return;
		} else if (typeof record.accessToken !== 'string' || !/^[\x21-\x7e]{16,16384}$/.test(record.accessToken)) return;
		if (record.user !== undefined && (typeof record.user !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(record.user))) return;
		return record;
	}
	/** Deletes every file whose token has expired, or that is no record at all: nothing keeps a dead lease's token. */
	async function sweep() {
		const names = await list().catch(() => []);
		for (const name of names) {
			const nonce = /^([a-f0-9]{32})\.json$/.exec(name)?.[1];
			// A `.tmp` is a write in progress (SECRET_FILE_SCRIPT): left to its writer.
			if (name.endsWith('.tmp')) continue;
			if (!nonce || !(await lease(nonce))) await remove(name).catch(() => {});
		}
	}
	return {
		methodFor: anyMethod,
		bearer: placeholderOf,
		unauthorizedCode: LEASE_ENDED,
		async authorize(bearer, nonce) {
			if (!LEASE.test(bearer ?? '')) return false;
			const record = await lease(nonce);
			if (!record || !same(bearer, record.lease)) return false;
			// The user, where the platform named one: the hosted relay's ceiling per user counts by it.
			return { user: record.user };
		},
		/**
		 * The relay's lease ends with the turn's file: `close` removes it, and the requests of that nonce still
		 * running are stopped then, not when they would have finished. A change in the directory is looked at
		 * at once, and every running nonce once a second besides; expired files are deleted once a minute.
		 */
		watch(relay) {
			let checking = false;
			const check = async () => {
				if (checking) return;
				checking = true;
				try {
					for (const nonce of relay.activeSessions()) if (!(await lease(nonce))) relay.endSession(nonce);
				} finally { checking = false; }
			};
			const timers = [setInterval(check, watchMs), setInterval(() => { void sweep(); }, sweepMs)];
			for (const timer of timers) timer.unref?.();
			let watcher;
			try { watcher = changes(() => { void check(); }); watcher?.on?.('error', () => {}); } catch {}
			void sweep();
			relay.on('close', () => { for (const timer of timers) clearInterval(timer); watcher?.close?.(); });
		},
		// Read again here: a token replaced while the request waited for a slot is the one sent.
		async target(url, headers, nonce) {
			const record = await lease(nonce);
			if (!record) return;
			const forward = record.forward;
			const secret = forward?.placeholder ?? record.accessToken;
			const target = wireTarget(forward?.provider ?? 'chatgpt', url, headers, secret);
			if (!target) return { refused: true };
			const secrets = [secret];
			if (forward) {
				if (machine) {
					const proof = forwardProof(forward.proofKey, machine, methodFor(forward.provider, url), url, now());
					target.headers[proofHeader] = proof;
					secrets.push(proof);
				}
				target.hostname = forward.host;
				target.path = '/model-relay' + url;
			}
			return { ...target, ...upstream, secrets };
		},
		responseFilter: (type, url, secrets) => scrubStream(secrets ?? [], type, true),
		// api.openai.com answers a ChatGPT-token stream with a 200 and no content type (as the server's route found,
		// server/src/model-relay-route.ts); Windlass reads it as an event stream whatever it says.
		untyped: (method, url) => (method === 'POST' && url.split('?')[0] === '/v1/responses' ? 'text/event-stream' : null),
		errorBody,
	};
}

module.exports = { windlassProvider, errorBody, wireTarget, anyMethod, placeholderOf, HOST, TOKENS, SOCKET, LEASE_ENDED };

if (process.env.WLP_MODEL_RELAY_PROGRAM === '1') {
	// The relay's own checks send the requests to a recorder instead (docs/model-relay.md, "Checks").
	const target = process.env.WLP_MODEL_RELAY_UPSTREAM ? new URL(process.env.WLP_MODEL_RELAY_UPSTREAM) : null;
	const upstream = target ? { hostname: target.hostname, port: Number(target.port || (target.protocol === 'http:' ? 80 : 443)) } : undefined;
	const limits = process.env.WLP_MODEL_RELAY_LIMITS ? JSON.parse(process.env.WLP_MODEL_RELAY_LIMITS) : undefined;
	const provider = windlassProvider({ upstream });
	rmSync(SOCKET, { force: true });
	stopOnSignal(createRelay({ provider, host: HOST, limits, forward: target?.protocol === 'http:' ? http.request : https.request })
		.listen(SOCKET), provider);
}
