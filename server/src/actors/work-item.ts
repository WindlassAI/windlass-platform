/**
 * `workItem`, key [uid, itemId]: one work item of the software factory (Plans "software factory" §1,
 * §2), and the run controller that carries it through the blueprint (server/src/factory/blueprint.ts).
 *
 * The whole loop is: a fact arrives (a person's action, the session's report of a turn, the answer of
 * a push or a poll); `advance` decides, as a pure function, what the item becomes and what is to be
 * done; the new item, the effects and the events go into SQLite in one transaction, guarded by the
 * revision the decision was made over; then each effect is performed by its key, and what comes of it
 * comes back as the next fact. Every decision is that one synchronous step, so actions that interleave
 * at an `await` cannot both decide from the same item. A fact whose key is not the current one changes
 * nothing (blueprint.ts), so a fact delivered twice, or performed again after a restart, is harmless.
 *
 * Stored: the item as one row (`FactoryItem` and what the actor knows around it), the effects not yet
 * performed (`effects`), the item's log (`events`) and its verdicts (`verdicts`). There are no tables
 * of runs, steps or questions: the item holds its current run, its current step and its one open
 * question, and everything before them is in the log, each entry with the step it happened in, which
 * is what the item's page shows them from. An effect stays in its table until it was performed: one
 * cut off by a deploy is performed again when the actor wakes, under the same key, so the session,
 * the user's turn queue and GitHub see the same request (an effect's key names it exactly once).
 *
 * Waits are rows and one durable schedule (`c.schedule`): an effect with a time (a CI poll, the check
 * whether a turn still runs, a push tried again) is performed when the schedule fires, and an effect
 * that could not be performed (its session or GitHub did not answer) is tried again later the same
 * way. The item keeps one schedule, for the earliest of its effects, so it never has more than a few.
 *
 * Only the `user` actor creates an item: its input carries a grant made for exactly this key, and an
 * actor made any other way has no row and removes itself. The item's agent session is made before the
 * item, with an id derived from the item's, so a creation tried again reaches the same two actors.
 */

import { networkBody, unionNetwork } from "../blocked-network.js";
import type { NetworkReceipt } from "./internal.js";
import { HIDDEN } from "../agent-publish.js";
import { readFeedback, feedbackId, type FeedbackNotice, type FeedbackSubject } from "./github-inbox.js";
import { sources, untrustedWords } from "../factory/untrusted.js";
import { batchText, feedbackWords, fingerprint, fits, QUIET_MS, MOST_MS } from "../factory/feedback.js";
import { isAddressed } from "../github/events.js";
import type { FeedbackBatch, FeedbackEntry } from "../contract.js";
import { GithubProblem } from "../github/repos.js";
import { verdictWords } from "../factory/verdict.js";
import { PlanError, unattendedKeys } from "../factory/feature-plan.js";
import { childItemId, itemSessionId } from "../factory/feature-ids.js";
import { getLayer } from "../layer.js";
import { limitApplies, type PlacementInventory } from "../factory/placement.js";
import { hasPushCi, repositoryAdmission } from "../github/feature-ci.js";
import { authorOf, branchFor } from "../github/publish.js";
import { featureBranch, openFeature, refHead, advanceFeatureRef, readyFeature } from "../github/feature.js";
import { crossRepo, integrationView, issueReference, linkSection, nextOpening, readyRefusal, repoOf, repoViews, withSection, INPUTS_DIRECTORY } from "../factory/cross-repo.js";
import { ForeignRun, dispatchIntegration, findIntegrationRun, integrationWorkflowProblem, readIntegrationRun } from "../github/integration.js";
import type { FeatureRepoState } from "../factory/types.js";
import { observeIssue, writeIssueComment, type IssueChanges, type IssueNotice, type ObservedIssue } from "./github-item.js";
import { filedFromIssue, recentSubject, type IssueBinding } from "../factory/intake.js";
import { CHECK_DENIED, checkConclusion, checkSummary, checkTitle, evidenceLine } from "../factory/verified-check.js";
import type { CheckRunUpdate } from "../github/checks.js";
import type { GithubUser } from "../github/app.js";
import type { ItemReview, ModelList } from "../contract.js";
import { itemAgent, ledgerSeconds, retryAt } from "../factory/budget.js";
import type { ReviewDelivery } from "./session-inbox.js";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { clientError, describeError, requireService, requireServiceFor, serviceParams } from "../auth.js";
import { config, githubConfig } from "../config.js";
import { githubId } from "../github/ids.js";
import { type GithubId, type ItemAction, type ItemEvent, type ItemReport, type ItemSummary, type ItemView, MAX_NOTE_CHARS, type SessionRepository, type Verdict } from "../contract.js";
import { advance, canRetry, completedKeys, currentKey, nextPrPoll, prPollKey } from "../factory/blueprint.js";
import { feedbackComment, itemComment, reportBlocks, REVIEW_PROFILE_REASON } from "../factory/review.js";
import type { Effect as BlueprintEffect, Fact, FactoryItem, VerifiedCheckEffect } from "../factory/types.js";
import { type GithubApp, githubApp, GithubError } from "../github/app.js";
import { readCi } from "../github/ci.js";
import { resolveBoundRepository, resolveRepository, type StoredConnection } from "../github/repos.js";
import { grantIsValid, isSessionGone, itemActor, sessionActor, userActor } from "./internal.js";
import type { ItemFacts } from "./user-items.js";

/** What the item knows around the blueprint's `FactoryItem`. */
export interface ItemMeta {
	/** Latest cumulative receipt for each session. A retry or an older receipt adds nothing. */
	blockedSessions?: Record<string, NetworkReceipt>;
	github?: IssueBinding;
	reviewerSessionId: string | null;
	reviewBase: { head: string; sha: string } | null;
	handoffReview: { recommendation: ItemReview["recommendation"]; reason: string | null } | null;
	uid: string;
	sessionId: string;
	/** The repository of the user's GitHub connection; `branch` is the base. */
	repository: SessionRepository;
	source: ItemSummary["source"];
	createdAt: number;
	updatedAt: number;
	/** The latest verdict's result and flags, for the index. */
	verdict: ItemSummary["verdict"];
	/**
	 * The hosted sandbox seconds of the item's session over its whole life, and the ledger's holds already
	 * in it: the ledger keeps only its last days, so the item adds each hold once as it sees it.
	 */
	ledger: { seconds: number; holds: string[] };
}

/** What `user` passes when it creates a `workItem`. */
export interface ItemCreateInput {
	/** A grant bound to this actor's key (internal.ts): proof that `user` created it. */
	grant: string;
	item: FactoryItem;
	meta: ItemMeta;
	/** The person who filed it, when it is started at once: the `start` fact is decided with the creation. */
	startedBy: string | null;
}

/** What a session answers about a turn of the item, as facts (session-inbox.ts). */
export type ItemPublishAnswer = { kind: "published"; head: string; pr: { number: number; url: string } | null } | { kind: "publish_failed"; said: string; transient: boolean };

interface Stored {
	item: FactoryItem;
	meta: ItemMeta;
}

interface ItemVars {
	/** Null for an actor `user` did not create. */
	stored: Stored | null;
	/** The tail of the write queue: every transaction runs after the one before it. */
	writing: Promise<unknown>;
	/** The effects being performed now, by row id: one is not performed twice at once. */
	performing: Set<string>;
	/** Every handoff edits the same comment, including a retry that overlaps the next run. */
	handoff: Promise<void>;
	/** The schedule that wakes the item for its earliest effect, as the item row has it. */
	due: { id: string; at: number } | null;
	reporting: Promise<void> | null;
	reportAgain: boolean;
}

interface Ctx {
	vars: ItemVars;
	db: RawAccess;
	key: string[];
	log: { warn(entry: unknown): void; error(entry: unknown): void };
	// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
	client(): any;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	schedule: { at(timestamp: number, action: string, ...args: unknown[]): Promise<string>; cancel(id: string): Promise<boolean> };
}

/** How long an effect that could not be performed waits before it is tried again: 15 s, doubling, at most 5 min. */
const EFFECT_RETRY_FIRST_MS = 15_000;
const EFFECT_RETRY_MOST_MS = 5 * 60_000;
/** The action the item's schedule fires: its name is looked up when it fires, so it is one constant (factory-e2e.ts checks it is registered). */
export const DUE_ACTION = "internalDue";
/** The item's page shows at most this many entries of its log, the newest. */
const VIEW_EVENTS = 500;

type IssueCheck = IssueChanges & { kind: "check_issue"; key: "pending"; at: number };
const ISSUE_CHANGE_WINDOW_MS = 15_000;

type FeedbackEffect = { kind: "feedback_ready"; key: "pending"; at: number } | { kind: "feedback_ack"; key: string; run: number } | { kind: "feedback_comment"; key: string; run: number; who: string };
/** `register`'s `repo`: a cross-repo feature's other repository, by alias, registered with that repository's directory. */
type Effect = BlueprintEffect | FeedbackEffect | IssueCheck | { kind: "issue_comment"; key: string; revision: number } | { kind: "register_issue"; key: string } | { kind: "register"; key: string; pr: number; head: string; repo?: string } | { kind: "forget"; key: string };
type GithubNudge = { installationId: GithubId; repositoryId: GithubId } & ({ kind: "ci"; head: string } | { kind: "pr"; pr: number });

type EffectRow = { id: string; effect: string; due_at: number; attempts: number };

const rowId = (effect: Effect) => `${effect.kind}:${effect.kind === "ask" ? effect.question.id : effect.key}`;

/** Whether the turn of a `deliver` key is the first of its run (`<item>:<run>:<step>:<attempt>`, blueprint.ts `stepKey`). */
function startsRun(key: string): boolean {
	const [, , step, attempt] = key.split(":");
	return step === "1" && attempt === "1";
}

// ---------------------------------------------------------------------------------------------
// The summary and the page
// ---------------------------------------------------------------------------------------------

function secondReview(item: FactoryItem, meta: ItemMeta): ItemSummary["review"] {
	if (!item.reviewer || "off" in item.reviewer) return { state: "off", recommendation: null };
	if (meta.handoffReview) return { state: meta.handoffReview.reason ? "none" : "filed", recommendation: meta.handoffReview.reason ? null : meta.handoffReview.recommendation };
	if (item.run?.step.kind !== "review") return null;
	return { state: item.run.step.turn === "started" ? "running" : "waiting", recommendation: null };
}

function summaryOf({ item, meta }: Stored): ItemSummary {
	const { repository } = meta;
	return {
		id: item.id,
		mode: item.mode ?? "single",
		parent: item.parent ?? null,
		title: item.task.title,
		repository: { provider: repository.provider, id: repository.id, owner: repository.owner, name: repository.name, branch: repository.branch, private: repository.private, url: repository.url },
		...(crossRepo(item) && { repositories: repoViews(item), integration: integrationView(item) }),
		place: item.place,
		...(item.placement && { placement: item.placement }),
		source: meta.source,
		origin: meta.github?.origin ?? null,
		state: item.state,
		wait: item.wait,
		question: item.question === null ? null : { id: item.question.id, kind: item.question.kind, text: item.question.text, choices: item.question.choices, askedAt: item.question.askedAt, ...(item.question.asked && { asked: item.question.asked }), ...(item.question.check && { check: item.question.check }) },
		pullRequest: item.pr,
		verdict: meta.verdict,
		review: secondReview(item, meta),
		budget: item.budget,
		spent: item.spent,
		agent: itemAgent(item),
		sessionId: meta.sessionId,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		...(item.endedAt !== undefined && ENDED.has(item.state) && { endedAt: item.endedAt }),
		revision: item.revision,
		...(item.run && item.run.endedAt === null && !ENDED.has(item.state) && { step: { kind: item.run.step.kind, startedAt: item.run.step.startedAt, turn: item.run.step.turn, rounds: { ...item.run.rounds, review: item.run.rounds.review ?? 0 } } }),
	};
}

/**
 * The item's page, read from what is stored, in the write queue: the item and its log are then one
 * state. Read from memory, a question decided a moment ago could be shown before the log line that led
 * to it was written.
 */
