import { gitlabAccess } from "./internal.js";
import { ciState, type CiReading } from "../codehost/ci.js";
import type { SessionRepository } from "../contract.js";
import { GitlabError } from "../gitlab/app.js";
import { gitlabApp } from "../gitlab/connect.js";
import { mergeKindAllowed, taskKind, type TaskKind } from "../factory/readiness-track.js";
import { resolveCodeHost } from "../codehost/index.js";
import { hostCaps } from "../codehost/capabilities.js";
import type { ItemHost } from "../codehost/item.js";
import type { Pull } from "../codehost/types.js";

/** Resolve the owner's selected project for each effect. Never persist this object (it holds a grant). */
export async function gitlabItemHost(
	c: Parameters<typeof gitlabAccess>[0],
	uid: string,
	repository: SessionRepository,
) {
	const app = gitlabApp();
	if (!app || repository.provider !== "gitlab") throw new Error("GitLab is unavailable.");
	const { project, viewer, token } = await gitlabAccess(c, uid, String(repository.id));
	if (
		project.provider !== "gitlab" ||
		String(project.id) !== String(repository.id) ||
		repository.url !== app.cloneUrl(repository.owner, repository.name).slice(0, -4)
	)
		throw new Error("The GitLab project changed.");
	const { owner, name } = project;
	const host = resolveCodeHost(repository.provider, { id: viewer, accessToken: async () => token, project });
	if (!host) throw new Error("GitLab is unavailable.");
	const target = (head: string) => ({ installationId: viewer, repositoryId: project.id, owner, name, head });
	const pull = (number: number) => host.readPull(token, owner, name, number);
	const pipeline = (head: string, pull?: number) => host.readCi(target(head), { pull });
	const baseTip = (branch: string) => app.branchHead(token, project.id, branch);
	return { app, host, project, viewer, token, owner, name, target, pull, pipeline, baseTip };
}
export type GitlabItemHost = Awaited<ReturnType<typeof gitlabItemHost>>;

/** The item host in the shape every code host shares. The grant is the owner's, not a scoped installation token. */
export function gitlabItem(hub: GitlabItemHost): ItemHost {
	return {
		host: hub.host,
		owner: hub.owner,
		name: hub.name,
		target: hub.target,
		pull: hub.pull,
		webUrl: hub.project.url,
		withToken: (_permissions, step) => step(hub.token),
		ownComment: comment => String(comment.person?.id) === hub.viewer,
		acknowledge: key => gitlabEyes(hub, key),
		caps: hostCaps("gitlab"),
		webhooks: true,
	};
}

export async function gitlabEyes(hub: GitlabItemHost, key: string) {
	const at = key.indexOf(":"),
		kind = key.slice(0, at),
		id = key.slice(at + 1);
	if (kind !== "issue" && kind !== "issue_comment" && kind !== "review_comment")
		throw new Error("Invalid GitLab reaction target.");
	try {
		await hub.host.react(hub.token, hub.project, { kind, id }, "eyes");
	} catch (e) {
		if (!(e instanceof GitlabError && [403, 404, 409].includes(e.status))) throw e;
	}
}

export async function gitlabCi(hub: GitlabItemHost, head: string, number: number, base: string, mergeCheck: boolean) {
	const mr = number ? await hub.pull(number) : null;
	const reading = await hub.pipeline(head, number || undefined);
	const baseSha = (mr?.base === base && mr.baseSha) || null;
	const tip = mergeCheck && baseSha ? await hub.baseTip(base) : undefined;
	return {
		reading,
		prHead: mr?.headSha || null,
		mergeable: mr?.mergeable ?? null,
		baseSha,
		baseTip: tip,
		baseAhead: tip && tip === baseSha && mr?.mergeBaseSha === tip ? 0 : undefined,
	};
}

/**
 * Never infer a merge from the webhook. Reads the MR, its target branch, the pipeline at the reviewed head and the
 * notes, outside the item's write queue. The returned step runs inside it: it rechecks only that the MR still has
 * the reviewed head and base, then merges at that head (GitLab refuses a merge whose head has moved since).
 */
export async function prepareGitlabMerge(
	hub: GitlabItemHost,
	number: number,
	head: string,
	base: string,
	reviewedBase: string | undefined,
	itemId: string,
	kinds?: TaskKind[],
) {
	const mr = await hub.pull(number);
	const reviewed = (pull: Pull) =>
		!!reviewedBase &&
		pull.state === "open" &&
		pull.headSha === head &&
		pull.base === base &&
		pull.baseSha === reviewedBase;
	if (!reviewed(mr) || !mr.mergeable || mr.mergeBaseSha !== reviewedBase || (await hub.baseTip(base)) !== reviewedBase)
		throw new Error("The merge request is not mergeable at the reviewed head and base.");
	const ci: CiReading = await hub.pipeline(head, number);
	if (ci.kind !== "read" || ci.head !== head || ci.truncated || ciState(ci) !== "passed")
		throw new Error("CI no longer passes on the reviewed head.");
	const notes = await hub.host.listComments(hub.token, hub.owner, hub.name, number, true);
	if (
		notes.some(
			n =>
				String(n.person?.id) !== hub.viewer ||
				!(
					n.body.startsWith(`<!-- windlass-item:${itemId} -->\n`) ||
					n.body.startsWith(`<!-- windlass-review:${itemId}:`)
				),
		)
	)
		throw new Error("Merge request feedback requires handover.");
	if (kinds) {
		// As on GitHub: the kind comes from the change itself, and a partial list cannot authorize a merge.
		const paths = await hub.app.changedPaths(hub.token, hub.project.id, reviewedBase!, head);
		if (!mergeKindAllowed(kinds, paths?.length && paths.length < 300 ? taskKind(paths) : null))
			throw new Error("Automatic merge is off for this kind of change.");
	}
	return async () => {
		if (!reviewed(await hub.pull(number))) throw new Error("The merge request changed before merge.");
		await hub.host.mergePull(hub.token, hub.owner, hub.name, number, head, mr.title);
	};
}
