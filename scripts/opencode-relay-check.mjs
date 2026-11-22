import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { text } from 'node:stream/consumers';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { providerFor } from '../sandbox/relay/opencode.cjs';
import { createRelay } from '../sandbox/relay/server.cjs';

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
	const bytes = Buffer.from('π old-access old-refresh next-access next-refresh end');
	const pieces = Readable.from(Array.from(bytes, b => Buffer.from([b])));
	assert.equal(await text(pieces.pipe(provider.responseFilter())), 'π [redacted] [redacted] [redacted] [redacted] end');
	record.generation = 'two';
	assert.equal(await provider.target('/openai/responses', {}), undefined);
});

test('explicit free model access uses only the public provider credential', async () => {
	const p = providerFor('free', 'one', {load: async () => ({provider:'free',generation:'one'})});
	assert.equal(p.bearer({'x-wlp-session':'placeholder'}), 'Bearer placeholder');
	assert.equal(p.bearer({authorization:'Bearer session'}, '/free/chat/completions'), 'Bearer session');
	assert.equal(p.bearer({authorization:'Bearer public', 'x-wlp-session':'legacy'}, '/free/chat/completions'), 'Bearer legacy');
	const native = {accept:'*/*', 'content-length':'123', 'accept-encoding':'gzip, br', 'user-agent':'client',
		'x-opencode-client':'acp', 'x-opencode-project':'project', 'x-opencode-request':'request',
		'x-opencode-session':'session', 'x-opencode-session-id':'session', 'x-opencode-parent-session-id':'parent',
		'x-parent-session-id':'parent'};
	const target = await p.target('/free/chat/completions', {...native, authorization:'Bearer session',
		'x-wlp-session':'legacy', cookie:'private', 'x-opencode-extra':'private', 'x-source':'untrusted',
		'transfer-encoding':'chunked', host:'foreign.invalid'});
	assert.deepEqual(target, {hostname:'opencode.ai', path:'/inference/openai/v1/chat/completions',
		headers:{...native, 'content-type':'application/json', authorization:'Bearer public'}});
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

test('an active stream survives expiry while the next request rotates the account token', async t => {
	const clock = t.mock.method(Date, 'now', () => 0);
	let record = {generation:'one',provider:'chatgpt',access:'initial-access',refresh:'initial-refresh',expires:60000};
	const renewed = 'eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({organizations:[{id:'new-account'}]})).toString('base64url')+'.tag';
	const provider = providerFor('chatgpt','one',{
		load: async () => record, persist: async next => { record = next; },
		exchange: async () => Response.json({access_token:renewed, refresh_token:'new-refresh', expires_in:3600}),
	});
	const first = await provider.target('/openai/responses',{});
	assert.equal(first.headers.authorization,'Bearer initial-access');
	const stream = provider.responseFilter();
	const reading = text(stream);
	stream.write('initial-');
	clock.mock.mockImplementation(() => 60001);
	const next = await provider.target('/openai/responses',{});
	assert.equal(next.headers.authorization,'Bearer '+renewed);
	assert.equal(next.headers['chatgpt-account-id'],'new-account');
	stream.end('access '+renewed);
	assert.equal(await reading,'[redacted] [redacted]');
});

test('a signed session routes Go, Zen and GLM keys independently and refuses unconfigured providers', async () => {
	const { createServer, request } = await import('node:http');
	const { connect } = await import('node:net');
	const { generateKeyPairSync, sign } = await import('node:crypto');
	const { createRelay } = await import('../sandbox/relay/server.cjs');
	const recorded = [];
	const origin = createServer(async (req, res) => {
		recorded.push([req.headers.host, req.url, req.headers.authorization, req.headers['x-api-key'], req.headers['x-goog-api-key']]);
		res.writeHead(200, {'content-type':'text/event-stream', 'content-encoding':'gzip'});
		res.end(gzipSync('fixture stream ' + (req.headers.authorization?.slice(7) ?? req.headers['x-api-key'] ?? req.headers['x-goog-api-key'])));
	});
	const {publicKey, privateKey} = generateKeyPairSync('ed25519');
	const nonce = 'a'.repeat(32);
	const placeholder = nonce + '.' + sign(null, Buffer.from('test\nmachine\n' + nonce), privateKey).toString('base64url');
	const records = Object.fromEntries(['zai-coding-plan','opencode-go','opencode'].map(provider => [provider, {provider,key:'secret-' + provider}]));
	const relay = createRelay({publicKey, machine:'machine', domain:'test',
		provider:providerFor(Object.keys(records), 'one', {load:async () => ({generation:'one',records})}),
		forward: (options, cb) => request({...options, hostname:'127.0.0.1', port:origin.address().port, headers:{...options.headers,host:options.hostname}}, cb)});
	try {
		for (const s of [origin,relay]) await new Promise(done => s.listen(0,'127.0.0.1',done));
		for (const [url,header,status] of [
			['/zai-coding-plan/chat/completions','authorization',200], ['/opencode-go/chat/completions','authorization',200],
			['/opencode-go/messages','x-api-key',200], ['/opencode/models/gemini-fixture:streamGenerateContent?alt=sse','x-goog-api-key',200],
			['/opencode/responses','authorization',200], ['/groq/chat/completions','authorization',403],
			['/opencode-go/../opencode/chat/completions','authorization',403],
		]) {
			const response = await new Promise((ok,fail) => {
				const req = request({method:'POST', path:url, headers:{host:'127.0.0.1:17892',[header]:(header === 'authorization' ? 'Bearer ' : '') + placeholder},
					createConnection:() => { const socket=connect(relay.address().port,'127.0.0.1');socket.write(nonce);return socket; }}, ok);
				req.on('error',fail);req.end('{}');
			});
			assert.equal(response.statusCode,status,url);
			if (status === 200) assert.equal(await text(response),'fixture stream [redacted]'); else response.resume();
		}
		assert.deepEqual(recorded,[
			['api.z.ai','/api/coding/paas/v4/chat/completions','Bearer secret-zai-coding-plan',undefined,undefined],
			['opencode.ai','/inference/go/openai/v1/chat/completions','Bearer secret-opencode-go',undefined,undefined],
			['opencode.ai','/inference/go/anthropic/v1/messages',undefined,'secret-opencode-go',undefined],
			['opencode.ai','/inference/google/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse',undefined,undefined,'secret-opencode'],
			['opencode.ai','/inference/openai/v1/responses','Bearer secret-opencode',undefined,undefined],
		]);
	} finally { relay.close();origin.closeAllConnections();origin.close(); }
});

test('Go preserves native client attribution and drops caller-supplied destination and credential headers', async () => {
	const relay = providerFor('opencode-go','one',{load:async () => ({generation:'one',provider:'opencode-go',key:'go-key'})});
	const target = await relay.target('/opencode-go/chat/completions',{'user-agent':'opencode/1.19.6','x-opencode-client':'acp',
		'x-opencode-session-id':'session-id',host:'elsewhere','x-wlp-session':'signed-placeholder','x-api-key':'foreign-key'});
	assert.equal(target.headers['x-opencode-client'],'acp');
	assert.equal(target.headers['user-agent'],'opencode/1.19.6');
	assert.equal(target.headers['x-opencode-session-id'],'session-id');
	for (const key of ['host','x-wlp-session','x-api-key']) assert.ok(!(key in target.headers));
});

test('a missing credential on an enabled route fails closed even when another key exists on the same host', async () => {
	const p = providerFor(['opencode','opencode-go'],'one',{load:async () => ({
		generation:'one',records:{opencode:{provider:'opencode',key:'zen-only'}}})});
	assert.ok(p.accepts('/opencode-go/chat/completions'));
	assert.equal(await p.target('/opencode-go/chat/completions',{}),undefined);
});

test('rotating the runner-owned ChatGPT credential preserves other provider keys in the volume', async () => {
	let store = {generation:'one',records:{chatgpt:{provider:'chatgpt',access:'expired',refresh:'old-refresh',expires:0},
		'opencode-go':{provider:'opencode-go',key:'go-key'}}};
	const p = providerFor(Object.keys(store.records),'one',{load:async () => store,persist:async next => {store=next;},
		exchange:async () => Response.json({access_token:'renewed',refresh_token:'rotated',expires_in:3600})});
	assert.equal((await p.target('/openai/responses',{})).headers.authorization,'Bearer renewed');
	assert.equal((await p.target('/opencode-go/chat/completions',{})).headers.authorization,'Bearer go-key');
	assert.equal(store.records.chatgpt.refresh,'rotated');
});

test('catalog API keys select the provider-specific inference host, base path and authentication header', async () => {
	for (const [id,base,suffix,header] of [
		['openrouter','https://openrouter.ai/api/v1','/chat/completions','authorization'],
		['google','https://generativelanguage.googleapis.com/v1beta','/models/gemini-fixture:streamGenerateContent?alt=sse','x-goog-api-key'],
		['zai','https://api.z.ai/api/paas/v4','/chat/completions','authorization'],
		['zhipuai','https://open.bigmodel.cn/api/paas/v4','/chat/completions','authorization'],
		['zhipuai-coding-plan','https://open.bigmodel.cn/api/coding/paas/v4','/chat/completions','authorization'],
		['moonshotai','https://api.moonshot.ai/v1','/chat/completions','authorization'],
		['kimi-code-plan-global','https://api.kimi.ai/coding/v1','/chat/completions','authorization'],
		['kimi-code-plan-cn','https://api.kimi.com/coding/v1','/chat/completions','authorization'],
		['minimax','https://api.minimax.io/anthropic/v1','/messages','x-api-key'],
		['deepseek','https://api.deepseek.com','/chat/completions','authorization'],
		['groq','https://api.groq.com/openai/v1','/chat/completions','authorization'],
	]) {
		const provider = providerFor(id,'one',{load:async () => ({generation:'one',provider:id,key:'fixture-key'})});
		const route = '/'+id+suffix;
		const bearer = header === 'authorization';
		assert.equal(provider.bearer({[header]:bearer ? 'Bearer placeholder' : 'placeholder'},route),'Bearer placeholder',id);
		const target = await provider.target(route,{});
		assert.equal('https://'+target.hostname+target.path,base+suffix,id);
		assert.equal(target.headers[header],bearer ? 'Bearer fixture-key' : 'fixture-key',id);
	}
});
test('an OpenCode ChatGPT refresh reply without a refresh token keeps the current one', async () => {
	let record = { provider: 'chatgpt', generation: 'one', access: 'old-access', refresh: 'kept-refresh', expires: 0 };
	const provider = providerFor('chatgpt', 'one', {
		load: async () => ({ ...record }),
		persist: async next => { record = next; },
		exchange: async () => Response.json({ access_token: 'next-access', expires_in: 3600 }),
	});
	assert.equal((await provider.target('/openai/responses', {}))?.headers.authorization, 'Bearer next-access');
	assert.deepEqual([record.access, record.refresh], ['next-access', 'kept-refresh']);
});

test('OpenAI rate-limit headers pass on a ChatGPT and an API-key route; account headers and secrets do not', async () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const nonce = 'd'.repeat(32);
	const bearer = 'Bearer ' + nonce + '.' + sign(null, Buffer.from('test\nmachine\n' + nonce), privateKey).toString('base64url');
	for (const [id, record, route] of [
		['chatgpt', { provider: 'chatgpt', generation: 'one', access: 'access-secret', refresh: 'refresh-secret', expires: Date.now() + 3600_000 }, '/openai/responses'],
		['openai', { provider: 'openai', generation: 'one', key: 'sk-key-secret' }, '/openai/responses'],
	]) {
		const secret = record.key ?? record.access;
		let answer;
		const relay = createRelay({ publicKey, machine: 'machine', domain: 'test', provider: providerFor(id, 'one', { load: async () => record }),
			forward: (options, callback) => {
				const input = new PassThrough();
				input.resume();
				input.on('finish', () => {
					const reply = new PassThrough();
					Object.assign(reply, answer);
					callback(reply);
					reply.end(answer.statusCode === 200 ? '{}' : secret);
				});
				return input;
			} });
		await new Promise(done => relay.listen(0, '127.0.0.1', done));
		const limits = { 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-tokens': '1200', 'x-ratelimit-reset-requests': '1s', 'x-codex-primary-used-percent': '12' };
		const hidden = { 'openai-organization': 'org', 'x-request-id': 'r', 'set-cookie': 'c', 'x-ratelimit-limit-tokens': 'Bearer ' + secret };
		try {
			for (const [statusCode, extra] of [[200, { 'content-type': 'application/json' }], [429, { 'retry-after': '20' }]]) {
				answer = { statusCode, headers: { ...limits, ...hidden, ...extra } };
				const res = await new Promise((resolve, reject) => {
					const req = request({ createConnection() {
						const socket = connect(relay.address().port, '127.0.0.1');
						socket.write(nonce);
						return socket;
					}, method: 'POST', path: route, headers: { host: '127.0.0.1:17892', authorization: bearer } }, resolve);
					req.on('error', reject);
					req.end('{}');
				});
				const body = await text(res);
				assert.equal(res.statusCode, statusCode, id);
				assert.ok(!body.includes(secret));
				for (const [name, value] of Object.entries(limits)) assert.equal(res.headers[name], value, id + ' ' + name);
				for (const name of Object.keys(hidden)) assert.equal(res.headers[name], undefined, id + ' ' + name);
				if (statusCode === 429) assert.deepEqual([res.headers['retry-after'], JSON.parse(body).error.type], ['20', 'rate_limit_error']);
			}
		} finally { relay.close(); }
	}
});