function viewOf(c: Ctx): Promise<ItemView> {
	return queued(c, async () => {
		const stored = await load(c.db);
		if (!stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
		return await pageOf(c, stored);
	});
}

export const FEEDBACK_TABLE = "CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,data TEXT NOT NULL,at INTEGER NOT NULL,received INTEGER NOT NULL,batch TEXT NOT NULL,ready INTEGER NOT NULL,after_run INTEGER NOT NULL DEFAULT -1,state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL,run INTEGER,plan INTEGER,saved_plan TEXT)";
export const CHECKS_TABLE = "CREATE TABLE IF NOT EXISTS checks (sha TEXT PRIMARY KEY, check_run_id TEXT, external_id TEXT NOT NULL, state TEXT NOT NULL, conclusion TEXT, at INTEGER NOT NULL, said TEXT NOT NULL)";
export const REVIEWS_TABLE = "CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, run INTEGER NOT NULL, head TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

/** The report and its reference snapshots share one JSON value and one transaction with the turn. */
/** The verdict comment's id on each pull request the item handed over on (`writeMarkedComment`). */
export const VERDICT_COMMENT_TABLE = "CREATE TABLE IF NOT EXISTS verdict_comment(pr INTEGER PRIMARY KEY, id TEXT NOT NULL)";
export const REPORTS_TABLE = "CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, run INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

export async function storeReport(db: Pick<RawAccess, "execute">, item: FactoryItem, sessionId: string, fact: Extract<Fact, { kind: "turn_ended" }>): Promise<void> {
	if (!item.run || !fact.report || typeof fact.report === "string") return;
	const head = fact.pushedHead ?? null;
	const report: ItemReport = {
		by: "builder", sessionId, run: item.run.n, key: fact.key, head,
		at: fact.at, title: fact.report.title, blocks: reportBlocks(fact.report), records: [], screenshots: fact.report.screenshots.map(shot => ({ ...shot, head })),
	};
	await db.execute("INSERT OR REPLACE INTO reports (key, run, at, data) VALUES (?, ?, ?, ?)", report.key, report.run, report.at, JSON.stringify(report));
}

async function publishReport(db: Pick<RawAccess, "execute">, turn: string, head: string): Promise<void> {
	// A sandbox without a commit can return a branch name in its publish receipt.
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return;
	const [row] = await db.execute<{ data: string }>("SELECT data FROM reports WHERE key = ?", turn);
	if (!row) return;
	const report: ItemReport = JSON.parse(row.data);
	report.head = head;
	for (const shot of report.screenshots) shot.head = head;
	await db.execute("UPDATE reports SET data = ? WHERE key = ?", JSON.stringify(report), turn);
}

export async function latestReport(db: Pick<RawAccess, "execute">, run: number): Promise<ItemReport | null> {
	const [row] = await db.execute<{ data: string }>("SELECT data FROM reports WHERE run = ? ORDER BY at DESC, rowid DESC LIMIT 1", run);
	return row ? JSON.parse(row.data) as ItemReport : null;
}

type FeedbackRow = { id: string; data: string; batch: string; state: FeedbackBatch["state"]; reason: string; run: number | null; plan: number | null; saved_plan: string | null };

async function feedbackView(db: RawAccess): Promise<ItemView["feedback"]> {
	const batches = new Map<string, FeedbackBatch>();
	for (const r of await db.execute<FeedbackRow>("SELECT * FROM feedback ORDER BY at, id")) {
		const key = r.state + ":" + r.batch;
		let batch = batches.get(key);
		if (!batch) batches.set(key, batch = { entries: [], state: r.state, reason: r.reason, run: r.run, plan: r.plan, ...(r.saved_plan && { savedPlan: JSON.parse(r.saved_plan) }) });
		batch.entries.push(JSON.parse(r.data));
	}
	const [counts] = await db.execute<{ n: number }>("SELECT count(*) AS n FROM issue_actions WHERE subject LIKE 'feedback-denied:%'");
	return { batches: [...batches.values()], notTaken: counts.n };
}

async function pageOf(c: Ctx, stored: Stored): Promise<ItemView> {
	const run = stored.item.run;
	const events = await c.db.execute<{ data: string }>("SELECT data FROM (SELECT seq, data FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq", VIEW_EVENTS);
	const verdicts = await c.db.execute<{ data: string }>("SELECT data FROM verdicts ORDER BY at, id");
	const plan = stored.item.featurePlan;
	const completed = completedKeys(stored.item);
	return {
		...summaryOf(stored),
		blockedNetwork: itemNetwork(stored.meta),
		feedback: await feedbackView(c.db),
		verifiedCheck: (await c.db.execute<NonNullable<ItemView["verifiedCheck"]>>("SELECT sha, state, conclusion, said FROM checks WHERE sha = ?", run?.ci?.moved ?? stored.item.head ?? ""))[0] ?? null,
		plan: plan ?? null,
		...(plan && { unattended: unattendedKeys(plan, completed), completedSubtasks: [...completed] }),
		canRetry: canRetry(stored.item),
		reviewerSessionId: stored.meta.reviewerSessionId ?? null,
		reviewNone: stored.meta.handoffReview?.reason ?? (!stored.item.reviewer ? "this item was created before second reviews were available" : "off" in stored.item.reviewer ? stored.item.reviewer.off === "profile" ? REVIEW_PROFILE_REASON : "turned off for this deployment" : null),
		reviews: (await c.db.execute<{ data: string }>("SELECT data FROM (SELECT data, at, rowid AS seq FROM reviews ORDER BY at DESC, rowid DESC LIMIT 10) ORDER BY at, seq")).map(row => JSON.parse(row.data) as ItemReview),
		task: stored.item.task,
		// What the gate and CI read stays here: the page shows the run as the contract has it.
		run: run === null ? null : { n: run.n, startedAt: run.startedAt, endedAt: run.endedAt, stopReason: run.stopReason, ...(stored.item.parent && {failureFingerprint: run.lastFailure}), step: run.step, rounds: { ...run.rounds, review: run.rounds.review ?? 0 } },
		head: stored.item.head,
		report: run ? await latestReport(c.db, run.n) : null,
		events: events.map((row) => JSON.parse(row.data) as ItemEvent),
		verdicts: verdicts.map((row) => JSON.parse(row.data) as Verdict),
	};
}

/** Sends summaries to the user's index until the newest has gone; calls meanwhile collapse into one more. */
function report(c: Ctx): void {
	c.vars.reportAgain = true;
	if (c.vars.reporting) return;
	const loop = (async () => {
		await Promise.resolve();
		try {
			while (c.vars.reportAgain && c.vars.stored) {
				c.vars.reportAgain = false;
				try {
					await userActor(c, c.vars.stored.meta.uid).internalItemChanged(summaryOf(c.vars.stored));
				} catch (error) {
					c.log.warn({ msg: "could not report the item's summary to its user", error: describeError(error) });
				}
			}
		} finally {
			c.vars.reporting = null;
		}
	})();
	c.vars.reporting = loop;
	void c.keepAwake(loop);
}

// ---------------------------------------------------------------------------------------------
// Deciding and storing
// ---------------------------------------------------------------------------------------------

function queued<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.writing.then(job, job);
	c.vars.writing = run.catch(() => undefined);
	return run;
}

/** Both receipt paths charge the same settled holds, including a replay after a restart. */
async function takeSessionFact(c: Ctx, stored: Stored, fact: Fact): Promise<void> {
	if (fact.kind === "turn_ended" || fact.kind === "review_ended") {
		const hostedSeconds = stored.item.place.kind === "hosted"
			? lifetimeSeconds(stored.meta, await userActor(c, stored.meta.uid).internalItemFacts(sessionsOf(stored.meta))) + childSeconds(stored.item)
			: 0;
		await take(c, { ...fact, spend: { tokens: fact.spend?.tokens ?? 0, ...(fact.spend?.rawTokens !== undefined && { rawTokens: fact.spend.rawTokens }), hostedSeconds, ...(fact.spend?.agent && { agent: fact.spend.agent }) } });
	} else {
		await take(c, fact);
	}
}

type CheckReceipt = { kind: "check_recorded"; at: number; effect: VerifiedCheckEffect; id: string | null; installationId: GithubId };

/**
 * The item after `fact`, stored with its effects and events in one transaction over the revision it
 * was decided from, and then performed. Resolves once it is stored, with whether the fact changed
 * anything: an action that answers after this has answered for what is durable.
 */
async function take(c: Ctx, fact: Fact | CheckReceipt | { kind: "issue_note"; at: number } | { kind: "network_reported"; at: number }, { baseSha, nudged, issue, overflow }: { overflow?: string[]; baseSha?: string | null; nudged?: boolean; issue?: Pick<ObservedIssue, "subject" | "by" | "said"> } = {}): Promise<boolean> {
	const stored = c.vars.stored;
	if (!stored) return false;
	// From here to the write being queued nothing is awaited: the decision is one step.
	const before = stored.item;
	const outcome: ReturnType<typeof advance> = fact.kind === "issue_note" || fact.kind === "network_reported" || fact.kind === "check_recorded" ? { item: { ...before, revision: before.revision + 1 }, effects: [], events: [] } : advance(before, fact);
	if (outcome.item === before) return false;
	if (issue?.said) outcome.events.push({ at: fact.at, by: issue.by, step: null, said: issue.said });
	stored.item = outcome.item;
	stored.meta.updatedAt = fact.at;
	const handoff = outcome.effects.find((effect): effect is Extract<Effect, { kind: "handoff" }> => effect.kind === "handoff");
	const strip = handoff ?? outcome.storeVerdict;
	if (strip) stored.meta.verdict = { result: strip.verdict.result, flags: strip.verdict.flags, ci: strip.verdict.ci.state };
	if (outcome.item.run?.n !== before.run?.n) {
		stored.meta.handoffReview = null;
		stored.meta.reviewBase = null;
	}
	if (outcome.storeVerdict && baseSha && /^[0-9a-f]{40}$/.test(baseSha)) stored.meta.reviewBase = { head: outcome.storeVerdict.verdict.head, sha: baseSha };
	const handedFiling = fact.kind === "review_ended" && fact.review?.id === outcome.item.run?.ci?.secondReview?.review ? fact.review : null;
	if (handedFiling) stored.meta.handoffReview = { recommendation: handedFiling.recommendation, reason: null };
	// Every filing the blueprint took is kept, the rounds that sent the builder back too: the page shows each round.
	const filing = handedFiling ?? (fact.kind === "review_ended" && fact.review && fact.review.id === outcome.tookReview ? fact.review : null);
	if (handoff && before.run?.n === outcome.item.run?.n) stored.meta.handoffReview = { recommendation: stored.meta.handoffReview?.recommendation ?? null, reason: handoff.reviewNone };
	// The item, its revision and its data are taken from this decision now: a later decision, made while this
	// one waits for its write, changes `stored` and must not be written beside this one's data.
	const next = outcome.item;
	const data = JSON.stringify({ item: next, meta: stored.meta });
	// An `ask` is the question on the item itself, which reaches the index with the summary: nothing is left to perform.
	const effects: Effect[] = outcome.effects.filter((effect) => effect.kind !== "ask");
	// A cut-off review may have left its checkout paused while the item waited for its owner.
	// Keep cleanup in the outbox, independently of GitHub and of a withdrawal still stopping a turn.
	if (stored.meta.reviewerSessionId && next.run && before.state !== next.state && (next.state === "review" || ENDED.has(next.state))) {
		effects.push({ kind: "release_review", key: String(next.run.n), run: next.run.n, to: "review" });
	}
	if (stored.meta.reviewerSessionId && handoff?.continuedIn) effects.push({ kind: "release_review", key: String(handoff.verdict.run), run: handoff.verdict.run, to: "review" });
	if (stored.meta.github) {
		if (issue?.subject !== "gone" && (before.pr?.number !== next.pr?.number || ENDED.has(before.state) !== ENDED.has(next.state)))
			effects.push({ kind: "issue_comment", key: "link", revision: next.revision });
		if (before.state === "failed" && !ENDED.has(next.state)) effects.push({ kind: "register_issue", key: String(next.revision) });
	}
	const sibling = fact.kind === "feature_ready" && fact.repo && crossRepo(next) && repoOf(next, fact.repo) !== next.repos![0] ? fact.repo : null;
	if (sibling && fact.kind === "feature_ready") effects.push({ kind: "register", key: fact.key + "/" + sibling, pr: fact.pr.number, head: fact.head, repo: sibling });
	else if (fact.kind === "feature_ready" || (fact.kind === "published" && fact.pr)) effects.push({ kind: "register", key: fact.key, pr: fact.pr!.number, head: fact.head });
	if (fact.kind !== "published" && fact.kind !== "feature_ready" && (before.run?.ci?.moved !== next.run?.ci?.moved || (next.mode === "orchestrate" && before.head !== next.head)) && next.pr && next.head && !ENDED.has(next.state))
		effects.push({ kind: "register", key: String(next.revision), pr: next.pr.number, head: next.head });
	if (ENDED.has(next.state) && !ENDED.has(before.state)) effects.push({ kind: "forget", key: String(next.revision) });
	try {
		await queued(c, () =>
			c.db.transaction(async (tx) => {
				const [row] = await tx.execute<{ revision: number }>("SELECT revision FROM item WHERE id = 1");
				if (row?.revision !== before.revision) throw new Error(`the item is at revision ${row?.revision ?? "none"}, not ${before.revision}`);
				if (issue) await tx.execute("INSERT INTO issue_actions VALUES(?)", issue.subject);
				await tx.execute("UPDATE item SET revision = ?, data = ? WHERE id = 1", next.revision, data);
				// What this decision left behind goes with it: a publish waiting for its retry is not done for a cancelled item.
				for (const old of await tx.execute<{ id: string; effect: string }>("SELECT id, effect FROM effects")) {
					if ((issue?.subject === "gone" && old.id === "issue_comment:link") || !live(next, JSON.parse(old.effect) as Effect)) await tx.execute("DELETE FROM effects WHERE id = ? AND effect = ?", old.id, old.effect);
				}
				if (next.feedbackReplans && next.featurePlan?.version !== before.featurePlan?.version && next.featurePlan) {
					const { version, spec, subtasks } = next.featurePlan;
					await tx.execute("UPDATE feedback SET plan=?,saved_plan=? WHERE state='taken' AND run=?", version, JSON.stringify({ goal: spec.goal, subtasks: subtasks.map(t => t.title) }), next.run!.n);
				}
				if (overflow?.length) {
					await tx.execute("UPDATE feedback SET state='pending', reason=?, after_run=?, batch='overflow' WHERE id IN (SELECT value FROM json_each(?))", feedbackWords.overflow, before.run?.n ?? 0, JSON.stringify(overflow));
				}
				for (const decision of outcome.feedback ?? []) {
					const ids = JSON.stringify(decision.ids);
					await tx.execute("UPDATE feedback SET state=?,reason=?,run=?,plan=?,batch=? WHERE id IN (SELECT value FROM json_each(?))", decision.state, decision.reason, decision.run ?? null, decision.plan ?? null, decision.ids[0], ids);
					if (decision.state !== "taken") continue;
					await tx.execute("INSERT OR IGNORE INTO issue_actions SELECT value FROM json_each(?)", ids);
					const writers = new Set<string>();
					for (const row of await tx.execute<{ data: string }>("SELECT data FROM feedback WHERE id IN (SELECT value FROM json_each(?))", ids)) {
						const entry: FeedbackEntry = JSON.parse(row.data);
						writers.add("@" + entry.author);
						if (entry.kind.endsWith("_comment")) effects.push({ kind: "feedback_ack", key: entry.id, run: decision.run! });
					}
					effects.push({ kind: "feedback_comment", key: String(decision.run), run: decision.run!, who: [...writers].join(", ") });
				}
				if (ENDED.has(next.state) && next.state !== before.state)
					await tx.execute("UPDATE feedback SET state='declined',reason=? WHERE state IN ('pending','held','question')", feedbackWords.ended(next.state));
				if (fact.kind === "github_feedback" || before.run?.n !== next.run?.n || ENDED.has(next.state)) await scheduleFeedback(tx, next);
				if (fact.kind === "check_recorded") await storeCheckReceipt(tx, next.id, fact, outcome.events);
				for (const event of outcome.events) await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", event.at, JSON.stringify(event));
				for (const effect of effects) {
					// Rework can reopen a posted check or one whose POST reply is still outstanding.
					if (effect.kind === "verified_check" && effect.existingOnly && !(await tx.execute(
						"SELECT 1 FROM checks WHERE sha=? AND check_run_id IS NOT NULL UNION ALL SELECT 1 FROM effects WHERE id=? LIMIT 1", effect.key, rowId(effect),
					)).length) continue;
					if (effect.kind === "verified_check" && effect.state === "completed" && handoff && effect.verdictId)
						await prepareCompletedCheck(tx, next, effect, handoff);
					await tx.execute("INSERT OR REPLACE INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, 0)", rowId(effect), JSON.stringify(effect), "at" in effect && effect.at !== undefined ? effect.at : 0);
				}
				if (fact.kind === "turn_ended") await storeReport(tx, before, stored.meta.sessionId, fact);
				if (fact.kind === "published" && before.run?.gate) await publishReport(tx, before.run.gate.turn, fact.head);
				if (filing) {
					const r = filing;
					await tx.execute("INSERT OR REPLACE INTO reviews (id, run, head, at, data) VALUES (?, ?, ?, ?, ?)", r.id, r.run, r.head, r.at, JSON.stringify(r));
				}
				if (strip) await tx.execute("INSERT OR REPLACE INTO verdicts (id, run, head, at, data) VALUES (?, ?, ?, ?, ?)", strip.verdict.id, strip.verdict.run, strip.verdict.head, strip.verdict.at, JSON.stringify(strip.verdict));
			}, { name: "item.take" }),
		);
	} catch (error) {
		// What is stored is what holds: the item is read again, and the fact is lost to whoever sends it again.
		c.vars.stored = await load(c.db).catch(() => c.vars.stored);
		throw error;
	}
	if (nudged && fact.kind === "ci_read") {
		const state = next.run?.ci?.lastReadState;
		const previous = before.run?.ci?.lastReadState ?? before.run?.ci?.last?.state;
		if (state && state !== "retry" && state !== previous)
			console.log(`[wlp] factory.ci.nudge_found item=${next.id} head=${fact.head.slice(0, 7)} state=${state}`);
	}
	if (fact.kind === "check_recorded") {
		if (fact.id === null && outcome.events.length) console.log(`github.verified_check.not_permitted installation=${fact.installationId} item=${next.id}`);
	} else {
		for (const event of outcome.events) console.log(`[wlp] item.event uid=${stored.meta.uid} item=${before.id} revision=${next.revision}: ${event.said.replace(/\s+/g, " ").slice(0, 200)}`);
	}
	report(c);
	// The item's one schedule, set before anything is performed: an item stopped by a deploy before its effects ran wakes for them.
	await armDue(c);
	void c.keepAwake(performDue(c));
	return true;
}

