import { record, type GithubApp, type Repository } from "../github/app.js";
import { checkGuide, guideTree, isGuide } from "./guide-check.js";

export const GUIDE_CHECK = "windlass/guides";

async function findings(app: GithubApp, token: string, repo: Repository, sha: string) {
	let paths: string[] = [];
	let wanted: string[] = [];
	const scan = await app.scanFiles(token, repo.owner, repo.name, sha, (tree, truncated) => {
		paths = tree.filter(f => f.type === "blob").map(f => f.path);
		wanted = paths.filter(p => isGuide(p) || /(?:^|\/)package\.json$/.test(p));
		return {
			paths: wanted.slice(0, 160),
			more: truncated || wanted.length > 160,
			maxFileBytes: 128 * 1024,
			maxBytes: 4 * 1024 * 1024,
		};
	});
	if (scan.commit !== sha || scan.incomplete || scan.files.length !== wanted.length)
		throw Error("The guide check could not read the complete set of guides and manifests.");
	const files = new Map(scan.files.map(f => [f.path, f.text]));
	const tree = guideTree(paths, p => files.get(p));
	return scan.files.filter(f => isGuide(f.path)).flatMap(f => checkGuide(f.path, f.text, tree));
}

export async function postGuideCheck(
	app: GithubApp,
	token: string,
	repo: Repository,
	base: string,
	head: string,
	branchPull: boolean,
	enabled: () => Promise<boolean>,
) {
	const id = await app.findCheckRun(token, repo.owner, repo.name, head, "guides", GUIDE_CHECK);
	if (branchPull) {
		// A branch awaiting review need not contain the latest changes on the default branch.
		const { body } = await app.call({
			path: `/repos/${repo.owner}/${repo.name}/compare/${base}...${head}`,
			query: { per_page: 1 },
			auth: { bearer: token },
			what: "find the shared base of the pull request",
		});
		const shared = record(record(body).merge_base_commit).sha;
		if (typeof shared !== "string" || !/^[a-f0-9]{40}$/.test(shared))
			throw Error("The guide check could not locate the shared repository revision.");
		base = shared;
	}
	const [before, after] = await Promise.all([findings(app, token, repo, base), findings(app, token, repo, head)]);
	// Moving a paragraph does not introduce a finding. Match occurrences, including repeated references.
	const existing = new Map<string, number>();
	const key = (f: (typeof before)[number]) => JSON.stringify([f.path, f.message]);
	for (const f of before) existing.set(key(f), (existing.get(key(f)) ?? 0) + 1);
	const added = after.filter(f => {
		const count = existing.get(key(f)) ?? 0;
		if (!count) return true;
		existing.set(key(f), count - 1);
		return false;
	});
	const older = after.length - added.length;
	const summary = [
		`${older} older finding${older === 1 ? "" : "s"}.`,
		...added.slice(0, 20).map(f => `${f.path}:${f.line} — ${f.message}`),
	]
		.join("\n")
		.slice(0, 3900);
	const at = new Date().toISOString(),
		url = app.repositoryUrl(repo.owner, repo.name);
	const conclusion = added.length ? "failure" : "success";
	const update = {
		status: "completed" as const,
		conclusion,
		started_at: at,
		completed_at: at,
		external_id: "guides:" + head,
		details_url: url + "/commit/" + head,
		output: { title: added.length ? "New broken guide references" : "No new broken guide references", summary },
	} as const;
	if (!(await enabled())) return null;
	const runId = id ?? (await app.createCheckRun(token, repo.owner, repo.name, head, update, GUIDE_CHECK));
	if (id) await app.updateCheckRun(token, repo.owner, repo.name, id, update);
	return { conclusion, url: url + "/runs/" + runId, title: update.output.title };
}
