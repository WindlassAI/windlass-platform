import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { codexProvider, persist } from '../sandbox/relay/codex.cjs';
import { createRelay, Stopping } from '../sandbox/relay/server.cjs';
import { forward } from '../runner/src/egress-proxy.mjs';

test('Codex allows only the Responses and versioned model-list routes', async () => {
	const provider = codexProvider('openai', 'generation', {
		load: async () => ({ generation: 'generation', provider: 'openai', key: 'sk-fixture' }),
	});
	for (const url of ['/codex/v1/models', '/codex/v1/models?client_version=0.171.0'])
		assert.equal(provider.methodFor(url), 'GET');
	assert.equal(provider.methodFor('/codex/v1/responses'), 'POST');
	for (const url of [
		'/codex/v1/models?redirect_uri=x',
		'/codex/v1/responses?x',
		'/codex/v1/chat/completions',
		'https://example.com',
	])
		assert.equal(provider.accepts(url), false);
	const target = await provider.target('/codex/v1/models', {
		authorization: 'Bearer ignored',
		host: 'example.com',
		cookie: 'ignored',
	});
	assert.deepEqual(
		[target.hostname, target.path, target.headers.authorization],
		['api.openai.com', '/v1/models', 'Bearer sk-fixture'],
	);
	assert.equal(target.headers.cookie, undefined);
});
test('two expired sessions share one refresh and the rotated token', async () => {
	let calls = 0,
		saves = 0,
		record = { generation: 'g', provider: 'chatgpt', access: 'expired', refresh: 'old', expires: 1 };
	const auth = codexProvider('chatgpt', 'g', {
		load: async () => record,
		persist: async (value) => {
			saves++;
			record = value;
		},
		exchange: async (url, opts) => {
			assert.equal(url, 'https://auth.openai.com/oauth/token');
			assert.equal(opts.body.get('refresh_token'), 'old');
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {
				ok: true,
				json: async () => ({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 300 }),
			};
		},
	});
	const targets = await Promise.all(['/codex/v1/responses', '/codex/v1/models'].map((url) => auth.target(url, {})));
	assert.equal(calls, 1);
	assert.equal(saves, 1);
	assert.equal(record.refresh, 'rotated');
	assert.deepEqual(
		targets.map((t) => t.headers.authorization),
		['Bearer new-access', 'Bearer new-access'],
	);
	assert.equal(targets[1].path, '/backend-api/codex/models?client_version=0.171.0');
});
test('killing the refresh writer before rename preserves the previous credential', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'codex-atomic-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, 'login.json');
	await writeFile(path, 'old', { mode: 0o400 });
	// Intercept only the rename syscall. The real persist function has written its temp file.
	const script = `require('node:fs/promises').rename=async()=>{process.send('ready');setInterval(()=>{},1000);};
	require(process.argv[1]).persist({refresh:'new'},process.argv[2]).catch(()=>process.exit(1));`;
	const child = spawn(
		process.execPath,
		['-e', script, new URL('../sandbox/relay/codex.cjs', import.meta.url).pathname, path],
		{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
	);
	const exit = once(child, 'exit');
	t.after(() => child.kill('SIGKILL'));
	await Promise.race([
		once(child, 'message'),
		exit.then(() => {
			throw Error('writer exited before rename');
		}),
	]);
	child.kill('SIGKILL');
	await exit;
	assert.equal(await readFile(path, 'utf8'), 'old');
	await persist({ refresh: 'new' }, path);
	assert.equal((await stat(path)).mode & 0o777, 0o400);
	assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { refresh: 'new' });
});

