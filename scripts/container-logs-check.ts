// Run with tsx from server/: npx tsx ../scripts/container-logs-check.ts
// Every container the platform and the runner start names its log driver, whatever the daemon's default:
// none for sessions, egress and helpers, rotated json-file logs for the runner and machine relays.
// A stand-in `docker` on PATH records each call, so this needs no Docker daemon.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import module from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wlp-logs-check-"));
const calls = join(dir, "calls");
const pin = "sha256:" + "1".repeat(64);
writeFileSync(calls, "");
writeFileSync(join(dir, "docker"), `#!/usr/bin/env node
const a = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
if (a[0] === "container" && a[1] === "inspect" && a.at(-1) === "0123456789ab")
  console.log(JSON.stringify([${JSON.stringify(pin)}, "local:test", [
    { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
    { Type: "volume", Name: "windlass-runner", Destination: "/var/lib/windlass-runner" }]]));
else if (a[1] === "inspect" && a.at(-1).startsWith("wlp-model-")) {
  console.error("No such object"); process.exitCode = 1;
}
else if (a[0] === "run" && a.includes("-d")) console.log("c0ffee");
else if (a[0] === "run" && a.some(v => v.endsWith("df"))) console.log("Avail\\n1000000");
`);
chmodSync(join(dir, "docker"), 0o755);
process.env.PATH = dir + ":" + process.env.PATH;
delete process.env.WLP_RUNNER_STATE_DIR;
// The runner bundle defines its image pins at build time.
Object.assign(globalThis, { SANDBOX_IMAGE: "windlass-platform-sandbox:check", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: {} });

const { NO_LOGS, RUNNER_LOGS, helperFlags } = await import("../server/src/sandbox/docker.js");
const { DockerSandboxes } = await import("../server/src/sandbox/sandboxes.js");
const { DockerModelRelay } = await import("../server/src/sandbox/model-relay.js");
const { DockerSnapshots } = await import("../server/src/sandbox/snapshots.js");
const { MachineDocker } = await import("../runner/src/policy.js");
// setup inspects only its own container, which Docker names by its short id.
(os as { hostname: () => string }).hostname = () => "0123456789ab";
module.syncBuiltinESMExports();
const { setupImageAndMounts } = await import("../runner/src/setup.js");

const recorded = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
/** The container-starting calls since the last look, each with the log options it passes. */
let seen = 0;
function started() {
	const all = recorded();
	const fresh = all.slice(seen).filter(args => args[0] === "run" || args[0] === "create");
	seen = all.length;
	return fresh;
}
function logOptions(args: string[]) {
	const options: string[] = [];
	args.forEach((arg, i) => { if (arg === "--log-driver" || arg === "--log-opt") options.push(arg, args[i + 1]); });
	return options;
}
const ok = (s: string) => console.log("PASS  " + s);

async function check() {
	assert.deepEqual(NO_LOGS, ["--log-driver", "none"]);
	assert.deepEqual(RUNNER_LOGS, ["--log-driver", "json-file", "--log-opt", "max-size=16m", "--log-opt", "max-file=3"]);
	assert.deepEqual(logOptions(helperFlags("wlp-tmp-check", "none")), NO_LOGS);
	ok("Helper containers (sign-in steps, access tokens, version probe, volume chores) keep no log.");

	const uid = "u_" + "a".repeat(16), sessionId = "s_check";
	const hosted = new DockerSandboxes({ machine: null, dataVolume: async () => "wlp-user-" + uid, dropDataVolume: async () => {} });
	await hosted.create({ uid, sessionId, profile: "docker-hardened" });
	const sessions = started();
	assert.equal(sessions.length, 1);
	assert.deepEqual(logOptions(sessions[0]), NO_LOGS);
	ok("A hosted Docker session container keeps no log, so the agent cannot fill the host's disk through it.");

	const acp = new DockerSandboxes({ machine: null, hostedKeys: true,
		dataVolume: async () => { throw Error("a hosted harness must not mount user data"); }, dropDataVolume: async () => {} });
	for (const harness of ["claude", "codex", "opencode"] as const) {
		await acp.create({ uid, sessionId, profile: "docker-hardened", harness });
		const [args] = started();
		assert.equal(args.at(-1), process.env[`WLP_${harness.toUpperCase()}_IMAGE`] || `windlass-platform-${harness}:dev`);
		assert.ok(args.includes("dev.windlass-platform.harness=" + harness));
		assert.ok(!args.includes("-v") && !args.some(arg => /API_KEY|BEARER|OAUTH/.test(arg)));
	}
	ok("Hosted Docker provisions each harness image without credentials or shared volumes.");
	if (process.argv.includes("--hosted")) return;

	const machine = "m_" + "b".repeat(16);
	const model = new DockerModelRelay({ machine, image: "fixture" });
	await model.ensure();
	const [modelContainer] = started();
	assert.equal(modelContainer[modelContainer.indexOf("--name") + 1], model.relayName);
	assert.deepEqual(logOptions(modelContainer), ["--log-driver", "json-file", "--log-opt", "max-size=4m", "--log-opt", "max-file=2"]);
	ok("A machine model relay starts with two rotated 4 MiB Docker logs.");

	const relayed = new DockerSandboxes({ machine, image: "windlass-platform-claude:check", harness: "claude",
		sessionRelay: async () => ({ env: ["-e", "WLP_RELAY=placeholder"], nonce: "n".repeat(16) }) });
	await relayed.create({ uid, sessionId, profile: "docker-hardened", harness: "claude" });
	const relaySessions = started();
	assert.equal(relaySessions.length, 1);
	assert.deepEqual(logOptions(relaySessions[0]), NO_LOGS);
	ok("A runner's relayed Claude session container names the none driver once.");

	const snapshots = new DockerSnapshots(machine, "windlass-platform-sandbox:check") as unknown as {
		locked<T>(image: string, work: () => Promise<T>, busy: T): Promise<T>; free(): Promise<number> };
	await snapshots.locked("windlass-platform-sandbox:check", async () => snapshots.free(), 0);
	const snapshotHelpers = started();
	assert.equal(snapshotHelpers.length, 2);
	for (const args of snapshotHelpers) assert.deepEqual(logOptions(args), NO_LOGS);
	ok("The snapshot lock and free-space containers keep no log.");

	const docker = new MachineDocker({ uid, machineId: machine });
	await docker.disk();
	const machineHelpers = started();
	assert.equal(machineHelpers.length, 1);
	assert.deepEqual(logOptions(machineHelpers[0]), NO_LOGS);
	ok("A runner's own helper and probe containers keep no log.");

	const { command } = await setupImageAndMounts();
	assert.deepEqual(logOptions(command), RUNNER_LOGS);
	assert.ok(command.indexOf("--log-driver") < command.indexOf(pin), "log options come before the image");
	ok("Setup's runner command keeps a json-file log of at most three 16 MiB files.");

	for (const file of ["../web/src/screens/Machines.tsx", "../web/src/docs/content/machines.md", "../web/src/docs/content/runner.md", "../docs/machines.md"]) {
		const text = readFileSync(new URL(file, import.meta.url), "utf8");
		for (const at of text.split("docker run -d --name windlass-runner").slice(1))
			assert.ok(at.split("\n").slice(0, 3).join("\n").includes(RUNNER_LOGS.join(" ")), file + " shows a runner command without its log limit");
	}
	ok("The Machines page and the docs show the same log limit on the runner command.");
}

try {
	await check();
} finally {
	rmSync(dir, { recursive: true, force: true });
}
