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

import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { clientError, describeError, requireService } from "../auth.js";
import { type ItemAction, type ItemEvent, type ItemSummary, type ItemView, MAX_NOTE_CHARS, type RoundCaps, type SessionRepository, type Verdict } from "../contract.js";
import { RULES, advance, currentKey } from "../factory/blueprint.js";
import type { Effect, Fact, FactoryItem } from "../factory/types.js";
import { githubApp, GithubError } from "../github/app.js";
import { readCi } from "../github/ci.js";
import { resolveRepository, type StoredConnection } from "../github/repos.js";
import { grantIsValid, sessionActor, userActor } from "./internal.js";

/** The rounds a run allows, as the blueprint stops on them (`RULES`), for the item's page. */
const ROUND_CAPS: RoundCaps = { plan: RULES.planRounds, gate: RULES.gateRounds, ci: RULES.ciRounds, conflict: RULES.conflictRounds };

/** What the item knows around the blueprint's `FactoryItem`. */
export interface ItemMeta {
	uid: string;
	sessionId: string;
	/** The repository of the user's GitHub connection; `branch` is the base. */
	repository: SessionRepository;
	source: ItemSummary["source"];
	createdAt: number;
	updatedAt: number;
	/** The latest verdict's result and flags, for the index. */
	verdict: ItemSummary["verdict"];
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
const RETRY_FIRST_MS = 15_000;
const RETRY_MOST_MS = 5 * 60_000;
/** The action the item's schedule fires: its name is looked up when it fires, so it is one constant (factory-e2e.ts checks it is registered). */
export const DUE_ACTION = "internalDue";
/** How soon an item wakes to perform what it stored, should it be stopped before it could: the performing itself starts at once. */
const SAFETY_MS = 5_000;
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
		budget: item.budget,
		spent: item.spent,
		sessionId: meta.sessionId,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		revision: item.revision,
	};
}

