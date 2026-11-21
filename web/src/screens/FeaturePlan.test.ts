// @vitest-environment jsdom
/**
 * Orchestrated work items against the mock: the Factory composer's Single · Orchestrate pill, and a
 * feature's page — its plan's questions, budgets checked as the server checks them, approval of the
 * version shown and a version that moved on meanwhile, the server's refusal on a repository without
 * checks, and the subtasks under a running feature.
 */
import type { AuthResult, CreateItemInput, ItemAction, ItemView } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient, type MockOptions } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { budgetProblems, subtaskFloor } from "../lib/feature";
import { machineDetailsProblem, tagsOf } from "../lib/machines";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;

const ada: AuthResult = { token: "mock:chatgpt:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } };

let host: HTMLElement;
let root: Root | null;
let client: MockClient;
let filed: CreateItemInput[];
/** Run before the page's own call of `actOnItem`, as another tab would act meanwhile. */
let meanwhile: ((id: string, action: ItemAction) => Promise<void>) | null;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = null;
	filed = [];
	meanwhile = null;
	sessionStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
});

async function settle(steps = 14): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2))));
}

function make(options: MockOptions): void {
	client = createMockClient({ pace: 0, origin: "http://localhost:5173", ...options });
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		return {
			...api,
			createItem: (input: CreateItemInput) => (filed.push(input), api.createItem(input)),
			actOnItem: async (id: string, action: ItemAction) => {
				const first = meanwhile;
				meanwhile = null;
				if (first) await first(id, action);
				return api.actOnItem(id, action);
			},
		};
	};
}

async function show(path: string): Promise<void> {
	history.replaceState(null, "", path);
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root?.render(createElement(AppProvider, { client, children: createElement(App) })));
	await settle();
}

const api = () => client.user(ada);
const field = () => host.querySelector(".start textarea") as HTMLTextAreaElement;
const pill = (name: string) => host.querySelector(`.start [data-picker="${name}"]`) as HTMLButtonElement | null;
const pop = () => document.querySelector(".ui-pop") as HTMLElement | null;
const button = (words: string | RegExp) => [...host.querySelectorAll("button")].find((candidate) => (typeof words === "string" ? candidate.textContent === words : words.test(candidate.textContent ?? ""))) as HTMLButtonElement | undefined;

