/** The owner queue, reservations, cap and saved policy shared by issue intakes. */

import { serviceParams } from "../auth.js";
import type { JiraClaimRef } from "./jira-site.js";
import { mayUse } from "../access.js";
import { readAccountDefaults } from "../account-defaults.js";
import { config } from "../config.js";
import type { CreateItemInput, GithubId, ItemSummary, UserProfile } from "../contract.js";
import { savedPlace } from "../factory/default-place.js";
import { issueMode, linearIdentifier, trackerId, trackerName, refusals, taskOfJira, taskOfLinear, type JiraBinding, type JiraFiled, type JiraFiling, type LinearBinding, type LinearFiled, type LinearFiling, type TrackerBinding, type TrackerFiled, type TrackerFiling } from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, resolveRepository } from "../github/repos.js";
import { QUICK_LABELS as LINEAR_QUICK_LABELS } from "../linear/webhook.js";
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

export async function existingItem(c: ItemsCtx, uid: string, id: string) {
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

type TrackerFile<B> = (profile: UserProfile, filing: { input: CreateItemInput; binding: B }) => Promise<ItemSummary>;

// Jira Cloud account IDs may contain colons. Site and issue IDs go in keys; account IDs never do.
const jiraAccount = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(id);

function wellFormed(f: TrackerFiling, accountId: (id: unknown) => boolean) {
	if (!f) return false;
	const { issue, trigger } = f;
	return issue && trigger && f.repository && trackerId(issue.id)
		&& isGithubId(f.repository.id) && (trigger.via === "label" || trigger.via === "assignment") && Number.isFinite(trigger.at)
		&& accountId(trigger.sender?.id) && typeof issue.title === "string" && typeof issue.description === "string" && Array.isArray(issue.labels)
		&& (issue.creator === null || (accountId(issue.creator?.id) && typeof issue.creator.name === "string"))
		&& typeof issue.url === "string" && /^https:\/\/[^\s/]+\//.test(issue.url);
}

interface TrackerPolicy<B> {
	tracker: "Linear" | "Jira";
	keyPrefix: string;
	generation?: number;
	trusted: boolean;
	bugType?: boolean;
	quickLabels: readonly string[];
	bind: (fields: TrackerBinding) => B;
}

/** Call inside inIntakeQueue, with the signed event and repository mapping already checked. */
export async function fileLinearIssue(c: ItemsCtx, f: LinearFiling, file: TrackerFile<LinearBinding>): Promise<LinearFiled> {
	if (!wellFormed(f, trackerId) || !linearIdentifier(f.issue.identifier) || !trackerId(f.team?.id) || !trackerId(f.team.workspaceId) || !trackerId(f.owner?.linearUserId))
		return { kind: "refused", reason: "The Linear issue was not well formed." };
	const { issue, team } = f;
	const trusted = issue.creator !== null && issue.creator.id === f.owner.linearUserId;
	const origin = { linear: { id: issue.id, identifier: issue.identifier, url: issue.url, author: trackerName(issue.creator?.name), trusted }, sender: trackerName(f.trigger.sender.name) };
	return fileTrackerIssue(c, f, { tracker: "Linear", keyPrefix: `linear:${issue.id}:`, trusted, quickLabels: LINEAR_QUICK_LABELS,
		bind: fields => ({ ...fields, teamId: team.id, workspaceId: team.workspaceId, origin }) }, file);
}

export type SiteJiraFiling = JiraFiling & { reservation?: { ref: JiraClaimRef; generation: number } };
export async function fileJiraIssue(c: ItemsCtx, f: SiteJiraFiling, file: TrackerFile<JiraBinding>, itemId: (uid: string, key: string) => string): Promise<JiraFiled> {
	if (!wellFormed(f, jiraAccount) || !trackerId(f.project?.id) || !trackerId(f.project.siteId)
		|| typeof f.issue.identifier !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,31}-\d{1,16}$/.test(f.issue.identifier)
		|| typeof f.issue.issueType !== "string" || f.issue.url.length > 2048 || /[^\x21-\x7e]/.test(f.issue.url) || !URL.canParse(f.issue.url))
		return { kind: "refused", reason: "The Jira issue was not well formed." };
	const { issue, project } = f;
	const origin = { jira: { id: issue.id, identifier: issue.identifier, url: issue.url, author: trackerName(issue.creator?.name), trusted: false as const }, sender: trackerName(f.trigger.sender.name) };
	return fileTrackerIssue(c, f, { tracker: "Jira", keyPrefix: `jira:${project.siteId}:${issue.id}:`, generation: f.reservation?.generation, trusted: false, quickLabels: ["windlass:quick", "windlass-quick"],
		bugType: issue.issueType.trim().toLowerCase() === "bug",
		bind: fields => ({ ...fields, projectId: project.id, siteId: project.siteId, origin }) }, async (owner, made) => {
		if (f.reservation) {
			const site = c.client().jiraSite.get([project.siteId], { params: serviceParams() });
			await site.internalReserveIssue(f.reservation.ref, made.binding.generation, itemId(owner.uid, made.input.idempotencyKey!));
		}
		return file(owner, made);
	});
}

