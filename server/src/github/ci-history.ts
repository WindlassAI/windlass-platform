import type { CiHistory } from "../factory/readiness.js";
import type { GithubApp, Repository } from "./app.js";

const commitsQuery = `query($owner: String!, $name: String!, $head: GitObjectID!, $since: GitTimestamp!, $after: String) {
	repository(owner: $owner, name: $name) { object(oid: $head) { ... on Commit {
		history(first: 100, since: $since, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes { oid committedDate message parents(first: 1) { totalCount nodes { oid } } statusCheckRollup { state }
				associatedPullRequests(first: 5) { nodes { number title baseRefName mergedAt mergeCommit { oid } } }
			}
		}
	} } }
}`;

interface Commit {
	oid: string; committedDate: string; message: string; parents: { totalCount: number; nodes: { oid: string }[] };
	statusCheckRollup: { state: string } | null;
	associatedPullRequests: { nodes: { number: number; title: string; baseRefName: string; mergedAt: string | null; mergeCommit: { oid: string } | null }[] };
}
interface HistoryPage { nodes: Commit[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
interface Run { id: string; head_branch: string; head_sha: string; run_attempt: number; event: string }
interface Job { name: string; run_attempt: number; head_sha: string; conclusion: string | null }

export async function scanCiHistory(app: GithubApp, token: string, repo: Repository, head: string | null, at: number): Promise<CiHistory> {
	const branch = repo.defaultBranch;
	const history: CiHistory = { at, branch, checked: 0, green: 0, flaky: [], reverts: 0, redMerges: 0, hasCi: false };
	if (!head) return history;
	const auth = { bearer: token }, since = new Date(at - 30 * 86_400_000).toISOString();
	const path = app.settings.apiUrl.endsWith("/api/v3") ? "/../graphql" : "/graphql";
	const commits = new Map<string, Commit>();
	let after: string | null = null;
	for (let page = 0; page < 2; page++) {
		const { body } = await app.call({ method: "POST", path, auth, what: "read commit checks and statuses",
			body: { query: commitsQuery, variables: { owner: repo.owner, name: repo.name, head, since, after } } });
		const response = body as { errors?: unknown[]; data?: { repository?: { object?: { history: HistoryPage } } } };
		const result = response?.data?.repository?.object?.history;
		if (response?.errors?.length || !result) throw Error("Could not read commit history.");
		for (const commit of result.nodes) commits.set(commit.oid, commit);
		if (!result.pageInfo.hasNextPage) break;
		after = result.pageInfo.endCursor;
	}
	const reverts = new Set<string>();
	const originals = [...commits.values()].flatMap(c => c.associatedPullRequests.nodes.filter(p => p.mergedAt && p.baseRefName === branch && !/^Revert\s/i.test(p.title)));
	for (const commit of commits.values()) {
		const pulls = commit.associatedPullRequests.nodes.filter(p => p.baseRefName === branch && p.mergedAt && p.mergedAt >= since && /^Revert\s/i.test(p.title));
		for (const pull of pulls) reverts.add("pr-" + pull.number);
		const direct = /^Revert ".*"/.test(commit.message) || /^This reverts commit\b/m.test(commit.message);
		if (!pulls.length && direct) reverts.add(commit.oid);
		if (!pulls.length && !direct) continue;
		const sha = /^This reverts commit ([0-9a-f]{7,40})\b/im.exec(commit.message)?.[1];
		const title = /^Revert "(.+)"(?: \(#\d+\))?$/m.exec(commit.message)?.[1] ?? /^Revert "(.+)"$/.exec(pulls[0]?.title ?? "")?.[1];
		const byTitle = [...new Set(originals.filter(p => p.title === title).map(p => p.number))];
		const pr = (sha && originals.find(p => p.mergeCommit?.oid.startsWith(sha))?.number) ||
			Number(title?.match(/\(#(\d+)\)$/)?.[1] ?? title?.match(/^Merge pull request #(\d+)\b/i)?.[1] ?? (pulls[0]?.title ?? commit.message).match(/^Revert (?:pull request )?#(\d+)\b/i)?.[1]) || (byTitle.length === 1 && byTitle[0]);
		if (pr) (history.revertedPulls ??= {})[pr] = Math.max(history.revertedPulls?.[pr] ?? 0, Date.parse(pulls[0]?.mergedAt ?? commit.committedDate));
	}
	history.reverts = reverts.size;
	// Follow the first parent so checks on a side branch never count as checks on main.
	for (let commit = commits.get(head); commit; commit = commits.get(commit.parents.nodes[0]?.oid ?? "")) {
		const { oid } = commit;
		const state = commit.statusCheckRollup?.state;
		if (state) history.hasCi = true;
		if (state !== "SUCCESS" && state !== "FAILURE" && state !== "ERROR") continue;
		history.checked++;
		if (state === "SUCCESS") history.green++;
		else if (commit.parents.totalCount > 1 || commit.associatedPullRequests.nodes.some(p => p.baseRefName === branch && p.mergeCommit?.oid === oid && p.mergedAt))
			history.redMerges++;
	}

	const runsPath = `/repos/${repo.owner}/${repo.name}/actions/runs`;
	const { body } = await app.call({ path: runsPath, auth, query: { per_page: 100, created: ">=" + since }, what: "read workflow runs" });
	const counts = new Map<string, number>();
	for (const run of (body as { workflow_runs: Run[] }).workflow_runs) {
		const itemPush = run.event === "push" && run.head_branch.startsWith("windlass/");
		if (run.head_branch !== branch && !itemPush && !["pull_request", "pull_request_target"].includes(run.event)) continue;
		history.hasCi = true;
		if (run.run_attempt < 2) continue;
		const jobs = await app.pages({ path: `${runsPath}/${run.id}/jobs`, auth, query: { filter: "all" }, what: "read workflow attempts" },
			body => (body as { jobs: Job[] }).jobs);
		if (jobs.truncated) throw Error("Could not read all workflow attempts.");
		const failed = new Map<string, number>();
		for (const job of jobs.items.sort((a, b) => a.run_attempt - b.run_attempt)) {
			if (job.head_sha !== run.head_sha) continue;
			if (job.conclusion === "failure") failed.set(job.name, job.run_attempt);
			if (job.conclusion === "success" && (failed.get(job.name) ?? Infinity) < job.run_attempt) {
				counts.set(job.name, (counts.get(job.name) ?? 0) + 1);
				failed.delete(job.name);
			}
		}
	}
	history.flaky = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	return history;
}
