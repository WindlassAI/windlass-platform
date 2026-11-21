// Run from server with: pnpm exec tsx ../scripts/opencode-docker-check.mjs sha256:<local OpenCode image id>
import { build } from '../runner/node_modules/esbuild/lib/main.js';
import { checkIsolation } from '../fixtures/claude-relay/isolation.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpConnection, LineSplitter } from '../server/src/sandbox/acp.ts';

const image = process.argv[2];
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(root, '.f3-check-'));
const id = randomBytes(8).toString('hex'), prefix = 'f3-check-' + id, machineId = 'm_' + id;
const relayName = 'wlp-opencode-relay-' + machineId;
const uplink = prefix + '-uplink', upstream = prefix + '-upstream';
const token = 'oc-fixture-' + randomBytes(32).toString('hex');
const identity = { uid: 'fixture', machineId };
const {privateKey} = generateKeyPairSync('ed25519');
Object.assign(process.env, { WLP_RUNNER_STATE_DIR: dir, F3_HARNESS: "opencode", F3_DIR: dir, F3_MACHINE: machineId, F3_PREFIX: prefix, PATH: dir + ':' + process.env.PATH });
Object.assign(globalThis, { SANDBOX_IMAGE: image, SHOTS_IMAGE_PIN: '', HARNESS_IMAGES: { opencode: image }, OPENCODE_RELAY_SCRIPT: (await build({
	entryPoints: [join(root, 'sandbox/relay/opencode.cjs')], bundle:true, platform:'node', format:'cjs', write:false })).outputFiles[0].text,
	CLAUDE_RELAY_SCRIPT: await readFile(join(root, 'sandbox/relay/server.cjs'), 'utf8') });
