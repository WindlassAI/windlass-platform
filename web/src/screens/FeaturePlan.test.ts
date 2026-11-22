// @vitest-environment jsdom
/**
 * Orchestrated work items against the mock: the Factory composer's Plan first / Quick choice, and a
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
import { compact } from "../lib/format";
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

function make(options: MockOptions, page: (item: ItemView) => ItemView = item => item): void {
	client = createMockClient({ pace: 0, origin: "http://localhost:5173", ...options });
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		return {
			...api,
			item: async id => page(await api.item(id)),
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

describe("the Factory composer's mode choice", () => {
	const group = () => host.querySelector('[role="radiogroup"][aria-label="How it runs"]');
	const option = (mode: string) => group()?.querySelector<HTMLInputElement>(`input[value="${mode}"]`);
	async function file(title: string) {
		type(field(), title);
		await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		await settle();
	}

	it("files Plan first by default and Quick for one item", async () => {
		make({});
		await show("/factory");
		expect(group()?.textContent).toBe("Plan firstQuick");
		expect(document.getElementById(group()!.getAttribute("aria-describedby")!)?.textContent).toBe("Adds a planning turn you approve; may spend up to 3× a Quick item.");
		expect(option("orchestrate")?.checked).toBe(true);
		await file("Search the docs");
		expect(filed[0]).toMatchObject({ title: "Search the docs", mode: "orchestrate" });
		expect(host.querySelector(".start-filed")?.textContent).toContain("its plan comes to you for approval");
		act(() => option("single")!.click());
		expect(document.getElementById(group()!.getAttribute("aria-describedby")!)?.textContent).toBe("Starts one implementer at once, with no plan to approve.");
		await file("Fix the report title");
		expect(filed[1]).toMatchObject({ title: "Fix the report title", mode: "single" });
		expect(option("orchestrate")?.checked).toBe(true);
	});

	it("files Quick when the deployment disables planning", async () => {
		make({});
		const info = client.info.bind(client);
		client.info = async () => ({ ...await info(), items: { reviewer: true, orchestrate: false } });
		await show("/factory");
		expect(group()).toBeNull();
		await file("Add an export");
		expect(filed[0]?.mode).toBe("single");
	});

	it("offers the control only for work items", async () => {
		make({});
		await show("/factory");
		act(() => (host.querySelector('.start-kind input[value="agent"]') as HTMLInputElement).click());
		expect(group()).toBeNull();
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

	it("saves a single suggestion’s answers before approving one implementer", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Search the docs from the command line");
		const edited = await api().actOnItem(feature.id, { kind: "edit_plan", version: feature.plan!.version,
			plan: { ...feature.plan!, subtasks: [], singleSuggested: "One library change.", questions: [{ id: "db", text: "Which database?" }] } });
		await show(`/items/${feature.id}`);
		expect(host.querySelector(".plan-question")?.textContent).toContain("Which database?");
		expect(button("Approve for one implementer")?.disabled).toBe(true);
		type(host.querySelector(".plan-asks input")!, "SQLite");
		await act(async () => button("Save as version " + (edited.plan!.version + 1))?.click());
		await settle();
		expect(button("Approve for one implementer")?.disabled).toBe(false);
		await act(async () => button("Approve for one implementer")?.click());
		await settle();
		expect((await api().item(feature.id)).plan?.questions[0]?.answer).toBe("SQLite");
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
		expect(host.querySelector(".repo-head .eyebrow")?.textContent).toContain("Plan first · one implementer");
		expect(host.querySelector(".plan-total")).toBeNull();
	});

	it.each([
		{ state: "failed", canRetry: true, retry: true },
		{ state: "failed", canRetry: false, retry: false },
		{ state: "review", canRetry: false, retry: false },
	] as const)("honours retry eligibility ($canRetry) and hides Send back on a $state feature", async ({ state, canRetry, retry }) => {
		make({ items: "features" }, item => ({ ...item, state, canRetry }));
		const feature = await featureNamed("Export the release manifest as CSV");
		await show(`/items/${feature.id}`);
		expect(Boolean(button("Retry"))).toBe(retry);
		expect(button("Send back…")).toBeUndefined();
		expect(host.querySelector(".repo-head .eyebrow")?.textContent).toContain("Plan first");
	});

	it("hides handover on a subtask with an older stored CI question", async () => {
		make({ items: "features" }, item => item.parent && item.question ? {
			...item, question: { ...item.question, kind: "ci_timeout", choices: [
				{ id: "wait", label: "Keep waiting" }, { id: "hand_over", label: "Hand it over as it is" }, { id: "give_up", label: "Give up" },
			] },
		} : item);
		const child = (await api().listItems()).find(item => item.parent && item.question)!;
		await show(`/items/${child.id}`);
		expect(button("Keep waiting")).toBeDefined();
		expect(button("Hand it over as it is")).toBeUndefined();
	});

	it.each(["suggested", "approved", "superseded"] as const)("shows actual spend and the single-item cap for a %s plan with no subtasks", async stage => {
		const single = { tokens: 6_000_000, turns: 14, activeSeconds: 14_400, hostedSeconds: 7200 };
		const spent = { tokens: 2_900_000, turns: 5, activeSeconds: 3750, hostedSeconds: 3800 };
		make({ items: "features" }, item => ({
			...item, mode: stage === "suggested" ? "orchestrate" : "single", spent, question: null,
			budget: stage === "suggested" ? item.budget : { ...single, tokens: 8_000_000 },
			plan: { ...item.plan!, status: stage === "suggested" ? "proposed" : stage, subtasks: [], singleSuggested: "One change.", compare: { singleBudget: single } },
		}));
		const feature = await featureNamed("Search the docs from the command line");
		await show(`/items/${feature.id}`);
		const plan = host.querySelector(".feature-plan")!;
		expect(plan.textContent).toContain("Runs as one item after this plan");
		expect(plan.querySelector(".plan-card")).toBeNull();
		expect([...plan.querySelectorAll(".item-cost dt")].map(row => row.textContent)).toEqual(["Tokens", "Turns", "Working time"]);
		const cap = stage === "suggested" ? 8.9 : 8;
		expect([...plan.querySelectorAll(".item-cost .usage-number")].map(row => row.textContent)).toEqual([`2.9M of ${cap}M`, stage === "suggested" ? "5 of 19" : "5 of 14", stage === "suggested" ? "1 h 2 min of 5 h 2 min" : "1 h 2 min of 4 h"]);
		expect(parseFloat(plan.querySelector<HTMLElement>(".usage-meter-used")!.style.width)).toBeCloseTo(100 * 2.9 / cap);
	});

	it("lists a running feature's subtasks with their state and track, and a subtask's question in Needs you under the feature", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Export the release manifest as CSV");
		await show(`/items/${feature.id}`);
		const states = [...host.querySelectorAll(".plan-task")].map((row) => row.querySelector(".item-track-word, .plan-task-word")?.textContent);
		expect(states).toEqual(["done", "building", "not started"]);
		expect(host.querySelector(".plan-total-head")?.textContent).toBe("Allotted to subtasks");
		const tokens = feature.children!.reduce((used, child) => used + child.spent.tokens, 0);
		expect(host.querySelector(".plan-total-figures")?.textContent).toContain("Spent by subtasks: " + compact(tokens));
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

describe("a plan that was set aside", () => {
	it("is one line with its version, state and goal, that opens to the plan, its long spec parts folded after three lines", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Resume interrupted uploads");
		await show(`/items/${feature.id}`);
		const row = host.querySelector(".plan-set-aside-row") as HTMLButtonElement;
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(row.querySelector(".usage-count")?.textContent).toBe("v1 · superseded");
		expect(row.querySelector(".plan-set-aside-goal")?.textContent).toMatch(/^Resume an interrupted upload from the last confirmed chunk/);
		expect(host.querySelector(".plan-spec")).toBeNull();
		act(() => row.click());
		expect(host.querySelector(".plan-set-aside-note")?.textContent).toBe("Set aside: the work runs as one item, under its own budget.");
		const requirements = host.querySelector(".plan-spec-requirements") as HTMLElement;
		expect(requirements.querySelector("dt")?.textContent).toBe("Requirements6");
		expect(requirements.querySelectorAll("li")).toHaveLength(3);
		const more = requirements.querySelector(".plan-spec-more") as HTMLButtonElement;
		expect(more.textContent).toBe("Show 3 more");
		act(() => more.click());
		expect(requirements.querySelectorAll("li")).toHaveLength(6);
		expect(more.textContent).toBe("Show fewer");
		// Three lines are shown whole: nothing to fold.
		expect(host.querySelector(".plan-spec-acceptance .plan-spec-more")).toBeNull();
		expect(host.querySelector(".plan-spec-acceptance .plan-code")?.textContent).toBe("harbor upload");
		// Its subtasks never ran.
		expect(host.querySelector(".plan-card")).toBeNull();
		expect(host.querySelector(".feature-plan .item-cost")).not.toBeNull();
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

describe("placement in a feature's plan", () => {
	const row = (key: string) => [...host.querySelectorAll(".plan-task")].find((candidate) => candidate.querySelector(".plan-task-head > .plan-task-key")?.textContent === key) as HTMLElement;
	const fact = (key: string, term: string) => [...row(key).querySelectorAll(".plan-task-facts > div")].find((candidate) => candidate.querySelector("dt")?.textContent === term)?.querySelector("dd")?.textContent ?? null;
	const pill = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label) as HTMLButtonElement;
	/** The places of the approval card's row `n`, each with its secrets words. */
	const routePlaces = (n: number) => [...(host.querySelectorAll(".plan-question .plan-route")[n]?.querySelectorAll(".plan-route-places > li") ?? [])].map((place) => place.textContent!.replace(/\s+/g, " ").trim());
	const menuRow = (name: string) => [...document.querySelectorAll('[role="menuitemradio"]')].find((candidate) => candidate.textContent?.startsWith(name)) as HTMLElement;

	it("shows each subtask's place, needs and reason, and the server's reason for a place it refuses", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Visual regression checks for the tide chart");
		await show(`/items/${feature.id}`);
		expect(host.querySelector(".plan-placement")?.textContent).toContain("A subtask with no place runs where the feature does: nas.");
		expect(pill("Runs on: nas")).toBeTruthy();
		expect(fact("fixtures", "needs")).toBe("4 CPUs6 GiB memory");
		expect(fact("capture", "runs on")).toContain("The only machine that reports screenshots.");
		expect(pill("Alternatives: nas")).toBeTruthy();
		// Before approval, from the server's own check; "studio" is busy, which is a wait and not a refusal.
		expect(fact("compare", "can't place")).toBe("‘ci-box’: owner placement policy is never.");
		expect(fact("capture", "can't place")).toBeNull();
		expect(fact("capture", "if approved")).toBe("Waiting for 1 free slot on ‘studio’. 0 free now.");
		// A place no machine can ever take holds approval back, with the reason beside the button.
		const approve = button("Approve version 1")!;
		expect(approve.disabled).toBe(true);
		expect(document.getElementById(approve.getAttribute("aria-describedby")!)?.textContent).toBe("Compare captures against the baseline can't be placed: ‘ci-box’: owner placement policy is never. Choose another place below and save, or ask for a new plan.");
		// The server refuses in the same words, should an approval reach it from elsewhere; the busy "studio" is not among them.
		await expect(api().actOnItem(feature.id, { kind: "approve_plan", version: 1 })).rejects.toThrow(/^Compare captures against the baseline: ‘ci-box’: owner placement policy is never\.$/);
		expect((await api().item(feature.id)).plan?.status).toBe("proposed");
	});

	it("changes a place from the owner's machines, saves it as the next version, and places the first subtask on approval", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Visual regression checks for the tide chart");
		await show(`/items/${feature.id}`);
		act(() => pill("Runs on: ci-box").click());
		expect(menuRow("ci-box")?.getAttribute("aria-disabled")).toBe("true");
		act(() => menuRow("studio").click());
		await settle(2);
		expect(fact("compare", "can't place")).toBeNull();
		expect(fact("compare", "runs on")).toContain("Chosen in plan review.");
		// "studio" is busy: a wait, which approval allows.
		expect(fact("compare", "if approved")).toBe("Waiting for 1 free slot on ‘studio’. 0 free now.");
		await act(async () => button("Save as version 2")?.click());
		await settle();
		expect(button("Approve version 2")?.disabled).toBe(false);
		expect(host.querySelector(".plan-question .plan-blocked-place")).toBeNull();
		expect([...host.querySelectorAll(".plan-question .plan-route-wait")].map((line) => line.textContent)).toEqual(["If approved now: Waiting for 1 free slot on ‘studio’. 0 free now.", "If approved now: Waiting for 1 free slot on ‘studio’. 0 free now."]);
		const saved = await api().item(feature.id);
		expect(saved.plan?.subtasks[2]?.place).toEqual({ prefer: "studio", reason: "Chosen in plan review." });
		expect(saved.plan?.overflow).toBe(true);
		await act(async () => button("Approve version 2")?.click());
		await settle();
		const after = await api().item(feature.id);
		expect(after.plan?.status).toBe("approved");
		expect(after.children?.[0]?.placement).toMatchObject({ name: "nas", units: 2, reason: "Big builds, and both its slots are free." });
		expect(fact("fixtures", "runs on")).toBe("nas · 2 slots secrets sentBig builds, and both its slots are free.");
	});

	it("turns overflow off as a plan change, and says the alternatives are not used", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Visual regression checks for the tide chart");
		await show(`/items/${feature.id}`);
		const off = [...host.querySelectorAll(".plan-overflow input")][0] as HTMLInputElement;
		act(() => off.click());
		await act(async () => button("Save as version 2")?.click());
		await settle();
		expect((await api().item(feature.id)).plan?.overflow).toBe(false);
		expect(host.querySelector(".plan-routes-overflow")?.textContent).toBe("overflow off");
		expect(routePlaces(1)).toEqual(["studio secrets sent", "or nas not used: overflow off"]);
	});

	it("lists on the approval card where each subtask runs, why, its alternatives and whether secrets go there", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Visual regression checks for the tide chart");
		expect(feature.placementReview).toEqual([{ name: "nas", sendSecrets: true }, { name: "studio", sendSecrets: true }, { name: "ci-box", sendSecrets: false }]);
		await show(`/items/${feature.id}`);
		const card = host.querySelector(".plan-question .plan-routes") as HTMLElement;
		expect(card.querySelector(".plan-routes-overflow")?.textContent).toBe("overflow allowed");
		expect([...card.querySelectorAll(".plan-route-title")].map((title) => title.textContent)).toEqual(["Record the chart fixtures", "Capture the chart in both themes", "Compare captures against the baseline"]);
		expect([...card.querySelectorAll(".plan-route-why")].map((why) => why.textContent)).toEqual(["Big builds, and both its slots are free.", "The only machine that reports screenshots.", "Idle, with four slots free."]);
		expect(routePlaces(0)).toEqual(["nas secrets sent"]);
		expect(routePlaces(1)).toEqual(["studio secrets sent", "or nas secrets sent"]);
		expect(routePlaces(2)).toEqual(["ci-box no secrets"]);
		expect(card.querySelectorAll(".plan-route")[2]?.querySelector(".plan-route-problem")?.textContent).toBe("Can't be placed: ‘ci-box’: owner placement policy is never.");
	});

	it("follows a machine's secrets switch, and always sends them to this platform", async () => {
		make({ items: "features" });
		await api().setMachineSecrets({ machineId: "m_nas", send: false });
		const chart = await featureNamed("Visual regression checks for the tide chart");
		await show(`/items/${chart.id}`);
		expect(routePlaces(0)).toEqual(["nas no secrets"]);
		expect(routePlaces(1)).toEqual(["studio secrets sent", "or nas no secrets"]);
		act(() => root?.unmount());
		root = null;
		const search = await featureNamed("Search the docs from the command line");
		await show(`/items/${search.id}`);
		expect(routePlaces(0)).toEqual(["this platform the feature's secrets sent"]);
		expect(host.querySelector(".plan-question .plan-route-why")?.textContent).toBe("Names no place: it runs where the feature does.");
	});

	it("says where each subtask ran and why, and which machine the next one waits for", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Nightly tide table as a PDF");
		await show(`/items/${feature.id}`);
		expect(fact("query", "ran on")).toBe("nas secrets were sentSame place as the feature");
		expect(fact("render", "ran on")).toBe("nas secrets were sentApproved overflow from ‘studio’");
		expect(fact("proof", "waits")).toBe("Waiting for 2 free slots on ‘studio’. 0 free now.");
		expect(row("proof").querySelector(".plan-task-word")?.textContent).toBe("waits for a machine");
		expect(pill("Runs on: studio")).toBeUndefined();
	});
});

