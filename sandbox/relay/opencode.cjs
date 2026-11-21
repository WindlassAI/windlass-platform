// This process owns refresh. Setup stops it before replacing or removing a login.
const { createPublicKey, randomUUID } = require('node:crypto');
const { readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { rmSync } = require('node:fs');
const { createRelay } = require('./server.cjs');

const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const filename = '/run/wlp-harness/opencode/login.json';
const api = {
	openai: { hostname: 'api.openai.com', route: '/openai/responses', path: '/v1/responses' },
	chatgpt: { hostname: 'chatgpt.com', route: '/openai/responses', path: '/backend-api/codex/responses' },
	anthropic: { hostname: 'api.anthropic.com', route: '/anthropic/messages', path: '/v1/messages' },
};

function claims(token) {
	try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
	catch { return {}; }
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
	async function credential() {
		const record = await load();
		if (record.generation !== generation || record.provider !== provider) return;
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
			const id = claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;
			const next = { ...latest, access: tokens.access_token, refresh: tokens.refresh_token,
				accountId: id || latest.accountId, expires: Date.now() + 1000 * tokens.expires_in };
			await persist(next);
			return next;
		})().finally(() => { refresh = undefined; });
	}
	return {
		accepts: url => url === endpoint.route,
		bearer: h => provider === 'anthropic' ? 'Bearer ' + h['x-api-key'] : h.authorization,
		async target(url, h) {
			if (url !== endpoint.route) return;
			const record = await credential();
			if (!record) return;
			const headers = { 'content-type': 'application/json' };
			if (provider === 'anthropic') {
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
