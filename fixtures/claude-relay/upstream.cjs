// Isolated TLS origin. Log only whether the independently provisioned test credential matched.
const fs = require('node:fs');
const https = require('node:https');
https.createServer({ key: fs.readFileSync('/fixture/key.pem'), cert: fs.readFileSync('/fixture/cert.pem') }, async (req, res) => {
	const bytes = [];
	for await (const chunk of req) bytes.push(chunk);
	const match = req.headers.authorization === 'Bearer ' + fs.readFileSync('/fixture/expected', 'utf8');
	console.log(req.method, req.url, 'bearerMatch=' + match, 'beta=' + req.headers['anthropic-beta'], 'version=' + req.headers['anthropic-version']);
	if (!match) { res.writeHead(401); return res.end(); }
	if (req.url.startsWith('/v1/messages/count_tokens')) {
		res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":3}');
	}
	const {model} = JSON.parse(Buffer.concat(bytes));
	res.writeHead(200, { 'content-type': 'text/event-stream' });
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
	res.end();
}).listen(443);
