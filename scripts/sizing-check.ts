// cd server && ../scripts/locked.sh sizing-check.ts [docker]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { DockerSandboxes } from "../server/src/sandbox/sandboxes.js";
import { writeProofDocker } from "./runner-proof-docker.js";
import { IMAGE } from "../server/src/sandbox/docker.js";
import { weightedFifo } from "./machine-fairness-check.js";

const GiB = 2 ** 30;
const capacity = (max: number, cpus: number, memory: number, pids: number) => ({
	max, unit: { cpus, memoryBytes: memory * GiB, pids }, reserve: { cpus: 0, memoryBytes: 0 },
});
for (const [cores, memory, max, cpu, ram, pids] of [
	[2, 12, 2, 1, 1.5, 512], [4, 8, 2, 2, 3.25, 1024], [8, 32, 3, 2, 8, 1024], [32, 128, 14, 2, 8, 1024],
]) test(`${cores} cores, ${memory} GiB`, async () => {
	const { sizeMachine } = await import("../runner/src/sizing.js");
	const actual = sizeMachine({ cores, memoryBytes: memory * GiB }, {});
	assert.deepEqual(actual.unit, capacity(max, cpu, ram, pids).unit);
	assert.equal(actual.max, max);
	assert.deepEqual(actual.reserve, { cpus: cores <= 2 ? 0 : Math.ceil(cores / 8),
		memoryBytes: cores <= 2 ? 0 : Math.ceil(Math.max(GiB, memory * GiB / 10) + GiB / 2) });
	assert(actual.unit.memoryBytes * max <= memory * GiB - actual.reserve.memoryBytes);
});

test("overrides and refusals", async () => {
	const { sizeMachine, sizingFlags } = await import("../runner/src/sizing.js");
	const size = (flags: Parameters<typeof sizingFlags>[0], env?: string) => sizeMachine({ cores: 32, memoryBytes: 128 * GiB }, sizingFlags(flags, env));
	const custom = size({ "slot-cpus": "4", "slot-memory": "12g" });
	assert.equal(custom.max, 7);
	assert.equal(custom.unit.memoryBytes * custom.max, 84 * GiB);
	assert.throws(() => size({ slots: "20", "slot-memory": "8g" }), /--slots.*--slot-memory.*--sandbox-memory/);
	assert.equal(size({ "max-turns": "3" }).max, 3);
	assert.deepEqual(size({ "max-turns": "3" }).unit, capacity(3, 2, 8, 1024).unit);
	assert.equal(size({ "slot-cpus": "3" }, "2").unit.cpus, 3);
	assert.equal(size({}, "4").unit.cpus, 4);
	assert.equal(size({ "sandbox-memory": "28g" }).unit.memoryBytes, 2 * GiB);
	for (const slots of ["0", "65", "1.5"]) assert.throws(() => size({ slots }), /--slots/);
	assert.throws(() => size({ "slot-cpus": "33" }), /--slot-cpus/);
	assert.throws(() => size({ "slot-memory": "768m" }), /--slot-memory/);
});

test("weighted FIFO across runner reconnect and legacy table migration", () => weightedFifo(capacity(3, 2, 8, 1024)));

// The stand-in substitutes a private Docker name at the CLI boundary. No session or
// harness names reach the daemon, and privateData avoids creating a shared volume.
if (process.argv.includes("docker")) test("create, inspect and reconnect on this Docker daemon", async t => {
	const dir = mkdtempSync(join(tmpdir(), "sizing-proof-"));
	const prefix = dir.split("/").pop()!;
	const path = process.env.PATH!;
	const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, PATH: path } }).trim();
	await writeProofDocker(dir, prefix + "-", execFileSync("which", ["docker"], { encoding: "utf8" }).trim());
	process.env.PATH = dir + delimiter + path;
	const uid = "sizing_owner";
	const input = { uid, profile: "docker-hardened" as const, sessionId: "sizing_session", privateData: true };
	const options = { machine: prefix, image: IMAGE, dataVolume: async () => { throw new Error("unexpected volume"); } };
	const provider = (slots: ReturnType<typeof capacity>) => new DockerSandboxes({ ...options, slots });
	const inspect = (id: string) => {
		const [{ HostConfig: h, Config }] = JSON.parse(docker(["inspect", prefix + "-agent-" + id]));
		return { limits: [h.NanoCpus, h.Memory, h.MemorySwap, h.PidsLimit, h.CpuShares], size: Config.Labels["dev.windlass-platform.slots"] };
	};
	try {
		await t.test("case 1: two-core regression and slot label", async () => {
			const id = await provider(capacity(2, 1, 1.5, 512)).create(input);
			const { limits, size } = inspect(id);
			console.log("case 1 docker inspect", JSON.stringify(limits));
			assert.deepEqual(limits, [1e9, 1.5 * GiB, 1.5 * GiB, 512, 256]);
			assert.equal(size, "1");
		});
		await t.test("case 7: old sandbox adopts new memory, swap and pids", async () => {
			const id = await new DockerSandboxes(options).create(input);
			assert.equal(inspect(id).limits[1], 1.5 * GiB);
			assert.ok(await provider(capacity(3, 1, 2, 1024)).connect(id));
			assert.deepEqual(inspect(id).limits, [1e9, 2 * GiB, 2 * GiB, 1024, 256]);
		});
		await t.test("over-limit memory is deferred without killing the workload and applies after stop", async () => {
			const id = await provider(capacity(2, 1, 1.5, 512)).create(input);
			const name = prefix + "-agent-" + id;
			// Exercise the same cgroup transition at MiB scale on the test host.
			docker(["exec", "-d", name, "node", "-e", "globalThis.b=Buffer.alloc(96*1024*1024,123); require('fs').writeFileSync('/tmp/allocated','1'); setInterval(()=>{},60000)"]);
			docker(["exec", name, "sh", "-ec", "for i in 1 2 3 4 5; do test ! -f /tmp/allocated || exit 0; sleep 1; done; exit 1"]);
			const resized = provider(capacity(2, 0.5, 0.0625, 256));
			assert.equal((await resized.connect(id))?.resizePending, true);
			assert.deepEqual(inspect(id).limits, [1e9, 1.5 * GiB, 1.5 * GiB, 512, 256]);
			assert.equal(docker(["inspect", "--format", "{{.State.Running}} {{.State.Paused}} {{.State.OOMKilled}}", name]), "true false false");
			docker(["stop", "-t", "1", name]);
			assert.equal((await resized.connect(id))?.resizePending, false);
			assert.deepEqual(inspect(id).limits, [0.5e9, 64 * 2 ** 20, 64 * 2 ** 20, 256, 256]);
		});
		await t.test("multi-slot limits on a size-two sandbox", async () => {
			const id = await provider(capacity(3, 0.75, 2, 512)).create({ ...input, size: 2 });
			assert.deepEqual(inspect(id), { limits: [1.5e9, 4 * GiB, 4 * GiB, 1024, 256], size: "2" });
		});
	} finally {
		process.env.PATH = path;
		for (const name of docker(["ps", "-a", "--filter", "name=^/" + prefix + "-", "--format", "{{.Names}}"]).split("\n"))
			if (name.startsWith(prefix + "-")) docker(["rm", "-fv", name]);
		rmSync(dir, { recursive: true, force: true });
	}
});