function type(into: HTMLTextAreaElement | HTMLInputElement, text: string): void {
	act(() => {
		const proto = into instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(into, text);
		into.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function featureNamed(title: string): Promise<ItemView> {
	const found = (await api().listItems()).find((item) => item.title === title);
	if (!found) throw new Error(`no item “${title}”`);
	return api().item(found.id);
}

/** A subtask's budget field on the page, by its key and figure ("tokens", "turns", "working", "hosted"). */
function budgetField(task: string, short: string): HTMLInputElement {
	const row = [...host.querySelectorAll(".plan-task")].find((candidate) => candidate.querySelector(".plan-task-head > .plan-task-key")?.textContent === task) as HTMLElement;
	const label = [...row.querySelectorAll("label.plan-budget-label")].find((candidate) => candidate.textContent === short) as HTMLLabelElement;
	return row.querySelector(`#${CSS.escape(label.htmlFor)}`) as HTMLInputElement;
}

describe("the Factory composer's mode pill", () => {
	it("files Single by default, and Orchestrate once chosen from its menu, with the line that says what it is", async () => {
		make({});
		await show("/factory");
		expect(pill("item-mode")?.dataset.value).toBe("Single");
		type(field(), "Add the tide almanac export");
		await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		await settle();
		expect(filed).toHaveLength(1);
		expect(filed[0]?.mode).toBeUndefined();

		act(() => pill("item-mode")?.click());
		const rows = [...(pop()?.querySelectorAll('[role="menuitemradio"]') ?? [])] as HTMLElement[];
		expect(rows.map((row) => row.querySelector(".ui-item-label")?.textContent)).toEqual(["Single", "Orchestrate"]);
		expect(rows[1]?.textContent).toContain("For a new feature with several parts. A planner splits it into subtasks you approve.");
		expect(pop()?.textContent).toContain("Approving a plan needs saved checks and CI that reports on pushes. Without them, file it as single.");
		await act(async () => rows[1]?.click());
		expect(pill("item-mode")?.dataset.value).toBe("Orchestrate");

		type(field(), "Search the docs\nIndex the docs and add a search command.");
		await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		await settle();
		expect(filed[1]).toMatchObject({ title: "Search the docs", mode: "orchestrate" });
		expect(host.querySelector(".start-filed")?.textContent).toBe("Filed “Search the docs”: its plan comes to you for approval. Open");
	});

	it("is not offered for an agent", async () => {
		make({});
		await show("/factory");
		act(() => (host.querySelector('.start-kind input[value="agent"]') as HTMLInputElement).click());
		expect(pill("item-mode")).toBeNull();
	});
});

describe("a feature's plan on its page", () => {
	it("asks its questions first, saves the answer as the next version, and approves the version shown", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Search the docs from the command line");
		await show(`/items/${feature.id}`);
		expect(host.querySelector(".feature-plan .usage-count")?.textContent).toBe("v2 · proposed");
		expect([...host.querySelectorAll(".plan-task-title")].map((title) => title.textContent)).toEqual(["Build the search index at release", "Add the search command", "Document search in the README"]);
		expect(host.querySelector(".plan-task:nth-child(2) .plan-task-after")?.textContent).toBe("after 1 index");
		expect([...host.querySelectorAll(".plan-task:first-child .plan-path")].map((path) => path.textContent)).toEqual(["src/search/index/**", "scripts/release.ts"]);
		// Not approvable until the question is answered and saved.
		expect(button("Approve version 2")?.disabled).toBe(true);
		expect(host.querySelector(".plan-question .field-note")?.textContent).toBe("Answer the question and save first.");
		const option = [...host.querySelectorAll(".plan-ask-options input")].find((input) => (input as HTMLInputElement).value === "No, 2.0 and later") as HTMLInputElement;
		act(() => option.click());
		await act(async () => button("Save as version 3")?.click());
		await settle();
		expect(host.querySelector(".feature-plan .usage-count")?.textContent).toBe("v3 · proposed");
		expect(host.querySelector(".plan-ask-answer")?.textContent).toBe("No, 2.0 and later");
		const approve = button("Approve version 3") as HTMLButtonElement;
		expect(approve.disabled).toBe(false);
		await act(async () => approve.click());
		await settle();
		const after = await api().item(feature.id);
		expect(after.plan?.status).toBe("approved");
		expect(host.querySelector(".feature-plan .usage-count")?.textContent).toBe("v3 · approved");
		expect(host.querySelector(".plan-task:first-child .plan-task-title")?.tagName).toBe("A");
	});

	it("refreshes and says so when the plan moved on before the approval reached the server", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Search the docs from the command line");
		await show(`/items/${feature.id}`);
		act(() => ([...host.querySelectorAll(".plan-ask-options input")][1] as HTMLInputElement).click());
		await act(async () => button("Save as version 3")?.click());
		await settle();
		// Another tab changes a budget meanwhile: version 4, which the page has not read when it approves 3.
		meanwhile = async (id, action) => {
			if (action.kind !== "approve_plan") return;
			const view = await api().item(id);
			const plan = structuredClone(view.plan!);
			plan.subtasks[2]!.budget.turns = 3;
			await api().actOnItem(id, { kind: "edit_plan", version: view.plan!.version, plan });
		};
		await act(async () => button("Approve version 3")?.click());
		await settle();
		expect(host.querySelector(".plan-question .callout-warn")?.textContent).toBe("The plan changed while you read it, here or in another tab: version 4 is shown now. Check it, then approve again.");
		expect(host.querySelector(".feature-plan .usage-count")?.textContent).toBe("v4 · proposed");
		expect((await api().item(feature.id)).plan?.status).toBe("proposed");
		await act(async () => button("Approve version 4")?.click());
		await settle();
		expect((await api().item(feature.id)).plan?.status).toBe("approved");
		expect(host.querySelector(".plan-question")).toBeNull();
	});

	it("checks each budget against the floor and a single item's cap, and the total against what the subtasks share", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Search the docs from the command line");
		await show(`/items/${feature.id}`);
		const turns = budgetField("docs", "turns");
		type(turns, "1");
		expect(turns.getAttribute("aria-invalid")).toBe("true");
		expect(host.querySelector(`#${CSS.escape(turns.id)}-range`)?.textContent).toBe("2–14");
		expect(button("Save as version 3")?.disabled).toBe(true);
		type(turns, "3");
		expect(turns.getAttribute("aria-invalid")).toBeNull();
		expect(button("Save as version 3")?.disabled).toBe(false);
		// Over a single item's 6M tokens for one subtask.
		const tokens = budgetField("index", "tokens");
		type(tokens, "6.5");
		expect(tokens.getAttribute("aria-invalid")).toBe("true");
		// Each within the cap, but together over what the subtasks may share once the reserve is kept.
		type(tokens, "6");
		type(budgetField("command", "tokens"), "6");
		type(budgetField("docs", "tokens"), "6");
		expect(tokens.getAttribute("aria-invalid")).toBeNull();
		expect(host.querySelector(".plan-total-over dt")?.textContent).toBe("Tokens");
		expect(button("Save as version 3")?.disabled).toBe(true);
		// Discarding brings back the plan's own figures.
		act(() => button("Discard changes")?.click());
		expect(budgetField("index", "tokens").value).toBe("2.4");
		expect(host.querySelector(".plan-total-over")).toBeNull();
	});

	it("says the server's refusal on a repository without checks, and offers the feature as one item", async () => {
		make({});
		const made = await api().createItem({ repository: { id: 7102 }, title: "Tide charts", body: "Draw the week's tides.", mode: "orchestrate", start: true });
		await show(`/items/${made.id}`);
		await act(async () => button("Approve version 1")?.click());
		await settle();
		expect(host.querySelector(".plan-refused")?.textContent).toBe("Use a single item or add saved repository checks before approving orchestration. A single item needs neither.");
		await act(async () => button("Run as a single item")?.click());
		await settle();
		expect((await api().item(made.id)).mode).toBe("single");
	});

	it("lists a running feature's subtasks with their state and track, and a subtask's question in Needs you under the feature", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Export the release manifest as CSV");
		await show(`/items/${feature.id}`);
		const states = [...host.querySelectorAll(".plan-task")].map((row) => row.querySelector(".item-track-word, .plan-task-word")?.textContent);
		expect(states).toEqual(["done", "building", "not started"]);
		expect(host.querySelectorAll(".plan-task .item-track")).toHaveLength(2);
		expect(host.querySelector(".plan-budget")).toBeNull();
		act(() => root?.unmount());
		root = null;
		await show("/factory");
		const asking = [...host.querySelectorAll(".item-row")].find((row) => row.querySelector(".item-row-feature")?.textContent === "Dark theme for the release dashboard");
		expect(asking?.querySelector(".agent-title")?.textContent).toContain("Move the dashboard's colours to tokens");
		// A feature's plan question is its whole plan: the row says only that it waits.
		const plan = [...host.querySelectorAll(".item-row")].find((row) => row.querySelector(".agent-title")?.textContent?.startsWith("Search the docs from the command line"));
		expect(plan?.querySelector(".item-row-why")?.textContent).toBe("Its plan waits for your approval.");
	});
});