describe("a subtask the feature could not place", () => {
	const card = () => host.querySelector(".placement-question") as HTMLElement;
	const fact = (term: string) => [...card().querySelectorAll(".placement-question-facts > div")].find((candidate) => candidate.querySelector("dt")?.textContent === term)?.querySelector("dd")?.textContent ?? null;
	const menuRow = (name: string) => [...document.querySelectorAll('[role="menuitemradio"]')].find((candidate) => candidate.textContent?.startsWith(name)) as HTMLElement;

	it("says which subtask, why, and where it was approved, with the three answers", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Flood alerts by mail");
		await show(`/items/${feature.id}`);
		expect(card().querySelector(".item-question-text")?.textContent).toBe("“Send the alert mails” can't be placed");
		expect(fact("refused")).toBe("‘ci-box’: owner placement policy is never.");
		expect(fact("approved")).toBe("ci-box");
		expect([...card().querySelectorAll(".item-choices button")].map((one) => one.textContent)).toEqual(["Revise the placement…", "Retry allowed places", "Give up the subtask"]);
	});

	it("retries the approved places and asks again while the owner's policy still refuses", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Flood alerts by mail");
		await show(`/items/${feature.id}`);
		const asked = feature.question!.id;
		await act(async () => button("Retry allowed places")?.click());
		await settle();
		const after = await api().item(feature.id);
		expect(after.question?.kind).toBe("placement_refused");
		expect(after.question?.id).not.toBe(asked);
		expect(fact("refused")).toBe("‘ci-box’: owner placement policy is never.");
	});

	it("revises the placement with a place picked from the owner's machines, sent to the planner as the owner's note", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Flood alerts by mail");
		await show(`/items/${feature.id}`);
		act(() => button("Revise the placement…")!.click());
		const send = button("Ask for a revised plan")!;
		expect(send.disabled).toBe(false);
		const pill = [...card().querySelectorAll("button")].find((one) => one.getAttribute("aria-label")?.startsWith("Runs on:")) as HTMLButtonElement;
		expect(pill.getAttribute("aria-label")).toBe("Runs on: ci-box");
		act(() => pill.click());
		expect(menuRow("ci-box")?.getAttribute("aria-disabled")).toBe("true");
		act(() => menuRow("nas").click());
		await settle(2);
		expect(card().querySelector(".plan-place-problem dd")?.textContent).toBe("‘ci-box’: owner placement policy is never.");
		const sent: ItemAction[] = [];
		meanwhile = async (_id, action) => void sent.push(action);
		await act(async () => button("Ask for a revised plan")?.click());
		await settle();
		expect(sent[0]).toEqual({ kind: "answer", question: feature.question!.id, choice: "revise", note: "Run “Send the alert mails” on nas." });
		const after = await api().item(feature.id);
		expect(after.question?.kind).toBe("plan_approval");
		expect(after.plan?.version).toBe(2);
	});

	it("allows a revision to a busy place, and says what it would wait for", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Flood alerts by mail");
		await show(`/items/${feature.id}`);
		act(() => button("Revise the placement…")!.click());
		const pill = [...card().querySelectorAll("button")].find((one) => one.getAttribute("aria-label")?.startsWith("Runs on:")) as HTMLButtonElement;
		act(() => pill.click());
		// "studio" takes a subtask that names it; both its slots are busy, which is a wait and not a refusal.
		act(() => menuRow("studio").click());
		await settle(2);
		expect(button("Ask for a revised plan")?.disabled).toBe(false);
		expect([...card().querySelectorAll(".plan-place-ahead dd")].map((one) => one.textContent)).toEqual(["Waiting for 1 free slot on ‘studio’. 0 free now."]);
	});

	it("gives up the subtask", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Flood alerts by mail");
		await show(`/items/${feature.id}`);
		await act(async () => button("Give up the subtask")?.click());
		await settle();
		const after = await api().item(feature.id);
		expect(after.question?.kind).not.toBe("placement_refused");
		expect(after.events.some((event) => event.said.includes("Cancelled “Send the alert mails”."))).toBe(true);
	});
});

