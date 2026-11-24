/**
 * Check of the live items feed (server/src/item-pages.ts `itemFeed`, and the `user` actor's `itemFeed`,
 * `listItems` and its broadcasts in server/src/actors/user-items.ts): the feed carries every open item
 * and the newest filed ended ones, with counts beside them, and `listItems` without a page still answers
 * with every item. Nothing here runs an engine, a sandbox or GitHub: the actor's actions run on an
 * in-memory database. Run with:
 *
 *   cd server && npx tsx ../scripts/item-feed-check.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ItemFeed, ItemSummary } from "../server/src/contract.js";

const scratch = mkdtempSync(join(tmpdir(), "wlp-item-feed-check-"));
// Set before the server's modules are loaded: they read their configuration when they are.
process.env.WLP_SECRET = `check-secret-${randomBytes(16).toString("hex")}`;
process.env.RIVETKIT_STORAGE_PATH = join(scratch, "storage");
mkdirSync(process.env.RIVETKIT_STORAGE_PATH, { recursive: true });

const { ITEM_FEED_ENDED } = await import("../server/src/contract.js");
const { itemFeed, listedItems, openChildren } = await import("../server/src/item-pages.js");
const { config } = await import("../server/src/config.js");
const { ITEM_TABLES, itemActions, loadItems } = await import("../server/src/actors/user-items.js");
const { serviceParams } = await import("../server/src/auth.js");
const { issueUserToken } = await import("../server/src/tokens.js");
type ItemsCtx = import("../server/src/actors/user-items.js").ItemsCtx;

let failed = 0;
async function check(title: string, test: () => unknown) {
	try {
		await test();
		console.log("PASS", title);
	} catch (error) {
		console.error("FAIL", title, error);
		failed++;
	}
}

const repo = (id: number, name: string) => ({ provider: "github" as const, id, owner: "acme", name, branch: "main", private: false });
const HARBOR = repo(7101, "harbor");
const TIDES = repo(7102, "tide-tables");
const T0 = 1_800_000_000_000;

/** An item filed `n` minutes after T0, on a repository, standing as `state` says. */
function item(n: number, state: ItemSummary["state"], repository = n % 2 === 0 ? HARBOR : TIDES, extra: Partial<ItemSummary> = {}): ItemSummary {
	const createdAt = T0 + n * 60_000;
	return {
		id: `i_${String(n).padStart(4, "0")}`,
		title: `Item ${n}`,
		repository,
		place: { kind: "hosted" },
		source: n % 3 === 0 ? "api" : "web",
		mode: "single",
		parent: null,
		origin: null,
		state,
		wait: null,
		question: null,
		pullRequest: null,
		verdict: null,
		review: null,
		budget: { tokens: 1, hostedSeconds: 1 },
		spent: { tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 },
		sessionId: `s_${n}`,
		createdAt,
		updatedAt: createdAt,
		revision: 1,
		...extra,
	} as ItemSummary;
}

const ENDED_STATES = ["done", "failed", "cancelled"] as const;
const question = { id: "q1", kind: "budget", text: "Go on?", askedAt: T0 } as unknown as ItemSummary["question"];
const parent = { itemId: "i_0001", key: "a", title: "Item 1" };
/** 3 open items, 60 ended ones over two repositories (filed among them), a feature child that asks and one that does not. */
function seed(): ItemSummary[] {
	const open = [item(1, "working"), item(30, "review"), item(75, "draft")];
	const ended = Array.from({ length: 60 }, (_, index) => item(index < 28 ? index + 2 : index + 12, ENDED_STATES[index % 3]!));
	const asking = item(80, "waiting", HARBOR, { id: "i_child_asks", parent, question });
	const quiet = item(81, "working", HARBOR, { id: "i_child_quiet", parent });
	return [...open, ...ended, asking, quiet];
}

const ids = (list: readonly ItemSummary[]) => list.map((one) => one.id);
const byFilingDesc = (list: readonly ItemSummary[]) => [...list].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

