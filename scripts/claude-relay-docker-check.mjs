// Run from server with: pnpm exec tsx ../scripts/claude-relay-docker-check.mjs sha256:<local Claude image id>
import { build } from '../runner/node_modules/esbuild/lib/main.js';
import { checkIsolation } from '../fixtures/claude-relay/isolation.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpConnection, LineSplitter } from '../server/src/sandbox/acp.ts';
import { claudeLimit } from '../server/src/provider-usage.ts';

const image = process.argv[2];
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(root, '.f3-check-'));
const id = randomBytes(8).toString('hex'), prefix = 'f3-check-' + id, machineId = 'm_' + id;
const relayName = 'wlp-claude-relay-' + machineId, socketVolume = 'wlp-claude-socket-' + machineId;
const uplink = prefix + '-uplink', upstream = prefix + '-upstream';
const token = 'sk-ant-oat01-' + randomBytes(32).toString('hex');
const identity = { uid: 'fixture', machineId };
const {privateKey} = generateKeyPairSync('ed25519');
Object.assign(process.env, { WLP_RUNNER_STATE_DIR: dir, F3_DIR: dir, F3_MACHINE: machineId, F3_PREFIX: prefix, PATH: dir + ':' + process.env.PATH });
const relayScript = (await build({ entryPoints: [join(root, 'sandbox/relay/server.cjs')], bundle: true, platform: 'node', write: false })).outputFiles[0].text;
Object.assign(globalThis, { SANDBOX_IMAGE: image, SHOTS_IMAGE_PIN: '', HARNESS_IMAGES: { claude: image }, CLAUDE_RELAY_SCRIPT: relayScript });
const { docker } = await import('../server/src/sandbox/docker.ts');
const { Executor } = await import('../runner/src/docker-executor.ts');
const { storePair } = await import('../runner/src/state.ts');
const { storeClaudeLogin, loginFileState } = await import('../runner/src/harness-login.ts');
const { containerName } = await import('../server/src/sandbox/sandboxes.ts');
const { LABEL, LABEL_ARG } = await import('../server/src/sandbox/docker.ts');
const cmd = async (args, opts) => (await docker(args, { check: true, timeoutMs: 45_000, ...opts })).stdout.trim();
const ok = message => console.log('PASS  ' + message);
const executor = mode => new Executor(identity, {}, false, true, ['docker-hardened'], { mode, allow: [] });
const owner = executor('restricted');
const profile = 'docker-hardened';
const saved = new Map();
async function create(session, machine = owner) {
	const id = await machine.create(session, profile, false, 'claude');
	const name = containerName('claude-' + id.slice(-12));
	const [box] = JSON.parse(await cmd(['container', 'inspect', name]));
	assert.equal(box.Mounts.length, 0);
	assert.ok(!box.Config.Env.some(s => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=/.test(s)));
	const { env } = await machine.turnCredentials('claude-' + id.slice(-12), 'claude', {});
	const placeholder = env.CLAUDE_CODE_OAUTH_TOKEN;
	saved.set(name, { id, placeholder, env }); return name;
}
async function status(name, bearer, host = '127.0.0.1:17892') {
	return cmd(['exec', name, 'node', '-e', `const r=require('http').request('http://127.0.0.1:17892/v1/messages/count_tokens',
		{method:'POST', headers:{host:process.argv[2],authorization:'Bearer '+process.argv[1]}},res=>{console.log(res.statusCode);res.resume()});
		r.on('error',()=>process.exit(1));r.end('{}');`, bearer, host]);
}
const isolation = name => checkIsolation(name, cmd, token, 'claude-agent-sdk-linux-', '/run/wlp-harness/claude/token');
const envFlags = env => Object.entries(env).flatMap(([k,v]) => ['-e', k + '=' + v]);
let adapter;
async function turn(first, proxyEnv, checkFirstTurn, text = 'Say relay check passed.', env = saved.get(first).env) {
	const child = adapter = spawn('docker', ['exec','-i',...envFlags(env),...proxyEnv,first,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
	child.stderr.resume();
	let reply = '';
	const commands = new Set();
	const rpc = new AcpConnection(line => child.stdin.write(line + '\n'), {
		async request() { throw Error('No client tools in fixture'); },
		notification(method, params) {
			if (method !== 'session/update') return;
			const update = params.update;
			if (update.sessionUpdate === 'agent_message_chunk') reply += update.content.text;
			if (update.sessionUpdate === 'available_commands_update')
				for (const command of update.availableCommands) commands.add(command.name);
		},
	}, '');
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding('utf8').on('data', s => lines.push(s));
	child.on('close', () => rpc.end('Adapter closed'));
	const call = (method, params) => rpc.request(method, params, { timeoutMs:45000 });
	await call('initialize', {protocolVersion:1,clientCapabilities:{}});
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[]});
	await call('session/set_mode',{sessionId:opened.sessionId,modeId:opened.modes.currentModeId});
	if (checkFirstTurn) await call('session/set_config_option',{sessionId:opened.sessionId,configId:'model',value:'sonnet'});
	const result = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text}]});
	assert.equal(result.stopReason,'end_turn'); assert.equal(reply,'relay check passed');
	if (checkFirstTurn) {
		assert.ok(commands.has('repo-fixture'), 'the repository slash command was missing from ACP');
		for (const name of ['deep-research', 'simplify', 'loop', 'workflow-authoring', 'plugin-authoring', 'doctor'])
			assert.ok(!commands.has(name), 'ACP advertised the bundled command ' + name);
		await isolation(first);
	}
	child.stdin.end();
}
// A builder's turn with the platform's tools over MCP (platform-tools.ts): the pinned adapter and CLI reach them under
// the image's managed policy, the platform's handlers answer, and a process of the sandbox without the token is refused.
async function toolsTurn(name) {
	const { PLATFORM_MCP_SERVER, PlatformMcpServer, platformToolDeclarations } = await import('../server/src/platform-tools.ts');
	const { askPerson, ASK_TAKEN, REPORT_TAKEN } = await import('../server/src/agent-publish.ts');
	const { fileReport } = await import('../server/src/factory/review.ts');
	const { NO_REDACTION } = await import('../server/src/repo-secrets.ts');
	const filed = [], asked = [], probes = [];
	let running = false;
	const handlers = new Map([
		['report', request => fileReport(request.arguments, NO_REDACTION, report => { filed.push(report); })],
		['ask_person', async request => {
			// While the call waits, a process of the sandbox tries the adapter's endpoint without its token.
			probes.push(await cmd(['exec', name, 'node', '-e', `const lines=require('fs').readFileSync('/proc/net/tcp','utf8').split('\\n').slice(1);
				const ports=lines.map(l=>l.trim().split(/\\s+/)).filter(f=>f[1]&&f[1].startsWith('0100007F:')&&f[3]==='0A').map(f=>parseInt(f[1].split(':')[1],16)).filter(p=>p!==17891&&p!==17892);
				Promise.all(ports.map(p=>fetch('http://127.0.0.1:'+p+'/mcp-d2luZGxhc3MtcGxhdGZvcm0',{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'}).then(async r=>[p,r.status,/ask_person/.test(await r.text())],()=>[p,0,false]))).then(s=>console.log(JSON.stringify(s)))`]));
			const taken = askPerson(request.arguments, { already: asked.length > 0, left: 3 }, NO_REDACTION);
			if (taken.asked) asked.push(taken.asked);
			return taken.told;
		}],
	]);
	const server = new PlatformMcpServer(handlers, platformToolDeclarations(handlers, { screenshots: false }), () => running);
	const child = adapter = spawn('docker', ['exec','-i',...envFlags(saved.get(name).env),name,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
	child.stderr.resume();
	let reply = '';
	const rpc = new AcpConnection(line => child.stdin.write(line + '\n'), {
		async request(method, params, withdrawn) {
			if (method === 'mcp/message') return server.handle(params, withdrawn);
			throw Error('No other client requests in fixture: ' + method);
		},
		notification(method, params) { if (method === 'session/update' && params.update.sessionUpdate === 'agent_message_chunk') reply += params.update.content.text; },
	}, '');
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding('utf8').on('data', s => lines.push(s));
	child.on('close', () => rpc.end('Adapter closed'));
	const call = (method, params) => rpc.request(method, params, { timeoutMs:45000 });
	await call('initialize', {protocolVersion:1,clientCapabilities:{}});
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[PLATFORM_MCP_SERVER]});
	await call('session/set_mode',{sessionId:opened.sessionId,modeId:'bypassPermissions'});
	running = true;
	const result = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:'Platform tool check.'}]});
	running = false;
	child.stdin.end();
	await new Promise(done => child.once('close', done));
	assert.equal(result.stopReason, 'end_turn'); assert.equal(reply, 'platform tools passed');
	assert.deepEqual(filed, [{ screenshots: [], title: 'Relay tool report', description: 'Checked the tools.', lookAt: '', concerns: '' }]);
	assert.deepEqual(asked, [{ text: 'Which store?', options: ['SQLite', 'Postgres'] }]);
	const answered = JSON.parse(probes[0] ?? '[]');
	// The adapter's endpoint answers 401 without the token; no listener of the sandbox hands out the platform's tools.
	const endpoint = answered.filter(([port, status]) => port !== 17894 && status === 401).map(([port]) => port);
	assert.ok(endpoint.length === 1 && !answered.some(([, , tools]) => tools), 'a process without the token reached the tools: ' + probes[0]);
	assert.ok((await cmd(['logs',upstream])).includes('platform tools results=2 told=' + JSON.stringify(REPORT_TAKEN + ' | ' + ASK_TAKEN)), 'the model was not told what the handlers said');
	// Once the adapter is gone its endpoint is too: nothing in the sandbox answers on that route.
	const port = endpoint[0].toString(16).toUpperCase().padStart(4, '0');
	assert.equal(await cmd(['exec', name, 'sh', '-c', `grep -c '0100007F:${port} .* 0A ' /proc/net/tcp || true`]), '0', 'the endpoint outlived its adapter');
}
// A person's turn with push, fetch_base and publish over MCP, in Claude's mode that asks (default): the image's managed policy
// lets the platform's tools through without Claude's own question, each call reaches the handlers as one over MCP, another
// branch is refused, and a publish that answers after 6 minutes (it waits for the person) is not given up on by the CLI,
// whose idle limit for an MCP call is 5 minutes unless the image's wrapper says otherwise.
async function pushTurn(name) {
	const { PLATFORM_MCP_SERVER } = await import('../server/src/platform-tools.ts');
	const { pushTurnServer, PUSH_PROMPT, PUSH_REPLY } = await import('../fixtures/acp-agent/platform-push.mjs');
	const turn = await pushTurnServer({ publishWaitMs: 6 * 60_000 });
	const child = adapter = spawn('docker', ['exec','-i',...envFlags(saved.get(name).env),name,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
	child.stderr.resume();
	let reply = '';
	const rpc = new AcpConnection(line => child.stdin.write(line + '\n'), {
		async request(method, params, withdrawn) {
			if (method === 'mcp/message') return turn.server.handle(params, withdrawn);
			if (method === 'session/request_permission') return turn.permission(params);
			throw Error('No other client requests in fixture: ' + method);
		},
		notification(method, params) { if (method === 'session/update' && params.update.sessionUpdate === 'agent_message_chunk') reply += params.update.content.text; },
	}, '');
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding('utf8').on('data', s => lines.push(s));
	child.on('close', () => rpc.end('Adapter closed'));
	const call = (method, params, timeoutMs = 45000) => rpc.request(method, params, { timeoutMs });
	await call('initialize', {protocolVersion:1,clientCapabilities:{}});
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[PLATFORM_MCP_SERVER]});
	await call('session/set_mode',{sessionId:opened.sessionId,modeId:'default'});
	turn.running = true;
	const result = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:PUSH_PROMPT}]}, 10 * 60_000);
	turn.running = false;
	child.stdin.end();
	await new Promise(done => child.once('close', done));
	assert.equal(result.stopReason, 'end_turn'); assert.equal(reply, PUSH_REPLY);
	turn.check(await cmd(['logs',upstream]));
}
// A turn whose upstream reply carries unified rate-limit headers: what the pinned harness reports from them.
async function limitTurn(name, text) {
	const child = adapter = spawn('docker', ['exec','-i',...envFlags(saved.get(name).env),name,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
	child.stderr.resume();
	const events = [];
	const rpc = new AcpConnection(line => child.stdin.write(line + '\n'), {
		async request() { throw Error('No client tools in fixture'); },
		notification(method, params) {
			const limit = params.update?._meta?.['_claude/rateLimit'];
			if (method === 'session/update' && params.update.sessionUpdate === 'usage_update' && limit) events.push(limit);
		},
	}, '');
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding('utf8').on('data', s => lines.push(s));
	child.on('close', () => rpc.end('Adapter closed'));
	const call = (method, params) => rpc.request(method, params, { timeoutMs:45000 });
	await call('initialize', {protocolVersion:1,clientCapabilities:{}});
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[]});
	await call('session/set_mode',{sessionId:opened.sessionId,modeId:opened.modes.currentModeId});
	const refused = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text}]}).then(() => undefined, error => error);
	child.stdin.end();
	assert.ok(!JSON.stringify(events).includes('req_fixture'));
	return { events, refused, seen: `events=${JSON.stringify(events)} error=${refused?.message} limit=${JSON.stringify(refused?.limit)}` };
}
async function settingsTurn(first, id, change) {
	const forward = { host: 'relay.fixture.test', provider: 'anthropic', placeholder: 'wlpm1.fixture', proofKey: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000 };
	const keyLease = await owner.openTurnKey('claude-' + id.slice(-12), 'claude', forward);
	try {
		const { env } = await owner.turnCredentials('claude-' + id.slice(-12), 'claude', { anthropic: keyLease.placeholder });
		assert.equal(env.ANTHROPIC_API_KEY, keyLease.placeholder);
		await change?.();
		const before = (await cmd(['logs', upstream])).length;
		await turn(first, [], false, 'Settings key check.', env);
		assert.match((await cmd(['logs', upstream])).slice(before), /settings messages authorized=true/);
	} finally { await keyLease.close(); }
	ok('The pinned Claude CLI used the Anthropic Settings lease for this turn.');
}
async function check() {
	execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=api.anthropic.com',
		'-addext','subjectAltName=DNS:api.anthropic.com,DNS:relay.fixture.test','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')], { stdio:'ignore' });
	await writeFile(join(dir,'expected'),token);
	await copyFile(join(root,'fixtures/claude-relay/upstream.cjs'),join(dir,'upstream.cjs'));
	await cmd(['network','create','--internal',uplink]);
	// Mount individual files; the recording origin has no access to the runner's pairing state.
	const mounts = ['key.pem','cert.pem','expected','upstream.cjs'].flatMap(file => ['--mount',`type=bind,src=${dir}/${file},dst=/fixture/${file},readonly`]);
	await cmd(['run','-d','--pull','never','--network',uplink,'--network-alias','api.anthropic.com','--network-alias','relay.fixture.test','--name',upstream,
		'--user',String(process.getuid()),'--cap-drop','ALL',...mounts,image,'node','/fixture/upstream.cjs']);
	storePair(identity, privateKey, 'https://fixture.invalid');
	if (process.argv.includes('--settings-keys')) {
		const id = await owner.create('key', profile, false, 'claude');
		const peer = await owner.create('peer', profile, false, 'claude');
		const name = containerName('claude-' + id.slice(-12));
		await settingsTurn(name, id, () => owner.lifecycle('destroy', peer, 'peer'));
		await storeClaudeLogin(owner, token);
		await settingsTurn(name, id);
		return;
	}
	const bundle = join(dir, 'runner.cjs');
	execFileSync(process.execPath, [join(root, 'runner/bundle.mjs'), image, bundle, 'claude=' + image]);
	await owner.loginChanged(false);
	const unsigned = owner.report().harnesses[0];
	assert.equal(unsigned.signIn, 'none');
	assert.ok(unsigned.options.checkedAt > 0 && unsigned.options.models.length > 1);
	assert.ok(unsigned.options.models.find(model => model.id === 'opus').efforts.includes('high'));
	assert.ok(unsigned.options.modes.some(mode => mode.id === 'plan'));
	execFileSync(process.execPath, [bundle, 'login', 'claude'], { input: token + '\n' });
	await owner.loginChanged(true);
	assert.equal(owner.report().harnesses[0].signIn, 'token');
	ok('Pinned adapter reports models, per-model efforts and modes before login and refreshes after login.');
	const first = await create('first'), second = await create('second');
	for (const name of [first, second]) {
		const [box] = JSON.parse(await cmd(['inspect',name]));
		assert.deepEqual(Object.keys(box.NetworkSettings.Networks), ['none']);
		assert.equal(await cmd(['exec',name,'ls','/sys/class/net']), 'lo');
	}
	await cmd(['exec','-d',second,'node','-e',"require('http').createServer((q,r)=>r.end('peer')).listen(19123,'0.0.0.0')"]);
	assert.equal(await cmd(['exec',second,'curl','--retry','8','--retry-connrefused','--noproxy','*','-fsS','http://127.0.0.1:19123']), 'peer');
	assert.notEqual((await docker(['exec',first,'curl','--max-time','2','--noproxy','*','-fsS','http://127.0.0.1:19123'])).code, 0);
	ok('Restricted Claude sessions have only loopback; a verified listener is unreachable from its peer.');
	const [relay] = JSON.parse(await cmd(['container','inspect',relayName]));
	assert.deepEqual(relay.HostConfig.LogConfig, { Type: 'json-file', Config: { 'max-size': '4m', 'max-file': '2' } }); assert.ok(!JSON.stringify(relay.Config).includes(token));
	assert.ok(relay.Mounts.some(m => m.Name === owner.claudeVolume && !m.RW));
	const one = saved.get(first), two = saved.get(second);
	assert.equal(await status(first, one.placeholder), '200');
	const foreignKey = generateKeyPairSync('ed25519').privateKey;
	const nonce = one.placeholder.split('.')[0];
	const forged = nonce + '.' + sign(null, Buffer.from('windlass-claude-relay-v2\n'+machineId+'\n'+nonce), foreignKey).toString('base64url');
	assert.equal(await status(first, forged), '401');
	assert.equal(await status(first, two.placeholder), '401');
	assert.equal(await status(second, one.placeholder), '401');
	assert.equal(await status(first, one.placeholder, 'foreign.invalid'), '403');
	ok('Both real session containers have zero mounts. Own bearer accepted, cross-session bearer and foreign Host refused.');
	// The fake provider sees the actual model input. Its usage counters are scripted.
	await cmd(['exec',first,'node','-e',`const fs = require('node:fs');
		fs.mkdirSync('/workspace/.claude/commands', { recursive: true });
		fs.writeFileSync('/workspace/CLAUDE.md', 'Use the repository sentinel plum-quartz.');
		fs.writeFileSync('/workspace/.claude/commands/repo-fixture.md', 'Repository fixture command.');
		fs.writeFileSync('/workspace/.claude/settings.json', JSON.stringify({ language: 'Icelandic' }));`]);
	await turn(first, [], true, 'Hello');
	const input = (await cmd(['logs',upstream])).match(/^first-turn input bytes=(\d+) instructions=true language=true repoCommand=true extras=false$/m);
	assert.ok(input, 'expected repository instructions, language and command in the first model request without bundled extras');
	assert.ok(Number(input[1]) < 33_000, 'first-turn input grew to ' + input[1] + ' bytes');
	ok('One-word Sonnet turn sent ' + input[1] + ' bytes of model input including repository instructions and settings.');
	await settingsTurn(first, one.id);
	await toolsTurn(first);
	ok('A builder turn on the pinned CLI reached report and ask_person over MCP under the managed policy; a process without the token was refused.');
	await pushTurn(first);
	ok("A person's turn in default mode reached push, fetch_base and publish over MCP without Claude's own question; another branch was refused, and a publish answered after 6 minutes reached the model.");
	await turn(first, ['-e','HTTP_PROXY=http://127.0.0.1:1','-e','HTTPS_PROXY=http://127.0.0.1:1','-e','http_proxy=http://127.0.0.1:1','-e','https_proxy=http://127.0.0.1:1','-e','NO_PROXY=','-e','no_proxy='], false);
	// What the session itself receives from the relay for a refused request.
	const limited = JSON.parse(await cmd(['exec', first, 'node', '-e', `const r=require('http').request('http://127.0.0.1:17892/v1/messages?beta=true',
		{method:'POST', headers:{authorization:'Bearer '+process.argv[1],'content-type':'application/json'}},res=>{console.log(JSON.stringify({status:res.statusCode,headers:res.headers}));res.resume()});
		r.on('error',()=>process.exit(1));r.end(JSON.stringify({messages:[{role:'user',content:'Rate limit check.'}]}));`, one.placeholder]));
	assert.equal(limited.status, 429);
	assert.equal(limited.headers['anthropic-ratelimit-unified-status'], 'rejected');
	assert.equal(limited.headers['anthropic-ratelimit-unified-reset'], '4102444800');
	assert.equal(limited.headers['retry-after'], '3600');
	assert.equal(limited.headers['request-id'], undefined);
	ok('The relay passes the upstream 429 rate-limit headers to the session, without its request id.');
	const warned = await limitTurn(first, 'Rate warning check.');
	const warning = warned.events.map(event => claudeLimit(event, Date.now())).find(event => event?.window.resetsAt === 4102444800_000);
	assert.ok(!warned.refused && warning && warning.status !== 'rejected' && warning.window.kind === '5h', warned.seen);
	ok(`A reply with unified headers through the relay made the pinned harness report the 5-hour window (${warning.status}) with its reset.`);
	// The pinned adapter attaches no rate-limit event to a refused turn, so the platform learns the limit, not its reset.
	const limitedOut = await limitTurn(first, 'Rate limit check.');
	assert.equal(limitedOut.refused?.limit?.reason, 'usage_limit', limitedOut.seen);
	assert.match(limitedOut.refused.message, /2100/, limitedOut.seen);
	ok('A 429 with unified headers through the relay ended the turn as a usage limit; the harness named its reset.');
	const recorded = await cmd(['logs',upstream]);
	assert.match(recorded,/POST \/v1\/messages\?beta=true bearerMatch=true beta=.*oauth-2025-04-20.*version=2023-06-01/);
	assert.ok(!recorded.includes(token) && !recorded.includes('bearerMatch=false'));
	ok('Pinned ACP/CLI completed a streamed turn through production relay TLS. Recorder verified bearer and OAuth beta.');
	// One request at a time per session: a second turn's request waits at the relay for the first's slot, and the
	// harness is never refused. A counting proxy inside the session records every status the relay answered.
	const single = relayScript.replace('SESSION_REQUESTS = 8', 'SESSION_REQUESTS = 1');
	assert.notEqual(single, relayScript);
	globalThis.CLAUDE_RELAY_SCRIPT = single;
	await owner.prepareClaudeRelay();
	assert.ok(JSON.parse(await cmd(['container','inspect',relayName]))[0].Config.Cmd.join(' ').includes('SESSION_REQUESTS = 1'));
	await cmd(['exec','-d',first,'node','-e',`const http=require('http'),base=new URL('http://127.0.0.1:17892'),seen=[];
		http.createServer((q,r)=>{if(q.url==='/statuses')return r.end(seen.join(','));
		const u=http.request({host:base.hostname,port:base.port,path:q.url,method:q.method,headers:{...q.headers,host:base.host}},v=>{seen.push(v.statusCode);r.writeHead(v.statusCode,v.headers);v.pipe(r)});
		u.on('error',()=>{seen.push('error');r.destroy()});q.pipe(u)}).listen(19124,'127.0.0.1')`]);
	await cmd(['exec',first,'curl','--retry','8','--retry-connrefused','--noproxy','*','-fsS','http://127.0.0.1:19124/statuses']);
	const counted = ['-e','ANTHROPIC_BASE_URL=http://127.0.0.1:19124'];
	const before = (await cmd(['logs',upstream])).split('\n').length;
	const recent = async () => (await cmd(['logs',upstream])).split('\n').slice(before);
	const slow = turn(first, counted, false, 'Slow relay check.');
	for (const end = Date.now() + 45_000; !(await recent()).some(line => line.endsWith('tag=slow'));) {
		assert.ok(Date.now() < end, 'The slow turn never reached the upstream');
		await new Promise(done => setTimeout(done, 200));
	}
	await Promise.all([slow, turn(first, counted, false, 'Queued relay check.')]);
	const order = await recent();
	const freed = order.indexOf('slow done'), queued = order.findIndex(line => line.endsWith('tag=queued'));
	assert.ok(freed >= 0 && queued > freed, 'The queued turn reached the upstream before the slow one freed its slot: ' + order.join(' | '));
	const statuses = await cmd(['exec',first,'curl','--noproxy','*','-fsS','http://127.0.0.1:19124/statuses']);
	assert.match(statuses, /^200(,200)*$/, 'The relay answered the harness: ' + statuses);
	globalThis.CLAUDE_RELAY_SCRIPT = relayScript;
	await owner.prepareClaudeRelay();
	ok(`With one request per session, a second pinned-harness turn waited at the relay for the first's slot and completed; the harness saw only ${statuses}.`);
	ok('Live adapter, CLI and other sandbox processes, mounted files and writable layer passed sentinel scans.');
	await owner.lifecycle('suspend',one.id,'first');
	await owner.lifecycle('connect',one.id,'first'); assert.equal(await status(first,one.placeholder),'200');
	await owner.lifecycle('destroy',one.id,'first');
	const replacement = await create('replacement');
	assert.equal(await status(replacement,one.placeholder),'401');
	assert.equal(await status(replacement,saved.get(replacement).placeholder),'200');
	ok('Restart preserved its own lease. Destroy revoked the removed endpoint.');
	for (const mode of ['none','open']) {
		const machine = executor(mode);
		const name = await create(mode, machine);
		const own = saved.get(name);
		assert.equal(await status(name, own.placeholder), '200');
		assert.equal(await status(name, two.placeholder), '401');
		if (mode === 'none') {
			assert.equal(await cmd(['exec',name,'ls','/sys/class/net']), 'lo');
			await cmd(['exec',name,'sh','-c','test -z "$HTTPS_PROXY" && ! curl -s --max-time 2 http://127.0.0.1:17891']);
		}
		await machine.lifecycle('destroy',own.id,mode);
		ok(mode + ' Claude can use its own relay lease.');
	}
	const legacy = containerName('claude-' + randomBytes(6).toString('hex'));
	await cmd(['run','-d','--pull','never','--name',legacy,'--network','none','--label',LABEL_ARG,...owner.pairingLabelFlags,
		'--label',LABEL+'.session=legacy','--label',LABEL+'.harness=claude','--label',LABEL+'.profile='+profile,
		'--mount','type=volume,src='+owner.claudeVolume+',dst=/run/wlp-harness/claude,readonly',image,'sleep','infinity']);
	const restarted = executor('restricted');
	await restarted.secureCredentialPath(); await restarted.discover();
	assert.equal(await cmd(['inspect','-f','{{.State.Running}}',legacy]),'false');
	const legacyId = 'm'+machineId+'-'+legacy.slice(-12);
	await assert.rejects(restarted.lifecycle('connect',legacyId,'legacy'),/predates credential isolation/);
	await assert.rejects(restarted.existing('legacy',profile,'claude'),/predates credential isolation/);
	assert.throws(()=>restarted.running(legacyId,'legacy'));
	ok('Upgrade stops legacy mounted sessions, keeps their workspace, and refuses reconnect, create and commands.');
	execFileSync(process.execPath, [bundle, 'logout', 'claude']);
	await owner.loginChanged(false);
	assert.deepEqual(owner.report().harnesses[0].options.models, unsigned.options.models);
	assert.notEqual((await docker(['container','inspect',relayName])).code,0);
	await storeClaudeLogin(owner, token);
	await owner.loginChanged(true); assert.equal(await status(second,two.placeholder),'200');
	ok('Logout removes the relay. Relogin restores a retained secure session.');
	const disabled = new Executor(identity, {});
	await disabled.secureCredentialPath();
	assert.notEqual((await docker(['container','inspect',relayName])).code,0);
	assert.equal(await loginFileState(owner),'token');
	ok('Disabling the Claude harness retires its relay and preserves the saved sign-in.');
	await cmd(['create','--name',relayName,'--network','none','--pull','never',image,'true']);
	await assert.rejects(storeClaudeLogin(owner,undefined),/different pairing/);
	assert.equal(await loginFileState(owner),'none','Logout must unlink the token even if relay cleanup refuses a namesake');
	assert.equal(await cmd(['inspect','-f','{{.State.Status}}',relayName]),'created');
	ok('A foreign relay namesake survives cleanup; logout still revokes the volume credential.');
	await cmd(['rm',relayName]);
	await owner.prune();
	assert.notEqual((await docker(['volume','inspect',socketVolume])).code,0);
	assert.notEqual((await docker(['volume','inspect',owner.claudeVolume])).code,0);
	ok('Prune removes the owned socket and login volumes.');
}
await symlink(join(root, 'fixtures/claude-relay/docker.cjs'), join(dir, 'docker'));
try {
	await check();
} catch (error) {
	const logs = await docker(['logs', upstream]);
	if (!logs.stderr.includes(token)) process.stderr.write(logs.stderr);
	throw error;
} finally {
	adapter?.stdin.end();
	const filters = Object.entries(owner.labels).flatMap(([key,value]) => ['--filter','label='+key+'='+value]);
	for (const id of (await cmd(['ps','-aq',...filters])).split(/\s+/).filter(Boolean)) await cmd(['rm','-fv',id]);
	for (const name of [relayName, upstream]) await docker(['rm','-fv',name]);
	for (const vol of (await cmd(['volume','ls','-q',...filters])).split(/\s+/).filter(Boolean)) await cmd(['volume','rm',vol]);
	for (const net of (await cmd(['network','ls','-q',...filters])).split(/\s+/).filter(Boolean)) await cmd(['network','rm',net]);
	await cmd(['network','rm',uplink]);
	await rm(dir,{recursive:true,force:true});
}