describe("one implementer suggested with the planner's questions open", () => {
	it("shows the questions and approves only once both are answered and saved", async () => {
		make({ items: "features" });
		const feature = await featureNamed("Round tide heights to centimetres");
		await show(`/items/${feature.id}`);
		const card = host.querySelector(".plan-question") as HTMLElement;
		expect(card.querySelector(".item-question-text")?.textContent).toContain("One function and its callers in a single change");
		expect([...card.querySelectorAll(".plan-ask-text")].map((one) => one.textContent)).toEqual(["Round half up, or half to even?", "Should the CSV export round too, or keep the raw millimetres?"]);
		const approve = button("Approve for one implementer")!;
		expect(approve.disabled).toBe(true);
		expect(document.getElementById(approve.getAttribute("aria-describedby")!)?.textContent).toBe("Answer the 2 questions and save first.");
		act(() => (card.querySelector('.plan-ask-options input[value="Half to even"]') as HTMLInputElement).click());
		type(card.querySelector(".plan-asks input:not([type])") as HTMLInputElement, "Keep the raw millimetres.");
		await act(async () => button("Save as version 2")?.click());
		await settle();
		expect(button("Approve for one implementer")?.disabled).toBe(false);
		await act(async () => button("Approve for one implementer")?.click());
		await settle();
		const after = await api().item(feature.id);
		expect(after.mode).toBe("single");
		expect(after.plan?.questions.map((one) => one.answer)).toEqual(["Half to even", "Keep the raw millimetres."]);
	});
});

