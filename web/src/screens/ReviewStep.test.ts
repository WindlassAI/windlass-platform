// @vitest-environment jsdom
/**
 * An item in its review step, and the second reviewer's own page. The platform makes the verdict
 * before the reviewer runs, so a reviewing item has one: its word stays back until the item is handed
 * over, and the row says it is being reviewed. The reviewer's page says what it is, with the way to the
 * item, and offers no prompt box and nothing to publish, which the server refuses it; its prompts are
 * the platform's and stand as such. Also the sentence about what the agent's own push does on GitHub.
 */
import type { AuthResult, ItemSummary, ItemView, SandboxProfile } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { PlatformPrompts, platformPromptLabel, Turn } from "../components/Blocks";
import { AGENT_PUSH_MEANS, PUBLISH_UNASKED_MEANS, PublishUnaskedCheck, publishAskedOverMcp, REVIEWER_PUBLISHES_NOTHING } from "../components/PullRequest";
import { saveAuth } from "../lib/authStore";
import { ZERO_USAGE, type TurnView } from "../lib/timeline";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";
import { Item } from "./Item";
import { inSecondReview, ItemRow } from "./Items";
import { Session, useSessionMachine } from "./Session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= () => {};

const auth = { token: "mock:user:u_step:ada@example.com", profile: { uid: "u_step", email: "ada@example.com", demo: false } };

let views: ItemView[] = [];
const viewNamed = (title: string): ItemView => {
	const found = views.find((view) => view.title === title);
	if (!found) throw new Error(`no seeded item "${title}"`);
	return found;
};

beforeEach(async () => {
	if (views.length > 0) return;
	const mock = createMockClient({ pace: 0 });
	const user = mock.user(auth);
	views = await Promise.all((await user.listItems()).map((item) => user.item(item.id)));
	mock.dispose();
});

function rowOf(item: ItemSummary): HTMLElement {
	const host = document.createElement("ul");
	host.innerHTML = renderToStaticMarkup(createElement(ItemRow, { item, now: item.updatedAt }));
	return host;
}

describe("an item's row in its review step", () => {
	it("shows that it is being reviewed in a quiet word, and no verdict word, though the verdict is made", () => {
		const running = viewNamed("Paginate the artefact list");
		expect(running.verdict?.result).toBe("pass");
		expect(inSecondReview(running)).toBe(true);
		const row = rowOf(running);
		expect(row.querySelector(".item-verdict")).toBeNull();
		expect(row.textContent).not.toContain("Ready for review");
		expect(row.querySelector(".agent-state")?.innerHTML).toBe('<span class="item-row-review">being reviewed</span>');
	});

	it("says it waits for its reviewer while the review waits to start, with no verdict word", () => {
		const waiting = viewNamed("Sort the station list by name");
		expect(waiting.review?.state).toBe("waiting");
		const row = rowOf(waiting);
		expect(row.querySelector(".item-verdict")).toBeNull();
		expect(row.querySelector(".agent-state")?.textContent).toBe("waiting for its reviewer");
	});

	it("shows the verdict word once it is handed over, with the reviewer's recommendation beside it", () => {
		const handed = viewNamed("Show the upload's checksum in the log");
		expect(inSecondReview(handed)).toBe(false);
		const row = rowOf(handed);
		expect(row.querySelector(".item-verdict")?.textContent).toBe("Ready for review");
		expect(row.querySelector(".item-row-review")?.textContent).toBe("reviewed: approves");
	});

	it("is so for every seeded item: no item whose reviewer runs or waits shows a verdict word", () => {
		const reviewing = views.filter(inSecondReview);
		expect(reviewing.length).toBeGreaterThan(1);
		for (const item of reviewing) expect(rowOf(item).querySelector(".item-verdict"), item.title).toBeNull();
	});
});

