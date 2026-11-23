// @vitest-environment jsdom
/**
 * A feature's subtasks as they run (lib/subtasks.ts, Subtasks.tsx), read from the mock's long state
 * (`items: "features"`, `long`): six subtasks, one merged, two running, one asking, two not started.
 * The tally counts them; each row says what its subtask is doing from its step, where it runs, what it
 * spent and links its session; the asking one shows its question and Answer. A subtask's strip says
 * which of six it is with its neighbours; the Factory row lists only the active ones; and a page holding
 * a feature's subtasks knows when the feed's open subtasks are newer than it.
 */
import type { ItemSummary, ItemView } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { childrenBehind, doingNow, doneKeys, plannedSubtasks, siblingsOf, tallyLine, tallyOf } from "../lib/subtasks";
import { progressCount } from "./Factory";
import { questionLine } from "./Items";
import { FactorySubtasks, showsSubtasks, SubtasksBlock, SubtaskStrip } from "./Subtasks";

const auth = { token: "mock:chatgpt:u_subtasks:ada@example.com", profile: { uid: "u_subtasks", email: "ada@example.com", demo: false } };

let feature: ItemView;
let children: ItemSummary[];
let short: ItemView;

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
	short = await plainUser.item((await plainUser.listItems()).find((item) => item.title === "Export the release manifest as CSV")!.id);
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
		const numbers = new Map(subtasks.map((entry) => [entry.task.key, entry.n]));
		const done = doneKeys(subtasks);
		const doing = subtasks.map((entry) => doingNow(entry, numbers, done, NOW()));
		expect(doing[0]!.word).toBe("merged");
		expect(doing[1]!.word).toBe("implementing");
		expect(doing[1]!.fact).toMatch(/^turn 2 of 5/);
		expect(doing[2]).toMatchObject({ word: "fixing", fact: "your checks failed, fix 1 of 2", code: "pnpm test src/golden" });
		expect(doing[3]!.word).toBe("asks you");
		expect(doing[4]).toEqual({ word: "waits", fact: "after 2" });
		expect(doing[5]).toEqual({ word: "waits", fact: "after 3 and 4" });
	});

	it("draws a row for each, with its place, spend, session and the question it asks", () => {
		expect(showsSubtasks(feature)).toBe(true);
		const html = renderToStaticMarkup(createElement(SubtasksBlock, { plan: feature.plan!, children: feature.children ?? [], now: NOW() }));
		expect(html.match(/class="subtask-run /g)).toHaveLength(6);
		expect(html).toContain("overflow from nas");
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
		expect(html.match(/class="subtask-run /g)).toHaveLength(3);
	});
});

describe("moving between subtasks", () => {
	it("a subtask's strip says which of six it is, with its neighbours", () => {
		const around = siblingsOf(plannedSubtasks(feature.plan!, feature.children ?? []), "stream")!;
		expect(around.at.n).toBe(4);
		expect(around.previous?.task.key).toBe("golden");
		expect(around.next?.task.key).toBe("docs");
		const html = renderToStaticMarkup(createElement(SubtaskStrip, { plan: feature.plan!, children: feature.children ?? [], current: "stream" }));
		expect(html).toContain("Subtask 4 of 6");
		expect(html.match(/class="subtask-chip /g)).toHaveLength(6);
		expect(html).toContain('aria-current="page"');
		// A sibling not started has no page to go to.
		expect(html).toMatch(/<span class="subtask-strip-next tone-faint"/);
		expect(html).toMatch(/<a class="link subtask-strip-previous"/);
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
		expect(golden.step).toMatchObject({ kind: "implement", rounds: { gate: 1 }, caps: { gate: 2 } });
		expect(children.some((child) => child.state === "done")).toBe(false);
	});
});
