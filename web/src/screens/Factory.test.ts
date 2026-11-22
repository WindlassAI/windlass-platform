// @vitest-environment jsdom
/**
 * The Factory page against the mock: its address and the bar's "Agents · Factory" with the count of
 * what asks, its groups and filters, filing a work item from it without leaving, the first visit, and
 * a deployment without the second review.
 */
import { ITEM_PAGE_DEFAULT, type AuthResult, type CreateItemInput, type ItemListPage, type ItemSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient, type MockOptions } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { parseRoute } from "../lib/router";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The whole app renders here: beside the other files on a busy machine, its first render can take longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
// jsdom has no media queries: the theme reads one, and a wide screen matches none of the app's.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;

const ada: AuthResult = { token: "mock:chatgpt:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } };

let host: HTMLElement;
let root: Root | null;
let client: MockClient;
/** What was filed, in order. */
let filed: CreateItemInput[];
/** The pages of items asked for, in order. */
let paged: ItemListPage[];

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = null;
	filed = [];
	paged = [];
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

/** Signs in to a mock set up by `options` and shows the app at `path`. */
async function show(path: string, options: MockOptions = {}): Promise<void> {
	history.replaceState(null, "", path);
	client = createMockClient({ pace: 0, origin: "http://localhost:5173", ...options });
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		return { ...api, createItem: (input: CreateItemInput) => (filed.push(input), api.createItem(input)), listItems: (page?: ItemListPage) => (page && paged.push(page), api.listItems(page)) };
	};
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root?.render(createElement(AppProvider, { client, children: createElement(App) })));
	await settle();
}

/** The user's items as the mock has them. */
const listed = (): Promise<ItemSummary[]> => client.user(ada).listItems();

const tabs = () => host.querySelector('nav[aria-label="Main"]') as HTMLElement | null;
const tab = (name: string) => [...(tabs()?.querySelectorAll("a") ?? [])].find((link) => link.textContent?.startsWith(name)) as HTMLAnchorElement | undefined;
/** The groups shown, in order, with the titles of their rows; the ended ones only once unfolded. */
const groups = () =>
	[...host.querySelectorAll(".factory-group")]
		.filter((group) => !group.closest("[hidden]"))
		.map((group) => ({ name: group.querySelector(".agent-group-name")?.textContent ?? "", titles: [...group.querySelectorAll(".agent-title")].map((title) => title.firstChild?.textContent ?? "") }));
const rows = () => [...host.querySelectorAll(".factory-group .item-row")].filter((row) => !row.closest("[hidden]")) as HTMLElement[];
const field = () => host.querySelector(".start textarea") as HTMLTextAreaElement;
/** The start composer's pill of a picker, by its name ("repo", "where", "agent", "mode", "criteria"). */
const pill = (name: string) => host.querySelector(`.start [data-picker="${name}"]`) as HTMLButtonElement | null;
/** The open picker, drawn at the end of the page. */
const pop = () => document.querySelector(".ui-pop") as HTMLElement | null;
const button = (words: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === words) as HTMLButtonElement;

