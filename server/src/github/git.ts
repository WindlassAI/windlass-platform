/**
 * The git commands the platform itself runs in a session's sandbox, for a repository of the user's
 * GitHub connection: one clone, and for each push a commit and a push. The agent runs none of them and
 * is given no credential: it works on the files, and its own git has nothing to authenticate with.
 *
 * The commands that talk to GitHub need an installation token (`clone`, `fetch`, `push`). How the token
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
 *   - The commit, outgoing-history scan and push use the same private object database. The
 *     worktree supplies content, and the agent's refs and objects supply its commit history.
 *   - The token is revoked when the command has ended (`GithubApp.withToken`), so what a command could
 *     have kept of it is of no use afterwards.
 *
 * What an agent's command can still observe is said in docs/github-and-repositories.md, "GitHub".
 *
 * The sandbox layer's fake runs none of this: there every command succeeds and prints nothing. So what
 * a script reports (`wlp:` lines) is read where it is there and never required.
 */

import { RUNNER_HTTP_PROXY } from "../runner/egress.js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ExecResult, SandboxHandle } from "../sandbox/api.js";
import type { WorkDiff } from "../verified.js";
import { GithubProblem } from "./repos.js";
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

// Keep env -i for platform Git. Only the known runner endpoint may enter its clean environment.
const GIT_PROXY = `wlp_proxy=''
if [ "\${https_proxy:-}" = '${RUNNER_HTTP_PROXY}' ]; then wlp_proxy='${RUNNER_HTTP_PROXY}'; fi`;
const PROXY_ENV = 'http_proxy="$wlp_proxy" https_proxy="$wlp_proxy"';

/**
 * `wlp_git`: git as the platform runs it with a token. The token is in the shell variable WLP_T and
 * reaches git on descriptor 3; the helper is consulted for `host` only, answers `get` and ignores
 * `store` and `erase`.
 */
