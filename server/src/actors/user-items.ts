/**
 * The software factory's part of the `user` actor (Plans "software factory" §1.2, §4.1): the index of
 * the user's work items, the turn queue, and the user's API tokens. user.ts registers these actions
 * and holds the state in its vars; everything about items is here.
 *
 * The index. One row per item with its summary, as the item last reported it, and the key it was
 * created with. An item and its agent session are made with ids derived from that key (or random,
 * without one), so a creation tried again after a lost answer reaches the same two actors and makes
 * nothing twice; the item's session is an ordinary row of the sessions' index, marked with its item.
 *
 * The turn queue. An item's turn does not take a running slot the way a person's prompt does
 * (`internalAcquireRun`, which refuses at the limit): its session asks here, and the request waits
 * as a row until it is admitted (factory/budget.ts `admit`), which answers granted or a wait with
 * the sentence the item shows. A slot is a row with its own id, named for the turn it was given to,
 * and released only by that id, when that turn ends (the session's outbox), or when it has been held
 * longer than any turn may run: never by what a session's summary says, which cannot tell "released"
 * from "not reported yet". A person's prompt counts these slots, and the factory counts the person's
 * running sessions, against the same limit; the factory's own share is lower, so a person always has
 * a turn of their own. Requests are admitted oldest first: each item has at most one turn waiting,
 * so oldest first is round-robin over items. A request that waits is tried again when a slot is given
 * back, when a session of the person's goes idle, and at its wait's time on the actor's schedule.
 */

