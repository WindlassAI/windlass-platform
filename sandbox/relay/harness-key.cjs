// A machine relay takes the turn's local placeholder. Only the platform can resolve the forwarded one.
const { readFile } = require('node:fs/promises');
const { wires, allowedBetas, wirePath, harnessMethod, forwardProof, proofHeader } = require('./wires.cjs');

function keyRoute(harness, url) {
	if (harness === 'claude') {
		const path = url.replace(/\?beta=true$/, '');
		if (harnessMethod(harness, 'anthropic', path)) return { provider: 'anthropic', path };
	} else if (harness === 'codex') {
		if (!url.startsWith('/codex/')) return;
		const path = wirePath('openai', url.slice('/codex'.length));
		if (harnessMethod(harness, 'openai', path)) return { provider: 'openai', path };
	} else if (harness === 'opencode') {
		const match = /^\/(anthropic|google|openai|openrouter)(\/.*)$/.exec(url);
		if (!match) return;
		const provider = match[1], wire = wires[provider];
		const path = (provider === 'anthropic' ? '/v1' : provider === 'google' ? '/v1beta' : wire.base) + match[2];
		if (harnessMethod(harness, provider, path)) return { provider, path };
	}
}

exports.harnessKeyProvider = function(harness, machine, incoming, scrub, load = file => readFile(file, 'utf8').then(JSON.parse)) {
	const placeholder = incoming['x-api-key'] ?? incoming['x-goog-api-key'] ?? incoming.authorization?.replace(/^Bearer /, '');
	if (!/^wlp-model\.[a-f0-9]{32}$/.test(placeholder ?? '')) return;
	const record = async nonce => {
		if (!/^[a-f0-9]{32}$/.test(nonce)) return;
		const value = await load('/run/wlp-keys/' + nonce + '.' + placeholder).catch(() => null);
		return value?.expiresAt > Date.now() && value.proofKey ? value : null;
	};
	return {
		bearer: () => placeholder,
		authorize: async (_, nonce) => !!await record(nonce),
		methodFor(url) {
			const route = keyRoute(harness, url);
			if (route) return route.path === wires[route.provider].models ? 'GET' : 'POST';
		},
		async target(url, incoming, nonce) {
			const key = await record(nonce);
			if (!key) return;
			const route = keyRoute(harness, url);
			if (!route || route.provider !== key.provider) return { refused: true };
			const { path, provider } = route, wire = wires[provider];
			const auth = wire.auth ?? 'authorization';
			if (incoming[auth] !== (wire.auth ? placeholder : 'Bearer ' + placeholder)) return { refused: true };
			const method = this.methodFor(url);
			const proof = forwardProof(key.proofKey, machine, method, path, Date.now());
			const headers = { [auth]: wire.auth ? key.placeholder : 'Bearer ' + key.placeholder, [proofHeader]: proof };
			if (method === 'POST') headers['content-type'] = 'application/json';
			if (method === 'POST' && provider === 'openai' && incoming['content-encoding'] === 'zstd') headers['content-encoding'] = 'zstd';
			if (method === 'POST' && wire.betas) {
				const betas = allowedBetas(incoming['anthropic-beta'] ?? '', wire.betas);
				if (betas) headers['anthropic-beta'] = betas;
			}
			return { hostname: key.host, path: '/model-relay' + path, headers, secrets: [key.placeholder, proof] };
		},
		responseFilter: (type, url, secrets) => scrub(secrets, type, true),
	};
};