describe("pages rendered with the mock", () => {
	let host: HTMLElement;
	let root: Root;
	let client: MockClient;

	beforeEach(() => {
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

	it("keeps the verdict's word back on the item's page while its reviewer runs, and says when it is given", async () => {
		client = createMockClient({ pace: 0 });
		saveAuth("mock", auth);
		for (const [title, reviewing] of [
			["Paginate the artefact list", true],
			["Show the upload's checksum in the log", false],
		] as const) {
			const view = viewNamed(title);
			const page = { view, error: null, missing: false, reload: () => undefined, replace: () => undefined };
			await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Item, { page }) })));
			const strip = host.querySelector('section[aria-labelledby="item-checks"]') as HTMLElement;
			expect(strip.querySelector(".item-verdict") === null, title).toBe(reviewing);
			expect(strip.querySelector(reviewing ? ".checks-summary .item-row-review" : ".checks-summary .item-verdict")?.textContent, title).toBe(reviewing ? "being reviewed" : "Ready for review");
			expect(strip.textContent?.includes("Its word is given when the second review is filed and the work is handed over."), title).toBe(reviewing);
			if (!reviewing) expect(strip.textContent).toContain("On GitHub as windlass/verified: Success");
			// The facts the verdict rests on are there either way.
			expect(strip.querySelector(".item-facts"), title).not.toBeNull();
		}
	});

	it("says on the reviewer's page that it is the item's second reviewer, links the item, and offers no prompt box and nothing to publish", async () => {
		vi.useFakeTimers();
		client = createMockClient({ origin: "http://localhost:5173" });
		const begun = client.login.start();
		await vi.advanceTimersByTimeAsync(1000);
		const { redirectPrefix, url } = await begun;
		const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
		await vi.advanceTimersByTimeAsync(1000);
		const signedIn: AuthResult = await finished;
		saveAuth("mock", signedIn);
		const listed = client.user(signedIn).listItems();
		await vi.advanceTimersByTimeAsync(1000);
		const item = (await listed).find((one) => one.title === "Show the upload's checksum in the log") as ItemSummary;
		const read = client.user(signedIn).item(item.id);
		await vi.advanceTimersByTimeAsync(1000);
		const reviewerId = (await read).reviewerSessionId as string;
		expect(reviewerId).toBeTruthy();
		function Screen() {
			const state = useSession(reviewerId);
			return createElement(Session, { sessionId: reviewerId, state, machine: useSessionMachine(state.summary?.place) });
		}
		act(() => root.render(createElement(AppProvider, { client, children: createElement(Screen) })));
		for (let step = 0; step < 10; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));

		const note = host.querySelector(".item-note") as HTMLElement;
		expect(note.querySelector(".item-note-text")?.textContent).toBe("This agent is the second reviewer of a work item: it reads the commit the item pushed and files one review. The item sends its prompts.");
		expect([...note.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["work item", `/items/${item.id}`]]);
		expect(host.querySelector(".session-main textarea, .composer-box, .starters")).toBeNull();

		const panel = host.querySelector("aside#details") as HTMLElement;
		expect(panel.querySelector(".gh-item-note")?.textContent).toBe(REVIEWER_PUBLISHES_NOTHING);
		expect(panel.textContent).not.toContain("Let the agent publish without asking");
		expect([...panel.querySelectorAll("button")].map((button) => button.textContent)).not.toEqual(expect.arrayContaining([expect.stringMatching(/pull request|Push|Commit/)]));

		// Its first prompt is the platform's, with no text of its own: a plain line, never an empty message.
		const first = host.querySelector(".turn .block-user") as HTMLElement;
		expect(first.querySelector(".user-platform-line")?.textContent).toBe(platformPromptLabel(true));
		expect(first.querySelector(".user-text")).toBeNull();
		expect(first.querySelector("button")).toBeNull();
		expect(first.textContent).not.toContain("You:");
	});
});

