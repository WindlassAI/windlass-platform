// @vitest-environment jsdom
/**
 * A feature's subtasks as they run (lib/subtasks.ts, Subtasks.tsx), read from the mock's long state
 * (`items: "features"`, `long`): six subtasks, one merged, two running, one asking, two not started.
 * The tally counts them; each row says what its subtask is doing from its step, where it runs, what it
 * spent and links its session; the asking one shows its question and Answer. A subtask's strip says
 * which of six it is with its neighbours; the Factory row lists only the active ones; and a page holding
 * a feature's subtasks knows when the feed's open subtasks are newer than it.
 */
import type { ItemSummary, ItemView, PlanSubtask } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { childrenBehind, doingNow, doneKeys, elapsed, groupSubtasks, PARALLEL_SUBTASKS, plannedSubtasks, sharesPaths, tallyLine, tallyOf, type DispatchedSubtask } from "../lib/subtasks";
import { progressCount } from "./Factory";
import { questionLine } from "./Items";
import { doneWords, FactorySubtasks, partOf, showsSubtasks, SubtasksBlock, SubtaskStrip } from "./Subtasks";

const auth = { token: "mock:user:u_subtasks:ada@example.com", profile: { uid: "u_subtasks", email: "ada@example.com", demo: false } };

let feature: ItemView;
let children: ItemSummary[];
let short: ItemView;
let parallel: ItemView;
let alongside: ItemView;

beforeAll(async () => {
	const mock = createMockClient({ pace: 0, items: "features", long: true });
	const user = mock.user(auth);
	const list = await user.listItems();
	const exporting = list.find((item) => item.title === "Export the release manifest as CSV")!;
	feature = await user.item(exporting.id);
	children = (await user.itemFeed()).children ?? [];
	mock.dispose();
	const plain = createMockClient({ pace: 0, items: "features" });
	const plainUser = plain.user(auth);
	const plainList = await plainUser.listItems();
	short = await plainUser.item(plainList.find((item) => item.title === "Export the release manifest as CSV")!.id);
	parallel = await plainUser.item(plainList.find((item) => item.title === "Import a station file in one pass")!.id);
	alongside = await plainUser.item(parallel.subtasks!.find((job) => job.key === "units")!.id);
	plain.dispose();
});

const NOW = () => Date.now();