function tokenGit(host: string): string {
	const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf password=; cat <&3; echo; }; f`;
	return [
		GIT_PROXY,
		"wlp_git() {",
		`	printf '%s' "$WLP_T" | {`,
		`		env -i ${PROXY_ENV} PATH=${SYSTEM_PATH} HOME=/nonexistent LANG=C.UTF-8 \\`,
		"			GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=http:https \\",
		"			GIT_CONFIG_COUNT=2 \\",
		"			GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \\",
		`			GIT_CONFIG_KEY_1=${shellQuote(`credential.${host}.helper`)} GIT_CONFIG_VALUE_1=${shellQuote(helper)} \\`,
		`			git ${SAFE_FLAGS} "$@" 3<&0 0</dev/null`,
		"	}",
		"}",
	].join("\n");
}

/**
 * What every git the platform runs in the workspace is given on its command line, whatever the
 * repository's configuration says: no hooks, no file-system monitor, no recursion into submodules, no
 * automatic housekeeping. Each of those would start a program the repository names.
 */
const SAFE_FLAGS = "-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c gc.auto=0 -c maintenance.auto=false";

/** Git with an empty environment and no configuration but its own, for the steps of a token script that need no token. */
const GIT_ENV = `env -i PATH=${SYSTEM_PATH} HOME=/nonexistent LANG=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1`;
const PLAIN_GIT = `plain_git() { ${GIT_ENV} git ${SAFE_FLAGS} "$@" </dev/null; }`;

/** Defense in depth: refuse repository-defined programs, redirects and included configuration
 * even though Git only uses the platform's private config. The guard reads keys as inert data. */
const UNSAFE_KEYS = String.raw`^(filter\.|diff\.external$|diff\..+\.(command|textconv)$|merge\..+\.driver$|core\.(sshcommand|pager|editor|worktree|gitproxy|askpass|alternaterefscommand)$|include\.|includeif\.|credential\.|gpg\.|url\.|protocol\.|remote\..+\.(uploadpack|receivepack|vcs)$|uploadpack\.|submodule\..+\.update$|ssh\.)`;

// This helper is shipped with the server and passed as script text to the sandbox. -I keeps
// workspace modules and Python's user site out of its imports.
const BRIDGE = `bridge() { local action="$1"; shift; python3 -I -c ${shellQuote(readFileSync(new URL("./private-git.py", import.meta.url), "utf8"))} "$action" "$private" "$@"; }`;

const WORKSPACE_GUARD = [
	"wlp_guard() {",
	`  git config --no-includes --file "$private/guard-config" --list --name-only > "$private/keys"`,
	`  bad=$(grep -iE ${shellQuote(UNSAFE_KEYS)} "$private/keys" | head -1)`,
	`  if [ -n "$bad" ]; then echo "wlp:unsafe $bad"; exit 3; fi`,
	`  links=$(set -o pipefail; git ls-files --stage | awk '/^160000 / {found=1} END {print found+0}') || { echo "wlp:unsafe unreadable"; exit 3; }`,
	`  if [ "$links" != 0 ]; then echo "wlp:unsafe gitlink"; exit 3; fi`,
	// The find child gets the same private git directory and clean config as the parent.
	`  nested=$(${GIT_ENV} GIT_DIR="$private/repo" GIT_WORK_TREE="$tree" timeout 4s find . -path ./.git -prune -o -type d -name node_modules -exec git ${SAFE_FLAGS} check-ignore -q -- {} \\; -prune -o -name .git -printf x -quit) || { echo "wlp:unsafe unreadable"; exit 3; }`,
	`  if [ -n "$nested" ]; then echo "wlp:unsafe nested"; exit 3; fi`,
	"}",
].join("\n");

const READ_TOKEN = `PATH=${SYSTEM_PATH}\nexport PATH\nIFS= read -r WLP_T || true`;

// Each operation owns its repo, index and config in the platform's /tmp. Windlass mounts a
// different /tmp for sandboxed commands. Never use workspace objects as Git alternates.
function privateStart(options: { refs?: string[]; missing?: "nothing" | "norepo"; fetch?: boolean } = {}): string {
	const refs = (options.refs ?? []).map(shellQuote).join(" ");
	const missing = options.missing ? ` || { rc=$?; if [ "$rc" = 2 ]; then echo "wlp:${options.missing}"; exit 0; fi; exit "$rc"; }` : "";
	return [
		"set -eu",
		`export PATH=${SYSTEM_PATH}`,
		"umask 077",
		PLAIN_GIT,
		BRIDGE,
		'private=$(mktemp -d /tmp/wlp-git.XXXXXXXX)',
		`trap 'rm -rf -- "$private"' EXIT`,
		'tree=$(pwd -P)',
		'plain_git -C "$private" init --quiet --bare --template= "$private/repo"',
		`bridge ${options.fetch ? "fetch" : "import"} ${refs}${missing}`,
		'git() { plain_git -C "$tree" --git-dir="$private/repo" --work-tree="$tree" "$@"; }',
		WORKSPACE_GUARD,
		"wlp_guard",
	].join("\n");
}

const COMMIT_PATHS = ". ':(exclude,top).wlp-shots'";
const VERIFY_OBJECTS = "git fsck --full --no-reflogs --no-dangling --no-progress >/dev/null";

function capture(paths = "."): string {
	return [
		`git ls-files -z --cached --others --exclude-standard -- ${paths} > "$private/paths"`,
		"bridge capture",
		'tree="$private/tree"',
	].join("\n");
}

export const WORKSPACE_HEAD_COMMAND = privateStart() + "\ngit rev-parse --verify 'HEAD^{commit}'";
export const WORKSPACE_GIT_START = privateStart() + "\n" + capture();

/** Plain clones run during initial sandbox setup. */
export const CLONE_GIT_START = [
	`export PATH=${SYSTEM_PATH}`,
	`if [ -e .git ] || [ -L .git ]; then (\n${privateStart()}\n); fi`,
	GIT_PROXY,
	`git() { ${GIT_ENV} ${PROXY_ENV} git ${SAFE_FLAGS} -C / "$@" </dev/null; }`,
].join("\n");

/** The sentence for a workspace `wlp_guard` refused: `what` is the key or ".git". */
export function unsafeWorkspace(what: string): string {
	if (what === "gitlink" || what === "nested") return "The workspace contains a submodule or a nested git repository. Remove the gitlink or move the nested repository outside the workspace before retrying.";
	if (what === "unreadable") return "The platform could not finish checking the workspace for nested git repositories. The git operation was stopped.";
	const named = what === ".git" ? "its .git is not the repository's own directory (a file, a link, or one that borrows another repository's configuration)" : `its git configuration sets ${what}`;
	return `The workspace's git settings were changed in a way the platform does not run: ${named}, under which git would start a program of the repository's outside the agent's sandbox. Nothing was pushed or read. Undo that change in the workspace (git config --unset, or put .git back), or start a new agent.`;
}

/** Kept in the platform's /tmp, outside the agent's mount namespace. Scope it to this work tree and base. */
function baseRecord(base: string): string {
	return `base_file=/tmp/wlp-base-$( { pwd -P; printf '%s' ${shellQuote(base)}; } | sha256sum | cut -d' ' -f1)`;
}

function saveBase(base: string, revision: string): string {
	return [baseRecord(base), 'record=$(mktemp "$base_file.XXXXXXXX")', `${revision} > "$record"`, 'mv -f -- "$record" "$base_file"'].join("\n");
}

