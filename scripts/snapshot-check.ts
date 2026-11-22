// Run with tsx from server/. --docker adds the real Docker index and isolation checks.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { canReuseSnapshot, canSaveSnapshot, dependencyHash, digest, snapshotPrompt, type TreeEntry } from "../server/src/sandbox/snapshot-key.js";
import { attemptLabel, candidateLabel, DockerSnapshots, evictions, snapshotLimits, sourceFromLabels } from "../server/src/sandbox/snapshots.js";
import { DATA_DIR, docker, LABEL } from "../server/src/sandbox/docker.js";
import { imageId } from "./check-image.js";

const blob = (path: string, byte: string): TreeEntry => ({ path, type: "blob", mode: "100644", sha: byte.repeat(40) });
const files = [blob("package.json", "a"), blob("pkg/go.sum", "b"), blob(".nvmrc", "c")];
const hash = (tree: TreeEntry[], manifest = { engines: { node: "22" } }) => dependencyHash(tree, async () => JSON.stringify(manifest));
const expected = await hash(files);
assert.equal(await hash(files.slice().reverse()), expected);
assert.equal(await hash([...files, blob("src/index.ts", "d")]), expected);
assert.notEqual(await hash([files[0], blob("pkg/go.sum", "e"), files[2]]), expected);
assert.notEqual(await hash(files, { engines: { node: "24" } }), expected);
const workspace = [blob("packages/lib/package.json", "d")];
const nested = (field: string, version: string) => dependencyHash(workspace, async () => JSON.stringify({name: field, packageManager: version}));
assert.equal(await nested("A", "pnpm@9"), await nested("B", "pnpm@9"));
assert.notEqual(await nested("A", "pnpm@9"), await nested("A", "pnpm@10"));
await assert.rejects(hash([{ ...files[0], mode: "120000" }]));
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
console.log("PASS dependency key, writer and secret policy, first-prompt notice, user and machine eviction, expiry");

if (process.argv.includes("--docker")) {
	const base = await imageId(), machine = "proof" + randomBytes(8).toString("hex");
	const cache = new DockerSnapshots(machine, base), uid = "userA", profile = "docker-hardened";
	const source = { attempt: randomBytes(16).toString("hex"), repo: "123", generation: digest(["settings"]), inputs: digest([expected, "npm ci"]), commit, created: Date.now() };
	const other = { ...source, inputs: digest([expected, "npm ci --offline"]) };
	const container = "snapshot-check-" + machine, volume = container + "-data", consumer = container + "-read";
	const checked = async (...args: string[]) => (await docker(args, { check: true })).stdout.trim();
	try {
		const selected = await cache.select(source, uid, profile);
		assert.equal(selected.hit, false);
		await checked("run", "-d", "--pull", "never", "--name", container, "--user", "agent", "--cap-drop", "ALL",
			"--label", LABEL+".uid="+uid, "--label", LABEL+".machine="+machine, "--label", LABEL+".session=producer", "--label", LABEL+".profile="+profile,
			"--label", attemptLabel+"="+source.attempt, "--label", candidateLabel+"="+selected.key, "-v", volume+":"+DATA_DIR, base);
		await checked("exec", container, "sh", "-c", "touch /workspace/installed && echo data-only > "+DATA_DIR+"/volume-secret");
		const noSpace = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, free: Number.MAX_SAFE_INTEGER });
		assert.equal(await noSpace.save(container, uid, profile, source), false);
		assert.equal(await cache.save(container, uid, profile, { ...source, attempt: randomBytes(16).toString("hex") }), false);
		assert.equal(await cache.save(container, uid, profile, source), true);
		await checked("exec", container, "touch", "/workspace/after-turn");
		for (const mismatch of [
			await new DockerSnapshots(machine, base, undefined, undefined, true).select(source, uid, profile),
			await cache.select(source, "userB", profile), await cache.select(other, uid, profile),
			await cache.select({ ...source, generation: digest(["edited"]) }, uid, profile),
			await cache.select({ ...source, repo: "321" }, uid, profile), await cache.select(source, uid, "docker-windlass-sandbox"),
		]) assert.equal(mismatch.hit, false);
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
		await checked("exec", consumer, "sh", "-c", "test -f /workspace/installed && test ! -e /workspace/after-turn && test ! -e "+DATA_DIR+"/volume-secret");
		await checked("rm", "-fv", consumer);
		const tiny = new DockerSnapshots(machine, base, undefined, { ...snapshotLimits, user: 1 });
		assert.equal((await tiny.select(source, uid, profile)).hit, false);
		assert.equal((await cache.select(source, uid, profile)).hit, false);
		console.log("PASS Docker commit, fresh config, pre-turn contents, data volume exclusion, matching and isolation, free-space refusal and actual quota removal");
	} finally {
		await docker(["rm", "-fv", container, consumer]);
		await cache.drop(uid);
		await docker(["volume", "rm", volume]);
	}
}
