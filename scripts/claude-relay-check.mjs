// Offline protocol checks. The Docker check also exercises the pinned adapter and the real TLS transport.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const machine = 'fixture-machine';
const nonce = randomBytes(16).toString('hex');
function credential(key = privateKey) {
	return nonce + '.' + sign(null, Buffer.from('windlass-claude-relay-v1\n' + machine + '\n' + nonce), key).toString('base64url');
}
const placeholder = credential();
const token = 'sk-ant-oat01-' + randomBytes(24).toString('hex');
let server, port, upstream, peer, login, sent, release;
before(async () => {
	const { createRelay } = await import('../sandbox/relay/server.cjs');
	server = createRelay({
		publicKey, machine, readToken: async () => login,
		lookup: async name => name === 'cc-' + nonce + '.invalid.' ? [peer] : [],
		forward: (options, callback) => {
			sent = options;
			const input = new PassThrough();
			input.resume();
			input.on('finish', () => {
				const response = new PassThrough();
				Object.assign(response, upstream);
				callback(response);
				response.write(upstream.statusCode === 200 ? 'first\n' : token);
				release = () => response.end('last\n');
				if (!upstream.holdOpen) release();
			});
			return input;
		},
	});
	await new Promise(done => server.listen(0, '127.0.0.1', done));
	port = server.address().port;
});
after(() => { server?.closeAllConnections(); server?.close(); });
function reset() {
	sent = undefined;
	login = token;
	peer = '127.0.0.1';
	upstream = { statusCode: 200, headers: { 'content-type': 'text/event-stream', 'x-private': token } };
}
function call({ bearer = placeholder, host = 'wlp-relay:8080', path = '/v1/messages?beta=true', method = 'POST' } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ port, agent: false, hostname: '127.0.0.1', method, path, headers: {
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
test('foreign target, method and unapproved endpoint never reach upstream', async () => {
	for (const bad of [{ host: 'foreign.invalid' }, { path: 'https://foreign.invalid/v1/messages' },
		{ path: '//foreign.invalid/v1/messages' }, { path: '/api/oauth/profile' }, { method: 'GET' }]) {
		reset(); assert.equal(await responseStatus(bad), 403); assert.equal(sent, undefined);
	}
});
test('another machine, another source, and a removed DNS registration cannot use a lease', async () => {
	for (const [bearer, addr] of [[credential(generateKeyPairSync('ed25519').privateKey), '127.0.0.1'],
		[placeholder, '127.0.0.2'], [placeholder, undefined], ['unissued', '127.0.0.1']]) {
		reset(); peer = addr; assert.equal(await responseStatus({ bearer }), 401); assert.equal(sent, undefined);
	}
});
test('logout takes effect on the next request', async () => {
	reset(); login = undefined; assert.equal(await responseStatus(), 401); assert.equal(sent, undefined);
});
test('upstream redirect and diagnostics cannot disclose the credential', async () => {
	for (const status of [302, 401, 429, 500]) {
		reset(); upstream = { statusCode: status, headers: { location: 'https://foreign.invalid/' + token, 'x-secret': token } };
		const res = await call(); let body = ''; for await (const data of res) body += data;
		assert.ok(res.statusCode >= 400); assert.equal(res.headers.location, undefined);
		assert.ok(!JSON.stringify(res.headers).includes(token)); assert.ok(!body.includes(token));
	}
});
