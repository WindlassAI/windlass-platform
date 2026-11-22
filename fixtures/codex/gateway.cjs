// Offline provider used only in the Codex Docker proof.
const http = require('node:http');
const models = ['gpt-6.2-sol', 'gpt-5.4', ...Array.from({ length: 38 }, (_, i) => 'fixture-' + i)];
exports.models = models;
exports.respond = (req, res) => {
	if (req.url.includes('/models')) {
		res.setHeader('content-type', 'application/json');
		return res.end(
			JSON.stringify({
				data: models.map((id) => ({ id })),
				models: models.map((slug) => ({ slug, visibility: 'list' })),
			}),
		);
	}
	if (!req.url.endsWith('/responses')) {
		res.writeHead(404);
		return res.end();
	}
	res.setHeader('content-type', 'text/event-stream');
	const item = {
		type: 'message',
		id: 'msg_fixture',
		role: 'assistant',
		status: 'completed',
		content: [{ type: 'output_text', text: 'Fixture turn complete.', annotations: [] }],
	};
	for (const event of [
		{ type: 'response.created', response: { id: 'resp_fixture' } },
		{ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
		{
			type: 'response.output_text.delta',
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: 'Fixture turn complete.',
		},
		{ type: 'response.output_item.done', output_index: 0, item },
		{
			type: 'response.completed',
			response: { id: 'resp_fixture', output: [item], usage: { input_tokens: 1, output_tokens: 4, total_tokens: 5 } },
		},
	])
		res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
	res.end();
};
if (require.main === module) http.createServer(exports.respond).listen(17892, '127.0.0.1');
