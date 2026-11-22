/**
 * The platform's own git in a session's sandbox runs nothing a setup or an agent configured. A setup
 * runs as the sandbox's user before the agent's first turn and can write `~/.gitconfig`, the files it
 * includes, the home's attributes file and the workspace's `.git/config` and hooks; the platform's git
 * runs after it, outside every agent sandbox. Here each script of the platform's that runs as that user
 * (github/git.ts, the workspace's first commit, the session's status and diff) runs in bash against a
 * home and a workspace that name a program in every place git would start one, and that program never
 * runs. The scripts run as this user, not in a container: what they hold to is their own text.
 *
 *   cd server && npx tsx ../scripts/git-config-check.ts
 *
 * Needs bash, git and python3 on the host. No Docker, no network.
 */

import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INIT_WORKSPACE } from "../server/src/github/git-flags.js";
import { WORKSPACE_HEAD_COMMAND, commitScript, probeScript, reviewCheckoutScript, unsafeWorkspace, workCheckoutScript, workScript } from "../server/src/github/git.js";
import { DIFF_COMMAND, STATUS_COMMAND } from "../server/src/actors/agent-session.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "wlp-git-config-"));
const home = join(root, "home"), scratch = join(root, "tmp"), marks = join(root, "marks");
for (const dir of [home, scratch, marks, join(home, ".config", "git"), join(home, "hooks")]) mkdirSync(dir, { recursive: true });

// One program for every place: it writes down where it was started from, and prints nothing a script could misread.
const evil = join(root, "evil");
writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> ${join(marks, "ran")}\ncat >/dev/null 2>&1 || true\nexit 0\n`);
chmodSync(evil, 0o755);
for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "pre-push", "reference-transaction", "post-index-change", "fsmonitor-watchman"]) {
	writeFileSync(join(home, "hooks", hook), `#!/bin/sh\nexec ${evil} hook ${hook}\n`);
	chmodSync(join(home, "hooks", hook), 0o755);
}
const programs = (where: string) => `[core]
	hooksPath = ${join(home, "hooks")}
	fsmonitor = ${evil}
	sshCommand = ${evil} ssh-${where}
	pager = ${evil} pager-${where}
	askPass = ${evil} askpass-${where}
	attributesFile = ${join(home, ".config", "git", "attributes")}
[credential]
	helper = !${evil} credential-${where}
[filter "evil"]
	clean = ${evil} clean-${where}
	smudge = ${evil} smudge-${where}
	process = ${evil} process-${where}
[diff "evil"]
	textconv = ${evil} textconv-${where}
	command = ${evil} diffcmd-${where}
[diff]
	external = ${evil} external-${where}
[merge "evil"]
	driver = ${evil} merge-${where}
[protocol]
	allow = always
[uploadpack]
	packObjectsHook = ${evil} pack-${where}
`;
// What a setup can write in the home: the user's configuration, a file it includes, and the home's attributes.
writeFileSync(join(home, ".gitconfig"), programs("home") + `[include]\n\tpath = ${join(home, "included")}\n[init]\n\ttemplateDir = ${join(home, "template")}\n`);
writeFileSync(join(home, "included"), programs("included"));
writeFileSync(join(home, ".config", "git", "config"), programs("xdg"));
writeFileSync(join(home, ".config", "git", "attributes"), "* filter=evil diff=evil merge=evil\n");
mkdirSync(join(home, "template", "hooks"), { recursive: true });
writeFileSync(join(home, "template", "hooks", "post-commit"), `#!/bin/sh\nexec ${evil} template-hook\n`);
chmodSync(join(home, "template", "hooks", "post-commit"), 0o755);

function bash(script: string, cwd: string, stdin = "", timeout = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		// As a sandbox's command gets it: the user's home, with nothing pointing git elsewhere.
		const child = execFile("bash", ["-c", script.replaceAll("/tmp/wlp-", scratch + "/wlp-")], {
			cwd, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", XDG_CONFIG_HOME: join(home, ".config"), GIT_PAGER: "", PAGER: "" }, timeout,
		}, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr }));
		child.stdin?.end(stdin);
	});
}
const ran = () => existsSync(join(marks, "ran")) ? readFileSync(join(marks, "ran"), "utf8").trim() : "";
const clearMarks = () => rmSync(join(marks, "ran"), { force: true });

// A plain git, for the fixture only, with no configuration at all.
const fixtureGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], {
	cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8",
}).trim();

