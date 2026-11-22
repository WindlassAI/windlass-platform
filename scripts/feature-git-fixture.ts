/** Preloaded only by the feature actor e2e, with the loopback GitHub stand-in and a fresh test directory. */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeHandle } from "../server/src/sandbox-fake.js";
import { CI_POLLING } from "../server/src/github/ci.js";
import { CROSS_POLLING } from "../server/src/factory/cross-repo.js";

const root = process.env.WLP_FEATURE_TEST_GIT!;
if (!root || new URL(process.env.WLP_GITHUB_API_URL!).hostname !== "127.0.0.1") throw new Error("Feature git fixture requires the local GitHub stand-in");
Object.assign(CI_POLLING, {everyMs: 200});
// A cross-repo feature's run is read every second; its merges are woken by webhooks, the poll being a fallback.
Object.assign(CROSS_POLLING, {integrationMs: 1000, mergeMs: 120_000});
const fakeRun = FakeHandle.prototype.run;
FakeHandle.prototype.run = async function(command, options = {}) {
	// A cross-repo feature's planning inputs, and what its fake planner reads of them, are real files too.
	const platformGit = command.includes("wlp_git clone --quiet") || command.includes("/tmp/wlp-git") || command.includes("/tmp/wlp-transport") || command.includes(".windlass-inputs");
	const setup = options.env?.WLP_SETUP === "1" && command === "exec 2>&1; sh index/setup.sh";
	if (!platformGit && !setup) return fakeRun.call(this, command, options);
	const dir = join(root, this.id), work = join(dir, "workspace"), scratch = join(dir, "tmp");
	mkdirSync(work, {recursive:true});
	mkdirSync(scratch, {recursive:true});
	// Materialize the recorded builder's edits when Git inspects the working tree.
	for (const [path, content] of this.sandbox.files) {
		if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid fixture file path");
		const file = join(work, path);
		mkdirSync(dirname(file), {recursive:true});
		writeFileSync(file, content);
	}
	return new Promise(resolve => {
		const child = execFile("bash", ["-c", command.replaceAll("/tmp/wlp-", scratch + "/wlp-")], {
			cwd: work, env: { PATH:"/usr/bin:/bin", HOME:dir, LANG:"C.UTF-8", ...(setup && { SETUP_FIXTURE: options.secretEnv?.SETUP_FIXTURE }) },
			timeout: options.timeoutMs ?? 60_000, signal: options.signal,
		}, (error, stdout, stderr) => {
			if (setup) options.onStdout?.(stdout);
			resolve({
				exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
				timedOut: error?.killed ?? false, aborted: options.signal?.aborted ?? false, stdout, stderr,
			});
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.stdin ?? "");
	});
};
