/**
 * What the two intakes that file work items from an issue share: GitHub's (github-intake.ts) and Linear's (below).
 * One owner queue, one daily cap with its reservations, one reading of the saved placement and defaults, one way to turn
 * text into a task and a mode (factory/intake.ts). Neither shares anything with an item filed on the web or by API key.
 *
 * What stays GitHub's: the issue's claim in the repository directory, the permission and subject reads, the refusal
 * comment, and everything an item does with its issue afterwards (the binding of work-item.ts). A Linear item has none of that:
 * its provenance is kept apart in `LinearBinding`.
 */

import { gitlabApp } from "../gitlab/connect.js";
import { GitlabError, record, text } from "../gitlab/app.js";
import { gitlabCodeHost } from "../gitlab/host.js";
import { decimalId } from "../gitlab/ids.js";
import type { GitlabDelivery } from "../gitlab/webhook.js";
import { mayUse } from "../access.js";
import { config } from "../config.js";
import type { CreateItemInput, GithubId, ItemSummary, UserProfile } from "../contract.js";
import { issueMode, linearIdentifier, linearId, linearName, refusals, taskOfLinear, taskOfText, type GitlabBinding, type LinearBinding, type LinearFiled, type LinearFiling } from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository } from "../github/repos.js";
import { QUICK_LABELS } from "../linear/webhook.js";
import { accountLimits } from "../user-limits.js";
import { gitlabAccess, isActorGone, itemActor } from "./internal.js";
import type { ItemsCtx, ItemsState } from "./user-items.js";

/** The sources of an item filed from an issue: the ones that share the queue, the cap and the reservations. */
export const INTAKE_SOURCES: ReadonlySet<ItemSummary["source"]> = new Set(["github", "gitlab", "linear"]);

/** The in-memory scope of an issue-filed creation's key (`ItemsState.created`): apart from the web's and the API's, with one namespace for both trackers (their keys differ in form). */
export const intakeScope = (key: string) => "intake:" + key;

const queues = new WeakMap<ItemsState, Promise<unknown>>();

/**
 * Runs a filing after every earlier one of this user's, whichever tracker it came from: all share the user's budget, so
 * the cap is read and the reservation made one filing at a time. A filing that fails does not hold up the next.
 */
export function inIntakeQueue<T>(c: ItemsCtx, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(c.vars.items) ?? Promise.resolve()).then(job);
	queues.set(c.vars.items, next.catch(() => {}));
	return next;
}

export async function existingItem(c: ItemsCtx, uid: string, id: string) {
	try { return await itemActor(c, uid, id).internalSummary(); }
	catch (error) { if (!isActorGone(error) && (error as { code?: string })?.code !== "item_not_found") throw error; }
}

/**
 * The one cap on items filed from an issue: how many a day, GitHub's and Linear's together, drafts among them. A flood of
 * labelled issues stops here. A filing interrupted after its key was reserved counts as filed (`github_item_keys` rows the
 * index does not have yet), and `resuming` is the id of one that is being finished, which the cap does not refuse again.
 */
export async function quotaRefusal(c: ItemsCtx, resuming?: string, from = "GitHub") {
	const filed = [...c.vars.items.items.values()].filter(i => INTAKE_SOURCES.has(i.source) && !i.parent);
	const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
	const { githubItemsPerDay } = accountLimits(c.vars.items.limits).factory;
	const unindexed = "FROM github_item_keys k WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id=k.id)";
	const [pending] = await c.db.execute<{ count: number; reserved: number }>(
		`SELECT count(*) AS count, count(CASE WHEN id=? THEN 1 END) AS reserved ${unindexed} AND created_at >= ? AND created_at < ?`,
		resuming ?? null, midnight, midnight + 86_400_000);
	if (!pending.reserved && filed.filter(i => i.createdAt >= midnight && i.createdAt < midnight + 86_400_000).length + pending.count >= githubItemsPerDay) return refusals.daily(githubItemsPerDay, from);
	return null;
}

export function intakeInput(task: { title: string; body: string; acceptance: string[] }, mode: "single" | "orchestrate", repository: { id: GithubId; branch: string }, start: boolean, key: string): CreateItemInput {
	return { ...task, mode, repository, start, idempotencyKey: key };
}

export const isEnded = (item: Pick<ItemSummary, "state">) => item.state === "done" || item.state === "failed" || item.state === "cancelled";