async function load(db: RawAccess): Promise<Stored | null> {
	const [row] = await db.execute<{ data: string }>("SELECT data FROM item WHERE id = 1");
	if (!row) return null;
	const stored = JSON.parse(row.data) as Stored;
	stored.item.reviewer ??= { off: "deployment" };
	return stored;
}

// ---------------------------------------------------------------------------------------------
// Performing
// ---------------------------------------------------------------------------------------------

/**
 * Performs every effect that is due and not being performed, in the order they were stored, then sets
 * the schedule for the next one. An effect is removed once performed; one that failed is tried again
 * later. Never throws.
 */
async function performDue(c: Ctx): Promise<void> {
	try {
		const now = Date.now();
		const rows = (await c.db.execute<EffectRow>("SELECT id, effect, due_at, attempts FROM effects WHERE due_at <= ? ORDER BY rowid", now)).filter((row) => !c.vars.performing.has(row.id));
		for (const row of rows) c.vars.performing.add(row.id);
		// Armed before they are performed: a server that stops under a slow push leaves a schedule that wakes the item for it.
		if (rows.length > 0) await armDue(c);
		await Promise.all(rows.map((row) => performRow(c, row)));
		await armDue(c);
	} catch (error) {
		c.log.error({ msg: "could not perform the item's effects", error: describeError(error) });
	}
}

async function performRow(c: Ctx, row: EffectRow): Promise<void> {
	c.vars.performing.add(row.id);
	try {
		const done = await perform(c, row);
		if (done === "deferred") return;
		await queued(c, async () => {
			// Found not wanted, it is let go only if the stored item does not want it either: the decision that retired it may
			// still be waiting for its write, which can fail, and the item read again then waits for this effect. That write
			// is queued before this one, so it has gone through or failed by now.
			if (!done) {
				const durable = await load(c.db);
				if (durable && live(durable.item, JSON.parse(row.effect) as Effect)) return;
			}
			await c.db.execute("DELETE FROM effects WHERE id = ? AND effect = ?", row.id, row.effect);
		});
	} catch (error) {
		const wait = Math.min(EFFECT_RETRY_MOST_MS, EFFECT_RETRY_FIRST_MS * 2 ** Math.min(row.attempts, 10));
		c.log.warn({ msg: "an effect of the item could not be performed; it is tried again", effect: row.id, inSeconds: wait / 1000, error: describeError(error) });
		await queued(c, () => c.db.execute("UPDATE effects SET due_at = ?, attempts = attempts + 1 WHERE id = ? AND effect = ?", Date.now() + wait, row.id, row.effect)).catch(() => undefined);
	} finally {
		c.vars.performing.delete(row.id);
	}
}

/**
 * One schedule, at the earliest effect still to perform; the one before it is cancelled. A stored
 * schedule whose time has passed is not armed: its firing may have been cut off after RivetKit took it.
 */
function armDue(c: Ctx): Promise<void> {
	return queued(c, () => armDueInQueue(c));
}

async function armDueInQueue(c: Ctx): Promise<void> {
	// An effect being performed now counts as due EFFECT_RETRY_FIRST_MS from now, not at its own time: armed "now" for it, the
	// schedule would fire again and again while a slow push goes on; left out, a server that stops under the push would
	// leave nothing to wake the item.
	const rows = await c.db.execute<{ id: string; due_at: number }>("SELECT id, due_at FROM effects");
	const now = Date.now();
	const times = rows.map((row) => (c.vars.performing.has(row.id) ? now + EFFECT_RETRY_FIRST_MS : row.due_at));
	const at = times.length === 0 ? null : Math.min(...times);
	const due = c.vars.due;
	if (at === null || (due !== null && due.at === at && due.at > Date.now())) return;
	const id = await c.schedule.at(Math.max(at, Date.now()), DUE_ACTION);
	c.vars.due = { id, at };
	await c.db.execute("UPDATE item SET due = ? WHERE id = 1", JSON.stringify(c.vars.due));
	if (due !== null) await c.schedule.cancel(due.id).catch(() => false);
}

async function binding(c: Ctx): Promise<GithubId | null> {
	const [row] = await c.db.execute<{ installation: string }>("SELECT installation FROM github_binding WHERE id = 1");
	return githubId(row?.installation);
}

/** Rebuild the one durable timer from unconsumed subjects, including overflow eligible in this run. */
async function scheduleFeedback(tx: Pick<RawAccess, "execute">, item: FactoryItem) {
	const [due] = await tx.execute<{ at: number | null }>("SELECT min(ready) AS at FROM feedback WHERE state='pending' AND after_run < ?", item.run?.n ?? 0);
	if (due.at === null) await tx.execute("DELETE FROM effects WHERE id='feedback_ready:pending'");
	else {
		const e: FeedbackEffect = { kind: "feedback_ready", key: "pending", at: due.at };
		await tx.execute("INSERT OR REPLACE INTO effects VALUES(?,?,?,0)", rowId(e), JSON.stringify(e), due.at);
	}
}

async function receiveFeedback(c: Ctx, notice: FeedbackNotice) {
	const changed = await queued(c, async () => {
		const stored = await load(c.db);
		if (!stored || stored.meta.repository.id !== notice.repositoryId || stored.item.pr?.number !== notice.pr || await binding(c) !== notice.installationId) return false;
		const { item } = stored;
		if (item.state === "done" || item.state === "cancelled") return false;
		const now = Date.now();
		return c.db.transaction(async tx => {
			if (notice.denied || notice.approval) {
				const subject = notice.denied ? "feedback-denied:" + notice.denied : notice.approval!.id;
				const added = await tx.execute("INSERT OR IGNORE INTO issue_actions VALUES(?) RETURNING subject", subject);
				if (added.length && notice.approval) await tx.execute("INSERT INTO events(at,data) VALUES(?,?)", now, JSON.stringify({
					at: now, step: null, by: "github:" + notice.approval.author, said: feedbackWords.approved(notice.approval.author),
				}));
				return !!added.length;
			}
			const review = notice.entries.find(e => e.kind === "changes_requested" || e.kind === "commented");
			let added = false;
			for (const e of notice.entries) {
				const oversized = e.body.length > 8000;
				const rows = await tx.execute("INSERT OR IGNORE INTO feedback(id,data,at,received,batch,ready,state,reason) VALUES(?,?,?,?,?,?,?,?) RETURNING id",
					e.id, JSON.stringify(e), e.at, now, review?.id ?? "comments", review ? now : now + QUIET_MS,
					oversized ? "declined" : "pending", oversized ? feedbackWords.oversized : feedbackWords.waiting);
				added ||= !!rows.length;
				// A line delivery can beat its review; the review collects the still-pending line.
				if (review && !rows.length) await tx.execute("UPDATE feedback SET batch=?,ready=? WHERE id=? AND state='pending' AND batch='comments'", review.id, now, e.id);
			}
			if (!added) return false;
			if (!review) await tx.execute("UPDATE feedback SET ready=min(?, (SELECT min(received) FROM feedback WHERE state='pending' AND batch='comments') + ?) WHERE state='pending' AND batch='comments'", now + QUIET_MS, MOST_MS);
			await scheduleFeedback(tx, item);
			return true;
		});
	});
	if (changed) await take(c, { kind: "issue_note", at: Date.now() });
	else await armDue(c); // A duplicate repairs a lost timer after a restart.
	return changed;
}

async function feedbackReady(c: Ctx) {
	const now = Date.now();
	const item = c.vars.stored!.item;
	const rows = await queued(c, () => c.db.execute<FeedbackRow>(`SELECT * FROM feedback WHERE state='held' OR (state='pending' AND batch=(
		SELECT batch FROM feedback WHERE state='pending' AND ready<=? AND after_run<? ORDER BY ready, received, rowid LIMIT 1) AND after_run<?) ORDER BY at,id`,
		now, item.run?.n ?? 0, item.run?.n ?? 0));
	if (item !== c.vars.stored!.item || !rows.some(r => r.state === "pending")) return;
	const { taken, rest } = fits(rows.map(r => JSON.parse(r.data) as FeedbackEntry));
	const writers = [...new Set(taken.map(e => e.author))];
	const ids = taken.map(e => e.id), overflow = rest.map(e => e.id);
	if (ids.every(id => item.feedback?.held?.includes(id))) {
		// The current held batch is full. Keep the rest for the first eligible later run.
		await queued(c, () => c.db.transaction(async tx => {
			await tx.execute("UPDATE feedback SET after_run=?,batch='overflow',reason=? WHERE state='pending' AND id IN (SELECT value FROM json_each(?))", item.run?.n ?? 0, feedbackWords.overflow, JSON.stringify(overflow));
			await scheduleFeedback(tx, c.vars.stored!.item);
		}));
		return;
	}
	await take(c, { kind: "github_feedback", at: now, by: "github:" + writers[0], writers, ids, fingerprint: fingerprint(taken),
		text: batchText(taken, { pr: item.pr!.number, run: (item.run?.n ?? 0) + 1, head: item.run?.ci?.moved ?? item.head }), others: taken.some(e => e.access !== "owner") }, { overflow });
}

/**
 * Whether a delivery from a cross-repo feature's other repository wakes anything: only its own PR's poll
 * once the feature is handed over (`merged`), through the installation bound to it at filing. Never the
 * primary's polls, whose PR may have the same number.
 */
export function siblingWakes(item: FactoryItem, sibling: FeatureRepoState, input: GithubNudge): boolean {
	return !ENDED.has(item.state) && item.run?.step.kind === "merged" && input.kind === "pr" && input.installationId === sibling.installationId && sibling.pr?.number === input.pr;
}

/** Under the item's write queue. A directory lookup may race a new push, a cancel, or a transfer. */
async function nudge(c: Ctx, input: GithubNudge): Promise<boolean> {
	const stored = await load(c.db);
	if (!stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
	const { item, meta } = stored;
	// A cross-repo feature's other repository: its PR poll, woken only by a nudge from the installation bound to that repository at filing.
	const sibling = crossRepo(item) && input.repositoryId !== meta.repository.id ? item.repos!.find(r => r.repositoryId === input.repositoryId) : undefined;
	if (sibling) {
		if (!siblingWakes(item, sibling, input)) return false;
	} else if (ENDED.has(item.state) || input.repositoryId !== meta.repository.id || input.installationId !== await binding(c)) return false;
	const repo = crossRepo(item) ? (sibling ?? item.repos![0]) : undefined;
	const id = repo && item.run?.step.kind === "merged" && input.kind === "pr" ? `poll_repo_pr:${currentKey(item)}/${repo.alias}` : `poll_${input.kind}:${input.kind === "pr" ? prPollKey(item) : currentKey(item)}`;
	const [row] = await c.db.execute<EffectRow>("SELECT * FROM effects WHERE id = ?", id);
	if (!row || c.vars.performing.has(row.id)) return false;
	const poll: Effect = JSON.parse(row.effect);
	const matches = input.kind === "ci" ? poll.kind === "poll_ci" && poll.head === input.head : (poll.kind === "poll_pr" || poll.kind === "poll_repo_pr") && poll.pr === input.pr;
	if (!matches || !live(item, poll)) return false;
	// Pre-webhook CI rows did not retain GitHub's retry floor. Honor their scheduled read once.
	const legacyBackoff = item.run?.ci?.webhooks === undefined && item.wait?.sentence.includes("GitHub asked the platform to wait until");
	const floor = poll.kind === "poll_ci" ? poll.notBefore ?? (legacyBackoff ? poll.at : 0) : 0;
	const at = Math.max(Date.now() + 15_000, floor);
	if (row.due_at > at) {
		await c.db.execute("UPDATE effects SET due_at = ? WHERE id = ?", at, id);
		console.log(`[wlp] factory.${input.kind}.nudged item=${item.id}${input.kind === "ci" ? " head=" + input.head.slice(0, 7) : ""}`);
	}
	// Also repairs a crash between the update and the timer write.
	await armDueInQueue(c);
	return true;
}

/** The repository as the user's connection reaches it now, and the app: what a poll of GitHub needs. */
async function github(c: Ctx, meta: ItemMeta, access: "read" | "write" = "read") {
	const app = githubApp();
	if (!app) throw new Error("the deployment has no GitHub App");
	const connection: StoredConnection | null = await userActor(c, meta.uid).internalGithubConnection();
	if (!connection) throw new GithubProblem("github_gone", "The user’s GitHub connection is gone.");
	const installationId = await binding(c) ?? (await resolveRepository(app, connection, meta.repository.id, "read")).installation.id;
	const resolved = await resolveBoundRepository(app, connection, meta.repository.id, installationId, access);
	const { owner, name } = resolved.repository;
	const pull = (number: number) => app.withToken(resolved.installation.id, { repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "read" } }, (token) => app.pull(token, owner, name, number), { reuse: true });
	return { app, installationId: resolved.installation.id, repository: resolved.repository, owner, name, pull, author: authorOf(connection), login: connection.user.login, connectedUserId: connection.user.id };
}

/**
 * A cross-repo feature's repository as the user's connection reaches it now, through the installation
 * bound to it at filing (never another one it may have moved to), with `perform` given a token scoped to
 * that one repository and `permissions`.
 */
