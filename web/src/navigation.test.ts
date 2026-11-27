// @vitest-environment jsdom
import type { AuthResult } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createMockClient, type MockClient } from "./api/mock";
import { DocsApp } from "./docs/Docs";
import { saveAuth } from "./lib/authStore";
import { navigate } from "./lib/router";
import { AppProvider } from "./state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((media: string) => ({
	media,
	matches: false,
	onchange: null,
	addListener() {},
	removeListener() {},
	addEventListener() {},
	removeEventListener() {},
	dispatchEvent: () => false,
})) as typeof matchMedia;
Element.prototype.scrollTo ??= () => {};
HTMLDialogElement.prototype.showModal ??= function () {
	this.open = true;
};
HTMLDialogElement.prototype.close ??= function () {
	this.open = false;
};

const auth: AuthResult = {
	token: "mock:user:u_ada:ada@example.com",
	profile: { uid: "u_ada", email: "ada@example.com", demo: false },
};
let host: HTMLElement;
let root: Root;
let client: MockClient;

beforeEach(() => {
	sessionStorage.clear();
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = createMockClient({ pace: 0 });
	saveAuth("mock", auth);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	vi.restoreAllMocks();
});

async function open(path: string) {
	history.replaceState(null, "", path);
	await act(async () => root.render(createElement(AppProvider, { client, children: createElement(App) })));
}

// Let React draw updates from the mock feeds and browser history.
function until(check: () => void) {
	return vi.waitFor(async () => {
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
		});
		check();
	});
}

const links = () =>
	[...host.querySelectorAll<HTMLAnchorElement>("main .button[href]")].map(link => [link.textContent, link.pathname]);
const button = (label: string) => [...host.querySelectorAll("button")].find(one => one.textContent?.trim() === label);
const docsLinks = () =>
	[...host.querySelectorAll<HTMLAnchorElement>("a")]
		.filter(link => link.textContent?.trim() === "Open Windlass")
		.map(link => link.getAttribute("href"));

describe("missing pages", () => {
	it("links a missing work item to the Factory and can go back to the previous page", async () => {
		await open("/machines");
		act(() => navigate({ name: "item", id: "missing" }));
		await until(() => expect(links()).toEqual([["Go to the Factory", "/factory"]]));
		act(() => button("Back")!.click());
		await until(() => expect(location.pathname).toBe("/machines"));
	});

	it.each([true, false])("returns a deleted agent to its section (item agent: %s)", async itemAgent => {
		const sessions = await client.user(auth).listSessions();
		const agent = sessions.find(one => Boolean(one.item) === itemAgent)!;
		await open("/agents/" + agent.id);
		await until(() => expect(document.title).toContain(agent.title));
		await act(async () => client.user(auth).deleteSession(agent.id));
		await until(() =>
			expect(links()).toEqual(itemAgent ? [["Go to the Factory", "/factory"]] : [["Go to Agents", "/"]]),
		);
	});

	it("links to the Factory when an item's agent is already gone", async () => {
		await open("/items/missing");
		act(() => navigate({ name: "session", id: "s_1234" }));
		await until(() => expect(links()).toEqual([["Go to the Factory", "/factory"]]));
	});

	it.each(["/unknown", "/agents/unknown"])("offers both sections at %s when the object is unknown", async path => {
		vi.spyOn(history, "length", "get").mockReturnValue(1);
		await open(path);
		await until(() =>
			expect(links()).toEqual([
				["Go to the Factory", "/factory"],
				["Go to Agents", "/"],
			]),
		);
		expect(button("Back")).toBeUndefined();
	});
});

describe("closing Add a machine", () => {
	const close = () => act(() => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));

	it("pops the dialog entry so the next Back leaves Machines", async () => {
		await open("/usage");
		act(() => navigate({ name: "machines" }));
		await until(() => expect(button("Add a machine")?.disabled).toBe(false));
		act(() => button("Add a machine")!.click());
		expect(location.pathname).toBe("/machines/add");
		await until(() => expect(host.querySelector("dialog")).not.toBeNull());
		close();
		await until(() => expect(location.pathname).toBe("/machines"));
		act(() => history.back());
		await until(() => expect(location.pathname).toBe("/usage"));
	});

	it("replaces a directly opened dialog even when the tab has prior history", async () => {
		history.replaceState(null, "", "/usage");
		history.pushState(null, "", "/machines/add");
		await open("/machines/add");
		await until(() => expect(host.querySelector("dialog")).not.toBeNull());
		const length = history.length;
		close();
		expect(location.pathname).toBe("/machines");
		expect(history.length).toBe(length);
		act(() => history.back());
		await until(() => expect(location.pathname).toBe("/usage"));
	});
});

describe("Open Windlass in Docs", () => {
	it("keeps the last app address in the header and drawer across docs pages and a fresh render", async () => {
		const path = "/factory?repository=7102&from=github&mock=1";
		await open(path);
		history.replaceState(history.state, "", path + "#work");
		act(() => navigate({ name: "docs", slug: "" }));
		await until(() => expect(docsLinks()).toEqual([path + "#work", path + "#work"]));
		act(() => navigate({ name: "docs", slug: "machines" }));
		await act(async () => root.render(createElement(DocsApp)));
		expect(docsLinks()).toEqual([path + "#work", path + "#work"]);
	});

	it("opens home on a direct docs visit with no saved page", async () => {
		history.replaceState(null, "", "/docs");
		await act(async () => root.render(createElement(DocsApp)));
		expect(docsLinks()).toEqual(["/", "/"]);
	});
});