test('owner validation forces exactly one rotation after the first Responses request', async () => {
	let record = {
		provider: 'chatgpt',
		generation: 'g',
		access: 'initial',
		refresh: 'first-refresh',
		expires: Date.now() + 600000,
		verifyRefreshAfterTurn: true,
	};
	let calls = 0;
	const relay = codexProvider('chatgpt', 'g', {
		load: async () => record,
		persist: async (next) => {
			record = next;
		},
		exchange: async () => {
			calls++;
			return {
				ok: true,
				json: async () => ({ access_token: 'rotated', refresh_token: 'second-refresh', expires_in: 600 }),
			};
		},
	});
	for (const [route, token] of [
		['models', 'initial'],
		['responses', 'initial'],
		['models', 'rotated'],
		['responses', 'rotated'],
	])
		assert.equal((await relay.target('/codex/v1/' + route, {})).headers.authorization, 'Bearer ' + token);
	assert.equal(calls, 1);
	assert.equal(record.verifyRefreshAfterTurn, undefined);
});
test('interleaved Responses deltas scrub a split credential and preserve other output', async () => {
	const key = 'sk-canary-0123456789';
	const provider = codexProvider('openai', 'g', { load: async () => ({ provider: 'openai', generation: 'g', key }) });
	await provider.target('/codex/v1/responses', {});
	const filter = provider.responseFilter('text/event-stream');
	let result = '';
	filter.on('data', (chunk) => (result += chunk));
	const finished = once(filter, 'end');
	for (const [id, delta] of [
		['one', key.slice(0, 8)],
		['two', 'hello'],
		['one', key.slice(8)],
	])
		filter.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', item_id: id, delta }) + '\n\n');
	filter.end();
	await finished;
	const content = result
		.split('\n')
		.filter((s) => s.startsWith('data: '))
		.map((s) => JSON.parse(s.slice(6)).delta)
		.join('');
	assert.ok(content.includes('hello'));
	assert.ok(!content.includes(key.slice(0, 8)));
	assert.ok(!content.includes(key.slice(8)));
});
test('the catalog filter keeps model ids whose UTF-8 bytes are split across chunks', async () => {
	const auth = codexProvider('openai', 'g', { load: async () => ({ provider: 'openai', generation: 'g', key: 'sk-x' }) });
	const bytes = Buffer.from(JSON.stringify({ data: [{ id: 'gpt-é-π-模型' }, { id: 'plain' }] }));
	const out = await text(Readable.from(Array.from(bytes, (b) => Buffer.from([b]))).pipe(auth.catalogFilter()));
	assert.deepEqual(JSON.parse(out), { data: [{ id: 'gpt-é-π-模型' }, { id: 'plain' }] });
});
test('a refresh reply without a refresh token keeps the current one', async () => {
	let record = { generation: 'g', provider: 'chatgpt', access: 'expired', refresh: 'kept', expires: 1 };
	const auth = codexProvider('chatgpt', 'g', {
		load: async () => record,
		persist: async (value) => {
			record = value;
		},
		exchange: async () => ({ ok: true, json: async () => ({ access_token: 'new-access', expires_in: 300 }) }),
	});
	assert.equal((await auth.target('/codex/v1/responses', {}))?.headers.authorization, 'Bearer new-access');
	assert.equal(record.refresh, 'kept');
	assert.equal(record.access, 'new-access');
});
test('SIGTERM during a refresh exits only after the rotated token is saved', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'codex-stop-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, 'login.json');
	await writeFile(path, JSON.stringify({ generation: 'g', provider: 'chatgpt', access: 'expired', refresh: 'spent', expires: 1 }), { mode: 0o400 });
	const script = `const relay = require(process.argv[1]), { stopOnSignal } = require(process.argv[2]), fs = require('node:fs/promises');
	const path = process.argv[3];
	const provider = relay.codexProvider('chatgpt', 'g', {
		load: async () => JSON.parse(await fs.readFile(path, 'utf8')),
		persist: (record) => relay.persist(record, path),
		exchange: async () => { process.send('exchanging'); await new Promise((r) => setTimeout(r, 500));
			return { ok: true, json: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated', expires_in: 300 }) }; },
	});
	stopOnSignal(require('node:net').createServer().listen(0), provider);
	provider.target('/codex/v1/responses', {});`;
	const child = spawn(
		process.execPath,
		['-e', script, new URL('../sandbox/relay/codex.cjs', import.meta.url).pathname, new URL('../sandbox/relay/server.cjs', import.meta.url).pathname, path],
		{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
	);
	t.after(() => child.kill('SIGKILL'));
	const exit = once(child, 'exit');
	await once(child, 'message');
	child.kill('SIGTERM');
	assert.deepEqual(await exit, [0, null]);
	assert.equal(JSON.parse(await readFile(path, 'utf8')).refresh, 'rotated');
});
test('a stopping relay starts no new refresh', async () => {
	let calls = 0;
	const auth = codexProvider('chatgpt', 'g', {
		load: async () => ({ generation: 'g', provider: 'chatgpt', access: 'expired', refresh: 'old', expires: 1 }),
		persist: async () => {},
		exchange: async () => {
			calls++;
			return { ok: true, json: async () => ({ access_token: 'a', refresh_token: 'b', expires_in: 300 }) };
		},
	});
	await auth.drain();
	await assert.rejects(auth.target('/codex/v1/responses', {}), Stopping);
	assert.equal(calls, 0);
});

