// Isolated TLS origin. Log only whether the independently provisioned test credential matched.
const fs = require('node:fs');
const https = require('node:https');
https.createServer({ key: fs.readFileSync('/fixture/key.pem'), cert: fs.readFileSync('/fixture/cert.pem') }, async (req, res) => {
	const bytes = [];
	for await (const chunk of req) bytes.push(chunk);
	const match = req.headers.authorization === 'Bearer ' + fs.readFileSync('/fixture/expected', 'utf8');
	const body = Buffer.concat(bytes).toString();
	const tag = req.url.startsWith('/v1/messages/count_tokens') ? '-' : body.includes('Slow relay check.') ? 'slow' : body.includes('Queued relay check.') ? 'queued' : '-';
	console.log(req.method, req.url, 'bearerMatch=' + match, 'beta=' + req.headers['anthropic-beta'], 'version=' + req.headers['anthropic-version'], 'tag=' + tag);
	if (!match) { res.writeHead(401); return res.end(); }
	if (req.url.startsWith('/v1/messages/count_tokens')) {
		res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":3}');
	}
	// A prompt that asks to be slow holds its relay slot for a while before the reply starts.
	if (tag === 'slow') await new Promise(done => setTimeout(done, 6000));
	// A prompt that asks for the limit gets the subscription's own refusal, with its unified headers.
	if (body.includes('Rate limit check.')) {
		res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600', 'request-id': 'req_fixture',
			'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': '4102444800',
			'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-5h-utilization': '1.0' });
		return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture limit' } }));
	}
	const request = JSON.parse(body);
	const {model} = request;
	if (request.messages?.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'text' && block.text === 'Hello'))) {
		const input = JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools });
		const extras = request.tools?.some(tool => ['Workflow', 'ReportFindings', 'ScheduleWakeup'].includes(tool.name));
		console.log('first-turn input bytes=' + Buffer.byteLength(input), 'instructions=' + input.includes('plum-quartz'),
			'language=' + input.includes('Icelandic'), 'repoCommand=' + input.includes('repo-fixture'), 'extras=' + extras);
	}
	// A prompt that asks for the platform's tools, offered over MCP: a call of report, then of ask_person, then a closing text.
	if (body.includes('Platform tool check.') && (request.tools ?? []).some(tool => tool.name === 'mcp__windlass_platform__report')) {
		const results = (request.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(block => block.type === 'tool_result');
		const told = results.map(r => (Array.isArray(r.content) ? r.content : [{ text: r.content }]).map(c => c.text).join('')).join(' | ');
		console.log('platform tools', 'results=' + results.length, 'told=' + JSON.stringify(told));
		const next = [['mcp__windlass_platform__report', { title: 'Relay tool report', description: 'Checked the tools.' }],
			['mcp__windlass_platform__ask_person', { question: 'Which store?', options: ['SQLite', 'Postgres'] }]][results.length];
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const block = next ? { type: 'tool_use', id: 'toolu_' + results.length, name: next[0], input: {} } : { type: 'text', text: '' };
		const delta = next ? { type: 'input_json_delta', partial_json: JSON.stringify(next[1]) } : { type: 'text_delta', text: 'platform tools passed' };
		for (const event of [
			{type:'message_start',message:{id:'msg_tools',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},
			{type:'content_block_start',index:0,content_block:block}, {type:'content_block_delta',index:0,delta}, {type:'content_block_stop',index:0},
			{type:'message_delta',delta:{stop_reason:next ? 'tool_use' : 'end_turn',stop_sequence:null},usage:{output_tokens:3}}, {type:'message_stop'},
		]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
		return res.end();
	}
	// A person's turn with push, fetch_base and publish over MCP: a push, one that names main, a fetch, a publish, then text.
	if (body.includes('Platform push check.') && (request.tools ?? []).some(tool => tool.name === 'mcp__windlass_platform__push')) {
		const results = (request.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(block => block.type === 'tool_result');
		const told = results.map(r => (Array.isArray(r.content) ? r.content : [{ text: r.content }]).map(c => c.text).join('')).join(' | ');
		console.log('platform push', 'results=' + results.length, 'told=' + JSON.stringify(told));
		const next = [['mcp__windlass_platform__push', { message: 'From the relay' }], ['mcp__windlass_platform__push', { branch: 'main' }],
			['mcp__windlass_platform__fetch_base', {}], ['mcp__windlass_platform__publish', { title: 'Relay publish', description: 'Checked publish.' }]][results.length];
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const block = next ? { type: 'tool_use', id: 'toolu_p' + results.length, name: next[0], input: {} } : { type: 'text', text: '' };
		const delta = next ? { type: 'input_json_delta', partial_json: JSON.stringify(next[1]) } : { type: 'text_delta', text: 'platform push passed' };
		for (const event of [
			{type:'message_start',message:{id:'msg_push',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},
			{type:'content_block_start',index:0,content_block:block}, {type:'content_block_delta',index:0,delta}, {type:'content_block_stop',index:0},
			{type:'message_delta',delta:{stop_reason:next ? 'tool_use' : 'end_turn',stop_sequence:null},usage:{output_tokens:3}}, {type:'message_stop'},
		]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
		return res.end();
	}
	// A prompt that asks for a warning gets a normal reply with the 5-hour window nearly used.
	res.writeHead(200, { 'content-type': 'text/event-stream', ...(body.includes('Rate warning check.') && {
		'anthropic-ratelimit-unified-status': 'allowed_warning', 'anthropic-ratelimit-unified-reset': '4102444800',
		'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-5h-utilization': '0.93',
		'anthropic-ratelimit-unified-5h-reset': '4102444800', 'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9' }) });
	const chunks = [
		{type:'message_start',message:{id:'msg_check',type:'message',role:'assistant',model,content:[],stop_reason:null,
			stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},
		{type:'content_block_start',index:0,content_block:{type:'text',text:''}},
		{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'relay check passed'}},
		{type:'content_block_stop',index:0},
		{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},
		{type:'message_stop'},
	];
	for (const event of chunks) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
	res.end(() => { if (tag === 'slow') console.log('slow done'); });
}).listen(443);
