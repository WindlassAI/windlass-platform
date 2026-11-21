// Isolated recording origin. Only fixture credentials are accepted.
const fs = require('node:fs');
const https = require('node:https');
const marker = fs.readFileSync('/fixture/expected','utf8');
let polls = 0;
let nativeFree;
function freeRequestMatches(req, body) {
	const headers = req.headers;
	if (Number(headers['content-length']) !== Buffer.byteLength(body) || !headers['x-opencode-session-id']
		|| headers['x-opencode-session'] !== headers['x-opencode-session-id']) return false;
	const stable = Object.fromEntries(['accept', 'accept-encoding', 'authorization', 'user-agent', 'content-type',
		'x-opencode-client'].map(k => [k, headers[k]]));
	const shape = JSON.stringify([Object.keys(headers).sort(), stable]);
	// The direct native ACP turn runs first on the fixture network. Keep values in memory only.
	if (!nativeFree) nativeFree = shape;
	return shape === nativeFree;
}
https.createServer({key:fs.readFileSync('/fixture/key.pem'),cert:fs.readFileSync('/fixture/cert.pem')},async (req,res)=>{
	let body = '';
	for await (const chunk of req) body += chunk;
	const json = value => {res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify(value));};
	const reject = () => {res.writeHead(401);res.end();};
	if (req.headers.host === 'auth.openai.com') {
		if (req.url === '/api/accounts/deviceauth/usercode') return json({device_auth_id:'private-fixture',user_code:'ABCD-EFGH',interval:'1'});
		if (req.url === '/api/accounts/deviceauth/token') {
			if (polls++ === 0) {	res.writeHead(403); res.end(); return; }
			return json({authorization_code:'fixture',code_verifier:'fixture'});
		}
		if (req.url !== '/oauth/token') return reject();
		const form = new URLSearchParams(body);
		if (form.get('grant_type') === 'authorization_code') return json({access_token:marker+'-expired', refresh_token:marker+'-refresh', expires_in:1});
		if (form.get('refresh_token') !== marker+'-refresh') return reject();
		console.log('refresh');
		return json({access_token:marker+'-rotated', refresh_token:marker+'-second', expires_in:3600});
	}
	if (req.headers.host === 'api.anthropic.com') {
		if (req.url !== '/v1/messages' || req.headers['x-api-key'] !== marker+'-key') return reject();
		const {model} = JSON.parse(body);
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const chunks = [
			{type:'message_start',message:{id:'msg_check',type:'message',role:'assistant',model,content:[],stop_reason:null,
				stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},
			{type:'content_block_start',index:0,content_block:{type:'text',text:''}},
			{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'relay proof'}},
			{type:'content_block_stop',index:0},
			{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},
			{type:'message_stop'},
		];
		for (const event of chunks) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
		res.end();
		return;
	}
	if (req.headers.host === 'opencode.ai' || req.headers.host === 'api.z.ai') {
		const expected = req.headers.host === 'api.z.ai' ? (req.url === '/api/coding/paas/v4/chat/completions' && marker+'-glm')
			: req.url === '/inference/go/openai/v1/chat/completions' ? marker+'-go' : req.url === '/inference/openai/v1/chat/completions' && 'public';
		if (expected === marker+'-go' && (!req.headers['user-agent'] || !req.headers['x-opencode-session-id'])) return reject();
		if (!expected || req.headers.authorization !== 'Bearer '+expected) return reject();
		if (expected === 'public') {
			if (!freeRequestMatches(req, body)) return reject();
			if (JSON.parse(body).model === 'big-pickle') {
				res.writeHead(429); res.end(marker); return;
			}
		}
		console.log('authorized',req.headers.host,req.url);
		res.writeHead(200,{'content-type':'text/event-stream'});
		for (const [delta,finish_reason] of [[{role:'assistant',content:'relay proof'},null],[{},'stop']]) {
			res.write('data: '+JSON.stringify({id:'msg-free',created:1,model:JSON.parse(body).model,
				object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n');
		}
		return res.end('data: [DONE]\n\n');
	}
	const chatgpt = req.headers.host === 'chatgpt.com' && req.url === '/backend-api/codex/responses';
	const openai = req.headers.host === 'api.openai.com' && req.url === '/v1/responses';
	if (!(chatgpt || openai) || req.headers.authorization !== 'Bearer '+marker+(chatgpt?'-rotated':'-key')) return reject();
	if (chatgpt && !JSON.parse(body).instructions) return reject();
	console.log('authorized',req.headers.host,req.url);
	res.writeHead(200,{'content-type':'text/event-stream'});
	const msg={id:'msg_1',type:'message',role:'assistant',content:[]};
	const ev=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
	const response={id:'resp_1',created_at:1,model:'gpt-5.4',object:'response',status:'in_progress',output:[]};
	ev('response.created',{response});ev('response.output_item.added',{output_index:0,item:msg});
	ev('response.output_text.delta',{output_index:0,item_id:'msg_1',content_index:0,delta:'relay proof'});
	ev('response.output_item.done',{output_index:0,item:{...msg,content:[{type:'output_text',text:'relay proof',annotations:[]}]}});
	ev('response.completed',{response:{...response,status:'completed',usage:{input_tokens:100,output_tokens:4}}});res.end();
}).listen(443);
