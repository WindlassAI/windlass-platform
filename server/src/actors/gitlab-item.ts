import { gitlabAccess } from "./internal.js";
import { ciState, type CiReading } from "../codehost/ci.js";
import type { SessionRepository } from "../contract.js";
import { GitlabError, record, text } from "../gitlab/app.js";
import { gitlabApp } from "../gitlab/connect.js";
import { mergeKindAllowed, taskKind, type TaskKind } from "../factory/readiness-track.js";
import { resolveCodeHost } from "../codehost/index.js";

/** Resolve the owner's selected project for each effect. Never persist this object (it holds a grant). */
export async function gitlabItemHost(c: Parameters<typeof gitlabAccess>[0], uid: string, repository: SessionRepository) {
	const app = gitlabApp();
	if (!app || repository.provider !== "gitlab") throw new Error("GitLab is unavailable.");
	const { project, viewer, token } = await gitlabAccess(c, uid, String(repository.id));
	if (project.provider !== "gitlab" || String(project.id) !== String(repository.id) || repository.url !== app.cloneUrl(repository.owner, repository.name).slice(0, -4)) throw new Error("The GitLab project changed.");
	const { owner, name } = project;
	const host = resolveCodeHost(repository.provider, { id: viewer, accessToken: async () => token, project });
	if (!host) throw new Error("GitLab is unavailable.");
	const target = (head: string) => ({ installationId: viewer, repositoryId: project.id, owner, name, head });
	const pull = (number: number) => host.readPull(token, owner, name, number);
	const pipeline = (head: string, pull?: number) => host.readCi(target(head), { pull });
	const baseTip = async (branch: string) => {
		const response = await app.call({ token, path: `/projects/${project.id}/repository/branches/${encodeURIComponent(branch)}` });
		const sha = text(record(record(response.body).commit).id);
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitLab did not identify the base commit.");
		return sha;
	};
	return { app, host, project, gitlabUrl: project.url, viewer, token, owner, name, target, pull, pipeline, baseTip };
}
export type GitlabItemHost = Awaited<ReturnType<typeof gitlabItemHost>>;

export async function gitlabEyes(hub: GitlabItemHost, key: string) {
	const at = key.indexOf(":"), kind = key.slice(0, at), id = key.slice(at + 1);
	if (kind !== "issue" && kind !== "issue_comment" && kind !== "review_comment") throw new Error("Invalid GitLab reaction target.");
	try { await hub.host.react(hub.token, hub.project, { kind, id }, "eyes"); }
	catch (e) { if (!(e instanceof GitlabError && [403, 404, 409].includes(e.status))) throw e; }
}

export async function gitlabCi(hub: GitlabItemHost, head: string, number: number, base: string, mergeCheck: boolean) {
	const mr = number ? await hub.pull(number) : null;
	const reading = await hub.pipeline(head, number || undefined);
	const baseSha = mr?.base === base && mr.baseSha || null;
	const tip = mergeCheck && baseSha ? await hub.baseTip(base) : undefined;
	return { reading, prHead: mr?.headSha || null, mergeable: mr?.mergeable ?? null, baseSha, baseTip: tip,
		baseAhead: tip && tip === baseSha && mr?.mergeBaseSha === tip ? 0 : undefined };
}

/** Never infer a merge from the webhook. Re-read the MR, its target branch and the pipeline at the reviewed head. */
export async function gitlabMerge(hub: GitlabItemHost, number: number, head: string, base: string, reviewedBase: string | undefined, itemId: string, beforeMerge?: () => void, kinds?: TaskKind[]) {
	const mr = await hub.pull(number);
	if (!reviewedBase || mr.state !== "open" || !mr.mergeable || mr.headSha !== head || mr.base !== base || mr.baseSha !== reviewedBase || mr.mergeBaseSha !== reviewedBase || await hub.baseTip(base) !== reviewedBase)
		throw new Error("The merge request is not mergeable at the reviewed head and base.");
	const ci: CiReading = await hub.pipeline(head, number);
	if (ci.kind !== "read" || ci.head !== head || ci.truncated || ciState(ci) !== "passed") throw new Error("CI no longer passes on the reviewed head.");
	const notes = await hub.host.listComments(hub.token, hub.owner, hub.name, number, true);
	if (notes.some(n => String(n.person?.id) !== hub.viewer || !(n.body.startsWith(`<!-- windlass-item:${itemId} -->\n`) || n.body.startsWith(`<!-- windlass-review:${itemId}:`)))) throw new Error("Merge request feedback requires handover.");
	if (kinds) {
		// As on GitHub: the kind comes from the change itself, and a partial list cannot authorize a merge.
		const paths = await hub.app.changedPaths(hub.token, hub.project.id, reviewedBase, head);
		if (!mergeKindAllowed(kinds, paths?.length && paths.length < 300 ? taskKind(paths) : null)) throw new Error("Automatic merge is off for this kind of change.");
	}
	beforeMerge?.();
	await hub.host.mergePull(hub.token, hub.owner, hub.name, number, head, mr.title);
}