async function repoHub<T>(c: Ctx, meta: ItemMeta, repo: FeatureRepoState, access: "read" | "write", permissions: Record<string, "read" | "write">, perform: (hub: { app: GithubApp; token: string; owner: string; name: string; private: boolean; author: ReturnType<typeof authorOf> }) => Promise<T>): Promise<T> {
	const app = githubApp();
	if (!app) throw new Error("the deployment has no GitHub App");
	const connection: StoredConnection | null = await userActor(c, meta.uid).internalGithubConnection();
	if (!connection) throw new GithubProblem("github_gone", "The user’s GitHub connection is gone.");
	const resolved = await resolveBoundRepository(app, connection, repo.repositoryId, repo.installationId, access);
	const { owner, name } = resolved.repository;
	return app.withToken(repo.installationId, { repositoryId: repo.repositoryId, permissions: { metadata: "read", ...permissions } }, token => perform({ app, token, owner, name, private: resolved.repository.private, author: authorOf(connection) }));
}

async function reconcileFeedback(c: Ctx, meta: ItemMeta, hub: Awaited<ReturnType<typeof github>>, pr: number) {
	const { app, installationId } = hub;
	const target = { repositoryId: meta.repository.id, installationId, pr };
	const now = Date.now();
	const [cursor] = await c.db.execute<{ since: number }>("SELECT since FROM feedback_cursor WHERE id=1");
	const subjects: FeedbackSubject[] = [];
	const since = Math.max(now - 3 * 86_400_000, (cursor?.since ?? meta.createdAt) - 1000);
	await app.withToken(installationId, { repositoryId: target.repositoryId, permissions: { metadata: "read", pull_requests: "read" } }, async token => {
		// Run again with a new token when a kept one is refused: nothing of a refused try is kept.
		subjects.length = 0;
		const repo = hub.repository;
		for (const r of await app.reviews(token, repo, pr)) {
			if (!recentSubject(r.at, now)) continue;
			if (r.state === "approved" || r.state === "changes_requested" || (r.state === "commented" && isAddressed(r.body, app.settings.slug) !== null))
				subjects.push({ kind: "review", sender: r.author, association: r.association, id: r.id });
			// A single line comment comes as a "commented" review with an empty body: its lines may be addressed.
			// Only reviews since the last poll are opened, so each costs one call once.
			else if (r.state === "commented" && r.at >= since) {
				for (const line of await app.reviewComments(token, repo, pr, r.id))
					if (recentSubject(line.at, now) && isAddressed(line.body, app.settings.slug) !== null)
						subjects.push({ kind: "review_comment", sender: line.author, association: line.association, id: line.id });
			}
		}
		for (const r of await app.issueComments(token, repo.owner, repo.name, pr, true, since))
			if (r.id && r.person && isAddressed(r.body, app.settings.slug) !== null) subjects.push({ kind: "issue_comment", sender: r.person, association: r.association, id: r.id });
	}, { reuse: true });
	for (const s of subjects) {
		const id = feedbackId(s);
		if ((await c.db.execute("SELECT 1 FROM feedback WHERE id=? UNION ALL SELECT 1 FROM issue_actions WHERE subject IN (?,?) LIMIT 1", id, id, "feedback-denied:" + id)).length) continue;
		const notice = await readFeedback(c, meta.uid, target, s, githubConfig().webhook ? undefined : hub.connectedUserId);
		if (notice) await receiveFeedback(c, notice);
	}
	await c.db.execute("INSERT OR REPLACE INTO feedback_cursor VALUES(1,?)", now);
}

/** `featureModel`: the feature's Windlass model, which a Windlass subtask choosing only an effort runs. */
async function placementInventory(c: Ctx, uid: string, featureModel: string | undefined, snapshotRepository?: GithubId): Promise<PlacementInventory> {
	const user = userActor(c, uid);
	const [machines, limited, dailyTokenWait, models, snapshotPlaces] = await Promise.all([user.internalPlannerMachines(), user.internalLimitedAccounts(), user.internalDailyTokenWait(), user.internalAgentModels(),
		// Only a hint for ranking places: a failure leaves it out.
		snapshotRepository === undefined ? undefined : user.internalSnapshotPlaces(snapshotRepository).catch(() => undefined)]);
	const { sandboxes } = await getLayer();
	const hostedProfiles = sandboxes.profiles().filter(p => p.available).map(p => p.id);
	return { machines, hostedProfiles, hostedEgress: sandboxes.egress?.(), limited, dailyTokenWait, models, ...(featureModel && { featureModel }), ...(snapshotPlaces?.length && { snapshotPlaces }) };
}

/**
 * Approval of a cross-repo plan: every repository is checked through its own installation before any
 * branch is made, and every refusal is named at once. Each needs saved checks and push CI on the actual
 * feature and child branch names; the combined run's repository needs the integration workflow; a base
 * that moved since the planner read it is named, and approval needs the person to reconfirm it (`bases`).
 */
async function checkCrossRepo(c: Ctx, stored: Stored, bases: Readonly<Record<string, string>>) {
	const { item, meta } = stored;
	const plan = item.featurePlan!;
	const pending = plan.subtasks.filter(s => !item.jobs?.some(j => j.task.key === s.key && j.state === "done"));
	const problems: string[] = [];
	const unknown = Object.keys(bases).filter(alias => !item.repos!.some(r => r.alias === alias));
	if (unknown.length) problems.push(`bases names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a repository of this feature.`);
	for (const repo of item.repos!) {
		const label = `${repo.owner}/${repo.name}`;
		try {
			if (!await userActor(c, meta.uid).internalHasChecks(repo.repositoryId)) problems.push(`${label}: add saved repository checks.`);
			const branches = [featureBranch(item.id), ...pending.filter(s => (s.repo ?? item.repos![0].alias) === repo.alias).map(s => branchFor(s.title, itemSessionId(childItemId(item.id, plan.version, s.key))))];
			problems.push(...await repoHub(c, meta, repo, "write", { contents: "read", actions: "read", checks: "read", statuses: "read", pull_requests: "read" }, async ({ app, token, owner, name, private: hidden }) => {
				const found = await repositoryAdmission(app, token, owner, name, { alias: repo.alias, baseRef: repo.baseRef, ciBase: repo.pr ? featureBranch(item.id) : repo.baseRef, branches, planningBaseSha: repo.planningBaseSha,
					reconfirmed: bases[repo.alias], runsIntegration: plan.finalIntegration?.runFrom === repo.alias, opened: !!repo.pr });
				// As GitHub says it now, not as it was at filing: a repository made private since is checked out by no one.
				if (plan.finalIntegration?.runFrom !== repo.alias && hidden) found.push(`${label}: the combined run checks out the other repositories without a token, so ${label} must be public.`);
				return found;
			}));
		} catch (error) {
			problems.push(`${label}: ${error instanceof GithubProblem ? error.message : describeError(error)}`);
		}
	}
	if (problems.length) throw new PlanError("Approval needs every repository ready first. " + problems.join(" "));
}

async function checkFeatureCi(c: Ctx, stored: Stored, bases: Readonly<Record<string, string>> = {}) {
	if (crossRepo(stored.item)) return checkCrossRepo(c, stored, bases);
	const { item, meta } = stored;
	if (!await userActor(c, meta.uid).internalHasChecks(meta.repository.id))
		throw new PlanError("Use a single item or add saved repository checks before approving orchestration.");
	const hub = await github(c, meta, "write");
	const plan = item.featurePlan!;
	const pending = plan.subtasks.filter(s => !item.jobs?.some(j => j.task.key === s.key && j.state === "done"));
	const branches = [featureBranch(item.id), ...pending.map(s => branchFor(s.title, itemSessionId(childItemId(item.id, plan.version, s.key))))];
	const eligible = await hub.app.withToken(hub.installationId, { repositoryId: meta.repository.id, permissions: { metadata: "read", contents: "read", actions: "read", checks: "read", statuses: "read", pull_requests: "read" } },
		token => hasPushCi(hub.app, token, hub.owner, hub.name, item.pr ? featureBranch(item.id) : meta.repository.branch, branches));
	if (!eligible) throw new PlanError("Use a single item or add CI that reports on pushes to the feature and child branches before approving orchestration.");
}

function repositoryDirectory(c: Ctx, meta: ItemMeta) {
	return c.client().githubRepository.getOrCreate([String(meta.repository.id)], { params: serviceParams() });
}

async function updateDirectory(c: Ctx, meta: ItemMeta, effect: Extract<Effect, { kind: "register" | "forget" }>): Promise<boolean> {
	const item = c.vars.stored?.item;
	if (effect.kind === "register" && effect.repo && item && crossRepo(item)) {
		const repo = repoOf(item, effect.repo);
		const directory = c.client().githubRepository.getOrCreate([String(repo.repositoryId)], { params: serviceParams() });
		return queued(c, async () => {
			const durable = await load(c.db);
			if (!durable || !live(durable.item, effect)) return false;
			await directory.internalRegister({ uid: meta.uid, itemId: durable.item.id, installationId: repo.installationId, pr: effect.pr, head: effect.head });
			return true;
		});
	}
	if (effect.kind === "forget" && item && crossRepo(item)) {
		for (const repo of item.repos!.slice(1)) await c.client().githubRepository.getOrCreate([String(repo.repositoryId)], { params: serviceParams() }).internalForget(item.id);
	}
	const directory = repositoryDirectory(c, meta);
	const installation = effect.kind === "register" ? (await github(c, meta)).installationId : null;
	// Order directory writes with local decisions, outside any SQLite transaction.
	return queued(c, async () => {
		const durable = await load(c.db);
		if (!durable || !live(durable.item, effect)) return false;
		if (effect.kind === "forget" && meta.github && !ENDED.has(durable.item.state)) return true;
		if (effect.kind === "register" && installation !== null) {
			await c.db.execute("INSERT OR REPLACE INTO github_binding VALUES (1, ?)", String(installation));
			await directory.internalRegister({ uid: meta.uid, itemId: durable.item.id, installationId: installation, pr: effect.pr, head: effect.head, moved: durable.item.run?.ci?.moved });
		} else {
			await directory.internalForget(durable.item.id);
			const installed = await binding(c);
			if (durable.item.state === "failed" && durable.item.pr && installed !== null) {
				await directory.internalRegister({ uid: meta.uid, itemId: durable.item.id, installationId: installed, pr: durable.item.pr.number });
			} else if (!meta.github) await c.db.execute("DELETE FROM github_binding");
		}
		return true;
	});
}

const itemUrl = (id: string) => `${config.origins[0]}/items/${encodeURIComponent(id)}`;

async function storeCheckReceipt(tx: Pick<RawAccess, "execute">, itemId: string, fact: CheckReceipt, events: ItemEvent[]) {
	const e = fact.effect;
	const denied = fact.id === null;
	await tx.execute(`INSERT INTO checks VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha) DO UPDATE SET
		check_run_id=coalesce(excluded.check_run_id,checks.check_run_id), external_id=excluded.external_id,
		state=excluded.state, conclusion=excluded.conclusion, at=excluded.at, said=excluded.said`,
		e.key, fact.id, e.verdictId ?? `pending:${itemId}:${e.run}`, denied ? "not_posted" : e.state, denied ? null : e.conclusion, e.changedAt, denied ? CHECK_DENIED : e.title);
	if (denied && !(await tx.execute("SELECT 1 FROM events WHERE json_extract(data, '$.step.run') = ? AND json_extract(data, '$.said') = ? LIMIT 1", e.run, CHECK_DENIED)).length)
		events.push({ by: "platform", at: fact.at, step: e.step, said: CHECK_DENIED });
}

async function prepareCompletedCheck(tx: Pick<RawAccess, "execute">, item: FactoryItem, effect: Extract<VerifiedCheckEffect, { state: "completed" }>, handoff: Handoff) {
	let assessment = handoff.review !== null ? handoff.assessment ?? null : null;
	// Reviews filed before check runs carried only their filing id on the handoff.
	if (handoff.review && !assessment) {
		const [row] = await tx.execute<{ data: string }>("SELECT data FROM reviews WHERE id=?", handoff.review);
		const filed: ItemReview | null = row ? JSON.parse(row.data) : null;
		if (filed?.recommendation) assessment = { recommendation: filed.recommendation, blocking: filed.blocks.filter(b => b.kind === "finding" && b.severity === "blocking").length };
	}
	const unfinished = handoff.unfinished === true;
	effect.title = checkTitle(handoff.verdict, assessment, unfinished);
	effect.conclusion = checkConclusion(handoff.verdict, assessment, unfinished);
	effect.summary = checkSummary(handoff.verdict, assessment, item.spent, item.budget, itemUrl(item.id), itemAgent(item), unfinished);
}

/** Only the token request and the write treat a permission refusal as a finished effect. */
function checkRefused(error: unknown): null {
	if (error instanceof GithubError && (error.status === 403 || error.status === 422)) return null;
	throw error;
}

async function postVerifiedCheck(c: Ctx, meta: ItemMeta, itemId: string, e: VerifiedCheckEffect): Promise<void> {
	const { app, installationId, owner, name } = await github(c, meta, "write");
	const issued = await app.installationToken(installationId, {
		repositoryId: meta.repository.id, permissions: { metadata: "read", checks: "write" },
	}).catch(checkRefused);
	let id: string | null = null;
	if (issued) {
		const { token } = issued;
		const [row] = await c.db.execute<{ check_run_id: string | null }>("SELECT check_run_id FROM checks WHERE sha=?", e.key);
		const existing = row?.check_run_id ?? await app.findCheckRun(token, owner, name, e.key, itemId);
		if (!existing && e.existingOnly) return;
		const url = itemUrl(itemId);
		const update: CheckRunUpdate = {
			external_id: e.verdictId ?? `pending:${itemId}:${e.run}`,
			details_url: url,
			started_at: new Date(e.startedAt).toISOString(),
			output: { title: e.title, summary: e.verdictId ? e.summary : e.summary + "\n\n" + evidenceLine(url) },
			...(e.state === "in_progress" ? { status: e.state } : { status: e.state, conclusion: e.conclusion, completed_at: new Date(e.changedAt).toISOString() }),
		};
		id = existing
			? await app.updateCheckRun(token, owner, name, existing, update).then(() => existing).catch(checkRefused)
			: await app.createCheckRun(token, owner, name, e.key, update).catch(checkRefused);
	}
	await take(c, { kind: "check_recorded", at: Date.now(), effect: e, id, installationId });
}

type Handoff = Extract<Effect, { kind: "handoff" }>;

async function handoffProblem(c: Ctx, effect: Handoff, said: string): Promise<void> {
	const [, , n, attempt] = effect.key.split(":");
	const event: ItemEvent = { at: Date.now(), by: "platform", step: { run: effect.verdict.run, kind: "handoff", n: Number(n), attempt: Number(attempt) }, said };
	// A scheduled retry of the same refusal leaves one explanation in the item's log.
	await queued(c, () => c.db.execute(
		"INSERT INTO events (at, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE json_extract(data, '$.step.run') = ? AND json_extract(data, '$.step.kind') = 'handoff' AND json_extract(data, '$.said') = ?)",
		event.at, JSON.stringify(event), effect.verdict.run, said,
	));
}