try {
	// The workspace's first commit: with the hostile home, as a new sandbox's user runs it.
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const init = await bash(INIT_WORKSPACE, workspace);
	expect("the workspace's first commit is made", init.code === 0 && fixtureGit(workspace, "log", "--format=%an <%ae> %s") === "Windlass agent <agent@windlass-platform.invalid> Empty workspace", init.stderr);
	expect("on main, without the home's template", fixtureGit(workspace, "symbolic-ref", "HEAD") === "refs/heads/main" && !existsSync(join(workspace, ".git", "hooks", "post-commit")));
	expect("and runs nothing the home's configuration names", ran() === "", ran());

	// The clone a setup ran in: a base commit and a branch, and files the attributes send through every driver.
	writeFileSync(join(workspace, "a.txt"), "one\n");
	writeFileSync(join(workspace, ".gitattributes"), "* filter=evil diff=evil merge=evil\n");
	fixtureGit(workspace, "add", "-A");
	fixtureGit(workspace, "commit", "-q", "-m", "base");
	const base = fixtureGit(workspace, "rev-parse", "HEAD");
	fixtureGit(workspace, "update-ref", "refs/remotes/origin/main", base);
	fixtureGit(workspace, "update-ref", "refs/remotes/origin/work", base);
	// What a setup can write in the workspace: hooks, and the keys of .git/config that wlp_guard lets
	// through because platform git never reads that file as configuration.
	for (const hook of ["pre-commit", "post-commit", "post-checkout", "reference-transaction"]) {
		writeFileSync(join(workspace, ".git", "hooks", hook), `#!/bin/sh\nexec ${evil} workspace-hook ${hook}\n`);
		chmodSync(join(workspace, ".git", "hooks", hook), 0o755);
	}
	const workspaceConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
	writeFileSync(join(workspace, ".git", "config"), workspaceConfig + `[core]\n\thooksPath = ${join(home, "hooks")}\n\tfsmonitor = ${evil}\n`);
	writeFileSync(join(workspace, ".git", "info", "attributes"), "* filter=evil diff=evil merge=evil\n");
	writeFileSync(join(workspace, "a.txt"), "one\ntwo\n");
	writeFileSync(join(workspace, "b.txt"), "new\n");
	clearMarks();

	const author = { name: "Platform", email: "platform@example.invalid" };
	const scripts: Array<[string, string, string?]> = [
		["the workspace's HEAD", WORKSPACE_HEAD_COMMAND],
		["the session's status", STATUS_COMMAND],
		["the session's diff", DIFF_COMMAND],
		["the probe before a push", probeScript(base, null)],
		["what a pull request says of its changes", workScript(base, "wlp-mark")],
		["the commit of a push", commitScript({ sessionId: "s1", branch: "work", baseSha: base, pushed: null, author }), "Commit message\n"],
		["the checkout of the session's branch", workCheckoutScript(".", "work")],
	];
	for (const [what, script, stdin] of scripts) {
		const result = await bash(script, workspace, stdin);
		expect(`${what} runs`, result.code === 0 && !result.stdout.includes("wlp:unsafe"), `exit ${result.code}: ${(result.stdout + result.stderr).slice(-600)}`);
		expect(`${what} runs nothing the home's or the workspace's configuration names`, ran() === "", ran());
		clearMarks();
	}
	const review = fixtureGit(workspace, "rev-parse", "HEAD");
	fixtureGit(workspace, "update-ref", "refs/wlp/review", review);
	const checkout = await bash(reviewCheckoutScript(".", review), workspace);
	expect("a review's checkout runs, and runs nothing configured", checkout.code === 0 && ran() === "", `exit ${checkout.code}: ${checkout.stderr.slice(-400)} ${ran()}`);
	clearMarks();

	// A workspace configuration that defines a program is refused outright: no platform git runs in it.
	for (const [key, text] of [
		["filter.evil.clean", `[filter "evil"]\n\tclean = ${evil}\n`],
		["diff.evil.textconv", `[diff "evil"]\n\ttextconv = ${evil}\n`],
		["merge.evil.driver", `[merge "evil"]\n\tdriver = ${evil}\n`],
		["core.sshcommand", `[core]\n\tsshCommand = ${evil}\n`],
		["credential.helper", `[credential]\n\thelper = !${evil}\n`],
		["protocol.allow", `[protocol]\n\tallow = always\n`],
		["include.path", `[include]\n\tpath = ${join(home, "included")}\n`],
	] as const) {
		writeFileSync(join(workspace, ".git", "config"), workspaceConfig + text);
		const status = await bash(STATUS_COMMAND, workspace);
		const commit = await bash(commitScript({ sessionId: "s2", branch: "work", baseSha: base, pushed: null, author }), workspace, "Message\n");
		expect(`a workspace whose .git/config sets ${key} is refused, and nothing runs`, status.code === 3 && status.stdout.includes(`wlp:unsafe ${key}`) && commit.code === 3 && ran() === "", `${status.code} ${status.stdout} ${commit.code} ${ran()}`);
		clearMarks();
	}
	expect("the refusal names the key in a sentence", unsafeWorkspace("filter.evil.clean").includes("filter.evil.clean"));

	// The check itself: the same home makes a plain git run the program.
	writeFileSync(join(workspace, ".git", "config"), workspaceConfig);
	// A newer git waits for the filter process to answer its protocol, which this program does not speak: what ran is enough.
	await bash("git status --porcelain >/dev/null; git -c user.name=x -c user.email=x@example.invalid commit -q --allow-empty -m x", workspace, "", 10_000);
	expect("the fixture is hostile: a plain git with this home runs its programs", ran() !== "", ran());
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
