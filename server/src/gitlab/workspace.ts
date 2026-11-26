import type { SessionRepository } from "../contract.js";
import type { SandboxHandle } from "../sandbox/api.js";
import { cloneWithToken, fetchWithToken, mergeBaseForCi, pushWithToken, unsafeWorkspace, type GitOutcome } from "../github/git.js";
import { BaseMergeConflict, scannedPush, type PushInput, type StoredRepository } from "../github/publish.js";
import { GithubProblem } from "../github/repos.js";
import { GitlabError, record, text } from "./app.js";
import { gitlabApp } from "./connect.js";

export interface GitlabAccess { project: SessionRepository; viewer: string; token: string }

/** Resolve the transport path by immutable project ID: the selected path might since have been reassigned. */
async function remote(access: GitlabAccess, repo: StoredRepository) {
	const app = gitlabApp();
	if (!app || repo.provider !== "gitlab" || access.project.provider !== "gitlab" || String(access.project.id) !== String(repo.id) ||
		repo.url !== app.cloneUrl(repo.owner, repo.name).slice(0, -4)) throw new Error("GitLab project unavailable.");
	const root = `/projects/${repo.id}`, token = access.token;
	const project = record((await app.call({ path: root, token })).body);
	const parts = text(project.path_with_namespace).split("/"), name = parts.pop();
	if (String(project.id) !== String(repo.id) || !name || !parts.length) throw new Error("GitLab project unavailable.");
	return { url: app.cloneUrl(parts.join("/"), name), name, async base() {
		const ref = record((await app.call({ path: `${root}/repository/branches/${encodeURIComponent(repo.branch)}`, token })).body);
		const sha = text(record(ref.commit).id);
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitLab did not confirm the repository base.");
		return sha;
	} };
}

function failure(outcome: GitOutcome): GithubProblem {
	const unsafe = outcome.marks.get("unsafe");
	if (unsafe !== undefined) return new GithubProblem("github_failed", unsafeWorkspace(unsafe));
	return new GithubProblem(["timeout", "unreachable"].includes(outcome.failure ?? "") ? "github_unreachable" : "github_failed", `GitLab Git transport failed (${outcome.failure ?? "unknown"}).`);
}

export async function cloneGitlab(access: GitlabAccess, repo: StoredRepository, sandbox: SandboxHandle, signal: AbortSignal, work?: string, pinnedBase?: string) {
	const dest = await remote(access, repo);
	const clone = await cloneWithToken(sandbox, access.token, { url: dest.url, directory: dest.name, branch: repo.branch, signal, work, pinnedBase, username: "oauth2" });
	if (signal.aborted || clone.failure === "aborted") return false;
	if (!clone.ok) throw failure(clone);
	const base = !work && pinnedBase ? pinnedBase : await dest.base();
	repo.baseSha = clone.marks.get("base") === base ? base : null;
	return { directory: clone.marks.get("dir") || ".", workAt: clone.marks.get("haswork") || null, workGone: clone.marks.has("nowork") };
}

export async function fetchGitlab(access: GitlabAccess, repo: StoredRepository, sandbox: SandboxHandle, work: string | null = null) {
	const dest = await remote(access, repo);
	const fetch = await fetchWithToken(sandbox, access.token, { url: dest.url, base: repo.branch, work, username: "oauth2" });
	if (!fetch.ok) throw failure(fetch);
	const sha = await dest.base();
	repo.baseSha = fetch.marks.get("base") === sha ? sha : null;
	return fetch.marks.has("fetchedwork");
}

export async function pushGitlab(access: GitlabAccess, input: Omit<PushInput, "app" | "connection">, message: string, update?: { head: string; at: number; baseTip?: string }) {
	const { repository, branch, sandbox } = input;
	const dest = await remote(access, repository);
	const author = { name: `GitLab user ${access.viewer}`, email: `${access.viewer}@users.noreply.${new URL(dest.url).hostname}` };
	let expected: string | undefined;
	if (update) {
		if (!await fetchGitlab(access, repository, sandbox, branch) || !repository.baseSha) throw new Error("GitLab did not confirm the branch and its base.");
		const merged = await mergeBaseForCi(sandbox, branch, repository.branch, update.baseTip ?? repository.baseSha, update.head, update.at, author);
		if (merged.ok && merged.marks.has("conflict")) throw new BaseMergeConflict();
		expected = merged.marks.get("head");
		if (!merged.ok || !expected) throw new Error("The GitLab branch could not be updated.");
		input = { ...input, pushed: update.head, lease: null };
	} else repository.baseSha ??= await dest.base();
	return scannedPush(input, message, { author, failure,
		push: attempt => pushWithToken(sandbox, access.token, { attempt, url: dest.url, branch, lease: input.lease, username: "oauth2" }),
		problem: error => new GithubProblem(error instanceof GitlabError && error.unreachable ? "github_unreachable" : "github_failed", "Could not push to GitLab."),
	}, expected);
}
