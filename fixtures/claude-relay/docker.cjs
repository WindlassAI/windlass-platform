#!/usr/bin/env node
// Test namespace translation at the Docker CLI boundary. Never select existing session or login resources.
const { spawnSync } = require('node:child_process');
const { F3_PREFIX: prefix, F3_MACHINE: machine, F3_DIR: dir } = process.env;
if (!/^f3-check-[a-f0-9]{16}$/.test(prefix) || !/^m_[a-f0-9]{16}$/.test(machine)) process.exit(2);
const harness = process.env.F3_HARNESS === 'opencode' ? 'opencode' : 'claude';
const volume = 'wlp-harness-' + harness + '-' + machine;
const args = process.argv.slice(2).map(s => s.replaceAll(volume, prefix + '-login').replace(/wlp-session-(?:(?:claude|opencode)-)?[a-f0-9]{12}\b/g, name => name.replace('wlp-session-', prefix + '-box-')));
if (args.some(s => /wlp-session-|wlp-harness-|wlp-user-|wlp-live[-_]|wlp-staging-|windlass-runner[-:]|windlass-tunnel|windlass-platform-sandbox:latest/.test(s))) throw Error('Unexpected resource name');
if (args[args.indexOf('--network') + 1] === 'bridge' || args[0] === 'network' && args[1] === 'connect' && args[2] === 'bridge') {
	const at = args.indexOf('bridge'); args[at] = prefix + '-uplink';
}
if (args[0] === 'create' && args.includes('WLP_' + harness.toUpperCase() + '_RELAY_MACHINE=' + machine)) {
	args.splice(1, 0, '--mount', 'type=bind,src=' + dir + '/cert.pem,dst=/fixture-ca.pem,readonly', '-e', 'NODE_EXTRA_CA_CERTS=/fixture-ca.pem');
}
if (harness === 'opencode' && args[0] === 'run' && args.includes('XDG_DATA_HOME=/login')) {
	args.splice(1, 0, '--mount', 'type=bind,src='+dir+'/cert.pem,dst=/fixture-ca.pem,readonly', '-e', 'NODE_EXTRA_CA_CERTS=/fixture-ca.pem', '-e', 'OPENCODE_DISABLE_MODELS_FETCH=true');
}
// Hold only an offline OpenCode probe so the test can replace the login during discovery.
if (process.env.F3_PAUSE_PROBE && args[0] === 'run' && args.at(-1) === 'wlp-opencode-acp') {
	const fs = require('node:fs');
	fs.writeFileSync(dir + '/probing', '');
	const deadline = Date.now() + 12000;
	const wait = new Int32Array(new SharedArrayBuffer(4));
	while (!fs.existsSync(dir + '/continue-probe')) {
		if (Date.now() > deadline) process.exit(2);
		Atomics.wait(wait, 0, 0, 50);
	}
}
const translate = args.includes('inspect') || args[0] === 'ps' || args[0] === 'volume' && args[1] === 'ls';
const result = spawnSync('/usr/bin/docker', args, { stdio: ['inherit', translate ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8' });
if (translate && result.stdout) process.stdout.write(result.stdout.replaceAll(prefix + '-login', volume)
	.replaceAll(prefix + '-box-', 'wlp-session-').replaceAll('"' + prefix + '-uplink":', '"bridge":'));
process.exit(result.status ?? 1);