await check("the pure feed: open items, the 25 newest filed ended ones, the counts", () => {
	const all = seed();
	const feed = itemFeed(listedItems(all));
	// Three open items and the child that asks; the quiet child is nowhere.
	assert.deepEqual(ids(feed.open).sort(), ["i_0001", "i_0030", "i_0075", "i_child_asks"].sort());
	assert.equal(feed.open.find((one) => one.id === "i_child_asks")?.title, "Item 1 — Item 80");
	assert.ok(![...feed.open, ...feed.ended].some((one) => one.id === "i_child_quiet"));
	assert.deepEqual(ids(feed.open), ids(byFilingDesc(feed.open)));
	const ended = byFilingDesc(all.filter((one) => (ENDED_STATES as readonly string[]).includes(one.state)));
	assert.equal(ITEM_FEED_ENDED, 25);
	assert.equal(feed.ended.length, 25);
	assert.deepEqual(ids(feed.ended), ids(ended.slice(0, 25)));
	assert.equal(feed.counts.ended, 60);
	const sum = (pick: (row: ItemFeed["counts"]["byRepository"][number]) => number, repository?: number) => feed.counts.byRepository.filter((row) => repository === undefined || row.repository === repository).reduce((total, row) => total + pick(row), 0);
	assert.equal(sum((row) => row.done + row.failed + row.cancelled), 60);
	assert.equal(sum((row) => row.open), 4);
	for (const repository of [HARBOR, TIDES]) {
		const on = listedItems(all).filter((one) => one.repository.id === repository.id);
		assert.equal(sum((row) => row.open + row.done + row.failed + row.cancelled, repository.id), on.length);
		for (const state of ENDED_STATES) assert.equal(sum((row) => row[state], repository.id), on.filter((one) => one.state === state).length);
	}
	// One row for each repository and way of filing, named as its newest item there.
	assert.equal(new Set(feed.counts.byRepository.map((row) => `${row.repository}|${row.source}`)).size, feed.counts.byRepository.length);
	assert.ok(feed.counts.byRepository.every((row) => row.owner === "acme" && (row.name === "harbor" || row.name === "tide-tables")));
});

await check("the feed carries every open subtask under its own title, asking or not, and no ended one", () => {
	const all = [...seed(), item(82, "done", HARBOR, { id: "i_child_done", parent })];
	const feed = itemFeed(listedItems(all), all);
	assert.deepEqual(ids(feed.children ?? []), ["i_child_quiet", "i_child_asks"]);
	assert.equal(feed.children?.find((one) => one.id === "i_child_asks")?.title, "Item 80");
	assert.deepEqual(ids(openChildren(all)), ids(feed.children ?? []));
	// Without the items held, as before: no children.
	assert.equal(itemFeed(listedItems(all)).children, undefined);
});

// The actor's actions, on an in-memory database.
config.items = true;
const sql = new DatabaseSync(":memory:");
ITEM_TABLES.forEach((q) => sql.exec(q));
type Query = { execute<T>(q: string, ...args: SQLInputValue[]): Promise<T[]> };
const db = {
	async execute<T>(q: string, ...args: SQLInputValue[]) {
		return sql.prepare(q).all(...args) as T[];
	},
	async transaction<T>(fn: (tx: Query) => Promise<T>): Promise<T> {
		return fn(db);
	},
};
const state = await loadItems(db as never);
for (const one of seed()) {
	state.items.set(one.id, one);
	sql.prepare("INSERT INTO items (id, created_at, summary) VALUES (?, ?, ?)").run(one.id, one.createdAt, JSON.stringify(one));
}
const uid = "u_feed";
const sent: Array<{ name: string; body: unknown }> = [];
const c = {
	vars: { tokenGen: 0, items: state, sessions: new Map(), profile: { uid, email: null, demo: false } },
	db,
	key: [uid],
	conn: { params: { token: issueUserToken({ uid, email: null, demo: false }, 0) } },
	schedule: { at: async () => "alarm", cancel: async () => true },
	keepAwake: <T>(work: Promise<T>) => work,
	broadcast(name: string, body: unknown) {
		sent.push({ name, body });
	},
	log: { warn() {}, error() {}, info() {} },
} as unknown as ItemsCtx;

