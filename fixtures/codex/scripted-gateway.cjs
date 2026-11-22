// Offline Responses API for codex-sandbox-escape-check.mjs. The first turn request answers with the
// `exec` tool call in env WLP_SCRIPT; later requests end the turn. Each request's tool outputs are
// appended to /tmp/tool-outputs.jsonl.
const fs = require('node:fs');
const http = require('node:http');
let calls = 0;
http
	.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.url.includes('/models')) {
				res.setHeader('content-type', 'application/json');
				return res.end(JSON.stringify({ data: [{ id: 'gpt-6.2-sol' }], models: [{ slug: 'gpt-6.2-sol', visibility: 'list' }] }));
			}
			const input = JSON.parse(body).input ?? [];
			for (const item of input.filter((i) => i.type === 'custom_tool_call_output'))
				fs.appendFileSync('/tmp/tool-outputs.jsonl', JSON.stringify(item.output) + '\n');
			const n = ++calls;
			const item =
				n === 1
					? { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: process.env.WLP_SCRIPT, status: 'completed' }
					: { type: 'message', id: 'msg_' + n, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
			res.setHeader('content-type', 'text/event-stream');
			for (const event of [
				{ type: 'response.created', response: { id: 'r' + n } },
				{ type: 'response.output_item.added', output_index: 0, item },
				{ type: 'response.output_item.done', output_index: 0, item },
				{ type: 'response.completed', response: { id: 'r' + n, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
			])
				res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
			res.end();
		});
	})
	.listen(17892, '127.0.0.1');
