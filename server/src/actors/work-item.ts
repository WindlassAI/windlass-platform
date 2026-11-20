/**
 * `workItem`, key [uid, itemId]: one work item of the software factory (Plans "software factory" §1,
 * §2), and the run controller that carries it through the blueprint (factory/blueprint.ts).
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

import type { ItemReview } from "../contract.js";
import { ledgerSeconds } from "../factory/budget.js";
import type { ReviewDelivery } from "./session-inbox.js";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { clientError, describeError, requireService } from "../auth.js";
import { type ItemAction, type ItemEvent, type ItemReport, type ItemSummary, type ItemView, MAX_NOTE_CHARS, type RoundCaps, type SessionRepository, type Verdict } from "../contract.js";
import { RULES, advance, currentKey } from "../factory/blueprint.js";
import { itemComment, reportBlocks, REVIEW_PROFILE_REASON } from "../factory/review.js";
import type { Effect, Fact, FactoryItem } from "../factory/types.js";
import { githubApp, GithubError } from "../github/app.js";
import { readCi } from "../github/ci.js";
import { resolveRepository, type StoredConnection } from "../github/repos.js";
import { grantIsValid, sessionActor, userActor } from "./internal.js";
import type { ItemFacts } from "./user-items.js";

/** The rounds a run allows, as the blueprint stops on them (`RULES`), for the item's page. */
const ROUND_CAPS: RoundCaps = { plan: RULES.planRounds, gate: RULES.gateRounds, ci: RULES.ciRounds, conflict: RULES.conflictRounds };