function write(text: string, into: HTMLTextAreaElement = field()): void {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(into, text);
		into.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Opens a filter's menu ("repo", "from") and chooses one of its choices, by its words. */
async function filter(label: string, choice: string): Promise<void> {
	act(() => (host.querySelector(`.factory-filters [data-picker="${label === "repo" ? "repository" : label}"]`) as HTMLButtonElement).click());
	const option = [...(pop()?.querySelectorAll('[role="menuitemradio"]') ?? [])].find((candidate) => candidate.querySelector(".ui-item-label")?.textContent === choice) as HTMLElement;
	await act(async () => option.click());
	await settle(4);
}

describe("the Factory page's address and the bar's tabs", () => {
	it("is at /factory, with Agents · Factory in the bar and the count of the items that ask", async () => {
		await show("/factory");
		const asking = (await listed()).filter((item) => item.question !== null).length;
		expect(asking).toBeGreaterThan(0);
		expect(host.querySelector("h1")?.textContent).toBe("Factory");
		expect(tab("Agents")?.getAttribute("href")).toBe("/");
		expect(tab("Factory")?.getAttribute("aria-current")).toBe("page");
		expect(tab("Factory")?.textContent).toBe(`Factory · ${asking} need you`);
		expect(document.title).toBe(`(${asking}) Factory · Windlass`);
		// To Home by its tab, where the count stays.
		await act(async () => tab("Agents")?.click());
		await settle();
		expect(location.pathname).toBe("/");
		expect(tab("Agents")?.getAttribute("aria-current")).toBe("page");
		expect(tab("Factory")?.textContent).toBe(`Factory · ${asking} need you`);
	});

	it("says no count when nothing asks", async () => {
		await show("/factory", { items: "none" });
		expect(tab("Factory")?.textContent).toBe("Factory");
	});

	it("is not found, and has no tab, where the deployment offers no work items", async () => {
		await show("/factory", { items: "off" });
		expect(host.textContent).toContain("Nothing at this address");
		expect(tab("Factory")).toBeUndefined();
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show("/", { items: "off" });
		expect(host.querySelector("h1")?.textContent).toBe("Agents");
		expect(tab("Factory")).toBeUndefined();
	});

	it("reads its filters from the address, and writes them back", () => {
		expect(parseRoute("/factory", "?repository=7101&from=github")).toEqual({ name: "factory", repository: 7101, from: "github" });
		expect(parseRoute("/factory", "?repository=x&from=email")).toEqual({ name: "factory" });
		expect(parseRoute("/factory/")).toEqual({ name: "factory" });
	});
});

describe("the Factory page's groups and filters", () => {
	it("groups every item across repositories by what its person must do, the ended ones folded", async () => {
		await show("/factory");
		const all = await listed();
		const names = (items: ItemSummary[]) => items.map((item) => item.title).sort();
		const shown = groups();
		expect(shown.map((group) => group.name)).toEqual(["Needs you", "Ready for you", "In progress", "Drafts"]);
		const of = (name: string) => (shown.find((group) => group.name === name)?.titles ?? []).slice().sort();
		const asking = all.filter((item) => item.question !== null);
		expect(of("Needs you")).toEqual(names(asking));
		const rest = all.filter((item) => item.question === null);
		expect(of("Ready for you")).toEqual(names(rest.filter((item) => item.state === "review")));
		expect(of("In progress")).toEqual(names(rest.filter((item) => ["working", "queued", "waiting"].includes(item.state))));
		expect(of("Drafts")).toEqual(names(rest.filter((item) => item.state === "draft")));
		// Needs you: the longest waiting first, with the question.
		const first = asking.sort((a, b) => (a.question?.askedAt ?? 0) - (b.question?.askedAt ?? 0))[0] as ItemSummary;
		expect(shown[0]?.titles[0]).toBe(first.title);
		expect(rows()[0]?.textContent).toContain(first.question?.text);
		// More than one repository is listed, each row says which.
		expect(new Set(all.map((item) => item.repository.name)).size).toBeGreaterThan(1);
		// The ended ones, folded until asked for.
		const ended = rest.filter((item) => ["done", "failed", "cancelled"].includes(item.state));
		expect(ended.length).toBeGreaterThan(0);
		act(() => button(`Show ${ended.length} ended items`).click());
		await settle();
		expect(groups().at(-1)).toMatchObject({ name: "Ended" });
		expect((groups().at(-1)?.titles ?? []).slice().sort()).toEqual(names(ended));
	});

	it("reads the ended ones from the server a page at a time, and starts again under a filter", async () => {
		await show("/factory", { items: "many" });
		const all = await listed();
		const ended = all.filter((item) => item.question === null && ["done", "failed", "cancelled"].includes(item.state));
		expect(ended.length).toBeGreaterThan(2 * ITEM_PAGE_DEFAULT);
		// Nothing is asked of the server until they are unfolded.
		expect(paged).toEqual([]);
		act(() => button(`Show ${ended.length} ended items`).click());
		await settle();
		const endedRows = () => groups().find((group) => group.name === "Ended")?.titles ?? [];
		const byFiling = ended.slice().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
		expect(endedRows()).toEqual(byFiling.slice(0, ITEM_PAGE_DEFAULT).map((item) => item.title));
		expect(paged).toEqual([{ ended: true, before: null, limit: ITEM_PAGE_DEFAULT, repository: null, source: null }]);
		expect(host.textContent).toContain(`${ITEM_PAGE_DEFAULT} of ${ended.length} work items`);
		// The next page starts after the last row shown.
		act(() => button(`Show ${ITEM_PAGE_DEFAULT} more`).click());
		await settle();
		expect(endedRows()).toEqual(byFiling.slice(0, 2 * ITEM_PAGE_DEFAULT).map((item) => item.title));
		const last = byFiling[ITEM_PAGE_DEFAULT - 1] as ItemSummary;
		expect(paged[1]).toMatchObject({ ended: true, before: { createdAt: last.createdAt, id: last.id } });
		// Under a filter, the server is asked for that repository's from the first page.
		await filter("repo", "acme/harbor");
		const harbor = byFiling.filter((item) => item.repository.id === 7101);
		expect(paged.at(-1)).toMatchObject({ ended: true, before: null, repository: 7101 });
		expect(endedRows()).toEqual(harbor.slice(0, ITEM_PAGE_DEFAULT).map((item) => item.title));
		// Read to the end: no more to show.
		for (let page = 0; page < 5 && host.textContent?.includes(`Show ${ITEM_PAGE_DEFAULT} more`); page++) {
			act(() => button(`Show ${ITEM_PAGE_DEFAULT} more`).click());
			await settle();
		}
		expect(endedRows()).toEqual(harbor.map((item) => item.title));
		expect(host.textContent).not.toContain(`Show ${ITEM_PAGE_DEFAULT} more`);
	});

	it("shows a row's verdict, CI, second review, pull request and issue", async () => {
		await show("/factory");
		const ready = (await listed()).find((item) => item.state === "review" && item.review?.state === "filed" && item.verdict?.ci === "passed" && item.pullRequest);
		expect(ready).toBeDefined();
		const row = rows().find((candidate) => candidate.querySelector(".agent-title")?.firstChild?.textContent === ready?.title) as HTMLElement;
		expect(row.querySelector(".item-verdict")).not.toBeNull();
		expect(row.textContent).toContain("CI passed");
		expect(row.querySelector(".item-row-review")?.textContent).toMatch(/^reviewed: /);
		expect(row.querySelector(`a[href="${ready?.pullRequest?.url}"]`)).not.toBeNull();
		const fromIssue = (await listed()).find((item) => item.origin !== null) as ItemSummary;
		const issueRow = rows().find((candidate) => candidate.querySelector(".agent-title")?.firstChild?.textContent === fromIssue.title) as HTMLElement;
		expect(issueRow.querySelector(`a[href="${fromIssue.origin?.issue.url}"]`)?.textContent).toBe(`issue #${fromIssue.origin?.issue.number}`);
	});

	it("filters by repository and by where an item came from, in the address", async () => {
		await show("/factory");
		const all = await listed();
		await filter("repo", "acme/harbor");
		expect(location.pathname).toBe("/factory");
		expect(new URLSearchParams(location.search).get("repository")).toBe("7101");
		const harbor = all.filter((item) => item.repository.id === 7101 && item.question === null && item.state !== "done" && item.state !== "failed" && item.state !== "cancelled").length + all.filter((item) => item.repository.id === 7101 && item.question !== null).length;
		expect(rows().length).toBe(harbor);
		expect(rows().every((row) => row.querySelector(".agent-repo")?.textContent === "acme/harbor")).toBe(true);
		await filter("from", "GitHub issue");
		expect(new URLSearchParams(location.search).get("from")).toBe("github");
		expect(rows().length).toBeGreaterThan(0);
		expect(rows().every((row) => row.textContent?.includes("issue #"))).toBe(true);
		await filter("from", "API");
		const api = all.filter((item) => item.repository.id === 7101 && item.source === "api" && !["done", "failed", "cancelled"].includes(item.state));
		expect(rows().length).toBe(api.length);
		await filter("repo", "all");
		await filter("from", "all");
		expect(location.search).toBe("");
		expect(groups().map((group) => group.name)).toContain("Needs you");
	});

	it("opens filtered from a link, and says when nothing matches", async () => {
		await show("/factory?repository=7101&from=web");
		expect(rows().length).toBeGreaterThan(0);
		expect(rows().every((row) => row.querySelector(".agent-repo")?.textContent === "acme/harbor" && !row.textContent?.includes("issue #") && !row.textContent?.includes("from the API"))).toBe(true);
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show("/factory?repository=999");
		expect(host.textContent).toContain("No work item matches.");
		await act(async () => button("Show them all").click());
		await settle(4);
		expect(location.search).toBe("");
		expect(rows().length).toBeGreaterThan(0);
	});
});

describe("filing a work item from the Factory page", () => {
	it("files it with the composer on Work item, started, and stays: the row comes in through the live list", async () => {
		await show("/factory");
		const before = (await listed()).length;
		expect(host.querySelector(".start-kind .segment-chosen")?.textContent).toBe("Work item");
		write("Add the tests command to the README\nSay how to run the unit tests, with its command.");
		expect(host.querySelector(".start-title")?.textContent).toBe("Title: Add the tests command to the README");
		// Its acceptance criteria, one a line, in their own chip.
		act(() => (pill("criteria") as HTMLButtonElement).click());
		write("The README names the unit test command.\n\nIt says where the tests live.", pop()?.querySelector("textarea") as HTMLTextAreaElement);
		await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		await settle();
		expect(filed).toHaveLength(1);
		expect(filed[0]).toMatchObject({ title: "Add the tests command to the README", body: "Say how to run the unit tests, with its command.", acceptance: ["The README names the unit test command.", "It says where the tests live."], start: true, repository: { branch: "main" } });
		expect(filed[0]?.idempotencyKey).toBeTruthy();
		expect(location.pathname).toBe("/factory");
		expect(field().value).toBe("");
		expect(host.querySelector(".start-filed")?.textContent).toBe("Filed “Add the tests command to the README”: its plan comes to you for approval. Open");
		expect((await listed()).length).toBe(before + 1);
		expect(groups().find((group) => group.name === "Needs you")?.titles).toContain("Add the tests command to the README");
	});

	it("files a draft from the line under it, into Drafts", async () => {
		await show("/factory");
		write("Rename the tide table columns again");
		act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
		await act(async () => ([...(pop()?.querySelectorAll('[role="menuitem"]') ?? [])].find((row) => row.querySelector(".ui-item-label")?.textContent === "File as a draft") as HTMLElement).click());
		await settle();
		expect(filed[0]).toMatchObject({ title: "Rename the tide table columns again", body: "", start: false });
		expect(groups().find((group) => group.name === "Drafts")?.titles).toContain("Rename the tide table columns again");
		expect(host.querySelector(".start-filed")?.textContent).toBe("Filed “Rename the tide table columns again” as a draft. Open");
	});

	it("files nothing without a repository, and says so", async () => {
		await show("/factory", { items: "none", github: false });
		write("Add a health check");
		await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		await settle();
		expect(filed).toHaveLength(0);
		expect(host.querySelector(".start-status")?.textContent).toBe("A work item needs a repository: choose one under “repo”.");
	});

	it("switches to an agent and back, from the same composer", async () => {
		await show("/factory");
		const agent = host.querySelector('.start-kind input[value="agent"]') as HTMLInputElement;
		act(() => agent.click());
		act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
		expect(pop()?.textContent).toContain("Create without a prompt");
		act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
		expect(pill("agent")).not.toBeNull();
		expect(pill("criteria")).toBeNull();
		act(() => (host.querySelector('.start-kind input[value="item"]') as HTMLInputElement).click());
		expect(pill("criteria")).not.toBeNull();
		// A work item chooses its agent and model too; it starts on Windlass.
		expect(pill("agent")?.getAttribute("data-value")).toMatch(/^Windlass · /);
	});
});

describe("the screenshots of a work item's repository", () => {
	it("are said in the repository's picker once one is chosen, with the way to its setting", async () => {
		await show("/factory", { items: "none", github: false });
		act(() => (pill("repo") as HTMLButtonElement).click());
		expect(pop()).not.toBeNull();
		expect(document.querySelector(".start-shots")).toBeNull();
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show("/factory");
		act(() => (pill("repo") as HTMLButtonElement).click());
		await settle();
		const note = document.querySelector(".start-shots") as HTMLElement;
		expect(note.textContent).toBe("Screenshots are off for this repository: turn them on.");
		expect(note.querySelector("a")?.getAttribute("href")).toMatch(/^\/repositories\/[0-9]+\/settings#screenshots$/);
	});
});

describe("the Factory page's first visit", () => {
	it("says what the factory does in three sentences under the composer, the GitHub label among them", async () => {
		await show("/factory", { items: "none" });
		const empty = host.querySelector(".factory-empty") as HTMLElement;
		expect(empty.querySelector("h2")?.textContent).toBe("No work items yet");
		const text = empty.querySelector("p")?.textContent ?? "";
		expect(text.split(/(?<=\.)\s+/)).toHaveLength(3);
		expect(text).toContain("labelling a GitHub issue windlass");
		expect(empty.querySelector("code")?.textContent).toBe("windlass");
		expect(host.querySelector(".start textarea")).not.toBeNull();
		expect(host.querySelector(".factory-filters")).toBeNull();
	});
});

describe("a deployment without the second review", () => {
	it("says so once under the heading, and no row has a word of it", async () => {
		await show("/factory", { reviewer: false });
		expect(host.querySelector(".factory-reviewer-off")?.textContent).toBe("No second review on this deployment: the verdict rests on CI and your checks.");
		act(() => button(`Show ${host.querySelector(".factory-fold button")?.textContent?.replace(/^Show /, "")}`)?.click());
		expect(rows().length).toBeGreaterThan(0);
		expect(host.querySelectorAll(".item-row-review")).toHaveLength(0);
		expect(host.textContent).not.toMatch(/reviewed: |being reviewed|waiting for its reviewer/);
	});

	it("says it before any item exists", async () => {
		await show("/factory", { reviewer: false, items: "none" });
		expect(host.querySelector(".factory-reviewer-off")).not.toBeNull();
	});

	it("says nothing of it where the reviewer is on, and the rows keep its word", async () => {
		await show("/factory");
		expect(host.querySelector(".factory-reviewer-off")).toBeNull();
		expect(host.querySelectorAll(".item-row-review").length).toBeGreaterThan(0);
	});
});