/**
 * Posts the item's verdict comment on its pull request, or edits the one posted before. The comment's id
 * is kept on the item when it is first posted or found, and edited by that id afterwards: a pull request
 * with more comments than are listed (ten pages) is never searched again, so it gets no second comment.
 * Without a kept id (posted before ids were kept, or the reply to the post was lost) the platform looks
 * for its marker, and refuses rather than post again when the list is cut short.
 */
async function writeMarkedComment(c: Ctx, app: GithubApp, token: string, owner: string, name: string, pr: number, item: string, body: string) {
	const [kept] = await c.db.execute<{ id: string }>("SELECT id FROM verdict_comment WHERE pr=?", pr);
	if (kept) {
		try {
			await app.updateIssueComment(token, owner, name, kept.id, body);
			return;
		} catch (error) {
			// Deleted on GitHub: ours is gone, so posting it again makes no second one.
			if (!(error instanceof GithubError && error.status === 404)) throw error;
			await c.db.execute("DELETE FROM verdict_comment WHERE pr=? AND id=?", pr, kept.id);
			const id = await app.createIssueComment(token, owner, name, pr, body);
			if (id) await c.db.execute("INSERT OR REPLACE INTO verdict_comment VALUES(?,?)", pr, id);
			return;
		}
	}
	const marker = `<!-- windlass-item:${item} -->`;
	const comments = await app.issueComments(token, owner, name, pr, true);
	const own = comments.find(c => c.author.toLowerCase() === app.settings.slug.toLowerCase() + "[bot]" && c.body.split("\n", 1)[0] === marker);
	if (own && !own.id) throw new Error("GitHub returned an invalid verdict comment id");
	const id = own?.id ?? await app.createIssueComment(token, owner, name, pr, body);
	if (own?.id) await app.updateIssueComment(token, owner, name, own.id, body);
	if (id) await c.db.execute("INSERT OR REPLACE INTO verdict_comment VALUES(?,?)", pr, id);
}

async function handoffOnGithub(c: Ctx, meta: ItemMeta, number: number, effect: Handoff, row: EffectRow): Promise<void> {
	const { verdict } = effect;
	let action = "reach the pull request";
	try {
		const { app, installationId, owner, name, login } = await github(c, meta);
		await app.withToken(installationId, { repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "write" } }, async (token) => {
			if (!effect.reviewDone) {
				action = "request your review";
				const pull = await app.pull(token, owner, name, number);
				const rows = await c.db.execute<{ login: string }>("SELECT DISTINCT json_extract(data,'$.author') AS login FROM feedback WHERE state='taken' AND run=? AND json_extract(data,'$.kind')='changes_requested'", verdict.run);
				const wanted = [...new Set([login, ...rows.map(r => r.login)])].filter(name => !pull.requestedReviewers.some(r => r.toLowerCase() === name.toLowerCase()));
				for (const reviewer of wanted) {
					try {
						await app.requestReviewers(token, owner, name, number, [reviewer]);
					} catch (error) {
						if (!(error instanceof GithubError && error.status === 422)) throw error;
						console.log(`[wlp] factory.review_request_refused item=${verdict.item} status=422`);
						await handoffProblem(c, effect, "GitHub refused the review request (422).");
					}
				}
				// The person may finish their review while a refused comment waits to be retried.
				const done = JSON.stringify({ ...effect, reviewDone: true });
				await queued(c, () => c.db.execute("UPDATE effects SET effect = ? WHERE id = ? AND effect = ?", done, row.id, row.effect));
				row.effect = done;
			}

			action = "post the verdict comment";
			const [reviewRow] = effect.review ? await c.db.execute<{ data: string }>("SELECT data FROM reviews WHERE id = ?", effect.review) : [];
			const body = itemComment(verdict, effect.words, await latestReport(c.db, verdict.run), { filed: reviewRow ? JSON.parse(reviewRow.data) as ItemReview : null, reason: effect.reviewNone, owner, name });
			await writeMarkedComment(c, app, token, owner, name, number, verdict.item, body);
		});
	} catch (error) {
		const status = error instanceof GithubError && error.status ? ` (GitHub ${error.status})` : "";
		await handoffProblem(c, effect, `Could not ${action}${status}. The platform will try again.`);
		throw error;
	}
}

function itemNetwork(meta: Pick<ItemMeta, "blockedSessions">) {
	return unionNetwork(...Object.values(meta.blockedSessions ?? {}).map(receipt => receipt.network));
}

/**
 * The item's lifetime hosted seconds after the ledger's latest entries for its session: each hold
 * counted once, whenever it is seen, and kept after the ledger has let it go. Decided synchronously on
 * the stored meta, which the next write of the item stores.
 */
function sessionsOf(meta: ItemMeta): string[] {
	return meta.reviewerSessionId ? [meta.sessionId, meta.reviewerSessionId] : [meta.sessionId];
}

const childSeconds = (item: FactoryItem) => (item.jobs ?? []).reduce((sum, j) => sum + j.spent.hostedSeconds, 0);

function lifetimeSeconds(meta: ItemMeta, facts: ItemFacts): number {
	const seen = new Set(meta.ledger.holds);
	const fresh = facts.entries.filter((entry) => !seen.has(entry.hold));
	// Every hold ever counted is kept: an older answer that comes back after a newer one would otherwise drop a hold, which the
	// next answer would count again. An item's life holds few of them (its hosted budget, in holds of minutes).
	meta.ledger = { seconds: meta.ledger.seconds + ledgerSeconds(fresh, sessionsOf(meta)), holds: [...meta.ledger.holds, ...fresh.map((entry) => entry.hold)] };
	return meta.ledger.seconds;
}

/** The user's facts for the item, and the item's hosted time taken in when it has grown: settled after a turn, it would otherwise be missed. */
async function factsOf(c: Ctx, meta: ItemMeta): Promise<ItemFacts> {
	const facts = await userActor(c, meta.uid).internalItemFacts(sessionsOf(meta));
	const stored = c.vars.stored;
	if (stored?.item.place.kind === "hosted") {
		const seconds = lifetimeSeconds(stored.meta, facts) + childSeconds(stored.item);
		if (seconds > stored.item.spent.hostedSeconds) await take(c, { kind: "spent", at: Date.now(), hostedSeconds: seconds });
	}
	return facts;
}

/** States in which an item asks nothing more of anyone: what was stored for its steps is not done. */
const ENDED: ReadonlySet<FactoryItem["state"]> = new Set(["done", "cancelled", "failed"]);

/**
 * Whether an effect is still wanted by the item as it is: of its current step's current attempt, with
 * the item not ended. Decided in the transaction that moves the item on (the rows it leaves behind go)
 * and again in the step that sends an effect, since a row read before a cancel may be performed after
 * it. A withdrawal is always wanted: it is what a cancel leaves.
 */
export function live(item: FactoryItem, effect: Effect): boolean {
	if (effect.kind === "feedback_ready" || effect.kind === "feedback_ack") return true;
	if (effect.kind === "feedback_comment") return item.run?.n === effect.run && item.state !== "review" && !ENDED.has(item.state);
	if (effect.kind === "notify_integrated") return item.state === "done" && item.head === effect.head;
	if (effect.kind === "cancel_children" || effect.kind === "verified_check") return true;
	if (effect.kind === "issue_comment") return true;
	if (effect.kind === "check_issue" || effect.kind === "register_issue") return !ENDED.has(item.state);
	if (effect.kind === "forget") return ENDED.has(item.state) || !item.run?.ci;
	if (effect.kind === "register" && effect.repo) return !ENDED.has(item.state) && crossRepo(item) && repoOf(item, effect.repo).pr?.number === effect.pr;
	if (effect.kind === "register") return !ENDED.has(item.state) && item.head === effect.head && item.pr?.number === effect.pr;
	// The managed PR sections say where the feature stands while it runs; an ended feature writes no more.
	if (effect.kind === "link_prs") return crossRepo(item) && item.state !== "draft" && !ENDED.has(item.state);
	if (effect.kind === "release_review" || effect.kind === "withdraw" || effect.kind === "ask") return true;
	const run = item.run;
	if (item.question?.kind === "machine_removed" || ENDED.has(item.state) || run === null) return false;
	const key = currentKey(item);
	switch (effect.kind) {
		case "provider_retry": return effect.key === key && item.wait?.reason === "provider" && !item.question;
		case "fresh_sandbox": return effect.key === key && !item.question && run.step.turn === null;
		case "describe_feature": return effect.key === key && run.step.kind === "publish" && !item.question;
		case "integration":
		case "poll_integration": return effect.key === key && run.step.kind === "integration" && !item.question && item.integration?.attempt === effect.attempt;
		case "poll_repo_pr": return effect.key === `${key}/${effect.repo}` && run.step.kind === "merged" && item.state === "review" && !item.question;
		case "integrate": return effect.key === key && run.step.kind === "subtasks" && !item.question;
		case "dispatch": return !item.question && effect.key === key && run.step.kind === "subtasks";
		case "deliver":
			return effect.key === key && run.step.turn === "delivered";
		case "check_turn":
			return effect.turn === key && run.step.turn !== null;
		case "publish":
			return effect.key === key && run.step.kind === "publish" && item.question?.kind !== "turn_refused";
		case "poll_ci":
			return effect.key === key && (run.step.kind === "ci" || run.step.kind === "handoff") && (item.pr !== null || !!item.parent);
		case "poll_pr":
			return effect.key === prPollKey(item) && effect.pr === item.pr?.number;
		case "handoff":
			return item.pr !== null && (run.n === effect.verdict.run || (run.n === effect.continuedIn && !run.ci?.handed));
	}
}

/** Merge into the first delivery's window. A delivery during the read needs a subsequent window. */
async function queueIssueCheck(c: Ctx, input: IssueNotice) {
	await queued(c, async () => {
		if (!c.vars.stored || ENDED.has(c.vars.stored.item.state)) return;
		const id = "check_issue:pending";
		const [row] = await c.db.execute<EffectRow>("SELECT * FROM effects WHERE id=?", id);
		const old: IssueCheck | undefined = row && JSON.parse(row.effect);
		const now = Date.now();
		const reading = c.vars.performing.has(id);
		let at = old && !(reading && old.at <= now) ? old.at : now + ISSUE_CHANGE_WINDOW_MS;
		if (!reading && input.action === "closed" && input.senderId === c.vars.stored.meta.github!.senderId) {
			// Withdraw a running turn promptly when the filer closes. Respect the same read budget.
			const [item] = await c.db.execute<{ issue_checked_at: number }>("SELECT issue_checked_at FROM item WHERE id=1");
			at = Math.min(at, Math.max(now, item.issue_checked_at + ISSUE_CHANGE_WINDOW_MS));
		}
		const next: IssueCheck = { kind: "check_issue", key: "pending", ...old, at };
		if (input.action === "edited") next.edited = true;
		else if (!next.closedBy?.includes(input.senderId)) next.closedBy = [...(next.closedBy ?? []), input.senderId];
		const data = JSON.stringify(next);
		if (row?.effect !== data) {
			await c.db.execute("INSERT OR REPLACE INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, ?)", id, data, row?.attempts ? Math.max(at, row.due_at) : at, row?.attempts ?? 0);
		}
		await armDueInQueue(c);
	});
}

async function checkIssue(c: Ctx, meta: ItemMeta, changes: IssueChanges) {
	const binding = meta.github!;
	const connection = await userActor(c, meta.uid).internalGithubConnection();
	if (!connection?.installations.some(i => i.id === binding.installationId)) return;
	const observations = await observeIssue(binding, meta.repository.id, changes, by => repositoryDirectory(c, meta).internalIssuePermission(binding.installationId, by));
	for (const seen of observations) {
		if ((await c.db.execute("SELECT 1 FROM issue_actions WHERE subject=?", seen.subject)).length) continue;
		const state = c.vars.stored!.item.state;
		if (ENDED.has(state) || (state === "review" && (seen.cancel === "before_review" || seen.subject === "stranger-close"))) continue;
		const cancel = seen.cancel === "draft" ? state === "draft" : seen.cancel === "before_review";
		await take(c, cancel ? { kind: "cancel", at: Date.now(), by: seen.by } : { kind: "issue_note", at: Date.now() }, { issue: seen });
	}
}

export function rescheduleChildPoll(db: Pick<RawAccess, "execute">, row: EffectRow, now: number) {
	return db.execute("UPDATE effects SET due_at = ?, attempts = attempts + 1 WHERE id = ? AND effect = ?", retryAt(now, row.attempts + 1), row.id, row.effect);
}

/**
 * Whether `error` says the platform cannot reach a repository or PR any more (the App lost access, the
 * repository was archived or removed, the PR is gone), so trying again changes nothing. A rate limit or an
 * outage is not that: it is tried again.
 */
export function lostAccess(error: unknown): boolean {
	if (error instanceof GithubProblem) return error.code === "github_denied" || error.code === "github_gone";
	return error instanceof GithubError && !error.rateLimited && !error.unreachable && [401, 403, 404, 410, 422].includes(error.status);
}

/**
 * Writes the managed section on each of a cross-repo feature's PRs, keeping what anyone else wrote there.
 * A PR the platform cannot write to any more is left as it is: the section is a courtesy, never retried for ever.
 */
async function linkPrs(c: Ctx, meta: ItemMeta, item: FactoryItem): Promise<void> {
	for (const repo of item.repos ?? []) {
		if (!repo.pr) continue;
		const pr = repo.pr.number;
		try {
			await repoHub(c, meta, repo, "write", { pull_requests: "write" }, async ({ app, token, owner, name }) => {
				const latest = c.vars.stored?.item ?? item;
				const pull = await app.pull(token, owner, name, pr);
				const body = withSection(pull.body, linkSection(latest, repo.alias));
				if (body !== pull.body) await app.updatePull(token, owner, name, pr, { title: pull.title, body });
			});
		} catch (error) {
			if (!lostAccess(error)) throw error;
			console.log(`[wlp] factory.cross_repo.link_dropped item=${item.id} repo=${repo.alias} said=${JSON.stringify(describeError(error))}`);
		}
	}
}

