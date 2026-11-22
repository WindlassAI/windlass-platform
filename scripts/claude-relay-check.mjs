// Offline protocol checks. The Docker check also exercises the pinned adapter and the real TLS transport.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { connect } from 'node:net';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const machine = 'fixture-machine';
const nonce = randomBytes(16).toString('hex');
function credential(key = privateKey, session = nonce) {
	return session + '.' + sign(null, Buffer.from('windlass-claude-relay-v2\n' + machine + '\n' + session), key).toString('base64url');
}
const placeholder = credential();
const token = 'sk-ant-oat01-' + randomBytes(24).toString('hex');
let server, port, upstream, peer, login, sent, release;
before(async () => {
	const { createRelay } = await import('../sandbox/relay/server.cjs');
	server = createRelay({
		publicKey, machine, readToken: async () => login,
		forward: (options, callback) => {
			sent = options;
			const input = new PassThrough();
			input.resume();
			input.on('finish', () => {
				const response = new PassThrough();
				Object.assign(response, upstream);
				callback(response);
				response.write(upstream.first ?? (upstream.statusCode === 200 ? 'first\n' : token));
				release = () => response.end(upstream.last ?? 'last\n');
				if (!upstream.holdOpen) release();
			});
			return input;
		},
	});
	await new Promise(done => server.listen(0, '127.0.0.1', done));
	port = server.address().port;
});
after(() => { server?.close(); });
function reset() {
	sent = undefined;
	login = token;
	peer = nonce;
	upstream = { statusCode: 200, headers: { 'content-type': 'text/event-stream', 'x-private': token } };
}
function call({ bearer = placeholder, host = '127.0.0.1:17892', path = '/v1/messages?beta=true', method = 'POST' } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ createConnection() {
			const socket = connect(port, '127.0.0.1');
			socket.write(peer);
			return socket;
		}, method, path, headers: {
			host, authorization: 'Bearer ' + bearer, 'anthropic-beta': 'oauth-2025-04-20', 'x-api-key': 'untrusted',
		} }, resolve);
		req.setTimeout(5000, () => req.destroy(Error('No streamed response received')));
		req.on('error', reject);
		req.end('{}');
	});
}
async function responseStatus(options) {
	const res = await call(options);
	for await (const _ of res) { /* Drain the response before issuing the next request. */ }
	return res.statusCode;
}
test('rewrite only the bearer, use the pinned TLS origin, stream before upstream EOF', async () => {
	reset(); upstream.holdOpen = true;
	const res = await call();
	assert.equal(res.statusCode, 200);
	assert.equal(sent.hostname, 'api.anthropic.com');
	assert.equal(sent.headers.authorization, 'Bearer ' + token);
	assert.equal(sent.headers['anthropic-beta'], 'oauth-2025-04-20');
	assert.equal(sent.headers['x-api-key'], undefined);
	assert.equal(res.headers['x-private'], undefined);
	const chunks = res[Symbol.asyncIterator]();
	assert.equal((await chunks.next()).value.toString(), 'first\n');
	release();
	assert.equal((await chunks.next()).value.toString(), 'last\n');
});
test('a successful upstream response cannot echo the setup token across chunks', async () => {
	for (const type of ['application/json', 'text/event-stream']) {
		reset();
		upstream.headers['content-type'] = type;
		upstream.first = (type === 'application/json' ? '{"text":"' : '') + 'before ' + token.slice(0, 17);
		upstream.last = token.slice(17) + ' after' + (type === 'application/json' ? '"}' : '');
		const res = await call();
		let body = '';
		for await (const chunk of res) body += chunk;
		assert.equal(type === 'application/json' ? JSON.parse(body).text : body, 'before [redacted] after');
	}
});
test('the Claude filter scrubs decoded provider responses', async () => {
	reset();
	upstream.headers['content-encoding'] = 'gzip';
	upstream.first = gzipSync('before ' + token + ' after');
	upstream.last = '';
	const res = await call();
	let body = '';
	for await (const chunk of res) body += chunk;
	assert.equal(res.statusCode, 200);
	assert.ok(body === 'before [redacted] after');
});