/** The key of a Linear issue's nth filing. Reserved with the same table as GitHub's, and told apart from them by its form. */
export const linearKey = (issueId: string, generation: number) => `linear:${issueId}:${generation}`;

/**
 * Files a Linear issue as a work item on its team's repository, in the queue and under the cap that GitHub's intake uses.
 *
 * `filing` is what the platform validated: the signed event, the issue as Linear has it, its team's mapping. This checks what
 * the owner's own account decides (may they use Windlass, work items on, the repository still writable through their GitHub
 * connection, the day's cap) and files, or says why not.
 *
 * One Linear issue is one active item: a second qualifying event while its item is open, or a repeat of the one that filed it,
 * files nothing (`exists`). Once the item is done, failed or cancelled, the next qualifying event files a new one (generation + 1).
 * A filing interrupted after its key was reserved is finished by the next call, whatever the issue says by then.
 *
 * Call it inside `inIntakeQueue`.
 */
export async function fileLinearIssue(c: ItemsCtx, f: LinearFiling,
	file: (profile: UserProfile, filing: { input: CreateItemInput; binding: LinearBinding }) => Promise<ItemSummary>): Promise<LinearFiled> {
	const { profile } = c.vars;
	const { issue, trigger, team } = f;
	const well = issue && trigger && team && f.repository && f.owner
		&& linearId(issue.id) && linearIdentifier(issue.identifier) && linearId(team.id) && linearId(team.workspaceId) && linearId(f.owner.linearUserId)
		&& isGithubId(f.repository.id) && (trigger.via === "label" || trigger.via === "assignment") && Number.isFinite(trigger.at)
		&& linearId(trigger.sender?.id) && typeof issue.title === "string" && typeof issue.description === "string" && Array.isArray(issue.labels)
		&& (issue.creator === null || (linearId(issue.creator?.id) && typeof issue.creator.name === "string"))
		&& typeof issue.url === "string" && /^https:\/\/[^\s/]+\//.test(issue.url);
	if (!well) return { kind: "refused", reason: "The Linear issue was not well formed." };
	if (!profile || !mayUse(profile, config.access)) return { kind: "ignored", why: "The owner may not use Windlass here." };
	if (issue.closed) return { kind: "ignored", why: "The issue is closed in Linear." };
	const uid = profile.uid;

	// The issue's earlier filings, from the keys: those the index holds, and one the index does not yet (an interrupted filing).
	const prefix = intakeScope(`linear:${issue.id}:`);
	const made = [...c.vars.items.created].flatMap(([key, entry]) => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)) ? [{ generation: Number(key.slice(prefix.length)), id: entry.id }] : []);
	const last = made.sort((a, b) => a.generation - b.generation).at(-1);
	const held = last && c.vars.items.items.get(last.id);
	if (last && held && !isEnded(held)) return { kind: "exists", itemId: last.id };
	const resuming = last && !held ? last : undefined;
	if (trigger.lapsed && !resuming) return { kind: "ignored", why: "The issue no longer has what qualified it." };
	const generation = resuming?.generation ?? (last?.generation ?? 0) + 1;

	if (!config.items) return { kind: "refused", reason: refusals.off };
	const app = githubApp(), connection = c.vars.github;
	if (!app || !connection) return { kind: "refused", reason: "Not taken: GitHub is not connected, so there is no repository to file this on." };
	let repository;
	try { repository = (await resolveRepository(app, connection, f.repository.id, "write")).repository; }
	catch (error) {
		// A GitHub that cannot answer is no refusal: the delivery fails and Linear redelivers it.
		if (error instanceof GithubProblem && error.code !== "github_unreachable" && error.code !== "github_failed") return { kind: "refused", reason: "Not taken: " + error.message };
		throw error;
	}

	const author = linearName(issue.creator?.name);
	const trusted = issue.creator !== null && issue.creator.id === f.owner.linearUserId;
	const labels = issue.labels.filter((label): label is string => typeof label === "string").map(label => label.trim().toLowerCase());
	const { mode, reason: modeReason, refusal } = issueMode("", labels, process.env.WLP_FACTORY_ORCHESTRATE !== "0", QUICK_LABELS);
	const resumed = resuming && await existingItem(c, uid, resuming.id);
	if (refusal) return { kind: "refused", reason: refusal };
	const cap = resumed ? null : await quotaRefusal(c, resuming?.id, "Linear");
	if (cap) return { kind: "refused", reason: cap, dailyCap: true };

	const key = linearKey(issue.id, generation);
	const { task } = taskOfLinear({ title: issue.title, body: issue.description, identifier: issue.identifier, url: issue.url, author, trusted });
	const binding: LinearBinding = {
		modeReason, generation, via: trigger.via, triggeredAt: trigger.at, senderId: trigger.sender.id,
		workspaceId: team.workspaceId, teamId: team.id,
		origin: { linear: { id: issue.id, identifier: issue.identifier, url: issue.url, author, trusted }, sender: linearName(trigger.sender.name) },
	};
	const input = intakeInput(task, mode, { id: repository.id, branch: repository.defaultBranch }, trusted, key);
	const item = await file(profile, { input, binding });
	return { kind: "filed", itemId: item.id, state: item.state };
}

