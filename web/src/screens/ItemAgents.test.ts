// @vitest-environment jsdom
/**
 * A work item's agent session is part of its item: the lists of agents on the home page and on a
 * repository's page leave it out, and it is reached from the item's row and page. The mock gives each
 * item its own session, marked as the item's, as the server does (mock.items.test.ts).
 */
import type { AuthResult, ItemSummary, SessionSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { Home } from "./Home";
import { Item, useItem } from "./Item";
import { Repository, useRepository } from "./Repository";
import { Usage } from "./Usage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
let sessions: SessionSummary[];
let items: ItemSummary[];

async function wait(steps = 8): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
}

/** Signs in to the mock and renders `screen` in the app's context, once the lists are known. */
async function render(screen: () => ReturnType<typeof createElement>): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173" });
	const begun = client.login.start();
	await vi.advanceTimersByTimeAsync(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	await vi.advanceTimersByTimeAsync(1000);
	const auth: AuthResult = await finished;
	saveAuth("mock", auth);
	const listed = Promise.all([client.user(auth).listSessions(), client.user(auth).listItems()]);
	await vi.advanceTimersByTimeAsync(1000);
	[sessions, items] = await listed;
	function Screen() {
		return screen();
	}
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Screen) })));
	await wait();
}

const linksTo = (scope: ParentNode, path: string) => [...scope.querySelectorAll("a")].filter((link) => link.getAttribute("href") === path);
const itemSessions = () => sessions.filter((session) => session.item !== undefined);

beforeEach(() => {
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	vi.useRealTimers();
});

describe("a work item's agent session", () => {
	it("is not among the home page's agents, nor in its count of agents, and a repository's heading counts its work items", async () => {
		await render(() => createElement(Home));
		expect(itemSessions().length).toBeGreaterThan(0);
		const lists = [...host.querySelectorAll("ul.agents[aria-label^='Your agents']")];
		expect(lists.length).toBeGreaterThan(0);
		for (const list of lists) for (const session of itemSessions()) expect(linksTo(list, `/agents/${session.id}`)).toEqual([]);
		const own = sessions.filter((session) => session.item === undefined);
		const rows = lists.reduce((sum, list) => sum + list.querySelectorAll("li.agent-row").length, 0);
		expect(rows).toBeLessThanOrEqual(own.length);
		expect(host.querySelector(".home-head .eyebrow")?.textContent).toMatch(new RegExp(`^${own.length} agents · \\d+ of 6 working, \\d+ of them work items`));
		// acme/lighthouse-docs has one agent of the user's own and some work items (a repository with only items keeps its heading: lib/repositories.test.ts).
		const docs = [...host.querySelectorAll(".agent-group-head")].find((head) => head.textContent?.includes("lighthouse-docs"));
		expect(docs?.querySelector("a")?.getAttribute("href")).toBe("/repositories/7103");
		const onDocs = itemSessions().filter((session) => session.repository?.id === 7103).length;
		expect(docs?.querySelector(".agent-group-count")?.textContent).toBe(`1 agent · ${onDocs} work items`);
	});

	it("is not among a repository's agents, and is reached from its item's row", async () => {
		await render(() => createElement(Repository, { page: useRepository(7101), view: "work" }));
		const onHarbor = itemSessions().filter((session) => session.repository?.id === 7101);
		expect(onHarbor.length).toBeGreaterThan(0);
		const agents = host.querySelector("ul.agents[aria-label^='Your agents on']") as HTMLElement;
		expect(agents).not.toBeNull();
		for (const session of onHarbor) expect(linksTo(agents, `/agents/${session.id}`)).toEqual([]);
		const own = sessions.filter((session) => session.repository?.id === 7101 && session.item === undefined);
		expect(agents.querySelectorAll("li.agent-row")).toHaveLength(own.length);
		expect(host.querySelector("#repo-agents .usage-count")?.textContent).toBe(String(own.length));
		expect(host.querySelector(".repo-head .eyebrow")?.textContent).toMatch(new RegExp(`^repository · ${own.length} agents`));
		// Every started item's row leads to its session; a draft's has nothing to show yet, and its page leads there.
		const section = host.querySelector("section[aria-labelledby='repo-items']") as HTMLElement;
		for (const item of items.filter((one) => one.repository.id === 7101 && one.state !== "draft" && one.state !== "done" && one.state !== "cancelled")) {
			expect(linksTo(section, `/agents/${item.sessionId}`)).toHaveLength(1);
		}
		const draft = items.find((one) => one.repository.id === 7101 && one.state === "draft") as ItemSummary;
		expect(linksTo(section, `/agents/${draft.sessionId}`)).toEqual([]);
	});

	it("is opened from its item's page", async () => {
		await render(() => {
			const draft = items.find((one) => one.state === "draft") as ItemSummary;
			return createElement(Item, { page: useItem(draft.id, true) });
		});
		const draft = items.find((one) => one.state === "draft") as ItemSummary;
		expect(linksTo(host, `/agents/${draft.sessionId}`).map((link) => link.textContent)).toEqual(["Open the agent"]);
	});

	it("has its sandbox time today in the usage page's one row for work items, not in a row of its own", async () => {
		await render(() => createElement(Usage));
		const table = host.querySelector("section[aria-labelledby='usage-agents'] table") as HTMLElement;
		expect(table).not.toBeNull();
		for (const session of itemSessions()) expect(linksTo(table, `/agents/${session.id}`)).toEqual([]);
		const row = linksTo(table, "#usage-items")[0];
		expect(row?.textContent).toMatch(/^\d+ work items?$/);
		expect(host.textContent).toContain("The work items' row is their agents' sandboxes together, today.");
		// The rows still add up to the day's total.
		const clock = (text: string | null | undefined) => (text ?? "").split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
		const counted = [...table.querySelectorAll("tbody tr")].reduce((sum, tr) => sum + clock(tr.querySelector("td")?.textContent), 0);
		expect(counted).toBe(clock(table.querySelector("tfoot td")?.textContent));
	});
});
