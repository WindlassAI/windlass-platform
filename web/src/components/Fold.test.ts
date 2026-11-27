// @vitest-environment jsdom
/**
 * The shared long-text treatment (Fold.tsx): prose offers "Show all" only when its clamp cuts it, and
 * opens in place to "Hide"; a list shows three items and "Show N more", never folding away one item;
 * paths say how many, show three and "+N"; the control is one link with `aria-expanded`.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FoldList, LongText, PathList, listFolds } from "./Fold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
/** What jsdom says of a clamped element's height: it lays nothing out, so the test says it. */
let tall = false;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => (tall ? 200 : 40) });
	Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 40 });
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	tall = false;
});

const render = (element: ReturnType<typeof createElement>) => act(() => root.render(element));
const button = () => host.querySelector("button");
const click = (target: Element | null) => act(() => (target as HTMLElement).click());

describe("LongText", () => {
	it("offers nothing when the text fits", () => {
		render(createElement(LongText, { lines: 3, children: "A short line." }));
		expect(host.textContent).toBe("A short line.");
		expect(button()).toBeNull();
		expect(host.querySelector(".long-text-body")?.getAttribute("data-clamped")).toBe("true");
	});

	it("offers Show all when the clamp cuts it, and opens in place to Hide", () => {
		tall = true;
		render(createElement(LongText, { lines: 2, children: "Line one\nLine two\nLine three" }));
		const body = host.querySelector(".long-text-body") as HTMLElement;
		expect(body.style.getPropertyValue("--lines")).toBe("2");
		expect(button()?.textContent).toBe("Show all");
		expect(button()?.getAttribute("aria-expanded")).toBe("false");
		expect(button()?.getAttribute("aria-controls")).toBe(body.id);
		click(button());
		expect(body.hasAttribute("data-clamped")).toBe(false);
		expect(button()?.textContent).toBe("Hide");
		expect(button()?.getAttribute("aria-expanded")).toBe("true");
		click(button());
		expect(button()?.textContent).toBe("Show all");
	});

	it("keeps the author's line breaks for CSS to show", () => {
		render(createElement(LongText, { children: "a\n\nb" }));
		expect(host.querySelector(".long-text-body")?.textContent).toBe("a\n\nb");
	});
});

describe("FoldList", () => {
	const lines = ["one", "two", "three", "four", "five", "six"];
	it("shows three, then Show N more, then Hide", () => {
		render(createElement(FoldList<string>, { items: lines, render: line => line }));
		expect([...host.querySelectorAll("li")].map(li => li.textContent)).toEqual(["one", "two", "three"]);
		expect(button()?.textContent).toBe("Show 3 more");
		click(button());
		expect(host.querySelectorAll("li")).toHaveLength(6);
		expect(button()?.textContent).toBe("Hide");
	});

	it("never folds away a single item", () => {
		expect(listFolds(4)).toBe(false);
		expect(listFolds(5)).toBe(true);
		render(createElement(FoldList<string>, { items: lines.slice(0, 4), render: line => line }));
		expect(host.querySelectorAll("li")).toHaveLength(4);
		expect(button()).toBeNull();
	});
});

describe("PathList", () => {
	it("says how many, shows three and +N", () => {
		const paths = Array.from({ length: 12 }, (_, index) => `src/p${index}.ts`);
		render(createElement(PathList, { paths }));
		expect(host.querySelector(".path-list-count")?.textContent).toBe("12 paths:");
		expect(host.querySelectorAll("code")).toHaveLength(3);
		expect(button()?.textContent).toBe("+9");
		expect(button()?.getAttribute("aria-label")).toBe("Show 9 more");
		click(button());
		expect(host.querySelectorAll("code")).toHaveLength(12);
		expect(button()?.textContent).toBe("Hide");
	});

	it("draws nothing for no paths, and one path whole", () => {
		render(createElement(PathList, { paths: [] }));
		expect(host.innerHTML).toBe("");
		render(createElement(PathList, { paths: ["a.ts"] }));
		expect(host.textContent).toBe("1 path:a.ts");
	});
});