await check("the actor's itemFeed is the pure feed of its items", () => {
	const feed = itemActions.itemFeed(c);
	assert.equal(feed.open.length, 4);
	assert.equal(feed.ended.length, 25);
	assert.equal(feed.counts.ended, 60);
});

await check("listItems without a page still answers with every listed item", () => {
	const list = itemActions.listItems(c);
	assert.equal(list.length, 64); // 3 open, 60 ended, the child that asks
	assert.equal(list.filter((one) => one.id !== "i_child_asks").length, 63);
	assert.equal(itemActions.listItems(c, { ended: true, limit: 100 }).length, 60);
	// `ended: false` keeps the open ones only: it listed cancelled items as open before.
	const open = itemActions.listItems(c, { ended: false, limit: 100 });
	assert.deepEqual(open.map((one) => one.id).sort(), list.filter((one) => !["done", "failed", "cancelled"].includes(one.state)).map((one) => one.id).sort());
	assert.equal(open.length, 4);
	assert.equal(itemActions.listItems(c, { limit: 100 }).length, 64, "left out, both");
});

await check("an item that ends: the next broadcast counts it, and carries it where it is among the newest filed", async () => {
	const users = c.conn!.params;
	(c.conn as { params: unknown }).params = serviceParams();
	try {
		// The newest open item ends: it is filed after every ended one, so it leads `ended`.
		const newest = state.items.get("i_0075")!;
		await itemActions.internalItemChanged(c, { ...newest, state: "done", revision: 2, updatedAt: T0 + 999 * 60_000 });
		let last = sent.at(-1)!;
		assert.equal(last.name, "items");
		let feed = last.body as ItemFeed;
		assert.equal(feed.counts.ended, 61);
		assert.equal(feed.ended[0]?.id, "i_0075");
		assert.equal(feed.ended.length, 25);
		assert.ok(!feed.open.some((one) => one.id === "i_0075"));
		// The oldest open item ends: counted at once, but older than the 25 newest filed, so not carried.
		const oldest = state.items.get("i_0001")!;
		await itemActions.internalItemChanged(c, { ...oldest, state: "failed", revision: 2, updatedAt: T0 + 1000 * 60_000 });
		last = sent.at(-1)!;
		feed = last.body as ItemFeed;
		assert.equal(feed.counts.ended, 62);
		assert.ok(![...feed.open, ...feed.ended].some((one) => one.id === "i_0001"));
		assert.equal(feed.ended.length, 25);
	} finally {
		(c.conn as { params: unknown }).params = users;
	}
});

await check("a subtask's step is kept in the index and its change goes out in the feed's children", async () => {
	const users = c.conn!.params;
	(c.conn as { params: unknown }).params = serviceParams();
	try {
		const quiet = state.items.get("i_child_quiet")!;
		const step = { kind: "gate" as const, startedAt: T0 + 5, turn: null, rounds: { plan: 0, gate: 1, ci: 0, conflict: 0, review: 0 } };
		await itemActions.internalItemChanged(c, { ...quiet, step, revision: quiet.revision + 1 });
		assert.deepEqual(state.items.get("i_child_quiet")?.step, step);
		const feed = sent.at(-1)!.body as ItemFeed;
		const carried = feed.children?.find((one) => one.id === "i_child_quiet");
		assert.equal(carried?.revision, quiet.revision + 1);
		assert.deepEqual(carried?.step, step);
		assert.ok(!feed.open.some((one) => one.id === "i_child_quiet"), "a quiet subtask stays out of the list");
	} finally {
		(c.conn as { params: unknown }).params = users;
	}
	assert.deepEqual(itemActions.itemFeed(c).children?.map((one) => one.id).sort(), ["i_child_asks", "i_child_quiet"]);
});

if (failed > 0) {
	console.error(`${failed} failed`);
	process.exit(1);
}
console.log("item feed check passed");
