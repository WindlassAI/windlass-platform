// @vitest-environment jsdom
/**
 * The first-run setup on Home for a new account (the mock's `fresh`): it opens at the first step not done,
 * moves through the repository, the agents and the first item, is dismissed and resumed where it was left, and
 * files the first item through the existing path.
 */
import type { AuthResult, CreateItemInput } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { loadOnboarding } from "../lib/onboarding";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });
HTMLDialogElement.prototype.showModal ??= function () {
	this.open = true;
};
HTMLDialogElement.prototype.close ??= function () {
	this.open = false;
};
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = () => {};
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addEventListener() {},
	removeEventListener() {},
	addListener() {},
	removeListener() {},
	dispatchEvent: () => false,
})) as typeof window.matchMedia;

const newbie: AuthResult = {
	token: "mock:user:u_new:new@example.com",
	profile: { uid: "u_new", email: "new@example.com", demo: false },
};

let host: HTMLElement;
let root: Root | null;
let client: MockClient;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	sessionStorage.clear();
	localStorage.clear();
	root = null;
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	localStorage.clear();
});

async function settle(steps = 16): Promise<void> {
	for (let step = 0; step < steps; step++)
		await act(async () => void (await new Promise(resolve => setTimeout(resolve, 2))));
}

async function render(auth = newbie) {
	history.replaceState(null, "", "/");
	saveAuth("mock", auth);
	root = createRoot(host);
	act(() => root!.render(createElement(AppProvider, { client, children: createElement(App) })));
	await settle();
}

const setup = () => host.querySelector<HTMLElement>('[aria-label="Set up Windlass"]');
/** The open card's title. */
const heading = () => setup()?.querySelector('[aria-current="step"] h3')?.textContent;
const button = (name: string, scope: ParentNode = host) =>
	[...scope.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent?.trim() === name);
const click = async (name: string, scope?: ParentNode) => {
	const found = button(name, scope);
	expect(found, name).toBeDefined();
	await act(async () => found!.click());
	await settle();
};

const fresh = () => createMockClient({ pace: 0, fresh: true, items: "none", machine: "none" });

it("opens at GitHub for a new account, and never for the demo user", async () => {
	client = fresh();
	await render();
	expect(heading()).toBe("Connect GitHub");
	expect(button("Install the GitHub App")).toBeDefined();
	// The later cards say what they wait for.
	expect(setup()?.textContent).toContain("After GitHub");
	expect(button("Continue")).toBeUndefined();
	expect(host.textContent).not.toContain("No agents yet");
	act(() => root!.unmount());

	root = null;
	const demo = await client.login.demo();
	await render(demo);
	expect(setup()).toBeNull();
});

it("moves from the repository to the agents to a first item, filed through the existing path", async () => {
	client = fresh();
	// GitHub is connected already: it opens at the repository.
	localStorage.setItem("wlp.mock.github.u_new", "1");
	await render();
	expect(heading()).toBe("Pick a repository");
	expect(button("Continue")?.disabled).toBe(true);
	const harbor = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(one =>
		one.textContent?.startsWith("acme/harbor"),
	)!;
	await act(async () => harbor.click());
	await click("Continue");
	expect(heading()).toBe("Connect your agents");
	const claude = host.querySelector<HTMLElement>('[data-agent="claude"]')!;
	// The mock's account may connect plans: "Use my plan" is chosen, with its command.
	expect(claude.querySelector('[aria-checked="true"]')?.textContent).toContain("Use my Claude plan");
	expect(claude.querySelector(".plan-connect pre")?.textContent).toBe("npx @windlassai/cli connect claude");
	expect(button("Continue")?.disabled).toBe(true);
	// A key connects Codex.
	const codex = host.querySelector<HTMLElement>('[data-agent="codex"]')!;
	await click("OpenAI API keyBilled to your OpenAI account", codex);
	await click("Add the OpenAI key…", codex);
	const input = document.querySelector<HTMLInputElement>("dialog input")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
			input,
			"sk-proj-abcdefghijklmnop1234",
		);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await click("Save key", document.querySelector("dialog")!);
	expect(codex.querySelector(".conn-state")?.textContent).toBe("OpenAI key");
	expect(button("Continue")?.disabled).toBe(false);
	await click("Continue");

	expect(heading()).toBe("File your first item");
	expect(setup()?.textContent).toContain("acme/harbor");
	const tasks = [...host.querySelectorAll<HTMLElement>('[aria-label="Starter task"] [role="radio"]')].map(
		one => one.firstChild?.textContent,
	);
	expect(tasks).toEqual([
		"Fix #142: Tide table shows yesterday after midnight UTC",
		"Fix #157: Harbor map pins overlap on small screens",
		"Add a test for an untested function",
	]);
	const filed: CreateItemInput[] = [];
	const user = client.user.bind(client);
	vi.spyOn(client, "user").mockImplementation(auth => ({
		...user(auth),
		createItem: input => {
			filed.push(input);
			return user(auth).createItem(input);
		},
	}));
	await click("Start item");
	await settle(30);
	// Codex is the agent something pays for on Hosted.
	expect(filed).toMatchObject([
		{
			repository: { id: 7101 },
			title: "Fix #142: Tide table shows yesterday after midnight UTC",
			harness: "codex",
			mode: "single",
			start: true,
		},
	]);
	const [item] = await client.user(newbie).listItems();
	expect(item?.title).toBe("Fix #142: Tide table shows yesterday after midnight UTC");
	expect(location.pathname).toBe(`/items/${item!.id}`);
	expect(loadOnboarding("u_new")?.dismissed).toBe(true);
});

it("is dismissed, stays shut on the next visit, and resumes where it was left", async () => {
	client = fresh();
	localStorage.setItem("wlp.mock.github.u_new", "1");
	await render();
	const tide = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(one =>
		one.textContent?.startsWith("ada/tide-tables"),
	)!;
	await act(async () => tide.click());
	await click("Continue");
	expect(heading()).toBe("Connect your agents");
	await click("Set up later");
	expect(setup()).toBeNull();
	expect(host.textContent).toContain("No agents yet");
	expect(host.textContent).toContain("Your setup is not finished.");

	act(() => root!.unmount());
	await render();
	expect(setup()).toBeNull();
	await click("Resume setup");
	expect(heading()).toBe("Connect your agents");
	await click("Skip for now");
	expect(heading()).toBe("File your first item");
	// No open bugs there: the generic tasks, and words of the user's own.
	expect(setup()?.textContent).toContain("ada/tide-tables");
	expect(setup()?.textContent).toContain("Fix typos and broken links in the README");
});
