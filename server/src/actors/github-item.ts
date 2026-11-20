import { config } from "../config.js";
import type { GithubId, ItemState } from "../contract.js";
import { issueComment, recentSubject, type IssueBinding } from "../factory/intake.js";
import { type GithubApp, type GithubUser } from "../github/app.js";
import { contentDigest, readIssue, subjectRead } from "../github/issues.js";

export interface IssueNotice { installationId: GithubId; repositoryId: GithubId; issue: number; senderId: GithubId; action: string }
export interface ObservedIssue { subject: string; by: string; said: string; cancel: "draft" | "before_review" | null }

export async function observeIssue(binding: IssueBinding, notice: IssueNotice, permission: (by: GithubUser) => Promise<string>): Promise<ObservedIssue | undefined> {
	const found = await readIssue(binding.installationId, notice.repositoryId, notice.issue);
	if (!found) return;
	const { app, token, repo, issue } = found;
	if (issue.id !== binding.issueId) return;
	if (notice.action === "edited") {
		const digest = contentDigest(issue);
		if (digest !== binding.contentDigest && recentSubject(issue.updated))
			return { subject: "edit:" + digest, by: "platform", said: "The issue was edited on GitHub after it was filed; the item keeps the text it was filed with.", cancel: null };
		return;
	}
	const transition = await subjectRead(() => app.issueTransition(token, repo, notice.issue, notice.action));
	if (!transition || !recentSubject(transition.at) || transition.at < binding.triggeredAt || transition.author.id !== notice.senderId) return;
	const actor = transition.author;
	const base = { subject: transition.id, by: "github:" + actor.login };
	switch (notice.action) {
		case "unlabeled":
			if (!issue.labels.includes("windlass")) return { ...base, said: `@${actor.login} removed the windlass label on GitHub.`, cancel: "draft" };
			break;
		case "closed":
			if (issue.state === "closed") {
				const writer = actor.id === binding.senderId || await permission(actor) === "write";
				return { ...base, said: `The issue was closed on GitHub by @${actor.login}.`, cancel: writer ? "before_review" : null };
			}
			break;
		case "deleted":
		case "transferred":
			return { ...base, said: "The issue was deleted (or moved) on GitHub.", cancel: "before_review" };
	}
}

export async function writeIssueComment(app: GithubApp, repo: { id: GithubId; owner: string; name: string }, binding: IssueBinding,
	itemId: string, state: ItemState, pr: number | undefined, commentId?: string) {
	const number = binding.origin.issue.number;
	const body = issueComment(itemId, binding.origin, state, pr, `${config.origins[0]}/items/${itemId}`);
	const marker = body.split("\n", 1)[0];
	return app.withToken(binding.installationId, { repositoryId: repo.id, permissions: { metadata: "read", issues: "write" } }, async token => {
		if (!commentId) {
			const comments = await app.issueComments(token, repo.owner, repo.name, number, true);
			const own = comments.find(one => one.author.toLowerCase() === app.settings.slug.toLowerCase() + "[bot]" && one.body.startsWith(marker + "\n"));
			if (own && !own.id) throw new Error("GitHub returned no issue comment id");
			if (own?.body === body) return own.id!;
			commentId = own?.id ?? undefined;
		}
		if (commentId) {
			await app.updateIssueComment(token, repo.owner, repo.name, commentId, body, "update the work item link");
			return commentId;
		}
		const id = await app.createIssueComment(token, repo.owner, repo.name, number, body, "post the work item link");
		if (!id) throw new Error("GitHub returned no issue comment id");
		return id;
	});
}
