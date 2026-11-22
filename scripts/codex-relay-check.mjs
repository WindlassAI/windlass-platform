import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexProvider, persist } from '../sandbox/relay/codex.cjs';

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
