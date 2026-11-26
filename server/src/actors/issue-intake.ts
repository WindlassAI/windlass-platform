/** The owner queue, reservations, cap and saved policy shared by issue intakes. */

import { serviceParams } from "../auth.js";
import type { JiraReservation } from "./jira-site.js";
import { mayUse } from "../access.js";
import { readAccountDefaults } from "../account-defaults.js";
import { config } from "../config.js";
import type { CreateItemInput, GithubId, ItemSummary, UserProfile } from "../contract.js";
import { savedPlace } from "../factory/default-place.js";
import { issueMode, linearIdentifier, trackerId, trackerName, refusals, taskOfTracker, type Intake, type JiraFiling, type LinearFiling, type TrackerFiled } from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository } from "../github/repos.js";
import { QUICK_LABELS } from "../linear/webhook.js";
import { accountLimits } from "../user-limits.js";
import { readDefaults } from "../repository-defaults.js";
import { isActorGone, itemActor } from "./internal.js";
import type { ItemsCtx, ItemsState } from "./user-items.js";

/** The sources of an item filed from an issue: the ones that share the queue, the cap and the reservations. */
export const INTAKE_SOURCES: ReadonlySet<ItemSummary["source"]> = new Set(["github", "linear", "jira"]);

/** The in-memory scope of an issue-filed creation's key (`ItemsState.created`): apart from the web's and the API's, with one namespace for all trackers (their keys differ in form). */
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

export async function existingItem(c: Pick<ItemsCtx, "client">, uid: string, id: string) {
	try { return await itemActor(c, uid, id).internalSummary(); }
	catch (error) { if (!isActorGone(error) && (error as { code?: string })?.code !== "item_not_found") throw error; }
}

/**
 * The one cap on items filed from an issue: how many a day, all trackers together, drafts among them. A flood of
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

/** What the saved defaults of a repository and of the account say of an item filed from an issue there. */
export async function intakePolicy(c: ItemsCtx, repositoryId: GithubId) {
	const defaults = await readDefaults(c.db, "github:" + repositoryId);
	const account = await readAccountDefaults(c.db);
	return { defaultPlace: savedPlace(defaults, account), profile: defaults.profile ?? account.profile ?? undefined, model: defaults.model ?? account.model ?? undefined };
}

/** The item an issue is filed as: its task and mode, in the repository's base, with the saved profile and model; started at once only when its text is the person's own. */
export function intakeInput(task: { title: string; body: string; acceptance: string[] }, mode: "single" | "orchestrate", repository: { id: GithubId; branch: string }, policy: Awaited<ReturnType<typeof intakePolicy>>, start: boolean, key: string): CreateItemInput {
	return { ...task, mode, repository, profile: policy.profile, model: policy.model, start, idempotencyKey: key };
}

export const isEnded = (item: Pick<ItemSummary, "state">) => item.state === "done" || item.state === "failed" || item.state === "cancelled";

