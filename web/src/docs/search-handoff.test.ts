// @vitest-environment jsdom
/**
 * The docs' search when the app takes over the prerendered page: what the visitor typed into the static field
 * while the docs' chunk loaded, and where the caret was, is carried into the app's field.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DocsView, takeStaticSearch } from "./Docs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

function staticPage(): HTMLElement {
	const container = document.createElement("div");
	container.id = "root";
	container.setAttribute("data-public", "");
	container.innerHTML = renderToStaticMarkup(
		createElement(DocsView, { slug: "sessions", theme: "dark", onToggleTheme: () => {} }),
	);
	document.body.replaceChildren(container);
	return container;
}

afterEach(() => document.body.replaceChildren());

describe("the docs' search on a prerendered page", () => {
	it("marks the bar's field, and only that one, for the static page's keys", () => {
		expect(staticPage().querySelectorAll("input[data-docs-search]")).toHaveLength(1);
	});

	it("reads nothing from a field nobody touched", () => {
		expect(takeStaticSearch(staticPage())).toBeNull();
	});

	it("carries the query, the focus and the caret into the app's field", () => {
		const container = staticPage();
		const field = container.querySelector<HTMLInputElement>("input[data-docs-search]");
		if (!field) throw new Error("no search field");
		field.focus();
		field.value = "steer";
		field.setSelectionRange(2, 2);
		const taken = takeStaticSearch(container);
		expect(taken).toEqual({ query: "steer", focused: true, selection: [2, 2] });

		container.replaceChildren();
		const root = createRoot(container);
		flushSync(() =>
			root.render(
				createElement(DocsView, {
					slug: "sessions",
					theme: "dark",
					onToggleTheme: () => {},
					initialSearch: taken ?? undefined,
				}),
			),
		);
		const app = container.querySelector<HTMLInputElement>("input[data-docs-search]");
		expect(app?.value).toBe("steer");
		expect(document.activeElement).toBe(app);
		expect([app?.selectionStart, app?.selectionEnd]).toEqual([2, 2]);
		root.unmount();
	});
});