/** A Codex relay on a Unix socket, as in the relay container, with the session's forwarder in front of it. */
async function relayAndForwarder(t, { stopping = false } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'codex-forward-'));
	const socket = join(dir, 'relay.sock'), marker = join(dir, 'signed-out');
	const held = [];
	const origin = createServer((req, res) => {
		if (req.url.endsWith('/responses')) return held.push(res);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
	});
	await new Promise((done) => origin.listen(0, '127.0.0.1', done));
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const nonce = 'c'.repeat(32);
	const bearer = 'Bearer ' + nonce + '.' + sign(null, Buffer.from('test\nmachine\n' + nonce), privateKey).toString('base64url');
	// A stopping relay still serves an API key; it refuses only a ChatGPT token that needs a refresh.
	const provider = stopping
		? codexProvider('chatgpt', 'g', { load: async () => ({ generation: 'g', provider: 'chatgpt', access: 'expired', refresh: 'r', expires: 1 }) })
		: codexProvider('openai', 'g', { load: async () => ({ generation: 'g', provider: 'openai', key: 'sk-fixture' }) });
	if (stopping) await provider.drain();
	const relay = createRelay({ publicKey, machine: 'machine', domain: 'test', provider, signedOut: () => existsSync(marker),
		forward: (options, cb) => request({ ...options, hostname: '127.0.0.1', port: origin.address().port }, cb) });
	const sockets = new Set();
	relay.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
	await new Promise((done) => relay.listen(socket, done));
	const forwarder = forward(0, socket, nonce, true);
	await once(forwarder, 'listening');
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	const call = (method, path) => new Promise((ok, fail) => {
		const req = request({ host: '127.0.0.1', port: forwarder.address().port, method, path, agent,
			headers: { host: '127.0.0.1:17892', authorization: bearer, 'content-type': 'application/json' } }, (res) => {
			res.resume();
			res.on('end', () => ok({ status: res.statusCode, connection: res.headers.connection, reused: req.reusedSocket }));
		});
		req.on('error', fail);
		req.end(method === 'POST' ? '{}' : undefined);
	});
	/** The relay process exits: its listener and every connection close, as at SIGTERM after drain. */
	const exit = () => { relay.close(); for (const s of sockets) s.destroy(); };
	t.after(async () => {
		agent.destroy(); forwarder.close(); exit(); origin.closeAllConnections(); origin.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { call, exit, held, marker };
}
test('logout during a request on a warm connection still answers the signed-out status', { timeout: 10_000 }, async (t) => {
	const relay = await relayAndForwarder(t);
	const warm = await relay.call('GET', '/codex/v1/models');
	assert.equal(warm.status, 200);
	// The relay closes every connection after its reply, so the next request cannot reuse an answered one.
	assert.equal(warm.connection, 'close');
	const turn = relay.call('POST', '/codex/v1/responses');
	while (!relay.held.length) await new Promise((r) => setTimeout(r, 10));
	await writeFile(relay.marker, '');
	relay.exit();
	assert.deepEqual(await turn, { status: 401, connection: 'close', reused: false });
});
test('a relay that is being replaced answers retryable, and signed out only after a logout', { timeout: 10_000 }, async (t) => {
	const stopping = await relayAndForwarder(t, { stopping: true });
	const replacing = await stopping.call('POST', '/codex/v1/responses');
	assert.equal(replacing.status, 503);
	await writeFile(stopping.marker, '');
	assert.equal((await stopping.call('POST', '/codex/v1/responses')).status, 401);
	const gone = await relayAndForwarder(t);
	gone.exit();
	assert.equal((await gone.call('GET', '/codex/v1/models')).status, 503);
	await writeFile(gone.marker, '');
	assert.equal((await gone.call('GET', '/codex/v1/models')).status, 401);
	const cut = await relayAndForwarder(t);
	const pending = cut.call('POST', '/codex/v1/responses');
	while (!cut.held.length) await new Promise((r) => setTimeout(r, 10));
	cut.exit();
	assert.equal((await pending).status, 503);
});