const { docker } = await import('../server/src/sandbox/docker.ts');
const { Executor } = await import('../runner/src/docker-executor.ts');
const { storePair } = await import('../runner/src/state.ts');
const { beginProviderLogin, storeProvider } = await import('../runner/src/opencode-login.ts');
const { probeHarnessOptions } = await import('../runner/src/harness-options.ts');
const { channelTurn } = await import('../fixtures/opencode/channel.mjs');
const { containerName } = await import('../server/src/sandbox/sandboxes.ts');
const cmd = async (args, opts) => (await docker(args, { check: true, timeoutMs: 45_000, ...opts })).stdout.trim();
const ok = message => console.log('PASS  ' + message);
const executor = mode => new Executor(identity, {}, false, false, ['docker-hardened'], { mode, allow: [] }, true);
const owner = executor('restricted');
const profile = 'docker-hardened';
const saved = new Map();
async function create(session, machine = owner) {
	const id = await machine.create(session, profile, false, 'opencode');
	const name = containerName('opencode-' + id.slice(-12));
	const [box] = JSON.parse(await cmd(['container', 'inspect', name]));
	assert.equal(box.Mounts.length, 0);
	const placeholder = JSON.parse(box.Config.Env.find(s => s.startsWith('OPENCODE_AUTH_CONTENT=')).slice('OPENCODE_AUTH_CONTENT='.length)).openai;
	saved.set(name, { id, placeholder }); return name;
}
let adapter;
async function turn(first, proxyEnv, scan, model) {
	const child = adapter = spawn('docker', ['exec','-i',...proxyEnv,first,'wlp-opencode-acp'], { stdio:['pipe','pipe','pipe'] });
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
	const initialized = await call('initialize', {protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
	assert.equal(initialized.agentInfo.version,'1.19.6');
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[]});
	assert.equal(opened.modes,undefined);
	assert.deepEqual(opened.configOptions.find(o=>o.category==='mode').options.map(o=>o.value),['build','plan']);
	const options = await call('session/set_config_option',{sessionId:opened.sessionId,configId:'mode',value:'plan'});
	assert.equal(options.configOptions.find(o=>o.category==='mode').currentValue,'plan');
	if (model) await call('session/set_config_option',{sessionId:opened.sessionId,configId:'model',value:model});
	const result = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:'Say relay proof.'}]});
	assert.equal(result.stopReason,'end_turn'); assert.equal(reply,'relay proof');
	if (scan) await checkIsolation(first, cmd, token, 'opencode', '/run/wlp-harness/opencode/login.json');
	child.stdin.end();
}
await symlink(join(root, 'fixtures/claude-relay/docker.cjs'), join(dir, 'docker'));
try {
	execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=api.anthropic.com',
		'-addext','subjectAltName=DNS:auth.openai.com,DNS:chatgpt.com,DNS:api.openai.com,DNS:api.anthropic.com,DNS:opencode.ai,DNS:api.z.ai','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')], { stdio:'ignore' });
	await writeFile(join(dir,'expected'),token);
	await copyFile(join(root,'fixtures/opencode/upstream.cjs'),join(dir,'upstream.cjs'));
	await cmd(['network','create','--internal',uplink]);
	// Mount individual files; the recording origin has no access to the runner's pairing state.
	const mounts = ['key.pem','cert.pem','expected','upstream.cjs'].flatMap(file => ['--mount',`type=bind,src=${dir}/${file},dst=/fixture/${file},readonly`]);
	await cmd(['run','-d','--pull','never','--network',uplink,'--network-alias','auth.openai.com','--network-alias','chatgpt.com','--network-alias','api.openai.com','--network-alias','api.anthropic.com','--network-alias','opencode.ai','--network-alias','api.z.ai','--name',upstream,
		'--user',String(process.getuid()),'--cap-drop','ALL',...mounts,image,'node','/fixture/upstream.cjs']);
	storePair(identity, privateKey, 'https://fixture.invalid');
	const catalog = await probeHarnessOptions(owner, image, 'free');
	assert.deepEqual(catalog.modes.map(m => m.id), ['build','plan']);
	assert.ok(catalog.models.some(m => m.id === catalog.defaultModel));
	ok('Offline inventory discovered public models and both modes without a credential volume.');
	process.env.F3_PAUSE_PROBE = '1';
	const probing = owner.loginChanged(true);
	try {
		const deadline = Date.now() + 15000;
		while (!existsSync(join(dir, 'probing'))) {
			assert.ok(Date.now() < deadline, 'The inventory probe did not start');
			await wait(50);
		}
		await storeProvider(owner, {provider:'openai',key:token+'-key'});
	} finally {
		await writeFile(join(dir,'continue-probe'),'');
		delete process.env.F3_PAUSE_PROBE;
		await probing;
	}
	assert.equal(owner.report().harnesses[0].options, undefined, 'A superseded inventory reached the report');
	const bundle = join(dir,'runner.cjs');
	execFileSync(process.execPath,[join(root,'runner/bundle.mjs'),image,bundle,'opencode='+image]);
	const cli = (...args) => execFileSync(process.execPath,[bundle,...args],{encoding:'utf8'});
	const transcript = execFileSync('script',['-qe','-c',process.execPath+' '+bundle+' login opencode --provider chatgpt','/dev/null'],
		{encoding:'utf8', timeout:90000, input:''});
	assert.match(transcript,/https:\/\/auth.openai.com\/codex\/device/);
	assert.match(transcript,/ABCD-EFGH/);
	assert.match(transcript,/signed in/i);
	assert.ok(!transcript.includes(token));
	ok('Native terminal device challenge, approval and private credential transfer against a TLS fixture.');
	const first = await create('first'), second = await create('second');
	assert.equal(await cmd(['exec',first,'ls','/sys/class/net']), 'lo');
	assert.match(await cmd(['exec',first,'printenv','HTTPS_PROXY']),/127.0.0.1:17891/);
	await cmd(['exec','-d',second,'node','-e',"require('http').createServer((q,r)=>r.end('peer')).listen(19123,'0.0.0.0')"]);
	assert.equal(await cmd(['exec',second,'curl','--retry','8','--retry-connrefused','--noproxy','*','-fsS','http://127.0.0.1:19123']), 'peer');
	assert.notEqual((await docker(['exec',first,'curl','--max-time','2','--noproxy','*','-fsS','http://127.0.0.1:19123'])).code,0);
	const other = saved.get(second).placeholder.access;
	const status = await cmd(['exec',first,'node','-e',`fetch('http://127.0.0.1:17892/openai/responses',{method:'POST',headers:{authorization:'Bearer '+process.argv[1]}}).then(r=>console.log(r.status))`,other]);
	assert.equal(status,'401');
	await turn(first, [], true);
	await turn(first,['-e','HTTPS_PROXY=http://127.0.0.1:1','-e','NO_PROXY='],false);
	assert.equal((await cmd(['logs',upstream])).split('\n').filter(s=>s==='refresh').length,1);
	ok('Restricted ACP streams through the relay after OAuth expiry. Process, file and Docker env scans pass. Peer bearer refused.');
	const waiting = await beginProviderLogin(owner);
	cli('logout','opencode');
	await assert.rejects(storeProvider(owner, {provider:'openai',key:token+'-key'}, waiting), /superseded/);
	assert.equal(await owner.ownedVolume(false, owner.opencodeVolume), false);
	assert.notEqual((await docker(['container','inspect',relayName])).code,0);
	execFileSync(process.execPath,[bundle,'login','opencode','--provider','openai'],{input:token+'-key\n'});
	const open = executor('open');
	const third = await create('third',open);
	await channelTurn(open, 'third', saved.get(third).id);
	assert.match(await cmd(['logs',upstream]),/authorized api.openai.com \/v1\/responses/);
	ok('Open API-key turn and resumed plan turn through the server harness and runner channel.');
	await storeProvider(owner, {provider:'anthropic',key:token+'-key'});
	const anth = await create('anthropic',open);
	await channelTurn(open,'anthropic',saved.get(anth).id,'anthropic/claude-opus-4-6');
	ok('Anthropic API-key turn over the runner session channel.');
	await storeProvider(owner,{provider:'free'});
	const free = await create('free',owner);
	await channelTurn(owner,'free',saved.get(free).id,'opencode/big-pickle');
	ok('Explicit public models completed a restricted turn without an owner credential.');
	await storeProvider(owner,{provider:'opencode-go',key:token+'-go'});
	await storeProvider(owner,{provider:'zai-coding-plan',key:token+'-glm'});
	const both = await create('both',owner);
	const blocked = await docker(['exec',both,'curl','--max-time','5','-sS','--noproxy','','-x','http://127.0.0.1:17891','-o','/dev/null','-w','%{http_connect}','https://api.z.ai/']);
	assert.equal(blocked.stdout.trim(),'403');
	await channelTurn(owner,'both',saved.get(both).id,'opencode-go/kimi-k3');
	await channelTurn(owner,'both',saved.get(both).id,'zai-coding-plan/glm-5.3');
	const log = await cmd(['logs',upstream]);
	assert.match(log,/authorized opencode.ai \/inference\/go\/openai\/v1\/chat\/completions/);
	assert.match(log,/authorized api.z.ai \/api\/coding\/paas\/v4\/chat\/completions/);
	await turn(both, [], true, 'opencode-go/kimi-k3');
	ok('Two stored providers, native Go and GLM streaming in one restricted sandbox, blocked direct CONNECT, placeholder scans.');
	await storeProvider(owner);
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