import { createHash, randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { mayUse } from "../access.js";
import { readAccountDefaults } from "../account-defaults.js";
import { API_TOKENS_TABLE, ApiTokenProblem, createApiToken, listApiTokens, revokeApiToken, tokenOwner, useApiToken } from "../api-tokens.js";
import { clientError, requireService, requireServiceFor, requireUser } from "../auth.js";
import { config } from "../config.js";
import {
	type ApiToken,
	type ApiTokenScope,
	type CreateItemInput,
	type CreateSessionInput,
	type FactoryLimits,
	type ItemAction,
	type ItemSummary,
	type ItemView,
	type MachineSummary,
	type SandboxPlace,
	MAX_ACCEPTANCE_CRITERIA,
	MAX_ITEM_BODY_CHARS,
	MAX_NOTE_CHARS,
	MAX_TITLE_CHARS,
	type SandboxProfileId,
	type SessionSummary,
	USAGE_HISTORY_DAYS,
	type UserProfile,
	type Wait,
} from "../contract.js";
import { createItem } from "../factory/blueprint.js";
import { admit, retryAt } from "../factory/budget.js";
import { getLayer } from "../layer.js";
import { readDefaults } from "../repository-defaults.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { type UsageBook, dayOf, hostedLimitsApply } from "../usage.js";
import { createItemActor, isActorGone, itemActor, sessionActor } from "./internal.js";
import type { TurnAnswer, TurnRelease, TurnRequest } from "./session-inbox.js";
import { launchPlace, launchMachineProfiles } from "./user-machines.js";
import type { ItemMeta } from "./work-item.js";

export const ITEM_TABLES = [
	"CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, summary TEXT NOT NULL, key TEXT, sent TEXT)",
	// A creation's key and the digest of what it asked for, written before either of its actors is made: a creation tried
	// again under that key with another body is refused even when the first never reached the index.
	"CREATE TABLE IF NOT EXISTS item_keys (key TEXT PRIMARY KEY, sent TEXT NOT NULL, id TEXT NOT NULL)",
	// A turn of an item's session waiting for a slot: `wait` is what it was last told, `attempt` how often it waited.
	"CREATE TABLE IF NOT EXISTS turn_request (key TEXT PRIMARY KEY, session TEXT NOT NULL, item TEXT NOT NULL, title TEXT NOT NULL, starts_run INTEGER NOT NULL, at INTEGER NOT NULL, attempt INTEGER NOT NULL, full INTEGER, full_until INTEGER, wait TEXT)",
	// A slot given to the turn of `key`: released by its id, or when `expires_at` has passed.
	"CREATE TABLE IF NOT EXISTS turn_slot (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, session TEXT NOT NULL, item TEXT NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
	// A slot whose session has not been told of it yet: told on the queue's next run and on wake, until the session answers.
	"CREATE TABLE IF NOT EXISTS turn_grant (slot TEXT PRIMARY KEY)",
	// The schedule that tries the waiting requests again: one, at the earliest wait's time.
	"CREATE TABLE IF NOT EXISTS turn_queue (id INTEGER PRIMARY KEY CHECK (id = 1), schedule TEXT NOT NULL, at INTEGER NOT NULL)",
	API_TOKENS_TABLE,
];

interface Request {
	key: string;
	session: string;
	item: string;
	title: string;
	startsRun: boolean;
	at: number;
	attempt: number;
	/** The hosted deployment's cap, when that was the refusal. */
	full: number | null;
	/** Retry time after a deployment refusal or an unanswered machine attach. */
	deferUntil: number | null;
	wait: Wait | null;
}

interface Slot {
	id: string;
	key: string;
	session: string;
	item: string;
	title: string;
	at: number;
	expiresAt: number;
	/** False until the session has answered for its grant: a grant lost with a server or a reply is sent again. */
	told: boolean;
}

export interface ItemsState {
	items: Map<string, ItemSummary>;
	/** The items created with a key, by that key: what was asked for, and the item. */
	created: Map<string, Submission & { id: string }>;
	creating: Attempts<ItemSummary>;
	requests: Map<string, Request>;
	slots: Map<string, Slot>;
	queueAt: { id: string; at: number } | null;
}

/** A slot is held at most this long: longer than any turn may run, and the time a lost release costs. */
const SLOT_LEASE_MS = config.turnTimeoutMs + 5 * 60_000;
/** What the sandbox layer said of the deployment's cap is believed this long. */
const FULL_FOR_MS = 5 * 60_000;
const KEYED = "work item";
/** The action the turn queue's schedule fires (factory-e2e.ts checks it is registered under this name). */
export const QUEUE_ACTION = "internalTurnQueue";

export async function loadItems(db: RawAccess): Promise<ItemsState> {
	const items = new Map<string, ItemSummary>();
	const created = new Map<string, Submission & { id: string }>();
	for (const row of await db.execute<{ summary: string; key: string | null; sent: string | null }>("SELECT summary, key, sent FROM items")) {
		const summary = JSON.parse(row.summary) as ItemSummary;
		items.set(summary.id, summary);
		if (row.key !== null && row.sent !== null) created.set(row.key, { key: row.key, sent: row.sent, id: summary.id });
	}
	for (const row of await db.execute<{ key: string; sent: string; id: string }>("SELECT key, sent, id FROM item_keys")) created.set(row.key, row);
	const requests = new Map<string, Request>();
	type RequestRow = { key: string; session: string; item: string; title: string; starts_run: number; at: number; attempt: number; full: number | null; full_until: number | null; wait: string | null };
	for (const row of await db.execute<RequestRow>("SELECT key, session, item, title, starts_run, at, attempt, full, full_until, wait FROM turn_request")) {
		requests.set(row.key, { key: row.key, session: row.session, item: row.item, title: row.title, startsRun: row.starts_run === 1, at: row.at, attempt: row.attempt, full: row.full, deferUntil: row.full_until, wait: row.wait ? (JSON.parse(row.wait) as Wait) : null });
	}
	const slots = new Map<string, Slot>();
	type SlotRow = { id: string; key: string; session: string; item: string; title: string; at: number; expires_at: number };
	const untold = new Set((await db.execute<{ slot: string }>("SELECT slot FROM turn_grant")).map((row) => row.slot));
	for (const row of await db.execute<SlotRow>("SELECT id, key, session, item, title, at, expires_at FROM turn_slot")) slots.set(row.id, { ...row, expiresAt: row.expires_at, told: !untold.has(row.id) });
	const [queue] = await db.execute<{ schedule: string; at: number }>("SELECT schedule, at FROM turn_queue WHERE id = 1");
	return { items, created, creating: new Attempts(), requests, slots, queueAt: queue ? { id: queue.schedule, at: queue.at } : null };
}

/**
 * What an item reads of its user: its session's entries in the ledger, each once by its hold (the item
 * adds up its own lifetime total from them, since the ledger keeps only the last days), and the user's
 * items not done, failed or cancelled.
 */
export interface ItemFacts {
	entries: Array<{ hold: string; seconds: number }>;
	openItems: number;
}

/** What the factory's functions need of the user actor's context. */
export interface ItemsCtx {
	vars: { items: ItemsState; machines: Map<string, MachineSummary>; sessions: Map<string, SessionSummary>; usage: UsageBook; profile: UserProfile | null };
	db: RawAccess;
	key: string[];
	log: { warn(entry: unknown): void; error(entry: unknown): void };
	broadcast(name: string, ...args: unknown[]): void;
	// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
	client(): any;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	schedule: { at(timestamp: number, action: string, ...args: unknown[]): Promise<string>; cancel(id: string): Promise<boolean> };
	conn?: { params: unknown } | null;
	scheduledFire?: { id: string; scheduledAt: number; firedAt: number };
}

/** `makeSession` of user.ts: makes the item's session under the id given, with the item as its origin, and puts it in the index. */
export type MakeSession = (c: ItemsCtx, profile: UserProfile, input: CreateSessionInput, submission: null, item: { sessionId: string; itemId: string }) => Promise<SessionSummary>;

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

function itemList(state: ItemsState): ItemSummary[] {
	return [...state.items.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** The summary's own fields of an item's summary or page: the index keeps no more. */
function summaryFields(item: ItemSummary): ItemSummary {
	const { id, title, repository, place, source, state, wait, question, pullRequest, verdict, budget, spent, sessionId, createdAt, updatedAt, revision } = item;
	return { id, title, repository, place, source, state, wait, question, pullRequest, verdict, budget, spent, sessionId, createdAt, updatedAt, revision };
}

/** Takes a summary the item reported when it is newer than the one held: reports can arrive out of order. */
async function noteItem(c: ItemsCtx, given: ItemSummary): Promise<void> {
	const summary = summaryFields(given);
	const held = c.vars.items.items.get(summary.id);
	if (!held || held.revision > summary.revision) return;
	c.vars.items.items.set(summary.id, summary);
	await c.db.execute("UPDATE items SET summary = ? WHERE id = ?", JSON.stringify(summary), summary.id);
	c.broadcast("items", itemList(c.vars.items));
}

function knownItem(c: ItemsCtx, id: unknown): ItemSummary {
	const summary = typeof id === "string" ? c.vars.items.items.get(id) : undefined;
	if (!summary) throw new UserError("That item does not exist.", { code: "item_not_found" });
	return summary;
}

const hex16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The input of a new item, checked. */
function cleanItemInput(raw: unknown): Required<Pick<CreateItemInput, "title" | "body" | "acceptance">> & { place: SandboxPlace; repository: { id: number; branch?: string }; profile: SandboxProfileId | null; model: string | null; start: boolean } {
	const bad = (message: string) => new UserError(message, { code: "bad_input" });
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof CreateItemInput, unknown>>;
	const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
	if (title === "" || title.length > MAX_TITLE_CHARS) throw bad(`Give the item a title of at most ${MAX_TITLE_CHARS} characters.`);
	const body = typeof input.body === "string" ? input.body.trim() : "";
	if (body === "" || body.length > MAX_ITEM_BODY_CHARS) throw bad(`Say what is to be done, in at most ${MAX_ITEM_BODY_CHARS} characters.`);
	const acceptance = input.acceptance === undefined || input.acceptance === null ? [] : input.acceptance;
	if (!Array.isArray(acceptance) || acceptance.length > MAX_ACCEPTANCE_CRITERIA || !acceptance.every((line) => typeof line === "string" && line.trim() !== "" && line.length <= MAX_NOTE_CHARS)) {
		throw bad(`The acceptance criteria are at most ${MAX_ACCEPTANCE_CRITERIA} lines of text, each at most ${MAX_NOTE_CHARS} characters.`);
	}
	const place = launchPlace(input.place ?? undefined);
	const repository = input.repository as { id?: unknown; branch?: unknown } | undefined;
	if (typeof repository !== "object" || repository === null || typeof repository.id !== "number") throw bad("Choose a repository of your GitHub connection for the item.");
	if (input.start !== undefined && input.start !== null && typeof input.start !== "boolean") throw bad("Say yes or no to starting the item at once.");
	const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
	return {
		place,
		title,
		body,
		acceptance: (acceptance as string[]).map((line) => line.trim()),
		repository: { id: repository.id, ...(typeof repository.branch === "string" ? { branch: repository.branch } : {}) },
		profile: text(input.profile) as SandboxProfileId | null,
		model: text(input.model),
		start: input.start === true,
	};
}

/** The sandbox an item's session is made in when the input names none: the repository's default, the account's, then the deployment's first that can be chosen. */
async function itemProfile(c: ItemsCtx, repositoryId: number, asked: SandboxProfileId | null, place: SandboxPlace): Promise<SandboxProfileId> {
	if (place.kind === "machine") {
		const machine = await launchMachineProfiles(c.db, place.machineId);
		const available = machine.profiles.filter(profile => profile.available);
		const chosen = available.find(profile => profile.id === asked) ?? available[0];
		if (!chosen) throw new UserError(`Your machine "${machine.name}" offers no available sandbox profile for this item.`, { code: "bad_profile" });
		return chosen.id;
	}
	if (asked !== null) return asked;
	const saved = (await readDefaults(c.db, `github:${repositoryId}`)).profile ?? (await readAccountDefaults(c.db)).profile;
	if (saved !== null) return saved;
	const first = (await getLayer()).sandboxes.profiles().find((profile) => profile.available);
	if (!first) throw new UserError("This deployment offers no sandbox an item could run in.", { code: "bad_profile" });
	return first.id;
}

/**
 * Makes the item: its session (`makeSession`, under an id derived from the item's), then the item
 * actor, then its row in the index, in one step at the end. Both actors are made under ids fixed
 * before anything is asked of the engine, and one that exists already is taken as made: a creation
 * that is tried again after a lost answer, or after the server stopped half way, finishes the first.
 */
async function makeItem(c: ItemsCtx, profile: UserProfile, raw: unknown, source: ItemSummary["source"], submission: Submission | null, makeSession: MakeSession): Promise<ItemSummary> {
	const input = cleanItemInput(raw);
	const uid = profile.uid;
	const itemId = `i_${submission ? hex16(`${uid}\n${submission.key}`) : randomBytes(8).toString("hex")}`;
	const sessionId = `s_${hex16(`item\n${itemId}`)}`;
	let summary: ItemSummary;
	// Set just before the session is made: a refusal before that made nothing, and leaves the key unused.
	let begun = false;
	if (submission) {
		// The key is this body's from here, before anything is made: in memory now, so that a second attempt is judged by it at
		// once, and stored before the first actor, so that it holds across a restart too.
		c.vars.items.created.set(submission.key, { ...submission, id: itemId });
		await c.db.execute("INSERT OR IGNORE INTO item_keys (key, sent, id) VALUES (?, ?, ?)", submission.key, submission.sent, itemId);
	}
	try {
		const existing = c.vars.sessions.get(sessionId);
		const sandbox = existing ? null : await itemProfile(c, input.repository.id, input.profile, input.place);
		begun = true;
		const session = existing ?? (await makeSession(c, profile, { title: input.title, place: input.place, profile: sandbox as SandboxProfileId, ...(input.model ? { model: input.model } : {}), repository: input.repository }, null, { sessionId, itemId }));
		const repository = session.repository;
		if (!repository) throw new Error("the item's session has no repository");
		const now = Date.now();
		const meta: ItemMeta = { uid, sessionId, repository, source, createdAt: now, updatedAt: now, verdict: null, ledger: { seconds: 0, holds: [] } };
		const item = createItem({ id: itemId, task: { title: input.title, body: input.body, acceptance: input.acceptance, base: repository.branch }, place: session.place, budget: config.factory.item });
		await createItemActor(c, uid, itemId, { item, meta, startedBy: input.start ? `person:${uid}` : null });
		summary = await itemActor(c, uid, itemId).internalSummary();
	} catch (error) {
		// Nothing was made: the key is unused again, as a refused attempt leaves it. Once anything may exist, it stays this body's.
		if (submission && !begun) {
			c.vars.items.created.delete(submission.key);
			await c.db.execute("DELETE FROM item_keys WHERE key = ?", submission.key).catch(() => undefined);
		}
		throw clientError(c.log, error, "The item could not be filed. Try again.");
	}
	// In one step with the item: from here a creation with this key answers with it.
	c.vars.items.items.set(summary.id, summary);
	if (submission) c.vars.items.created.set(submission.key, { ...submission, id: summary.id });
	await c.db.execute("INSERT INTO items (id, created_at, summary, key, sent) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary", summary.id, summary.createdAt, JSON.stringify(summary), submission?.key ?? null, submission?.sent ?? null);
	c.broadcast("items", itemList(c.vars.items));
	console.log(`[wlp] item.created uid=${uid} item=${summary.id} session=${sessionId} source=${source}`);
	if (summary.place.kind === "machine" && !c.vars.machines.has(summary.place.machineId)) {
		await notifyRemovedMachines(c, summary.place.machineId);
		return itemView(c, summary.id);
	}
	return summary;
}

/** `createItem`, keyed or not, as `createSession` is: the same key answers with the item it made. */
async function fileItem(c: ItemsCtx, profile: UserProfile, raw: unknown, source: ItemSummary["source"], makeSession: MakeSession): Promise<ItemSummary> {
	if (typeof raw !== "object" || raw === null) throw new UserError("Say what the item is.", { code: "bad_input" });
	let attempt: Promise<ItemSummary>;
	try {
		const { idempotencyKey, ...asked } = raw as CreateItemInput;
		const submission = submissionOf(idempotencyKey, asked);
		if (submission === null) return await makeItem(c, profile, asked, source, null, makeSession);
		const made = c.vars.items.created.get(submission.key);
		const item = made && isRepeat(made, submission, KEYED) ? c.vars.items.items.get(made.id) : undefined;
		if (item) return item;
		attempt = c.vars.items.creating.run(submission, KEYED, () => makeItem(c, profile, asked, source, submission, makeSession));
	} catch (error) {
		if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	}
	return await attempt;
}

async function itemView(c: ItemsCtx, id: string): Promise<ItemView> {
	const view = await itemActor(c, c.key[0] as string, id).internalView();
	await noteItem(c, view);
	return view;
}

// ---------------------------------------------------------------------------------------------
// The turn queue
// ---------------------------------------------------------------------------------------------

async function storeRequest(db: RawAccess, request: Request): Promise<void> {
	await db.execute(
		"INSERT OR REPLACE INTO turn_request (key, session, item, title, starts_run, at, attempt, full, full_until, wait) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		request.key,
		request.session,
		request.item,
		request.title,
		request.startsRun ? 1 : 0,
		request.at,
		request.attempt,
		request.full,
		request.deferUntil,
		request.wait === null ? null : JSON.stringify(request.wait),
	);
}

/** The factory's slots held now, for `internalAcquireRun`: they count against the person's turns too. */
export function factorySlots(c: { vars: { items: ItemsState } }): number {
	return c.vars.items.slots.size;
}

/**
 * Admits what can run now, oldest first, and gives each its slot; every other request gets the wait
 * that holds it. The counts and the grants are one synchronous step; what was decided is then
 * written, the sessions told of their slots (except `answering`, which is answered directly), the
 * items told of their waits, and the schedule set for the earliest wait. A grant whose session could
 * not be told is taken back and tried again later.
 */
async function runQueue(c: ItemsCtx, answering: string | null = null, retrying = false): Promise<Slot | null> {
	const state = c.vars.items;
	const now = Date.now();
	const released: string[] = [];
	for (const slot of state.slots.values()) {
		if (slot.expiresAt > now) continue;
		state.slots.delete(slot.id);
		released.push(slot.id);
		// Asked for again: a turn whose slot outlived every turn's limit never started (its grant was lost with a server), and a
		// session that ended it answers a second grant by giving it back.
		if (!state.requests.has(slot.key)) state.requests.set(slot.key, { key: slot.key, session: slot.session, item: slot.item, title: slot.title, startsRun: false, at: slot.at, attempt: 0, full: null, deferUntil: null, wait: null });
		console.warn(`[wlp] factory.slot_expired uid=${c.key[0]} slot=${slot.id} key=${slot.key}: held past ${Math.round(SLOT_LEASE_MS / 60_000)} min without its turn's end being reported; given back and asked for again`);
	}
	const limits = config.factory;
	const sessions = [...c.vars.sessions.values()];
	// The person's own agents at work, as `internalAcquireRun` counts them: one on a machine of theirs is not (`hostedLimitsApply`).
	const own = sessions.filter((session) => !session.item && session.status !== "idle" && hostedLimitsApply(session.place)).length;
	const inReview = [...state.items.values()].filter((item) => item.state === "review").length;
	const usage = c.vars.usage.numbers(now);
	const hostedRunning = new Set(sessions.filter((session) => session.place.kind === "hosted" && session.sandbox === "running").map((session) => session.id));
	// A session given a slot runs a sandbox from then on, whether or not its summary has said so yet: counted across admissions, not only within one.
	for (const slot of state.slots.values()) {
		if (c.vars.sessions.get(slot.session)?.place.kind === "hosted") hostedRunning.add(slot.session);
	}
	const granted: Slot[] = [];
	const waits: Request[] = [];
	const dropped: string[] = [];
	const removed: Request[] = [];
	for (const request of [...state.requests.values()].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))) {
		// The item may not be in the index yet: its first delivery can come before its creation has answered here.
		const session = c.vars.sessions.get(request.session);
		if (!session) {
			state.requests.delete(request.key);
			dropped.push(request.key);
			continue;
		}
		const slots = [...state.slots.values()];
		const machine = session.place.kind === "machine" ? c.vars.machines.get(session.place.machineId) : null;
		if (session.place.kind === "machine" && !machine) {
			// Keep the request until the item's durable withdrawal. Its creation can precede the index entry.
			removed.push(request);
			continue;
		}
		const answer = admit({
			at: now,
			limits,
			turns: { running: own + slots.length, factory: slots.map((slot) => slot.title) },
			startsRun: request.startsRun,
			inReview,
			// The session's own sandbox, running already, is not one more for its turn.
			place: machine ? {
				kind: "machine", name: machine.name, online: machine.status === "online",
				attachRetryAt: machine.since <= request.at ? request.deferUntil : null,
				running: machine.sandboxes.filter(box => box.state === "running" && box.sessionId !== session.id).length,
				max: machine.maxRunning ?? Infinity,
				keptFull: machine.maxSandboxes !== undefined && machine.sandboxes.length >= machine.maxSandboxes && !machine.sandboxes.some(box => box.sessionId === session.id),
			} : { kind: "hosted", usage, running: hostedRunning.size - (hostedRunning.has(session.id) ? 1 : 0), needsSandbox: session.sandbox === "none", deploymentFull: (request.deferUntil ?? 0) > now ? request.full : null },
			attempt: request.attempt,
		});
		if (answer.ok) {
			// The one asking now is told in its answer; any other is told below, and until it answers the grant stays recorded.
			const slot: Slot = { id: `t_${randomBytes(8).toString("hex")}`, key: request.key, session: request.session, item: request.item, title: request.title, at: now, expiresAt: now + SLOT_LEASE_MS, told: request.key === answering };
			state.requests.delete(request.key);
			state.slots.set(slot.id, slot);
			granted.push(slot);
			if (hostedLimitsApply(session.place)) hostedRunning.add(session.id);
			continue;
		}
		const before = request.wait;
		// A try that was due counts as one more wait: the next one is further off.
		if (retrying && before !== null && before.retryAt !== null && before.retryAt <= now) request.attempt += 1;
		request.wait = answer.wait;
		if (before?.sentence !== answer.wait.sentence || before?.retryAt !== answer.wait.retryAt) waits.push(request);
	}

	for (const id of released) {
		await c.db.execute("DELETE FROM turn_slot WHERE id = ?", id);
		await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", id);
	}
	for (const key of dropped) await c.db.execute("DELETE FROM turn_request WHERE key = ?", key);
	for (const slot of granted) {
		// The request becomes its slot in one transaction: a server stopped in between leaves one or the other, never neither.
		await c.db.transaction(async (tx) => {
			await tx.execute("DELETE FROM turn_request WHERE key = ?", slot.key);
			await tx.execute("INSERT OR REPLACE INTO turn_slot (id, key, session, item, title, at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", slot.id, slot.key, slot.session, slot.item, slot.title, slot.at, slot.expiresAt);
			if (!slot.told) await tx.execute("INSERT OR IGNORE INTO turn_grant (slot) VALUES (?)", slot.id);
		}, { name: "queue.grant" });
		console.log(`[wlp] factory.slot_granted uid=${c.key[0]} slot=${slot.id} key=${slot.key} factory=${state.slots.size}`);
	}
	for (const request of waits) await storeRequest(c.db, request);

	const uid = c.key[0] as string;
	const mine = granted.find((slot) => slot.key === answering) ?? null;
	// Every slot its session has not answered for: the ones granted now, and any whose grant was lost before.
	for (const slot of [...state.slots.values()].filter((one) => !one.told)) {
		try {
			await sessionActor(c, uid, slot.session).internalGrant({ key: slot.key, slot: slot.id });
			slot.told = true;
			await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
		} catch (error) {
			if (!isActorGone(error)) {
				// Kept, slot and all: the session may have taken it and only its answer was lost. Told again on the next run, or freed by its lease.
				c.log.warn({ msg: "could not give a session its slot; it is told again later", session: slot.session, error: String(error) });
				continue;
			}
			state.slots.delete(slot.id);
			await c.db.execute("DELETE FROM turn_slot WHERE id = ?", slot.id);
			await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
		}
	}
	for (const request of removed) {
		await itemActor(c, uid, request.item).internalFact({ kind: "machine_removed", at: now });
		state.requests.delete(request.key);
		await c.db.execute("DELETE FROM turn_request WHERE key = ?", request.key);
	}
	for (const request of waits) {
		if (request.wait === null) continue;
		const fact = { kind: "turn_waiting" as const, at: now, key: request.key, wait: request.wait };
		await itemActor(c, uid, request.item)
			.internalFact(fact)
			.catch((error: unknown) => c.log.warn({ msg: "could not tell an item why its turn waits", item: request.item, error: String(error) }));
	}
	await armQueue(c);
	return mine;
}

/** One schedule, at the earliest time a waiting request is to be tried again. */
async function armQueue(c: ItemsCtx): Promise<void> {
	const state = c.vars.items;
	const times = [...state.requests.values()].map((request) => request.wait?.retryAt ?? null).filter((at): at is number => at !== null);
	if (times.length === 0) return;
	const at = Math.max(Date.now(), Math.min(...times));
	if (state.queueAt !== null && state.queueAt.at <= at && state.queueAt.at > Date.now()) return;
	const before = state.queueAt;
	const id = await c.schedule.at(at, QUEUE_ACTION);
	state.queueAt = { id, at };
	await c.db.execute("INSERT OR REPLACE INTO turn_queue (id, schedule, at) VALUES (1, ?, ?)", id, at);
	if (before !== null) await c.schedule.cancel(before.id).catch(() => false);
}

/** Removal also reaches drafts and work waiting on GitHub. Repeat on wake in case a notification was cut off. */
export async function notifyRemovedMachines(c: ItemsCtx, machineId?: string): Promise<void> {
	for (const item of c.vars.items.items.values()) {
		if (item.place.kind !== "machine" || (machineId && item.place.machineId !== machineId) || c.vars.machines.has(item.place.machineId)) continue;
		if (["done", "failed", "cancelled"].includes(item.state) || item.question?.kind === "machine_removed") continue;
		await itemActor(c, c.key[0]!, item.id).internalFact({ kind: "machine_removed", at: Date.now() });
	}
}

/** Something that frees capacity happened (a person's session went idle), or the actor woke: the waiting requests are tried, and the schedule armed again. Never throws. */
export function queueChanged(c: ItemsCtx): void {
	const { requests, slots } = c.vars.items;
	if (requests.size === 0 && [...slots.values()].every((slot) => slot.told)) return;
	void c.keepAwake(runQueue(c).catch((error) => c.log.error({ msg: "the turn queue could not be run", error: String(error) })));
}

/**
 * Why a session may not be deleted, when it is a work item's: the item owns it, and its steps would
 * find it gone. The item is cancelled instead, which leaves the agent and its timeline to be read.
 */
export function itemSessionRefusal(c: { vars: { items: ItemsState } }, session: SessionSummary): UserError | null {
	if (!session.item) return null;
	const item = c.vars.items.items.get(session.item.id);
	const name = item ? `“${item.title}”` : "a work item";
	return new UserError(`This agent works for ${name}. Cancel the item instead; the agent and what it did stay readable.`, { code: "item_session" });
}

// ---------------------------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------------------------

function tokenInput<T>(step: () => Promise<T>): Promise<T> {
	return step().catch((error) => {
		if (error instanceof ApiTokenProblem) throw new UserError(error.message, { code: error.code });
		throw error;
	});
}

/** The profile of the user an API token names, when the token is good for `scope` here. */
async function apiCaller(c: ItemsCtx, token: unknown, scope: ApiTokenScope): Promise<UserProfile> {
	const owner = tokenOwner(token);
	const profile = c.vars.profile;
	const refused = new UserError("That API token is not valid, or may not do this.", { code: "invalid_token" });
	// The access rules hold for a token as for a sign-in: someone taken off the list, or a demo user once the demo is off, is locked out at once.
	if (!owner || owner.uid !== c.key[0] || !profile || !mayUse(profile, config.access)) throw refused;
	if (!(await useApiToken(c.db, owner.digest, scope, Date.now()))) throw refused;
	return profile;
}

// ---------------------------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------------------------

/** The switch for work items (WLP_ITEMS), read by each of the person's actions on items and API tokens as the machines' are. */
function enabled(): void {
	if (!config.items) throw new UserError("Work items are not available on this platform.", { code: "items_off" });
}

export const itemActions = {
	listItems: (c: ItemsCtx): ItemSummary[] => {
		requireUser(c);
		enabled();
		return itemList(c.vars.items);
	},

	item: async (c: ItemsCtx, id: string): Promise<ItemView> => {
		requireUser(c);
		enabled();
		knownItem(c, id);
		try {
			return await itemView(c, id);
		} catch (error) {
			throw clientError(c.log, error, "The item could not be read. Try again.");
		}
	},

	createItem: async (c: ItemsCtx, input: CreateItemInput, makeSession: MakeSession): Promise<ItemSummary> => {
		const profile = requireUser(c);
		enabled();
		return fileItem(c, profile, input, "web", makeSession);
	},

	actOnItem: async (c: ItemsCtx, input: { id: string; action: ItemAction }): Promise<ItemView> => {
		const profile = requireUser(c);
		enabled();
		knownItem(c, input?.id);
		const view = await itemActor(c, profile.uid, input.id).internalAct({ action: input.action, by: `person:${profile.uid}` });
		await noteItem(c, view);
		return view;
	},

	// Answered with work items off too: the ceiling on running agents among these holds for a person's own agents as well.
	factoryLimits: (c: ItemsCtx): FactoryLimits => {
		requireUser(c);
		return config.factory;
	},

	apiTokens: async (c: ItemsCtx): Promise<ApiToken[]> => {
		requireUser(c);
		enabled();
		return await listApiTokens(c.db);
	},

	createApiToken: async (c: ItemsCtx, input: { name: string; scopes: ApiTokenScope[] }): Promise<{ token: ApiToken; secret: string }> => {
		const profile = requireUser(c);
		enabled();
		const made = await tokenInput(() => createApiToken(c.db, profile.uid, input, Date.now()));
		console.log(`[wlp] api_token.created uid=${profile.uid} token=${made.token.id} scopes=${made.token.scopes.join(",")}`);
		return made;
	},

	revokeApiToken: async (c: ItemsCtx, id: string): Promise<ApiToken[]> => {
		const profile = requireUser(c);
		enabled();
		await revokeApiToken(c.db, id);
		console.log(`[wlp] api_token.revoked uid=${profile.uid} token=${String(id).slice(0, 40)}`);
		return await listApiTokens(c.db);
	},

	// --- called by api-routes.ts, with the caller's API token -------------------------------------

	internalApiCreateItem: async (c: ItemsCtx, input: { token: string; item: CreateItemInput }, makeSession: MakeSession): Promise<ItemSummary> => {
		requireServiceFor(c, "api");
		return fileItem(c, await apiCaller(c, input?.token, "items:create"), input?.item, "api", makeSession);
	},

	internalApiItem: async (c: ItemsCtx, input: { token: string; id: string }): Promise<ItemView> => {
		requireServiceFor(c, "api");
		await apiCaller(c, input?.token, "items:read");
		knownItem(c, input?.id);
		return await itemView(c, input.id);
	},

	// --- called by `workItem` and by item sessions ------------------------------------------------

	internalItemChanged: async (c: ItemsCtx, summary: ItemSummary): Promise<void> => {
		requireService(c);
		if (typeof summary?.id !== "string") return;
		const before = c.vars.items.items.get(summary.id);
		await noteItem(c, summary);
		// An item that left review, or came to it, changes what the review cap holds back.
		if (before && (before.state === "review") !== (summary.state === "review")) queueChanged(c);
	},

	/** What an item reads of its user: the hosted sandbox seconds the ledger has for its session, and the user's open items. */
	internalItemFacts: (c: ItemsCtx, sessionId: string): ItemFacts => {
		requireService(c);
		const today = dayOf(Date.now());
		const entries = Array.from({ length: USAGE_HISTORY_DAYS }, (_, back) => c.vars.usage.entriesOn(today - back))
			.flat()
			.filter((entry) => entry.session === String(sessionId))
			.map((entry) => ({ hold: entry.hold, seconds: entry.seconds }));
		const openItems = [...c.vars.items.items.values()].filter((item) => item.state !== "done" && item.state !== "failed" && item.state !== "cancelled").length;
		return { entries, openItems };
	},

	/** An item session asks for a slot for the turn of `key`: granted now, or queued with a wait the item is told. Asked again, it answers the same. */
	internalRequestTurn: async (c: ItemsCtx, input: TurnRequest): Promise<TurnAnswer> => {
		requireService(c);
		const state = c.vars.items;
		const key = String(input?.key);
		const held = [...state.slots.values()].find((slot) => slot.key === key);
		if (held) {
			// Asked by its session: this answer tells it, so the grant need not be sent again.
			if (!held.told) {
				held.told = true;
				await c.db.execute("DELETE FROM turn_grant WHERE slot = ?", held.id);
			}
			return { granted: true, slot: held.id };
		}
		const session = c.vars.sessions.get(String(input?.sessionId));
		if (!session?.item || session.item.id !== input.itemId) return { granted: false };
		const now = Date.now();
		const known = state.requests.get(key);
		const full = typeof input.deploymentFull === "number" && input.deploymentFull > 0 ? input.deploymentFull : (known?.full ?? null);
		const request: Request = { key, session: session.id, item: input.itemId, title: String(input.title ?? ""), startsRun: input.startsRun === true, at: known?.at ?? now, attempt: known?.attempt ?? 0, full, deferUntil: input.deploymentFull ? now + FULL_FOR_MS : known?.deferUntil ?? null, wait: known?.wait ?? null };
		state.requests.set(key, request);
		await storeRequest(c.db, request);
		const mine = await runQueue(c, key);
		return mine ? { granted: true, slot: mine.id } : { granted: false };
	},

	/** The turn a slot was given to has ended, or could not start: the slot is free. Named by its id, so a release that comes twice frees nothing else. */
	internalTurnDone: async (c: ItemsCtx, input: TurnRelease): Promise<void> => {
		requireService(c);
		const slot = c.vars.items.slots.get(String(input?.slot));
		if (!slot || slot.session !== input.sessionId) return;
		const retry = input.machineWait;
		const request: Request | null = retry ? {
			key: slot.key, session: slot.session, item: slot.item, title: slot.title, startsRun: retry.startsRun,
			at: retry.at, attempt: 0, full: null, deferUntil: retryAt(retry.at, 0), wait: null,
		} : null;
		// Keep the slot until its durable release commits. An outbox retry after a failed write still finds it.
		const released = await c.db.transaction(async tx => {
			const rows = await tx.execute("DELETE FROM turn_slot WHERE id = ? RETURNING id", slot.id);
			if (!rows.length) return false;
			await tx.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
			if (request) await storeRequest(tx, request);
			return true;
		}, { name: "queue.release" });
		if (!released || !c.vars.items.slots.delete(slot.id)) return;
		if (request) c.vars.items.requests.set(request.key, request);
		await runQueue(c);
	},

	/** The item does not want the turn of `key` any more, before it started: its request goes. */
	internalWithdrawTurn: async (c: ItemsCtx, input: { sessionId: string; key: string }): Promise<void> => {
		requireService(c);
		const key = String(input?.key);
		const slot = [...c.vars.items.slots.values()].find(slot => slot.key === key && slot.session === input.sessionId);
		// The inbox confirmed this delivery was withdrawn before it started. Its attach can still hold a
		// slot, or its delayed release can already have put it back in the queue.
		await c.db.transaction(async tx => {
			await tx.execute("DELETE FROM turn_request WHERE key = ? AND session = ?", key, input.sessionId);
			if (slot) {
				await tx.execute("DELETE FROM turn_slot WHERE id = ?", slot.id);
				await tx.execute("DELETE FROM turn_grant WHERE slot = ?", slot.id);
			}
		}, { name: "queue.withdraw" });
		if (c.vars.items.requests.get(key)?.session === input.sessionId) c.vars.items.requests.delete(key);
		if (slot && c.vars.items.slots.delete(slot.id)) queueChanged(c);
	},

	// --- called by the actor's own schedule only ------------------------------------------------

	internalTurnQueue: async (c: ItemsCtx): Promise<void> => {
		const fire = c.scheduledFire;
		if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
		console.log(`[wlp] schedule.fired action=${QUEUE_ACTION} uid=${c.key[0]} waiting=${c.vars.items.requests.size} late_ms=${fire.firedAt - fire.scheduledAt}`);
		if (c.vars.items.queueAt?.id === fire.id) c.vars.items.queueAt = null;
		await runQueue(c, null, true);
	},
};
