// Regenerate with the unpacked opencode-linux-arm64@1.19.6 executable as argv[2].
// generate.ts in the tagged source embeds its build-time models.dev/api.json in Bun.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const binary = readFileSync(process.argv[2]);
if (createHash('sha256').update(binary).digest('hex') !== '0dc19cfbfaa07fbde5a8b574aab2319e898e2215a138618d7a7bd41ae7dee567')
	throw Error('Expected the pinned arm64 OpenCode 1.19.6 executable.');
const at = binary.indexOf('typeof{empiriolabs:{id:"empiriolabs"');
if (at < 0) throw Error('Missing embedded registry');
const start = at + 'typeof'.length;
let end = start, depth = 0, quote = 0;
for (; end < binary.length; end++) {
	const c = binary[end];
	if (quote) {
		if (c === 92) end++;
		else if (c === quote) quote = 0;
	} else if ([34,39,96].includes(c)) quote = c;
	else if (c === 123) depth++;
	else if (c === 125 && --depth === 0) break;
}
const snapshot = runInNewContext('(' + binary.toString('utf8', start, end + 1) + ')');

// SDK defaults and inference request formats from the same binary. Model-level
// provider.api and provider.npm override the provider-level values in OpenCode.
const sdk = {
	'openai-compatible': ['chat'], openai: ['responses','https://api.openai.com/v1'],
	anthropic: ['messages','https://api.anthropic.com/v1'], google: ['google','https://generativelanguage.googleapis.com/v1beta'],
	groq: ['chat','https://api.groq.com/openai/v1'], cerebras: ['chat','https://api.cerebras.ai/v1'],
	togetherai: ['chat','https://api.together.xyz/v1'], deepinfra: ['deepinfra','https://api.deepinfra.com/v1'],
	mistral: ['chat','https://api.mistral.ai/v1'], perplexity: ['chat','https://api.perplexity.ai'],
	xai: ['responses','https://api.x.ai/v1'], cohere: ['cohere','https://api.cohere.com/v2'],
	gateway: ['gateway','https://ai-gateway.vercel.sh/v3/ai'],
	'@openrouter/ai-sdk-provider': ['chat'], 'venice-ai-sdk-provider': ['chat','https://api.venice.ai/api/v1'],
};
const providers = {}, unavailable = {};
for (const [id,p] of Object.entries(snapshot).sort(([a],[b]) => a.localeCompare(b,'en'))) {
	const routes = {}, variants = {}, blocked = [];
	const groups = new Map();
	let reason;
	for (const m of Object.values(p.models)) {
		const npm = m.provider?.npm ?? p.npm;
		const adapter = sdk[npm.replace(/^@ai-sdk\//,'')];
		const base = m.provider?.api ?? p.api ?? adapter?.[1];
		if (!adapter || !base || !/^https:\/\/[a-z\d.-]+(?:\/[a-z\d._~/-]*)?$/i.test(base) || id === 'github-copilot') {
			reason = id === 'github-copilot' ? 'Requires a Copilot token exchange' : !adapter ? 'Separate SDK or credential protocol: '+npm
				: 'Needs a local, account-specific or non-HTTPS endpoint';
			blocked.push(m.id); continue;
		}
		const kind = adapter[0];
		const urls = groups.get(kind) ?? new Map();
		const models = urls.get(base) ?? [];
		models.push(m.id); urls.set(base,models); groups.set(kind,urls);
	}
	for (const [kind, urls] of groups) {
		const [[base], ...others] = [...urls].sort((a,b) => b[1].length-a[1].length);
		routes[kind] = base;
		for (const [url,ids] of others) for (const mid of ids) variants[mid] = [kind,url];
	}
	if (!groups.size) { unavailable[id] = reason ?? 'No models'; continue; }
	providers[id] = { name:p.name, routes, ...(blocked.length && {blocked}), ...(Object.keys(variants).length && {variants}) };
}
const out = new URL('../sandbox/relay/providers.json',import.meta.url);
// One record per line keeps changes in release snapshots reviewable.
const rows = Object.entries(providers).map(([id,p]) => '    '+JSON.stringify(id)+': '+JSON.stringify(p));
writeFileSync(out, '{\n  "providers": {\n'+rows.join(',\n')+'\n  },\n  "unavailable": '+JSON.stringify(unavailable,null,2)+'\n}\n');
