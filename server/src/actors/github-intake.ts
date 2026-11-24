/** The user decides intake on their own budget. Only lookup keys cross the webhook boundary. */
import { contentDigest, readIssue, subjectRead } from "../github/issues.js";
import { mayUse } from "../access.js";
import { readAccountDefaults } from "../account-defaults.js";
import { serviceParams } from "../auth.js";
import { accountLimits } from "../user-limits.js";
import { config } from "../config.js";
import type { ItemSummary, UserProfile } from "../contract.js";
import { savedPlace } from "../factory/default-place.js";
import { issueMode, recentSubject, refusals, taskOfIssue, type IntakeTrigger, type IssueFiling } from "../factory/intake.js";
import type { GithubApp, Repository } from "../github/app.js";
import { isAddressed } from "../github/events.js";
import { readDefaults } from "../repository-defaults.js";
import type { IssueClaim, IssueDecision } from "./github-repository.js";
import { isActorGone, itemActor } from "./internal.js";
import type { ItemsCtx } from "./user-items.js";

async function command(app: GithubApp, token: string, repo: Repository, trigger: IntakeTrigger) {
	if (trigger.via === "label") {
		const event = await app.issueTransition(token, repo, trigger.issue, "labeled", trigger.label);
		return event && { ...event, note: "" };
	}
	const comment = await app.issueCommand(token, repo, trigger.issue, trigger.commentId);
	if (!comment) return null;
	const note = isAddressed(comment.body, app.settings.slug);
	return note === null ? null : { ...comment, note };
}

async function refusal(app: GithubApp, repo: Repository, t: IntakeTrigger, generation: number, reason: string) {
	const marker = `<!-- windlass-issue-refusal:${t.issue}:${generation} -->`;
	await app.withToken(t.installationId, { repositoryId: repo.id, permissions: { metadata: "read", issues: "write" } }, async token => {
		const comments = await app.issueComments(token, repo.owner, repo.name, t.issue, true);
		if (!comments.some(c => c.author.toLowerCase() === app.settings.slug.toLowerCase() + "[bot]" && c.body.startsWith(marker + "\n")))
			await app.createIssueComment(token, repo.owner, repo.name, t.issue, marker + "\n" + reason, "post the intake refusal");
	});
}

async function existingItem(c: ItemsCtx, uid: string, id: string) {
	try { return await itemActor(c, uid, id).internalSummary(); }
	catch (error) { if (!isActorGone(error) && (error as { code?: string })?.code !== "item_not_found") throw error; }
}

/** The one cap on items filed from GitHub: how many a day, drafts among them. A flood of labelled issues stops here. */
async function quotaRefusal(c: ItemsCtx, resuming?: string) {
	const filed = [...c.vars.items.items.values()].filter(i => i.source === "github" && !i.parent);
	const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
	const { githubItemsPerDay } = accountLimits(c.vars.items.limits).factory;
	const unindexed = "FROM github_item_keys k WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id=k.id)";
	const [pending] = await c.db.execute<{ count: number; reserved: number }>(
		`SELECT count(*) AS count, count(CASE WHEN id=? THEN 1 END) AS reserved ${unindexed} AND created_at >= ? AND created_at < ?`,
		resuming ?? null, midnight, midnight + 86_400_000);
	if (!pending.reserved && filed.filter(i => i.createdAt >= midnight && i.createdAt < midnight + 86_400_000).length + pending.count >= githubItemsPerDay) return refusals.daily(githubItemsPerDay);
	return null;
}

