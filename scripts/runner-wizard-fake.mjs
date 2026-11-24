// A fake machine for the setup wizard's checks (runner-setup-wizard-check.mjs) and its recordings:
// the runner bundle, a fake docker on PATH, a state directory and a fake platform that approves the pairing.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = 'sha256:' + '1'.repeat(64), id = 'm_' + 'b'.repeat(16);
const registry = 'ghcr.io/windlassai/';
export const runner = registry + 'windlass-runner@' + pin;
const ref = role => registry + 'windlass-platform-' + role + '@' + pin;

/** `waiting`: how many polls the platform answers "waiting" before it approves. */
export async function fakeMachine({ waiting = 0 } = {}) {
	const dir = await mkdtemp(join(root, '.wizard-check-'));
	const platformRoot = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
	const asked = [];
	let refuse = false;
	const server = createServer(async (req, res) => {
		for await (const _ of req);
		asked.push(req.url);
		if (refuse) { res.writeHead(403); res.end('{}'); return; }
		res.setHeader('content-type', 'application/json');
		if (req.url !== '/runner/pair' && waiting-- > 0) return res.end(JSON.stringify({ state: 'waiting' }));
		res.end(JSON.stringify(req.url === '/runner/pair' ? { code: 'WXYZ-1210', pairing: 'a'.repeat(43), pollSecret: 'b'.repeat(43) }
			: { state: 'approved', uid: 'fixture', machineId: id, githubLogin: 'fixture-owner', platformRoot, endpoint: 'http://127.0.0.1:' + server.address().port }));
	});
	await new Promise(done => server.listen(0, '127.0.0.1', done));
	const origin = 'http://127.0.0.1:' + server.address().port;
	execFileSync(process.execPath, [join(root, 'runner/bundle.mjs'), ref('sandbox'), join(dir, 'runner.cjs'), ref('sandbox-shots'), 'claude=' + ref('claude'), 'opencode=' + ref('opencode'), 'codex=' + ref('codex')]);
	await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
	const state = join(dir, 'state'), volume = join(dir, 'relay-volume');
	await Promise.all([mkdir(state), mkdir(volume)]);
	await writeFile(join(dir, 'host.cjs'), `require('node:os').hostname=()=>'0123456789ab';require('node:module').syncBuiltinESMExports()`);
	await writeFile(join(dir, 'docker'), `#!/usr/bin/env node
const a=process.argv.slice(2),d=process.env.WLP_RUNNER_STATE_DIR,fs=require('node:fs'),pin=${JSON.stringify(pin)};
const service=d+'/../fake-service';
if (a[0]==='container' && a.at(-1)==='0123456789ab') console.log(JSON.stringify([pin, ${JSON.stringify(runner)}, [{Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock'},{Type:'volume',Name:'windlass-runner',Destination:d}]]));
else if (a[0]==='container' && a.at(-1)==='windlass-runner') { if (!fs.existsSync(service)) { console.error('No such container'); process.exit(1); } console.log(fs.readFileSync(service,'utf8').startsWith('running') ? 'true' : 'false'); }
else if (a[0]==='run' && a[a.indexOf('--name')+1]==='windlass-runner') {
 if (fs.existsSync(service)) { console.error('Conflict. The container name "/windlass-runner" is already in use'); process.exit(125); }
 fs.writeFileSync(service,'running\\n'+a.join(' '));fs.appendFileSync(d+'/../service-runs',a.join(' ')+'\\n');
 fs.writeFileSync(d+'/status.json',JSON.stringify({machineId:${JSON.stringify(id)},connection:'Online',idleSuspendMs:null,runnerVersion:'0',protocol:2}),{mode:0o600});
 console.log('c'.repeat(64));
}
else if (a[0]==='rm' && a.at(-1)==='windlass-runner') fs.rmSync(service,{force:true});
else if ((a[0]==='stop' || a[0]==='start') && a.at(-1)==='windlass-runner') fs.writeFileSync(service,(a[0]==='stop'?'stopped':'running')+fs.readFileSync(service,'utf8').replace(/^\\w+/,''));
else if (a[0]==='info') console.log('docker-desktop');
else if (a[0]==='version') console.log('linux/arm64');
else if (a[0]==='image' && a.some(v=>v.includes('@'))) { if(!fs.existsSync(d+'/../pulled-'+a.find(v=>v.includes('@')).split('/').at(-1))) process.exit(1); console.log('linux/arm64'); }
else if (a[0]==='pull') { const role=a.at(-1).split('/').at(-1); console.log('Pull progress '+role); fs.writeFileSync(d+'/../pulled-'+role,''); }
else if (a[0]==='image') console.log(pin);
else if (a[0]==='container') { console.error('No such container'); process.exitCode=1; }
else if (a[0]==='volume' && a[1]==='ls') console.log('wlp-harness-opencode-${id}');
else if (a[0]==='volume' && a[1]==='inspect') console.log(JSON.stringify([{Driver:'local',Labels:{'dev.windlass-platform':'1','dev.windlass-platform.machine':'${id}','dev.windlass-platform.uid':'fixture'}}]));
else if (a[0]==='run' && a.includes('--network') && a.includes('none')) {
 if (!a.some(v=>v.includes('dst=/login,volume-nocopy'))) process.exit(3);
 process.chdir(${JSON.stringify(volume)}); fs.chownSync=()=>{}; eval(a.at(-1));
}
else process.exitCode=2;
`, { mode: 0o755 });
	const env = { ...process.env, PATH: dir + ':' + process.env.PATH, WLP_RUNNER_STATE_DIR: state, FORCE_COLOR: '0' };
	const argv = args => [process.execPath, '--require', join(dir, 'host.cjs'), join(dir, 'runner.cjs'), ...args];
	return {
		dir, state, origin, asked, env, argv,
		/** From now on the platform refuses every pairing. */
		refuse() { refuse = true; },
		/** Runs the runner in a pseudo-terminal, answering each prompt in order once it shows. */
		async terminal(args, prompts, timeout = 45000) {
			const quoted = argv(args).map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
			const child = spawn('script', ['-qef', '-c', quoted, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
			let output = '', step = 0, from = 0;
			const answer = () => {
				while (step < prompts.length) {
					const at = output.indexOf(prompts[step][0], from);
					if (at < 0) return;
					from = at + prompts[step][0].length;
					child.stdin.write(prompts[step++][1] + '\n');
				}
			};
			child.stdout.on('data', chunk => { output += chunk; answer(); });
			child.stderr.on('data', chunk => { output += chunk; });
			const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
			let code;
			try { code = await new Promise(done => child.once('exit', done)); } finally { clearTimeout(timer); child.stdin.destroy(); }
			return { code, output: output.replaceAll('\r', ''), answered: step };
		},
		/** Runs the runner with standard input from a pipe that ends at once: no terminal. */
		async piped(args) {
			const child = spawn(argv(args)[0], argv(args).slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
			child.stdin.end();
			let output = '';
			child.stdout.on('data', chunk => { output += chunk; });
			child.stderr.on('data', chunk => { output += chunk; });
			const code = await new Promise(done => child.once('exit', done));
			return { code, output };
		},
		serviceRuns: async () => (await readFile(join(dir, 'service-runs'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
		async close() { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); },
	};
}
