// Only the Codex relay opens the machine login. The session presents a signed lease.
const { createPublicKey, randomUUID } = require('node:crypto');
const { readFile, rename, rm, writeFile } = require('node:fs/promises');
const { rmSync } = require('node:fs');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { providerFor } = require('./opencode.cjs');
const { createRelay, stopOnSignal, SIGNED_OUT, NOTES_FILE } = require('./server.cjs');

const filename = '/run/wlp-harness/codex/login.json';
const models = /^\/codex\/v1\/models(?:\?client_version=\d{1,4}\.\d{1,4}\.\d{1,4})?$/;
const responses = '/codex/v1/responses';
async function persist(record, path = filename) {
	const temp = path + '.' + randomUUID();
	try {
		await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o400 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}
function jwtExpiry(token) {
	try {
		return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp;
	} catch {
		return undefined;
	}
}
// Native Codex refresh replies may carry the expiry in the access JWT.
async function exchange(url, options) {
	const reply = await fetch(url, options);
	if (!reply.ok) return reply;
	const tokens = await reply.json();
	tokens.expires_in ??= jwtExpiry(tokens.access_token) - Date.now() / 1000;
	return { ok: true, json: async () => tokens };
}
function codexProvider(provider, generation, options = {}) {
	if (!['chatgpt', 'openai'].includes(provider)) throw Error('Invalid Codex login method.');
	let servedTurn = false;
	const load =
		options.load ??
		(async () =>
			JSON.parse(
				await readFile(filename, 'utf8').catch((error) => {
					if (error.code === 'ENOENT') return '{}';
					throw error;
				}),
			));
	const auth = providerFor(provider, generation, {
		exchange,
		responses: true,
		...options,
		async load() {
			const record = await load();
			return servedTurn && record.verifyRefreshAfterTurn ? { ...record, expires: 0 } : record;
		},
		async persist(record) {
			if (servedTurn) delete record.verifyRefreshAfterTurn;
			await (options.persist ?? persist)(record);
		},
	});
	return {
		methodFor: (url) => (models.test(url) ? 'GET' : url === responses ? 'POST' : undefined),
		accepts: (url) => models.test(url) || url === responses,
		bearer: (headers) => headers.authorization,
		closeEachReply: true,
		// chatgpt.com/backend-api answers a ChatGPT-token stream with a 200 and no content type (or text/plain),
		// as api.openai.com does for Windlass (windlass.cjs): the Responses route is read as an event stream.
		untyped: (method, url) => (method === 'POST' && url === responses ? 'text/event-stream' : null),
		responseFilter: auth.responseFilter,
		secrets: auth.secrets,
		drain: auth.drain,
		async target(url, headers) {
			if (!models.test(url) && url !== responses) return;
			const target = await auth.target('/openai/responses', {});
			if (!target) return;
			if (url === responses) servedTurn = true;
			if (provider === 'chatgpt') target.headers.originator = 'codex_cli_rs';
			if (models.test(url))
				target.path = provider === 'chatgpt' ? '/backend-api/codex/models?client_version=0.171.0' : '/v1/models';
			else if (headers['content-encoding'] === 'zstd') target.headers['content-encoding'] = 'zstd';
			return target;
		},
		catalogFilter() {
			// A model id's UTF-8 bytes may be split across chunks.
			const decoder = new StringDecoder('utf8');
			let body = '';
			return new Transform({
				transform(chunk, enc, done) {
					body += decoder.write(chunk);
					done(body.length > 4 * 1024 * 1024 ? Error('Catalog too large') : undefined);
				},
				flush(done) {
					try {
						const catalog = JSON.parse(body + decoder.end());
						const ids =
							provider === 'chatgpt'
								? catalog.models.filter((m) => m.visibility !== 'hide').map((m) => m.slug)
								: catalog.data.map((m) => m.id);
						if (!ids.every((id) => typeof id === 'string' && id.length <= 512)) throw Error('Invalid catalog');
						done(null, JSON.stringify({ data: ids.map((id) => ({ id })) }));
					} catch (error) {
						done(error);
					}
				},
			});
		},
	};
}
module.exports = { codexProvider, persist };
if (process.env.WLP_CODEX_RELAY_PUBLIC_KEY) {
	const publicKey = createPublicKey({
		key: Buffer.from(process.env.WLP_CODEX_RELAY_PUBLIC_KEY, 'base64'),
		type: 'spki',
		format: 'der',
	});
	const socket = '/workspace/relay.sock';
	rmSync(socket, { force: true });
	rmSync(SIGNED_OUT, { force: true });
	const provider = codexProvider(process.env.WLP_CODEX_PROVIDER, process.env.WLP_CODEX_GENERATION);
	stopOnSignal(
		createRelay({
			harness: 'codex', publicKey,
			machine: process.env.WLP_CODEX_RELAY_MACHINE,
			domain: process.env.WLP_CODEX_SESSION_DOMAIN,
			provider,
			notesFile: NOTES_FILE,
		}).listen(socket),
		provider,
	);
}