export async function githubIntake(c: ItemsCtx, t: IntakeTrigger, itemId: (key: string) => string,
	file: (profile: UserProfile, filing: IssueFiling) => Promise<ItemSummary>) {
	const { profile, github } = c.vars;
	const connected = () => c.vars.github?.webhookLinked && c.vars.github.user.id === t.senderId && c.vars.github.installations.some(i => i.id === t.installationId);
	if (!profile || !github || !connected() || !mayUse(profile, config.access)) return;
	const params = { params: serviceParams() };
	const directory = c.client().githubRepository.getOrCreate([String(t.repositoryId)], params);
	let claim: IssueClaim | null = await directory.internalIssueClaim(t.issue);
	if (claim && claim.installation !== String(t.installationId)) return;
	const access = await directory.internalIssuePermission(t.installationId, github.user);
	// A reader's command gets no reply and costs no subject or repository read.
	if (access !== "write" && (t.via === "mention" || access !== "read")) return;
	const found = await readIssue(t.installationId, t.repositoryId, t.issue);
	if (!found || found === "gone" || "movedIssueId" in found) return;
	const { app, token, repo, issue } = found;
	if (issue.state !== "open" || (t.via === "label" && !issue.labels.includes(t.label ?? "windlass"))) return;
	const subject = await subjectRead(() => command(app, token, repo, t));
	if (!subject || !recentSubject(subject.at) || subject.author.id !== t.senderId || !connected()) return;
	let reason = !config.items ? refusals.off : access === "read" ? refusals.read : repo.archived ? refusals.archived : null;
	const uid = profile.uid;
	// A newer genuine trigger may arrive while an accepted filing is between actor calls.
	// Complete its snapshot before deciding this trigger, including when the earlier label is gone.
	if (!reason && claim?.pending && claim.uid === uid) {
		const pending: IssueDecision = await directory.internalDecideIssue({ issue: t.issue, installation: t.installationId, uid,
			subject: claim.subject, previous: claim.generation, decision: { kind: "ignore" } });
		if (pending.kind !== "file" || pending.filing.binding.issueId !== issue.id) return;
		if (!c.vars.items.items.has(claim.itemId) && !await existingItem(c, uid, claim.itemId) && await quotaRefusal(c, claim.itemId)) return;
		if (!connected()) return;
		await file(profile, pending.filing);
		await directory.internalFinishIssue(t.issue, claim.subject);
		if (claim.subject === subject.id) return;
		claim = { ...claim, pending: 0 };
	}
	const generation = (claim?.generation ?? 0) + 1;
	let decision: IssueDecision = { kind: "ignore" };
	let create = !claim;
	if (!reason && claim?.pending && claim.uid !== uid) reason = refusals.other;
	if (!reason && claim && !claim.pending) {
		const current = await existingItem(c, claim.uid, claim.itemId);
		create = !current || current.state === "done" || current.state === "cancelled";
		if (!create && claim.uid !== uid) reason = refusals.other;
		else if (current?.state === "failed") decision = { kind: "retry", itemId: claim.itemId };
	}
	if (!reason && create) {
		const { task, trusted } = taskOfIssue({ ...issue, sender: subject.author, note: subject.note });
		const { mode, reason: modeReason, refusal } = issueMode(subject.note, issue.labels, process.env.WLP_FACTORY_ORCHESTRATE !== "0");
		reason = refusal ?? await quotaRefusal(c);
		if (!reason) {
			const key = `github:${repo.id}#${issue.number}:${generation}`;
			const defaults = await readDefaults(c.db, "github:" + repo.id);
			const account = await readAccountDefaults(c.db);
			const defaultPlace = savedPlace(defaults, account);
			const binding = { ...(defaultPlace && { defaultPlace }), modeReason, triggerLabel: t.via === "label" ? t.label : undefined, installationId: t.installationId, generation, triggeredAt: subject.at, senderId: subject.author.id, issueId: issue.id, contentDigest: contentDigest(issue),
				origin: { issue: { number: issue.number, url: issue.url, author: issue.author.login, trusted }, sender: subject.author.login } };
			decision = { kind: "file", itemId: itemId(key), filing: { binding, input: { ...task, mode, repository: { id: repo.id, branch: repo.defaultBranch },
				profile: defaults.profile ?? account.profile ?? undefined, model: defaults.model ?? account.model ?? undefined, start: trusted, idempotencyKey: key } } };
		}
	}
	if (reason) decision = { kind: "refuse", reason, generation: create ? generation : claim?.generation ?? 1 };
	const result: IssueDecision = await directory.internalDecideIssue({ issue: t.issue, installation: t.installationId, uid, subject: subject.id, previous: claim?.generation ?? 0, decision });
	if (!connected()) return;
	if (result.kind === "file") {
		if (access !== "write" || !config.items || repo.archived) return;
		await file(profile, result.filing);
	} else if (result.kind === "retry") {
		if (access !== "write" || !config.items || repo.archived) return;
		await c.client().workItem.get([uid, result.itemId], params).internalGithubRetry({ subject: subject.id, installationId: t.installationId, by: subject.author });
	} else if (result.kind === "refuse") await refusal(app, repo, t, result.generation, result.reason);
	else return;
	await directory.internalFinishIssue(t.issue, subject.id);
}
