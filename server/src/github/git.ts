/**
 * The git commands the platform itself runs in a session's sandbox, for a repository of the user's
 * GitHub connection: one clone, and for each push a commit and a push. The agent runs none of them and
 * is given no credential: it works on the files, and its own git has nothing to authenticate with.
 *
 * Two of these commands talk to GitHub and need an installation token (`clone`, `push`). How the token
 * gets to git, and no further:
 *
 *   - It is written to the command's standard input (`ExecOptions.stdin`), not passed in its arguments or
 *     its environment: on Docker those are on the server's own `docker exec` command line.
 *   - The script reads it into a shell variable that is never exported, and hands it to git on a pipe
 *     (file descriptor 3). Git is given a credential helper, in its environment's configuration, that
 *     answers a request for GitHub's host by reading that pipe: so the token is in no argument, no
 *     environment variable and no file, the pipe is empty once git has read it, and git sends it only
 *     where GitHub asked for it. On the wire it is what GitHub documents, the HTTP password of the
 *     user `x-access-token`:
 *     https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
 *   - That git runs with an empty environment (`env -i`), without the system's and the user's
 *     configuration, and without hooks: nothing writes the token down. A clone's `.git/config` holds the
 *     plain address and no credential.
 *   - A push never runs in the workspace's repository, whose configuration and hooks the agent can
 *     write: a remote rewritten to another host, a credential helper or a `pre-push` hook there would be
 *     handed the token. The commit is made in the workspace by a command that has no token; the push
 *     runs in an empty repository the script makes for it outside the workspace, which borrows the
 *     workspace's objects and nothing else, and is removed afterwards.
 *   - The token is revoked when the command has ended (`GithubApp.withToken`), so what a command could
 *     have kept of it is of no use afterwards.
 *
 * What an agent's command can still observe is said in README, "GitHub".
 *
 * The sandbox layer's fake runs none of this: there every command succeeds and prints nothing. So what
 * a script reports (`wlp:` lines) is read where it is there and never required.
 */

import type { ExecResult, SandboxHandle } from "../sandbox/api.js";
import { redact } from "./redact.js";

const CLONE_TIMEOUT_MS = 3 * 60 * 1000;
// A push is one action of the session's actor, which may take two minutes in all: the commit and the push fit in it together.
const COMMIT_TIMEOUT_MS = 30 * 1000;
const PUSH_TIMEOUT_MS = 70 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A branch name git and GitHub would accept, as far as it matters for a command line. */
export function isBranchName(name: unknown): name is string {
	return typeof name === "string" && name.length > 0 && name.length <= 250 && !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".lock") && !name.includes("..") && !/[\u0000- ~^:?*[\\\u007f]/.test(name);
}

/** `https://github.com`: what the credential helper answers for, and nothing else. */
function hostOf(url: string): string {
	const parsed = new URL(url);
	return `${parsed.protocol}//${parsed.host}`;
}

/**
 * `wlp_git`: git as the platform runs it with a token. The token is in the shell variable WLP_T and
 * reaches git on descriptor 3; the helper is consulted for `host` only, answers `get` and ignores
 * `store` and `erase`.
 */
