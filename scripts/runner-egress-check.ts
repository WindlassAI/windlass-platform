// Fast regressions, run from server with tsx ../scripts/runner-egress-check.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLONE_GIT_START, cloneScript } from "../server/src/github/git.js";
import { parseRunnerFrame } from "../server/src/runner/control.js";
import { machineProfiles } from "../server/src/machines/profiles.js";

const report = { kind: "report", docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: null, sandboxes: [] } as const;
test("the wire accepts each egress mode and older reports", () => {
	for (const egress of [undefined, "open", "restricted", "none"]) assert.ok(parseRunnerFrame(JSON.stringify({ ...report, egress, name: "Test machine", claudeRelay: true })), String(egress));
	assert.ok(parseRunnerFrame(JSON.stringify(report)));
	assert.equal(parseRunnerFrame(JSON.stringify({ ...report, egress: "other" })), null);
});
test("machine profiles describe command networking separately from model networking", () => {
	for (const mode of ["restricted", "none", "open"] as const) {
		const [inner, hardened] = machineProfiles("fixture", { ...report, sandboxes: [], egress: mode });
		assert.equal(inner.commandNetwork, false);
		assert.equal(hardened.commandNetwork, mode !== "none");
		assert.match(hardened.commandNetworkText!, mode === "restricted" ? /public/ : mode === "none" ? /no network/ : /local network/);
	}
});
test("new pairing, migration, persisted opt-in and invalid owner flags", async () => {
	const dir = mkdtempSync(join(tmpdir(), "egress-state-"));
	process.env.WLP_RUNNER_STATE_DIR = dir;
	try {
		const state = await import("../runner/src/state.js");
		const policy = await import("../runner/src/egress-policy.js");
		const identity = { machineId: "m_0000000000000001", uid: "u_test" };
		state.storePair(identity, generateKeyPairSync("ed25519").privateKey, "https://example.com");
		assert.equal(state.pairingEgress(identity.machineId).mode, "restricted");
		const legacy = "m_0000000000000002";
		assert.equal(state.pairingEgress(legacy).mode, "open");
		assert.match(state.egressNote(legacy), /--egress restricted/);
		const requested = policy.egressFlags("restricted", "Mirror.Example,git.example");
		assert.deepEqual(requested, { mode: "restricted", allow: ["git.example", "mirror.example"] });
		state.pairingEgress(legacy, requested);
		assert.deepEqual(state.pairingEgress(legacy), requested);
		assert.doesNotMatch(state.egressNote(legacy), /--egress restricted/);
		for (const [mode, hosts] of [["bad", undefined], ["none", "host"], ["restricted", "*.lan"], ["restricted", "http://x/"]]) {
			assert.throws(() => policy.egressFlags(mode, hosts));
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test("proxy pins DNS results, fails closed on mixed answers, and scopes private exceptions", async () => {
	// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
	const { selectAddress } = await import("../runner/src/egress-proxy.mjs");
	const check = (ips: string[], allow: string[] = [], host = "mirror.example", local: string[] = []) =>
		selectAddress(host, allow, async () => ips.map(address => ({ address })), { eth0: local.map(address => ({ address })) });
	for (const ip of ["127.0.0.1", "0.0.0.0", "169.254.169.254", "169.254.1.2", "100.64.0.1", "10.0.0.1", "172.31.1.1", "192.168.1.1", "fc00::1", "fd00:ec2::254", "fe80::1", "::ffff:a00:1", "2002:a00:1::1"]) {
		await assert.rejects(check([ip]), /blocked/);
	}
	await assert.rejects(check(["1.1.1.1", "10.0.0.1"]), /blocked/);
	assert.equal(await check(["1.1.1.1"]), "1.1.1.1");
	assert.equal(await check(["10.0.0.1"], ["mirror.example"]), "10.0.0.1");
	await assert.rejects(check(["169.254.169.254"], ["mirror.example"]), /blocked/);
	await assert.rejects(check(["8.8.8.8"], [], "mirror.example", ["8.8.8.8"]), /blocked/);
});
test("both harness providers construct the same runner-owned network configuration", async () => {
	Object.assign(globalThis, { SANDBOX_IMAGE: "fixture", SHOTS_IMAGE_PIN: "", HARNESS_IMAGES: { claude: "fixture" } });
	const { Executor } = await import("../runner/src/docker-executor.js");
	for (const mode of ["restricted", "none", "open"] as const) {
		const owner = new Executor({ uid: "u_fixture", machineId: "m_fixture" }, {}, false, true, ["docker-hardened"], { mode, allow: [] });
		const frame = { ...owner.report(), name: "Build runner" };
		assert.equal(frame.egress, mode);
		assert.equal(frame.claudeRelay, true);
		assert.ok(frame.host && frame.host.cpus > 0 && frame.host.memoryBytes > 0);
		assert.deepEqual(parseRunnerFrame(JSON.stringify(frame)), frame);
		const { host, ...beforeCapacity } = frame;
		assert.deepEqual(parseRunnerFrame(JSON.stringify(beforeCapacity)), beforeCapacity);
		const flags = owner.network.sandboxNetwork();
		assert.equal(flags.name, mode === "open" ? "wlp-open-m_fixture" : "none");
		for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
			assert.equal(flags.env[key], mode === "restricted" ? "http://127.0.0.1:17891" : undefined);
		assert.equal(flags.env.NO_PROXY, mode === "restricted" ? "localhost,127.0.0.1,::1" : undefined);
	}
});
test("restoring a kept restricted session prepares the current helper image pin", async () => {
	const { Executor } = await import("../runner/src/docker-executor.js");
	const dir = mkdtempSync(join(tmpdir(), "egress-upgrade-"));
	const path = process.env.PATH;
	try {
		writeFileSync(join(dir, "docker"), '#!/bin/sh\nif [ "$1" = container ]; then echo "No such container" >&2; fi\nexit 1\n', { mode: 0o700 });
		process.env.PATH = dir + ":" + path;
		const owner = new Executor({ uid: "u_test", machineId: "m_fixture" }, {}, false, false, ["docker-hardened"], { mode: "restricted", allow: [] });
		owner.ownedVolume = async () => true;
		const pulling = new Error("fetch current helper pin");
		owner.ensureImage = async () => { throw pulling; };
		await assert.rejects(owner.network.attach("0123456789ab", "fixture"), error => error === pulling);
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("both platform clone paths hand only the runner proxy to clean Git", () => {
	const dir = mkdtempSync(join(tmpdir(), "clean-git-"));
	try {
		// Inspect the clean environment at the point where the shell would exec Git.
		const inspect = `env() { local args=(); while [ "$1" != git ]; do args+=("$1"); shift; done; command env "\${args[@]}" /usr/bin/env; exit 72; }`;
		for (const script of [CLONE_GIT_START + "\ngit clone fixture", cloneScript("https://example.invalid/repo", "main", "repo")]) {
			for (const proxy of ["http://127.0.0.1:17891", "http://untrusted.invalid"]) {
				const result = spawnSync("bash", ["-ec", inspect + "\n" + script], {
					cwd: dir, input: "fixture-token\n", encoding: "utf8", env: { https_proxy: proxy, SECRET: "fixture-secret" },
				});
				assert.equal(result.status, 72, result.stderr);
				assert.doesNotMatch(result.stdout, /fixture-secret|fixture-token|untrusted/);
				if (proxy.includes("127.0.0.1")) assert.match(result.stdout, /^https_proxy=http:\/\/127\.0\.0\.1:17891$/m);
			}
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the restricted OpenCode broker refuses registry and login hosts before DNS, and retains repository egress", async () => {
	// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
	const { selectAddress } = await import("../runner/src/egress-proxy.mjs");
	const { providerHosts } = await import("../runner/src/opencode-providers.js");
	const check = (host: string, policy: string[]) => selectAddress(host, [], async () => [{address:"8.8.8.8"}], {}, policy);
	for (const host of ["OPENCODE.AI.","api.z.ai","open.bigmodel.cn","chatgpt.com","auth.openai.com","8.8.8.8"])
		await assert.rejects(check(host,providerHosts),/blocked/);
	assert.equal(await check("github.com",providerHosts),"8.8.8.8");
	assert.equal(await check("opencode.ai",[]),"8.8.8.8");
});