/** The sources of a turn's text that a Linear item carries when its issue is someone else's. */
export const linearSources = (origin: { linear: { identifier: string; author: string; trusted: boolean } }) =>
	origin.linear.trusted ? [] : [untrustedWords.linear(origin.linear.identifier, origin.linear.author)];

export type GitlabTrigger = Extract<GitlabDelivery, { event: "issue" | "note" }>;

/** A hook identifies the subject; only the selected project's current issue and note supply task text. */
export async function fileGitlabIssue(c: ItemsCtx, delivery: GitlabTrigger,
	file: (profile: UserProfile, input: CreateItemInput, binding: GitlabBinding) => Promise<ItemSummary>): Promise<string | null> {
	const profile = c.vars.profile, app = gitlabApp();
	if (!profile || !mayUse(profile, config.access) || !config.items || !app) return null;
	const projectId = decimalId(delivery.projectId), iid = decimalId(delivery.iid);
	if (!projectId || !iid) return null;
	const { project, token, viewer } = await gitlabAccess(c, profile.uid, projectId);
	if (viewer !== delivery.senderId) return null;
	const path = `/projects/${projectId}/issues/${iid}`;
	const get = async (path: string) => {
		try { return record((await app.call({ path, token })).body); }
		catch (e) { if (e instanceof GitlabError && e.status === 404) return null; throw e; }
	};
	const issue = await get(path);
	if (!issue || issue.state !== "opened" || decimalId(issue.iid) !== iid || decimalId(issue.project_id) !== projectId) return null;
	const key = `gitlab:${projectId}:${iid}`;
	const previous = c.vars.items.created.get(intakeScope(key));
	if (previous && c.vars.items.items.has(previous.id)) return previous.id;
	const sources = [untrustedWords.gitlabIssue(iid)];
	let body = text(issue.description);
	if (delivery.event === "note") {
		const noteId = decimalId(delivery.noteId);
		if (!noteId) return null;
		const note = await get(`${path}/notes/${noteId}`);
		if (!note || decimalId(note.id) !== noteId || note.system || decimalId(record(note.author).id) !== viewer || !/^\/windlass(?:\s|$)/.test(text(note.body))) return null;
		const words = text(note.body).slice("/windlass".length).trim();
		if (/^feature(?:\s|$)/i.test(words)) return null;
		if (words) { body += `\n\nGitLab note:\n${words}`; sources.push(untrustedWords.gitlabNote(noteId)); }
	} else if (!Array.isArray(issue.labels) || !issue.labels.includes("windlass")) return null;
	if (await quotaRefusal(c, previous?.id, "GitLab")) return null;
	const author = record(issue.author);
	const { task } = taskOfText({ title: text(issue.title), body, fallbackTitle: `Issue #${iid}`, from: `From GitLab issue #${iid}. ${project.url}/-/issues/${iid}`,
		by: linearName(author.username), tracker: "GitLab", trusted: false, note: "" });
	const input = intakeInput(task, "single", project, decimalId(author.id) === viewer, key);
	const item = await file(profile, input, { project, iid, sources });
	// Acknowledgement is best effort: failure to react must never undo a successful filing.
	const host = gitlabCodeHost(app, { id: viewer, project, accessToken: async () => token });
	await host.react(token, project, delivery.event === "note" ? { kind: "issue_comment", id: `${iid}:${delivery.noteId}` } : { kind: "issue", id: iid }, "eyes").catch(() => undefined);
	return item.id;
}
