import assert from 'node:assert/strict';
export async function checkIsolation(name, cmd, token, processMatch, loginPath) {
	const audit = await cmd(['exec', '-i', name, 'python3', '-c', `import base64,glob,os,subprocess,sys
marker=sys.stdin.buffer.read()
assert marker and not os.path.exists(sys.argv[2])
envs=glob.glob('/proc/[0-9]*/environ')
assert len(envs)>2
saw_cli=False
for path in ['/etc/hosts','/etc/hostname','/etc/resolv.conf',*envs,*glob.glob('/proc/[0-9]*/cmdline')]:
 if not os.path.exists(path): continue
 raw=subprocess.check_output(['cat','--',path])
 encoded=subprocess.check_output(['base64','-w0','--',path])
 assert marker not in raw and marker not in base64.b64decode(encoded)
 if path.endswith('/cmdline') and sys.argv[1].encode() in raw.split(b'\\0')[0]: saw_cli=True
assert saw_cli
print("ok")
`,processMatch,loginPath], {stdin: token.slice(0,31)});
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
