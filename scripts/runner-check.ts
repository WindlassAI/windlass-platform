/** Run: cd server && npx tsx ../scripts/runner-check.ts
 * The five-minute Wi-Fi outage and two-minute laptop sleep are wall time.
 */
import { imageId } from "./check-image.js";
import { localListeners } from "./check-listeners.js";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { AcpConnection, LineSplitter } from "../server/src/sandbox/acp.js";
import { docker, LABEL_ARG, MACHINE_LABEL } from "../server/src/sandbox/docker.js";
import { containerName, DockerSandboxes } from "../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../server/src/sandbox/token-file.js";
import { PAIRING_TTL_MS, REFUSED_RETRY_MS, refuse, type Refusal } from "../server/src/runner/control.js";
import { RUNNER_GRACE_MS } from "../server/src/runner/protocol.js";
import { ConversationLost, ServerChannel } from "../server/src/runner/channel.js";
import { safeSentence } from "../runner/src/audit.js";
import { stub, until } from "./runner-stub-server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), "wlp-runner-check-"));
const state = join(tmp, "state");
const bundle = join(tmp, "runner.cjs");
const exec = promisify(execFile);
const ok = (s: string) => console.log("PASS  " + s);
const children = new Set<ChildProcess>();
const env = (dir: string) => ({ PATH: process.env.PATH, HOME: tmp, RIVET_LOG_LEVEL: "silent", WLP_RUNNER_STATE_DIR: dir });
async function stop(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
	if (p.exitCode !== null || p.signalCode) return;
	const closed = new Promise<void>(resolve => p.once("exit", () => resolve()));
	p.kill("SIGCONT"); p.kill(signal);
	const timer = setTimeout(() => p.kill("SIGKILL"), 12_000);
	try { await closed; } finally { clearTimeout(timer); }
}
async function scripted(ch: ServerChannel, id: string, interrupt: () => Promise<void>, resume?: string) {
	const fixture = JSON.parse(await readFile(join(root, "fixtures/acp-probe/script.json"), "utf8"));
	fixture.responses.shift(); // omit the network example; the shell step is local
	const path = "/workspace/fixture.json";
	await ch.request("writeTextFile", { id, path, content: JSON.stringify(fixture) });
	const events: string[] = [], seq = new Set<number>();
	let duplicates = 0;
	let dropped: Promise<void> | undefined;
	const acp = new AcpConnection(line => ch.write(process.id, line + "\n"), {
		async request() { return { outcome: { outcome: "cancelled" } }; },
		notification(method, params) {
			if (method !== "_windlass/event") return;
			const e = params.event as { type: string; seq?: number };
			if (e.seq !== undefined) { if (seq.has(e.seq)) duplicates++; seq.add(e.seq); }
			events.push(e.type);
			if (!dropped && e.type === "tool.started") dropped = interrupt();
		},
	}, "windlass");
	const lines = new LineSplitter(line => acp.receive(line));
	const process = ch.start({ id, argv: ["windlass", "acp"], tag: "fixture", options: { env: { WINDLASS_ACP_SCRIPT: path } } }, (fd, s) => { if (fd === 1) lines.push(s); });
	const call = <T>(method: string, params: Record<string, unknown>) => acp.request<T>(method, params, { timeoutMs: 430_000 });
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "runner-check", version: "1" }, clientCapabilities: { _meta: { windlass: { events: true, updates: false } } } });
	const params = { cwd: "/workspace", mcpServers: [], _meta: { windlass: { approval: "full", attended: true } } };
	const opened = await call<{ sessionId: string }>(resume ? "session/resume" : "session/new", { ...params, ...(resume ? { sessionId: resume } : {}) });
	const sessionId = resume ?? opened.sessionId;
	const result = await call<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: "Run the local fixture." }] });
	await dropped;
	assert.ok(dropped); assert.ok(events.includes("execution.succeeded")); assert.equal(duplicates, 0); assert.equal(result.stopReason, "end_turn");
	await call("session/close", { sessionId }); ch.closeIn(process.id);
	assert.equal((await process.ended).code, 0);
	return sessionId;
}
// One integration against the actual platform routes, user and machine actors. The demo
// account has no GitHub link, so this also exercises the nullable login in PairStatus.
async function realMachine(runnerImage: string) {
	const { engine: port, http: [http] } = await localListeners();
	const endpoint = "http://127.0.0.1:" + port;
	const platform = "http://127.0.0.1:" + http;
	const node = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
		cwd: join(root, "server"), stdio: "ignore",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, WLP_SECRET: randomBytes(32).toString("hex"),
			WLP_MACHINES: "1", WLP_DEMO: "1", WLP_SANDBOX: "fake", WLP_PUBLIC_URL: platform,
			WLP_HTTP_PORT: String(http), RIVET_RUN_ENGINE_PORT: String(port),
			RIVET_LOG_LEVEL: "silent", RIVETKIT_STORAGE_PATH: join(tmp, "real-engine") },
	});
	const directory = join(tmp, "real-runner");
	const name = "wlp-check-runner-" + randomBytes(6).toString("hex");
	let service: ChildProcess | undefined;
	let output = "", stderr = "", health = "";
	try {
		await until(async () => {
			if (node.exitCode !== null) throw Error("Local platform exited during startup.");
			return (await fetch(platform + "/health").catch(() => null))?.ok === true;
		}, "Local platform did not start.", 90_000);
		const { createClient } = await import("../server/src/client.js");
		const client = createClient<import("../server/src/client.js").Registry>({ endpoint, namespace: "default" });
		const auth = await client.login.getOrCreate([randomUUID()]).demo();
		const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
		await mkdir(directory, { mode: 0o700 });
		const socket = "/var/run/docker.sock";
		service = spawn("docker", ["run", "--rm", "--pull", "never", "--name", name, "--label", LABEL_ARG,
			"--log-driver", "none", "--network", "host", "--user", `${process.getuid!()}:${process.getgid!()}`,
			"--group-add", String((await stat(socket)).gid), "-e", "HOME=/tmp",
			"-v", socket + ":" + socket, "-v", directory + ":/var/lib/windlass-runner", runnerImage, "--platform", platform],
			{ stdio: ["ignore", "pipe", "pipe"] });
		service.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
		service.stdout!.on("data", chunk => { output = (output + chunk).slice(-8192); });
		await until(() => /enter [A-Z0-9]{4}-[A-Z0-9]{4}/.test(output), "Real platform did not start pairing.");
		const code = /enter ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)![1];
		await user.claimMachine({ code }); const machine = await user.confirmMachine({ code });
		await until(async () => {
			const current = (await user.machines()).find(m => m.machineId === machine.machineId);
			health = current?.commandSandbox?.ok === false ? current.commandSandbox.reason : "";
			return current?.status === "online" && current.freeDiskBytes !== null;
		}, "The real machine actor did not accept the runner's hello and report.", 60_000);
		assert.match(output, /Paired with an account without a GitHub login/);
		const pruneStarted = performance.now();
		await assert.rejects(exec("docker", ["exec", name, "windlass-runner", "prune"], { timeout: 3_000 }),
			(error: { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes("run prune in a one-off runner container with the same state volume and Docker socket"));
		ok(`Prune refused the running service in ${((performance.now() - pruneStarted) / 1000).toFixed(2)}s and explained how to prune after stopping it.`);
		const publicKey = async () => createPublicKey(JSON.parse(await readFile(join(directory, "pair.json"), "utf8")).key).export({ type: "spki", format: "der" });
		const formerKey = await publicKey();
		await user.removeMachine({ machineId: machine.machineId, removeSandboxes: false });
		await until(() => output.includes("was removed"), "Real actor removal did not reach the runner.");
		assert.equal(service.exitCode, null);
		async function pairThroughService() {
			output = "";
			const pairing = exec("docker", ["exec", name, "windlass-runner", "pair"], { timeout: 60_000 });
			await until(() => /enter [A-Z0-9]{4}-[A-Z0-9]{4}/.test(output), "The local pair command did not start a fresh pairing.");
			const code = /enter ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)![1];
			await user.claimMachine({ code });
			const paired = await user.confirmMachine({ code });
			assert.match((await pairing).stdout, /Paired with/);
			await until(async () => (await user.machines()).some(m => m.machineId === paired.machineId && m.status === "online"),
				"The new pairing did not reconnect.");
			return paired.machineId;
		}
		const replacement = await pairThroughService();
		assert.notEqual(replacement, machine.machineId); assert.ok(!formerKey.equals(await publicKey()));
		assert.notEqual(await pairThroughService(), replacement);
		const status = await exec("docker", ["exec", name, "windlass-runner", "status"]);
		for (const id of [machine.machineId, replacement]) assert.ok(status.stdout.includes(id + " (previous pairing)"));
		ok("The packaged runner pairs against the real actor, parks on removal, and accepts a local pair command both while parked and while online.");

	} catch (error) {
		for (const [source, tail] of [["stdout", output], ["stderr", stderr], ["health", health]]) {
			const lines = tail.trim().split("\n").slice(-6);
			for (const line of lines) {
				const clean = safeSentence(line.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b|\b(?:ws|wss):\/\/\S+/gi, "[redacted]"));
				if (clean) console.error(`Runner ${source}: ${clean.slice(0, 500)}`);
			}
		}
		throw error;
	} finally {
		if (service) { await stop(service); await docker(["rm", "-f", name]); }
		await stop(node);
	}
}
async function check(image: string) {
	const srv = await stub(join(tmp, "engine"));
	const { machineId, uid, sessionId } = srv;
	const hostedRaw = randomBytes(6).toString("hex");
	const hostedName = containerName(hostedRaw);
	const marker = "dev.windlass-platform.check=" + randomBytes(6).toString("hex");
	const ownedFilters = ["--filter", "label=" + LABEL_ARG, "--filter", "label=" + MACHINE_LABEL + "=" + machineId];
	const containers = async () => (await docker(["ps", "-a", ...ownedFilters, "--format", "{{.Names}}"], { check: true })).stdout.trim();
	const reported = (id: string) => srv.state.report!.sandboxes.some(box => box.id === id);
	const testClock = join(tmp, "owner-clock.cjs");
	await writeFile(testClock, `const timers = require("node:timers/promises"); const wait = timers.setTimeout;
timers.setTimeout = (ms, ...args) => wait(ms === ${REFUSED_RETRY_MS} ? 3500 : ms, ...args);
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = ms => timeout(ms === ${PAIRING_TTL_MS} ? 6500 : ms);\n`);
	function run(dir = state, preload?: string, program = bundle, dockerEnv: NodeJS.ProcessEnv = {}, { platform = srv.platform, flags = [] }: { platform?: string; flags?: string[] } = {}) {
		const child = spawn(process.execPath, ["--require", testClock, ...(preload ? ["--require", preload] : []), program, "--platform", platform, ...flags], { env: { ...env(dir), ...dockerEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", s => { output += s; }); child.stderr.on("data", s => { output += s; });
		children.add(child); child.once("exit", () => children.delete(child));
		return { child, output: () => output };
	}
	async function cli(command: string, dir = state) { return (await exec(process.execPath, [bundle, command], { env: env(dir), timeout: 20_000 })).stdout; }
	let hosted = false;
	try {
		await mkdir(state, { mode: 0o700 });
		for (const [flag, value] of [["--max-running", "0"], ["--max-sandboxes", "1.5"]]) {
			await assert.rejects(exec(process.execPath, [bundle, "status", flag, value], { env: env(state) }),
				(error: { code?: number; stderr?: string }) => error.code === 1 && error.stderr?.trim() === `Give ${flag} a positive whole number.`);
		}
		const expiredAudit = join(state, "audit-2000-01-01.jsonl");
		await writeFile(expiredAudit, "old", { mode: 0o600 });
		// A runner died after docker run and before the workspace's git init.
		const unfinishedRaw = randomBytes(6).toString("hex");
		const unfinishedName = containerName(unfinishedRaw);
		await docker(["run", "-d", "--pull", "never", "--name", unfinishedName, "--label", LABEL_ARG,
			"--label", MACHINE_LABEL + "=" + machineId, "--label", "dev.windlass-platform.uid=" + uid,
			"--label", "dev.windlass-platform.session=" + sessionId, "--label", "dev.windlass-platform.profile=docker-hardened",
			image], { check: true });
		srv.state.pairingMode = "refused";
		let service = run();
		await until(() => service.output().includes("Pairing was refused"), "Pairing refusal did not park the runner.");
		assert.equal(service.child.exitCode, null); assert.match(await cli("status"), /restart the container/);
		assert.equal(srv.state.pairStarts, 1);
		await assert.rejects(exec(process.execPath, [bundle, "pair", "--platform", srv.platform], { env: env(join(tmp, "standalone")), timeout: 10_000 }),
			(error: { code?: number; stdout?: string }) => error.code === 1 && !!error.stdout?.includes("Pairing was refused"));
		srv.state.pairingMode = "gone";
		assert.match(await cli("pair"), /pairing code expired/);
		srv.state.pairingMode = "waiting";
		assert.match(await cli("pair"), /pairing code expired/);
		const invalid = join(tmp, "standalone");
		await writeFile(join(invalid, "status.json"), "broken", { mode: 0o600 });
		await assert.rejects(exec(process.execPath, [bundle, "status"], { env: env(invalid) }),
			(error: { stderr?: string }) => !!error.stderr?.includes("status.json. Repair or restore"));
		const parkedStarts = srv.state.pairStarts;
		const parkedPolls = srv.state.pollFailures;
		await wait(7000);
		assert.equal(srv.state.pairStarts, parkedStarts); assert.equal(srv.state.pollFailures, parkedPolls);
		assert.match(await cli("log"), /pairing code expired/);
		srv.state.pairingMode = "approve"; srv.state.startFailures = 1;
		const paired = await cli("pair");
		assert.match(paired, /Trying again/); assert.match(paired, /Paired with runner-check/);
		ok("Refused start, expired code and polling deadline all park the service. Only the owner's pair command obtains another code.");
		await until(() => !!srv.state.report, "The runner did not pair and report.", 75_000);
		assert.match(service.output(), /Paired with runner-check\. If that is not you, run `windlass-runner pair` again\./);
		assert.ok(srv.state.pollFailures >= 2 && srv.state.clockRefusals > 0);
		await assert.rejects(stat(expiredAudit), { code: "ENOENT" });
		assert.equal((await stat(state)).mode & 0o777, 0o700); assert.equal((await stat(join(state, "pair.json"))).mode & 0o777, 0o600);
		assert.equal((await readFile(join(state, "lock"), "utf8")).trim(), String(service.child.pid));
		assert.equal(srv.state.report!.docker.ok, true);
		ok("Pairing retries a 503, identifies the account, protects the key and lock, and corrects a 30-minute clock error.");
		assert.ok(reported("m" + machineId + "-" + unfinishedRaw));
		await srv.attach();
		const recoveryChannel = srv.channel(sessionId);
		const [recovered, repeated] = await Promise.all([1, 2].map(() => recoveryChannel.request("create", { profile: "docker-hardened" })));
		assert.notEqual(recovered, "m" + machineId + "-" + unfinishedRaw, "Create adopted the unfinished sandbox.");
		assert.equal(repeated, recovered);
		const recoveredName = containerName(recovered.slice(-12));
		assert.equal(await containers(), recoveredName);
		await docker(["exec", recoveredName, "test", "-e", "/workspace/.git"], { check: true });
		await recoveryChannel.request("destroy", { id: recovered });
		srv.detach();
		ok("Concurrent creates replace a rediscovered unfinished sandbox once.");
		const waiting = "Another runner holds the state lock. Waiting to retry.";
		const interrupted = run(state, undefined, bundle, {}, { flags: ["run"] });
		await until(() => interrupted.output().includes(waiting), "Second service did not wait for the lock.");
		const stopping = performance.now();
		await stop(interrupted.child);
		assert.equal(interrupted.child.exitCode, 0);
		assert.ok(performance.now() - stopping < 3000, "Stopping a waiting service took too long.");

		const standby = run();
		await until(() => standby.output().includes(waiting), "Service started with --platform did not wait for the lock.");
		await wait(4000); // Cross the test clock's 3.5-second retry while the first service is still online.
		assert.equal(standby.output().trim(), waiting);
		assert.equal(standby.child.exitCode, null);
		assert.ok(srv.online());
		assert.equal((await readFile(join(state, "lock"), "utf8")).trim(), String(service.child.pid));
		await stop(service.child);
		service = standby;
		await until(() => service.output().includes("Online"), "The waiting service did not take over.", 10_000);
		assert.equal((await readFile(join(state, "lock"), "utf8")).trim(), String(service.child.pid));
		ok("A second service reports the held lock once, stays alive and takes over after the first stops. SIGTERM interrupts a waiting service.");
		const second = join(tmp, "second");
		await mkdir(second, { mode: 0o700 }); await copyFile(join(state, "pair.json"), join(second, "pair.json"));
		const mismatch = run(second, undefined, bundle, {}, { platform: "http://127.0.0.1:1" });
		await until(() => mismatch.output().includes("pair with a different platform"), "Platform mismatch did not park.");
		assert.equal(mismatch.child.exitCode, null);
		assert.match(await cli("status", second), /pair with a different platform/);
		await stop(mismatch.child);
		const oldPair = await readFile(join(state, "pair.json"));
		srv.state.pairingMode = "gone";
		assert.match(await cli("pair"), /pairing code expired/);
		assert.ok(oldPair.equals(await readFile(join(state, "pair.json"))));
		await until(() => srv.online(), "An abandoned pairing failed to reconnect with the working key.");
		srv.state.pairingMode = "approve";
		ok("A platform mismatch parks, standalone pairing exits on refusal, and an abandoned replacement preserves the working pairing.");
		const duplicate = run(second);
		await until(() => duplicate.output().includes("key-in-use"), "Copied key was not refused.");
		assert.equal(duplicate.child.exitCode, null); assert.match(await cli("status", second), /key-in-use/);
		await stop(duplicate.child);
		ok("A second process with a copied key stays alive and the first stays online.");

		// The join run lost the gateway while the HTTP route still answered. Also
		// exercise immediate HTTP failures, when a tight loop would make the most attempts.
		for (const link of ["gateway", "all", "gateway"] as const) {
			const { connections, connectionRequests } = srv.state;
			srv.cut(link);
			await wait(30_000);
			const attempts = srv.state.connectionRequests - connectionRequests;
			const restored = performance.now();
			srv.restore();
			await until(() => srv.state.connections > connections, "Runner took over 20s to reconnect.", 20_000);
			assert.ok(attempts >= 3 && attempts <= 5, `Made ${attempts} attempts during the cut.`);
			ok(`Runner reconnected ${((performance.now() - restored) / 1000).toFixed(2)}s after a 30s ${link} cut, with ${attempts} attempts during the cut.`);
		}

		const missing = join(tmp, "missing.cjs");
		await exec(process.execPath, ["runner/bundle.mjs", "sha256:" + randomBytes(32).toString("hex"), missing], { cwd: root });
		const bin = join(tmp, "bin");
		await mkdir(bin);
		const measured = join(tmp, "disk-measurements");
		const pullStarted = join(tmp, "pull-started"), releasePull = join(tmp, "release-pull");
		const wrappedDocker = { PATH: bin + ":" + env(state).PATH, CHECK_DOCKER_PATH: env(state).PATH };
		// A delayed pull is entirely local. All container operations use the real daemon.
		await writeFile(join(bin, "docker"), `#!/bin/sh
if [ "$1" = "pull" ]; then
  echo start >> "$CHECK_PULL_STARTED"
  for i in $(seq 1 100); do [ -f "$CHECK_RELEASE_PULL" ] && break; sleep 0.1; done
  exit 1
fi
for arg in "$@"; do
  if [ "$arg" = "df" ] && [ -n "$CHECK_DF_LOG" ]; then echo df >> "$CHECK_DF_LOG"; fi
  if [ "$arg" = "df" ] && [ -n "$CHECK_LOW_DISK" ]; then printf 'Avail\\n4999999999\\n'; exit 0; fi
done
PATH="$CHECK_DOCKER_PATH" exec docker "$@"
`, { mode: 0o700 });
		for (const fault of ["daemon", "image", "disk"] as const) {
			await stop(service.child); await until(() => !srv.online(), "Test runner did not disconnect.");
			srv.state.report = null;
			// This socket never exists. Keep its path within the Unix socket limit even with a long TMPDIR.
			const missingHost = `unix:///run/absent-directory-${machineId}/missing.sock`;
			const dockerEnv = fault === "daemon" ? { DOCKER_HOST: missingHost, CHECK_PRIVATE_SETTING: "absent-directory" } :
				fault === "disk" ? { ...wrappedDocker, CHECK_LOW_DISK: "1" } : {};
			service = run(state, undefined, fault === "image" ? missing : bundle, dockerEnv);
			await until(() => !!srv.state.report, "Missing machine-health report.");
			if (fault === "daemon") {
				const health = srv.state.report!.docker;
				assert.ok(!health.ok);
				const { stderr, code } = await docker(["--host", missingHost, "ps"]);
				assert.notEqual(code, 0);
				const prefix = stderr.trim().split(/[\r\n]/, 1)[0].split("unix://")[0];
				assert.ok(prefix.length > 0 && health.reason.startsWith(prefix));
				assert.ok(!health.reason.includes("absent-directory") && !/[\r\n]/.test(health.reason) && health.reason.length <= 500);
				assert.match(await cli("log"), /"operation":"docker","outcome":"(?:not found|unreachable)"/);
			} else {
				await srv.attach();
				await assert.rejects(srv.channel(sessionId).request("create", { profile: "docker-hardened" }),
					fault === "disk" ? /at least 5 GB free/ : /pinned sandbox image is missing/);
				assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
			}
		}
		await stop(service.child); await until(() => !srv.online(), "Fault fixture stayed connected.");
		const slowImage = join(tmp, "slow.cjs");
		await exec(process.execPath, ["runner/bundle.mjs", "fixture.invalid/sandbox@sha256:" + "0".repeat(64), slowImage], { cwd: root });
		service = run(state, undefined, slowImage, { ...wrappedDocker, CHECK_PULL_STARTED: pullStarted, CHECK_RELEASE_PULL: releasePull });
		await until(() => stat(pullStarted).then(() => true, () => false), "The simulated pull did not start.");
		await srv.attach();
		const pullingChannel = srv.channel(sessionId);
		const creates = Promise.all([1, 2].map(() => assert.rejects(pullingChannel.request("create", { profile: "docker-hardened" }), /pinned sandbox image/)));
		try {
			assert.equal(await pullingChannel.request("state", { id: "m" + machineId + "-" + hostedRaw }), "none");
		} finally { await writeFile(releasePull, "done"); }
		await creates;
		assert.equal(await readFile(pullStarted, "utf8"), "start\n");
		await stop(service.child); await until(() => !srv.online(), "Slow pull fixture stayed connected.");
		ok("Concurrent creates and welcome share one image pull while another lifecycle request completes.");
		async function startWithLimits(...flags: string[]) {
			srv.state.report = null;
			service = run(state, undefined, bundle, {}, { flags });
			await until(() => !!srv.state.report, "The runner did not report after changing its limits.");
		}
		async function stopService() {
			await stop(service.child);
			await until(() => !srv.online(), "The runner stayed connected after stopping.");
		}
		async function limitsInStatus(running: string, kept: string) {
			const lines = (await cli("status")).split("\n");
			assert.ok(lines.includes("Running sandbox limit: " + running));
			assert.ok(lines.includes("Kept sandbox limit: " + kept));
			return lines;
		}
		await startWithLimits();
		const boxes = [];
		for (let i = 0; i < 11; i++) {
			const session = i === 0 ? sessionId : i === 1 ? srv.other : sessionId + "_cap" + i;
			await srv.attach(session);
			const channel = srv.channel(session);
			const id = await channel.request("create", { profile: "docker-hardened" });
			if (i >= 1 && i <= 7) await channel.request("suspend", { id });
			boxes.push({ session, channel, id });
		}
		const inventory = await limitsInStatus("no limit", "no limit");
		assert.equal(inventory.filter(line => line.endsWith("  running")).length, 4);
		assert.equal(inventory.filter(line => line.endsWith("  paused")).length, 7);
		for (const { session, channel, id } of boxes.slice(2)) {
			await channel.request("destroy", { id });
			srv.reset(session);
		}
		ok("Without flags the runner keeps eleven sandboxes, four running, and status shows no limit for both.");
		const [first, secondBox] = boxes;
		await stopService();
		await startWithLimits("--max-running", "1");
		await limitsInStatus("1", "no limit");
		await until(() => first.channel.connected && secondBox.channel.connected, "The sessions did not reconnect.");
		const runningLimit = { name: "SandboxUserError", message: "This machine has reached its own limit on running sandboxes, set by --max-running." };
		await assert.rejects(secondBox.channel.request("connect", { id: secondBox.id }), runningLimit);
		await secondBox.channel.request("destroy", { id: secondBox.id });
		await assert.rejects(secondBox.channel.request("create", { profile: "docker-hardened" }), runningLimit);
		await first.channel.request("suspend", { id: first.id });
		ok("--max-running 1 refuses a second start on resume and create with the owner's flag in the session message.");
		await stopService();
		await startWithLimits("--max-sandboxes", "1");
		await limitsInStatus("no limit", "1");
		await until(() => first.channel.connected && secondBox.channel.connected, "The sessions did not reconnect.");
		await assert.rejects(secondBox.channel.request("create", { profile: "docker-hardened" }),
			{ name: "SandboxUserError", message: "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes." });
		await first.channel.request("destroy", { id: first.id });
		srv.detach(srv.other);
		await stopService();
		ok("--max-sandboxes 1 counts the suspended sandbox and refuses a second create with the owner's flag in the session message.");
		srv.state.gatewayLifetime = 2000;
		srv.state.report = null; service = run(state, undefined, bundle, { ...wrappedDocker, CHECK_DF_LOG: measured }); await until(() => !!srv.state.report, "Healthy runner did not report again.");
		ok("An unavailable daemon is reported, and a missing pin or less than 5 GB free prevents sandbox creation.");
		assert.equal(await readFile(measured, "utf8"), "df\n");
		const connections = srv.state.connections, requests = srv.state.connectionRequests;
		await wait(srv.state.gatewayLifetime + 100);
		srv.state.gatewayLifetime = 60_000;
		await srv.attach();
		assert.equal(srv.state.connections, connections);
		assert.equal(srv.state.connectionRequests, requests + 1);
		await srv.attach();
		assert.equal(srv.state.connectionRequests, requests + 1);
		ok("An expired gateway credential is renewed for a session open and reused on the next open, on the original control connection.");
		let ch = srv.channel(sessionId);
		let id: string;
		try {
			id = await ch.request("create", { profile: "docker-windlass-sandbox" });
			ok("Bubblewrap starts in the created sandbox.");
		} catch (error) {
			assert.match((error as Error).message, /Bubblewrap could not start in the new sandbox/);
			assert.equal(srv.state.report!.commandSandbox.ok, false, "Startup probe must reflect this kernel's create-time result.");
			assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
			ok("This kernel refused the create-time bubblewrap probe; the runner removed the failed sandbox.");
			id = await ch.request("create", { profile: "docker-hardened" });
		}
		assert.ok((await readFile(measured, "utf8")).split("df\n").length >= 3);
		const raw = id.slice(-12); assert.equal(id, "m" + machineId + "-" + raw);
		const name = containerName(raw);
		const [inspection] = JSON.parse((await docker(["inspect", name], { check: true })).stdout);
		assert.equal(inspection.Config.Labels[MACHINE_LABEL], machineId);
		assert.equal(inspection.Config.Labels["dev.windlass-platform.uid"], uid);
		assert.equal(inspection.Config.Labels["dev.windlass-platform.session"], sessionId);
		assert.equal(inspection.Config.Image, image); assert.equal(inspection.Config.User, "agent");
		assert.equal(inspection.HostConfig.Privileged, false); assert.equal(inspection.HostConfig.Memory, 1536 * 1024 ** 2);
		assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]); assert.equal(inspection.HostConfig.PidsLimit, 512);
		assert.equal(inspection.Mounts.length, 1); assert.equal(inspection.Mounts[0].Type, "volume");
		assert.notEqual(inspection.Mounts[0].Name, "wlp-user-" + uid);
		await until(() => reported(id), "Create did not promptly report the sandbox.", 5000);
		const reports = srv.state.reports;
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), id);
		assert.equal(await containers(), name);
		assert.equal(srv.state.reports, reports);
		ok("Repeating create returns the one container and the unchanged inventory is reported once.");
		await ch.request("writeTextFile", { id, path: "/tmp/runner-file", content: "survives suspend" });
		await ch.request("writeSecretFile", { id, path: "/tmp/private-fixture", content: "ordinary fixture" });
		assert.equal((await ch.request("ask", { id, argv: ["stat", "-c", "%a", "/tmp/private-fixture"] }))?.stdout.trim(), "600");
		assert.equal((await ch.request("run", { id, command: "pwd", options: { cwd: "/tmp" } })).stdout.trim(), "/tmp");
		await ch.request("removeFiles", { id, paths: ["/tmp/private-fixture"] });
		await assert.rejects(ch.request("readTextFile", { id, path: "/tmp/absent-file" }), /cannot read.*absent-file/);
		assert.equal(srv.state.lastErrorKind, "sandbox");
		const log = await cli("log");
		assert.ok(!log.includes("ordinary fixture") && !log.includes("/tmp/private-fixture") && !log.includes("PRIVATE KEY"));
		await ch.request("suspend", { id }); assert.equal(await ch.request("state", { id }), "paused");
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), id);
		assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim(), "exited");
		assert.equal((await ch.request("connect", { id }))?.cwd, "/workspace");
		assert.equal(await ch.request("readTextFile", { id, path: "/tmp/runner-file" }), "survives suspend");
		ok("Create, read, write, ask, run, suspend and resume use the pinned image, local limits and labelled volume.");

		await srv.attach(srv.other);
		await assert.rejects(srv.channel(srv.other).request("run", { id, command: "touch /tmp/wrong-session" }), /another session/);
		assert.equal(srv.state.lastErrorKind, "refused");
		srv.corruptNext("unknown");
		await assert.rejects(ch.request("run", { id, command: "touch /tmp/unknown-op" }), /does not serve/);
		srv.corruptNext("create");
		await assert.rejects(ch.request("create", { profile: "docker-hardened" }), /does not serve/);
		assert.equal((await ch.request("run", { id, command: "test ! -e /tmp/wrong-session && test ! -e /tmp/unknown-op" })).exitCode, 0);
		await docker(["run", "-d", "--name", hostedName, "--label", LABEL_ARG, "--label", marker, "--label", "dev.windlass-platform.uid=" + uid, image, "sleep", "infinity"], { check: true });
		hosted = true;
		const foreign = "m" + machineId + "-" + hostedRaw;
		await assert.rejects(ch.request("destroy", { id: foreign }), /does not belong/);
		await assert.rejects(ch.request("run", { id: foreign, command: "touch /tmp/touched" }), /owned/);
		const hostedProvider = new DockerSandboxes({ image, machine: null, dataVolume: async () => { throw Error("unexpected create"); } });
		assert.deepEqual((await hostedProvider.list(uid)).map(x => x.id), [hostedRaw]);
		assert.ok(!(await cli("status")).includes(hostedRaw)); assert.equal((await docker(["exec", hostedName, "test", "!", "-e", "/tmp/touched"])).code, 0);
		srv.detach(srv.other); srv.incompatible(srv.other);
		srv.ticket(srv.other);
		await until(async () => (await cli("log")).includes("speaks protocol 0"), "The session refusal was not logged.");
		const opened = srv.opened.get(srv.other);
		srv.ticket(srv.other); await wait(1500);
		assert.equal(srv.opened.get(srv.other), opened);
		ok("A protocol-refused session ignores subsequent tickets while the control socket stays online.");
		ok("Cross-session, hosted and unknown operations are refused. Hosted and runner inventories are disjoint.");

		let output = "";
		const stopped = ch.start({ id, tag: "stopme", argv: ["sh", "-c", "echo ready; sleep 120"] }, (_, s) => { output += s; });
		await until(() => output.includes("ready"), "The process did not stream output.");
		await srv.attach(); // A new ticket takes over the live socket with this process still outstanding.
		assert.ok((await ch.request("ask", { id, argv: ["wlp-run", "list", "stopme"] }))?.stdout.trim());
		await ch.request("signal", { process: stopped.id, sig: "TERM", who: "all" }); await stopped.ended;
		const abort = new AbortController();
		const cancelled = await ch.request("run", { id, command: "echo ready; sleep 120" }, { signal: abort.signal, onOutput: () => abort.abort() });
		assert.equal(cancelled.aborted, true); assert.equal(cancelled.timedOut, false);
		ok("The server's tag identifies the process. Signalling stops it and cancel aborts a run.");

		// The marker is after the final blocking write: it cannot exist while the runner's pipes are paused.
		srv.acks(false);
		const hash = createHash("sha256"); let bytes = 0;
		const stream = ch.start({ id, tag: "pressure", argv: ["sh", "-c", "seq -f '%09.0f' 0 2097151; touch /tmp/writer-finished"] }, (_, data) => { hash.update(data); bytes += data.length; });
		// The window counts encoded frames, including JSON escapes for these newlines.
		// Observe the writer coming to rest without assuming eight MiB of payload fit.
		let lastBytes = 0, changed = Date.now();
		await until(() => {
			if (bytes !== lastBytes) { lastBytes = bytes; changed = Date.now(); }
			return bytes >= 4 * 1024 ** 2 && Date.now() - changed > 1200;
		}, "The source did not stall with acknowledgements withheld.");
		assert.equal((await docker(["exec", name, "test", "!", "-e", "/tmp/writer-finished"])).code, 0);
		const peak = bytes; await wait(1000); assert.equal(bytes, peak);
		srv.cut(); srv.acks(true); await wait(5000); srv.restore();
		assert.equal((await stream.ended).code, 0); assert.equal(bytes, 20 * 1024 ** 2);
		const expected = createHash("sha256");
		for (let n = 0; n < 2_097_152; n++) expected.update(String(n).padStart(9, "0") + "\n");
		assert.equal(hash.digest("hex"), expected.digest("hex"));
		ok("Withheld receipts block the container writer. After a real TCP cut all 20 MiB arrive once and in order.");

		const tokenPath = tokenFilePath(id);
		await ch.request("writeTextFile", { id, path: tokenPath, content: "fixture" });
		srv.send({ kind: "logout" });
		await until(async () => (await ch.request("ask", { id, argv: ["test", "!", "-e", tokenPath] }))?.code === 0, "Logout left the token file.");
		let running = false;
		const oldRun = ch.request("run", { id, command: "echo ready; sleep 3; touch /tmp/orphan-finished" }, { onOutput: () => { running = true; } });
		const lost = assert.rejects(oldRun, ConversationLost);
		const acp = ch.start({ id, tag: "orphan", argv: ["windlass", "acp"] }, () => {});
		await until(async () => running && !!(await docker(["exec", name, "wlp-run", "list", "orphan"])).stdout.trim(), "Orphan fixture did not start.");
		srv.reset(); await srv.attach(); ch = srv.channel(sessionId);
		await lost; assert.ok((await acp.ended).error instanceof ConversationLost);
		await until(async () => !(await docker(["exec", name, "wlp-run", "list", "orphan"])).stdout.trim(), "Reset left Windlass running.");
		await until(async () => (await docker(["exec", name, "test", "-e", "/tmp/orphan-finished"])).code === 0, "Reset killed an independent run.");
		ok("Control logout removes the turn file. A fresh conversation closes Windlass and lets an independent command finish.");

		let windlass: string | undefined;
		for (const [duration, freeze] of [[5000, false], [300_000, false], [120_000, true]] as const) {
			windlass = await scripted(ch, id, async () => {
				const before = await readFile(measured, "utf8");
				srv.cut();
				if (freeze) { service.child.kill("SIGSTOP"); await docker(["pause", name], { check: true }); }
				try { await wait(duration); assert.equal(await readFile(measured, "utf8"), before); }
				finally { if (freeze) { await docker(["unpause", name], { check: true }); service.child.kill("SIGCONT"); } srv.restore(); }
			}, windlass);
			ok(`A scripted Windlass turn finished with unique events across a ${duration / 1000}s ${freeze ? "laptop sleep" : "network loss"}.`);
		}

		ok("Disk is measured on welcome and create, and the five-minute outage starts no disk helper.");
		const crash = ch.start({ id, tag: "crash", argv: ["sh", "-c", "sleep 120 | windlass acp"] }, () => {});
		await until(async () => !!(await docker(["exec", name, "wlp-run", "list", "crash"])).stdout.trim(), "Crash fixture did not start.");
		const epoch = srv.state.epoch;
		await stop(service.child, "SIGKILL"); await until(() => !srv.online(), "Killed runner stayed online.");
		srv.state.report = null; srv.state.idleMs = 2000;
		// Section 9 row 2 uses a one-minute grace. Shorten only that timer in the test
		// process and restarted runner; the released runner has no timing override.
		const clock = join(tmp, "grace.cjs");
		await writeFile(clock, `const timer = global.setTimeout; global.setTimeout = (fn, ms, ...args) => timer(fn, ms === ${RUNNER_GRACE_MS} ? 60000 : ms, ...args);\n`);
		service = run(state, clock);
		await until(() => srv.state.epoch !== epoch && !!srv.state.report, "Restart did not report.");
		assert.ok((await crash.ended).error instanceof ConversationLost);
		assert.ok(srv.state.report!.sandboxes.some(b => b.id === id)); assert.ok(!srv.state.report!.sandboxes.some(b => b.id === foreign));
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), id);
		assert.equal(await containers(), name);
		assert.ok(await ch.request("stopLeftovers", { id, program: "windlass" }) > 0);
		assert.equal(await ch.request("readTextFile", { id, path: "/tmp/runner-file" }), "survives suspend");
		const orphan = ch.start({ id, tag: "longloss", argv: ["windlass", "acp"] }, () => {});
		await until(async () => !!(await docker(["exec", name, "wlp-run", "list", "longloss"])).stdout.trim(), "Long-outage fixture did not start.");
		const timer = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
			timer(fn, ms === RUNNER_GRACE_MS ? 60_000 : ms, ...args)) as typeof setTimeout;
		try {
			srv.cut();
			await until(() => !ch.connected, "The session socket stayed connected.");
			await wait(5000); // Longer than the two-second idle interval, within the conversation's grace.
			assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim(), "running");
			await wait(85_000);
			assert.ok((await orphan.ended).error instanceof ConversationLost);
			await until(async () => (await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim() === "exited",
				"The sandbox did not idle-stop after the orphaned Windlass process ended.");
		} finally { globalThis.setTimeout = timer; srv.restore(); }
		await until(() => ch.connected, "Fresh socket did not attach after the expired grace.", 90_000);
		await ch.request("connect", { id });
		assert.equal((await ch.request("ask", { id, argv: ["wlp-run", "list", "longloss"] }))?.stdout.trim(), "");
		await scripted(ch, id, async () => {}, windlass);
		ok("Windlass keeps the disconnected sandbox running past idle time. After grace expires, the process ends, idle stops the sandbox, and Windlass can resume.");
		srv.detach();
		await until(async () => (await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim() === "exited", "Welcome idle time was ignored.");
		await srv.attach(); await ch.request("connect", { id }); await ch.request("destroy", { id });
		await until(() => !reported(id), "Destroy did not promptly report the removal.", 5000);
		assert.equal(await ch.request("state", { id }), "none");
		ok("SIGKILL loses the conversation. Restart recovers only owned containers, the next turn can stop leftovers, and welcome controls idle suspension.");

		const replacement = await ch.request("create", { profile: "docker-hardened" });
		assert.notEqual(replacement, id);
		const replacementName = containerName(replacement.slice(-12));
		assert.equal(await containers(), replacementName);
		await docker(["pause", replacementName], { check: true });
		assert.equal(await ch.request("create", { profile: "docker-hardened" }), replacement);
		assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", replacementName])).stdout.trim(), "paused");
		await docker(["unpause", replacementName], { check: true });
		await docker(["rm", "-f", replacementName], { check: true });
		const remove = await ch.request("create", { profile: "docker-hardened" });
		assert.notEqual(remove, replacement);
		assert.equal(await containers(), containerName(remove.slice(-12)));
		await until(() => reported(remove) && !reported(replacement), "The new inventory was not reported.", 5000);
		srv.send({ kind: "remove", sandbox: remove });
		await until(() => srv.state.removed === remove, "Control removal not acknowledged.");
		await until(() => !reported(remove), "Control removal did not promptly update the report.", 5000);
		ok("Create reuses a stopped, paused or rediscovered sandbox. Session destroy and external deletion each allow a fresh create, and both removal paths report promptly.");
		await ch.request("create", { profile: "docker-hardened" });
		for (const refusal of [refuse("outdated", { runnerVersion: "0.0.9" }), refuse("bad-frame"), refuse("unknown"), { kind: "refused", reason: "other", message: "Account unavailable." } as Refusal]) {
			srv.send(refusal);
			await until(() => service.output().includes(refusal.message), "The refusal was not logged.");
			assert.equal(service.child.exitCode, null); assert.ok((await cli("status")).includes(refusal.message));
			assert.ok((await cli("log")).includes(refusal.reason));
			const count = srv.state.connectionRequests;
			await wait(1500); assert.equal(srv.state.connectionRequests, count);
			await until(() => srv.online(), "Runner missed its slow retry.", 12_000);
		}
		async function expectParked() {
			await until(async () => (await cli("status")).includes("was removed"), "Removal did not appear in status.");
			assert.match(await cli("log"), /windlass-runner pair.*new key/);
			assert.ok(JSON.parse(await readFile(join(state, "pair.json"), "utf8")).key === null);
			const attempts = srv.state.connectionRequests, starts = srv.state.pairStarts;
			await wait(7500); // More than twice this process's test REFUSED_RETRY_MS.
			assert.equal(srv.state.connectionRequests, attempts); assert.equal(srv.state.pairStarts, starts);
			assert.equal(service.child.exitCode, null);
		}
		srv.send(refuse("removed", { removeSandboxes: true }));
		await expectParked();
		assert.equal((await docker(["volume", "ls", "-q", ...ownedFilters])).stdout.trim(), "");
		assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
		assert.match(await cli("pair"), /Paired with runner-check/);
		await until(() => srv.online(), "Pairing again left the runner idle."); await srv.attach();
		const kept = await ch.request("create", { profile: "docker-hardened" });
		await stop(service.child);
		srv.state.httpRefusal = "unknown"; service = run();
		await until(() => service.output().includes("HTTP 403"), "HTTP refusal was not reported.");
		assert.equal(service.child.exitCode, null); assert.match(await cli("status"), /unknown/);
		srv.state.httpRefusal = "removed"; await expectParked();
		assert.equal((await docker(["inspect", "-f", "{{.State.Status}}", containerName(kept.slice(-12))], { check: true })).stdout.trim(), "exited");
		assert.match(await cli("log"), /HTTP 410/);
		await stop(service.child);
		ok("Recoverable refusals retry slowly. Both forms of removal erase the key and park until the owner acts.");

		const prune = spawn(process.execPath, [bundle, "prune"], { env: env(state), stdio: ["pipe", "ignore", "ignore"] });
		prune.stdin.end("yes\n");
		assert.equal(await new Promise(resolve => prune.on("exit", resolve)), 0);
		assert.equal((await docker(["ps", "-aq", ...ownedFilters])).stdout.trim(), "");
		assert.equal((await docker(["volume", "ls", "-q", ...ownedFilters])).stdout.trim(), "");
		assert.equal((await docker(["inspect", containerName(kept.slice(-12))])).code === 0, false);
		assert.equal((await docker(["inspect", "-f", "{{.State.Running}}", hostedName])).stdout.trim(), "true");
		ok("Queued removal is acknowledged. Confirmed prune removes the machine's containers and volume and leaves hosted Docker intact.");
	} finally {
		for (const p of children) await stop(p);
		await srv.close();
		if (hosted) await docker(["rm", "-f", hostedName], { check: true });
		for (const id of (await docker(["ps", "-aq", ...ownedFilters])).stdout.trim().split(/\s+/).filter(Boolean)) await docker(["rm", "-fv", id], { check: true });
		for (const v of (await docker(["volume", "ls", "-q", ...ownedFilters])).stdout.trim().split(/\s+/).filter(Boolean)) await docker(["volume", "rm", v], { check: true });
	}
}
const privateTag = process.env.WLP_RUNNER_CHECK_IMAGE ? undefined : `windlass-runner:chk-${randomUUID()}`;
try {
	const image = await imageId();
	if (privateTag) {
		await exec(join(root, "scripts/runner-build.sh"), [image], { env: { ...process.env, WLP_RUNNER_BUILD_TAG: privateTag, WLP_RUNNER_PLATFORMS: "" } });
	}
	const runnerImage = await imageId(privateTag ?? process.env.WLP_RUNNER_CHECK_IMAGE);
	if (!process.argv.includes("--real-machine")) {
		await exec(process.execPath, ["runner/bundle.mjs", image, bundle], { cwd: root });
		await check(image);
	}
	await realMachine(runnerImage);
} catch (error) {
	// Client exceptions can contain signed URLs. Identify the failing assertion without replaying its arguments.
	const where = error instanceof Error ? /runner-check\.ts:(\d+)/.exec(error.stack ?? "")?.[1] : undefined;
	console.error(`FAIL  runner-check.ts line ${where ?? "unknown"}`);
	process.exitCode = 1;
} finally {
	if (privateTag && (await docker(["image", "inspect", privateTag])).code === 0) {
		await docker(["image", "rm", privateTag], { check: true });
	}
	await rm(tmp, { recursive: true, force: true });
}
// The in-process Rivet native runtime retains worker handles after registry.shutdown().
process.exit(process.exitCode ?? 0);
