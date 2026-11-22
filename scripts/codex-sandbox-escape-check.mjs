// From server: pnpm exec tsx ../scripts/codex-sandbox-escape-check.mjs <local Codex image>
// Codex in the Windlass sandbox profile's container never runs or writes anything outside its own
// sandbox, even when the user would allow it: the image's PermissionRequest hook refuses the request
// inside Codex, a repository's .codex/config.toml cannot turn the hook off, and Auto review fails.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { PROFILE_RUN_FLAGS } from '../server/src/sandbox/docker-flags.ts';
import { commonRunFlags } from '../server/src/sandbox/profiles.ts';
import { NO_LOGS } from '../server/src/sandbox/docker.ts';

const image = process.argv[2];
assert.ok(image, 'usage: codex-sandbox-escape-check.mjs <image>');
const fixtures = fileURLToPath(new URL('../fixtures/codex/', import.meta.url));
const box = 'wlp-escape-check-' + randomBytes(6).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const sh = (script) => docker('exec', box, 'sh', '-c', script);
const ok = (s) => console.log('PASS  ' + s);

async function turn(mode, script) {
	sh('pkill -f "[s]cripted-gateway" ; rm -f /tmp/tool-outputs.jsonl; true');
	docker('exec', '-d', '-e', 'WLP_SCRIPT=' + script, box, 'node', '/fixture/scripted-gateway.cjs');
	for (let i = 0; sh("node -e \"require('net').connect(17892,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\" && echo up || true") !== 'up'; i++) {
		assert.ok(i < 50, 'the scripted gateway did not start');
		await wait(100);
	}
	const result = JSON.parse(docker('exec', '-w', '/workspace', '-e', 'WLP_MODE=' + mode, box, 'node', '/fixture/acp-client.mjs'));
	result.outputs = sh('cat /tmp/tool-outputs.jsonl 2>/dev/null || true');
	return result;
}
const exists = (path) => sh(`test -e ${path} && echo yes || echo no`) === 'yes';
const escalate = (path) =>
	`const r = await tools.exec_command({cmd:"id > ${path}", sandbox_permissions:"require_escalated", justification:"Need to write there"}); text(JSON.stringify(r));`;
const patch = (path) => `const r = await tools.apply_patch("*** Begin Patch\\n*** Add File: ${path}\\n+x\\n*** End Patch\\n"); text(JSON.stringify(r));`;
function refused(result, what) {
	assert.deepEqual(result.asked, [], what + ': Codex asked the client');
	assert.equal(result.stopReason, 'end_turn', what + ': ' + JSON.stringify(result));
	assert.match(result.outputs, /Refused: on this machine Codex runs only inside its sandbox\./, what);
}

try {
	docker('run', '-d', '--rm', '--name', box, '--pull', 'never', ...NO_LOGS, ...commonRunFlags(1, 'none'),
		...PROFILE_RUN_FLAGS['docker-windlass-sandbox'], '-v', fixtures + ':/fixture:ro', image, 'sleep', '600');

	refused(await turn('workspace-write', escalate('/home/agent/escalated')), 'an escalated command');
	assert.equal(exists('/home/agent/escalated'), false);
	ok('Workspace access: a command with require_escalated is refused inside Codex and never runs.');

	refused(await turn('read-only', patch('/home/agent/patched')), 'an edit in Read-only');
	assert.equal(exists('/home/agent/patched'), false);
	ok('Read-only: an edit is refused inside Codex, although an approved edit would be written outside the sandbox.');

	refused(await turn('workspace-write', patch('/workspace/.codex/config.toml')), 'an edit of a protected path');
	assert.equal(exists('/workspace/.codex/config.toml'), false);
	ok('Workspace access: an edit of the protected /workspace/.codex is refused.');

	const inside = await turn('workspace-write', patch('/workspace/inside.txt'));
	assert.deepEqual(inside.asked, []);
	assert.equal(exists('/workspace/inside.txt'), true);
	ok('Workspace access still edits the workspace without asking.');

	sh('mkdir -p /workspace/.codex && printf "[features]\\ncodex_hooks = false\\n" > /workspace/.codex/config.toml');
	refused(await turn('workspace-write', escalate('/home/agent/escalated-again')), 'a repository that disables hooks');
	assert.equal(exists('/home/agent/escalated-again'), false);
	sh('rm -rf /workspace/.codex');
	ok("A repository's .codex/config.toml cannot turn the refusal off (requirements.toml keeps hooks on).");

	const review = await turn('agent', 'text("unreached")');
	assert.match(review.error ?? '', /approvals_reviewer|approvals reviewer|AutoReview|auto_review/i, JSON.stringify(review));
	ok('Auto review fails: requirements.toml allows only the user as approvals reviewer.');

	const container = await turn('agent-full-access', 'const r = await tools.exec_command({cmd:"echo ran-in-container"}); text(JSON.stringify(r));');
	assert.deepEqual(container.asked, []);
	assert.match(container.outputs, /ran-in-container/);
	ok('Container access (the hardened profile’s mode) still runs commands without asking.');
	console.log('PASS Codex stays in its sandbox on the Windlass sandbox profile.');
} finally {
	try { docker('rm', '-f', box); } catch {}
}