/** Opens a cross-repo feature one repository at a time (a seed, then a draft PR), or writes both PR descriptions after its summary. */
async function crossOpenOrDescribe(c: Ctx, meta: ItemMeta, item: FactoryItem, effect: Extract<Effect, { kind: "dispatch" | "describe_feature" }>): Promise<void> {
	const key = effect.key;
	const opening = effect.kind === "dispatch" ? nextOpening(item) : null;
	try {
		if (opening) {
			const { repo } = opening;
			await repoHub(c, meta, repo, "write", { contents: "write", pull_requests: "write" }, async ({ app, token, owner, name, author }) => {
				if (!live(c.vars.stored!.item, effect)) return;
				if (opening.step === "seed") {
					// The commit the planner read, or reconfirmed at approval: the feature starts where it was planned.
					const sha = repo.planningBaseSha ?? await refHead(app, token, owner, name, repo.baseRef);
					await take(c, { kind: "feature_seed", key, sha, repo: repo.alias, at: Date.now() });
					return;
				}
				const opened = await openFeature(app, token, owner, name, { id: item.id, title: item.task.title, base: repo.baseRef, seed: repo.seed!, author, created: meta.createdAt, body: networkBody(withSection(item.featurePlan!.spec.goal, linkSection(item, repo.alias)), itemNetwork(meta), false), draftOnly: true });
				await take(c, { kind: "feature_ready", key, ...opened, repo: repo.alias, at: Date.now() });
			});
			return;
		}
		const report = await latestReport(c.db, item.run!.n);
		const text = [report?.title, ...report?.blocks.map(b => "text" in b ? b.text : "") ?? [], meta.github && issueReference(item.repos![0], meta.github.origin.issue.number)].filter(Boolean).join("\n\n");
		for (const repo of item.repos!) {
			const pr = repo.pr!.number;
			await repoHub(c, meta, repo, "write", { pull_requests: "write" }, ({ app, token, owner, name }) =>
				app.updatePull(token, owner, name, pr, { title: item.task.title, body: networkBody(withSection(text, linkSection(item, repo.alias)), itemNetwork(meta), false) }));
		}
		await take(c, { kind: "published", key, at: Date.now(), pr: item.pr, head: item.head!, openItems: 1, webhooks: githubConfig().pollFallback });
	} catch (error) {
		const denied = error instanceof GithubProblem && (error.code === "github_denied" || error.code === "github_gone");
		if (!denied && !(error instanceof GithubError && [403, 404, 409, 422].includes(error.status))) throw error;
		const where = opening ? `${opening.repo.owner}/${opening.repo.name}: ` : "";
		await take(c, { kind: "feature_problem", key, at: Date.now(), reason: where + error.message });
	}
}

/** Starts a cross-repo feature's combined run, or reads it. A refusal by GitHub (no workflow, no permission) is a run that could not run. */
async function integrationStep(c: Ctx, meta: ItemMeta, item: FactoryItem, effect: Extract<Effect, { kind: "integration" | "poll_integration" }>): Promise<void> {
	const plan = item.approvedPlan?.finalIntegration;
	const run = item.integration!;
	const base = { at: Date.now(), key: effect.key, attempt: effect.attempt };
	if (!plan) return void await take(c, { ...base, kind: "integration_read", state: "unavailable", url: null, said: "the approved plan has no combined run" });
	const from = repoOf(item, plan.runFrom);
	try {
		if (effect.kind === "integration") {
			// A PR merged or closed already: the set is not what would be tested.
			for (const repo of item.repos!) {
				const state = await repoHub(c, meta, repo, "read", { pull_requests: "read" }, ({ app, token, owner, name }) => app.pull(token, owner, name, repo.pr!.number).then(p => p.state));
				if (state === "merged" || state === "closed")
					return void await take(c, { ...base, kind: "integration_read", state: "unavailable", url: null, said: `${repo.owner}/${repo.name}#${repo.pr!.number} was ${state} before the repositories were tested together` });
			}
			// The workflow GitHub runs is the one at the dispatched commit: it is checked there, every time.
			const refused = await repoHub(c, meta, from, "read", { actions: "read", contents: "read" }, ({ app, token, owner, name }) =>
				integrationWorkflowProblem(app, token, owner, name, effect.heads[plan.runFrom]));
			if (refused) return void await take(c, { ...base, kind: "integration_read", state: "unavailable", url: null, said: refused });
			const heads = Object.fromEntries(item.repos!.filter(r => plan.inputs.includes(r.alias)).map(r => [r.alias, { repository: `${r.owner}/${r.name}`, sha: effect.heads[r.alias] }]));
			const started = await repoHub(c, meta, from, "write", { actions: "write" }, ({ app, token, owner, name }) =>
				dispatchIntegration(app, token, owner, name, { ref: featureBranch(item.id), item: item.id, attempt: effect.attempt, heads, runFrom: plan.runFrom, command: plan.command, timeoutSeconds: plan.timeoutSeconds }));
			await take(c, { ...base, kind: "integration_started", runId: started?.runId ?? null, url: started?.url ?? null });
			return;
		}
		// The run is the platform's only on the head of `runFrom` it was dispatched on.
		const runHead = run.heads?.[plan.runFrom] ?? "";
		const reading = await repoHub(c, meta, from, "read", { actions: "read" }, ({ app, token, owner, name }) =>
			run.runId ? readIntegrationRun(app, token, owner, name, run.runId, runHead) : findIntegrationRun(app, token, owner, name, featureBranch(item.id), item.id, effect.attempt, runHead));
		if (!reading) {
			const lost = run.dispatchedAt !== null && Date.now() - run.dispatchedAt > 10 * 60_000;
			await take(c, { ...base, kind: "integration_read", state: lost ? "unavailable" : "queued", url: null, said: lost ? "GitHub lists no run of the integration workflow for this attempt" : null });
		} else if (!run.runId) await take(c, { ...base, kind: "integration_started", runId: reading.runId, url: reading.url });
		else await take(c, { ...base, kind: "integration_read", state: reading.state, url: reading.url, said: reading.said, ...(reading.seconds !== undefined && { seconds: reading.seconds }) });
	} catch (error) {
		const denied = error instanceof GithubProblem && (error.code === "github_denied" || error.code === "github_gone");
		if (!denied && !(error instanceof ForeignRun) && !(error instanceof GithubError && [403, 404, 422].includes(error.status))) throw error;
		await take(c, { ...base, kind: "integration_read", state: "unavailable", url: null, said: error.message });
	}
}

/**
 * Performs one effect: what comes of it is taken as a fact. Throws when it could not be done, to be
 * tried again; answers false when the item as it is now does not want it, and nothing was done.
 */