describe("the subtasks of a running feature", () => {
	it("counts them, in plan order", () => {
		const subtasks = plannedSubtasks(feature.plan!, feature.children ?? []);
		expect(subtasks.map((entry) => entry.state)).toEqual(["done", "running", "running", "asks", "to_go", "to_go"]);
		expect(tallyLine(tallyOf(subtasks))).toBe("2 running · 1 asks you · 1 of 6 done");
	});

	it("says what each one is doing from its step, not a sentence", () => {
		const subtasks = plannedSubtasks(feature.plan!, feature.children ?? []);
		const titles = new Map(subtasks.map((entry) => [entry.task.key, entry.task.title]));
		const done = doneKeys(subtasks);
		const doing = subtasks.map((entry) => doingNow(entry, titles, done, NOW()));
		expect(doing[0]!.word).toBe("merged");
		expect(doing[1]!.word).toBe("implementing");
		expect(doing[1]!.fact).toBe("turn 2");
		expect(doing[2]).toMatchObject({ word: "fixing", fact: "your checks failed, fix 1", code: "pnpm test src/golden" });
		expect(doing[3]!.word).toBe("asks you");
		expect(doing[4]).toEqual({ word: "waits", fact: `After “${subtasks[1]!.task.title}”` });
		expect(doing[5]).toEqual({ word: "waits", fact: `After “${subtasks[2]!.task.title}” and “${subtasks[3]!.task.title}”` });
	});

	it("draws a row for each, with its place, session and the question it asks, the done ones folded", () => {
		expect(showsSubtasks(feature)).toBe(true);
		const html = renderToStaticMarkup(createElement(SubtasksBlock, { plan: feature.plan!, children: feature.children ?? [], now: NOW() }));
		// Three running and two up next; the merged one is behind "Show".
		expect(html.match(/class="subtask-run /g)).toHaveLength(5);
		expect(html).toContain("Running now");
		expect(html).toContain("3 of 3");
		expect(html).toContain("1 integrated");
		expect(html).toContain(">studio<");
		expect(html).toContain("Session of Wire --csv into the manifest command");
		expect(html).toContain("The release runner gives a step 64 MiB");
		expect(html).toContain(">Answer<");
		expect(html).toContain("3 suggested answers");
		// Not the brief, its paths or its checks: those are on the subtask's page and in the plan.
		expect(html).not.toContain("Hand-off:");
		expect(html).not.toContain("test/fixtures/manifest-2.4.0.json");
	});

	it("works the same with one subtask running", () => {
		const subtasks = plannedSubtasks(short.plan!, short.children ?? []);
		expect(tallyLine(tallyOf(subtasks))).toBe("1 running · 1 of 3 done");
		const html = renderToStaticMarkup(createElement(SubtasksBlock, { plan: short.plan!, children: short.children ?? [], now: NOW() }));
		// Its two running rows: the plan's part and the factory's repair of the feature's CI.
		expect(html.match(/class="subtask-run /g)).toHaveLength(3);
		expect(html).toContain("<strong>1</strong> of 3 integrated");
	});
});

describe("moving between subtasks", () => {
	it("a subtask's strip has a chip a sibling and names the ones running alongside it", () => {
		expect(partOf(feature.plan!, "stream")).toEqual({ n: 4, of: 6 });
		const html = renderToStaticMarkup(createElement(SubtaskStrip, { plan: feature.plan!, children: feature.children ?? [], current: "stream" }));
		expect(html.match(/class="subtask-chip /g)).toHaveLength(6);
		expect(html).toContain('aria-current="page"');
		expect(html).toContain("Running alongside");
		expect(html).toContain("Wire --csv into the manifest command");
		expect(html).toContain("Add a golden-file test for 2.4.0");
		// Not itself, and not one that is done.
		expect(html).not.toMatch(/Running alongside.*Stream rows/);
		expect(html).not.toMatch(/Running alongside.*Add the CSV writer/);
	});

	it("the Factory row counts the open subtasks and lists only the active ones", () => {
		expect(children.filter((child) => child.parent?.itemId === feature.id)).toHaveLength(3);
		const html = renderToStaticMarkup(createElement(FactorySubtasks, { feature, children, now: NOW() }));
		expect(html).toContain("<strong>2</strong> running");
		expect(html).toContain("<strong>1</strong> asks you");
		expect(html.match(/class="factory-subtask factory-subtask-/g)).toHaveLength(3);
		expect(html).toContain("implementing · nas");
		expect(html).toContain("asks you · studio");
		expect(progressCount([feature], children)).toBe("1 work item · 2 subtasks running");
	});

	it("an asking subtask's line in a list is the start of its question", () => {
		const asking = children.find((child) => child.question)!;
		expect(questionLine(asking)).toMatch(/^The release runner gives a step 64 MiB/);
	});
});

describe("live updates from the feed's open subtasks", () => {
	const kid = (id: string, revision: number, state: ItemSummary["state"] = "working") => ({ id, revision, state, parent: { itemId: "f", key: id, title: "F" } }) as ItemSummary;
	it("a newer revision, a subtask that ended, or one made since: the page is behind", () => {
		const shown = [kid("a", 2), kid("b", 1)];
		expect(childrenBehind("f", shown, [kid("a", 2), kid("b", 1)])).toBe(false);
		expect(childrenBehind("f", shown, [kid("a", 3), kid("b", 1)])).toBe(true);
		expect(childrenBehind("f", shown, [kid("a", 2)])).toBe(true);
		expect(childrenBehind("f", shown, [kid("a", 2), kid("b", 1), kid("c", 1)])).toBe(true);
		// One the page already holds as ended is not looked for.
		expect(childrenBehind("f", [kid("a", 2), kid("b", 4, "done")], [kid("a", 2)])).toBe(false);
		// Another feature's subtasks are not this page's.
		expect(childrenBehind("f", shown, [kid("a", 2), kid("b", 1), { ...kid("x", 9), parent: { itemId: "g", key: "x", title: "G" } }])).toBe(false);
		// A server before the feed carried subtasks says nothing.
		expect(childrenBehind("f", shown, undefined)).toBe(false);
	});

	it("the mock's feed carries each open subtask with its step", () => {
		const golden = children.find((child) => child.parent?.key === "golden")!;
		expect(golden.step).toMatchObject({ kind: "implement", rounds: { gate: 1 } });
		expect(children.some((child) => child.state === "done")).toBe(false);
	});
});

describe("subtasks in parallel, grouped", () => {
	const keys = (lines: readonly { entry: { task: { key: string } } }[]) => lines.map((line) => line.entry.task.key);

	it("the mock's feature: two running, one waiting on another's files, one on its dependencies, one integrated", () => {
		const groups = groupSubtasks(parallel.plan!, parallel.children ?? [], parallel.subtasks);
		expect(keys(groups.running)).toEqual(["units", "cache"]);
		expect(groups.running.map((line) => [line.word, line.place])).toEqual([["running", "hosted"], ["checks", "studio"]]);
		expect(groups.running[0]!.since).toBe(parallel.subtasks!.find((job) => job.key === "units")!.startedAt);
		expect(keys(groups.next)).toEqual(["command", "docs"]);
		expect(groups.next[0]).toMatchObject({ phase: "files", files: { path: "src/import/index.ts" } });
		expect(groups.next[0]!.files!.owner.task.key).toBe("cache");
		expect(groups.next[1]!.phase).toBe("after");
		expect(groups.next[1]!.after!.map((entry) => entry.task.key)).toEqual(["units", "command"]);
		expect(keys(groups.done)).toEqual(["parser"]);
		expect(doneWords(groups.done)).toBe("1 integrated");
	});

	it("a repair the factory filed itself runs with the parts, but the integrated count stays the plan's", () => {
		const done = (parallel.children ?? []).find((child) => child.parent?.key === "parser")!;
		const repair = { ...done, id: "it_repair", title: "Fix failing feature checks", state: "working" as const, createdAt: done.createdAt + 1, parent: { ...done.parent!, key: "ci-fix-9" } };
		const groups = groupSubtasks(parallel.plan!, [...(parallel.children ?? []), repair], parallel.subtasks);
		expect(keys(groups.running)).toContain("ci-fix-9");
		const html = renderToStaticMarkup(createElement(SubtasksBlock, { plan: parallel.plan!, children: [...(parallel.children ?? []), repair], jobs: parallel.subtasks, now: Date.now() }));
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text).toContain("Fix failing feature checks");
		expect(text).toContain(`1 of ${parallel.plan!.subtasks.length} integrated`);
		// It says why it is there and what it fixes, and is not numbered as a part of the plan.
		expect(text.replace(/&#x27;/g, "'")).toContain("fix Fix failing feature checks Added by the factory: the feature's CI failed after its parts were integrated.");
		const ended = groupSubtasks(parallel.plan!, [...(parallel.children ?? []), { ...repair, state: "done" as const }], parallel.subtasks);
		expect(doneWords(ended.done)).toBe("1 integrated · 1 repair integrated");
	});

	it("says what the feature waits for on the next subtask, rather than that it is starting", () => {
		const wait = { reason: "machine" as const, sentence: "Waiting for two free slots on studio.", since: 0, retryAt: null };
		const plan = { subtasks: [{ ...parallel.plan!.subtasks[0]!, key: "solo", dependsOn: [], owns: ["solo/**"] }] };
		expect(groupSubtasks(plan, [], [], wait).next[0]).toMatchObject({ word: "waiting for a place", fact: "Waiting for two free slots on studio." });
		expect(groupSubtasks(plan, [], [], null).next[0]).toMatchObject({ word: "starting", fact: null });
	});

	it("draws Running now (2 of 3), Up next with what holds each, and Done folded", () => {
		const now = parallel.subtasks!.find((job) => job.key === "units")!.startedAt! + 19 * 60_000;
		const html = renderToStaticMarkup(createElement(SubtasksBlock, { plan: parallel.plan!, children: parallel.children ?? [], jobs: parallel.subtasks, now }));
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text).toContain("Running now 2 of 3");
		expect(text).toContain("Up next 2");
		expect(text).toContain("waits for src/import/index.ts , owned by 3 Cache parsed stations by checksum");
		expect(text).toContain("waits for 2 Convert units on import and 4 Add the import command");
		expect(text).toContain("Done 1 integrated");
		expect(text).toContain("hosted 19m Session");
		// Done is folded: the integrated one has no row until it is shown.
		expect(html.match(/class="subtask-run /g)).toHaveLength(4);
		expect(html).not.toContain("Parse the station file in one pass");
		expect(html.indexOf("Running now")).toBeLessThan(html.indexOf("Up next"));
	});

	it("a subtask's page says which part it is and what runs alongside it", () => {
		const feature = parallel;
		expect(partOf(feature.plan!, alongside.parent!.key)).toEqual({ n: 2, of: 5 });
		const html = renderToStaticMarkup(createElement(SubtaskStrip, { plan: feature.plan!, children: feature.children ?? [], jobs: feature.subtasks, current: "units" }));
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		expect(text).toContain("Running alongside: 3 Cache parsed stations by checksum");
		expect(text).not.toContain("Convert units on import");
	});

	const task = (key: string, dependsOn: string[] = [], owns: string[] = [`src/${key}/**`]): PlanSubtask => ({ key, title: key, brief: "", acceptance: [], dependsOn, owns, budget: { tokens: 1 } });
	const job = (key: string, state: ItemSummary["state"], wait: string | null = null): DispatchedSubtask => ({ id: `it_${key}`, key, state, dispatchedAt: 1_000, startedAt: wait ? null : 2_000, wait });
	const child = (key: string, state: ItemSummary["state"], step?: Partial<NonNullable<ItemSummary["step"]>>): ItemSummary =>
		({ id: `it_${key}`, title: key, state, question: null, wait: null, createdAt: 500, place: { kind: "hosted" }, spent: { tokens: 0, turns: 1 }, parent: { itemId: "f", key, title: "F" }, ...(step && { step: { kind: "implement", startedAt: 0, turn: null, rounds: { plan: 0, gate: 0, ci: 0, conflict: 0 }, ...step } }) }) as unknown as ItemSummary;

	it("a full set of slots holds the next one; a job waiting for a place holds a slot and says why", () => {
		const plan = { subtasks: [task("a"), task("b"), task("c"), task("d")] };
		const groups = groupSubtasks(plan, [child("a", "working"), child("b", "working", { kind: "subtasks" })], [job("a", "working"), job("b", "working"), job("c", "draft", "Waiting for a slot on ‘nas’: both are taken.")]);
		expect(groups.running.map((line) => [line.entry.task.key, line.phase, line.word])).toEqual([
			["a", "running", "running"],
			["b", "integrating", "integrating"],
			["c", "place", "waiting for a place"],
		]);
		expect(groups.running[2]!.fact).toBe("Waiting for a slot on ‘nas’: both are taken.");
		expect(groups.running).toHaveLength(PARALLEL_SUBTASKS);
		expect(groups.next.map((line) => [line.entry.task.key, line.phase])).toEqual([["d", "slot"]]);
	});

	it("reads each step as its word, and ended ones as done", () => {
		const plan = { subtasks: [task("a"), task("b"), task("c"), task("d"), task("e")] };
		const groups = groupSubtasks(plan, [child("a", "working", { kind: "conflict" }), child("b", "waiting", { kind: "ci" }), child("c", "working", { kind: "implement", rounds: { plan: 0, gate: 1, ci: 0, conflict: 0 } }), child("d", "failed"), child("e", "cancelled")], undefined);
		expect(groups.running.map((line) => line.word)).toEqual(["conflict", "CI", "fixing"]);
		expect(groups.running[2]!.fact).toBe("checks failed, fix 1");
		expect(groups.done.map((line) => line.phase)).toEqual(["failed", "cancelled"]);
		expect(doneWords(groups.done)).toBe("1 failed · 1 cancelled");
	});

	it("a subtask that lists no files waits for any running one, as the server reads it", () => {
		const plan = { subtasks: [task("a"), task("b", [], [])] };
		const groups = groupSubtasks(plan, [child("a", "working")], undefined);
		expect(groups.next[0]).toMatchObject({ phase: "files", files: { path: null } });
	});

	it("owned paths overlap as the server's globs do", () => {
		expect(sharesPaths({ owns: ["src/import"] }, { owns: ["src/import/index.ts"] })).toBe(true);
		expect(sharesPaths({ owns: ["src/**/index.ts"] }, { owns: ["src/import/index.ts"] })).toBe(true);
		expect(sharesPaths({ owns: ["src/a/*.ts"] }, { owns: ["src/b/x.ts"] })).toBe(false);
		expect(sharesPaths({ owns: ["src/import/parse/**"] }, { owns: ["src/import/units/**"] })).toBe(false);
		expect(sharesPaths({ owns: ["src/x"], repo: "web" }, { owns: ["src/x"], repo: "api" })).toBe(false);
	});

	it("says how long one has run to the minute", () => {
		expect(elapsed(30_000)).toBe("<1m");
		expect(elapsed(19 * 60_000 + 59_000)).toBe("19m");
		expect(elapsed(65 * 60_000)).toBe("1h 05m");
	});
});
