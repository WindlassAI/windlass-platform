// Run from server with: pnpm exec tsx ../scripts/claude-relay-docker-check.mjs sha256:<local Claude image id>
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpConnection, LineSplitter } from '../server/src/sandbox/acp.ts';

const image = process.argv[2];
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(root, '.f3-check-'));
const id = randomBytes(8).toString('hex'), prefix = 'f3-check-' + id, machineId = 'm_' + id;
const relayName = 'wlp-claude-relay-' + machineId, internal = 'wlp-claude-net-' + machineId;
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
const { probeClaudeOptions } = await import('../runner/src/claude-options.ts');
const { containerName } = await import('../server/src/sandbox/sandboxes.ts');
const { LABEL, LABEL_ARG } = await import('../server/src/sandbox/docker.ts');
const cmd = async (args, opts) => (await docker(args, { check: true, timeoutMs: 45_000, ...opts })).stdout.trim();
const ok = message => console.log('PASS  ' + message);
const owner = new Executor(identity, {}, false, true);
const profile = 'docker-hardened', boxes = [];
const saved = new Map();
async function create(session) {
	const id = await owner.create(session, profile, false, 'claude');
	const name = containerName('claude-' + id.slice(-12)); boxes.push(name);
	const [box] = JSON.parse(await cmd(['container', 'inspect', name]));
	assert.equal(box.Mounts.length, 0);
	const placeholder = box.Config.Env.find(s => s.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')).split('=')[1];
	saved.set(name, { id, placeholder }); return name;
}
async function status(name, bearer, host = 'wlp-relay:8080') {
	return cmd(['exec', name, 'node', '-e', `const r=require('http').request(process.env.ANTHROPIC_BASE_URL+'/v1/messages/count_tokens',
		{method:'POST', headers:{host:process.argv[2],authorization:'Bearer '+process.argv[1]}},res=>{console.log(res.statusCode);res.resume()});
		r.on('error',()=>process.exit(1));r.end('{}');`, bearer, host]);
}
async function isolation(name) {
	const audit = await cmd(['exec', '-i', name, 'python3', '-c', `import base64,glob,os,subprocess,sys
marker=sys.stdin.buffer.read()
assert marker and not os.path.exists('/run/wlp-harness/claude/token')
envs=glob.glob('/proc/[0-9]*/environ')
assert len(envs)>2
saw_cli=False
for path in ['/etc/hosts','/etc/hostname','/etc/resolv.conf',*envs,*glob.glob('/proc/[0-9]*/cmdline')]:
 if not os.path.exists(path): continue
 raw=subprocess.check_output(['cat','--',path])
 encoded=subprocess.check_output(['base64','-w0','--',path])
 assert marker not in raw and marker not in base64.b64decode(encoded)
 if path.endswith('/cmdline') and b'claude-agent-sdk-linux-' in raw.split(b'\\0')[0]: saw_cli=True
assert saw_cli
print("ok")
`], {stdin: token.slice(0,31)});
	assert.equal(audit, 'ok');
	assert.ok(!JSON.stringify(JSON.parse(await cmd(['container','inspect',name]))[0].Config).includes(token));
	// The immutable image predates the random sentinel. Scan the contents of every regular
	// file created or modified in its writable layer; pass only a short search prefix.
	const changes = await cmd(['diff', name]);
	const paths = changes.split('\n').filter(s => /^[AC] /.test(s)).map(s => s.slice(2));
	const result = await cmd(['exec', '-i', name, 'python3', '-c', `import sys,os
marker,*paths=sys.stdin.buffer.read().splitlines()
assert paths
for raw in paths:
 p=os.fsdecode(raw)
 if os.path.isfile(p) and not os.path.islink(p):
  with open(p,'rb') as f:
   tail=b''
   while block:=f.read(131072):
    data=tail+block
    assert marker not in data
    tail=data[-len(marker):]
`,], { stdin: token.slice(0,31) + '\n' + paths.join('\n') + '\n' });
	assert.equal(result, '');
}
let adapter;
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
	await storeClaudeLogin(owner, token);
	const options = await probeClaudeOptions(owner, image);
	assert.ok(options.models.length && options.defaultModel); ok('Pinned adapter discovers models with network disabled and no login volume.');
	const first = await create('first'), second = await create('second');
	const [bridge] = JSON.parse(await cmd(['network','inspect',internal]));
	assert.equal(bridge.Internal,true);
	assert.equal(bridge.Options['com.docker.network.bridge.gateway_mode_ipv4'],'isolated','Agent relay bridge must not add a host gateway');
	const [relay] = JSON.parse(await cmd(['container','inspect',relayName]));
	assert.equal(relay.HostConfig.LogConfig.Type,'none'); assert.ok(!JSON.stringify(relay.Config).includes(token));
	assert.ok(relay.Mounts.some(m => m.Name === owner.claudeVolume && !m.RW));
	const one = saved.get(first), two = saved.get(second);
	assert.equal(await status(first, one.placeholder), '200');
	const foreignKey = generateKeyPairSync('ed25519').privateKey;
	const nonce = one.placeholder.split('.')[0];
	const forged = nonce + '.' + sign(null, Buffer.from('windlass-claude-relay-v1\n'+machineId+'\n'+nonce), foreignKey).toString('base64url');
	assert.equal(await status(first, forged), '401');
	assert.equal(await status(first, two.placeholder), '401');
	assert.equal(await status(second, one.placeholder), '401');
	assert.equal(await status(first, one.placeholder, 'foreign.invalid'), '403');
	ok('Both real session containers have zero mounts. Own bearer accepted, cross-session bearer and foreign Host refused.');
	adapter = spawn('docker', ['exec','-i','-e','HTTP_PROXY=http://127.0.0.1:1','-e','HTTPS_PROXY=http://127.0.0.1:1','-e','NO_PROXY=','-e','no_proxy=',first,'wlp-claude-acp'], { stdio:['pipe','pipe','pipe'] });
	adapter.stderr.resume();
	let reply = '';
	const rpc = new AcpConnection(line => adapter.stdin.write(line + '\n'), {
		async request() { throw Error('No client tools in fixture'); },
		notification(method, params) { if (method === 'session/update' && params.update.sessionUpdate === 'agent_message_chunk') reply += params.update.content.text; },
	}, '');
	const lines = new LineSplitter(line => rpc.receive(line));
	adapter.stdout.setEncoding('utf8').on('data', s => lines.push(s));
	adapter.on('close', () => rpc.end('Adapter closed'));
	const call = (method, params) => rpc.request(method, params, { timeoutMs:45000 });
	await call('initialize', {protocolVersion:1,clientCapabilities:{}});
	const opened = await call('session/new',{cwd:'/workspace',mcpServers:[]});
	await call('session/set_mode',{sessionId:opened.sessionId,modeId:opened.modes.currentModeId});
	const result = await call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:'Say relay check passed.'}]});
	assert.equal(result.stopReason,'end_turn'); assert.equal(reply,'relay check passed');
	await isolation(first);
	const recorded = await cmd(['logs',upstream]);
	assert.match(recorded,/POST \/v1\/messages\?beta=true bearerMatch=true beta=.*oauth-2025-04-20.*version=2023-06-01/);
	assert.ok(!recorded.includes(token) && !recorded.includes('bearerMatch=false'));
	ok('Pinned ACP/CLI completed a streamed turn through production relay TLS. Recorder verified bearer and OAuth beta.');
	ok('Live adapter, CLI and other sandbox processes, mounted files and writable layer passed sentinel scans.');
	adapter.stdin.end();
	await owner.lifecycle('suspend',one.id,'first');
	await owner.lifecycle('connect',one.id,'first'); assert.equal(await status(first,one.placeholder),'200');
	const endpointIp = async name => JSON.parse(await cmd(['inspect',name]))[0].NetworkSettings.Networks[internal].IPAddress;
	const retiredIp = await endpointIp(first);
	await owner.lifecycle('destroy',one.id,'first');
	const replacement = await create('replacement');
	assert.equal(await endpointIp(replacement), retiredIp, 'Exercise reuse of the removed address');
	assert.equal(await status(replacement,one.placeholder),'401');
	assert.equal(await status(replacement,saved.get(replacement).placeholder),'200');
	ok('Restart preserved its own lease. Destroy revoked the removed endpoint.');
	const legacy = containerName('claude-' + randomBytes(6).toString('hex')); boxes.push(legacy);
	await cmd(['run','-d','--pull','never','--name',legacy,'--network','none','--label',LABEL_ARG,...owner.pairingLabelFlags,
		'--label',LABEL+'.session=legacy','--label',LABEL+'.harness=claude','--label',LABEL+'.profile='+profile,
		'--mount','type=volume,src='+owner.claudeVolume+',dst=/run/wlp-harness/claude,readonly',image,'sleep','infinity']);
	const restarted = new Executor(identity, {}, false, true);
	await restarted.secureCredentialPath(); await restarted.discover();
	assert.equal(await cmd(['inspect','-f','{{.State.Running}}',legacy]),'false');
	const legacyId = 'm'+machineId+'-'+legacy.slice(-12);
	await assert.rejects(restarted.lifecycle('connect',legacyId,'legacy'),/predates credential isolation/);
	await assert.rejects(restarted.existing('legacy',profile,'claude'),/predates credential isolation/);
	assert.throws(()=>restarted.running(legacyId,'legacy'));
	ok('Upgrade stops legacy mounted sessions, keeps their workspace, and refuses reconnect, create and commands.');
	await storeClaudeLogin(owner, undefined);
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
	assert.notEqual((await docker(['network','inspect',internal])).code,0);
	assert.notEqual((await docker(['volume','inspect',owner.claudeVolume])).code,0);
	ok('Prune removes the owned relay network and login volume.');
} catch (error) {
	const logs = await docker(['logs', upstream]);
	if (!logs.stderr.includes(token)) process.stderr.write(logs.stderr);
	throw error;
} finally {
	adapter?.stdin.end();
	for (const name of [...boxes, relayName, upstream]) await docker(['rm','-fv',name]);
	await docker(['volume','rm',owner.claudeVolume]);
	await docker(['network','rm',internal]); await docker(['network','rm',uplink]);
	await rm(dir,{recursive:true,force:true});
}