async function perform(c: Ctx, row: EffectRow): Promise<boolean | "deferred"> {
	const effect: Effect = JSON.parse(row.effect);
	const stored = c.vars.stored;
	// Checked in the step that sends it: a cancel stored since the row was read leaves it undone.
	if (!stored || !live(stored.item, effect)) return false;
	const { item, meta } = stored;
	const sessionId = "to" in effect && effect.to === "review" ? meta.reviewerSessionId : meta.sessionId;
	if (!sessionId) throw new Error("Review delivery has no reviewer session.");
	const session = sessionActor(c, meta.uid, sessionId);
	// Catch only the session RPC. A failure from GitHub or another actor still belongs to the retry queue.
	const gone = Symbol("deleted session");
	const onGone = async (error: unknown): Promise<typeof gone> => {
		if (!isSessionGone(error)) throw error;
		if ((effect.kind === "deliver" || effect.kind === "check_turn" || effect.kind === "fresh_sandbox" || effect.kind === "publish")
			&& c.vars.stored && live(c.vars.stored.item, effect)) {
			await take(c, { kind: "session_deleted", key: effect.kind === "check_turn" ? effect.turn : effect.key, at: Date.now() });
		}
		return gone;
	};
	switch (effect.kind) {
		case "provider_retry":
			await take(c, { ...effect, at: Date.now(), loginChanged: row.due_at < effect.at });
			return true;
		case "feedback_ready":
			await feedbackReady(c);
			return "deferred";
		case "feedback_ack": {
			const hub = await github(c, meta);
			const [kind, id] = effect.key.split(":") as ["issue_comment" | "review_comment", string];
			await hub.app.withToken(hub.installationId, { repositoryId: meta.repository.id, permissions: { metadata: "read", [kind === "issue_comment" ? "issues" : "pull_requests"]: "write" } },
				token => hub.app.react(token, hub, { kind, id }, "eyes")).catch(error => {
				if (!(error instanceof GithubError && [404, 410].includes(error.status))) throw error;
			});
			return true;
		}
		case "feedback_comment": {
			const update = c.vars.handoff.then(async () => {
				if (!live(c.vars.stored!.item, effect)) return;
				const hub = await github(c, meta);
				await hub.app.withToken(hub.installationId, { repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "write" } }, async token => {
					const marker = `<!-- windlass-item:${item.id} -->`;
					const [prev] = await c.db.execute<{data:string}>("SELECT data FROM verdicts WHERE run < ? ORDER BY at DESC,rowid DESC LIMIT 1", effect.run);
					let body = marker + "\n\n" + feedbackComment(effect.who, effect.run);
					if (prev) {
						const verdict: Verdict = JSON.parse(prev.data);
						const [filed] = await c.db.execute<{data:string}>("SELECT data FROM reviews WHERE run=? AND head=? ORDER BY at DESC LIMIT 1", verdict.run, verdict.head);
						body = itemComment(verdict, verdictWords(verdict, null), await latestReport(c.db, verdict.run),
							{ filed: filed ? JSON.parse(filed.data) : null, reason: null, owner: hub.owner, name: hub.name }, effect);
					}
					await writeMarkedComment(c, hub.app, token, hub.owner, hub.name, item.pr!.number, item.id, body);
				});
			});
			c.vars.handoff = update.catch(() => {});
			await update;
			return true;
		}
		case "verified_check":
			// A handoff or cancellation can replace a pending row after the due scan.
			if (!(await c.db.execute("SELECT 1 FROM effects WHERE id=? AND effect=?", row.id, row.effect)).length) return true;
			await postVerifiedCheck(c, meta, item.id, effect);
			return true;
		case "notify_integrated":
			await itemActor(c, meta.uid, item.parent!.itemId).internalChildNotice({ id:item.id, spent:item.spent, budget:item.budget, state:"done", integratedHead:effect.head });
			return true;
		case "cancel_children":
			for (const child of effect.ids) {
				const view = await userActor(c, meta.uid).internalFeatureChild({ parent: item.id, child, cancel: true });
				const active = c.vars.stored?.item, job = active?.jobs?.at(-1);
				if (!view && active && job?.id === child && job.cancelRequested && job.state === "draft" && !ENDED.has(active.state)) {
					// A placement wait has no child actor to report cancellation.
					await take(c, { kind: "child_update", key: currentKey(active)!, child, state: "cancelled",
						spent: job.spent, head: null, report: "Cancelled before launch.", at: Date.now() });
				}
			}
			return true;
		case "link_prs":
			await linkPrs(c, meta, item);
			return true;
		case "integration":
		case "poll_integration":
			await integrationStep(c, meta, item, effect);
			return true;
		case "poll_repo_pr": {
			const repo = repoOf(item, effect.repo);
			let pull: Awaited<ReturnType<GithubApp["call"]>>;
			try {
				pull = await repoHub(c, meta, repo, "read", { pull_requests: "read" }, ({ app, token, owner, name }) =>
					app.call({ path: `/repos/${owner}/${name}/pulls/${effect.pr}`, auth: { bearer: token }, what: "read the feature pull request" }));
			} catch (error) {
				// Denied, gone or archived: polling again changes nothing, so the person is asked.
				if (!lostAccess(error)) throw error;
				await take(c, { kind: "repo_pr_lost", at: Date.now(), key: effect.key, repo: effect.repo, said: error instanceof GithubProblem ? error.message : describeError(error) });
				return true;
			}
			const body = (pull.body ?? {}) as Record<string, unknown>;
			const merged = body.merged === true;
			const state = merged ? "merged" : body.state === "closed" ? "closed" : body.draft === true ? "draft" : "open";
			const head = ((body.head ?? {}) as Record<string, unknown>).sha;
			const changed = await take(c, { kind: "repo_pr_read", at: Date.now(), key: effect.key, repo: effect.repo, state, prHead: typeof head === "string" ? head : null, mergedCommit: merged && typeof body.merge_commit_sha === "string" ? body.merge_commit_sha : null, mergedAt: merged && typeof body.merged_at === "string" && Number.isFinite(Date.parse(body.merged_at)) ? Date.parse(body.merged_at) : null });
			if (!changed && live(c.vars.stored!.item, effect)) {
				await queued(c, () => rescheduleChildPoll(c.db, row, Date.now()));
				return "deferred";
			}
			return true;
		}
		case "dispatch":
		case "describe_feature":
		case "integrate": {
			const key = effect.key;
			const job = item.jobs?.at(-1);
			if (crossRepo(item) && effect.kind !== "integrate" && (effect.kind === "describe_feature" || nextOpening(item))) {
				await crossOpenOrDescribe(c, meta, item, effect);
				return true;
			}
			if (effect.kind === "dispatch" && item.pr && job) {
				if (job.route && !job.placement && job.state === "draft" && !job.cancelRequested) {
					await take(c, { kind: "place_child", key, inventory: await placementInventory(c, meta.uid, item.agent?.model, crossRepo(item) ? undefined : meta.repository.id), at: Date.now() });
					return true;
				}
				const v = await userActor(c, meta.uid).internalFeatureChild({ parent: item.id, child: job.id });
				const changed = v && await take(c, { kind: "child_update", key, child: v.id, state: v.state, placement: v.placement, head: v.head, spent: v.spent, budget: v.budget, failure: v.run?.failureFingerprint, report: JSON.stringify({ title: v.report?.title, blocks: v.report?.blocks, verdict: v.verdict, stop: v.run?.stopReason, question: v.question?.text }).slice(0, 5000), at: Date.now() });
				if (!changed && live(c.vars.stored!.item, effect)) {
					// The child notice replaces this keyed effect immediately. An unchanged observation only moves its fallback timer.
					await queued(c, () => rescheduleChildPoll(c.db, row, Date.now()));
					return "deferred";
				}
				return true;
			}
			try {
				const hub = await github(c, meta, "write");
				await hub.app.withToken(hub.installationId, { repositoryId: meta.repository.id, permissions: { contents: "write", metadata: "read", pull_requests: "write" } }, async token => {
					if (!live(c.vars.stored!.item, effect)) return;
					const { app, owner, name } = hub;
					if (effect.kind === "integrate") {
						await advanceFeatureRef(app, token, owner, name, item.parent!.itemId, item.childBase!, effect.head);
						await take(c, { kind: "integrated", key, at: Date.now() });
					} else if (effect.kind === "describe_feature") {
						const report = await latestReport(c.db, item.run!.n);
						const body = [report?.title, ...report?.blocks.map(b => "text" in b ? b.text : "") ?? [], meta.github && "Closes #" + meta.github.origin.issue.number + "."].filter(Boolean).join("\n\n");
						await app.updatePull(token, owner, name, item.pr!.number, { title: item.task.title, body: networkBody(body, itemNetwork(meta), hub.repository.private) });
						await take(c, { kind: "published", key, at: Date.now(), pr: item.pr, head: item.head!, openItems: 1, webhooks: githubConfig().pollFallback });
					} else if (!item.seed) {
						const sha = await refHead(app, token, owner, name, meta.repository.branch);
						await take(c, { kind: "feature_seed", key, sha, at: Date.now() });
					} else {
						const opened = await openFeature(app, token, owner, name, { id: item.id, title: item.task.title, base: meta.repository.branch, seed: item.seed, author: hub.author, created: meta.createdAt, body: networkBody(item.featurePlan!.spec.goal, itemNetwork(meta), hub.repository.private) });
						await take(c, { kind: "feature_ready", key, ...opened, at: Date.now() });
					}
				});
			} catch (error) {
				const denied = error instanceof GithubProblem && (error.code === "github_denied" || error.code === "github_gone");
				if (!denied && !(error instanceof GithubError && [403,404,409,422].includes(error.status))) throw error;
				await take(c, { kind: "feature_problem", key, at: Date.now(), reason: error.message, rebase: effect.kind === "integrate" && error instanceof GithubError && [409,422].includes(error.status) });
			}
			return true;
		}
		case "check_issue":
			await c.db.execute("UPDATE item SET issue_checked_at=? WHERE id=1", Date.now());
			await checkIssue(c, meta, effect);
			return true;
		case "issue_comment": {
			const binding = meta.github!;
			const hub = await github(c, meta);
			const [old] = await c.db.execute<{ id: string }>("SELECT id FROM issue_comment");
			const latest = c.vars.stored!.item;
			const id = await writeIssueComment(hub.app, { ...hub, id: meta.repository.id }, binding, item.id, latest.state, latest.pr?.number, old?.id);
			await c.db.execute("INSERT OR REPLACE INTO issue_comment VALUES(1,?)", id);
			return true;
		}
		case "register_issue":
			return queued(c, async () => {
				if (!live(c.vars.stored!.item, effect)) return false;
				const binding = meta.github!;
				await repositoryDirectory(c, meta).internalRegister({ uid: meta.uid, itemId: item.id, installationId: binding.installationId,
					issue: binding.origin.issue.number, generation: binding.generation });
				return true;
			});
		case "register":
		case "forget":
			return updateDirectory(c, meta, effect);
		case "deliver": {
			let checkout: ReviewDelivery | null = null;
			if (effect.to === "review") {
				if (!effect.checkout || !effect.reviewerInput || !meta.reviewBase || meta.reviewBase.head !== effect.checkout.head) {
					await take(c, { kind: "review_ended", key: effect.key, at: Date.now(), outcome: "error", refused: "GitHub did not identify the base commit for this review", review: null, said: null, spend: { tokens: 0, hostedSeconds: item.spent.hostedSeconds } });
					return true;
				}
				const report = await latestReport(c.db, item.run!.n);
				const prose = (heading: string) => report?.blocks.find(b => b.kind === "text" && b.heading === heading);
				const description = prose("What it did"), lookAt = prose("Where to look"), risk = report?.blocks.find(b => b.kind === "risk");
				checkout = { ...effect.reviewerInput, baseSha: meta.reviewBase.sha, report: report ? { title: report.title, description: description?.kind === "text" ? description.text : "", lookAt: lookAt?.kind === "text" ? lookAt.text : "", concerns: risk?.text ?? "", screenshots: report.screenshots.map(s => ({ file: s.id, caption: s.caption })) } : null };
			}
			let text = effect.text;
			if (effect.feedbackQuote) {
				const { head, start, length } = effect.feedbackQuote;
				const run = item.run!.n;
				const rows = await c.db.execute<{ data: string }>("SELECT data FROM feedback WHERE state='taken' AND run=? ORDER BY at,id", run);
				const quote = batchText(rows.map(row => JSON.parse(row.data) as FeedbackEntry), { pr: item.pr!.number, run, head });
				text = text.slice(0, start) + quote + text.slice(start + length);
			}
			// A provider retry replays the delivered planner prompt, including its inventory.
			if (effect.agent === "planner" && item.run!.step.attempt === 1) {
				const inventory = await placementInventory(c, meta.uid, item.agent?.model);
				// Each agent's models in short: "sonnet (low/high)". The planner may propose one; the person approves it.
				const listed = (list?: ModelList | null) => list?.models.map(m => m.efforts.length ? `${m.id} (${m.efforts.join("/")})` : m.id);
				const places = inventory.machines.map(({ machineId, repositorySecrets, ...description }) => ({ ...description,
					agentModels: Object.fromEntries(Object.entries(inventory.models?.machines?.[machineId] ?? {}).map(([id, list]) => [id, listed(list)])),
					limited: inventory.limited?.filter(a => limitApplies(a, machineId)).map(({ harness, limitedUntil }) => ({ harness, limitedUntil })) }));
				const parent = item.place;
				const parentName = parent.kind === "hosted" ? "hosted" : inventory.machines.find(m => m.machineId === parent.machineId)?.name;
				text += "\n\nCurrent runners do not support sizing beyond one slot.\nPlacement inventory (read-only data): " + JSON.stringify({ parent: parentName, hostedProfiles: inventory.hostedProfiles, windlassModels: listed(inventory.models?.windlass), featureModel: item.agent?.model, machines: places });
				// The budget figures are the planning turn's own text (blueprint.ts `plannerBudgetText`).
			}
			await session.internalDeliver({ key: effect.key, itemId: item.id, title: item.task.title, text, checkout, agent: effect.agent, maxSteps: effect.maxSteps, fetchBase: effect.fetchBase, startsRun: startsRun(effect.key), untrusted: effect.untrusted ?? [], ...(effect.unsandboxed && { unsandboxed: true }), ...(effect.fresh && { fresh: effect.fresh }), ...(effect.asksLeft !== undefined && { asksLeft: effect.asksLeft }) }).catch(onGone);
			return true;
		}
		case "release_review":
			await session.internalFreeSandbox(effect.run).catch(onGone);
			return true;
		case "fresh_sandbox":
			// The person chose a new sandbox for a step whose sandbox could not be prepared: the session's is removed, as "Free" does.
			if (await session.internalFreeSandbox().catch(onGone) === gone) return true;
			await take(c, { kind: "sandbox_freed", key: effect.key, at: Date.now(), plan: effect.plan });
			return true;
		case "withdraw":
			await session.internalWithdraw(effect.key).catch(onGone);
			return true;
		case "check_turn": {
			const fact = await session.internalCheckTurn({ turn: effect.turn, check: effect.key }).catch(onGone);
			if (fact === gone) return true;
			// A turn still waiting for its slot is not running at the session: it is still in the session's hands, and looked at again.
			if (fact === null && item.run?.step.turn === "delivered") await take(c, { kind: "turn_running", at: Date.now(), key: effect.key });
			else if (fact !== null) await takeSessionFact(c, stored, fact);
			return true;
		}
		case "publish": {
			// Read before the push: a lookup that fails tries the effect again before anything was pushed, not after a push that went through.
			const { openItems } = await factsOf(c, meta);
			// Asked again after the lookup: a cancel stored while it was answered pushes nothing.
			const now = c.vars.stored;
			if (!now || !live(now.item, effect)) return false;
			const body = meta.github ? `${item.task.body}\n\nCloses #${meta.github.origin.issue.number}.` : item.task.body;
			const answer = await session.internalPublish({ key: effect.key, title: item.task.title, body, blockedNetwork: itemNetwork(meta), branchOnly: !!item.parent }).catch(onGone);
			if (answer === gone) return true;
			const receipt = { at: Date.now(), key: effect.key };
			await take(c, answer.kind === "published" ? { ...answer, ...receipt, openItems, webhooks: githubConfig().pollFallback } : { ...answer, ...receipt });
			return true;
		}
		case "poll_ci": {
			const number = item.pr?.number ?? 0;
			// Not reaching GitHub at all (the connection gone, the repository out of reach) is a reading that failed:
			// it waits as any other, and CI's time limit still ends in the person's question.
			const read = async () => {
				const hub = await github(c, meta);
				// A commit's SHA, or the branch where git did not say which commit it pushed: as part of the address, in one piece.
				const reading = await readCi(hub.app, { installationId: hub.installationId, repositoryId: meta.repository.id, owner: hub.owner, name: hub.name, head: encodeURIComponent(effect.head) });
				// GitHub works out whether a pull request can merge after a push, and says null until it has. Its head is the
				// commit it holds now, which may be one pushed after the agent's.
				const pull = item.parent ? null : await hub.pull(number).catch(() => null);
				return { reading, baseSha: pull?.base === meta.repository.branch ? pull.baseSha : null, mergeable: pull?.mergeable ?? null, prHead: pull?.headSha || null };
			};
			const { reading, mergeable, prHead, baseSha } = await read().catch((error: unknown) => ({ reading: { kind: "failed" as const, said: describeError(error) }, mergeable: null, prHead: null, baseSha: null }));
			const openItems = item.run?.step.kind === "handoff" ? 0 : (await factsOf(c, meta)).openItems;
			await take(c, { kind: "ci_read", at: Date.now(), key: effect.key, head: effect.head, reading, mergeable, prHead, openItems, webhooks: githubConfig().pollFallback }, { baseSha, nudged: row.due_at < effect.at });
			return true;
		}
		case "poll_pr": {
			// In review, too: the last turn's sandbox time is settled while the person reviews.
			await factsOf(c, meta);
			const hub = await github(c, meta);
			const pull = await hub.pull(effect.pr);
			await take(c, { kind: "pr_read", at: Date.now(), key: effect.key, state: pull.state, prHead: pull.headSha || null, webhooks: githubConfig().pollFallback });
			if ((pull.state === "open" || pull.state === "draft") && item.state === "review") await reconcileFeedback(c, meta, hub, effect.pr);
			return true;
		}
		case "handoff": {
			const next = c.vars.handoff.then(async () => {
				const latest = c.vars.stored?.item;
				if (!latest?.pr || !live(latest, effect)) return false;
				if (latest.mode === "orchestrate") {
					// Never for a cross-repo feature, whatever path led here: its PRs leave draft only after a review of the set.
					const refused = readyRefusal(latest);
					if (refused) throw new PlanError(refused);
					const hub = await github(c, meta, "write");
					await hub.app.withToken(hub.installationId, { repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "write" } }, token => readyFeature(hub.app, token, hub.owner, hub.name, latest.pr!.number, latest.id));
				}
				await handoffOnGithub(c, meta, latest.pr.number, effect, row);
				return true;
			});
			c.vars.handoff = next.then(() => undefined, () => undefined);
			return next;
		}
		case "ask":
			return true;
	}
}

// ---------------------------------------------------------------------------------------------
// A person's actions
// ---------------------------------------------------------------------------------------------

const MAX_RAISE = { tokens: 1_000_000_000, hostedSeconds: 7 * 86_400 } as const;

/** The fact of a person's action, checked; throws a UserError for one that cannot be taken. */
function factOf(action: ItemAction, by: string, at: number): Fact {
	const bad = (message: string) => new UserError(message, { code: "bad_input" });
	const note = (value: unknown, needed: boolean): string | undefined => {
		if (value === undefined || value === null || value === "") {
			if (needed) throw bad("Write a note for the agent.");
			return undefined;
		}
		if (typeof value !== "string" || value.length > MAX_NOTE_CHARS) throw bad(`A note is text of at most ${MAX_NOTE_CHARS} characters.`);
		return value;
	};
	// The subtasks whose agent works without asking that the person confirmed on the approval card.
	const agentsOf = (value: unknown): { agents?: string[] } => {
		if (value === undefined || value === null) return {};
		if (!Array.isArray(value) || value.length > 6 || !value.every(key => typeof key === "string" && key.length <= 32)) throw bad("Confirm the subtasks by their keys.");
		return { agents: value as string[] };
	};
	switch (action?.kind) {
		case "cancel_subtask": return { kind: action.kind, key: action.key, by, at };
		case "edit_plan": return { kind: action.kind, version: action.version, plan: action.plan, by, at };
		case "approve_plan": {
			const bases = (action as { bases?: unknown }).bases;
			if (bases !== undefined && bases !== null && (typeof bases !== "object" || Array.isArray(bases) || Object.entries(bases).length > 2 || !Object.entries(bases).every(([alias, sha]) => /^[a-z][a-z0-9-]{0,15}$/.test(alias) && typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))))
				throw bad("Reconfirm a moved base by its repository's alias and full commit.");
			return { kind: action.kind, version: action.version, by, at, ...agentsOf(action.agents), ...(bases ? { bases: bases as Record<string, string> } : {}) };
		}
		case "run_single": return { kind: action.kind, by, at };
		case "start":
		case "cancel":
		case "retry":
			return { kind: action.kind, at, by };
		case "send_back":
			return { kind: "send_back", at, by, note: note(action.note, true) as string };
		case "answer": {
			if (typeof action.question !== "string" || typeof action.choice !== "string") throw bad("Say which question this answers, and which choice.");
			const budget: Record<string, number> = {};
			for (const [name, most] of Object.entries(MAX_RAISE)) {
				const value = (action.budget as Record<string, unknown> | undefined)?.[name];
				if (value === undefined) continue;
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > most) throw bad(`A budget's ${name} is a number above 0 and at most ${most}.`);
				budget[name] = value;
			}
			// An answer to the agent's question is the note: without words there is nothing to send it.
			// A note that answers the agent goes to it as the person's words: nothing hidden in it may ride along.
			const replyNote = action.choice === "reply" && typeof action.note === "string" ? action.note.replace(HIDDEN, "") : action.note;
			const answerNote = action.choice === "reply" && typeof replyNote === "string" && replyNote.trim() === "" ? undefined : replyNote;
			if (action.choice === "reply" && answerNote === undefined) throw bad("Write your answer to the agent.");
			return { kind: "answer", at, by, question: action.question, choice: action.choice, note: note(answerNote, false), budget, ...agentsOf(action.agents) };
		}
		default:
			throw bad("Say what to do with the item.");
	}
}

const CONFLICT: Record<ItemAction["kind"], string> = {
	cancel_subtask: "This subtask is no longer running.",
	edit_plan: "That plan has changed. Read the latest version.", approve_plan: "Review the latest plan and answer its questions first.", run_single: "This item cannot switch to single mode.",
	start: "Only a draft can be started.",
	cancel: "The item is done or cancelled already.",
	retry: "Only an item that failed can be retried.",
	send_back: "Only an item in review can be sent back.",
	answer: "That question is not open any more, or does not offer that choice.",
};

// ---------------------------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------------------------