function tokenGit(host: string): string {
	const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf password=; cat <&3; echo; }; f`;
	return [
		"wlp_git() {",
		`	printf '%s' "$WLP_T" | {`,
		`		env -i PATH=${SYSTEM_PATH} HOME=/nonexistent LANG=C.UTF-8 \\`,
		"			GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ALLOW_PROTOCOL=http:https \\",
		"			GIT_CONFIG_COUNT=3 \\",
		"			GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \\",
		`			GIT_CONFIG_KEY_1=${shellQuote(`credential.${host}.helper`)} GIT_CONFIG_VALUE_1=${shellQuote(helper)} \\`,
		"			GIT_CONFIG_KEY_2=core.hooksPath GIT_CONFIG_VALUE_2=/dev/null \\",
		`			git "$@" 3<&0 0</dev/null`,
		"	}",
		"}",
	].join("\n");
}

/** Git with an empty environment and no configuration but its own, for the steps of a token script that need no token. */
const PLAIN_GIT = `plain_git() { env -i PATH=${SYSTEM_PATH} HOME=/nonexistent LANG=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@" </dev/null; }`;

/**
 * How a script that is handed a token begins. The commands it runs itself (`env`, `mktemp`, `rm`) come
 * from the system's own directories, whatever the sandbox's PATH names first; then the token is read
 * from standard input, before anything else runs that could take it from there.
 */
const READ_TOKEN = `PATH=${SYSTEM_PATH}\nexport PATH\nIFS= read -r WLP_T || true`;

/** How a script without a token begins: the system's own programs, and no prompt that nobody would answer. */
const PLAIN_START = `PATH=${SYSTEM_PATH}\nexport PATH GIT_TERMINAL_PROMPT=0`;

/**
 * Clones `url` at `branch` into the workspace, as the plain clone of a pasted address does: a new
 * sandbox's workspace holds an empty repository and nothing else, which the clone replaces.
 *
 * With `work`, the branch the platform pushed the session's work to: the clone is of a sandbox made in
 * place of a lost one, and what was pushed is all that is left of the work. The clone has that branch
 * too (it fetches every branch), so the workspace is put on it, as GitHub has it now: `wlp:work <commit>`.
 * `wlp:nowork` when GitHub no longer has the branch (deleted, say, after its pull request was merged):
 * the workspace then stays on `branch`. That step needs no token and gets none.
 *
 * `wlp:dir <directory>` says where the clone is, relative to the workspace: "." or `directory`.
 */
export function cloneScript(url: string, branch: string, directory: string, work?: string): string {
	const lines = [
		"set -eu",
		READ_TOKEN,
		tokenGit(hostOf(url)),
		`if [ -z "$(ls -A | grep -v '^\\.git$' || true)" ]; then`,
		"	rm -rf .git",
		"	target=.",
		"else",
		`	target=${shellQuote(directory)}`,
		"fi",
		`wlp_git clone --quiet --branch ${shellQuote(branch)} -- ${shellQuote(url)} "$target"`,
		`echo "wlp:dir $target"`,
	];
	if (work !== undefined && work !== branch) {
		const remote = shellQuote(`refs/remotes/origin/${work}`);
		lines.push(
			"WLP_T=",
			PLAIN_GIT,
			`if plain_git -C "$target" rev-parse -q --verify ${shellQuote(`refs/remotes/origin/${work}^{commit}`)} >/dev/null 2>&1; then`,
			`	plain_git -C "$target" -c core.hooksPath=/dev/null checkout --quiet -B ${shellQuote(work)} ${remote}`,
			`	echo "wlp:work $(plain_git -C "$target" rev-parse HEAD)"`,
			"else",
			`	echo "wlp:nowork"`,
			"fi",
		);
	}
	return lines.join("\n");
}

/** Where the commit step leaves the push step two lines: the commit to push, and the workspace's object directory. */
function handoverFile(sessionId: string): string {
	return `/tmp/wlp-publish-${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * Whether the workspace has anything GitHub does not: `wlp:nothing` when its HEAD is the commit last
 * pushed, or, before the first push, a commit the base branch already had when it was cloned.
 */
function nothingNew(base: string, pushed: string | null): string[] {
	const said = `nothing=1; echo "wlp:nothing"`;
	if (pushed !== null) return ["nothing=0", `if [ "$head" = ${shellQuote(pushed)} ]; then ${said}; fi`];
	const ref = shellQuote(`refs/remotes/origin/${base}`);
	return ["nothing=0", `if git rev-parse -q --verify ${ref} >/dev/null 2>&1 && git merge-base --is-ancestor "$head" ${ref} 2>/dev/null; then ${said}; fi`];
}

export interface CommitInput {
	sessionId: string;
	/** The branch the work goes on. */
	branch: string;
	/** The branch the session started from. */
	base: string;
	/** The commit the platform last pushed, if it pushed before. */
	pushed: string | null;
	author: { name: string; email: string };
}

/**
 * Puts the work on the session's branch and commits what is uncommitted, with the message on standard
 * input. No token: this runs in the workspace's own repository, which is the agent's to configure. The
 * repository's hooks are not run: the commit is the platform's, and a hook of the project's may need
 * what the sandbox does not have. The message is put in a file of its own first, outside the workspace:
 * a program the repository's configuration makes git start could otherwise read it away.
 */
export function commitScript(input: CommitInput): string {
	const branch = shellQuote(input.branch);
	const file = shellQuote(handoverFile(input.sessionId));
	return [
		"set -eu",
		PLAIN_START,
		"message=$(mktemp /tmp/wlp-message.XXXXXXXX)",
		`trap 'rm -f "$message"' EXIT`,
		`cat > "$message"`,
		"exec </dev/null",
		`if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "wlp:norepo"; exit 0; fi`,
		`cd "$(git rev-parse --show-toplevel)"`,
		`if [ "$(git symbolic-ref --quiet --short HEAD || true)" != ${branch} ]; then git checkout --quiet -B ${branch}; fi`,
		"git -c core.fsmonitor=false add -A",
		"if git diff --cached --quiet; then",
		"	committed=0",
		"else",
		`	git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c user.name=${shellQuote(input.author.name)} -c user.email=${shellQuote(input.author.email)} commit --quiet --no-verify -F "$message"`,
		"	committed=$(git show --pretty=format: --name-only HEAD | grep -c . || true)",
		"fi",
		`if ! head=$(git rev-parse -q --verify 'HEAD^{commit}'); then echo "wlp:nothing"; exit 0; fi`,
		`echo "wlp:committed $committed"`,
		`echo "wlp:head $head"`,
		...nothingNew(input.base, input.pushed),
		`rm -rf ${file}`,
		// Left for the push only when there is something to push.
		`if [ "$nothing" = 0 ]; then ( umask 077; { echo "$head"; cd "$(git rev-parse --git-path objects)" && pwd -P; } > ${file} ); fi`,
	].join("\n");
}

/** Reads the workspace's HEAD and whether GitHub lacks anything, without changing it. No token. */
export function probeScript(base: string, pushed: string | null): string {
	return [
		"set -eu",
		PLAIN_START,
		`if ! head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null); then echo "wlp:nothing"; exit 0; fi`,
		`echo "wlp:head $head"`,
		`if [ -n "$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=normal 2>/dev/null | head -c 1)" ]; then echo "wlp:dirty"; fi`,
		...nothingNew(base, pushed),
	].join("\n");
}

/**
 * Pushes the commit the commit step left to `branch` at `url`, with the token on standard input. It
 * does not touch the workspace's repository: what it reads of it are two lines of a file (a commit's
 * name and a directory's path, both checked), and git runs in an empty repository made here, with a
 * configuration of the platform's own, that finds the commit's objects in the workspace's object
 * directory. A branch that moved on GitHub is not overwritten: the push is refused.
 */
export function pushScript(sessionId: string, url: string, branch: string): string {
	const file = shellQuote(handoverFile(sessionId));
	return [
		"set -eu",
		READ_TOKEN,
		tokenGit(hostOf(url)),
		PLAIN_GIT,
		`{ IFS= read -r sha && IFS= read -r objects; } < ${file} || { echo "wlp:nohandover"; exit 4; }`,
		`rm -f ${file}`,
		`case "$sha" in *[!0-9a-f]* | "") echo "wlp:nohandover"; exit 4 ;; esac`,
		`case "$objects" in /*) ;; *) echo "wlp:nohandover"; exit 4 ;; esac`,
		"tmp=$(mktemp -d /tmp/wlp-push.XXXXXXXX)",
		`trap 'rm -rf "$tmp"' EXIT`,
		`cd "$tmp"`,
		`plain_git init --quiet --bare --template= "$tmp/repo"`,
		`mkdir -p "$tmp/repo/objects/info"`,
		`printf '%s\\n' "$objects" > "$tmp/repo/objects/info/alternates"`,
		`wlp_git --git-dir="$tmp/repo" push --quiet -- ${shellQuote(url)} "$sha:refs/heads/"${shellQuote(branch)}`,
		`echo "wlp:pushed $sha"`,
	].join("\n");
}

/** The `wlp:` lines of a script's output: name -> what follows it. */
export function markers(output: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = /^wlp:([a-z]+)(?: (.*))?$/.exec(line.trim());
		if (match?.[1]) found.set(match[1], match[2] ?? "");
	}
	return found;
}