/** Finish an interrupted filing, reuse its active item, or reserve the next generation. */
async function fileTrackerIssue<B>(c: ItemsCtx, f: TrackerFiling, rules: TrackerPolicy<B>, file: TrackerFile<B>): Promise<TrackerFiled> {
	const { tracker, keyPrefix, trusted, bugType, bind } = rules;
	const { profile } = c.vars;
	const { issue, trigger } = f;
	if (!profile || !mayUse(profile, config.access)) return { kind: "ignored", why: "The owner may not use Windlass here." };
	if (issue.closed) return { kind: "ignored", why: `The issue is closed in ${tracker}.` };
	const uid = profile.uid;

	// The issue's earlier filings, from the keys: those the index holds, and one the index does not yet (an interrupted filing).
	const prefix = intakeScope(keyPrefix);
	const made = [...c.vars.items.created].flatMap(([key, entry]) => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)) ? [{ generation: Number(key.slice(prefix.length)), id: entry.id }] : []);
	const last = made.sort((a, b) => a.generation - b.generation).at(-1);
	const held = last && c.vars.items.items.get(last.id);
	if (rules.generation !== undefined && last && (last.generation > rules.generation || (!held && last.generation !== rules.generation))) throw new Error("Jira intake generation mismatch");
	if (last && held && (last.generation === rules.generation || !isEnded(held))) return { kind: "exists", itemId: last.id };
	// An older Jira trigger delivered out of order belongs to the finished generation.
	if (tracker === "Jira" && held?.endedAt !== undefined && trigger.at <= held.endedAt) return { kind: "exists", itemId: held.id };
	const resuming = last && !held ? last : undefined;
	if (trigger.lapsed && !resuming) return { kind: "ignored", why: "The issue no longer has what qualified it." };
	const generation = rules.generation ?? resuming?.generation ?? (last?.generation ?? 0) + 1;

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
	if (bugType) labels.push("bug");
	const { mode, reason: modeReason, refusal } = issueMode("", labels, process.env.WLP_FACTORY_ORCHESTRATE !== "0", rules.quickLabels);
	const resumed = resuming && await existingItem(c, uid, resuming.id);
	if (refusal) return { kind: "refused", reason: refusal };
	const cap = resumed ? null : await quotaRefusal(c, resuming?.id, tracker);
	if (cap) return { kind: "refused", reason: cap, dailyCap: true };

	const key = keyPrefix + generation;
	const policy = await intakePolicy(c, repository.id);
	const text = { title: issue.title, body: issue.description, identifier: issue.identifier, url: issue.url, author: trackerName(issue.creator?.name), trusted };
	const { task } = tracker === "Jira" ? taskOfJira(text) : taskOfLinear(text);
	const binding = bind({ ...(policy.defaultPlace && { defaultPlace: policy.defaultPlace }), modeReason: bugType ? "This is a Jira bug, so it runs in Quick mode without a plan." : modeReason,
		generation, via: trigger.via, triggeredAt: trigger.at, senderId: trigger.sender.id });
	const input = intakeInput(task, mode, { id: repository.id, branch: repository.defaultBranch }, policy, trusted, key);
	const item = await file(profile, { input, binding });
	return { kind: "filed", itemId: item.id, state: item.state };
}

/** The sources of a turn's text that a Linear item carries when its issue is someone else's. */
export const linearSources = (origin: { linear: { identifier: string; author: string; trusted: boolean } }) =>
	origin.linear.trusted ? [] : [untrustedWords.linear(origin.linear.identifier, origin.linear.author)];
