const { createHmac } = require('node:crypto');

const wires = {
	chatgpt: { base: '/v1', host: 'api.openai.com', models: '/v1/models', posts: ['/v1/responses'],
		passed: ['content-type', 'session-id'], dropUnknown: true },
	openai: { base: '/v1', host: 'api.openai.com', models: '/v1/models', posts: ['/v1/responses', '/v1/chat/completions'],
		passed: ['session-id'], drop: ['openai-organization', 'openai-project', 'originator', 'thread-id', 'x-client-feature-id',
			'x-client-request-id', 'x-codex-beta-features', 'x-codex-window-id', 'x-codex-turn-metadata', 'x-openai-internal-codex-responses-lite'] },
	anthropic: { base: '', host: 'api.anthropic.com', models: '/v1/models', posts: ['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true'], auth: 'x-api-key',
		fixed: { 'anthropic-version': '2023-06-01' }, betas: ['interleaved-thinking-2025-05-14', 'claude-code-20250219',
			'context-management-2025-06-27', 'per-turn-control-2026-07-01', 'mid-conversation-tool-changes-2026-07-01',
			'thinking-token-count-2026-05-13', 'thinking-display-updates-2026-08-18', 'advanced-tool-use-2025-11-20', 'effort-2025-11-24',
			'thinking-binding-controls-2026-08-01', 'fine-grained-tool-streaming-2025-05-14', 'structured-outputs-2025-11-13',
			'inline-tools-2026-09-15', 'advisor-tool-2026-03-01'],
		drop: ['anthropic-dangerous-direct-browser-access', 'x-app', 'x-client-request-id', 'x-claude-code-session-id'] },
	google: { base: '', host: 'generativelanguage.googleapis.com', models: '/v1beta/models', posts: [], auth: 'x-goog-api-key',
		postPattern: /^\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}:(?:generateContent|streamGenerateContent(?:\?alt=sse)?)$/, drop: ['x-goog-api-client'] },
	openrouter: { base: '/api/v1', host: 'openrouter.ai', models: '/api/v1/models', posts: ['/api/v1/chat/completions'], drop: ['http-referer', 'x-title'] },
};

// Codex adds its client version when listing models. OpenAI gets the canonical models route.
function wirePath(provider, path) {
	return provider === 'openai' && /^\/v1\/models\?client_version=\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(path) ? wires.openai.models : path;
}

function wireMethod(provider, path) {
	const wire = wires[provider];
	if (wirePath(provider, path) === wire.models) return 'GET';
	if (wire.posts.includes(path) || wire.postPattern?.test(path)) return 'POST';
}

function harnessMethod(harness, provider, path) {
	if (harness === 'codex') return provider === 'openai' && wireMethod('chatgpt', wirePath(provider, path));
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
module.exports = { wires, wirePath, wireMethod, harnessMethod, forwardHost, forwardPlaceholder, validProofKey, proofHeader, forwardProof };