test('decoded JSON and interleaved content blocks scrub model text across SSE events', async () => {
	const event = (index, s) => 'data: ' + JSON.stringify({type:'content_block_delta', index, delta:{type:'text_delta',text:s}}) + '\r\n\r\n';
	reset();
	upstream.first = event(2, 'one ' + token.slice(0, 11)).replace('sk-ant', '\\u0073k-ant') + event(3, 'separate');
	upstream.last = event(2, token.slice(11) + ' two') + 'data: {"type":"content_block_stop","index":2}\n\n';
	const stream = await call(); let body = '';
	for await (const part of stream) body += part;
	const events = body.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5)));
	assert.equal(events.filter(e => e.index === 2).map(e => e.delta?.text ?? '').join(''), 'one [redacted] two');
	assert.equal(events.find(e => e.index === 3).delta.text, 'separate');
	reset(); upstream.headers['content-type'] = 'application/json';
	upstream.first = JSON.stringify({text:token}).replace('sk-ant', '\\u0073k-ant'); upstream.last = '';
	const response = await call(); body = ''; for await (const part of response) body += part;
	assert.deepEqual(JSON.parse(body), {text:'[redacted]'});
});

test('a chunk ending with a complete shorter secret waits for the longer one', async () => {
	const { scrubStream } = await import('../sandbox/relay/server.cjs');
	for (const secrets of [['fixture', 'fixture-long'], ['fixture-long', 'fixture']]) {
		const stream = scrubStream(secrets);
		stream.write('fixture'); stream.end('-long fixture.');
		let body = ''; for await (const part of stream) body += part;
		assert.equal(body, '[redacted] [redacted].');
	}
});

test('foreign target, method and unapproved endpoint never reach upstream', async () => {
	for (const bad of [{ host: 'foreign.invalid' }, { path: 'https://foreign.invalid/v1/messages' },
		{ path: '//foreign.invalid/v1/messages' }, { path: '/api/oauth/profile' }, { method: 'GET' }]) {
		reset(); assert.equal(await responseStatus(bad), 403); assert.equal(sent, undefined);
	}
});
test('another machine or session cannot use a lease', async () => {
	for (const [bearer, addr] of [[credential(generateKeyPairSync('ed25519').privateKey), nonce],
		[placeholder, randomBytes(16).toString('hex')], ['unissued', nonce]]) {
		reset(); peer = addr; assert.equal(await responseStatus({ bearer }), 401); assert.equal(sent, undefined);
	}
});
test('a fragmented helper identity applies to every request on its connection', async () => {
	reset();
	const socket = connect(port, '127.0.0.1');
	let response = '';
	socket.setEncoding('utf8');
	const closed = new Promise((resolve, reject) => {
		socket.on('data', chunk => { response += chunk; });
		socket.on('end', resolve);
		socket.on('error', reject);
		socket.setTimeout(5000, () => socket.destroy(Error('Incomplete relay response')));
	});
	const post = (bearer, connection) => [
		'POST /v1/messages HTTP/1.1', 'Host: 127.0.0.1:17892', 'Content-Length: 0',
		'Authorization: Bearer ' + bearer, 'Connection: ' + connection, '', '',
	].join('\r\n');
	socket.write(nonce.slice(0, 9));
	await new Promise(done => setTimeout(done, 10));
	const foreign = credential(privateKey, randomBytes(16).toString('hex'));
	socket.write(nonce.slice(9) + post(placeholder, 'keep-alive') + post(foreign, 'close'));
	await closed;
	assert.deepEqual([...response.matchAll(/HTTP\/1\.1 (\d+)/g)].map(match => match[1]), ['200', '401']);
});
test('logout takes effect on the next request', async () => {
	reset(); login = undefined; assert.equal(await responseStatus(), 401); assert.equal(sent, undefined);
});
test('upstream redirect and diagnostics cannot disclose the credential', async () => {
	for (const [status, expected, message] of [
		[302, 502, "The provider failed or couldn't be reached."],
		[400, 400, 'The provider rejected the request.'],
		[401, 401, 'Provider sign-in is missing or the session placeholder is no longer valid.'],
		[403, 403, 'This request is not allowed by the relay.'],
		[429, 429, "The provider's usage or rate limit was reached."],
		[503, 503, "The provider failed or couldn't be reached."],
	]) {
		reset(); upstream = { statusCode: status, headers: { location: 'https://foreign.invalid/' + token, 'x-secret': token } };
		const res = await call(); let body = ''; for await (const data of res) body += data;
		assert.equal(res.statusCode, expected); assert.equal(JSON.parse(body).error.message, message); assert.equal(res.headers.location, undefined);
		assert.ok(!JSON.stringify(res.headers).includes(token)); assert.ok(!body.includes(token));
	}
});

