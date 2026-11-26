/**
 * GitHub, Linear and Slack share one user queue, daily cap, reservation table and placement policy.
 * Each intake keeps its permission checks, delivery identity and item binding separate.
 */

import { createHash } from "node:crypto";
import { mayUse } from "../access.js";
import { readAccountDefaults } from "../account-defaults.js";
import { config } from "../config.js";
import type { CreateItemInput, GithubId, ItemSummary, UserProfile } from "../contract.js";
import { savedPlace } from "../factory/default-place.js";
import { issueMode, linearIdentifier, linearId, linearName, refusals, taskOfLinear, taskOfSlack, type SlackFiling, type SlackBinding, type IntakeFiled, type LinearBinding, type LinearFiled, type LinearFiling } from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { githubApp } from "../github/app.js";
import { isGithubId } from "../github/ids.js";
import { GithubProblem, problemOf, resolveBoundRepository, resolveRepository } from "../github/repos.js";
import { QUICK_LABELS } from "../linear/webhook.js";
import { accountLimits } from "../user-limits.js";
import { readDefaults } from "../repository-defaults.js";
import { isActorGone, itemActor } from "./internal.js";
import type { ItemsCtx, ItemsState } from "./user-items.js";

/** The sources of an item filed from an issue: the ones that share the queue, the cap and the reservations. */
export const INTAKE_SOURCES: ReadonlySet<ItemSummary["source"]> = new Set(["github", "linear", "slack"]);

/** The in-memory scope of an issue-filed creation's key (`ItemsState.created`): apart from the web's and the API's, with one namespace for external intake (their keys differ in form). */
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
 * The one cap on items filed from an issue: how many a day, all external intakes together, drafts among them. A flood of
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
	const policy = await intakePolicy(c, repository.id);
	const { task } = taskOfLinear({ title: issue.title, body: issue.description, identifier: issue.identifier, url: issue.url, author, trusted });
	const binding: LinearBinding = {
		...(policy.defaultPlace && { defaultPlace: policy.defaultPlace }), modeReason, generation, via: trigger.via, triggeredAt: trigger.at, senderId: trigger.sender.id,
		workspaceId: team.workspaceId, teamId: team.id,
		origin: { linear: { id: issue.id, identifier: issue.identifier, url: issue.url, author, trusted }, sender: linearName(trigger.sender.name) },
	};
	const input = intakeInput(task, mode, { id: repository.id, branch: repository.defaultBranch }, policy, trusted, key);
	const item = await file(profile, { input, binding });
	return { kind: "filed", itemId: item.id, state: item.state };
}

/** The sources of a turn's text that a Linear item carries when its issue is someone else's. */
export const linearSources = (origin: { linear: { identifier: string; author: string; trusted: boolean } }) =>
	origin.linear.trusted ? [] : [untrustedWords.linear(origin.linear.identifier, origin.linear.author)];

/** A signed request is one filing forever, even after the item ends. Called in the linked user's intake queue. */
export async function fileSlackRequest(c: ItemsCtx, f: SlackFiling,
	file: (profile: UserProfile, filing: { input: CreateItemInput; binding: SlackBinding }) => Promise<ItemSummary>): Promise<IntakeFiled> {
	const { profile, github: connection } = c.vars;
	if (!profile || !mayUse(profile, config.access))
		return { kind: "refused", reason: "This account cannot file work items here." };
	if (!config.items) return { kind: "refused", reason: refusals.off };
	const d = f.delivery;
	const parsed = taskOfSlack(d.text);
	if (!parsed) return { kind: "refused", reason: "Include a description of the work to file." };
	const app = githubApp();
	if (!app || !connection) return { kind: "refused", reason: "Connect GitHub in Windlass Settings to file here." };
	let repository;
	try {
		const { installation } = await resolveRepository(app, connection, f.repository.id, "read");
		// Discovery may be cached. Verify current access to the mapped repository before starting work.
		repository = (await resolveBoundRepository(app, connection, f.repository.id, installation.id, "write")).repository;
	} catch (error) {
		const failure = problemOf(error, connection.user.login);
		if (failure.code === "github_failed" || failure.code === "github_unreachable") throw failure;
		return { kind: "refused", reason: "Your GitHub account needs write access to the mapped repository." };
	}
	const key = "slack:" + createHash("sha256").update(`${d.teamId}:${d.deliveryId}`).digest("hex");
	const held = c.vars.items.created.get(intakeScope(key));
	if (held && c.vars.items.items.has(held.id)) return { kind: "exists", itemId: held.id };
	const resumed = held && await existingItem(c, profile.uid, held.id);
	const cap = !resumed && await quotaRefusal(c, held?.id, "Slack");
	if (cap) return { kind: "refused", reason: cap, dailyCap: true };
	const policy = await intakePolicy(c, repository.id);
	const mode = issueMode(parsed.quick ? "quick" : "", [], process.env.WLP_FACTORY_ORCHESTRATE !== "0");
	const input = intakeInput(parsed.task, mode.mode, { id: repository.id, branch: repository.defaultBranch }, policy, true, key);
	const binding = { teamId: d.teamId, channelId: d.channelId, threadTs: d.threadTs, generation: f.generation, defaultPlace: policy.defaultPlace };
	const item = await file(profile, { input, binding });
	return { kind: "filed", itemId: item.id, state: item.state };
}
