import assert from 'node:assert/strict';
import test from 'node:test';
import { providerFor } from '../sandbox/relay/opencode.cjs';

test('concurrent ChatGPT requests share a machine-side refresh and retain the rotated credential', async () => {
	let record = { provider: 'chatgpt', generation: 'one', access: 'old-access', refresh: 'old-refresh', expires: 0 };
	let calls = 0, saves = 0;
	const provider = providerFor('chatgpt', 'one', {
		load: async () => ({ ...record }),
		persist: async next => { saves++; record = next; },
		exchange: async (url, opts) => {
			assert.equal(url, 'https://auth.openai.com/oauth/token');
			assert.equal(opts.body.get('refresh_token'), 'old-refresh');
			assert.equal(opts.redirect, 'error');
			calls++;
			return Response.json({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600 });
		},
	});
	const result = await Promise.all(Array.from({ length: 8 }, () => provider.target('/openai/responses', {})));
	assert.deepEqual([calls, saves, record.refresh], [1, 1, 'next-refresh']);
	for (const target of result) {
		assert.equal(target.headers.authorization, 'Bearer next-access');
		assert.equal(target.hostname, 'chatgpt.com');
		assert.equal(target.path, '/backend-api/codex/responses');
	}
	record.generation = 'two';
	assert.equal(await provider.target('/openai/responses', {}), undefined);
});

test('explicit free model access uses only the public provider credential', async () => {
	const p = providerFor('free', 'one', {load: async () => ({provider:'free',generation:'one'})});
	assert.equal(p.bearer({'x-wlp-session':'placeholder'}), 'Bearer placeholder');
	assert.deepEqual(await p.target('/free/chat/completions', {}), {hostname:'opencode.ai',
		path:'/inference/openai/v1/chat/completions',headers:{'content-type':'application/json',authorization:'Bearer public'}});
});

test('API keys are scoped to the configured inference route and host', async () => {
	for (const [id, route, hostname, header] of [['openai', '/openai/responses', 'api.openai.com', 'authorization'],
		['anthropic', '/anthropic/messages', 'api.anthropic.com', 'x-api-key']]) {
		const provider = providerFor(id, 'one', { load: async () => ({ provider: id, generation: 'one', key: 'fixture' }) });
		assert.equal(provider.accepts(route), true);
		assert.equal(provider.accepts(route + '?url=elsewhere'), false);
		const target = await provider.target(route, {host: 'elsewhere', authorization: 'wrong'});
		assert.equal(target.hostname, hostname);
		assert.equal(target.headers[header], id === 'openai' ? 'Bearer fixture' : 'fixture');
		assert.equal(target.headers.host, undefined);
	}
});
