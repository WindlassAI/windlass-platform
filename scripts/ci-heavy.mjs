#!/usr/bin/env node
// The heavy checks on CI, from scripts/ci-groups.json (docs/testing.md).
//
//   node scripts/ci-heavy.mjs select                    in Actions: the jobs this change needs, as outputs
//   node scripts/ci-heavy.mjs select --base <ref>       locally: what a push of HEAD would run
//   node scripts/ci-heavy.mjs select --files <path>...  locally: what a change to these files would run
//   node scripts/ci-heavy.mjs select --all
//   node scripts/ci-heavy.mjs run <group>[/<shard>]     runs a job's checks one after another
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const map = JSON.parse(readFileSync(join(root, "scripts/ci-groups.json"), "utf8"));
const env = process.env;

/** A glob of the map as a regular expression: `**` any directories, `*` within one, `{a,b}` either. */
function globRegex(glob) {
	let out = "",
		braces = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			i++;
			if (glob[i + 1] === "/") {
				i++;
				out += "(?:.*/)?";
			} else out += ".*";
		} else if (c === "*") out += "[^/]*";
		else if (c === "{") {
			braces++;
			out += "(?:";
		} else if (c === "}") {
			braces--;
			out += ")";
		} else if (c === "," && braces > 0) out += "|";
		else out += c.replace(/[.+?^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}
const matcher = globs => {
	const res = globs.map(globRegex);
	return path => res.some(re => re.test(path));
};
const isCore = matcher(map.core),
	isDocs = matcher(map.docs);
const groupMatchers = Object.entries(map.groups).map(([name, g]) => [name, matcher(g.paths)]);

/** What each job is called in the Actions UI. The job id stays the group/shard the select and run commands use. */
const TITLES = {
	rules: "Unit checks",
	actors: "Server: sign-in and sessions",
	"machines/machines": "Server: machines and item recovery",
	"machines/protocol": "Server: runner protocol and sessions",
	webhook: "GitHub webhooks",
	"factory/1": "Factory 1 of 4",
	"factory/2": "Factory 2 of 4",
	"factory/3": "Factory 3 of 4",
	"factory/4": "Factory 4 of 4",
	"factory/orchestration": "Factory orchestration",
	"sandbox-docker/1": "Docker sandbox 1 of 2",
	"sandbox-docker/2": "Docker sandbox 2 of 2",
	"sandbox-docker/mcp": "Docker sandbox: GitHub, MCP and relays",
	"shots-docker": "Docker screenshots",
	"e2e-docker/actors": "Docker end to end: sessions",
	"e2e-docker/snapshots": "Docker end to end: snapshots",
	"runner-docker/runner": "Runner: service and lifecycle",
	"runner-docker/outages": "Runner: network loss and laptop sleep",
	"runner-docker/suites": "Runner: focused suites and OpenCode",
	"runner-docker/harness": "Runner: Claude relay and egress",
	"codex-docker": "Codex image: sandbox, refusals and platform tools",
};
const harnessImages = ["claude", "opencode", "codex"];
const titleOf = job => TITLES[job] ?? job;

/** The jobs of a group: one, or one per shard. */
function jobsOf(name) {
	const g = map.groups[name];
	const shards = g.shards ? Object.entries(g.shards) : [[null, {}]];
	return shards.map(([shard, s]) => {
		const checks = s.only ?? Object.keys(g.checks);
		const job = shard ? `${name}/${shard}` : name;
		return {
			job,
			title: titleOf(job),
			checks: checks.join(" "),
			images: (s.images ?? g.images ?? []).join(" "),
			timeout: s.timeout ?? g.timeout,
			depth: (s.history ?? g.history) ? 0 : 1,
		};
	});
}

function selectFor(files) {
	const why = new Map();
	for (const file of files) {
		if (isDocs(file)) continue;
		if (isCore(file)) return { all: true, reason: `core file ${file}` };
		for (const [name, match] of groupMatchers)
			if (match(file)) {
				if (!why.has(name)) why.set(name, file);
			}
	}
	return { all: false, why };
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const changedSince = base => git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);

function select(argv) {
	let files = null,
		reason = "",
		all = false;
	if (argv.includes("--all")) {
		all = true;
		reason = "--all";
	} else if (argv.includes("--files")) files = argv.slice(argv.indexOf("--files") + 1);
	else if (argv.includes("--base")) {
		const base = git("merge-base", argv[argv.indexOf("--base") + 1], "HEAD");
		files = changedSince(base);
		reason = `changes since ${base.slice(0, 12)}`;
	} else {
		// In Actions. Main, the nightly run and a full dispatch run everything.
		const event = env.GITHUB_EVENT_NAME,
			ref = env.GITHUB_REF ?? "";
		if (event === "schedule" || ref === "refs/heads/main" || (event === "workflow_dispatch" && env.FULL === "true")) {
			all = true;
			reason =
				event === "schedule" ? "nightly" : ref === "refs/heads/main" && event === "push" ? "push to main" : "full run";
		} else {
			if (env.BASE_REF?.startsWith("-")) throw new Error(`not a ref: ${env.BASE_REF}`);
			const base =
				event === "pull_request" ? env.PR_BASE_SHA : git("merge-base", env.BASE_REF || "origin/main", "HEAD");
			files = changedSince(base);
			reason = `changes since ${base.slice(0, 12)}`;
		}
	}
	let picked = [];
	const lines = [];
	if (all) picked = Object.keys(map.groups);
	else {
		const result = selectFor(files);
		if (result.all) {
			picked = Object.keys(map.groups);
			reason = [reason, result.reason].filter(Boolean).join("; ");
		} else {
			picked = [...result.why.keys()];
			for (const [name, file] of result.why) lines.push(`- ${name}: ${file}`);
		}
		lines.unshift(`${files.length} changed file(s)`);
	}
	const jobs = picked.flatMap(jobsOf);
	const plain = jobs.filter(j => !j.images),
		docker = jobs.filter(j => j.images);
	// The harness images are built on base in the job that needs them (`run`): only base is made ahead.
	const builtInJob = i => harnessImages.includes(i);
	const images = [...new Set(docker.flatMap(j => j.images.split(" ")))].filter(i => !builtInJob(i));
	if (docker.some(j => j.images.split(" ").some(builtInJob)) && !images.includes("base")) images.push("base");
	const summary = [
		`### Heavy checks: ${jobs.length ? jobs.map(j => j.job).join(", ") : "none"}`,
		"",
		`Selected by ${reason || "the files given"}.`,
		...lines,
	].join("\n");
	console.log(summary);
	if (env.GITHUB_OUTPUT) {
		appendFileSync(
			env.GITHUB_OUTPUT,
			[
				`plain=${JSON.stringify({ include: plain })}`,
				`plain-any=${plain.length > 0}`,
				`docker=${JSON.stringify({ include: docker })}`,
				`docker-any=${docker.length > 0}`,
				`images=${JSON.stringify(images)}`,
				`images-any=${images.length > 0}`,
				"",
			].join("\n"),
		);
	}
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + "\n");
}

