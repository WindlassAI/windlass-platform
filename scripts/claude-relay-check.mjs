// Offline protocol checks. The Docker check also exercises the pinned adapter and the real TLS transport.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
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

// Caps: a relay whose fake upstream answers only when the check says so. `pending` holds the requests that
// reached the upstream, in order, each with the client's request id.
async function cappedRelay(limits) {
	const { createRelay } = await import('../sandbox/relay/server.cjs');
	const pending = [];
	const relay = createRelay({ publicKey, machine, readToken: async () => token, limits, forward: (options, callback) => {
		const input = new PassThrough();
		input.resume();
		input.on('finish', () => pending.push({ callback, id: options.headers['x-client-request-id'] }));
		input.destroy = () => input;
		return input;
	} });
	const sockets = new Set();
	relay.on('connection', socket => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise(done => relay.listen(0, '127.0.0.1', done));
	const close = () => {
		const closed = new Promise(done => relay.close(done));
		for (const socket of sockets) socket.destroy();
		return closed;
	};
	const at = relay.address().port;
	const send = (session, id) => {
		const req = request({ createConnection() {
			const socket = connect(at, '127.0.0.1');
			socket.write(session);
			return socket;
		}, method: 'POST', path: '/v1/messages?beta=true', headers: { host: '127.0.0.1:17892', authorization: 'Bearer ' + credential(privateKey, session),
			...(id && { 'x-client-request-id': id }) } });
		const reply = new Promise((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
		reply.catch(() => {});
		req.end('{}');
		return { req, reply };
	};
	// Answer the upstream request with this id, or the oldest one.
	const answer = id => {
		const at = id ? pending.findIndex(p => p.id === id) : 0;
		assert.ok(at >= 0, 'upstream has request ' + id);
		const [{ callback }] = pending.splice(at, 1);
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
	// Nothing more reaches the upstream within a while.
	const stays = async count => { await new Promise(done => setTimeout(done, 150)); assert.equal(pending.length, count); };
	return { relay, close, pending, send, answer, until, stays };
}
async function refusal(reply) {
	const res = await reply;
	let body = ''; for await (const chunk of res) body += chunk;
	return { status: res.statusCode, retry: res.headers['retry-after'], message: JSON.parse(body).error.message };
}
const drained = async reply => { for await (const _ of await reply) { /* drain */ } };
const sleep = ms => new Promise(done => setTimeout(done, ms));

test('a ninth request from one session waits at the relay and goes upstream, in order, once a slot frees', async () => {
	const { close, pending, send, answer, until, stays } = await cappedRelay();
	try {
		const session = randomBytes(16).toString('hex');
		const first = Array.from({ length: 8 }, (_, i) => send(session, 'a' + i));
		await until(8);
		const ninth = send(session, 'ninth'), tenth = send(session, 'tenth');
		await stays(8);
		answer('a3').end('done\n');
		await until(8);
		assert.deepEqual(pending.map(p => p.id).filter(id => !id.startsWith('a')), ['ninth']);
		answer('a5').end('done\n');
		await until(8);
		assert.ok(pending.some(p => p.id === 'tenth'));
		for (const stream of Array.from({ length: pending.length }, () => answer())) stream.end('done\n');
		for (const { reply } of [...first, ninth, tenth]) await drained(reply);
	} finally { await close(); }
});

test('a waiting request that gets no slot in time is refused with a 503 and retry-after, and never reaches upstream', async () => {
	const { close, send, until, stays } = await cappedRelay({ waitMs: 200 });
	try {
		const session = randomBytes(16).toString('hex');
		const held = Array.from({ length: 8 }, () => send(session));
		await until(8);
		const started = Date.now();
		assert.deepEqual(await refusal(send(session).reply), { status: 503, retry: '2', message: 'Too many model requests at once from this session (8).' });
		assert.ok(Date.now() - started >= 190);
		await stays(8);
		for (const { req } of held) req.destroy();
	} finally { await close(); }
});

test('the wait list is bounded per session and per machine; past it the refusal is immediate', async () => {
	const { close, send, until, stays } = await cappedRelay({ sessionRequests: 1, machineRequests: 2, sessionWaiting: 2, machineWaiting: 3 });
	try {
		const [a, b, c] = Array.from({ length: 3 }, () => randomBytes(16).toString('hex'));
		const sent = [send(a), send(b)];
		await until(2);
		sent.push(send(a), send(a));
		await sleep(100);
		assert.deepEqual(await refusal(send(a).reply), { status: 503, retry: '2', message: 'Too many model requests waiting from this session (2).' });
		sent.push(send(c));
		await sleep(100);
		assert.deepEqual(await refusal(send(c).reply), { status: 503, retry: '2', message: 'Too many model requests waiting on this machine (3).' });
		await stays(2);
		for (const { req } of sent) req.destroy();
	} finally { await close(); }
});

test('a session at its own ceiling does not hold up another session waiting for a machine slot', async () => {
	const { close, pending, send, answer, until, stays } = await cappedRelay({ sessionRequests: 2, machineRequests: 3 });
	try {
		const [a, b] = Array.from({ length: 2 }, () => randomBytes(16).toString('hex'));
		const sent = [send(a, 'a1'), send(a, 'a2'), send(b, 'b1')];
		await until(3);
		sent.push(send(a, 'a3'));
		await sleep(50);
		sent.push(send(b, 'b2'));
		await stays(3);
		// A machine slot frees from b. a3 is first in line but a is at its own ceiling, so b2 goes.
		answer('b1').end('done\n');
		await until(3);
		assert.deepEqual(pending.map(p => p.id).sort(), ['a1', 'a2', 'b2']);
		answer('a1').end('done\n');
		await until(3);
		assert.deepEqual(pending.map(p => p.id).sort(), ['a2', 'a3', 'b2']);
		for (const stream of Array.from({ length: pending.length }, () => answer())) stream.end('done\n');
		for (const { reply } of sent) await drained(reply);
	} finally { await close(); }
});

test('counts are exact on every path: finished, aborted mid-stream, aborted upstream-pending, and aborted while waiting', async () => {
	const { close, pending, send, answer, until, stays } = await cappedRelay({ sessionWaiting: 4 });
	try {
		const session = randomBytes(16).toString('hex');
		const first = Array.from({ length: 8 }, () => send(session));
		await until(8);
		// Four wait; each client gives up while waiting. The wait list is then empty again.
		const waiters = Array.from({ length: 4 }, () => send(session));
		await sleep(100);
		for (const { req } of waiters) req.destroy();
		await sleep(50);
		const more = Array.from({ length: 4 }, () => send(session));
		await stays(8);
		for (const stream of Array.from({ length: pending.length }, () => answer())) stream.end('done\n');
		for (const { reply } of first) await drained(reply);
		await until(4);
		for (const stream of Array.from({ length: pending.length }, () => answer())) stream.end('done\n');
		for (const { reply } of more) await drained(reply);
		// Eight more, each aborted by the client mid-stream.
		const aborted = Array.from({ length: 8 }, () => send(session));
		await until(8);
		for (const stream of Array.from({ length: pending.length }, () => answer())) stream.write('partial\n');
		for (const { req, reply } of aborted) { await reply; req.destroy(); }
		// Eight more, aborted before the upstream answered.
		const early = Array.from({ length: 8 }, () => send(session));
		await until(8);
		for (const { req } of early) req.destroy();
		pending.splice(0);
		await sleep(50);
		const again = Array.from({ length: 8 }, () => send(session));
		await until(8);
		const ninth = send(session);
		await stays(8);
		for (const { req } of [...again, ninth]) req.destroy();
	} finally { await close(); }
});

test('the 25th request in flight on the machine waits across sessions', async () => {
	const { close, pending, send, answer, until, stays } = await cappedRelay();
	try {
		const sessions = Array.from({ length: 4 }, () => randomBytes(16).toString('hex'));
		const sent = Array.from({ length: 24 }, (_, i) => send(sessions[i % 4]));
		await until(24);
		const other = send(randomBytes(16).toString('hex'), 'other');
		await stays(24);
		answer().end('done\n');
		await until(24);
		assert.ok(pending.some(p => p.id === 'other'));
		for (const { req } of [...sent, other]) req.destroy();
	} finally { await close(); }
});

// Requests pipelined on one socket each pass admission (the response of a queued pipelined request has no socket yet).
test('requests pipelined on one socket are counted, wait or are refused, and are released when the socket closes', async () => {
	const { relay, close, pending, send, until, stays } = await cappedRelay({ sessionWaiting: 4 });
	try {
		const session = randomBytes(16).toString('hex');
		const one = `POST /v1/messages?beta=true HTTP/1.1\r\nhost: 127.0.0.1:17892\r\nauthorization: Bearer ${credential(privateKey, session)}\r\ncontent-length: 2\r\n\r\n{}`;
		const disconnected = once(relay, 'connection').then(([peer]) => once(peer, 'close'));
		const socket = connect(relay.address().port, '127.0.0.1');
		socket.on('error', () => {});
		socket.write(session + one.repeat(20));
		await until(8);
		await stays(8);
		socket.destroy();
		await disconnected;
		pending.splice(0);
		const fresh = Array.from({ length: 8 }, () => send(session));
		await until(8);
		for (const { req } of fresh) req.destroy();
	} finally { await close(); }
});

test('a session past 32 open connections gets a 503 on the extra ones, which are closed; idle sockets time out', { timeout: 15000 }, async () => {
	const { relay, close, send, until } = await cappedRelay({ firstRequestMs: 1500 });
	try {
		const session = randomBytes(16).toString('hex');
		const opened = () => {
			const socket = connect(relay.address().port, '127.0.0.1');
			socket.on('error', () => {});
			socket.write(session);
			let data = '';
			socket.on('data', chunk => data += chunk);
			const closed = new Promise(done => socket.on('close', () => done(data)));
			return { socket, closed };
		};
		const idle = [];
		for (let i = 0; i < 32; i++) idle.push(opened());
		await sleep(100);
		// Three more that never send a request: each is answered and closed at once.
		const extra = Array.from({ length: 3 }, opened);
		const started = Date.now();
		for (const { closed } of extra) {
			const reply = await closed;
			assert.match(reply, /^HTTP\/1\.1 503 /);
			assert.match(reply, /\r\nretry-after: 2\r\n/);
			assert.match(reply, /\r\nconnection: close\r\n/);
			assert.equal(JSON.parse(reply.split('\r\n\r\n')[1]).error.message, 'Too many connections to the model relay from this session (32).');
		}
		assert.ok(Date.now() - started < 1000);
		// Another session is not locked out.
		const other = send(randomBytes(16).toString('hex'));
		await until(1);
		other.req.destroy();
		// The idle ones never sent a request: the relay closes them, and the session can connect again.
		await Promise.all(idle.map(({ closed }) => closed));
		const again = send(session);
		await until(2);
		again.req.destroy();
	} finally { await close(); }
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
		'anthropic-ratelimit-unified-overage-status': 'a'.repeat(65), 'anthropic-ratelimit-unified-fallback': 'x ' + token };
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
	// Only up to 64 characters of [A-Za-z0-9 .,:_+-]: numbers, timestamps, durations and status words pass.
	const kept = { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT', 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-reset': '2026-11-22T10:00:00.5+00:00',
		'anthropic-ratelimit-unified-status': 'allowed_warning', 'x-ratelimit-n': '-1', 'x-ratelimit-long': 'a'.repeat(64) };
	assert.deepEqual(limitHeaders({ ...kept, 'x-ratelimit-over': 'a'.repeat(65), 'x-ratelimit-quote': 'a"b', 'x-ratelimit-tag': '<b>',
		'x-ratelimit-semi': 'a;b', 'x-ratelimit-url': 'https://x/y', 'x-ratelimit-eq': 'k=v', 'x-ratelimit-json': '{}' }), kept);
	const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['x-ratelimit-n' + i, String(i)]));
	assert.equal(Object.keys(limitHeaders(many)).length, 24);
});
