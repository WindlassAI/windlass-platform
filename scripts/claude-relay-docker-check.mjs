// Run from server with: pnpm exec tsx ../scripts/claude-relay-docker-check.mjs sha256:<local Claude image id>
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
Object.assign(globalThis, { SANDBOX_IMAGE: image, SHOTS_IMAGE_PIN: '', HARNESS_IMAGES: { claude: image },
	CLAUDE_RELAY_SCRIPT: await readFile(join(root, 'sandbox/relay/server.cjs'), 'utf8') });
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
	const placeholder = box.Config.Env.find(s => s.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')).split('=')[1];
	saved.set(name, { id, placeholder }); return name;
}
async function status(name, bearer, host = '127.0.0.1:17892') {
	return cmd(['exec', name, 'node', '-e', `const r=require('http').request(process.env.ANTHROPIC_BASE_URL+'/v1/messages/count_tokens',
		{method:'POST', headers:{host:process.argv[2],authorization:'Bearer '+process.argv[1]}},res=>{console.log(res.statusCode);res.resume()});
		r.on('error',()=>process.exit(1));r.end('{}');`, bearer, host]);
}
const isolation = name => checkIsolation(name, cmd, token, 'claude-agent-sdk-linux-', '/run/wlp-harness/claude/token');
let adapter;
async function turn(first, proxyEnv, scan) {
	const child = adapter = spawn('docker', ['exec','-i',...proxyEnv,first,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
	child.stderr.resume();
	let reply = '';
	const rpc = new AcpConnection(line => child.stdin.write(line + '\n'), {
		async request() { throw Error('No client tools in fixture'); },
		notification(method, params) { if (method === 'session/update' && params.update.sessionUpdate === 'agent_message_chunk') reply += params.update.content.text; },
	}, '');
	const lines = new LineSplitter(line => rpc.receive(line));
	child.stdout.setEncoding('utf8').on('data', s => lines.push(s));
	child.on('close', () => rpc.end('Adapter closed'));
	const call = (method, params) => rpc.request(method, params, { timeoutMs:45000 });
	await call('initialize', {protocolVersion:1,clientCapabilities:{}});
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[]});
	await call('session/set_mode',{sessionId:opened.sessionId,modeId:opened.modes.currentModeId});
	const result = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:'Say relay check passed.'}]});
	assert.equal(result.stopReason,'end_turn'); assert.equal(reply,'relay check passed');
	if (scan) await isolation(first);
	child.stdin.end();
}
// The upstream refuses this prompt with a 429 and unified headers. The relay passes them through, so the
// pinned harness reports the limit with its reset, as it does without a relay.
async function limitedTurn(name) {
	const child = adapter = spawn('docker', ['exec','-i',name,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
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
	const refused = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:'Rate limit check.'}]}).then(() => undefined, error => error);
	child.stdin.end();
	const reported = events.map(event => claudeLimit(event, Date.now())).find(event => event?.status === 'rejected');
	const seen = `events=${JSON.stringify(events)} error=${refused?.message} limit=${JSON.stringify(refused?.limit)}`;
	assert.ok(reported || refused?.limit, 'No rate-limit report: ' + seen);
	if (reported) assert.equal(reported.window.resetsAt, 4102444800_000, seen);
	if (refused?.limit) assert.equal(refused.limit.resetsAt, 4102444800_000, seen);
	assert.ok(!JSON.stringify(events).includes('req_fixture'));
}
await symlink(join(root, 'fixtures/claude-relay/docker.cjs'), join(dir, 'docker'));
try {
	execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=api.anthropic.com',
		'-addext','subjectAltName=DNS:api.anthropic.com','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')], { stdio:'ignore' });
	await writeFile(join(dir,'expected'),token);
	await copyFile(join(root,'fixtures/claude-relay/upstream.cjs'),join(dir,'upstream.cjs'));
	await cmd(['network','create','--internal',uplink]);
	// Mount individual files; the recording origin has no access to the runner's pairing state.
	const mounts = ['key.pem','cert.pem','expected','upstream.cjs'].flatMap(file => ['--mount',`type=bind,src=${dir}/${file},dst=/fixture/${file},readonly`]);
	await cmd(['run','-d','--pull','never','--network',uplink,'--network-alias','api.anthropic.com','--name',upstream,
		'--user',String(process.getuid()),'--cap-drop','ALL',...mounts,image,'node','/fixture/upstream.cjs']);
	storePair(identity, privateKey, 'https://fixture.invalid');
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
	assert.equal(relay.HostConfig.LogConfig.Type,'none'); assert.ok(!JSON.stringify(relay.Config).includes(token));
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
	await turn(first, [], true);
	await turn(first, ['-e','HTTP_PROXY=http://127.0.0.1:1','-e','HTTPS_PROXY=http://127.0.0.1:1','-e','http_proxy=http://127.0.0.1:1','-e','https_proxy=http://127.0.0.1:1','-e','NO_PROXY=','-e','no_proxy='], false);
	// What the session itself receives from the relay for a refused request.
	const limited = JSON.parse(await cmd(['exec', first, 'node', '-e', `const r=require('http').request(process.env.ANTHROPIC_BASE_URL+'/v1/messages?beta=true',
		{method:'POST', headers:{authorization:'Bearer '+process.argv[1],'content-type':'application/json'}},res=>{console.log(JSON.stringify({status:res.statusCode,headers:res.headers}));res.resume()});
		r.on('error',()=>process.exit(1));r.end(JSON.stringify({messages:[{role:'user',content:'Rate limit check.'}]}));`, one.placeholder]));
	assert.equal(limited.status, 429);
	assert.equal(limited.headers['anthropic-ratelimit-unified-status'], 'rejected');
	assert.equal(limited.headers['anthropic-ratelimit-unified-reset'], '4102444800');
	assert.equal(limited.headers['retry-after'], '3600');
	assert.equal(limited.headers['request-id'], undefined);
	ok('The relay passes the upstream 429 rate-limit headers to the session, without its request id.');
	await limitedTurn(first);
	ok('A 429 with unified headers reached the pinned harness through the relay; it reported the limit with its reset.');
	const recorded = await cmd(['logs',upstream]);
	assert.match(recorded,/POST \/v1\/messages\?beta=true bearerMatch=true beta=.*oauth-2025-04-20.*version=2023-06-01/);
	assert.ok(!recorded.includes(token) && !recorded.includes('bearerMatch=false'));
	ok('Pinned ACP/CLI completed a streamed turn through production relay TLS. Recorder verified bearer and OAuth beta.');
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