describe("the rules the page checks before sending", () => {
	const single = { tokens: 6_000_000, turns: 14, activeSeconds: 4 * 3600, hostedSeconds: 2 * 3600 };
	it("takes a subtask's floor as a tenth of a single item, two turns, at least 1,000 tokens and a minute", () => {
		expect(subtaskFloor(single)).toEqual({ tokens: 600_000, turns: 2, activeSeconds: 1440, hostedSeconds: 720 });
		expect(subtaskFloor({ tokens: 5000, turns: 3, activeSeconds: 100, hostedSeconds: 100 })).toEqual({ tokens: 1000, turns: 2, activeSeconds: 60, hostedSeconds: 60 });
		const pool = { tokens: 10_000_000, turns: 30, activeSeconds: 8 * 3600, hostedSeconds: 4 * 3600 };
		expect(budgetProblems(single, pool, { a: { ...single, turns: 1.5 } }).fields.a).toEqual({ turns: "bad" });
		expect(budgetProblems(single, pool, { a: single, b: single }).total).toEqual(["tokens"]);
		expect(budgetProblems(single, pool, { a: { ...single, tokens: 4e6 }, b: { ...single, tokens: 4e6 } }).any).toBe(false);
	});

	it("refuses machine details as the server does", () => {
		expect(tagsOf("gpu, big-build gpu")).toEqual(["gpu", "big-build"]);
		expect(machineDetailsProblem("Builds", ["gpu"])).toBeNull();
		expect(machineDetailsProblem("x".repeat(501), [])).toContain("at most 500");
		expect(machineDetailsProblem("", ["os"])).toContain("comes from the runner");
		expect(machineDetailsProblem("", ["-gpu"])).toContain("is not a tag");
		expect(machineDetailsProblem("", Array.from({ length: 13 }, (_, n) => `t${n}`))).toContain("at most 12 tags");
	});
});
