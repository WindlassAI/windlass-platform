// Run with tsx from server/. --docker adds the real Docker index and isolation checks.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDeployment } from "../server/src/sandbox/snapshot-deployment.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { canReuseSnapshot, canSaveSnapshot, dependencyHash, digest, snapshotPrompt, type TreeEntry } from "../server/src/sandbox/snapshot-key.js";
import { attemptLabel, candidateLabel, DockerSnapshots, evictions, relieveDiskPressure, snapshotLimits, sourceFromLabels } from "../server/src/sandbox/snapshots.js";
import { DATA_DIR, docker, LABEL } from "../server/src/sandbox/docker.js";
import { imageId } from "./check-image.js";

const docs = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8").split("## Docker setup snapshots")[1];
assert.match(docs, /local fixture repository/);
const blob = (path: string, byte: string): TreeEntry => ({ path, type: "blob", mode: "100644", sha: byte.repeat(40) });
const files = [blob("package.json", "a"), blob("pkg/go.sum", "b"), blob(".nvmrc", "c")];
const hash = (tree: TreeEntry[]) => dependencyHash(tree);
const expected = await hash(files);
assert.ok(expected);
assert.equal(await hash(files.slice().reverse()), expected);
assert.equal(await hash([...files, blob("src/index.ts", "d")]), expected);
for (const path of ["package.json", "packages/lib/package.json", "Gemfile.lock", "composer.lock", "Pipfile.lock",
	"poetry.lock", "pyproject.toml", "requirements-dev.txt", "flake.lock", "mix.lock", "go.sum", "Cargo.lock",
	"package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "uv.lock"]) {
	const tree = [blob("anchor/yarn.lock", "a")];
	assert.notEqual(await hash([...tree, blob(path, "b")]), await hash([...tree, blob(path, "c")]), path);
}
for (const tree of [[], [files[0]], [files[0], files[2], blob(".tool-versions", "d")]]) assert.equal(await hash(tree), null);
assert.throws(() => hash([files[1], { ...files[0], mode: "120000" }]));
assert.equal(canReuseSnapshot(true, "windlass", 0), true);
assert.equal(canReuseSnapshot(true, "windlass", 1), false);
assert.equal(canReuseSnapshot(false, "windlass", 0), false);
assert.equal(canReuseSnapshot(true, "claude", 0), false);
assert.equal(canSaveSnapshot(undefined, 0, true, 30000), true);
for (const eligible of [canSaveSnapshot(undefined, 1, true, 30000), canSaveSnapshot({role:"builder",owns:[]}, 0, true, 30000),
	canSaveSnapshot({role:"reviewer"}, 0, true, 30000), canSaveSnapshot(undefined, 0, false, 30000), canSaveSnapshot(undefined, 0, true, 29999)]) assert.equal(eligible, false);
const commit = "a".repeat(40);
assert.match(snapshotPrompt(commit), new RegExp(commit + ".*Rebuild"));
const rows = [{ uid: "A", bytes: 3, used: 1 }, { uid: "B", bytes: 6, used: 2 }, { uid: "A", bytes: 6, used: 3 }];
assert.deepEqual(evictions(rows, 4, { machine: 12, user: 8, free: 0 }), [rows[0]]);
assert.deepEqual(evictions(rows, 4, { machine: 10, user: 10, free: 0 }), rows.slice(0, 2));
assert.deepEqual(evictions(rows, 15 * 86400000), rows);
assert.deepEqual(evictions([rows[2]], 4, { machine: 20, user: 8, free: 0 }, [rows[0]]), [rows[2]], "pinned layers count toward the user cap");
const retired: number[] = [], readings = [0, 0, 15];
assert.equal(await relieveDiskPressure([...rows].reverse(), 15, async () => readings.shift()!, async row => { retired.push(row.used); }), true);
assert.deepEqual(retired, [1, 2]);
console.log("PASS dependency key, writer and secret policy, first-prompt notice, user and machine eviction, expiry");

if (process.argv.includes("--docker")) {
	const base = await imageId(), machine = "m_" + randomBytes(8).toString("hex");
	const cache = new DockerSnapshots(machine, base), uid = "userA", profile = "docker-hardened";
	const directory = mkdtempSync(join(tmpdir(), "snapshot-proof-"));
	assert.equal(snapshotDeployment(directory, false), undefined);
	const deployment = snapshotDeployment(directory);
	assert.ok(deployment);
	assert.equal(snapshotDeployment(directory), deployment);
	assert.notEqual(snapshotDeployment(join(directory, "other")), deployment);
	const source = { attempt: randomBytes(16).toString("hex"), repo: "123", generation: digest(["settings"]), inputs: digest([expected, "npm ci"]), commit, created: Date.now() };
	const other = { ...source, inputs: digest([expected, "npm ci --offline"]) };
	const container = "snapshot-check-" + machine, volume = container + "-data", consumer = container + "-read";
	const checked = async (...args: string[]) => (await docker(args, { check: true })).stdout.trim();
	const producer = async (name: string, request: typeof source) => {
		const selected = await cache.select(request, uid, profile);
		assert.equal(selected.hit, false);
		await checked("run", "-d", "--pull", "never", "--name", name, "--user", "agent", "--cap-drop", "ALL",
			"--label", LABEL+".uid="+uid, "--label", LABEL+".machine="+machine, "--label", LABEL+".session=producer", "--label", LABEL+".profile="+profile,
			"--label", attemptLabel+"="+request.attempt, "--label", candidateLabel+"="+selected.key, "-v", volume+":"+DATA_DIR, base);
		return selected;
	};
	const bigBox = container + "-large", alias = container + ":alias";
	try {
		const selected = await producer(container, source);
		await checked("exec", container, "sh", "-c", "touch /workspace/installed && echo data-only > "+DATA_DIR+"/volume-secret");
		const noSpace = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, free: Number.MAX_SAFE_INTEGER });
		assert.equal(await noSpace.save(container, uid, profile, source), false);
		assert.equal(await cache.save(container, uid, profile, { ...source, attempt: randomBytes(16).toString("hex") }), false);
		await checked("exec", "--user", "65534", container, "mkdir", "/tmp/wlp-transport-fixture");
		await checked("exec", container, "touch", "/tmp/wlp-stage-fixture");
		assert.equal(await cache.save(container, uid, profile, source), true);
		await checked("exec", container, "touch", "/workspace/after-turn");
		for (const mismatch of [
			await new DockerSnapshots(machine, base, undefined, undefined, true).select(source, uid, profile),
			await cache.select(source, "userB", profile), await cache.select(other, uid, profile),
			await cache.select({ ...source, generation: digest(["edited"]) }, uid, profile),
			await cache.select({ ...source, repo: "321" }, uid, profile), await cache.select(source, uid, "docker-windlass-sandbox"),
		]) assert.equal(mismatch.hit, false);
		assert.equal(await cache.has(uid, source.repo), true);
		const isolated = new DockerSnapshots(machine, base, undefined, undefined, false, deployment);
		const isolatedSelection = await isolated.select(source, uid, profile);
		assert.notEqual(isolatedSelection.key, selected.key);
		assert.equal(isolatedSelection.hit, false);
		const unknown = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, user: 1, free: Number.MAX_SAFE_INTEGER });
		await unknown.sweepOwners(async () => null);
		assert.equal(await cache.has(uid, source.repo), true, "unknown owner lost its snapshot");
		const hit = await cache.select(source, uid, profile);
		assert.equal(hit.hit, true);
		assert.equal((await new DockerSnapshots(machine, hit.image).select(source, uid, profile)).hit, false);
		await checked("run", "-d", "--pull", "never", "--name", consumer, "--label", LABEL+".session=consumer", "--label", attemptLabel+"="+source.attempt, hit.image);
		const [a] = JSON.parse(await checked("container", "inspect", consumer));
		const [b] = JSON.parse(await checked("image", "inspect", base));
		assert.deepEqual(a.Config.Env, b.Config.Env);
		assert.equal(a.Config.Labels[LABEL+".session"], "consumer");
		assert.equal(Object.values(a.Config.Labels).includes("producer"), false);
		assert.deepEqual(sourceFromLabels(a.Config.Labels), source);
		await checked("exec", consumer, "sh", "-c", "test ! -e /tmp/wlp-transport-fixture && test ! -e /tmp/wlp-stage-fixture && test -f /workspace/installed && test ! -e /workspace/after-turn && test ! -e "+DATA_DIR+"/volume-secret");
		// A candidate estimated between 1x and 2x writable bytes must leave the existing
		// image alone. Once refused it remains refused even after the writable layer shrinks.
		const large = { ...source, repo: "456", attempt: randomBytes(16).toString("hex") };
		await producer(bigBox, large);
		await checked("exec", bigBox, "sh", "-c", "head -c 4194304 /dev/urandom > /workspace/large");
		const size = Number(await checked("container", "inspect", "--size", "--format", "{{.SizeRw}}", bigBox));
		const limited = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, user: Math.ceil(size * 1.5) });
		assert.equal(await limited.save(bigBox, uid, profile, large), false);
		assert.equal(await cache.has(uid, source.repo), true, "oversize save evicted the previous image");
		await checked("exec", bigBox, "rm", "/workspace/large");
		assert.equal(await cache.save(bigBox, uid, profile, large), false, "refused key retried");

		await noSpace.sweep(uid);
		assert.equal(await cache.has(uid, source.repo), false, "disk pressure left the image available");
		const held = await checked("image", "inspect", "--format", "{{json .RepoTags}}", hit.image);
		assert.match(held, /:held-/, "in-use layers lost their accounting tag");
		await checked("rm", "-fv", consumer);
		assert.equal(await noSpace.save(container, uid, profile, source), false);
		assert.notEqual((await docker(["image", "inspect", hit.image])).code, 0, "pre-commit pressure retained released layers");
		await cache.drop(uid);
		assert.equal(await cache.save(container, uid, profile, source), true);

		process.env.WLP_RUNNER_STATE_DIR = directory;
		Object.assign(globalThis, { SANDBOX_IMAGE: base, SHOTS_IMAGE_PIN: "" });
		const { storePair } = await import("../runner/src/state.js");
		const { snapshotMaintenance } = await import("../runner/src/snapshot-retention.js");
		const platform = "https://fixture.invalid", key = generateKeyPairSync("ed25519").privateKey;
		const current = { uid: "newOwner", machineId: "m_" + randomBytes(8).toString("hex") };
		storePair({ uid, machineId: machine }, key, platform);
		storePair(current, key, platform);
		const last = await cache.select(source, uid, profile);
		assert.equal(last.hit, true);
		await checked("tag", last.image, alias);
		await checked("run", "-d", "--pull", "never", "--name", consumer, last.image);
		await snapshotMaintenance(current, key, platform, null)(Date.now());
		assert.equal(await cache.has(uid, source.repo), false, "re-pairing retained the previous owner's snapshot");
		assert.equal(await checked("image", "inspect", "--format", "{{.Id}}", alias), last.image, "removed a tag outside the index");
		// Replacing the tags leaves a pinned image with no repository name, as on older runners.
		const tags: string[] = JSON.parse(await checked("image", "inspect", "--format", "{{json .RepoTags}}", last.image));
		const heldTag = tags.find(tag => tag.includes(":held-"));
		assert.ok(heldTag);
		await checked("image", "rm", heldTag);
		await checked("tag", base, alias);
		const owners: string[] = [];
		await cache.sweepOwners(async owner => { owners.push(owner); return null; });
		assert.deepEqual(owners, [uid], "the untagged image disappeared from accounting");
		await checked("rm", "-fv", consumer);
		await cache.sweep(uid);
		assert.notEqual((await docker(["image", "inspect", last.image])).code, 0, "released untagged layer survived the sweep");
		console.log("PASS Docker admission, refusal memory, deployment isolation, unknown owners, transport cleanup, disk pressure, pinned layers and re-pairing");
	} finally {
		await docker(["rm", "-fv", container, consumer, bigBox]);
		await cache.drop(uid);
		await docker(["image", "rm", alias]);
		await docker(["volume", "rm", volume]);
		rmSync(directory, { recursive: true, force: true });
	}
}
