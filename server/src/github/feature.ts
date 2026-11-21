import { GithubError, type GithubApp } from "./app.js";

export function featureBranch(item: string) {
	if (!/^i_[a-z0-9]+$/.test(item)) throw new Error("Invalid feature identity.");
	return "windlass/feature-" + item;
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
export async function advanceFeatureRef(app: GithubApp, token: string, owner: string, repo: string, id: string, base: string, head: string) {
	const branch = featureBranch(id);
	if (branch === base) throw new Error("The feature branch must differ from the destination.");
	const path = "/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch;
	const { body } = await app.call({ method: "PATCH", path, auth: { bearer: token }, body: { sha: sha(head), force: false }, what: "fast-forward the feature branch" });
	if (sha(obj(obj(body).object).sha) !== head) throw new Error("GitHub did not confirm the fast-forward.");
}

/** One empty marker commit gives the draft PR a distinct head. Fixed identity, date and parent make retries identical. */
export async function openFeature(app: GithubApp, token: string, owner: string, repo: string, input: { id: string; title: string; base: string; seed: string; created: number; body: string }) {
	const branch = featureBranch(input.id), root = "/repos/" + owner + "/" + repo, auth = { bearer: token };
	if (branch === input.base) throw new Error("The feature branch must differ from the destination.");
	const commit = await app.call({ path: root + "/git/commits/" + sha(input.seed), auth, what: "read the feature base tree" });
	const tree = sha(obj(obj(commit.body).tree).sha);
	const author = { name: "Windlass", email: "windlass@users.noreply.github.com", date: new Date(input.created).toISOString() };
	const marker = await app.call({ method: "POST", path: root + "/git/commits", auth, body: { tree, parents: [input.seed], author, committer: author, message: "Start feature " + input.id }, what: "create the feature start commit" });
	const head = sha(obj(marker.body).sha);
	try {
		await app.call({ method: "POST", path: root + "/git/refs", auth, body: { ref: "refs/heads/" + branch, sha: head }, what: "create the feature branch" });
	} catch (e) {
		if (!(e instanceof GithubError && e.status === 422) || await refHead(app, token, owner, repo, branch) !== head) throw e;
	}
	const pull = await app.openPull(token, owner, repo, branch, input.base) ?? await app.createPull(token, owner, repo, { title: input.title, body: input.body, head: branch, base: input.base, draft: true });
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
