// From server: pnpm exec tsx ../scripts/codex-docker-check.mjs <local Codex image id>
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { build } from '../runner/node_modules/esbuild/lib/main.js';

const pin = process.argv[2];
assert.match(pin ?? '', /^sha256:[a-f0-9]{64}$/);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(root, '.codex-proof-'));
const id = randomBytes(8).toString('hex'),
	prefix = 'f3-check-' + id;
const machineId = 'm_' + id,
	net = prefix + '-uplink',
	upstream = prefix + '-upstream';
const real = (...args) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8' }).trim();
const jwt = () =>
	'eyJhbGciOiJub25lIn0.' +
	Buffer.from(JSON.stringify({ canary: randomBytes(20).toString('hex') })).toString('base64url') +
	'.fixture';
const random = () => randomBytes(24).toString('hex');
const markers = { access: jwt(), rotated: jwt(), refresh: random(), next: random(), key: 'sk-' + random() };
const observe = (value) => {
	for (const secret of Object.values(markers))
		assert.ok(!String(value).includes(secret), 'credential crossed the session boundary');
};
Object.assign(process.env, {
	WLP_RUNNER_STATE_DIR: dir,
	F3_HARNESS: 'codex',
	F3_MACHINE: machineId,
	F3_PREFIX: prefix,
	F3_DIR: dir,
	PATH: dir + ':' + process.env.PATH,
});
Object.assign(globalThis, {
	SANDBOX_IMAGE: pin,
	SHOTS_IMAGE_PIN: '',
	HARNESS_IMAGES: { codex: pin },
	CODEX_RELAY_SCRIPT: (
		await build({
			entryPoints: [join(root, 'sandbox/relay/codex.cjs')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			write: false,
		})
	).outputFiles[0].text,
});
await symlink(join(root, 'fixtures/claude-relay/docker.cjs'), join(dir, 'docker'));
const { storePair } = await import('../runner/src/state.ts');
const { storeCodexLogin } = await import('../runner/src/codex-login.ts');
const { Executor } = await import('../runner/src/docker-executor.ts');
const { docker } = await import('../server/src/sandbox/docker.ts');
const { channelTurn } = await import('../fixtures/opencode/channel.mjs');
const { optionsDigest, compactReport } = await import('../server/src/runner/catalog.ts');
const { parseRunnerFrame } = await import('../server/src/runner/control.ts');
const { codexModes } = await import('../server/src/sandbox/codex-modes.ts');
const cmd = async (args, opts) => (await docker(args, { check: true, timeoutMs: 45_000, ...opts })).stdout.trim();
const who = { machineId, uid: 'fixture' };
const runner = new Executor(
	who,
	{ slots: null },
	false,
	false,
	['docker-hardened'],
	{ mode: 'restricted', allow: [] },
	false,
	true,
);
const args = ['--filter', 'label=dev.windlass-platform.machine=' + machineId];
const boxes = [];
const boxName = (id) => 'wlp-session-codex-' + id.slice(-12);
const probe =
	"fetch('http://127.0.0.1:17892/codex/v1/models',{headers:{authorization:'Bearer '+process.env.WLP_SESSION_BEARER}}).then(r=>console.log(r.status))";
// One keep-alive socket: a model-list request warms it, then a Responses request the upstream holds.
// Without a relay that closes each connection after its reply, the held request would reuse the
// answered connection, and logout would end it without the signed-out status.
const warmProbe = `const http=require('node:http');const agent=new http.Agent({keepAlive:true,maxSockets:1});
const call=(method,path)=>new Promise((ok,no)=>{const req=http.request({host:'127.0.0.1',port:17892,method,path,agent,
headers:{authorization:'Bearer '+process.env.WLP_SESSION_BEARER,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode+':'+req.reusedSocket))});req.on('error',e=>ok('error:'+e.code));req.end(method==='POST'?'{}':undefined)});
(async()=>{console.log(await call('GET','/codex/v1/models'));console.log(await call('POST','/codex/v1/responses'))})();`;
async function terminalLogin(hostileUrl) {
	const child = spawn('script', ['-qef', '-c', 'exec node runner.cjs login codex', '/dev/null'], {
		cwd: dir,
		env: { ...process.env, ...(hostileUrl && { F3_DEVICE_URL: hostileUrl }) },
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 60000,
	});
	let output = '',
		stage = 0;
	child.stdout.on('data', (chunk) => {
		output += chunk;
		if (stage === 0 && output.includes('Choose a method:')) {
			stage++;
			child.stdin.write(hostileUrl ? '1\n' : '2\n');
		} else if (stage === 1 && output.includes('Enter the OpenAI API key:')) {
			stage++;
			child.stdin.write(markers.key + '\n');
		}
	});
	child.stderr.on('data', (chunk) => (output += chunk));
	const [code] = await once(child, 'close');
	observe(output);
	if (hostileUrl) {
		assert.notEqual(code, 0);
		assert.match(output, /unexpected verification URL/);
		assert.ok(!output.includes(hostileUrl) && !output.includes('ABCD-EFGH'));
		return;
	}
	assert.equal(code, 0, output);
	assert.match(output, /Codex: signed in/);
}
async function until(fn) {
	const deadline = Date.now() + 60_000;
	while (!(await fn())) {
		assert.ok(Date.now() < deadline, 'timed out waiting for fixture');
		await wait(100);
	}
}
async function scan(name) {
	observe(await cmd(['inspect', name]));
	const code = `import os,glob,sys,json
needles=[v.encode() for v in json.load(sys.stdin).values()]
found=set()
files=glob.glob('/proc/[0-9]*/environ')+glob.glob('/proc/[0-9]*/cmdline')
for root in ['/home/agent','/tmp','/workspace',os.environ['CODEX_HOME']]:
 for base,dirs,names in os.walk(root):
  files += [os.path.join(base,n) for n in names]
for path in files:
 try:
  if not os.path.islink(path) and os.path.isfile(path):
   with open(path,'rb') as f:
    tail=b''
    while b:=f.read(131072):
     data=tail+b
     found.update(n for n in needles if n in data)
     tail=data[-4096:]
 except (FileNotFoundError,PermissionError): pass
print(len(found))`;
	return Number(await cmd(['exec', '-i', name, 'python3', '-c', code], { stdin: JSON.stringify(markers) }));
}
try {
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-days',
			'1',
			'-subj',
			'/CN=fixture',
			'-addext',
			'subjectAltName=DNS:auth.openai.com,DNS:api.openai.com,DNS:chatgpt.com',
			'-keyout',
			join(dir, 'key.pem'),
			'-out',
			join(dir, 'cert.pem'),
		],
		{ stdio: 'ignore' },
	);
	await writeFile(join(dir, 'expected'), JSON.stringify(markers), { mode: 0o600 });
	for (const file of ['auth.cjs', 'gateway.cjs']) await copyFile(join(root, 'fixtures/codex', file), join(dir, file));
	real('network', 'create', '--internal', net);
	real(
		'run',
		'-d',
		'--rm',
		'--name',
		upstream,
		'--network',
		net,
		'--network-alias',
		'auth.openai.com',
		'--network-alias',
		'chatgpt.com',
		'--network-alias',
		'api.openai.com',
		'--user',
		'0',
		'-v',
		dir + ':/fixture:ro',
		pin,
		'node',
		'/fixture/auth.cjs',
	);
	execFileSync(process.execPath, [join(root, 'runner/bundle.mjs'), pin, join(dir, 'runner.cjs'), 'codex=' + pin], {
		stdio: 'pipe',
	});
	storePair(who, generateKeyPairSync('ed25519').privateKey, 'https://fixture.invalid');
	for (const url of ['https://fixture.invalid/device', 'https://auth.openai.com/codex/device?redirect_uri=x'])
		await terminalLogin(url);
	await runner.refresh();
	assert.ok(runner.report().docker.ok, JSON.stringify(runner.report().docker));
	await runner.loginChanged(false);
	assert.equal(runner.report().harnesses[0].signIn, 'none');
	assert.ok(runner.report().harnesses[0].options?.models.length, 'signed-out inventory missing');
	const credential = {
		provider: 'chatgpt',
		access: markers.access,
		refresh: markers.refresh,
		expires: 0,
		accountId: 'fixture-account',
	};
	await storeCodexLogin(runner, credential);
	for (const session of ['first', 'second'])
		boxes.push(await runner.create(session, 'docker-hardened', false, 'codex'));
	assert.deepEqual(await Promise.all(boxes.map((id) => cmd(['exec', boxName(id), 'node', '-e', probe]))), [
		'200',
		'200',
	]);
	assert.equal(
		real('logs', upstream)
			.split('\n')
			.filter((line) => line === 'refresh').length,
		1,
	);
	const otherLease = await cmd(['exec', boxName(boxes[1]), 'printenv', 'WLP_SESSION_BEARER']);
	const wrongLeaseProbe = probe.replace('process.env.WLP_SESSION_BEARER', "require('node:fs').readFileSync(0,'utf8')");
	assert.equal(
		await cmd(['exec', '-i', boxName(boxes[0]), 'node', '-e', wrongLeaseProbe], { stdin: otherLease }),
		'401',
	);
	const saved = JSON.parse(
		await cmd(['exec', 'wlp-codex-relay-' + machineId, 'cat', '/run/wlp-harness/codex/login.json']),
	);
	assert.ok(saved.refresh === markers.next && saved.access === markers.rotated);
	assert.equal(
		await cmd(['exec', 'wlp-codex-relay-' + machineId, 'stat', '-c', '%a:%u', '/run/wlp-harness/codex/login.json']),
		'400:1000',
	);
	assert.deepEqual(JSON.parse(await cmd(['inspect', '--format', '{{json .HostConfig.LogConfig}}', 'wlp-codex-relay-' + machineId])),
		{ Type: 'json-file', Config: { 'max-size': '4m', 'max-file': '2' } });
	await runner.loginChanged(true);
	const report = runner.report(),
		entry = report.harnesses[0],
		catalog = entry.options;
	assert.equal(entry.method, 'chatgpt');
	assert.match(entry.loginGeneration, /^[0-9a-f]{32}$/);
	assert.deepEqual(entry.modes, ['agent-full-access']);
	assert.deepEqual(catalog.models.map((m) => m.id).sort(), ['gpt-6.2-sol']);
	assert.ok(catalog.models.every((m) => m.efforts.length));
	assert.ok(parseRunnerFrame(JSON.stringify({ kind: 'catalog', id: 'codex', options: catalog })));
	assert.ok(parseRunnerFrame(JSON.stringify(compactReport(report))));
	assert.ok(optionsDigest(catalog));
	observe(JSON.stringify(report));
	const first = boxName(boxes[0]);
	for (const host of ['chatgpt.com', 'api.openai.com']) {
		const res = await docker([
			'exec',
			first,
			'curl',
			'-m5',
			'-sS',
			'-o',
			'/dev/null',
			'-w',
			'%{http_connect}',
			'https://' + host,
		]);
		assert.equal(res.stdout.trim(), '403');
		assert.notEqual(res.code, 0);
	}
	await channelTurn(runner, 'first', boxes[0], undefined, undefined, { observe });
	await cmd(['exec', first, 'sh', '-ec', 'test ! -e "$CODEX_HOME/auth.json"']);
	assert.equal(await scan(first), 0);
	// Positive control proves the scan detects a projected credential. CODEX_HOME is root's (the image's Dockerfile).
	await cmd(['exec', '-i', '-u', 'root', first, 'sh', '-ec', 'cat > "$CODEX_HOME/auth.json"'], { stdin: JSON.stringify(markers) });
	assert.equal(await scan(first), Object.keys(markers).length);
	await cmd(['exec', '-u', 'root', first, 'sh', '-ec', 'rm "$CODEX_HOME/auth.json"']);
	process.env.F3_PAUSE_PROBE = '1';
	const probing = runner.loginChanged(true);
	await until(() =>
		readFile(join(dir, 'probing')).then(
			() => true,
			() => false,
		),
	);
	await cmd(['exec', upstream, 'touch', '/tmp/hold']);
	const turn = channelTurn(runner, 'second', boxes[1], undefined, undefined, { observe, signedOut: true });
	const holding = () => real('logs', upstream).split('\n').filter((line) => line === 'holding').length;
	await until(() => holding() > 0);
	const warmed = docker(['exec', boxName(boxes[1]), 'node', '-e', warmProbe], { timeoutMs: 60_000 });
	await until(() => holding() > 1);
	const loggingOut = Date.now();
	observe(execFileSync(process.execPath, [join(dir, 'runner.cjs'), 'logout', 'codex'], { encoding: 'utf8' }));
	// The relay exits on SIGTERM once no refresh is in flight, well before Docker's stop timeout.
	assert.ok(Date.now() - loggingOut < 20_000, 'the relay ignored SIGTERM during logout');
	assert.equal(await runner.ownedVolume(false, runner.codexVolume), false);
	assert.equal(await cmd(['exec', first, 'node', '-e', probe]), '401');
	assert.deepEqual((await warmed).stdout.trim().split('\n'), ['200:false', '401:false']);
	await writeFile(join(dir, 'continue-probe'), '');
	delete process.env.F3_PAUSE_PROBE;
	await Promise.all([turn, probing]);
	assert.equal(runner.report().harnesses[0].options, undefined);
	await terminalLogin();
	await cmd(['exec', upstream, 'rm', '/tmp/hold']);
	const third = await runner.create('third', 'docker-hardened', false, 'codex');
	boxes.push(third);
	Object.assign(process.env, { WLP_DEMO: '1', WLP_SANDBOX: 'fake', WLP_SECRET: random() });
	const { timelineFixture } = await import('../fixtures/acp-agent/timeline.ts');
	const timeline = timelineFixture();
	try {
		await channelTurn(runner, 'third', third, undefined, undefined, { observe, onUpdate: timeline.recorder.update });
		timeline.recorder.flush();
		await until(() => timeline.items.length > 0 && timeline.stored().length === timeline.items.length);
		const stored = JSON.stringify(timeline.stored());
		assert.ok(stored.includes('Fixture turn complete.'));
		observe(stored);
		observe(JSON.stringify(timeline.deltas));
	} finally {
		timeline.sql.close();
	}
	assert.equal(await scan(boxName(third)), 0);
	const sandboxRunner = new Executor(
		who,
		{ slots: null },
		false,
		false,
		['docker-hardened', 'docker-windlass-sandbox'],
		{ mode: 'restricted', allow: [] },
		false,
		true,
	);
	await sandboxRunner.loginChanged(true);
	const sandboxReport = sandboxRunner.report().harnesses[0];
	if (sandboxReport.modes.includes('workspace-write')) {
		assert.deepEqual(sandboxReport.modes, ['agent-full-access', 'read-only', 'workspace-write']);
		assert.doesNotThrow(() => sandboxRunner.requireHarness('docker-windlass-sandbox', 'codex'));
		assert.deepEqual(codexModes('docker-windlass-sandbox', sandboxReport.modes).map((m) => m.id), ['read-only', 'workspace-write']);
		const inner = await sandboxRunner.create('fourth', 'docker-windlass-sandbox', false, 'codex');
		boxes.push(inner);
		assert.equal(await cmd(['exec', boxName(inner), 'printenv', 'INITIAL_AGENT_MODE']), 'workspace-write');
		assert.equal(await cmd(['exec', boxName(third), 'printenv', 'INITIAL_AGENT_MODE']), 'agent-full-access');
	} else {
		assert.deepEqual(sandboxReport.modes, ['agent-full-access']);
		assert.throws(() => sandboxRunner.requireHarness('docker-windlass-sandbox', 'codex'), /sandbox probe/);
	}
	console.log('Probed modes:', sandboxReport.modes.join(', '));
	// A logout while the relay is stopped still tells a session it is signed out (401), not to try again (503).
	await cmd(['stop', '-t', '1', 'wlp-codex-relay-' + machineId]);
	observe(execFileSync(process.execPath, [join(dir, 'runner.cjs'), 'logout', 'codex'], { encoding: 'utf8' }));
	assert.equal(await runner.ownedVolume(false, runner.codexVolume), false);
	assert.equal(await cmd(['exec', boxName(third), 'node', '-e', probe]), '401', 'a logout without a running relay left sessions retrying');
	for (const file of (await readdir(dir)).filter((f) => /^audit-.*\.jsonl$/.test(f) || f === 'status.json'))
		observe(await readFile(join(dir, file), 'utf8'));
	console.log(
		'PASS Codex ACP over the runner channel, TLS routes, concurrent refresh, logout during a turn and with the relay stopped, generation invalidation, restricted egress and credential scans.',
	);
} finally {
	delete process.env.F3_PAUSE_PROBE;
	await writeFile(join(dir, 'continue-probe'), '');
	for (const id of real('ps', '-aq', ...args)
		.split(/\s+/)
		.filter(Boolean))
		real('rm', '-fv', id);
	for (const v of real('volume', 'ls', '-q', ...args)
		.split(/\s+/)
		.filter(Boolean))
		real('volume', 'rm', v);
	if (real('ps', '-aq', '--filter', 'name=^/' + upstream + '$')) real('rm', '-fv', upstream);
	if (real('network', 'ls', '-q', '--filter', 'name=^' + net + '$')) real('network', 'rm', net);
	await rm(dir, { recursive: true, force: true });
}