/**
 * Clones `url` at `branch` into the workspace, as the plain clone of a pasted address does: a new
 * sandbox's workspace holds an empty repository and nothing else, which the clone replaces.
 *
 * With `work`, the branch the platform pushed the session's work to: the clone is of a sandbox made in
 * place of a lost one, and what was pushed is all that is left of the work. The clone has that branch
 * too (it fetches every branch), and says at which commit: `wlp:haswork <commit>`, or `wlp:nowork`
 * when GitHub no longer has it (deleted, say, after its pull request was merged). The workspace stays
 * on `branch` all the same: the repository's setup command runs there first, on what the session was
 * launched from. For a subtask, setup runs on the pinned feature seed and the saved publishing base
 * is the fetched feature tip. Setup never runs on what a session pushed (the command runs with
 * the network and every secret saved for the repository). `workCheckoutScript` puts it on the branch
 * afterwards. Neither step needs a token, and neither gets one.
 *
 * `wlp:dir <directory>` says where the clone is, relative to the workspace: "." or `directory`.
 */
export function cloneScript(url: string, branch: string, directory: string, work?: string, pinnedBase?: string): string {
	if (pinnedBase !== undefined && !/^[0-9a-f]{40}$/.test(pinnedBase)) throw new Error("Invalid setup base SHA.");
	// Review clones need only the base ref. A pinned subtask also restores its feature or published branch.
	const cloneFlags = pinnedBase ? (work ? "--no-checkout " : "--single-branch --no-checkout ") : "";
	const featureRef = shellQuote("refs/remotes/origin/" + branch);
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
		`wlp_git clone --quiet ${cloneFlags}--branch ${shellQuote(branch)} -- ${shellQuote(url)} "$target"`,
		`echo "wlp:dir $target"`,
		PLAIN_GIT,
		...(pinnedBase ? ["WLP_T=", `plain_git -C "$target" checkout -q --detach ${pinnedBase}`] : []),
		`(cd "$target" && {
${saveBase(branch, "plain_git rev-parse --verify " + (work && pinnedBase ? featureRef : "HEAD"))}
})`,
	];
	if (work !== undefined) {
		lines.push(
			"WLP_T=",
			`if at=$(plain_git -C "$target" rev-parse -q --verify ${shellQuote(`refs/remotes/origin/${work}^{commit}`)} 2>/dev/null); then`,
			`	echo "wlp:haswork $at"`,
			"else",
			...(pinnedBase ? [`	at=$(plain_git -C "$target" rev-parse --verify ${featureRef})`, '\techo "wlp:haswork $at"'] : []),
			`	echo "wlp:nowork"`,
			"fi",
		);
	}
	return lines.join("\n");
}

/**
 * Puts the clone in `directory` on the session's branch `work`, at the commit the clone fetched, once
 * the setup command has run on the base (`cloneScript`). Git uses the private repository. `-f` on purpose: what the setup did to tracked files (a
 * lockfile an install rewrote) goes, since the workspace must hold what the session pushed and nothing
 * else; what it made beside them (`node_modules`) stays. `wlp:work <commit>`.
 */
export function workCheckoutScript(directory: string, work: string): string {
	return [
		"set -eu",
		// Check the platform's clone itself, also when it was made under a nonempty workspace.
		`cd ${shellQuote(directory)}`,
		privateStart({ refs: [`refs/heads/${work}`] }),
		`git checkout --quiet -f -B ${shellQuote(work)} ${shellQuote(`refs/remotes/origin/${work}`)}`,
		`bridge export HEAD index ${shellQuote(`refs/heads/${work}`)}`,
		`echo "wlp:work $(git rev-parse HEAD)"`,
	].join("\n");
}

/** Runs `workCheckoutScript`. */
export function checkoutWork(sandbox: SandboxHandle, directory: string, work: string): Promise<GitOutcome> {
	return run(sandbox, workCheckoutScript(directory, work), { stdin: "", timeoutMs: COMMIT_TIMEOUT_MS });
}