/** The end of what git said, with no credential in it. */
function said(result: ExecResult, secrets: string[]): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("wlp:"));
	return redact(lines.slice(-4).join(" ").slice(-400), secrets);
}

export type GitFailure =
	/** GitHub did not accept the token, or the app may not do this in the repository. */
	| "denied"
	/** The repository is not there (any more), or the app cannot see it. */
	| "gone"
	/** A rule of the repository's refused the branch. */
	| "protected"
	/** The push changes a workflow file, which the app's permissions do not cover. */
	| "workflow"
	/** GitHub's branch has commits the workspace lacks. */
	| "diverged"
	/** The branch to clone does not exist. */
	| "no_branch"
	| "unreachable"
	| "timeout"
	| "aborted"
	| "other";

export interface GitOutcome {
	ok: boolean;
	failure: GitFailure | null;
	/** What git said, redacted; empty when it succeeded. */
	said: string;
	marks: Map<string, string>;
}

/** What a failed clone or push means, from git's own words and GitHub's `remote:` lines. */
function classify(text: string): GitFailure {
	if (/GH006|GH013|protected branch|rule violations/i.test(text)) return "protected";
	if (/without `?workflows?`? permission/i.test(text)) return "workflow";
	if (/non-fast-forward|fetch first|\[rejected\]/i.test(text)) return "diverged";
	if (/Remote branch .* not found/i.test(text)) return "no_branch";
	if (/Repository not found|returned error: 404|not found\b/i.test(text)) return "gone";
	if (/returned error: 40[13]|Permission to .* denied|Authentication failed|Invalid username or (?:token|password)|could not read (?:Username|Password)|Write access to repository not granted/i.test(text)) return "denied";
	if (/Could not resolve host|Failed to connect|Connection (?:refused|timed out|reset)|unable to access|network is unreachable|returned error: 5\d\d/i.test(text)) return "unreachable";
	return "other";
}

