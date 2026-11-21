// This process owns refresh. Setup stops it before replacing or removing a login.
const { createPublicKey, randomUUID } = require('node:crypto');
const { readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { rmSync } = require('node:fs');
const { createRelay } = require('./server.cjs');

const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const filename = '/run/wlp-harness/opencode/login.json';
const api = {
	free: { hostname: 'opencode.ai', route: '/free/chat/completions', path: '/inference/openai/v1/chat/completions' },
	openai: { hostname: 'api.openai.com', route: '/openai/responses', path: '/v1/responses' },
	chatgpt: { hostname: 'chatgpt.com', route: '/openai/responses', path: '/backend-api/codex/responses' },
	anthropic: { hostname: 'api.anthropic.com', route: '/anthropic/messages', path: '/v1/messages' },
};

function claims(token) {
	try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
	catch { return {}; }
}
function accountId(token) {
	const c = claims(token);
	return c.chatgpt_account_id || c['https://api.openai.com/auth']?.chatgpt_account_id || c.organizations?.[0]?.id;
}

// Filter at the credential boundary, before any result can enter an agent file, log or ACP stream.
function scrubStream(secrets) {
	const decoder = new StringDecoder('utf8');
	let pending = '';
	function consume(text, final) {
		const input = pending + text;
		pending = '';
		let result = '', start = 0;
		while (start < input.length) {
			let at = input.length, size = 0;
			for (const secret of secrets) {
				let i = input.indexOf(secret[0], start);
				while (i >= 0 && i <= at) {
					if (input.startsWith(secret, i)) {
						if (i < at || secret.length > size) { at = i; size = secret.length; }
						break;
					}
					if (!final && secret.startsWith(input.slice(i))) {
						if (i < at) { at = i; size = 0; }
						break;
					}
					i = input.indexOf(secret[0], i + 1);
				}
			}
			result += input.slice(start, at);
			if (!size) { pending = input.slice(at); break; }
			result += '[redacted]';
			start = at + size;
		}
		return result;
	}
	return new Transform({
		transform(chunk, encoding, done) { done(null, consume(decoder.write(chunk), false)); },
		flush(done) { done(null, consume(decoder.end(), true)); },
	});
}
async function save(record) {
	const temp = filename + '.' + randomUUID();
	try {
		await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
		await rename(temp, filename);
	} finally { await unlink(temp).catch(() => {}); }
}
function providerFor(provider, generation, { load = async () => JSON.parse(await readFile(filename, 'utf8')), persist = save, exchange = fetch } = {}) {
	const endpoint = api[provider];
	if (!endpoint) throw new Error('Unsupported provider.');
	let refresh;
	const secrets = new Set();
	function remember(record) {
		for (const value of [record.key, record.refresh, record.access]) if (value) secrets.add(value);
	}
	async function credential() {
		const record = await load();
		if (record.generation !== generation || record.provider !== provider) return;
		remember(record);
		if (provider !== 'chatgpt' || record.expires > Date.now() + 30000) return record;
		// Re-read inside the single flight: a concurrent request may have already rotated.
		return refresh ??= (async () => {
			const latest = await load();
			if (latest.provider !== provider || latest.generation !== generation) return;
			if (latest.expires > Date.now() + 30000) return latest;
			const res = await exchange('https://auth.openai.com/oauth/token', {
				method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
				body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: latest.refresh }),
			});
			if (!res.ok) return;
			const tokens = await res.json();
			if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) return;
			const id = accountId(tokens.id_token) || accountId(tokens.access_token);
			const next = { ...latest, access: tokens.access_token, refresh: tokens.refresh_token,
				accountId: id || latest.accountId, expires: Date.now() + 1000 * tokens.expires_in };
			await persist(next);
			remember(next);
			return next;
		})().finally(() => { refresh = undefined; });
	}
	return {
		responseFilter: () => secrets.size ? scrubStream(secrets) : undefined,
		accepts: url => url === endpoint.route,
		bearer: h => provider === 'free' ? 'Bearer ' + h['x-wlp-session'] : provider === 'anthropic' ? 'Bearer ' + h['x-api-key'] : h.authorization,
		async target(url, h) {
			if (url !== endpoint.route) return;
			const record = await credential();
			if (!record) return;
			const headers = { 'content-type': 'application/json' };
			if (provider === 'free') headers.authorization = 'Bearer public';
			else if (provider === 'anthropic') {
				headers['x-api-key'] = record.key;
				headers['anthropic-version'] = '2023-06-01';
				if (h['anthropic-beta']) headers['anthropic-beta'] = h['anthropic-beta'];
			} else {
				headers.authorization = 'Bearer ' + (provider === 'chatgpt' ? record.access : record.key);
				if (provider === 'chatgpt') {
					headers.originator = 'opencode';
					if (record.accountId) headers['chatgpt-account-id'] = record.accountId;
					const c = claims(record.access);
					const residency = c['https://api.openai.com/auth']?.chatgpt_compute_residency ?? c.chatgpt_compute_residency;
					if (residency && residency !== 'no_constraint') headers['x-openai-internal-codex-residency'] = residency;
				}
			}
			return { hostname: endpoint.hostname, path: endpoint.path, headers };
		},
	};
}
exports.providerFor = providerFor;
if (process.env.WLP_OPENCODE_RELAY_PUBLIC_KEY) {
	const generation = process.env.WLP_OPENCODE_GENERATION;
	const publicKey = createPublicKey({ key: Buffer.from(process.env.WLP_OPENCODE_RELAY_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
	const socket = '/workspace/relay.sock';
	rmSync(socket, { force: true });
	createRelay({ publicKey, machine: process.env.WLP_OPENCODE_RELAY_MACHINE,
		domain: 'windlass-opencode-relay-v1-' + generation, provider: providerFor(process.env.WLP_OPENCODE_PROVIDER, generation) }).listen(socket);
}