/** A prepared reviewer's setup belongs to the pinned base, which can predate the freshly fetched branch tip. */
export function checkoutPreparedReviewBase(sandbox: SandboxHandle, base: string, sha: string): Promise<GitOutcome> {
	if (!isBranchName(base) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid review base");
	const script = [
		privateStart(),
		`git merge-base --is-ancestor ${sha} ${shellQuote("refs/remotes/origin/" + base)}`,
		`git checkout -q -f --detach ${sha}`,
		"bridge export HEAD index",
		saveBase(base, "git rev-parse --verify HEAD"),
		'echo "wlp:work $(git rev-parse HEAD)"',
	].join("\n");
	return run(sandbox, script, { stdin: "", timeoutMs: COMMIT_TIMEOUT_MS });
}

/** Both fetches use fresh private objects and export the requested refs after dropping the token. */
function fetchPrefix(url: string, directory: string, refs: string[]): string[] {
	return [
		"set -eu",
		READ_TOKEN,
		`cd ${shellQuote(directory)}`,
		privateStart({ refs, fetch: true }),
		tokenGit(hostOf(url)),
		// Negotiate from an empty database so the remote supplies the complete history.
		'rm -rf "$private/repo"',
		'plain_git -C "$private" init --quiet --bare --template= "$private/repo"',
		`fetch_ref() { (cd "$private" && wlp_git --git-dir="$private/repo" fetch --quiet --no-tags -- ${shellQuote(url)} "$1"); }`,
	];
}

/** Make origin/<base> and the available work branch visible for the agent to merge. */
export function fetchBaseScript(url: string, base: string, work: string | null = null): string {
	const tracking = (name: string) => `refs/remotes/origin/${name}`;
	const refs = [tracking(base), ...(work === null ? [] : [tracking(work)])];
	const fetch = (name: string) => `fetch_ref ${shellQuote(`+refs/heads/${name}:${tracking(name)}`)}`;
	return [
		...fetchPrefix(url, ".", refs),
		fetch(base),
		`set -- ${shellQuote(tracking(base))}`,
		...(work === null ? [] : [`if ${fetch(work)}; then set -- "$@" ${shellQuote(tracking(work))}; echo "wlp:fetchedwork"; fi`]),
		"WLP_T=",
		'bridge export "$@"',
		saveBase(base, `git rev-parse --verify ${shellQuote(`${tracking(base)}^{commit}`)}`),
		'echo "wlp:fetched"',
	].join("\n");
}

/** Fetch only the pull ref, with a read token isolated from the workspace. */
export function fetchHeadScript(url: string, pr: number, directory = "."): string {
	if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("Invalid pull request number.");
	return [
		...fetchPrefix(url, directory, ["refs/wlp/review"]),
		`fetch_ref '+refs/pull/${pr}/head:refs/wlp/review'`,
		"WLP_T=",
		"bridge export refs/wlp/review",
	].join("\n");
}

export function reviewCheckoutScript(directory: string, head: string): string {
	if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid review head SHA.");
	// Setup has run here, and a retry can reuse a workspace where the reviewer ran commands.
	return [
		"set -eu",
		`cd ${shellQuote(directory)}`,
		privateStart({ refs: ["refs/wlp/review"] }),
		VERIFY_OBJECTS,
		`[ "$(git rev-parse --verify 'refs/wlp/review^{commit}')" = ${head} ] && git cat-file -e '${head}^{commit}' || { echo wlp:missing; exit 1; }`,
		`git checkout -q -f --detach ${head}`,
		`git reset -q --hard ${head}`,
		"git clean -q -fd",
		"rm -rf -- .wlp-shots",
		"bridge export HEAD index",
		'echo "wlp:review $(git rev-parse --verify HEAD)"',
	].join("\n");
}

export async function checkoutReview(sandbox: SandboxHandle, url: string, token: string, directory: string, pr: number, head: string, signal?: AbortSignal) {
	const fetch = await run(sandbox, fetchHeadScript(url, pr, directory), { stdin: token + "\n", timeoutMs: PUSH_TIMEOUT_MS, secrets: [token], signal });
	if (!fetch.ok) {
		if (fetch.marks.has("unsafe")) throw new GithubProblem("github_denied", unsafeWorkspace(fetch.marks.get("unsafe")!));
		if (fetch.failure === "denied" || fetch.failure === "gone" || (fetch.failure === "other" && /couldn't find remote ref/i.test(fetch.said))) {
			throw new GithubProblem(fetch.failure === "denied" ? "github_denied" : "github_gone", "the pull request head is unavailable");
		}
		throw new Error("the pull request head could not be fetched");
	}
	const checkout = await run(sandbox, reviewCheckoutScript(directory, head), { stdin: "", timeoutMs: COMMIT_TIMEOUT_MS, signal });
	if (checkout.marks.has("missing") && !checkout.ok && checkout.failure !== "aborted" && checkout.failure !== "timeout") {
		throw new GithubProblem("github_gone", "the pull ref does not identify the expected commit");
	}
	if (!checkout.ok || checkout.marks.get("review") !== head) throw new Error("the checkout of the pull request failed");
}

export async function changedReviewPaths(sandbox: SandboxHandle, directory: string, base: string, head: string): Promise<string[]> {
	if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha))) throw new Error("Invalid review SHA.");
	const script = [
		`cd ${shellQuote(directory)} || exit 1`,
		privateStart(),
		VERIFY_OBJECTS,
		`git diff --no-ext-diff --no-renames --name-only -z ${base}...${head} --`,
	].join("\n");
	const result = await sandbox.run(script, { timeoutMs: COMMIT_TIMEOUT_MS });
	if (result.exitCode !== 0 || result.timedOut || result.aborted || (result.stdout && !result.stdout.endsWith("\0"))) throw new Error("could not read the changed paths");
	return result.stdout.split("\0").filter(Boolean);
}