export const workItem = actor({
	options: { name: "Work item", icon: "list-check", actionTimeout: 60_000 },

	db: db({
		onMigrate: async (db) => {
			// `due` is the schedule for the earliest effect: kept, so that a woken actor cancels it rather than adding another.
			await db.execute("CREATE TABLE IF NOT EXISTS item (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, due TEXT, issue_checked_at INTEGER NOT NULL DEFAULT 0)");
			await db.execute("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, effect TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL)");
			await db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, data TEXT NOT NULL)");
			await db.execute(CHECKS_TABLE);
			await db.execute(REPORTS_TABLE);
			await db.execute(REVIEWS_TABLE);
			await db.execute(FEEDBACK_TABLE);
			await db.execute("CREATE INDEX IF NOT EXISTS feedback_pending ON feedback(state,after_run,ready)");
			await db.execute("CREATE TABLE IF NOT EXISTS feedback_cursor(id INTEGER PRIMARY KEY, since INTEGER NOT NULL)");
			await db.execute("CREATE TABLE IF NOT EXISTS github_binding (id INTEGER PRIMARY KEY CHECK (id = 1), installation TEXT NOT NULL)");
			await db.execute("CREATE TABLE IF NOT EXISTS issue_actions(subject TEXT PRIMARY KEY)");
			await db.execute("CREATE TABLE IF NOT EXISTS issue_comment(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL)");
			await db.execute(VERDICT_COMMENT_TABLE);
			// Backfill items published before G2 on their next wake.
			const stored = await load(db);
			if (stored?.item.run?.step.kind === "review" && stored.item.pr && !ENDED.has(stored.item.state)) {
				const poll = nextPrPoll(stored.item, Date.now());
				await db.execute("INSERT OR IGNORE INTO effects VALUES (?, ?, ?, 0)", rowId(poll), JSON.stringify(poll), poll.at);
			}
			if (stored?.item.pr && stored.item.head && !ENDED.has(stored.item.state) && !(await db.execute("SELECT 1 FROM github_binding")).length) {
				const effect: Effect = { kind: "register", key: `existing:${stored.item.revision}`, pr: stored.item.pr.number, head: stored.item.head };
				await db.execute("INSERT OR IGNORE INTO effects SELECT ?, ?, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM effects WHERE id LIKE 'register:%')", rowId(effect), JSON.stringify(effect));
			}
			await db.execute("CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, run INTEGER NOT NULL, head TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
		},
	}),

	// Only `user` creates an item. An actor made any other way stays without a row and removes itself on wake.
	onCreate: async (c, input: ItemCreateInput | undefined) => {
		try {
			if (!input || !grantIsValid(input.grant, c.key, "workItem") || input.item?.id !== c.key[1]) return;
			let item = input.item;
			const events: ItemEvent[] = [];
			let effects: Effect[] = [];
			if (input.startedBy !== null) {
				const started = advance(item, { kind: "start", at: input.meta.createdAt, by: input.startedBy });
				({ item } = started);
				events.push(...started.events);
				effects = started.effects;
			}
			await c.db.transaction(async (tx) => {
				if (input.meta.github) {
					await tx.execute("INSERT INTO github_binding VALUES(1,?)", String(input.meta.github.installationId));
					effects.push({ kind: "issue_comment", key: "link", revision: item.revision });
				}
				await tx.execute("INSERT INTO item (id, revision, data) VALUES (1, ?, ?)", item.revision, JSON.stringify({ item, meta: input.meta }));
				await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", input.meta.createdAt, JSON.stringify({ at: input.meta.createdAt, by: input.startedBy ?? "platform", step: null, said: input.meta.github ? filedFromIssue(input.meta.github.origin) : `Filed from ${input.meta.source === "api" ? "the API" : "the web app"}.` } satisfies ItemEvent));
				for (const event of events) await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", event.at, JSON.stringify(event));
				for (const effect of effects) await tx.execute("INSERT INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, 0)", rowId(effect), JSON.stringify(effect), "at" in effect && effect.at !== undefined ? effect.at : 0);
			}, { name: "item.create" });
		} catch (error) {
			c.log.error({ msg: "could not initialise the work item", error: describeError(error) });
		}
	},

	createVars: async (c): Promise<ItemVars> => {
		const [row] = await c.db.execute<{ due: string | null }>("SELECT due FROM item WHERE id = 1");
		return { stored: await load(c.db), writing: Promise.resolve(), performing: new Set(), handoff: Promise.resolve(), due: row?.due ? (JSON.parse(row.due) as ItemVars["due"]) : null, reporting: null, reportAgain: false };
	},

	onDestroy: async (c) => {
		const stored = c.vars.stored;
		if (stored) await Promise.all([
			queued(c, () => repositoryDirectory(c, stored.meta).internalForget(stored.item.id)),
			userActor(c, stored.meta.uid).internalDeleteItemAttachments(stored.item.id),
		]);
	},

	onWake: (c) => {
		if (!c.vars.stored) {
			c.destroy();
			return;
		}
		// What a deploy cut off is performed again, under the keys it was stored with.
		void c.keepAwake(performDue(c));
	},

	actions: {
		// --- called by `user` only ---------------------------------------------------------------

		internalChildNotice: async (c, child: Pick<ItemSummary, "id" | "spent" | "state"> & { budget?: ItemSummary["budget"]; integratedHead?: string }) => {
			requireServiceFor(c, "call");
			await take(c, {kind: "child_notice", at: Date.now(), child: child.id, spent: child.spent, ...(child.budget && { budget: child.budget }), state: child.state, integratedHead: child.integratedHead});
		},
		// The seed belongs to the parent. Looking it up on clone also covers previously created child sessions.
		// A cross-repo feature's child asks for the seed of its own repository (`repositoryId`).
		internalSetupSeed: async (c, source: "child" | "feature", repositoryId?: GithubId): Promise<string | null> => {
			requireServiceFor(c, "call");
			const stored = c.vars.stored;
			if (!stored) throw new Error("The work item is unavailable for setup.");
			if (source === "child") {
				const parent = stored.item.parent;
				return parent ? itemActor(c, stored.meta.uid, parent.itemId).internalSetupSeed("feature", stored.meta.repository.id) : null;
			}
			if (crossRepo(stored.item) && repositoryId !== undefined) {
				const seed = stored.item.repos!.find(r => r.repositoryId === repositoryId)?.seed;
				if (!seed) throw new Error("The feature has no recorded setup commit for that repository.");
				return seed;
			}
			if (!stored.item.seed) throw new Error("The feature has no recorded setup commit.");
			return stored.item.seed;
		},
		/**
		 * The other repositories of a cross-repo feature a planning turn of `key` reads, each at the base
		 * commit the filing recorded: null for any other turn. The session fetches each with a read token of
		 * its own and leaves no credentials behind (agent-session.ts, `materializeInputs`).
		 */
		internalPlanningInputs: (c, key: string): { directory: string; inputs: { alias: string; repositoryId: GithubId; installationId: GithubId; owner: string; name: string; baseRef: string; sha: string | null }[] } | null => {
			requireService(c);
			const item = c.vars.stored?.item;
			if (!item || !crossRepo(item) || item.run?.step.kind !== "refine" || currentKey(item) !== key) return null;
			return { directory: INPUTS_DIRECTORY, inputs: item.repos!.slice(1).map(r => ({ alias: r.alias, repositoryId: r.repositoryId, installationId: r.installationId, owner: r.owner, name: r.name, baseRef: r.baseRef, sha: r.planningBaseSha })) };
		},
		internalChildRequest: (c, id: string) => {
			requireService(c);
			const s = c.vars.stored, job = s?.item.jobs?.at(-1);
			if (!s || !job || job.id !== id || s.item.run?.step.kind !== "subtasks" || s.item.featurePlan?.status !== "approved" || s.item.question || ENDED.has(s.item.state)) return null;
			const completed = s.item.jobs?.filter(j => j.state === "done") ?? [];
			const previous = completed.at(-1);
			const reports = completed.filter(j => job.task.dependsOn.includes(j.task.key)).map(j => j.report);
			// A cross-repo feature's child is made in its subtask's repository, from that repository's feature branch.
			const repo = crossRepo(s.item) ? repoOf(s.item, job.task.repo) : null;
			return { job: { ...job, dispatchKey: currentKey(s.item)! }, sessionId: s.meta.sessionId, feature: summaryOf(s),
				repository: repo && { id: repo.repositoryId, base: repo.baseRef, alias: repo.alias },
				context: JSON.stringify({ spec: s.item.featurePlan.spec, reports }),
				previous: previous && { head: previous.head, report: previous.report, place: previous.placement?.place },
				// The subtask's task was planned from the feature's (its sources go with it), and quotes the reports of subtasks before it.
				untrusted: sources(s.item.untrusted, reports.length ? [untrustedWords.earlier] : []),
				// What the feature's person chose to run anyway on "Docker, hardened": the subtask's task carries the same text.
				...(s.item.unsandboxed?.length && { unsandboxed: s.item.unsandboxed }) };
		},
		internalFilePlan: async (c, input: { key: string; plan: unknown }): Promise<string> => {
			requireService(c);
			try {
				return await take(c, { ...input, kind: "file_plan", at: Date.now() }) ? "Plan filed. End your turn." : "This planning turn ended.";
			} catch (error) { return describeError(error); }
		},
		internalSummary: (c): ItemSummary => {
			requireService(c);
			if (!c.vars.stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			return summaryOf(c.vars.stored);
		},

		internalBlockedNetwork: async (c, receipt: NetworkReceipt): Promise<void> => {
			requireService(c);
			const meta = c.vars.stored?.meta;
			if (!meta || !sessionsOf(meta).includes(receipt.sessionId)) return;
			const previous = meta.blockedSessions?.[receipt.sessionId];
			if (previous && previous.revision >= receipt.revision) {
				// A duplicate can arrive while the original write is queued. Acknowledge durable state.
				await queued(c, async () => {
					const saved = (await load(c.db))?.meta.blockedSessions?.[receipt.sessionId];
					if (!saved || saved.revision < receipt.revision) throw new Error("Network receipt was not saved.");
				});
				return;
			}
			(meta.blockedSessions ??= {})[receipt.sessionId] = receipt;
			await take(c, { kind: "network_reported", at: Date.now() });
		},
		internalView: async (c): Promise<ItemView> => {
			requireService(c);
			if (!c.vars.stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			return await viewOf(c);
		},

		/** A person's action (`UserActions.actOnItem`), by `by` ("person:<uid>"). Refused with `item_conflict` when it changes nothing. */
		internalAct: async (c, input: { action: ItemAction; by: string }): Promise<ItemView> => {
			requireService(c);
			const stored = c.vars.stored;
			if (!stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			const fact = factOf(input?.action, String(input?.by), Date.now());
			let changed: boolean;
			try {
				const approving = stored.item.featurePlan?.status === "proposed" && (fact.kind === "approve_plan" || (fact.kind === "answer" && fact.choice === "approve"));
				if (approving && (fact.kind === "approve_plan" || fact.kind === "answer")) {
					fact.inventory = await placementInventory(c, stored.meta.uid, stored.item.agent?.model);
					if (advance(stored.item, fact).item.featurePlan?.status === "approved") await checkFeatureCi(c, stored, fact.kind === "approve_plan" ? fact.bases : undefined);
				}
				changed = await take(c, fact);
			} catch (error) {
				if (error instanceof PlanError) throw new UserError(error.message, { code: "bad_input" });
				throw clientError(c.log, error, "The item could not be changed. Try again.");
			}
			if (!changed) throw new UserError(CONFLICT[input.action.kind], { code: "item_conflict" });
			return await viewOf(c);
		},

		internalGithubRetry: async (c, input: { installationId: GithubId; subject: string; by: GithubUser }) => {
			requireServiceFor(c, "call");
			const binding = c.vars.stored?.meta.github;
			if (!binding || binding.installationId !== input.installationId || binding.senderId !== input.by.id) return;
			if ((await c.db.execute("SELECT 1 FROM issue_actions WHERE subject=?", input.subject)).length) return;
			const by = "github:" + input.by.login;
			await take(c, { kind: "retry", at: Date.now(), by }, { issue: { subject: input.subject, by, said: "" } });
		},
		internalGithubIssue: async (c, input: IssueNotice) => {
			requireServiceFor(c, "call");
			const meta = c.vars.stored?.meta, binding = meta?.github;
			if (!meta || !binding || ENDED.has(c.vars.stored!.item.state) || binding.installationId !== input.installationId || meta.repository.id !== input.repositoryId || binding.origin.issue.number !== input.issue) return;
			if (input.action === "edited" || input.action === "closed") return queueIssueCheck(c, input);
			await checkIssue(c, meta, input.action === "unlabeled" ? { unlabeledBy: input.senderId } : {});
		},

		internalGithubFeedback: async (c, input: FeedbackNotice) => {
			requireServiceFor(c, "call");
			return receiveFeedback(c, input);
		},

		internalReverify: async (c, input: { installationId: GithubId; repositoryId: GithubId; head: string }): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (input.repositoryId !== c.vars.stored?.meta.repository.id || input.installationId !== await binding(c)) return false;
			return take(c, { kind: "reverify", head: input.head, at: Date.now() });
		},

		internalProviderChanged: async (c, revision: number): Promise<void> => {
			requireServiceFor(c, "call");
			await queued(c, async () => {
				const item = c.vars.stored?.item;
				if (item?.revision !== revision || item.wait?.reason !== "provider" || item.question) return;
				// Admission waits belong to the user's queue. A refused turn or unplaced child has its own timer.
				const key = currentKey(item);
				const now = Date.now();
				const rows = await c.db.execute("UPDATE effects SET due_at=? WHERE id IN (?,?) AND due_at>? RETURNING id",
					now, "provider_retry:" + key, "dispatch:" + key, now);
				if (rows.length) await armDueInQueue(c);
			});
		},

		internalGithubNudge: async (c, input: GithubNudge): Promise<boolean> => {
			requireServiceFor(c, "call");
			return queued(c, () => nudge(c, input));
		},

		// --- called by the item's session and by `user` -----------------------------------------

		/** A fact about the item's turn, from its session's outbox or from the user's turn queue. Resolves once it is stored. */
		internalFact: async (c, fact: Fact): Promise<void> => {
			requireService(c);
			const stored = c.vars.stored;
			if (!stored || typeof fact?.kind !== "string" || typeof fact.at !== "number") return;
			if (fact.kind === "placement_wait") {
				requireServiceFor(c, "call");
				await take(c, fact);
				return;
			}
			if (fact.kind !== "machine_removed" && fact.kind !== "turn_ended" && fact.kind !== "review_ended" && fact.kind !== "turn_started" && fact.kind !== "turn_running" && fact.kind !== "turn_waiting") return;
			await takeSessionFact(c, stored, fact);
		},

		// --- called by the actor's own schedule only ------------------------------------------------

		[DUE_ACTION]: async (c): Promise<void> => {
			const fire = c.scheduledFire;
			if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
			// One line per firing, so that a late or lost schedule shows in the logs.
			console.log(`[wlp] schedule.fired action=${DUE_ACTION} item=${c.key[1]} late_ms=${fire.firedAt - fire.scheduledAt}`);
			if (c.vars.due?.id === fire.id) c.vars.due = null;
			await performDue(c);
		},
	},
});
