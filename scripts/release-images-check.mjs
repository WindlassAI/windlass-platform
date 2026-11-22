import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyRelease } from "./release-check.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = join(root, ".github/workflows/release-images.yml");
const licenseLabel = "org.opencontainers.image.licenses=" + JSON.parse(readFileSync(join(root, "package.json"))).license;
const node = (file, ...args) => execFileSync(process.execPath, [join(root,file), ...args], {encoding:"utf8", stdio:"pipe"});
const pin = "sha256:" + "1".repeat(64);
const ref = "ghcr.io/windlassai/windlass-platform-sandbox@" + pin;
function scratch(t) {
	const dir = mkdtempSync(join(tmpdir(), "release-check-"));
	t.after(() => rmSync(dir, {recursive:true, force:true}));
	return dir;
}
test("release permissions and immutable action references", t => {
	const dir = scratch(t), source = readFileSync(workflow,"utf8");
	node("scripts/workflow-lint.ts", workflow);
	assert.ok(source.split("\n").some(line => line.trim() === licenseLabel));
	for (const [file, pattern, replacement, reason] of [
		["action", /actions\/checkout@[a-f0-9]{40}/, "actions/checkout@v7", /Unpinned action/],
		["scope", /permissions:\n  contents: read/, "permissions:\n  contents: write", /workflow scope/],
		["token", /permissions: &package-write\n/, "permissions: &package-write\n      id-token: write\n", /Unexpected permission/],
		["package", /  plan:\n/, "  plan:\n    permissions: {packages: write}\n", /Unexpected permission/],
	]) {
		const fixture = join(dir, file+".yml");
		writeFileSync(fixture, source.replace(pattern,replacement));
		assert.throws(() => node("scripts/workflow-lint.ts",fixture), reason);
	}
});
test("release scan rejects embedded material and source maps", t => {
	const file = join(scratch(t), "runner.cjs");
	for (const marker of ["/home/", "@gmail", "-----BEGIN", "WLP_SECRET", "onrivet", "sourceMappingURL="]) {
		writeFileSync(file, "/* " + marker + " */");
		assert.throws(() => node("scripts/release-check.ts","scan",file), /bundle contains/);
	}
	writeFileSync(file, ""); writeFileSync(file+".map", "{}");
	assert.throws(() => node("scripts/release-check.ts","scan",file), /has a source map/);
});
test("context-only and registry-pin builds do not resolve mutable local tags", t => {
	const dir = scratch(t), docker = join(dir,"docker"), trace = join(dir,"trace");
	writeFileSync(docker, '#!/bin/sh\necho "$*" >> "$TRACE"\n', {mode:0o755});
	const env = {...process.env, PATH:dir+":"+process.env.PATH, TRACE:trace, WINDLASS_BINARY:process.execPath};
	for (const variant of ["base","shots"]) {
		const context = join(dir,variant);
		execFileSync(join(root,"sandbox/build.sh"),["--context",context],{env:{...env,WLP_SANDBOX_VARIANT:variant}});
		assert.deepEqual(readFileSync(join(context, "Dockerfile")), readFileSync(join(root, "sandbox/Dockerfile")));
		assert.deepEqual(readdirSync(context).sort(), ["Dockerfile","windlass","wlp-run",...(variant === "shots" ? ["wlp-shot"] : [])]);
	}
	assert.throws(() => readFileSync(trace), {code:"ENOENT"});
	const refuse = spawnSync(join(root,"scripts/runner-build.sh"),[pin],{encoding:"utf8",env:{...env,WLP_RUNNER_PUSH:"ghcr.io/windlassai/windlass-runner:fixture"}});
	assert.notEqual(refuse.status,0);
	assert.match(refuse.stderr,/requires a registry sandbox pin/);
	assert.throws(() => readFileSync(trace), {code:"ENOENT"});
	execFileSync(join(root,"sandbox/harness/build.sh"),["opencode",ref], {env});
	const calls = readFileSync(trace,"utf8").trim().split("\n");
	assert.match(calls[0],new RegExp("--build-arg SANDBOX_IMAGE="+ref+" "));
	assert.equal(calls.length,2);
});
test("the release gate compares each embedded pin and verifies all six indexes", t => {
	const dir = scratch(t), bundle = join(dir,"runner.cjs");
	const version = "0.1.0";
	const release = {version,commit:"a".repeat(40),windlass:"v0.5.0",signer:"https://github.com/WindlassAI/windlass-platform/.github/workflows/release-images.yml@refs/tags/runner-v"+version,images:{}};
	for (const role of ["runner","sandbox","sandbox-shots","claude","opencode","codex"]) {
		const name = role === "runner" ? "windlass-runner" : "windlass-platform-"+role;
		release.images[role] = {ref:"ghcr.io/windlassai/"+name, index:pin, platforms:{"linux/amd64":pin,"linux/arm64":pin}};
	}
	Object.assign(release.images.claude, {adapter:"0.109.0", cli:"2.1.328"});
	Object.assign(release.images.codex, {adapter:"2.9.0", cli:"0.171.0"});
	release.images.opencode.version = "1.19.6";
	const image = role => release.images[role].ref+"@"+pin;
	// Drive the publication entry point. The Buildx stand-in writes only its local
	// metadata file, just as a successful multi-platform push would.
	const trace = join(dir, "build-args.json");
	writeFileSync(join(dir, "package.json"), JSON.stringify({type:"commonjs"}));
	writeFileSync(join(dir,"docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "buildx" || args[1] !== "build") process.exit(2);
fs.writeFileSync(process.env.TRACE, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf("--metadata-file")+1], JSON.stringify({"containerimage.digest":${JSON.stringify(pin)}}));
`, {mode:0o755});
	const tag = release.images.runner.ref + ":runner-v" + version;
	const result = execFileSync(join(root,"scripts/runner-build.sh"),["--screenshots",image("sandbox"),image("sandbox-shots")], {
		encoding:"utf8", env:{...process.env,PATH:dir+":"+process.env.PATH,TRACE:trace,WLP_RUNNER_PUSH:tag,WLP_RUNNER_RELEASE_DIR:dir,
			WLP_RUNNER_HARNESSES:"claude="+image("claude")+" opencode="+image("opencode")+" codex="+image("codex")},
	});
	assert.equal(result.trim(),pin);
	const args = JSON.parse(readFileSync(trace));
	assert.equal(args[args.indexOf("--platform")+1],"linux/amd64,linux/arm64");
	assert.ok(args.includes("--push") && args.includes("--sbom=true") && args.includes("mode=max"));
	assert.ok(args.includes(licenseLabel) && args.includes("index:"+licenseLabel));
	const tags = args.flatMap((arg,i) => arg === "--tag" ? [args[i+1]] : []);
	assert.equal(tags[0],tag);
	assert.match(tags[1],/^ghcr\.io\/windlassai\/windlass-runner:sha-[0-9a-f]{12}$/);
	node("scripts/release-check.ts","scan",bundle);
	const checked=[];
	verifyRelease(release,bundle,(ref,identity) => { assert.equal(identity,release.signer); checked.push(ref); });
	assert.equal(new Set(checked).size,6);
	const missing=structuredClone(release);
	delete missing.images["sandbox-shots"];
	assert.throws(() => verifyRelease(missing,bundle,assert.fail),/Missing or invalid sandbox-shots index/);
	const mismatch=structuredClone(release);
	mismatch.images.codex.index="sha256:"+"2".repeat(64);
	assert.throws(() => verifyRelease(mismatch,bundle,()=>{}),/codex bundle pin does not match/);
	assert.throws(() => verifyRelease(release,bundle,ref=>{ if (ref === image("codex")) throw Error("unsigned"); }),/Could not verify codex index/);
});
