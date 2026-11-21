import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('setup pairs, skips Claude, accepts a hidden OpenCode key and prints the runnable Docker command', async () => {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const dir = await mkdtemp(join(root, '.setup-check-'));
	const pin = 'sha256:'+'1'.repeat(64), id = 'm_'+'a'.repeat(16);
	const asked = [];
	const server = createServer(async (req,res) => {
		let body=''; for await(const c of req) body+=c;
		asked.push(req.url);
		res.setHeader('content-type','application/json');
		res.end(JSON.stringify(req.url === '/runner/pair' ? {code:'ABCD-EFGH',pairing:'a'.repeat(43),pollSecret:'b'.repeat(43)}
			: {state:'approved',uid:'fixture',machineId:id,githubLogin:'fixture-owner'}));
	});
	try {
		await new Promise(done=>server.listen(0,'127.0.0.1',done));
		const origin='http://127.0.0.1:'+server.address().port;
		execFileSync(process.execPath,[join(root,'runner/bundle.mjs'),pin,join(dir,'runner.cjs'),'claude='+pin,'opencode='+pin]);
		await writeFile(join(dir,"package.json"),JSON.stringify({type:"commonjs"}));
		const preload=join(dir,'host.cjs');
		await writeFile(preload,"require('node:os').hostname=()=>'0123456789ab';require('node:module').syncBuiltinESMExports()");
		await writeFile(join(dir,'docker'),`#!/usr/bin/env node
const a=process.argv.slice(2),d=process.env.WLP_RUNNER_STATE_DIR,fs=require('node:fs'),pin=${JSON.stringify(pin)};
if (a.includes('{{json .Image}} {{json .Mounts}}')) console.log(JSON.stringify(pin),JSON.stringify([{Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock'},{Type:'volume',Name:'setup-test',Destination:d}]));
else if(a[0]==='image') console.log(pin);
else if(a[0]==='container') { console.error('No such container');process.exitCode=1; }
else if(a[0]==='volume' && a[1]==='ls') console.log('wlp-harness-opencode-${id}');
else if(a[0]==='volume' && a[1]==='inspect') console.log(JSON.stringify([{Driver:'local',Labels:{'dev.windlass-platform':'1','dev.windlass-platform.machine':'${id}','dev.windlass-platform.uid':'fixture'}}]));
else if(a[0]==='run' && a.includes('--network') && a.includes('none')) fs.writeFileSync(d+'/stored',fs.readFileSync(0));
else process.exitCode=2;
`,{mode:0o755});
		const env={...process.env,PATH:dir+':'+process.env.PATH,WLP_RUNNER_STATE_DIR:dir};
		const child=spawn('script',['-qef','-c',`"${process.execPath}" --require "${preload}" "${dir}/runner.cjs" setup --platform ${origin} --harness claude --harness opencode`,'/dev/null'],{env,stdio:['pipe','pipe','pipe']});
		const prompts=[['Claude Code: sign in now?','n'],['OpenCode: sign in now?',''],['OpenCode provider','openai'],['Enter the openai API key','setup-fixture-secret']];
		let output='', step=0;
		child.stdout.on('data',chunk=>{output+=chunk;if(step<prompts.length && output.includes(prompts[step][0])) child.stdin.write(prompts[step++][1]+'\n');});
		const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
		let code;try {code=await new Promise(done=>child.once('exit',done));}finally{clearTimeout(timer);child.stdin.destroy();}
		assert.equal(code,0,output.replaceAll('setup-fixture-secret','[fixture]'));
		assert.equal(step,prompts.length);
		assert.ok(!output.includes('setup-fixture-secret'));
		assert.match(output,/ABCD-EFGH/);
		assert.deepEqual(asked,['/runner/pair','/runner/pair/poll']);
		assert.equal(JSON.parse(await readFile(join(dir,'stored'),'utf8')).key,'setup-fixture-secret');
		assert.ok(output.includes('-e WLP_RUNNER_STATE_DIR='+dir));
		const pairing = await readFile(join(dir,'opencode-'+id+'.json'),'utf8');
		assert.equal(JSON.parse(pairing).provider,'openai');
		assert.ok(!pairing.includes('setup-fixture-secret'));
		assert.ok(output.includes(pin+' run --platform '+origin+' --harness claude --harness opencode'));
	} finally { server.closeAllConnections();server.close();await rm(dir,{recursive:true,force:true}); }
});
