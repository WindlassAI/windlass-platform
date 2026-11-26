// @vitest-environment jsdom
/** Sections, trails, the back control's way and words, and the state Back brings back. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { boardTracks } from "./board";
import { accountTrail, itemTrail, routeLabel, sectionOfPage, sessionTrail, trailParent } from "./nav";
import { navigate, pageFrom, parseRoute, useBack, useHistoryState, usePageLabel, type Route } from "./router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const harbor = { id: 7101, name: "harbor" } as never;

describe("the section of a page", () => {
	it("is decided by what the page shows", () => {
		const at = (path: string, itemSession = false) => sectionOfPage(parseRoute(...(path.split("?") as [string, string?])), itemSession);
		expect(at("/")).toBe("agents");
		expect(at("/repositories/7101/items")).toBe("agents");
		expect(at("/repositories/7101/settings")).toBe("agents");
		expect(at("/new")).toBe("agents");
		expect(at("/factory", false)).toBe("factory");
		expect(at("/items/i1")).toBe("factory");
		expect(at("/agents/s1")).toBe("agents");
		expect(at("/agents/item-s1", true)).toBe("factory");
		expect(at("/machines")).toBe("machines");
		expect(at("/usage")).toBe("account");
		expect(at("/settings")).toBe("account");
		expect(at("/plans")).toBe("account");
		expect(at("/nowhere")).toBeNull();
	});
});

describe("a page's trail", () => {
	it("starts a work item's with the Factory, its repository the Factory filtered to it", () => {
		const trail = itemTrail({ title: "Fix the timezone", repository: harbor });
		expect(trail.map((crumb) => crumb.label)).toEqual(["Factory", "harbor", "Fix the timezone"]);
		expect(trail[1]?.route).toEqual({ name: "factory", repository: 7101 });
		expect(trailParent(trail)).toEqual({ route: { name: "factory", repository: 7101 }, label: "Factory · harbor" });
		expect(itemTrail(null).map((crumb) => crumb.label)).toEqual(["Factory", "Work item"]);
	});

	it("puts a subtask under its feature, which is the way back on a direct visit", () => {
		const trail = itemTrail({ title: "Part", repository: harbor, parent: { itemId: "f1", title: "Feature" } });
		expect(trail.map((crumb) => crumb.label)).toEqual(["Factory", "harbor", "Feature", "Part"]);
		expect(trailParent(trail)).toEqual({ route: { name: "item", id: "f1" }, label: "Feature" });
	});

	it("gives a work item's agent the item's trail, and the user's own agent Agents'", () => {
		const part = sessionTrail({ title: "s", repository: harbor, item: { id: "p1" } }, { title: "Part", repository: harbor, parent: { itemId: "f1", title: "Feature" } });
		expect(part.map((crumb) => crumb.label)).toEqual(["Factory", "harbor", "Feature", "Part", "Builder"]);
		expect(trailParent(part)).toEqual({ route: { name: "item", id: "p1" }, label: "Part" });
		expect(sessionTrail({ title: "r", item: { id: "i1", role: "reviewer" } }, null).at(-1)?.label).toBe("Code review");
		expect(sessionTrail({ title: "Part", item: { id: "i1", role: "reviewer", planCritic: true } }, null).at(-1)?.label).toBe("Plan review");
		const own = sessionTrail({ title: "Fix it", repository: harbor }, null);
		expect(own.map((crumb) => crumb.label)).toEqual(["Agents", "harbor", "Fix it"]);
		expect(trailParent(own)).toEqual({ route: { name: "repository", id: 7101 }, label: "harbor" });
		expect(trailParent(sessionTrail({ title: "Loose" }, null))).toEqual({ route: { name: "home" }, label: "Agents" });
	});

	it("puts the account's pages under Settings", () => {
		expect(accountTrail("Usage").map((crumb) => crumb.label)).toEqual(["Settings", "Usage"]);
		expect(trailParent(accountTrail("Usage"))).toEqual({ route: { name: "settings" }, label: "Settings" });
	});
});

describe("the back control", () => {
	let back: ReturnType<typeof useBack> = null;
	let host: HTMLElement;
	afterEach(() => host?.remove());

	function Probe({ fallback, label }: { fallback: { route: Route; label: string } | null; label?: string }) {
		back = useBack(fallback);
		usePageLabel(label);
		return null;
	}
	const render = (props: { fallback: { route: Route; label: string } | null; label?: string }) => {
		host = document.createElement("div");
		const root = createRoot(host);
		act(() => root.render(createElement(Probe, props)));
		return root;
	};

	it("falls back to the trail's parent on a direct visit", () => {
		history.replaceState(null, "", "/items/i1");
		const root = render({ fallback: { route: { name: "factory" }, label: "Factory" } });
		expect(back?.label).toBe("Factory");
		expect(back?.href).toBe("/factory");
		act(() => root.unmount());
		render({ fallback: null });
		expect(back).toBeNull();
	});

	it("names the page you came from, by what it called itself", () => {
		history.replaceState(null, "", "/factory?repository=7101");
		const root = render({ fallback: null, label: "Factory · harbor" });
		act(() => navigate({ name: "item", id: "i1" }));
		expect(pageFrom()).toEqual({ href: "/factory?repository=7101", label: "Factory · harbor" });
		expect(back?.label).toBe("Factory · harbor");
		expect(back?.href).toBe("/factory?repository=7101");
		act(() => root.unmount());
	});

	it("keeps where a page was opened from when a filter replaces it, and a page that named nothing by its kind", () => {
		history.replaceState(null, "", "/usage");
		act(() => navigate({ name: "factory" }));
		expect(pageFrom()?.label).toBe("Usage");
		act(() => navigate({ name: "factory", from: "web" }, { replace: true }));
		expect(pageFrom()).toEqual({ href: "/usage", label: "Usage" });
		expect(routeLabel({ name: "repository", id: 1 as never, view: "items" })).toBe("Work items");
	});
});

describe("the state Back brings back", () => {
	it("is kept in the history entry and read again when the page opens", () => {
		history.replaceState(null, "", "/factory");
		let state: [boolean, (next: boolean) => void] = [false, () => {}];
		function Probe() {
			state = useHistoryState("ended", false);
			return null;
		}
		const host = document.createElement("div");
		let root = createRoot(host);
		act(() => root.render(createElement(Probe)));
		expect(state[0]).toBe(false);
		act(() => state[1](true));
		act(() => root.unmount());
		root = createRoot(host);
		act(() => root.render(createElement(Probe)));
		expect(state[0]).toBe(true);
		act(() => root.unmount());
	});

	it("saves the scroll of the page left", () => {
		history.replaceState(null, "", "/factory");
		Object.defineProperty(window, "scrollY", { value: 900, configurable: true });
		act(() => navigate({ name: "item", id: "i2" }));
		history.back();
		return new Promise<void>((resolve) =>
			window.addEventListener(
				"popstate",
				() => {
					expect((history.state as { scroll?: number }).scroll).toBe(900);
					resolve();
				},
				{ once: true },
			),
		);
	});
});

describe("the board's columns", () => {
	it("makes an empty column a slim strip and lets the others share the width", () => {
		expect(boardTracks({ planning: 0, building: 3, ci: 0, review: 0, ready: 2, ended: 4 })).toBe("44px minmax(188px, 1fr) 44px 44px minmax(188px, 1fr) minmax(160px, 0.8fr)");
		expect(boardTracks({ planning: 1, building: 0, ci: 0, review: 0, ready: 0, ended: 0 })).toBe("minmax(188px, 1fr) 44px 44px 44px 44px 44px");
	});
});