/** What the item knows around the blueprint's `FactoryItem`. */
export interface ItemMeta {
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
export type ItemPublishAnswer = { kind: "published"; head: string; pr: { number: number; url: string } } | { kind: "publish_failed"; said: string; transient: boolean };

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

type EffectRow = { id: string; effect: string; due_at: number; attempts: number };

const rowId = (effect: Effect) => `${effect.kind}:${effect.kind === "ask" ? effect.question.id : effect.key}`;

/** Whether the turn of a `deliver` key is the first of its run (`<item>:<run>:<step>:<attempt>`, blueprint.ts `stepKey`): the review cap holds back only those. */
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
		title: item.task.title,
		repository: { provider: repository.provider, id: repository.id, owner: repository.owner, name: repository.name, branch: repository.branch, private: repository.private, url: repository.url },
		place: item.place,
		source: meta.source,
		state: item.state,
		wait: item.wait,
		question: item.question === null ? null : { id: item.question.id, kind: item.question.kind, text: item.question.text, choices: item.question.choices, askedAt: item.question.askedAt },
		pullRequest: item.pr,
		verdict: meta.verdict,
		review: secondReview(item, meta),
		budget: item.budget,
		spent: item.spent,
		sessionId: meta.sessionId,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		revision: item.revision,
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

/** The report and its reference snapshots share one JSON value and one transaction with the turn. */
export const REVIEWS_TABLE = "CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, run INTEGER NOT NULL, head TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

export const REPORTS_TABLE = "CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, run INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

export async function storeReport(db: Pick<RawAccess, "execute">, item: FactoryItem, sessionId: string, fact: Extract<Fact, { kind: "turn_ended" }>): Promise<void> {
	if (!item.run || !fact.report || typeof fact.report === "string") return;
	const report: ItemReport = {
		by: "builder", sessionId, run: item.run.n, key: fact.key, head: fact.pushedHead === undefined ? item.head : fact.pushedHead,
		at: fact.at, title: fact.report.title, blocks: reportBlocks(fact.report), records: [], screenshots: fact.report.screenshots,
	};
	await db.execute("INSERT OR REPLACE INTO reports (key, run, at, data) VALUES (?, ?, ?, ?)", report.key, report.run, report.at, JSON.stringify(report));
}

export async function latestReport(db: Pick<RawAccess, "execute">, run: number): Promise<ItemReport | null> {
	const [row] = await db.execute<{ data: string }>("SELECT data FROM reports WHERE run = ? ORDER BY at DESC, rowid DESC LIMIT 1", run);
	return row ? JSON.parse(row.data) as ItemReport : null;
}

async function pageOf(c: Ctx, stored: Stored): Promise<ItemView> {
	const run = stored.item.run;
	const events = await c.db.execute<{ data: string }>("SELECT data FROM (SELECT seq, data FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq", VIEW_EVENTS);
	const verdicts = await c.db.execute<{ data: string }>("SELECT data FROM verdicts ORDER BY at, id");
	return {
		...summaryOf(stored),
		reviewerSessionId: stored.meta.reviewerSessionId ?? null,
		reviewNone: stored.meta.handoffReview?.reason ?? (!stored.item.reviewer ? "this item was created before second reviews were available" : "off" in stored.item.reviewer ? stored.item.reviewer.off === "profile" ? REVIEW_PROFILE_REASON : "turned off for this deployment" : null),
		reviews: (await c.db.execute<{ data: string }>("SELECT data FROM (SELECT data, at, rowid AS seq FROM reviews ORDER BY at DESC, rowid DESC LIMIT 10) ORDER BY at, seq")).map(row => JSON.parse(row.data) as ItemReview),
		task: stored.item.task,
		// What the gate and CI read stays here: the page shows the run as the contract has it.
		run: run === null ? null : { n: run.n, startedAt: run.startedAt, endedAt: run.endedAt, stopReason: run.stopReason, step: run.step, rounds: run.rounds, caps: ROUND_CAPS },
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
			? lifetimeSeconds(stored.meta, await userActor(c, stored.meta.uid).internalItemFacts(sessionsOf(stored.meta)))
			: 0;
		await take(c, { ...fact, spend: { tokens: fact.spend?.tokens ?? 0, hostedSeconds } });
	} else {
		await take(c, fact);
	}
}

/**
 * The item after `fact`, stored with its effects and events in one transaction over the revision it
 * was decided from, and then performed. Resolves once it is stored, with whether the fact changed
 * anything: an action that answers after this has answered for what is durable.
 */
async function take(c: Ctx, fact: Fact, baseSha?: string | null): Promise<boolean> {
	const stored = c.vars.stored;
	if (!stored) return false;
	// From here to the write being queued nothing is awaited: the decision is one step.
	const before = stored.item;
	const outcome = advance(before, fact);
	if (outcome.item === before) return false;
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
	const filing = fact.kind === "review_ended" && fact.review?.id === outcome.item.run?.ci?.secondReview?.review ? fact.review : null;
	if (filing) stored.meta.handoffReview = { recommendation: filing.recommendation, reason: null };
	if (handoff) stored.meta.handoffReview = { recommendation: stored.meta.handoffReview?.recommendation ?? null, reason: handoff.reviewNone };
	// The item, its revision and its data are taken from this decision now: a later decision, made while this
	// one waits for its write, changes `stored` and must not be written beside this one's data.
	const next = outcome.item;
	const data = JSON.stringify({ item: next, meta: stored.meta });
	// An `ask` is the question on the item itself, which reaches the index with the summary: nothing is left to perform.
	const effects = outcome.effects.filter((effect) => effect.kind !== "ask");
	// A cut-off review may have left its checkout paused while the item waited for its owner.
	// Keep cleanup in the outbox, independently of GitHub and of a withdrawal still stopping a turn.
	if (stored.meta.reviewerSessionId && next.run && before.state !== next.state && (next.state === "review" || ENDED.has(next.state))) {
		effects.push({ kind: "release_review", key: String(next.run.n), run: next.run.n, to: "review" });
	}
	try {
		await queued(c, () =>
			c.db.transaction(async (tx) => {
				const [row] = await tx.execute<{ revision: number }>("SELECT revision FROM item WHERE id = 1");
				if (row?.revision !== before.revision) throw new Error(`the item is at revision ${row?.revision ?? "none"}, not ${before.revision}`);
				await tx.execute("UPDATE item SET revision = ?, data = ? WHERE id = 1", next.revision, data);
				// What this decision left behind goes with it: a publish waiting for its retry is not done for a cancelled item.
				for (const old of await tx.execute<{ id: string; effect: string }>("SELECT id, effect FROM effects")) {
					if (!live(next, JSON.parse(old.effect) as Effect)) await tx.execute("DELETE FROM effects WHERE id = ? AND effect = ?", old.id, old.effect);
				}
				for (const event of outcome.events) await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", event.at, JSON.stringify(event));
				for (const effect of effects) {
					await tx.execute("INSERT OR REPLACE INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, 0)", rowId(effect), JSON.stringify(effect), "at" in effect && effect.at !== undefined ? effect.at : 0);
				}
				if (fact.kind === "turn_ended") await storeReport(tx, before, stored.meta.sessionId, fact);
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
	for (const event of outcome.events) console.log(`[wlp] item.event uid=${stored.meta.uid} item=${before.id} revision=${next.revision}: ${event.said.replace(/\s+/g, " ").slice(0, 200)}`);
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
async function armDue(c: Ctx): Promise<void> {
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
	await queued(c, () => c.db.execute("UPDATE item SET due = ? WHERE id = 1", JSON.stringify(c.vars.due)));
	if (due !== null) await c.schedule.cancel(due.id).catch(() => false);
}

/** The repository as the user's connection reaches it now, and the app: what a poll of GitHub needs. */
async function github(c: Ctx, meta: ItemMeta) {
	const app = githubApp();
	if (!app) throw new Error("the deployment has no GitHub App");
	const connection: StoredConnection | null = await userActor(c, meta.uid).internalGithubConnection();
	if (!connection) throw new Error("the user's GitHub connection is gone");
	const resolved = await resolveRepository(app, connection, meta.repository.id, "read");
	const { owner, name } = resolved.repository;
	const pull = (number: number) => app.withToken(resolved.installation.id, { repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "read" } }, (token) => app.pull(token, owner, name, number));
	return { app, installationId: resolved.installation.id, owner, name, pull, login: connection.user.login };
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

async function handoffOnGithub(c: Ctx, meta: ItemMeta, number: number, effect: Handoff, row: EffectRow): Promise<void> {
	const { verdict } = effect;
	let action = "reach the pull request";
	try {
		const { app, installationId, owner, name, login } = await github(c, meta);
		await app.withToken(installationId, { repositoryId: meta.repository.id, permissions: { metadata: "read", pull_requests: "write" } }, async (token) => {
			if (!effect.reviewDone) {
				action = "request your review";
				const pull = await app.pull(token, owner, name, number);
				if (!pull.requestedReviewers.some((reviewer) => reviewer.toLowerCase() === login.toLowerCase())) {
					try {
						await app.requestReviewers(token, owner, name, number, [login]);
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
			const marker = `<!-- windlass-item:${verdict.item} -->`;
			const [reviewRow] = effect.review ? await c.db.execute<{ data: string }>("SELECT data FROM reviews WHERE id = ?", effect.review) : [];
			const body = itemComment(verdict, effect.words, await latestReport(c.db, verdict.run), { filed: reviewRow ? JSON.parse(reviewRow.data) as ItemReview : null, reason: effect.reviewNone, owner, name });
			// Every page, so that on a busy pull request a comment past the first hundred is edited, not posted a second time.
			const comments = await app.issueComments(token, owner, name, number);
			const own = comments.find((one) => one.author.toLowerCase() === `${app.settings.slug.toLowerCase()}[bot]` && one.body.split("\n", 1)[0] === marker);
			if (own?.id === null) throw new Error("GitHub returned an invalid verdict comment id");
			if (own) await app.updateIssueComment(token, owner, name, own.id, body);
			else await app.createIssueComment(token, owner, name, number, body);
		});
	} catch (error) {
		const status = error instanceof GithubError && error.status ? ` (GitHub ${error.status})` : "";
		await handoffProblem(c, effect, `Could not ${action}${status}. The platform will try again.`);
		throw error;
	}
}

/**
 * The item's lifetime hosted seconds after the ledger's latest entries for its session: each hold
 * counted once, whenever it is seen, and kept after the ledger has let it go. Decided synchronously on
 * the stored meta, which the next write of the item stores.
 */
function sessionsOf(meta: ItemMeta): string[] {
	return meta.reviewerSessionId ? [meta.sessionId, meta.reviewerSessionId] : [meta.sessionId];
}

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
		const seconds = lifetimeSeconds(stored.meta, facts);
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
function live(item: FactoryItem, effect: Effect): boolean {
	if (effect.kind === "release_review" || effect.kind === "withdraw" || effect.kind === "ask") return true;
	const run = item.run;
	if (item.question?.kind === "machine_removed" || ENDED.has(item.state) || run === null) return false;
	const key = currentKey(item);
	switch (effect.kind) {
		case "deliver":
			return effect.key === key && run.step.turn === "delivered";
		case "check_turn":
			return effect.turn === key && run.step.turn !== null;
		case "publish":
			return effect.key === key && run.step.kind === "publish";
		case "poll_ci":
			return effect.key === key && (run.step.kind === "ci" || run.step.kind === "handoff") && item.pr !== null;
		case "poll_pr":
			return effect.key === key && run.step.kind === "merged";
		case "handoff":
			return run.n === effect.verdict.run && item.pr !== null;
	}
}

/**
 * Performs one effect: what comes of it is taken as a fact. Throws when it could not be done, to be
 * tried again; answers false when the item as it is now does not want it, and nothing was done.
 */
async function perform(c: Ctx, row: EffectRow): Promise<boolean> {
	const effect: Effect = JSON.parse(row.effect);
	const stored = c.vars.stored;
	// Checked in the step that sends it: a cancel stored since the row was read leaves it undone.
	if (!stored || !live(stored.item, effect)) return false;
	const { item, meta } = stored;
	const sessionId = "to" in effect && effect.to === "review" ? meta.reviewerSessionId : meta.sessionId;
	if (!sessionId) throw new Error("Review delivery has no reviewer session.");
	const session = sessionActor(c, meta.uid, sessionId);
	switch (effect.kind) {
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
			await session.internalDeliver({ key: effect.key, itemId: item.id, title: item.task.title, text: effect.text, checkout, agent: effect.agent, maxSteps: effect.maxSteps, fetchBase: effect.fetchBase, startsRun: startsRun(effect.key) });
			return true;
		}
		case "release_review":
			await session.internalFreeSandbox(effect.run);
			return true;
		case "withdraw":
			await session.internalWithdraw(effect.key);
			return true;
		case "check_turn": {
			const fact = await session.internalCheckTurn({ turn: effect.turn, check: effect.key });
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
			const answer = await session.internalPublish({ key: effect.key, title: item.task.title, body: item.task.body });
			await take(c, { ...answer, at: Date.now(), key: effect.key, ...(answer.kind === "published" ? { openItems } : {}) } as Fact);
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
				const pull = await hub.pull(number).catch(() => null);
				return { reading, baseSha: pull?.base === meta.repository.branch ? pull.baseSha : null, mergeable: pull?.mergeable ?? null, prHead: pull?.headSha || null };
			};
			const { reading, mergeable, prHead, baseSha } = await read().catch((error: unknown) => ({ reading: { kind: "failed" as const, said: describeError(error) }, mergeable: null, prHead: null, baseSha: null }));
			const openItems = item.run?.step.kind === "handoff" ? 0 : (await factsOf(c, meta)).openItems;
			await take(c, { kind: "ci_read", at: Date.now(), key: effect.key, head: effect.head, reading, mergeable, prHead, openItems }, baseSha);
			return true;
		}
		case "poll_pr": {
			// In review, too: the last turn's sandbox time is settled while the person reviews.
			await factsOf(c, meta);
			const pull = await (await github(c, meta)).pull(effect.pr);
			await take(c, { kind: "pr_read", at: Date.now(), key: effect.key, state: pull.state, prHead: pull.headSha || null });
			return true;
		}
		case "handoff": {
			const next = c.vars.handoff.then(async () => {
				const latest = c.vars.stored?.item;
				if (!latest?.pr || !live(latest, effect)) return false;
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

const MAX_RAISE = { tokens: 1_000_000_000, turns: 1_000, activeSeconds: 7 * 86_400, hostedSeconds: 7 * 86_400 } as const;

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
	switch (action?.kind) {
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
			return { kind: "answer", at, by, question: action.question, choice: action.choice, note: note(action.note, false), budget };
		}
		default:
			throw bad("Say what to do with the item.");
	}
}

const CONFLICT: Record<ItemAction["kind"], string> = {
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
			await db.execute("CREATE TABLE IF NOT EXISTS item (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, due TEXT)");
			await db.execute("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, effect TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL)");
			await db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, data TEXT NOT NULL)");
			await db.execute(REPORTS_TABLE);
			await db.execute(REVIEWS_TABLE);
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
				await tx.execute("INSERT INTO item (id, revision, data) VALUES (1, ?, ?)", item.revision, JSON.stringify({ item, meta: input.meta }));
				await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", input.meta.createdAt, JSON.stringify({ at: input.meta.createdAt, by: input.startedBy ?? "platform", step: null, said: `Filed from ${input.meta.source === "api" ? "the API" : "the web app"}.` } satisfies ItemEvent));
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
		if (stored) await userActor(c, stored.meta.uid).internalDeleteItemAttachments(stored.item.id);
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

		internalSummary: (c): ItemSummary => {
			requireService(c);
			if (!c.vars.stored) throw new UserError("That item does not exist.", { code: "item_not_found" });
			return summaryOf(c.vars.stored);
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
				changed = await take(c, fact);
			} catch (error) {
				throw clientError(c.log, error, "The item could not be changed. Try again.");
			}
			if (!changed) throw new UserError(CONFLICT[input.action.kind], { code: "item_conflict" });
			return await viewOf(c);
		},

		// --- called by the item's session and by `user` -----------------------------------------

		/** A fact about the item's turn, from its session's outbox or from the user's turn queue. Resolves once it is stored. */
		internalFact: async (c, fact: Fact): Promise<void> => {
			requireService(c);
			const stored = c.vars.stored;
			if (!stored || typeof fact?.kind !== "string" || typeof fact.at !== "number") return;
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
