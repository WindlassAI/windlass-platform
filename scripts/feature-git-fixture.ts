/** Preloaded only by the feature actor e2e, with the loopback GitHub stand-in and a fresh test directory. */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeHandle, FakeWindlass } from "../server/src/sandbox-fake.js";
import { turnPlatformTools } from "../server/src/platform-tools.js";
import { CI_POLLING } from "../server/src/github/ci.js";
import { CROSS_POLLING } from "../server/src/factory/cross-repo.js";

const root = process.env.WLP_FEATURE_TEST_GIT!;
if (!root || new URL(process.env.WLP_GITHUB_API_URL!).hostname !== "127.0.0.1") throw new Error("Feature git fixture requires the local GitHub stand-in");
Object.assign(CI_POLLING, {everyMs: 200});
// A cross-repo feature's run is read every second; its merges are woken by webhooks, the poll being a fallback.
Object.assign(CROSS_POLLING, {integrationMs: 1000, mergeMs: 120_000});
// The recorded builder keeps the feature's setup script when resolving the target-update fixture.
const fakeTurn = FakeWindlass.prototype.runTurn;
FakeWindlass.prototype.runTurn = async function(sandbox, input) {
	if (input.onSetup) {
		const host = turnPlatformTools(input), mcp = turnPlatformTools(input, "sandbox");
		if (host.size !== 1 || !host.has("file_repo_setup") || mcp.size || !input.untrusted?.length || input.onQuestion || !input.reviewDirectory) throw Error("Invalid setup tool access.");
		const folder = join(root, sandbox.id, input.reviewDirectory.replace("/tmp/", "tmp/"), ".windlass-inputs/notes");
		const ids = readdirSync(folder).filter(n => n.endsWith(".md")).map(n => n.slice(0, -3));
		const notes = ids.map(id => {
			const path = join(folder, id + ".md");
			if (statSync(path).mode & 0o222) throw Error("Writable note.");
			const note = readFileSync(path, "utf8");
			const answer = input.prompt.includes('"answer":"drop"');
			const verdict = note.includes("password=") ? "secret" : note.includes("release") ? (answer ? "stale" : "question") : "team";
			return { noteId: id, verdict, reason: "Checked the repository readme." };
		});
		const ref = { file: "README.md", line: 1 };
		const noteId = notes.find(n => n.verdict === "team")!.noteId;
		const call = { messageId: "draft", callId: "file", arguments: {
			score: ["setup", "checks", "guide"].map(id => ({ id, pass: false, reason: "Missing proof." })),
			files: [{ kind: "guide", path: "AGENTS.md", content: "# Working here\n## Terms\nSee `README.md`.\nRun `missing.sh`.\nRun `echo hello`.\npassword=fixture-only\n",
				lines: [{ line: 3, noteId, evidence: ref }, { line: 4, evidence: ref }, { line: 6, evidence: ref }] },
				{ kind: "area", path: "src/AGENTS.md", content: "# Source files\nSee [the readme](../README.md).\n", lines: [{ line: 2, evidence: ref }] }],
			notes, questions: notes.filter(n => n.verdict === "question").map(n => ({ noteId: n.noteId, ask: "Which check should run before a release?" })),
		} };
		const invoke = host.get("file_repo_setup")!;
		const answer = await invoke(call, input.signal!);
		if (!answer.startsWith("Guides filed") || !(await invoke(call, input.signal!)).includes("closed")) throw Error("Unexpected filing reply: " + answer);
		return { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: null };
	}
	if (input.prompt.includes("git merge origin/main; do not rebase")) {
		execFileSync("git", ["-c", "user.name=Builder", "-c", "user.email=builder@example.com",
			"merge", "--no-edit", "-X", "ours", "origin/main"], { cwd: join(root, sandbox.id, "workspace") });
	}
	return fakeTurn.call(this, sandbox, input);
};
const fakeRun = FakeHandle.prototype.run;
FakeHandle.prototype.run = async function(command, options = {}) {
	// A cross-repo feature's planning inputs, and what its fake planner reads of them, are real files too.
	const platformGit = command.includes("wlp_git clone --quiet") || command.includes("/tmp/wlp-git") || command.includes("/tmp/wlp-transport") || command.includes(".windlass-inputs");
	const setup = options.env?.WLP_SETUP === "1" && command === "exec 2>&1; sh index/setup.sh";
	const guideWrite = command.startsWith("test ! -L") && command.includes("AGENTS.md");
	if (!platformGit && !setup && !guideWrite) return fakeRun.call(this, command, options);
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
			cwd: guideWrite && options.cwd ? options.cwd.replace(this.cwd, work) : work, env: { PATH:"/usr/bin:/bin", HOME:dir, LANG:"C.UTF-8", ...(setup && { SETUP_FIXTURE: options.secretEnv?.SETUP_FIXTURE }) },
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
