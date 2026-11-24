import { GithubError, type GithubApp } from "./app.js";

export function featureBranch(item: string) {
	if (!/^i_[a-z0-9]+$/.test(item)) throw new Error("Invalid feature identity.");
	return "windlass/feature-" + item;
}

export function subtaskBranch(feature: string, key: string, child: string) {
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key) || !/^i_[a-z0-9]+$/.test(child)) throw new Error("Invalid subtask identity.");
	// A revised plan may reuse a key. Its new session must never overwrite the old branch.
	return featureBranch(feature) + "-" + key + "-" + child;
}

const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;
function sha(v: unknown) {
	if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) throw new Error("GitHub did not identify the requested commit.");
	return v;
}
export async function refHead(app: GithubApp, token: string, owner: string, repo: string, ref: string) {
	const path = "/repos/" + owner + "/" + repo + "/git/ref/heads/" + ref.split("/").map(encodeURIComponent).join("/");
	const { body } = await app.call({ path, auth: { bearer: token }, what: "read the branch commit" });
	return sha(obj(obj(body).object).sha);
}
/** Commits reachable from the base branch but absent from this item's exact pushed head. */
export async function commitsBehindBase(app: GithubApp, token: string, owner: string, repo: string, base: string, head: string): Promise<number> {
	const path = `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${sha(head)}`;
	const { body } = await app.call({ path, query: { per_page: 1 }, auth: { bearer: token }, what: "compare the item with its base branch" });
	const behind = obj(body).behind_by;
	if (typeof behind !== "number" || !Number.isSafeInteger(behind) || behind < 0) throw new Error("GitHub did not report how far the base branch is ahead.");
	return behind;
}

export async function advanceFeatureRef(app: GithubApp, token: string, owner: string, repo: string, id: string, base: string, head: string) {
	const branch = featureBranch(id);
	if (branch === base) throw new Error("The feature branch must differ from the destination.");
	const path = "/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch;
	const auth = { bearer: token };
	try {
		const { body } = await app.call({ method: "PATCH", path, auth, body: { sha: sha(head), force: false }, what: "fast-forward the feature branch" });
		if (sha(obj(obj(body).object).sha) !== head) throw new Error("GitHub did not confirm the fast-forward.");
		return head;
	} catch (error) {
		if (!(error instanceof GithubError && [409, 422].includes(error.status) && /fast.forward/i.test(error.said))) throw error;
	}
	const merged = await app.call({ method: "POST", path: "/repos/" + owner + "/" + repo + "/merges", auth,
		body: { base: branch, head, commit_message: "Integrate subtask " + head.slice(0, 10) }, what: "merge the verified subtask" });
	// A retry after GitHub accepted the merge but the parent did not record its receipt.
	return merged.status === 204 ? refHead(app, token, owner, repo, branch) : sha(obj(merged.body).sha);
}

/**
 * One empty marker commit gives the draft PR a distinct head. Fixed identity, date and parent make retries identical.
 * `draftOnly` (a cross-repo feature): a repository without draft PRs refuses the feature instead of getting an ordinary PR.
 */
export async function openFeature(app: GithubApp, token: string, owner: string, repo: string, input: { id: string; title: string; base: string; seed: string; created: number; body: string; author: { name: string; email: string }; draftOnly?: boolean }) {
	const branch = featureBranch(input.id), root = "/repos/" + owner + "/" + repo, auth = { bearer: token };
	if (branch === input.base) throw new Error("The feature branch must differ from the destination.");
	const commit = await app.call({ path: root + "/git/commits/" + sha(input.seed), auth, what: "read the feature base tree" });
	const tree = sha(obj(obj(commit.body).tree).sha);
	const author = { ...input.author, date: new Date(input.created).toISOString() };
	const marker = await app.call({ method: "POST", path: root + "/git/commits", auth, body: { tree, parents: [input.seed], author, committer: author, message: "Start feature " + input.id }, what: "create the feature start commit" });
	const head = sha(obj(marker.body).sha);
	try {
		await app.call({ method: "POST", path: root + "/git/refs", auth, body: { ref: "refs/heads/" + branch, sha: head }, what: "create the feature branch" });
	} catch (e) {
		if (!(e instanceof GithubError && e.status === 422) || await refHead(app, token, owner, repo, branch) !== head) throw e;
	}
	let pull = await app.openPull(token, owner, repo, branch, input.base);
	if (!pull) {
		const fields = { title: input.title, body: input.body, head: branch, base: input.base };
		try {
			pull = await app.createPull(token, owner, repo, { ...fields, draft: true });
		} catch (error) {
			if (!(error instanceof GithubError && error.status === 422 && /(?:^|: )draft pull requests are not supported in this repository\.?$/i.test(error.said))) throw error;
			if (input.draftOnly) throw new GithubError(422, `draft pull requests are not supported in ${owner}/${repo}, and a cross-repo feature's pull requests must be drafts`, "open the feature PR");
			pull = await app.createPull(token, owner, repo, { ...fields, draft: false, body: fields.body + "\n\nFeature in progress." });
		}
	}
	if (pull.headSha !== head || pull.base !== input.base) throw new Error("The feature PR changed during creation.");
	return { head, pr: { number: pull.number, url: pull.url } };
}

export async function readyFeature(app: GithubApp, token: string, owner: string, repo: string, number: number, id: string) {
	const auth = { bearer: token };
	const { body } = await app.call({ path: `/repos/${owner}/${repo}/pulls/${number}`, auth, what: "read the feature pull request" });
	if (obj(obj(body).head).ref !== featureBranch(id)) throw new Error("The pull request no longer belongs to the feature branch.");
	if (!obj(body).draft) return;
	const path = app.settings.apiUrl.endsWith("/api/v3") ? "/../graphql" : "/graphql";
	const result = await app.call({ method: "POST", path, auth, what: "mark the feature PR ready for review", body: {
		query: "mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { isDraft } } }", variables: { id: obj(body).node_id },
	} });
	if (obj(obj(obj(obj(result.body).data).markPullRequestReadyForReview).pullRequest).isDraft !== false) throw new Error("GitHub did not confirm the PR is ready for review.");
}