/** Runs one shell command in server/, its whole process group stopped at the deadline. */
function runOne(command, extraEnv, timeoutMs) {
	return new Promise(done => {
		const started = Date.now();
		const child = spawn("bash", ["-eo", "pipefail", "-c", command], {
			cwd: join(root, "server"),
			stdio: "inherit",
			detached: true,
			env: { ...env, ...extraEnv, PATH: `${join(root, "server/node_modules/.bin")}:${env.PATH}` },
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			done({
				ok: code === 0,
				seconds: Math.round((Date.now() - started) / 1000),
				code: timedOut ? "timed out" : (code ?? signal),
			});
		});
	});
}

const sh = command =>
	execFileSync("bash", ["-ec", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

async function run([job]) {
	const [name, shard] = job.split("/");
	const g = map.groups[name];
	if (!g) throw new Error(`no group ${name}`);
	const s = shard ? g.shards[shard] : {};
	const checks = s.only ?? Object.keys(g.checks);
	const images = s.images ?? g.images ?? [];
	const extra = { ...(s.env ?? {}) };
	// Windlass's released binary, for the checks that run `windlass` on the host.
	const windlassDir = sh("sandbox/fetch-windlass.sh");
	extra.WLP_WINDLASS_BIN = join(windlassDir, `windlass-linux-${process.arch === "arm64" ? "arm64" : "x64"}`);
	if (images.includes("base"))
		extra.WLP_CI_BASE_IMAGE = sh("docker image inspect --format '{{.Id}}' windlass-platform-sandbox:latest");
	for (const harness of harnessImages.filter(name => images.includes(name))) {
		const started = Date.now();
		extra[`WLP_CI_${harness.toUpperCase()}_IMAGE`] = sh(
			`WLP_HARNESS_TAG=ci sandbox/harness/build.sh ${harness} windlass-platform-sandbox:latest`,
		);
		console.log(`built the ${harness} harness image in ${Math.round((Date.now() - started) / 1000)} s`);
	}
	const results = [];
	for (const check of checks) {
		const command = g.checks[check] + (s.args ? ` ${s.args}` : "");
		console.log(`::group::${check}: ${command}`);
		const result = await runOne(command, extra, (s.timeout ?? g.timeout) * 60_000);
		console.log("::endgroup::");
		console.log(
			`${result.ok ? "PASS" : "FAIL"}  ${check}  ${result.seconds} s${result.ok ? "" : ` (exit ${result.code})`}`,
		);
		results.push({ check, ...result });
	}
	const table = [
		`### ${job}`,
		"",
		"| check | result | seconds |",
		"| --- | --- | --- |",
		...results.map(r => `| ${r.check} | ${r.ok ? "passed" : `failed (${r.code})`} | ${r.seconds} |`),
	].join("\n");
	console.log(table);
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, table + "\n");
	process.exit(results.every(r => r.ok) ? 0 : 1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "select") select(rest);
else if (command === "run") await run(rest);
else {
	console.error("usage: ci-heavy.mjs select [--base <ref> | --files <path>... | --all] | run <group>[/<shard>]");
	process.exit(2);
}
