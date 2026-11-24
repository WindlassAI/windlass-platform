const { createHmac } = require('node:crypto');

const wires = {
	chatgpt: { base: '/v1', host: 'api.openai.com', models: '/v1/models', posts: ['/v1/responses'],
		passed: ['content-type', 'session-id'], dropUnknown: true },
	openai: { base: '/v1', host: 'api.openai.com', models: '/v1/models', posts: ['/v1/responses', '/v1/chat/completions'],
		passed: ['session-id'], drop: ['openai-organization', 'openai-project'] },
	anthropic: { base: '', host: 'api.anthropic.com', models: '/v1/models', posts: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'x-api-key',
		fixed: { 'anthropic-version': '2023-06-01' }, betas: ['interleaved-thinking-2025-05-14'], drop: ['anthropic-dangerous-direct-browser-access'] },
	google: { base: '', host: 'generativelanguage.googleapis.com', models: '/v1beta/models', posts: [], auth: 'x-goog-api-key',
		postPattern: /^\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}:(?:generateContent|streamGenerateContent(?:\?alt=sse)?)$/, drop: ['x-goog-api-client'] },
	openrouter: { base: '/api/v1', host: 'openrouter.ai', models: '/api/v1/models', posts: ['/api/v1/chat/completions'] },
};

function wireMethod(provider, path) {
	const wire = wires[provider];
	if (path === wire.models) return 'GET';
	if (wire.posts.includes(path) || wire.postPattern?.test(path)) return 'POST';
}

function harnessMethod(harness, provider, path) {
	if (harness === 'codex') return provider === 'openai' && wireMethod('chatgpt', path);
	if (harness === 'claude') return provider === 'anthropic' && wireMethod(provider, path);
	if (harness === 'opencode') return wireMethod(provider, path);
}

const forwardHost = value => typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(value);
const forwardPlaceholder = value => typeof value === 'string' && /^wlpm1\.[A-Za-z0-9_.-]{1,1018}$/.test(value);
const validProofKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const proofHeader = 'x-wlp-machine-proof';
function forwardProof(key, machine, method, path, time) {
	return time + '.' + createHmac('sha256', key).update(JSON.stringify([machine, method, path, time])).digest('base64url');
}
module.exports = { wires, wireMethod, harnessMethod, forwardHost, forwardPlaceholder, validProofKey, proofHeader, forwardProof };
