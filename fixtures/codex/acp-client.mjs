// One prompt through wlp-codex-acp in mode WLP_MODE, for codex-sandbox-escape-check.mjs. Prints one JSON
// line: the permission requests Codex sent (each answered allow_once, the most a user could do) and the
// prompt's outcome.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn('wlp-codex-acp', [], {
	stdio: ['pipe', 'pipe', 'ignore'],
	env: { ...process.env, WLP_SESSION_BEARER: 'a'.repeat(32) + '.' + 'b'.repeat(86) },
});
const pending = new Map();
const asked = [];
let id = 0;
const send = (frame) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const request = (method, params) =>
	new Promise((ok, fail) => {
		pending.set(++id, { ok, fail });
		send({ id, method, params });
	});
createInterface({ input: child.stdout }).on('line', (line) => {
	const frame = JSON.parse(line);
	if (frame.method === 'session/request_permission') {
		asked.push(frame.params.toolCall);
		const allow = frame.params.options.find((o) => o.kind === 'allow_once');
		send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
	} else if (frame.method && frame.id !== undefined) send({ id: frame.id, error: { code: -32601, message: 'not here' } });
	else if (!frame.method) {
		const waiting = pending.get(frame.id);
		pending.delete(frame.id);
		if (frame.error) waiting?.fail(frame.error);
		else waiting?.ok(frame.result);
	}
});
let outcome;
try {
	await request('initialize', { protocolVersion: 1, clientCapabilities: { auth: { _meta: { gateway: true } }, fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'check', version: '0' } });
	await request('providers/set', { providerId: 'openai', apiType: 'openai', baseUrl: 'http://127.0.0.1:17892/codex/v1', headers: {} });
	const { sessionId } = await request('session/new', { cwd: '/workspace', mcpServers: [] });
	await request('session/set_config_option', { sessionId, configId: 'mode', value: process.env.WLP_MODE });
	outcome = { stopReason: (await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })).stopReason };
} catch (error) {
	outcome = { error: JSON.stringify(error) };
}
console.log(JSON.stringify({ asked, ...outcome }));
child.kill();
process.exit(0);
