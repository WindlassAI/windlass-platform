// One prompt through wlp-codex-acp in mode WLP_MODE, for codex-sandbox-escape-check.mjs. Prints one JSON
// line: the permission requests Codex sent (each answered allow_once, the most a user could do), the mode
// the session opened in and the prompt's outcome. With WLP_MCP=1 the session is also handed the platform's
// MCP server over ACP (`"type": "acp"`), answered here as server/src/platform-tools.ts answers it; each
// `mcp/message` is appended to /tmp/mcp.jsonl, and the prompt answer's `usage` is printed. WLP_MCP_PUBLISH_MS: a call
// of publish is answered only after so long, as a publish that waits for the person is.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mcp = process.env.WLP_MCP === '1';
const VERSION = '2026-07-28';
const TOOLS = [
	{ name: 'report', description: 'File what you did.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
	{ name: 'ask_person', description: 'Ask your person one question.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
	{ name: 'publish', description: 'Publish the work.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
	{ name: 'push', description: 'Push the branch.', inputSchema: { type: 'object', properties: { message: { type: 'string' }, branch: { type: 'string' } } } },
	{ name: 'fetch_base', description: 'Fetch the base.', inputSchema: { type: 'object', properties: {} } },
].map((tool) => ({ ...tool, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }));
function mcpAnswer(params) {
	if (params.serverId !== 'windlass-platform') return { error: { code: -32602, message: 'No such server on this connection.' } };
	const inner = params.params ?? {};
	switch (params.method) {
		case 'server/discover': return { result: { resultType: 'complete', supportedVersions: [VERSION], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'windlass_platform', version: '1' }, ttlMs: 0, cacheScope: 'private' } };
		case 'ping': return { result: {} };
		case 'tools/list': return { result: { tools: TOOLS } };
		case 'tools/call': return { result: { content: [{ type: 'text', text: 'Recorded ' + inner.name + '.' }], isError: false } };
		default: return { error: { code: -32601, message: 'Method not found' } };
	}
}
const child = spawn('wlp-codex-acp', [], {
	stdio: ['pipe', 'pipe', 'ignore'],
	env: { ...process.env, WLP_SESSION_BEARER: 'a'.repeat(32) + '.' + 'b'.repeat(86) },
});
const pending = new Map();
const asked = [];
// Tool calls as the client sees them (with WLP_MCP): title, status and text of each tool_call and update.
const calls = [];
let id = 0;
const send = (frame) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const request = (method, params) =>
	new Promise((ok, fail) => {
		pending.set(++id, { ok, fail });
		send({ id, method, params });
	});
createInterface({ input: child.stdout }).on('line', (line) => {
	const frame = JSON.parse(line);
	if (frame.method === 'mcp/message' && mcp) {
		appendFileSync('/tmp/mcp.jsonl', JSON.stringify(frame.params) + '\n');
		const late = frame.params.method === 'tools/call' && frame.params.params?.name === 'publish' ? Number(process.env.WLP_MCP_PUBLISH_MS ?? 0) : 0;
		setTimeout(() => send({ id: frame.id, result: mcpAnswer(frame.params) }), late);
	} else if (frame.method === 'session/request_permission') {
		asked.push(frame.params.toolCall);
		const allow = frame.params.options.find((o) => o.kind === 'allow_once');
		send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
	} else if (mcp && frame.method === 'session/update' && /^tool_call/.test(frame.params?.update?.sessionUpdate ?? '')) {
		const u = frame.params.update;
		calls.push({ id: u.toolCallId, title: u.title, status: u.status, text: JSON.stringify(u.content ?? u.rawOutput ?? null).slice(0, 3000) });
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
	const { sessionId, modes, configOptions } = await request('session/new', { cwd: '/workspace', mcpServers: mcp ? [{ type: 'acp', name: 'windlass_platform', serverId: 'windlass-platform' }] : [] });
	const opened = configOptions?.find((o) => o.category === 'mode')?.currentValue ?? modes?.currentModeId;
	// An empty WLP_MODE keeps the mode the session opened in.
	if (process.env.WLP_MODE) await request('session/set_config_option', { sessionId, configId: 'mode', value: process.env.WLP_MODE });
	const answered = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
	outcome = { opened, stopReason: answered.stopReason, ...(answered.usage !== undefined && { usage: answered.usage }) };
} catch (error) {
	outcome = { error: JSON.stringify(error) };
}
console.log(JSON.stringify({ asked, ...outcome, ...(mcp && { calls }) }));
// Ended as the platform ends a turn: stdin closed, so that every process of the agent ends with it (the MCP
// bridge holds its fixed port until then), and killed only if it does not.
child.stdin.end();
const ended = new Promise((resolve) => child.once('exit', resolve));
if (!(await Promise.race([ended.then(() => true), new Promise((resolve) => setTimeout(resolve, 10_000, false))]))) child.kill();
process.exit(0);
