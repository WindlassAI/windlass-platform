#!/usr/bin/env node
// Test namespace translation at the Docker CLI boundary. Never select existing session or login resources.
const { spawnSync } = require('node:child_process');
const { F3_PREFIX: prefix, F3_MACHINE: machine, F3_DIR: dir } = process.env;
if (!/^f3-check-[a-f0-9]{16}$/.test(prefix) || !/^m_[a-f0-9]{16}$/.test(machine)) process.exit(2);
const harness = ['opencode','codex'].includes(process.env.F3_HARNESS) ? process.env.F3_HARNESS : 'claude';
const volume = 'wlp-harness-' + harness + '-' + machine;
const names = [
	...['claude','opencode','codex'].filter(h => h !== harness).flatMap(h => [
		['wlp-harness-'+h+'-'+machine,prefix+'-'+h+'-login'],
		['wlp-'+h+'-relay-'+machine,prefix+'-'+h+'-relay'],
		['wlp-'+h+'-socket-'+machine,prefix+'-'+h+'-socket'],
	]),
	[volume, prefix + '-login'],
	['wlp-' + harness + '-relay-' + machine, prefix + '-relay'],
	['wlp-' + harness + '-socket-' + machine, prefix + '-socket'],
	['wlp-egress-' + machine, prefix + '-egress'],
];
const args = process.argv.slice(2).map(arg => names.reduce((s, [from,to]) => s.replaceAll(from,to), arg).replace(/wlp-session-(?:(?:claude|opencode|codex)-)?[a-f0-9]{12}\b/g, name => name.replace('wlp-session-', prefix + '-box-')));
if (args.some(s => /wlp-(?:opencode|claude|codex)-relay-m_|wlp-egress-m_|wlp-session-|wlp-harness-|wlp-user-|wlp-live[-_]|wlp-staging-|windlass-runner[-:]|windlass-tunnel|windlass-platform-sandbox:latest/.test(s))) throw Error('Unexpected resource name');
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
if (process.env.F3_PAUSE_PROBE && args[0] === 'run' && (args.at(-1) === 'wlp-opencode-acp' || args.at(-1)?.endsWith('exec wlp-codex-acp'))) {
	const fs = require('node:fs');
	fs.writeFileSync(dir + '/probing', '');
	const deadline = Date.now() + (harness === "codex" ? 120000 : 12000);
	const wait = new Int32Array(new SharedArrayBuffer(4));
	while (!fs.existsSync(dir + '/continue-probe')) {
		if (Date.now() > deadline) process.exit(2);
		Atomics.wait(wait, 0, 0, 50);
	}
}
if (harness === 'codex' && process.env.F3_DEVICE_URL && args[0] === 'exec' && args.at(-1) === '--device-auth') {
	process.stdout.write(process.env.F3_DEVICE_URL+'\nABCD-EFGH\n');
	return;
}
const translate = args.includes('inspect') || args[0] === 'ps' || args[0] === 'volume' && args[1] === 'ls';
const result = spawnSync('/usr/bin/docker', args, { stdio: ['inherit', translate ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8' });
if (translate && result.stdout) process.stdout.write(names.reduce((s, [original,fixture]) => s.replaceAll(fixture,original), result.stdout)
	.replaceAll(prefix + '-box-', 'wlp-session-').replaceAll('"' + prefix + '-uplink":', '"bridge":'));
// Full inspect output includes the bundled relay script and can span multiple pipe buffers.
process.exitCode = result.status ?? 1;