async function viewOf(c: Ctx, stored: Stored): Promise<ItemView> {
	const run = stored.item.run;
	const events = await c.db.execute<{ data: string }>("SELECT data FROM (SELECT seq, data FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq", VIEW_EVENTS);
	const verdicts = await c.db.execute<{ data: string }>("SELECT data FROM verdicts ORDER BY at, id");
	return {
		...summaryOf(stored),
		task: stored.item.task,
		// What the gate and CI read stays here: the page shows the run as the contract has it.
		run: run === null ? null : { n: run.n, startedAt: run.startedAt, endedAt: run.endedAt, stopReason: run.stopReason, step: run.step, rounds: run.rounds, caps: ROUND_CAPS },
		head: stored.item.head,
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

/**
 * The item after `fact`, stored with its effects and events in one transaction over the revision it
 * was decided from, and then performed. Resolves once it is stored, with whether the fact changed
 * anything: an action that answers after this has answered for what is durable.
 */
async function take(c: Ctx, fact: Fact): Promise<boolean> {
	const stored = c.vars.stored;
	if (!stored) return false;
	// From here to the write being queued nothing is awaited: the decision is one step.
	const before = stored.item;
	const outcome = advance(before, fact);
	if (outcome.item === before) return false;
	stored.item = outcome.item;
	stored.meta.updatedAt = fact.at;
	const handoff = outcome.effects.find((effect): effect is Extract<Effect, { kind: "handoff" }> => effect.kind === "handoff");
	if (handoff) stored.meta.verdict = { result: handoff.verdict.result, flags: handoff.verdict.flags, ci: handoff.verdict.ci.state };
	// The item, its revision and its data are taken from this decision now: a later decision, made while this
	// one waits for its write, changes `stored` and must not be written beside this one's data.
	const next = outcome.item;
	const data = JSON.stringify({ item: next, meta: stored.meta });
	// An `ask` is the question on the item itself, which reaches the index with the summary: nothing is left to perform.
	const effects = outcome.effects.filter((effect) => effect.kind !== "ask");
	try {
		await queued(c, () =>
			c.db.transaction(async (tx) => {
				const [row] = await tx.execute<{ revision: number }>("SELECT revision FROM item WHERE id = 1");
				if (row?.revision !== before.revision) throw new Error(`the item is at revision ${row?.revision ?? "none"}, not ${before.revision}`);
				await tx.execute("UPDATE item SET revision = ?, data = ? WHERE id = 1", stored.item.revision, data);
				for (const event of outcome.events) await tx.execute("INSERT INTO events (at, data) VALUES (?, ?)", event.at, JSON.stringify(event));
				for (const effect of effects) {
					await tx.execute("INSERT OR REPLACE INTO effects (id, effect, due_at, attempts) VALUES (?, ?, ?, 0)", rowId(effect), JSON.stringify(effect), "at" in effect && effect.at !== undefined ? effect.at : 0);
				}
				if (handoff) await tx.execute("INSERT OR REPLACE INTO verdicts (id, run, head, at, data) VALUES (?, ?, ?, ?, ?)", handoff.verdict.id, handoff.verdict.run, handoff.verdict.head, handoff.verdict.at, JSON.stringify(handoff.verdict));
			}, { name: "item.take" }),
		);
	} catch (error) {
		// What is stored is what holds: the item is read again, and the fact is lost to whoever sends it again.
		c.vars.stored = await load(c.db).catch(() => c.vars.stored);
		throw error;
	}
	for (const event of outcome.events) console.log(`[wlp] item.event uid=${stored.meta.uid} item=${before.id} revision=${stored.item.revision}: ${event.said.replace(/\s+/g, " ").slice(0, 200)}`);
	report(c);
	// Durable before anything is performed: an item stopped by a deploy before its effects ran wakes for them.
	if (effects.length > 0) await c.schedule.at(Date.now() + SAFETY_MS, DUE_ACTION);
	void c.keepAwake(performDue(c));
	return true;
}

async function load(db: RawAccess): Promise<Stored | null> {
	const [row] = await db.execute<{ data: string }>("SELECT data FROM item WHERE id = 1");
	return row ? (JSON.parse(row.data) as Stored) : null;
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
		const rows = await c.db.execute<EffectRow>("SELECT id, effect, due_at, attempts FROM effects WHERE due_at <= ? ORDER BY rowid", now);
		await Promise.all(rows.filter((row) => !c.vars.performing.has(row.id)).map((row) => performRow(c, row)));
		await armDue(c);
	} catch (error) {
		c.log.error({ msg: "could not perform the item's effects", error: describeError(error) });
	}
}

async function performRow(c: Ctx, row: EffectRow): Promise<void> {
	c.vars.performing.add(row.id);
	try {
		await perform(c, row);
		await queued(c, () => c.db.execute("DELETE FROM effects WHERE id = ? AND effect = ?", row.id, row.effect));
	} catch (error) {
		const wait = Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** Math.min(row.attempts, 10));
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
	const [next] = await c.db.execute<{ at: number | null }>("SELECT MIN(due_at) AS at FROM effects");
	const at = next?.at ?? null;
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

/** Put outside text in one paragraph. Bound it before escaping, so even twenty criteria fit in a GitHub comment. */
function commentText(value: string, limit: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	const bounded = line.length > limit ? `${line.slice(0, limit)}…` : line;
	return bounded.replace(/([\\`*_{}\[\]()<>!&~|@#:$.])/g, "\\$1");
}

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
			// Older queued handoffs kept the sentence in the same transaction, only in the item's log.
			const words = effect.words ?? (await c.db.execute<{ said: string }>(
				"SELECT json_extract(data, '$.said') AS said FROM events WHERE at = ? AND json_extract(data, '$.step.kind') = 'handoff' ORDER BY seq LIMIT 1", verdict.at,
			))[0]?.said;
			if (!words) throw new Error("the handoff has no recorded verdict sentence");
			const acceptance = verdict.acceptance.map((criterion) => `- ${commentText(criterion, 1000)}`);
			const body = [marker, `**Windlass verdict at ${commentText(verdict.head.slice(0, 7), 7)}: ${verdict.result}**`, commentText(words, MAX_NOTE_CHARS), ...(acceptance.length ? [`Acceptance criteria left to you:\n\n${acceptance.join("\n")}`] : [])].join("\n\n");
			const comments = await app.issueComments(token, owner, name, number);
			const own = comments.find((one) => one.author.toLowerCase() === `${app.settings.slug.toLowerCase()}[bot]` && one.body.split("\n", 1)[0] === marker);
			if (own) await app.updateIssueComment(token, owner, name, own.id, body);
			else await app.createIssueComment(token, owner, name, number, body);
		});
	} catch (error) {
		const status = error instanceof GithubError && error.status ? ` (GitHub ${error.status})` : "";
		await handoffProblem(c, effect, `Could not ${action}${status}. The platform will try again.`);
		throw error;
	}
}

/** Performs one effect: what comes of it is taken as a fact. Throws when it could not be done, to be tried again. */
async function perform(c: Ctx, row: EffectRow): Promise<void> {
	const effect: Effect = JSON.parse(row.effect);
	const stored = c.vars.stored;
	if (!stored) return;
	const { item, meta } = stored;
	const session = sessionActor(c, meta.uid, meta.sessionId);
	const current = currentKey(item);
	switch (effect.kind) {
		case "deliver":
			await session.internalDeliver({ key: effect.key, itemId: item.id, title: item.task.title, text: effect.text, agent: effect.agent, maxSteps: effect.maxSteps, fetchBase: effect.fetchBase, startsRun: startsRun(effect.key) });
			return;
		case "withdraw":
			await session.internalWithdraw(effect.key);
			return;
		case "check_turn": {
			if (effect.turn !== current) return;
			const fact = await session.internalCheckTurn({ turn: effect.turn, check: effect.key });
			if (fact !== null) await take(c, fact);
			return;
		}
		case "publish": {
			if (effect.key !== current) return;
			const answer = await session.internalPublish({ key: effect.key, title: item.task.title, body: item.task.body });
			const { openItems } = await userActor(c, meta.uid).internalItemFacts(meta.sessionId);
			await take(c, { ...answer, at: Date.now(), key: effect.key, ...(answer.kind === "published" ? { openItems } : {}) } as Fact);
			return;
		}
		case "poll_ci": {
			if (effect.key !== current || item.pr === null) return;
			const hub = await github(c, meta);
			// A commit's SHA, or the branch where git did not say which commit it pushed: as part of the address, in one piece.
			const reading = await readCi(hub.app, { installationId: hub.installationId, repositoryId: meta.repository.id, owner: hub.owner, name: hub.name, head: encodeURIComponent(effect.head) });
			// GitHub works out whether a pull request can merge after a push, and says null until it has.
			const mergeable = (await hub.pull(item.pr.number).catch(() => null))?.mergeable ?? null;
			const { openItems } = await userActor(c, meta.uid).internalItemFacts(meta.sessionId);
			await take(c, { kind: "ci_read", at: Date.now(), key: effect.key, head: effect.head, reading, mergeable, openItems });
			return;
		}
		case "poll_pr": {
			if (effect.key !== current) return;
			const pull = await (await github(c, meta)).pull(effect.pr);
			await take(c, { kind: "pr_read", at: Date.now(), key: effect.key, state: pull.state });
			return;
		}
		case "handoff": {
			const next = c.vars.handoff.then(async () => {
				const latest = c.vars.stored?.item;
				if (latest?.pr && latest.run?.n === effect.verdict.run) await handoffOnGithub(c, meta, latest.pr.number, effect, row);
			});
			c.vars.handoff = next.catch(() => undefined);
			return next;
		}
		case "ask":
			return;
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
			return await viewOf(c, c.vars.stored);
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
			return await viewOf(c, stored);
		},

		// --- called by the item's session and by `user` -----------------------------------------

		/** A fact about the item's turn, from its session's outbox or from the user's turn queue. Resolves once it is stored. */
		internalFact: async (c, fact: Fact): Promise<void> => {
			requireService(c);
			const stored = c.vars.stored;
			if (!stored || typeof fact?.kind !== "string" || typeof fact.at !== "number") return;
			if (fact.kind !== "turn_ended" && fact.kind !== "turn_started" && fact.kind !== "turn_running" && fact.kind !== "turn_waiting") return;
			if (fact.kind === "turn_ended") {
				// The sandbox time the item's session has used so far is the ledger's, which the user's actor keeps.
				const { hostedSeconds } = await userActor(c, stored.meta.uid).internalItemFacts(stored.meta.sessionId);
				await take(c, { ...fact, spend: { tokens: fact.spend?.tokens ?? 0, hostedSeconds } });
				return;
			}
			await take(c, fact);
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
