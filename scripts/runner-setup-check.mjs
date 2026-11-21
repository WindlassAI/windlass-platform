import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const importing of [false,true]) test(importing ? 'setup imports two API keys, declines a foreign refresh token and drops the mount' : 'setup pairs, skips Claude, accepts a hidden OpenCode key and prints the runnable Docker command', async () => {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const dir = await mkdtemp(join(root, '.setup-check-'));
	const pin = 'sha256:'+'1'.repeat(64), id = 'm_'+'a'.repeat(16);
	const asked = [];
	let refuseSetup = false;
	const server = createServer(async (req,res) => {
		let body=''; for await(const c of req) body+=c;
		asked.push(req.url);
		if (refuseSetup) { res.writeHead(403); res.end("{}"); return; }
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
		const state = join(dir,'state'), volume = join(dir,'relay-volume'), source = join(dir,'auth.json');
		await Promise.all([mkdir(state),mkdir(volume)]);
		const fixture = JSON.stringify({'opencode-go':{type:'api',key:'fixture-existing-go'},opencode:{type:'api',key:'fixture-existing-zen'},
			openai:{type:'oauth',refresh:'fixture-foreign-refresh',access:'fixture-foreign-access'}});
		if (importing) await writeFile(source,fixture);
		await writeFile(preload,`require('node:os').hostname=()=>'0123456789ab';
const fs=require('node:fs/promises'),open=fs.open;
fs.open=(p,...args)=>open(p==='/import/opencode/auth.json'?${JSON.stringify(source)}:p,...args);
require('node:module').syncBuiltinESMExports()`);
		await writeFile(join(dir,'docker'),`#!/usr/bin/env node
const a=process.argv.slice(2),d=process.env.WLP_RUNNER_STATE_DIR,fs=require('node:fs'),pin=${JSON.stringify(pin)};
if (a.includes('{{json .Image}} {{json .Mounts}}')) console.log(JSON.stringify(pin),JSON.stringify([{Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock'},{Type:'volume',Name:'setup-test',Destination:d},...${importing ? "[{Type:'bind',RW:false,Source:'/fixture/source',Destination:'/import/opencode'}]" : '[]'}]));
else if(a[0]==='image') console.log(pin);
else if(a[0]==='container') { console.error('No such container');process.exitCode=1; }
else if(a[0]==='volume' && a[1]==='ls') console.log('wlp-harness-opencode-${id}');
else if(a[0]==='volume' && a[1]==='inspect') console.log(JSON.stringify([{Driver:'local',Labels:{'dev.windlass-platform':'1','dev.windlass-platform.machine':'${id}','dev.windlass-platform.uid':'fixture'}}]));
else if(a[0]==='run' && a.includes('--network') && a.includes('none')) {
 if (!a.some(v=>v.includes('dst=/login,volume-nocopy'))) process.exit(3);
 process.chdir(${JSON.stringify(volume)}); fs.chownSync=()=>{};eval(a.at(-1));
}
else process.exitCode=2;
`,{mode:0o755});
		const env={...process.env,PATH:dir+':'+process.env.PATH,WLP_RUNNER_STATE_DIR:state};
		const child=spawn('script',['-qef','-c',`"${process.execPath}" --require "${preload}" "${dir}/runner.cjs" setup --platform ${origin} --harness claude --harness opencode`,'/dev/null'],{env,stdio:['pipe','pipe','pipe']});
		const prompts=[['Claude Code: sign in now?','n'],['OpenCode: sign in now?',''],...(importing ? [['(opencode-go) API key: import?',''],['(opencode) API key: import?',''],["can't be shared safely",'n']] : [['OpenCode provider','openai'],['Enter the openai API key','setup-fixture-secret']])];
		let output='', step=0;
		child.stdout.on('data',chunk=>{output+=chunk;if(step<prompts.length && output.includes(prompts[step][0])) child.stdin.write(prompts[step++][1]+'\n');});
		const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
		let code;try {code=await new Promise(done=>child.once('exit',done));}finally{clearTimeout(timer);child.stdin.destroy();}
		assert.equal(code,0,output.replaceAll('setup-fixture-secret','[fixture]'));
		assert.equal(step,prompts.length);
		assert.ok(!output.includes('setup-fixture-secret'));
		assert.match(output,/ABCD-EFGH/);
		assert.deepEqual(asked,['/runner/pair','/runner/pair/poll']);
		const stored = JSON.parse(await readFile(join(volume,'login.json'),'utf8'));
		const ids = importing ? ['opencode-go','opencode'] : ['openai'];
		assert.deepEqual(Object.keys(stored.records),ids);
		for (const [i,id] of ids.entries()) assert.equal(stored.records[id].key,importing ? ['fixture-existing-go','fixture-existing-zen'][i] : 'setup-fixture-secret');
		assert.doesNotMatch(JSON.stringify(stored),/foreign-refresh|foreign-access/);
		assert.ok(output.includes('-e WLP_RUNNER_STATE_DIR='+state));
		assert.deepEqual(JSON.parse(await readFile(join(state,'opencode-'+id+'.json'),'utf8')).providers,ids);
		for (const name of await readdir(state,{withFileTypes:true})) if (name.isFile())
			assert.doesNotMatch(await readFile(join(state,name.name),'utf8'),/fixture-existing-|fixture-foreign-|setup-fixture-secret/);
		if (importing) assert.equal(await readFile(source,'utf8'),fixture);
		assert.doesNotMatch(output,/fixture-existing-|fixture-foreign-|\/import\/opencode|\/fixture\/source/);
		assert.ok(output.includes(pin+' run --platform '+origin+' --harness claude --harness opencode'));
		if (!importing) {
			const bundle = join(dir, 'runner.cjs');
			const published = 'registry.invalid/runner@' + pin;
			const report = () => JSON.parse(execFileSync(process.execPath, [bundle,'capabilities'], {env:{...env,WLP_RUNNER_IMAGE:published}}));
			assert.deepEqual(report(), { image:published, harnesses:['claude','opencode'] });
			execFileSync(process.execPath,[join(root,'runner/bundle.mjs'),pin,bundle,'claude='+pin]);
			assert.deepEqual(report(), { image:published, harnesses:['claude'] });
			const run = (...args) => promisify(execFile)(process.execPath, ['--require',preload,bundle,...args], {env, timeout:10000});
			await assert.rejects(run('status','--name','example'), /with setup, run or pair/);
			await assert.rejects(run('pair','--egress','none'), /with setup or run/);
			refuseSetup = true;
			await assert.rejects(run('setup','--platform',origin), error => {
				assert.match(error.stdout, /re-run the setup command/);
				assert.doesNotMatch(error.stdout, /restart the container/);
				return true;
			});
		}

	} finally { server.closeAllConnections();server.close();await rm(dir,{recursive:true,force:true}); }
});
