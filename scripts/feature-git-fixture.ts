/** Preloaded only by the feature actor e2e, with the loopback GitHub stand-in and a fresh test directory. */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeHandle, FakeWindlass } from "../server/src/sandbox-fake.js";
import { setupGuide } from "./setup-guide-fixture.js";
import { getLayer } from "../server/src/layer.js";
import { hostToolsMeta } from "../server/src/sandbox/turn.js";
import { getSignIns } from "../server/src/signin/index.js";
import { turnPlatformTools } from "../server/src/platform-tools.js";
import { CI_POLLING } from "../server/src/github/ci.js";
import { CROSS_POLLING } from "../server/src/factory/cross-repo.js";

const root = process.env.WLP_FEATURE_TEST_GIT!;
if (!root || new URL(process.env.WLP_GITHUB_API_URL!).hostname !== "127.0.0.1") throw new Error("Feature git fixture requires the local GitHub stand-in");
Object.assign(CI_POLLING, {everyMs: 200});
// A cross-repo feature's run is read every second; its merges are woken by webhooks, the poll being a fallback.
Object.assign(CROSS_POLLING, {integrationMs: 1000, mergeMs: 120_000});
if (process.env.WLP_FEATURE_TEST_RESTRICTED_HOST === "1") {
	const { sandboxes } = await getLayer();
	sandboxes.egress = () => "restricted";
}
if (process.env.WLP_TEST_SETUP_MODEL) {
	const { commands } = await getSignIns();
	commands.models = async () => ({ defaultModel: "account-default", models: [
		{ id: "account-default", name: null, efforts: [] }, { id: "stale-mini", name: null, efforts: [] },
		{ id: "saved-choice", name: null, efforts: [] },
	] });
}
const fakeTurn = FakeWindlass.prototype.runTurn;
FakeWindlass.prototype.runTurn = async function(sandbox, input) {
	if (input.onPlan && input.prompt.includes("(hosted-docs)")) {
		const file = input.onPlan;
		const egress = input.prompt.includes("(open-egress)") ? "open" : "restricted";
		input = { ...input, onPlan: (call, signal) => file({ ...call, arguments: {
			spec: { goal: "Add two documentation notes", requirements: [], outOfScope: [], acceptance: ["Both notes exist."] },
			questions: [],
			subtasks: ["B", "C"].map(letter => {
				const path = `docs/NOTES-${letter}.md`;
				return { key: "notes-" + letter.toLowerCase(), title: "Write " + path, brief: "Add a note.", owns: [path],
					acceptance: [`Run test -f ${path}`], dependsOn: [], budget: { tokens: 200_000 },
					place: { prefer: "hosted", reason: "Small isolated documentation file." }, needs: { egress } };
			}),
		} }, signal) };
	}
	if (input.onSetup || input.onSetupReview) {
		const names = hostToolsMeta(turnPlatformTools(input)).hostTools.map(t => t.name);
		const tool = input.onSetupReview ? "file_repo_setup_review" : "file_repo_setup";
		if (names.length !== 1 || names[0] !== tool || !input.prompt.includes(tool)) throw Error("Missing setup tool or filing instructions.");
		const expectedModel = input.prompt.includes("ada/setup-startup") ? "saved-choice" : "account-default";
		if (process.env.WLP_TEST_SETUP_MODEL && input.model !== expectedModel) throw Error("Setup changed the account model.");
		const ended = { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: null };
		if (input.prompt.includes("ada/setup-startup")) return { ...ended, failure: { reason: "unknown_model", message: "The model is unavailable." } };
		input.onHostTools?.(names);
		if (input.prompt.includes("ada/setup-no-filing") || input.prompt.includes("ada/setup-refused")) {
			if (input.prompt.includes("ada/setup-refused")) {
				const badLines = Array.from({ length: 11 }, (_, i) => i === 1 ? "password=diagnosisFixtureSecret" : "- Run `make invented` for " + "x".repeat(150));
				const rejected = { path: "AGENTS.md", kind: "guide", content: ["# Guide", "## Quick commands", ...badLines].join("\n"),
					lines: badLines.map((_, i) => ({ line: i + 3, evidence: { file: "README.md", line: 1 } })) };
				for (const [i, args] of [{}, { files: [{ kind: "skill", path: ".agents/skills/read-source/SKILL.md",
					content: "# Inspect source\nOwner preview ghs_diagnosisFixtureSecret123. " + "x".repeat(350), lines: [] }], notes: [], score: [] },
					{ files: [rejected], score: ["setup", "checks", "guide"].map(id => ({ id, pass: false, reason: "Missing proof." })) }].entries()) {
					const reply = await input.onSetup!({ messageId: "draft", callId: "file-" + i, arguments: args }, input.signal!);
					if (!reply.includes("Correct the filing")) throw Error("Expected a retryable rejection.");
				}
			}
			input.onEvent?.({ type: "text.ended", data: { text: "First message." } });
			input.onEvent?.({ type: "text.ended", data: { text: "Stopped ghs_diagnosisFixtureSecret123. " + "x".repeat(350) } });
			return { ...ended, summary: { type: "cli.summary", outcome: "succeeded" }, stopReason: "end_turn" };
		}
	}
	if (input.onSetupReview) {
		const host = turnPlatformTools(input);
		const repo = join(root, sandbox.id, input.reviewDirectory!.replace("/tmp/", "tmp/"), ".windlass-inputs");
		if (input.windlassSessionId || host.size !== 1 || turnPlatformTools(input, "sandbox").size ||
			readdirSync(join(repo, "notes")).length !== 1 || !readFileSync(join(repo, "notes", readdirSync(join(repo, "notes"))[0]), "utf8").includes("README")) throw Error("Invalid critic inputs.");
		const files = [...readdirSync(join(repo, "draft"), { recursive: true, encoding: "utf8" })].filter(p => p.endsWith(".md")).map(path =>
			({ path, verdict: path === "AGENTS.md" ? "fix" : "ok", findings: path === "AGENTS.md" ? ["Name the root guide clearly."] : [] }));
		if (files.some(f => f.path.includes("bad-")) || !files.some(f => f.path.includes("read-source"))) throw Error("Draft did not pass the read-only checks.");
		const answer = await host.get("file_repo_setup_review")!({ callId: "review", messageId: "review", arguments: { files } }, input.signal!);
		if (!answer.startsWith("Review filed")) throw Error(answer);
		return { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: "revision-critic", summary: null, stderrTail: "", failure: null };
	}
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
			return { noteId: id, verdict, question: verdict === "question" ? "Which check should run before a release?" : undefined, reason: "Checked the repository readme." };
		});
		const ref = { file: "README.md", line: 1 };
		const noteId = notes.find(n => n.verdict === "team")!.noteId;
		const revise = input.prompt.includes("Name the root guide clearly.");
		if (revise && input.windlassSessionId !== "draft-turn") throw Error("The read-only revision lost the original draft.");
		const skill = (name: string, file: string) => ({ kind: "skill", path: ".agents/skills/" + name + "/SKILL.md",
			content: ["---", `name: "${name}"`, "description: >-", "  Verify the starter service's source layout.", "---", "",
				"## When to use", "Use before changing the starter service.", "", "## Steps",
				"1. Read `README.md` for the service setup.", "2. Inspect `src/f0.ts` before editing its exports.", "",
				"## Check", "```sh", "test -f " + file, "```"].join("\n"),
			lines: [8, 11, 12].map(line => ({ line, evidence: line === 12 ? { file: "src/f0.ts", line: 1 } : ref })) });
		const call = { messageId: "draft", callId: "file", arguments: {
			score: ["setup", "checks", "guide"].map(id => ({ id, pass: false, reason: "Missing proof." })),
			files: [...[setupGuide("", revise ? "# Read the repository guide" : "# Working here", "See `README.md`.", "Run `missing.sh`.\nRun `echo hello`.\npassword=fixture-only"),
				setupGuide("src", "# Source files", "Run the check from the root.")].map(f => ({ ...f, lines: f.lines.map(r => ({ ...r, noteId: f.kind === "guide" && r.noteId ? noteId : undefined })) })),
				skill("read-source", "README.md"), ...(notes.some(n => n.verdict === "question") ? [skill("first-draft", "README.md")] : []), skill("bad-read", "src"), skill("bad-reference", "missing"),
				...(revise && notes.some(n => n.verdict === "question") ? [skill("unreviewed", "README.md")] : [])],
			notes,
		} };
		const guide = call.arguments.files[0];
		for (const command of ["make prepare", "make verify"]) {
			if (!input.prompt.includes(JSON.stringify(command))) throw Error("Missing saved repository command.");
			guide.content += "Run `" + command + "`.\n";
			(guide.lines as { line: number; evidence: unknown }[]).push({ line: guide.content.trimEnd().split("\n").length, evidence: { command } });
		}
		const invoke = host.get("file_repo_setup")!;
		const answer = await invoke(call, input.signal!);
		if (!answer.startsWith("Guides filed") || !(await invoke(call, input.signal!)).includes("closed")) throw Error("Unexpected filing reply: " + answer);
		return { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: "draft-turn", summary: null, stderrTail: "", failure: null };
	}
	// The recorded builder keeps the feature's setup script when resolving the target-update fixture.
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
	const guideWrite = command.startsWith("test ! -L") || command.startsWith("if test -d .claude");
	const restore = command.startsWith("git -c core.hooksPath=/dev/null restore");
	const guideRead = command.startsWith("test -f ") && options.cwd?.startsWith("/tmp/wlp-");
	if (!platformGit && !setup && !guideWrite && !guideRead && !restore) return fakeRun.call(this, command, options);
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
			cwd: guideRead ? join(dir, options.cwd!.replace("/tmp/", "tmp/")) : (guideWrite || restore) && options.cwd ? options.cwd.replace(this.cwd, work) : work, env: { PATH:"/usr/bin:/bin", HOME:dir, LANG:"C.UTF-8", ...(setup && { SETUP_FIXTURE: options.secretEnv?.SETUP_FIXTURE }) },
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