/** Fetches the base branch with `token`, which is given to the command on its standard input and to nothing else. */
export function fetchWithToken(sandbox: SandboxHandle, token: string, input: { url: string; base: string; work?: string | null }): Promise<GitOutcome> {
	return run(sandbox, fetchBaseScript(input.url, input.base, input.work ?? null), { stdin: `${token}\n`, timeoutMs: PUSH_TIMEOUT_MS, secrets: [token] });
}

/** One commit, scan and push share this directory in the outer mount namespace. */
function handoverDirectory(attempt: string): string {
	return `/tmp/wlp-git-attempt-${attempt.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * Whether the workspace has anything GitHub does not: `wlp:nothing` when its HEAD is the commit last
 * pushed, or, before the first push, a commit the base branch already had when it was cloned.
 */
function nothingNew(base: string, pushed: string | null): string[] {
	const said = `nothing=1; echo "wlp:nothing"`;
	if (pushed !== null) return ["nothing=0", `if [ "$head" = ${shellQuote(pushed)} ]; then ${said}; fi`];
	return [
		baseRecord(base),
		"nothing=0",
		// Older workspaces have no private record. Their tracking ref can suppress an unnecessary push,
		// but outgoingPatch never uses it to exclude commits from the secret check.
		`base_sha=${shellQuote(`refs/remotes/origin/${base}`)}`,
		'if [ -f "$base_file" ]; then IFS= read -r base_sha < "$base_file"; fi',
		`if GIT_NO_REPLACE_OBJECTS=1 git merge-base --is-ancestor "$head" "$base_sha" 2>/dev/null; then ${said}; fi`,
	];
}

/** Only commits the platform observed at GitHub can bound a scan of the outgoing history. */
function outgoingBoundaries(base: string, pushed: string | null): string[] {
	return [
		baseRecord(base),
		"set --",
		...(pushed ? [`if git cat-file -e ${shellQuote(pushed + "^{commit}")}; then set -- ${shellQuote(pushed)}; fi`] : []),
		'if [ -f "$base_file" ]; then IFS= read -r base_sha < "$base_file"; if git cat-file -e "$base_sha^{commit}"; then set -- "$@" "$base_sha"; fi; fi',
	];
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

/** Stage a stable copy of the files against the agent's history; retain the private repo for this push. */
export function commitScript(input: CommitInput, attempt = input.sessionId): string {
	const destination = shellQuote(handoverDirectory(attempt));
	return [
		"set -eu",
		privateStart({ refs: [`refs/heads/${input.branch}`], missing: "norepo" }),
		'cat > "$private/message"',
		"exec </dev/null",
		capture(COMMIT_PATHS),
		// Changing the branch here only changes private refs. Checking out could rewrite the files.
		`if git rev-parse --verify HEAD >/dev/null 2>&1; then git update-ref --no-deref ${shellQuote(`refs/heads/${input.branch}`)} "$(git rev-parse HEAD)"; fi`,
		`git symbolic-ref HEAD ${shellQuote(`refs/heads/${input.branch}`)}`,
		// Keep staged paths (including force-added ignored files), discard workspace stat cache
		// and assume-unchanged/skip-worktree bits. Only captured bytes may supply new blobs.
		'git ls-files --stage -z > "$private/staged"',
		'rm -f "$private/repo/index"',
		`${GIT_ENV} git ${SAFE_FLAGS} --git-dir="$private/repo" --work-tree="$tree" update-index -z --index-info < "$private/staged"`,
		`git add -A -- ${COMMIT_PATHS}`,
		"git rm -r -q -f --cached --ignore-unmatch -- .wlp-shots",
		'if git diff --cached --quiet && [ ! -f "$private/repo/MERGE_HEAD" ]; then',
		"	committed=0",
		"else",
		`	git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c user.name=${shellQuote(input.author.name)} -c user.email=${shellQuote(input.author.email)} commit --quiet --no-verify -F "$private/message"`,
		"	committed=$(git diff-tree --root --no-commit-id --diff-merges=first-parent --name-only -r HEAD | grep -c . || true)",
		"fi",
		`if ! head=$(git rev-parse -q --verify 'HEAD^{commit}'); then echo "wlp:nothing"; exit 0; fi`,
		`echo "wlp:committed $committed"`,
		`echo "wlp:head $head"`,
		...nothingNew(input.base, input.pushed),
		'[ "$nothing" = 0 ] || exit 0',
		VERIFY_OBJECTS,
		...outgoingBoundaries(input.base, input.pushed),
		// An earlier agent commit could contain a screenshot already removed from HEAD.
		// Look up the root entry of each outgoing tree, including either side of a merge.
		"set -o pipefail",
		`git rev-list --no-commit-header --format='%T:.wlp-shots' "$head" --not "$@" | ${GIT_ENV} git ${SAFE_FLAGS} --git-dir="$private/repo" cat-file --batch-check > "$private/shots"`,
		'if grep -qv " missing$" "$private/shots"; then echo "An outgoing commit contains .wlp-shots. Remove it from the commits to push." >&2; exit 1; fi',
		// Only immutable private objects and metadata survive the handover.
		`echo "$head" > "$private/head"; rm -rf "$private/tree" "$private/message"; mv -T "$private" ${destination}`,
	].join("\n");
}

/** Reads the workspace's HEAD and whether GitHub lacks anything, without changing it. No token. */
export function probeScript(base: string, pushed: string | null): string {
	return [
		"set -eu",
		privateStart({ missing: "nothing" }),
		capture(),
		`if ! head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null); then echo "wlp:nothing"; exit 0; fi`,
		`echo "wlp:head $head"`,
		'git status --porcelain=v1 --untracked-files=normal --ignore-submodules=all > "$private/status"',
		'if [ -s "$private/status" ]; then echo "wlp:dirty"; fi',
		...nothingNew(base, pushed),
	].join("\n");
}

/**
 * Push exactly the commit and object database that the platform staged and scanned. After the
 * transport reports its result, install the branch and index if the workspace still matches.
 *
 * With `lease`, the commit the platform itself last pushed to the branch: a push that is refused as no
 * fast-forward is tried once more with `--force-with-lease` on it, so that it may replace that commit and
 * nothing else. A branch the agent rebased goes (`wlp:forced`); a commit anyone else pushed to the branch
 * since makes GitHub refuse it (`wlp:stale`). The plain push comes first, so that a fast-forward over
 * someone else's commit (one the agent merged) is never taken for a rebase.
 */
export function pushScript(attempt: string, url: string, branch: string, lease: string | null = null): string {
	const directory = shellQuote(handoverDirectory(attempt));
	if (lease !== null && !/^[0-9a-f]{40,64}$/.test(lease)) throw new Error("a lease is a commit's full name");
	const target = shellQuote(`refs/heads/${branch}`);
	return [
		"set -eu",
		READ_TOKEN,
		tokenGit(hostOf(url)),
		`private=${directory}`,
		`IFS= read -r sha < "$private/head" || { echo "wlp:nohandover"; exit 4; }`,
		`case "$sha" in *[!0-9a-f]* | "") echo "wlp:nohandover"; exit 4 ;; esac`,
		`send() { (cd "$private" && wlp_git --git-dir="$private/repo" push --porcelain "$@"); }`,
		// One refspec means exactly one porcelain status. "=" is also possible when the lease retry races another push.
		"pushed() {",
		`	status=$(printf '%s\\n' "$said" | awk -F '\\t' 'NF >= 3 {print $1}')`,
		`	case "$status" in`,
		`		'=') echo "wlp:uptodate $sha" ;;`,
		`		'+') echo "wlp:forced"; echo "wlp:pushed $sha" ;;`,
		`		' '|'*') echo "wlp:pushed $sha" ;;`,
		`		*) exit 1 ;;`,
		"	esac",
		"}",
		// A plain push first: a fast-forward goes, whoever else pushed to the branch before.
		`if said=$(send -- ${shellQuote(url)} "$sha:"${target} 2>&1); then pushed; exit 0; fi`,
		...(lease === null
			? []
			: [
					// Refused as no fast-forward (a branch the agent rebased): once more, now replacing the platform's own last push and nothing else.
					`if printf '%s\\n' "$said" | grep -qE 'non-fast-forward|fetch first|\\[rejected\\]'; then`,
					`	if said=$(send ${shellQuote(`--force-with-lease=refs/heads/${branch}:${lease}`)} -- ${shellQuote(url)} "$sha:"${target} 2>&1); then pushed; exit 0; fi`,
					// The lease refused it: what is at GitHub is not the platform's last push.
					`	if printf '%s\\n' "$said" | grep -q 'stale info'; then echo "wlp:stale"; fi`,
					"fi",
				]),
		`printf '%s\\n' "$said" >&2`,
		"exit 1",
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
export function cloneWithToken(sandbox: SandboxHandle, token: string, input: { url: string; branch: string; directory: string; work?: string; pinnedBase?: string; signal?: AbortSignal }): Promise<GitOutcome> {
	return run(sandbox, cloneScript(input.url, input.branch, input.directory, input.work, input.pinnedBase), { stdin: `${token}\n`, timeoutMs: CLONE_TIMEOUT_MS, signal: input.signal, secrets: [token] });
}

// commitAndPush passes the same handle to both steps. Pin the scan to this commit even if HEAD moves.
const attempts = new WeakMap<SandboxHandle, { head: string; sessionId: string; id: string; sent: boolean }>();

/** Commits the workspace's changes on the session's branch. `message` is the commit's whole message. */
export async function commitWork(sandbox: SandboxHandle, input: CommitInput, message: string): Promise<GitOutcome> {
	attempts.delete(sandbox);
	const id = randomBytes(16).toString("hex");
	const result = await run(sandbox, commitScript(input, id), { stdin: message.endsWith("\n") ? message : `${message}\n`, timeoutMs: COMMIT_TIMEOUT_MS });
	const head = result.marks.get("head");
	if (result.ok && head && !result.marks.has("nothing")) {
		attempts.set(sandbox, { head, sessionId: input.sessionId, id, sent: false });
	}
	return result;
}

/** Read the commit handed to the push, excluding only commits the platform observed at GitHub. */
export async function outgoingPatch(sandbox: SandboxHandle, base: string, pushed: string | null): Promise<string | null> {
	const pending = attempts.get(sandbox);
	const limit = 8_000_000;
	const script = [
		"set -eu",
		...(pending ? [] : ["exit 1"]), // A real scan requires the commit step's pinned head.
		`export PATH=${SYSTEM_PATH}`,
		PLAIN_GIT,
		`private=${shellQuote(handoverDirectory(pending?.id ?? ""))}`,
		'git() { plain_git -C "$private" --git-dir="$private/repo" "$@"; }',
		"set -o pipefail",
		...outgoingBoundaries(base, pushed),
		'patch=$(mktemp /tmp/wlp-scan.XXXXXXXX)',
		`trap 'rm -f "$patch"' EXIT`,
		"status=0",
		`GIT_NO_REPLACE_OBJECTS=1 git -c core.quotePath=false log -p -m --text --no-color --no-ext-diff --no-textconv --format='%H%n%B' ${shellQuote(pending?.head ?? "")} --not "$@" -- 2>/dev/null | head -c ${limit} > "$patch" || status=$?`,
		'bytes=$(wc -c < "$patch")',
		`[ "$bytes" -lt ${limit} ] || exit 8`,
		'[ "$status" = 0 ] || exit 1',
		'echo "$bytes"',
		// Preserve arbitrary bytes across UTF-8 chunks. The runner caps buffered stdout but streams it all.
		'base64 -w0 "$patch"',
	].join("\n");
	const chunks: string[] = [];
	const result = await sandbox.run(script, { timeoutMs: PROBE_TIMEOUT_MS, onStdout: (chunk) => chunks.push(chunk) }).catch(() => null);
	const output = chunks.length ? chunks.join("") : (result?.stdout ?? "");
	if (result?.exitCode === 8 || (!pending && Buffer.byteLength(output) >= limit)) {
		if (pending) await discardHandover(sandbox, pending.sessionId);
		throw new GithubProblem("github_failed", "Nothing was pushed. The change is too large to check for saved secrets (8 MB limit).");
	}
	if (!result || result.exitCode !== 0 || result.timedOut || result.aborted) return null;
	// The fake interpreter executes no shell or Git and gives redaction its synthetic diff directly.
	if (!pending) return output;
	const newline = output.indexOf("\n");
	const length = output.slice(0, newline);
	const encoded = output.slice(newline + 1);
	if (newline < 1 || !/^\d+$/.test(length) || encoded.length !== 4 * Math.ceil(Number(length) / 3)) return null;
	return Buffer.from(encoded, "base64").toString("utf8");
}

export function probeWork(sandbox: SandboxHandle, base: string, pushed: string | null): Promise<GitOutcome> {
	return run(sandbox, probeScript(base, pushed), { stdin: "", timeoutMs: PROBE_TIMEOUT_MS });
}

/**
 * Reads the workspace's commit against the branch it started from, without changing anything, for
 * what a pull request says of its changes (verified.ts, `workFlags`): which files changed and how,
 * the changed lines, and the repository's `.windlass/config.json` and `package.json` as they were
 * and as they are. Each part ends with a line only this call knows. No token, and no program of the
 * repository's choosing is run for it: no external diff, no text conversion.
 */
export function workScript(base: string, mark: string): string {
	const diff = "git -c core.quotePath=false -c core.fsmonitor=false diff --no-ext-diff --no-textconv --no-color -M";
	return [
		"set -eu",
		privateStart(),
		"if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi",
		`base=$(git merge-base HEAD ${shellQuote(`refs/remotes/origin/${base}`)} 2>/dev/null) || exit 0`,
		`end() { printf '\\n%s\\n' ${shellQuote(mark)}; }`,
		`${diff} --name-status -z "$base" HEAD | head -c 400000; end`,
		`${diff} -U0 "$base" HEAD | head -c 2000000; end`,
		`for at in "$base" HEAD; do for file in .windlass/config.json package.json; do if git cat-file -e "$at:$file" 2>/dev/null; then echo file; git cat-file blob "$at:$file" | head -c 200000; else echo absent; fi; end; done; done`,
	].join("\n");
}

/** `workScript`'s answer, or null when git did not give one (no repository, no such base, a sandbox that is not running). Never throws. */
export async function readWork(sandbox: SandboxHandle, base: string): Promise<WorkDiff | null> {
	const mark = `wlp-${randomBytes(9).toString("hex")}`;
	const result = await sandbox.run(workScript(base, mark), { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
	if (result === null || result.exitCode !== 0) return null;
	const parts = result.stdout.split(`\n${mark}\n`);
	if (parts.length < 7) return null;
	const names = (parts[0] as string).split("\0");
	const files: WorkDiff["files"] = [];
	for (let index = 0; index + 1 < names.length; index += 2) {
		const status = names[index] as string;
		const path = names[index + 1] as string;
		// A rename or a copy names two paths: where it was, and where it is.
		if (/^[RC]/.test(status)) files.push({ status, path, to: names[(index += 1) + 1] });
		else files.push({ status, path });
	}
	const file = (part: string): string | null => (part.startsWith("file\n") ? part.slice(5) : null);
	return { files, patch: parts[1] as string, config: { before: file(parts[2] as string), after: file(parts[4] as string) }, packageJson: { before: file(parts[3] as string), after: file(parts[5] as string) } };
}

/** Removes what `commitWork` left for a push that is not going to run. Never throws. */
export async function discardHandover(sandbox: SandboxHandle, sessionId: string): Promise<void> {
	const attempt = attempts.get(sandbox);
	if (!attempt || attempt.sessionId !== sessionId) return;
	await sandbox.run(`/bin/rm -rf -- ${shellQuote(handoverDirectory(attempt.id))}`, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
}

/** The receipt for the current serialized publish, including when a later PR operation failed. */
export function actuallyPushed(sandbox: SandboxHandle, head: string): boolean {
	const attempt = attempts.get(sandbox);
	return attempt?.head === head && attempt.sent;
}

/** Pushes what `commitWork` left, with `token` on the command's standard input; `lease` as `pushScript` takes it. */
export async function pushWithToken(sandbox: SandboxHandle, token: string, input: { sessionId: string; url: string; branch: string; lease?: string | null }): Promise<GitOutcome> {
	const attempt = attempts.get(sandbox);
	const id = attempt?.sessionId === input.sessionId ? attempt.id : "missing";
	const result = await run(sandbox, pushScript(id, input.url, input.branch, input.lease ?? null), { stdin: `${token}\n`, timeoutMs: PUSH_TIMEOUT_MS, secrets: [token] });
	if (result.ok && attempt && result.marks.get("pushed") === attempt.head) attempt.sent = true;
	if (result.ok && attempt && attempt.id === id) {
		// Keep the remote receipt even when a competing command moved the workspace refs.
		// The token process has exited. This step has its own timeout and invokes no Git.
		const sync = [
			"set -eu",
			`export PATH=${SYSTEM_PATH}`,
			`private=${shellQuote(handoverDirectory(id))}`,
			`trap 'rm -rf -- "$private"' EXIT`,
			BRIDGE,
			`bridge export HEAD index MERGE_HEAD ${shellQuote(`refs/heads/${input.branch}`)}`,
		].join("\n");
		const local = await run(sandbox, sync, { stdin: "", timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
		if (!local?.ok) result.marks.set("workspacechanged", "");
	} else {
		await discardHandover(sandbox, input.sessionId);
	}
	return result;
}

export const CLONE_MINUTES = CLONE_TIMEOUT_MS / 60_000;