describe("a prompt of the platform's in the reviewer's timeline", () => {
	const turn = (n: number, text: string): TurnView => ({ turn: n, blocks: [{ id: `u${n}`, kind: "user", at: 1_700_000_000_000, text, model: "gpt-6.1-sol", effort: null, steer: false }], steps: 0, interruptRequested: false, changedFiles: null, usage: ZERO_USAGE, end: null, platformAnswer: null });
	let host: HTMLElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("stands under a plain label, its text clamped to two lines with Show all only when cut", () => {
		const text = "You were interrupted. Continue from where you were.";
		act(() => root.render(createElement(PlatformPrompts.Provider, { value: "reviewer", children: createElement(Turn, { turn: turn(2, text) }) })));
		expect(host.querySelector(".user-platform-line")?.textContent).toBe(platformPromptLabel(false));
		const shown = host.querySelector(".user-platform-text") as HTMLElement;
		expect(shown.textContent).toBe(text);
		expect(shown.getAttribute("data-clamped")).toBe("true");
		expect(shown.style.getPropertyValue("--lines")).toBe("2");
		// jsdom lays nothing out, so nothing is cut: no control.
		expect(host.querySelector("button")).toBeNull();
	});

	it("is the factory's brief in a builder's timeline", () => {
		act(() => root.render(createElement(PlatformPrompts.Provider, { value: "builder", children: createElement(Turn, { turn: turn(1, "Goal: stream the rows.") }) })));
		expect(host.querySelector(".user-platform-line")?.textContent).toBe("The factory's brief");
		expect(host.querySelector(".user-platform-text")?.textContent).toBe("Goal: stream the rows.");
		expect(host.textContent).not.toContain("You:");
	});

	it("is a person's message everywhere else", () => {
		act(() => root.render(createElement(Turn, { turn: turn(1, "Run the tests.") })));
		expect(host.querySelector(".user-platform")).toBeNull();
		expect(host.querySelector(".user-text")?.textContent).toBe("You: Run the tests.");
	});
});

describe("what the agent's own push does on GitHub", () => {
	const sandboxed = { id: "docker-windlass-sandbox", name: "Windlass sandbox", approval: "sandboxed", commandNetwork: false, commandsCanReadAccessToken: false } as unknown as SandboxProfile;
	const open = { ...sandboxed, approval: "full" } as SandboxProfile;

	it("is said in one sentence: it runs the repository's CI on the agent's changes, with the CI's secrets, without asking", () => {
		expect(AGENT_PUSH_MEANS).toBe("The agent pushes this session's own branch whenever it wants, and a push runs the repository's CI workflows on the agent's changes, with the CI's secrets, without you being asked.");
		expect(PUBLISH_UNASKED_MEANS).not.toContain("branch");
	});

	it("stands under the setting in the panel, whichever way the setting can be", () => {
		for (const profile of [sandboxed, open]) {
			const html = renderToStaticMarkup(createElement(PublishUnaskedCheck, { checked: false, disabled: false, onChange: () => undefined, profile }));
			const host = document.createElement("div");
			host.innerHTML = html;
			expect([...host.querySelectorAll(".check-means")].map((node) => node.textContent), profile.approval).toContain(AGENT_PUSH_MEANS);
		}
	});

	it("for an agent that reaches its tools over MCP, says it is asked every time, with no setting, in the Windlass sandbox profile too", () => {
		const html = renderToStaticMarkup(createElement(PublishUnaskedCheck, { checked: false, disabled: false, onChange: () => undefined, profile: sandboxed, agent: "Codex" }));
		const host = document.createElement("div");
		host.innerHTML = html;
		expect(host.querySelector("input")).toBeNull();
		expect(host.querySelector(".check-name")?.textContent).toBe("You are asked each time the agent wants to publish");
		expect([...host.querySelectorAll(".check-means")].map((node) => node.textContent)).toEqual([publishAskedOverMcp("Codex"), AGENT_PUSH_MEANS]);
	});
});