describe("a machine's placement policy", () => {
	it("is chosen in its details, saved at once, and named on its card when it is not the default", async () => {
		make({ items: "features" });
		await show("/machines");
		const cards = () => [...host.querySelectorAll(".machine-row")] as HTMLElement[];
		const card = (name: string) => cards().find((candidate) => candidate.querySelector(".usage-kept-title")?.textContent === name)!;
		expect(card("nas").querySelector(".machine-policy-note")).toBeNull();
		expect(card("studio").querySelector(".machine-policy-note")?.textContent).toBe("features: when named");
		expect(card("ci-box").querySelector(".machine-policy-note")?.textContent).toBe("features: never");
		const group = card("nas").querySelector('[role="radiogroup"]') as HTMLElement;
		expect(group.textContent).toBe("Any featureWhen namedNever");
		expect(card("nas").querySelector(".machine-policy .field-note")?.textContent).toBe("Features may place subtasks here.");
		await act(async () => (group.querySelector('input[value="never"]') as HTMLInputElement).click());
		await settle();
		expect((await api().machines()).find((machine) => machine.name === "nas")).toMatchObject({ orchestrator: "never", whenToUse: "Build and test", tags: ["big-build"] });
		expect(card("nas").querySelector(".machine-policy-note")?.textContent).toBe("features: never");
		expect(card("nas").querySelector(".machine-policy .field-note")?.textContent).toBe("Features never place subtasks here.");
	});
});

describe("a turn's token counts", () => {
	it("are folded behind a toggle at the end of the outcome line", async () => {
		// jsdom lays nothing out: the timeline's scrolling is a no-op here.
		Element.prototype.scrollTo ??= function () {} as Element["scrollTo"];
		make({});
		await show("/agents/add-test");
		await settle(30);
		const end = host.querySelector(".turn-end") as HTMLElement;
		const toggle = end.querySelector(".turn-end-fold") as HTMLButtonElement;
		expect(toggle.textContent).toBe("tokens");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.title).toMatch(/^[\d,]+ in · [\d,]+ cached \(\d+%\) · [\d,]+ out$/);
		expect(end.textContent).not.toContain(" cached (");
		act(() => toggle.click());
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		const line = document.getElementById(toggle.getAttribute("aria-controls")!);
		expect(line?.textContent).toMatch(/in.*cached.*out/);
		act(() => toggle.click());
		expect(end.textContent).not.toContain(" cached (");
	});
});