export type SiteJiraFiling = JiraFiling & { plan: JiraReservation };
export async function fileTrackerIssue(c: ItemsCtx, f: LinearFiling | SiteJiraFiling, itemId: (uid: string, key: string) => string,
	file: (profile: UserProfile, input: CreateItemInput, intake: Intake) => Promise<ItemSummary>): Promise<TrackerFiled> {
	const { profile } = c.vars, { issue, trigger } = f;
	const jira = "project" in f ? f : null, tracker = jira ? "Jira" : "Linear";
	if ("team" in f) {
		const { team, owner } = f;
		if (!(issue && trigger && team && f.repository && owner
			&& trackerId(issue.id) && linearIdentifier(issue.identifier) && trackerId(team.id) && trackerId(team.workspaceId) && trackerId(owner.linearUserId)
			&& isGithubId(f.repository.id) && (trigger.via === "label" || trigger.via === "assignment") && Number.isFinite(trigger.at)
			&& trackerId(trigger.sender?.id) && typeof issue.title === "string" && typeof issue.description === "string" && Array.isArray(issue.labels)
			&& (issue.creator === null || (trackerId(issue.creator?.id) && typeof issue.creator.name === "string"))
			&& typeof issue.url === "string" && /^https:\/\/[^\s/]+\//.test(issue.url))) return { kind: "refused", reason: "The Linear issue was not well formed." };
	}
	const keyPrefix = jira ? `jira:${jira.project.siteId}:${issue.id}:` : `linear:${issue.id}:`;
	if (!profile || !mayUse(profile, config.access)) return { kind: "ignored", why: "The owner may not use Windlass here." };
	if (issue.closed) return { kind: "ignored", why: `The issue is closed in ${tracker}.` };
	const uid = profile.uid;

	// The issue's earlier filings, from the keys: those the index holds, and one the index does not yet (an interrupted filing).
	const prefix = intakeScope(keyPrefix);
	let generation = jira?.plan.generation ?? 1;
	if (!jira) {
		const made = [...c.vars.items.created.keys()].filter(key => key.startsWith(prefix)).map(key => Number(key.slice(prefix.length)));
		const last = made.reduce((max, n) => Math.max(max, n), 0);
		const prior = c.vars.items.created.get(prefix + last);
		const held = prior && c.vars.items.items.get(prior.id);
		if (held && !isEnded(held)) return { kind: "exists", itemId: held.id };
		generation = prior && !held ? last : last + 1;
	}
	const resuming = c.vars.items.created.get(prefix + generation);
	const indexed = resuming && c.vars.items.items.get(resuming.id);
	if (indexed) return { kind: "exists", itemId: indexed.id };
	if (trigger.lapsed && !resuming) return { kind: "ignored", why: "The issue no longer has what qualified it." };

	if (!config.items) return { kind: "refused", reason: refusals.off };
	const app = githubApp(), connection = c.vars.github;
	if (!app || !connection) return { kind: "refused", reason: "Not taken: GitHub is not connected, so there is no repository to file this on." };
	let repository;
	try { repository = (await resolveRepository(app, connection, f.repository.id, "write")).repository; }
	catch (error) {
		// A GitHub that cannot answer is no refusal: the delivery fails and the tracker redelivers it.
		if (error instanceof GithubProblem && error.code !== "github_unreachable" && error.code !== "github_failed") return { kind: "refused", reason: "Not taken: " + error.message };
		throw error;
	}

	const labels = issue.labels.filter((label): label is string => typeof label === "string").map(label => label.trim().toLowerCase());
	const bugType = jira?.issue.issueType.trim().toLowerCase() === "bug";
	if (bugType) labels.push("bug");
	const { mode, reason: modeReason, refusal } = issueMode("", labels, process.env.WLP_FACTORY_ORCHESTRATE !== "0", QUICK_LABELS);
	const resumed = resuming && await existingItem(c, uid, resuming.id);
	if (refusal) return { kind: "refused", reason: refusal };
	const cap = resumed ? null : await quotaRefusal(c, resuming?.id, tracker);
	if (cap) return { kind: "refused", reason: cap, dailyCap: true };

	const key = keyPrefix + generation;
	const policy = await intakePolicy(c, repository.id);
	const trusted = "owner" in f && issue.creator?.id === f.owner.linearUserId;
	const author = trackerName(issue.creator?.name), sender = trackerName(trigger.sender.name);
	const { task } = taskOfTracker({ ...issue, body: issue.description, author, trusted }, tracker);
	const source = { id: issue.id, identifier: issue.identifier, url: issue.url, author };
	const fields = { defaultPlace: policy.defaultPlace, modeReason: bugType ? "This is a Jira bug, so it runs in Quick mode without a plan." : modeReason,
		generation, via: trigger.via, triggeredAt: trigger.at, senderId: trigger.sender.id };
	const input = intakeInput(task, mode, { id: repository.id, branch: repository.defaultBranch }, policy, trusted, key);
	let intake: Intake;
	if ("project" in f) {
		const site = c.client().jiraSite.get([f.project.siteId], { params: serviceParams() });
		await site.internalReserveIssue(uid, issue.id, itemId(uid, key), f.plan);
		intake = { jira: { ...fields, siteId: f.project.siteId, projectId: f.project.id, origin: { jira: { ...source, trusted: false }, sender } } };
	} else intake = { linear: { ...fields, workspaceId: f.team.workspaceId, teamId: f.team.id, origin: { linear: { ...source, trusted }, sender } } };
	const item = await file(profile, input, intake);
	return { kind: "filed", itemId: item.id, state: item.state };
}

/** The sources of a turn's text that a Linear item carries when its issue is someone else's. */
export const linearSources = (origin: { linear: { identifier: string; author: string; trusted: boolean } }) =>
	origin.linear.trusted ? [] : [untrustedWords.linear(origin.linear.identifier, origin.linear.author)];
