// Local checks for machine scheduling and session persistence.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { claude: "fixture" } });

const identity = { uid: "u_fixture", machineId: "m_fixture" };

test("agent containers get low CPU shares and the machine's CPU cap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wlp-flags-"));
	const path = process.env.PATH, cap = process.env.WLP_RUNNER_CPUS;
	process.env.WLP_RUNNER_STATE_DIR = dir;
	const { Executor } = await import("../runner/src/docker-executor.js");
	try {
		writeFileSync(join(dir, "docker"), '#!/bin/sh\nif [ "$1" = run ]; then printf "%s\\n" "$@" > "$0.args"; fi\n', { mode: 0o755 });
		process.env.PATH = dir + ":" + path;
		for (const override of [undefined, "0.75"]) {
			if (override) process.env.WLP_RUNNER_CPUS = override;
			else delete process.env.WLP_RUNNER_CPUS;
			const owner = new Executor(identity, {}, false, true);
			owner.network.prepare = async () => {}; // This check captures session CPU flags without a daemon.
			owner.disk = async () => 10_000_000_000;
			owner.existing = async () => undefined;
			owner.ownedVolume = async () => true;
			for (const harness of [undefined, "claude"] as const) {
				await owner.create("s_fixture", "docker-hardened", false, harness);
				const flags = readFileSync(join(dir, "docker.args"), "utf8").trim().split("\n");
				const value = (flag: string) => flags.includes(flag) ? flags[flags.indexOf(flag) + 1] : undefined;
				assert.equal(value("--cpu-shares"), "256");
				assert.equal(value("--cpus"), override ?? String(Math.max(0.5, availableParallelism() / 2)));
				assert.equal(flags.filter(f => f === "--cpus").length, 1);
				assert.equal(value("--cap-drop"), "ALL");
			}
		}
		process.env.WLP_RUNNER_CPUS = "1 --privileged";
		assert.throws(() => new Executor(identity, {}), /WLP_RUNNER_CPUS/);
	} finally {
		process.env.PATH = path;
		if (cap === undefined) delete process.env.WLP_RUNNER_CPUS; else process.env.WLP_RUNNER_CPUS = cap;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resumed sandbox adopts this runner's CPU policy", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wlp-resume-"));
	const path = process.env.PATH;
	try {
		writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s " "$@" >> "$0.args"\nprintf "\\n" >> "$0.args"\nif [ "$1" = container ]; then echo "exited|1|m_fixture|docker-hardened|u_fixture"; fi\n', { mode: 0o755 });
		process.env.PATH = dir + ":" + path;
		const { DockerSandboxes } = await import("../server/src/sandbox/sandboxes.js");
		const options = { machine: identity.machineId, dataVolume: async () => "fixture", cpus: 0.75 };
		assert.ok(await new DockerSandboxes(options).connect("0123456789ab"));
		assert.match(readFileSync(join(dir, "docker.args"), "utf8"), /update --cpu-shares 256 --cpus 0.75 wlp-session-0123456789ab .*\nstart/);
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runner advertises two turn slots by default, and accepts a positive whole-number override", async () => {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const { parseRunnerFrame } = await import("../server/src/runner/control.js");
	const hello = { kind: "hello", runnerVersion: "1.0.0", epoch: "e0123456789", time: Date.now(), signature: "A".repeat(86) };
	const parse = (extra: object) => parseRunnerFrame(JSON.stringify({ ...hello, ...extra }));
	assert.equal(new Executor(identity, {}).maxTurns, 2);
	assert.equal(new Executor(identity, { maxTurns: 3 }).maxTurns, 3);
	assert.ok(parse({ maxTurns: 2 }));
	assert.ok(parse({}));
	for (const cap of [0, -1, 1.5, "3", null]) assert.equal(parse({ maxTurns: cap }), null);
});

test("a snapshot during attach still waits for the first machine profile", async () => {
	const { RunnerLink } = await import("../server/src/sandbox/runner-layer.js");
	let release!: () => void;
	const wait = new Promise<void>(resolve => { release = resolve; });
	const link = new RunnerLink({ ...identity, sessionId: "s_test" }, {
		facts: async () => {
			await wait;
			return { status: "online", name: "Fixture", publicKey: "", report: null };
		},
		attach: async () => ({ ok: false, reason: "offline" }),
		removeSandbox: async () => {},
	}, () => {});
	const attach = link.ready().catch(() => {});
	try {
		let settled = false;
		const snapshot = link.snapshotFacts().then(() => { settled = true; });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, false, "snapshot returned without its profile");
		release();
		await snapshot;
		assert.equal(link.known?.name, "Fixture");
	} finally { release(); link.close(); await attach; }
});