// Caps: a relay whose fake upstream answers only when the check says so.
async function cappedRelay() {
	const { createRelay } = await import('../sandbox/relay/server.cjs');
	const pending = [];
	const relay = createRelay({ publicKey, machine, readToken: async () => token, forward: (options, callback) => {
		const input = new PassThrough();
		input.resume();
		input.on('finish', () => pending.push(callback));
		input.destroy = () => input;
		return input;
	} });
	await new Promise(done => relay.listen(0, '127.0.0.1', done));
	const at = relay.address().port;
	const send = session => {
		const req = request({ createConnection() {
			const socket = connect(at, '127.0.0.1');
			socket.write(session);
			return socket;
		}, method: 'POST', path: '/v1/messages?beta=true', headers: { host: '127.0.0.1:17892', authorization: 'Bearer ' + credential(privateKey, session) } });
		const reply = new Promise((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
		reply.catch(() => {});
		req.end('{}');
		return { req, reply };
	};
	const answer = () => {
		const callback = pending.shift();
		const response = new PassThrough();
		Object.assign(response, { statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
		callback(response);
		return response;
	};
	const until = async (count, ms = 5000) => {
		for (const end = Date.now() + ms; pending.length < count;) {
			if (Date.now() > end) throw Error(`${pending.length} of ${count} requests reached upstream`);
			await new Promise(done => setTimeout(done, 5));
		}
	};
	return { relay, pending, send, answer, until };
}
async function refusal(reply) {
	const res = await reply;
	let body = ''; for await (const chunk of res) body += chunk;
	return { status: res.statusCode, retry: res.headers['retry-after'], message: JSON.parse(body).error.message };
}

test('a ninth request in flight from one session is refused, and counts are released on every path', async () => {
	const { relay, pending, send, answer, until } = await cappedRelay();
	try {
		const session = randomBytes(16).toString('hex');
		const first = Array.from({ length: 8 }, () => send(session));
		await until(8);
		assert.deepEqual(await refusal(send(session).reply), { status: 503, retry: '2', message: 'Too many model requests at once from this session (8).' });
		assert.equal(pending.length, 8);
		// Finish all eight. The upstream may see them in any order, so answer every one before reading.
		for (const stream of first.map(() => answer())) stream.end('done\n');
		for (const { reply } of first) for await (const _ of await reply) { /* drain */ }
		// Eight more, each aborted by the client mid-stream.
		const aborted = Array.from({ length: 8 }, () => send(session));
		await until(8);
		for (const stream of aborted.map(() => answer())) stream.write('partial\n');
		for (const { req, reply } of aborted) { await reply; req.destroy(); }
		// Eight more, aborted before the upstream answered.
		const early = Array.from({ length: 8 }, () => send(session));
		await until(8);
		for (const { req } of early) req.destroy();
		pending.splice(0);
		await new Promise(done => setTimeout(done, 50));
		const again = Array.from({ length: 8 }, () => send(session));
		await until(8);
		assert.equal((await refusal(send(session).reply)).status, 503);
		for (const { req } of again) req.destroy();
	} finally { relay.close(); }
});

test('the 25th request in flight on the machine is refused across sessions', async () => {
	const { relay, pending, send, until } = await cappedRelay();
	try {
		const sessions = Array.from({ length: 4 }, () => randomBytes(16).toString('hex'));
		const sent = Array.from({ length: 24 }, (_, i) => send(sessions[i % 4]));
		await until(24);
		assert.deepEqual(await refusal(send(sessions[0]).reply), { status: 503, retry: '2', message: 'Too many model requests at once on this machine (24).' });
		assert.deepEqual(await refusal(send(randomBytes(16).toString('hex')).reply), { status: 503, retry: '2', message: 'Too many model requests at once on this machine (24).' });
		assert.equal(pending.length, 24);
		for (const { req } of sent) req.destroy();
	} finally { relay.close(); }
});

test('a session past 32 open connections is refused on the extra ones', async () => {
	const { relay, pending, send, until } = await cappedRelay();
	try {
		const session = randomBytes(16).toString('hex');
		const sockets = [];
		for (let i = 0; i < 32; i++) {
			const socket = connect(relay.address().port, '127.0.0.1');
			socket.write(session);
			sockets.push(socket);
		}
		await new Promise(done => setTimeout(done, 100));
		const refused = await refusal(send(session).reply);
		assert.deepEqual(refused, { status: 503, retry: '2', message: 'Too many connections to the model relay from this session (32).' });
		assert.equal(pending.length, 0);
		for (const socket of sockets) socket.destroy();
		await new Promise(done => setTimeout(done, 100));
		const { req } = send(session);
		await until(1);
		req.destroy();
	} finally { relay.close(); }
});

test('only allowlisted rate-limit headers pass, on success and on a limit refusal', async () => {
	reset();
	upstream.headers = { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed_warning',
		'anthropic-ratelimit-unified-reset': '1763800000', 'set-cookie': ['x'], 'request-id': 'r', 'x-request-id': 'r', 'cf-ray': 'c', server: 's' };
	let res = await call(); for await (const _ of res) { /* drain */ }
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['anthropic-ratelimit-unified-status'], 'allowed_warning');
	assert.equal(res.headers['anthropic-ratelimit-unified-reset'], '1763800000');
	for (const name of ['set-cookie', 'request-id', 'x-request-id', 'cf-ray', 'server']) assert.equal(res.headers[name], undefined, name);
	for (const status of [429, 503, 529]) {
		reset();
		upstream = { statusCode: status, headers: { 'retry-after': '30', 'anthropic-ratelimit-unified-status': 'rejected', 'request-id': 'r' } };
		res = await call(); let body = ''; for await (const chunk of res) body += chunk;
		assert.equal(res.statusCode, status);
		assert.equal(JSON.parse(body).type, 'error');
		assert.ok(!body.includes(token));
		assert.equal(res.headers['retry-after'], '30');
		assert.equal(res.headers['anthropic-ratelimit-unified-status'], 'rejected');
		assert.equal(res.headers['request-id'], undefined);
	}
	reset();
	upstream = { statusCode: 400, headers: { 'retry-after': '30', 'anthropic-ratelimit-unified-status': 'rejected' } };
	res = await call(); for await (const _ of res) { /* drain */ }
	assert.equal(res.headers['retry-after'], undefined);
});

test('a rate-limit header with a control character, an overlong value or the credential is dropped', async () => {
	reset();
	upstream.headers = { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed',
		'anthropic-ratelimit-unified-overage-status': 'a'.repeat(201), 'anthropic-ratelimit-unified-fallback': 'x ' + token };
	const res = await call(); for await (const _ of res) { /* drain */ }
	assert.equal(res.headers['anthropic-ratelimit-unified-status'], 'allowed');
	assert.equal(res.headers['anthropic-ratelimit-unified-overage-status'], undefined);
	assert.equal(res.headers['anthropic-ratelimit-unified-fallback'], undefined);
	// Node refuses to build a header with a control character, so check the filter itself.
	const { limitHeaders } = await import('../sandbox/relay/server.cjs');
	assert.deepEqual(limitHeaders({ 'x-ratelimit-remaining-requests': '1\u0007', 'x-ratelimit-limit-requests': '60',
		'x-codex-primary-used-percent': '12.5', 'x-codex-other-secondary-reset-at': '1763800000', 'x-codex-credits-balance': '4',
		'x-codex-promo-message': 'hi', 'x-codex-turn-state': 's', 'openai-organization': 'o', 'anthropic-organization-id': 'o' }, [token]),
	{ 'x-ratelimit-limit-requests': '60', 'x-codex-primary-used-percent': '12.5', 'x-codex-other-secondary-reset-at': '1763800000', 'x-codex-credits-balance': '4' });
	const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['x-ratelimit-n' + i, String(i)]));
	assert.equal(Object.keys(limitHeaders(many)).length, 24);
});
