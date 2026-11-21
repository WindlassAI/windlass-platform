// Run from server: pnpm exec tsx ../scripts/runner-egress-live.ts <base-image-id> <claude-image-id>
// Uses the real runner bundle, a local pairing server and run-private Docker names.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LABEL, MACHINE_LABEL } from "../server/src/sandbox/docker.js";
import { stub, until } from "./runner-stub-server.js";

const exec = promisify(execFile);
const [base, claude] = process.argv.slice(2);
assert([base, claude].every(pin => /^sha256:[a-f0-9]{64}$/.test(pin)), "Supply two immutable local image IDs.");
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "egress-proof-"));
const srv = await stub(join(dir, "engine"));
const prefix = "egress-" + srv.machineId.slice(2) + "-";
const realDocker = (await exec("which", ["docker"])).stdout.trim();
const docker = async (...args: string[]) => (await exec(realDocker, args, { timeout: 90_000 })).stdout.trim();
const bundle = process.env.EGRESS_CHECK_BUNDLE ? resolve(process.env.EGRESS_CHECK_BUNDLE) : join(dir, "runner.cjs");
const state = join(dir, "state");
const env = { PATH: dir + delimiter + process.env.PATH, HOME: dir, WLP_RUNNER_STATE_DIR: state, RIVET_LOG_LEVEL: "silent" };
// Translate only the two shared resource prefixes at the CLI boundary. Keep streaming exec
// and image arguments intact. The daemon sees no normal session names or login volume names.
const runnerImage = process.env.EGRESS_CHECK_RUNNER_IMAGE;
if (runnerImage) assert.match(runnerImage, /^sha256:[0-9a-f]{64}$/);
const serviceName = prefix + "runner";
await writeFile(join(dir, "docker"), `#!/usr/bin/env node
const {spawnSync} = require("node:child_process");
const {readFileSync} = require("node:fs");
const pairs=[["wlp-session-", "${prefix}agent-"], ["wlp-harness-claude-", "${prefix}login-"]];
function names(value, reverse=false) {
	for(const [a,b] of pairs) value=reverse ? value.replaceAll(b,a) : value.replaceAll(a,b);
	return value;
}
const args=process.argv.slice(2).map(x=>names(x));
const listing=args[0]==="ps" || (args[0]==="volume" && args[1]==="ls");
const api=args[0]==="system" && args[1]==="dial-stdio";
const child=spawnSync(${JSON.stringify(runnerImage ? "/usr/local/bin/docker" : realDocker)},args,{
	stdio:[api?"pipe":"inherit",listing?"pipe":"inherit","inherit"],
	...(api && {input:names(readFileSync(0,"utf8"))})
});
if(listing) process.stdout.write(names(child.stdout.toString(),true));
process.exit(child.status ?? 1);
`, { mode: 0o755 });
let service: ReturnType<typeof spawn> | undefined;
let output = "";
async function start(extra: string[] = []) {
	srv.state.report = null;
	const flags = ["--platform", srv.platform, "--harness", "claude", "--allow-profile", "docker-windlass-sandbox", ...extra];
	const sock = "/var/run/docker.sock";
	service = runnerImage
		? spawn(realDocker, ["run", "--rm", "--pull", "never", "--name", serviceName, "--network", "host",
			"--user", `${process.getuid!()}:${process.getgid!()}`, "--group-add", String((await stat(sock)).gid),
			"-e", "HOME=/tmp", "-e", "PATH=/test-bin:/usr/local/bin:/usr/bin:/bin", "-v", sock + ":" + sock,
			"-v", state + ":/var/lib/windlass-runner", "-v", join(dir, "docker") + ":/test-bin/docker:ro", runnerImage, ...flags],
			{ stdio: ["ignore", "pipe", "pipe"] })
		: spawn(process.execPath, [bundle, ...flags], { env, stdio: ["ignore", "pipe", "pipe"] });
	service.stdout!.on("data", s => { output += s; });
	service.stderr!.on("data", s => { output += s; });
	await until(() => { assert.equal(service!.exitCode, null, output); return !!srv.state.report; }, "runner report", 120_000);
}
async function stop() {
	if (service && service.exitCode === null && !service.signalCode) {
		const closed = once(service, "exit");
		if (runnerImage) await docker("stop", "-t", "15", serviceName);
		else service.kill("SIGTERM");
		await closed;
	}
}
async function probe(container: string, name: string, command: string, expected: RegExp) {
	const out = await docker("exec", container, "bash", "-ec", command);
	assert.match(out, expected, name);
	console.log("PASS", name, JSON.stringify(command), "=>", out.slice(-200));
}
const filters = ["--filter", "label=" + MACHINE_LABEL + "=" + srv.machineId, "--filter", "label=" + LABEL + ".uid=" + srv.uid];
const physical = (id: string, harness = "") => prefix + "agent-" + harness + id.slice(-12);
try {
	await mkdir(state, { mode: 0o700 });
	if (!runnerImage && !process.env.EGRESS_CHECK_BUNDLE) await exec(process.execPath, [join(root, "runner/bundle.mjs"), base, bundle, "claude=" + claude]);
	await start();
	await srv.attach();
	let first = srv.channel(srv.sessionId);
	const a = await first.request("create", { profile: "docker-windlass-sandbox" });
	const agent = physical(a);
	await srv.attach(srv.other);
	let second = srv.channel(srv.other);
	const b = await second.request("create", { profile: "docker-hardened", harness: "claude" });
	const peer = physical(b, "claude-");
	for (const [name, pin] of [[agent, base], [peer, claude]]) {
		const actual = await docker("inspect", "-f", "{{.Image}}", name);
		assert.equal(actual, await docker("image", "inspect", "-f", "{{.Id}}", pin));
	}
	await docker("exec", "-d", peer, "node", "-e", "require('http').createServer((q,r)=>r.end('peer-witness')).listen(19123,'0.0.0.0')");
	await until(async () => (await docker("exec", peer, "curl", "-fsS", "--noproxy", "*", "http://127.0.0.1:19123").catch(() => "")) === "peer-witness", "peer listener");
	const peerIp = await docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", peer);
	await probe(agent, "peer isolation (listener verified in Claude)", `if curl --noproxy '*' -fsS --max-time 3 http://${isIP(peerIp) ? peerIp : "127.0.0.1"}:19123; then echo reachable; else echo blocked; fi`, /^blocked$/);
	assert.equal(srv.state.report!.egress, "restricted");
	await probe(agent, "CONNECT refuses private HTTPS", "curl --max-time 4 -s -o /dev/null -w '%{http_connect}' https://10.0.0.1 || true", /^403$/);
	for (const target of ["169.254.169.254", "[fd00:ec2::254]", "169.254.5.6", "10.0.0.1", "100.64.0.1", "[fc00::1]", "[fe80::1]", "172.17.0.1:22"]) {
		await probe(agent, "proxy denies " + target, `curl --max-time 5 -s -o /dev/null -w '%{http_code}' http://${target}/`, /^403$/);
	}
	await probe(agent, "direct TCP including host, metadata and internet", `for address in 169.254.169.254/80 172.17.0.1/22 10.0.0.1/443 1.1.1.1/443; do if timeout 2 bash -c "true > /dev/tcp/$address" 2>/dev/null; then exit 1; fi; done; echo blocked`, /^blocked$/);
	await probe(agent, "public HTTPS", "curl -fsS --max-time 20 -o /dev/null -w '%{http_code}' https://example.com", /^200$/);
	await probe(agent, "plain HTTP", "curl -sS --max-time 20 -o /dev/null -w '%{http_code}' http://example.com", /^[23]\d\d$/);
	await probe(agent, "git clone", "git clone -q --depth=1 https://github.com/octocat/Hello-World.git /tmp/egress-git && git -C /tmp/egress-git rev-parse --short HEAD", /^[a-f0-9]+$/);
	await probe(agent, "npm install", "mkdir /tmp/egress-npm && cd /tmp/egress-npm && npm install --no-audit --no-fund --ignore-scripts is-number@7.0.0 && node -p \"require('is-number')(7)\"", /true$/);
	await probe(agent, "Windlass Bun model transport", "bun -e \"console.log((await fetch('https://api.openai.com/v1/models')).status)\"", /^401$/);
	await first.request("writeSecretFile", { id: a, path: "/tmp/egress-fixture-token.json",
		content: JSON.stringify({ accessToken: "invalid-egress-proof", expiresAt: Date.now() + 3_600_000 }) });
	await probe(agent, "Windlass provider round trip with a dummy token",
		"WINDLASS_ACCESS_TOKEN_FILE=/tmp/egress-fixture-token.json windlass --json hi > /tmp/provider-proof 2>&1 || true; rg -io -m1 'handed_in_rejected|401 Unauthorized' /tmp/provider-proof", /handed_in_rejected|401 Unauthorized/i);
	await probe(peer, "Claude image and Anthropic TLS", "wlp-claude-acp --cli --version && curl -sS --max-time 20 -o /dev/null -w '%{ssl_verify_result} %{http_code}' https://api.anthropic.com/v1/models", /Claude Code\)[\s\S]*0 (401|403)$/);
	const script = { responses: [
		[{ type: "tool_call", callId: "local", name: "shell", input: { command: "if curl -fsS --max-time 3 https://example.com; then exit 1; fi; echo inner-isolated > proof.txt" } }, { type: "finish", reason: "tool_calls" }],
		[{ type: "text", text: "egress-proof-finished" }, { type: "finish", reason: "stop" }],
	] };
	await first.request("writeTextFile", { id: a, path: "/tmp/egress-script.json", content: JSON.stringify(script) });
	await probe(agent, "full fake-model turn and bubblewrap command isolation", "WINDLASS_ACP_SCRIPT=/tmp/egress-script.json windlass --approval auto --json hi > /tmp/egress-turn && rg -q egress-proof-finished /tmp/egress-turn && cat proof.txt", /^inner-isolated$/);
	await first.request("suspend", { id: a });
	await first.request("connect", { id: a });
	await probe(agent, "resume restores proxy", "curl -fsS --max-time 20 -o /dev/null -w '%{http_code}' https://example.com", /^200$/);
	await stop();
	srv.reset(srv.sessionId); srv.reset(srv.other);
	await start(["--egress", "none"]);
	await srv.attach(); await srv.attach(srv.other);
	first = srv.channel(srv.sessionId); second = srv.channel(srv.other);
	assert.equal(srv.state.report!.egress, "none");
	for (const old of [agent, peer]) assert.equal(await docker("inspect", "-f", "{{.State.Running}}", old), "false");
	await assert.rejects(first.request("connect", { id: a }), /different network policy/);
	await first.request("destroy", { id: a });
	const offline = await first.request("create", { profile: "docker-hardened" });
	await probe(physical(offline), "none has no route or proxy", "test -z \"$HTTPS_PROXY\" && ! curl -fsS --max-time 3 https://example.com && echo blocked", /^blocked$/);
	await first.request("destroy", { id: offline });
	await second.request("destroy", { id: b });
	await stop();
	srv.reset(srv.sessionId); srv.reset(srv.other);
	await start(["--egress", "open"]);
	await srv.attach(); await srv.attach(srv.other);
	first = srv.channel(srv.sessionId); second = srv.channel(srv.other);
	const o1 = physical(await first.request("create", { profile: "docker-hardened" }));
	const o2 = physical(await second.request("create", { profile: "docker-hardened" }));
	await docker("exec", "-d", o2, "node", "-e", "require('http').createServer((q,r)=>r.end('peer')).listen(19123)");
	await until(async () => (await docker("exec", o2, "curl", "-fsS", "http://127.0.0.1:19123").catch(() => "")) === "peer", "open peer listener");
	const ip = await docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", o2);
	await probe(o1, "open peer isolation", `! curl -fsS --max-time 2 http://${ip}:19123 && echo blocked`, /^blocked$/);
	await probe(o1, "open direct HTTPS", "curl --noproxy '*' -fsS --max-time 20 -o /dev/null -w '%{http_code}' https://example.com", /^200$/);
	await stop();
	// Simulate an already-paired pre-egress runner and a kept workspace on bridge.
	await rm(join(state, "egress-" + srv.machineId + ".json"));
	const old = prefix + "agent-" + randomBytes(6).toString("hex");
	await docker("run", "-d", "--name", old, "--network", "bridge", "--label", LABEL + "=1",
		"--label", MACHINE_LABEL + "=" + srv.machineId, "--label", LABEL + ".uid=" + srv.uid,
		"--label", LABEL + ".session=s_legacy", "--label", LABEL + ".profile=docker-hardened", base);
	await docker("exec", old, "sh", "-c", "echo kept > /workspace/legacy.txt");
	await start();
	assert.equal(srv.state.report!.egress, "open");
	const networks = JSON.parse(await docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", old));
	assert.deepEqual(Object.keys(networks), ["wlp-open-" + srv.machineId]);
	assert.equal(await docker("exec", old, "cat", "/workspace/legacy.txt"), "kept");
	for (const command of ["status", "log"]) {
		const result = runnerImage ? await docker("exec", serviceName, "windlass-runner", command) : (await exec(process.execPath, [bundle, command], { env })).stdout;
		assert.match(result, /--egress restricted/);
	}
	console.log("PASS legacy pairing stays open, preserves workspace, isolates the former bridge and prints opt-in in status and log");
} catch (err) {
	console.error(output);
	throw err;
} finally {
	await stop();
	await srv.close();
	for (const id of (await docker("ps", "-aq", ...filters)).split(/\s+/).filter(Boolean)) await docker("rm", "-fv", id);
	for (const vol of (await docker("volume", "ls", "-q", ...filters)).split(/\s+/).filter(Boolean)) await docker("volume", "rm", vol);
	for (const net of (await docker("network", "ls", "-q", ...filters)).split(/\s+/).filter(Boolean)) await docker("network", "rm", net);
	await rm(dir, { recursive: true, force: true });
	console.log("Throwaway pairing cleaned up", srv.machineId);
}
