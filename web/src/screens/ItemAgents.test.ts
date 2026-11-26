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
import { ITEM_SESSION_PROMPT, createMockClient, type MockClient } from "../api/mock";
import { loadAuth, saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { Item, useItem } from "./Item";
import { RepositoryPane, useRepository } from "./Repository";
import { useItems } from "./Items";
import { NO_FILTERS } from "../lib/workspace";
import type { RepositoryPaneView } from "../lib/router";
import { Workspace } from "./Workspace";
import { Session, useSessionMachine } from "./Session";
import { useSession } from "../state/hooks";
import { Usage } from "./Usage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out: the conversation's scrolling to its end has nothing to do.
Element.prototype.scrollTo ??= () => {};

let host: HTMLElement;
let root: Root;
let client: MockClient;
let sessions: SessionSummary[];
let items: ItemSummary[];

async function wait(steps = 8): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
}

/** Signs in to the mock and renders `screen` in the app's context, once the lists are known. */
async function render(screen: () => ReturnType<typeof createElement>, options: Parameters<typeof createMockClient>[0] = {}): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173", ...options });
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
	it("is not among the home page's agents, nor in its count of agents: its item stands in the feed instead", async () => {
		await render(() => createElement(Workspace, { selection: { kind: "everything" }, items: useItems(true) }));
		expect(itemSessions().length).toBeGreaterThan(0);
		const feed = host.querySelector(".home-feed") as HTMLElement;
		expect(feed).not.toBeNull();
		for (const session of itemSessions()) expect(linksTo(feed, `/agents/${session.id}`)).toEqual([]);
		const own = sessions.filter((session) => session.item === undefined);
		expect(feed.querySelectorAll('.feed-row[data-kind="agent"]').length).toBeLessThanOrEqual(own.length);
		expect(feed.querySelectorAll('.feed-row[data-kind="item"]').length).toBeGreaterThan(0);
		expect(host.querySelector(".home-head .home-facts")?.textContent).toMatch(new RegExp(`^${own.length} agents, \\d+ of 6 working, \\d+ of them work items`));
		// The repository is a label on each row, leading to its page: acme/lighthouse-docs is 7103.
		const docs = [...feed.querySelectorAll<HTMLAnchorElement>(".feed-repo")].find((label) => label.textContent?.includes("lighthouse-docs"));
		expect(docs?.getAttribute("href")).toBe("/repositories/7103");
	});

	it("is not among a repository's agents, and is reached from its item's row", async () => {
		const pane = (view: RepositoryPaneView) => () => createElement(RepositoryPane, { page: useRepository(7101), view, items: useItems(true), filters: NO_FILTERS, onFilters: () => undefined, machines: [] });
		await render(pane("agents"));
		const onHarbor = itemSessions().filter((session) => session.repository?.id === 7101);
		expect(onHarbor.length).toBeGreaterThan(0);
		const agents = host.querySelector("ul.agents[aria-label^='Your agents on']") as HTMLElement;
		expect(agents).not.toBeNull();
		for (const session of onHarbor) expect(linksTo(agents, `/agents/${session.id}`)).toEqual([]);
		const own = sessions.filter((session) => session.repository?.id === 7101 && session.item === undefined);
		expect(agents.querySelectorAll("li.agent-row")).toHaveLength(own.length);
		expect(host.querySelector("#repo-agents .ws-section-count")?.textContent).toBe(String(own.length));
		expect(host.querySelector(".ws-head .ws-status")?.textContent).toContain(`${own.length} agents`);
		act(() => root.unmount());
		client.dispose();
		root = createRoot(host);
		await render(pane("items"));
		// Every started item's row leads to its session; a draft's has nothing to show yet, and its page leads there.
		const section = host.querySelector("section[aria-labelledby='repo-items']") as HTMLElement;
		for (const item of items.filter((one) => one.repository.id === 7101 && one.state !== "draft" && one.state !== "done" && one.state !== "cancelled")) {
			expect(linksTo(section, `/agents/${item.sessionId}`)).toHaveLength(1);
		}
		const draft = items.find((one) => one.repository.id === 7101 && one.state === "draft") as ItemSummary;
		expect(linksTo(section, `/agents/${draft.sessionId}`)).toEqual([]);
	});

	it("explains where a feature subtask gets its second review", async () => {
		await render(() => {
			const child = items.find(one => one.parent)!;
			return createElement(Item, { page: useItem(child.id, true) });
		}, { items: "features" });
		const review = host.querySelector('section[aria-labelledby="item-checks"]');
		expect(review?.textContent).toContain("Reviewed with the whole feature.");
		expect(review?.textContent).not.toContain("turned off for this deployment");
	});

	it("explains when the first running turn will count toward spend", async () => {
		await render(() => {
			const item = items.find(one => one.title === "Cache the downloaded tide predictions")!;
			return createElement(Item, { page: useItem(item.id, true) });
		});
		const cost = host.querySelector('section[aria-labelledby="item-cost"]');
		expect(cost?.textContent).toContain("Spend is counted when the running turn ends. This step started 29 min ago.");
		expect(cost?.textContent).toContain("0 turns");
	});

	it("is opened from its item's page", async () => {
		await render(() => {
			const draft = items.find((one) => one.state === "draft") as ItemSummary;
			return createElement(Item, { page: useItem(draft.id, true) });
		});
		const draft = items.find((one) => one.state === "draft") as ItemSummary;
		expect(host.textContent).not.toContain("Spend is counted when the running turn ends.");
		expect(linksTo(host, `/agents/${draft.sessionId}`).map((link) => link.textContent)).toEqual([draft.title + " · Builder"]);
	});

	it("has its sandbox time today in the usage page's one row for work items, not in a row of its own", async () => {
		await render(() => createElement(Usage));
		const table = host.querySelector("section[aria-labelledby='usage-agents'] table") as HTMLElement;
		expect(table).not.toBeNull();
		for (const session of itemSessions()) expect(linksTo(table, `/agents/${session.id}`)).toEqual([]);
		const row = linksTo(table, "#usage-items")[0];
		expect(row?.textContent).toMatch(/^\d+ work items?$/);
		expect(table.querySelector("thead th[hidden]")?.textContent).toBe("Held");
		// The rows still add up to the day's total.
		const clock = (text: string | null | undefined) => (text ?? "").split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
		const counted = [...table.querySelectorAll("tbody tr")].reduce((sum, tr) => sum + clock(tr.querySelector("td")?.textContent), 0);
		expect(counted).toBe(clock(table.querySelector("tfoot td")?.textContent));
	});

	it("has no prompt box on its page: one line says its item's steps send its prompts, with the way to the item, and the server's controls stay", async () => {
		let shown = "";
		await render(() => {
			const working = items.find((one) => one.state === "working" && sessions.some((session) => session.id === one.sessionId && session.status === "running")) as ItemSummary;
			shown = working.sessionId as string;
			const state = useSession(shown);
			return createElement(Session, { sessionId: shown, state, machine: useSessionMachine(state.summary?.place) });
		});
		const item = items.find((one) => one.sessionId === shown) as ItemSummary;
		expect(host.querySelector("main.session")).not.toBeNull();
		// No field, no Send or Steer, no model or effort to choose, no prompts to start with.
		expect(host.querySelector(".session-main textarea")).toBeNull();
		expect(host.querySelector(".composer-box, .composer-foot, .starters")).toBeNull();
		expect([...host.querySelectorAll("button")].map((button) => button.textContent)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(Send|Steer)/)]));
		const note = host.querySelector(".item-note") as HTMLElement;
		expect(note.querySelector(".item-note-text")?.textContent).toBe("This agent works for a work item, whose steps send its prompts.");
		expect(linksTo(note, `/items/${item.id}`).map((link) => link.textContent)).toEqual(["work item"]);
		// Stop is the server's to allow, and it does: while the item's turn runs it is there, and says what stopping means for an item.
		const stop = [...note.querySelectorAll("button")].find((button) => button.textContent === "Stop the turn") as HTMLButtonElement;
		expect(stop).toBeDefined();
		expect(stop.title).toBe("The item tries this step again. To end its work, cancel the item.");
		// The panel: the pull request is the item's to open, and the setting to publish unasked, which its agent never asks, is not there.
		const panel = host.querySelector("aside#details") as HTMLElement;
		expect(panel.textContent).not.toContain("Let the agent open and update it");
		expect(panel.querySelector(".gh-item-note")?.textContent).toBe("The work item's steps push the work and open or update the pull request.");
		// And the server would refuse a prompt in any case: the mock does, in its words.
		const auth = loadAuth("mock") as AuthResult;
		const sent = client.session(auth, shown).prompt({ text: "Do something else" }).then(
			() => null,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await sent).toMatchObject({ message: ITEM_SESSION_PROMPT, reason: "item_session" });
		expect(ITEM_SESSION_PROMPT).toBe("This agent works for a work item, whose steps send its prompts. Answer the item, or send its work back with a note.");
	});

	it("says on an idle item agent's page what sends its prompts, with no Stop", async () => {
		let shown = "";
		await render(() => {
			const idle = sessions.find((session) => session.item !== undefined && session.status === "idle") as SessionSummary;
			shown = idle.id;
			const state = useSession(shown);
			return createElement(Session, { sessionId: shown, state, machine: useSessionMachine(state.summary?.place) });
		});
		const note = host.querySelector(".item-note") as HTMLElement;
		expect(note.textContent).toBe("This agent works for a work item, whose steps send its prompts.");
		expect(note.querySelector("button")).toBeNull();
		expect(host.querySelector(".session-main textarea")).toBeNull();
	});
});