async function run(sandbox: SandboxHandle, script: string, options: { stdin: string; timeoutMs: number; signal?: AbortSignal; secrets?: string[] }): Promise<GitOutcome> {
	const secrets = options.secrets ?? [];
	let result: ExecResult;
	try {
		result = await sandbox.run(script, { stdin: options.stdin, timeoutMs: options.timeoutMs, signal: options.signal });
	} catch (error) {
		// Whatever the sandbox layer says of a command it could not run, it does not say with the token in it.
		throw new Error(redact(error instanceof Error ? error.message : String(error), secrets));
	}
	const marks = markers(result.stdout);
	if (result.aborted) return { ok: false, failure: "aborted", said: "", marks };
	if (result.timedOut) return { ok: false, failure: "timeout", said: "", marks };
	if (result.exitCode === 0) return { ok: true, failure: null, said: "", marks };
	const text = said(result, secrets);
	return { ok: false, failure: classify(`${result.stderr}\n${result.stdout}`), said: text, marks };
}

/** Clones with `token`, which is given to the command on its standard input and to nothing else. */
export function cloneWithToken(sandbox: SandboxHandle, token: string, input: { url: string; branch: string; directory: string; work?: string; signal?: AbortSignal }): Promise<GitOutcome> {
	return run(sandbox, cloneScript(input.url, input.branch, input.directory, input.work), { stdin: `${token}\n`, timeoutMs: CLONE_TIMEOUT_MS, signal: input.signal, secrets: [token] });
}

/** Commits the workspace's changes on the session's branch. `message` is the commit's whole message. */
export function commitWork(sandbox: SandboxHandle, input: CommitInput, message: string): Promise<GitOutcome> {
	return run(sandbox, commitScript(input), { stdin: message.endsWith("\n") ? message : `${message}\n`, timeoutMs: COMMIT_TIMEOUT_MS });
}

export function probeWork(sandbox: SandboxHandle, base: string, pushed: string | null): Promise<GitOutcome> {
	return run(sandbox, probeScript(base, pushed), { stdin: "", timeoutMs: PROBE_TIMEOUT_MS });
}

/** Removes what `commitWork` left for a push that is not going to run. Never throws. */
export async function discardHandover(sandbox: SandboxHandle, sessionId: string): Promise<void> {
	await sandbox.run(`rm -f ${shellQuote(handoverFile(sessionId))}`, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
}

/** Pushes what `commitWork` left, with `token` on the command's standard input. */
export function pushWithToken(sandbox: SandboxHandle, token: string, input: { sessionId: string; url: string; branch: string }): Promise<GitOutcome> {
	return run(sandbox, pushScript(input.sessionId, input.url, input.branch), { stdin: `${token}\n`, timeoutMs: PUSH_TIMEOUT_MS, secrets: [token] });
}

export const CLONE_MINUTES = CLONE_TIMEOUT_MS / 60_000;
