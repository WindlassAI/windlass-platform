import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseRoute } from "../lib/router";
import { docsSource } from "./content";
import { DocsView } from "./Docs";
import { DOCS_PAGES, DOCS_SECTIONS, docsPath, docsRoutes } from "./pages";
import { docsPublicPages } from "./public";
import { renderDocs, slugify } from "./render";
import { searchDocs } from "./search";

const contentDir = fileURLToPath(new URL("./content/", import.meta.url));

/** Every page's rendered HTML, by its address. */
const rendered = new Map(DOCS_PAGES.map((page) => [docsPath(page.slug), renderDocs(docsSource(page))]));

function idsOf(html: string): Set<string> {
	return new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1] ?? ""));
}

describe("the docs' pages", () => {
	it("each has a Markdown file, and each file a page", () => {
		const files = readdirSync(contentDir).filter((name) => name.endsWith(".md"));
		expect(new Set(DOCS_PAGES.map((page) => page.file))).toEqual(new Set(files));
		for (const page of DOCS_PAGES) expect(readFileSync(contentDir + page.file, "utf8").trim().length, page.file).toBeGreaterThan(200);
	});

	it("have unique slugs and titles, a description each, and a known section", () => {
		expect(new Set(DOCS_PAGES.map((page) => page.slug)).size).toBe(DOCS_PAGES.length);
		expect(new Set(DOCS_PAGES.map((page) => page.title)).size).toBe(DOCS_PAGES.length);
		for (const page of DOCS_PAGES) {
			expect(page.slug).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
			expect(page.description.length, page.slug).toBeGreaterThan(30);
			expect(page.description.length, page.slug).toBeLessThanOrEqual(170);
			expect(DOCS_SECTIONS).toContain(page.section);
		}
		expect(DOCS_PAGES[0]?.slug).toBe("");
	});

	it("are found by the router at their addresses", () => {
		for (const page of DOCS_PAGES) expect(parseRoute(docsPath(page.slug))).toEqual({ name: "docs", slug: page.slug });
		expect(parseRoute("/docs/")).toEqual({ name: "docs", slug: "" });
	});

	it("are listed for the build with their titles and descriptions", () => {
		const routes = docsRoutes();
		expect(routes.map((route) => route.path)).toEqual(DOCS_PAGES.map((page) => docsPath(page.slug)));
		for (const route of routes) {
			expect(route.title).toMatch(/Windlass/);
			expect(readFileSync(fileURLToPath(new URL(`../../../${route.file}`, import.meta.url)), "utf8").length).toBeGreaterThan(0);
		}
	});

	it("render, each with its headings, and without a title of their own", () => {
		for (const page of DOCS_PAGES) {
			const { html, headings } = renderDocs(docsSource(page));
			expect(html, page.slug).not.toMatch(/<h1/);
			expect(headings.length, page.slug).toBeGreaterThan(0);
			for (const heading of headings) expect(html).toContain(`id="${heading.id}"`);
			expect(new Set(headings.map((heading) => heading.id)).size, page.slug).toBe(headings.length);
		}
	});

	it("render as whole pages, with the sidebar, the page and the way on", () => {
		for (const page of DOCS_PAGES) {
			const html = renderToStaticMarkup(createElement(DocsView, { slug: page.slug, theme: "dark", onToggleTheme: () => {} }));
			expect(html).toContain('class="docs-title"');
			expect(html).toContain('aria-current="page"');
			expect(html).toContain('class="docs-prose"');
			if (page !== DOCS_PAGES[DOCS_PAGES.length - 1]) expect(html).toContain("docs-pager-next");
		}
	});

	it("are offered to the build as public pages, each rendering without a browser", () => {
		const pages = docsPublicPages();
		expect(pages.map((page) => page.path)).toEqual(DOCS_PAGES.map((page) => docsPath(page.slug)));
		for (const page of pages) {
			expect(page.title.length, page.path).toBeLessThanOrEqual(60);
			expect(renderToStaticMarkup(page.render())).toContain('class="docs-prose"');
			expect(page.markdown()).toMatch(/^# .+\n/);
		}
	});

	it("say when a page does not exist", () => {
		const html = renderToStaticMarkup(createElement(DocsView, { slug: "no-such-page", theme: "light", onToggleTheme: () => {} }));
		expect(html).toContain("No page here");
	});

	it("link only to pages and sections that exist", () => {
		const broken: string[] = [];
		for (const [from, { html }] of rendered) {
			for (const match of html.matchAll(/<a href="([^"]+)"/g)) {
				const target = (match[1] ?? "").replace(/&amp;/g, "&");
				if (/^(https?:|mailto:)/.test(target)) continue;
				const [path = "", fragment] = target.split("#");
				const page = path === "" ? rendered.get(from) : rendered.get(path);
				if (!page) {
					broken.push(`${from} → ${target}`);
					continue;
				}
				if (fragment && !idsOf(page.html).has(fragment)) broken.push(`${from} → ${target}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("make code blocks with a copy button and callouts of quotes that ask for one", () => {
		const { html } = renderDocs("```sh\ndocker logs windlass-runner\n```\n\n> **Careful** It cannot be undone.\n\n> A plain quote.");
		expect(html).toContain('data-docs-copy');
		expect(html).toContain("docker logs windlass-runner");
		expect(html).toContain('class="docs-callout docs-callout-careful"');
		expect(html).toContain("<blockquote>");
	});

	it("keep links to the docs in the tab and open others in a new one", () => {
		const { html } = renderDocs("[a](/docs/runner) [b](https://example.com) [c](/machines)");
		expect(html).toContain('<a href="/docs/runner" data-docs-link>');
		expect(html).toMatch(/href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
		expect(html).toContain('<a href="/machines">');
	});

	it("give headings ids as GitHub would", () => {
		expect(slugify("Turn limit and queueing")).toBe("turn-limit-and-queueing");
		expect(slugify("Docker, hardened")).toBe("docker-hardened");
		expect(slugify("The `run` command")).toBe("the-run-command");
	});
});

describe("search across the docs", () => {
	it("finds a command and a setting by their words", () => {
		expect(searchDocs("max-turns").slice(0, 3).map((hit) => hit.href)).toContain("/docs/runner#run-options");
		expect(searchDocs("pairing code").map((hit) => hit.page.slug)).toContain("machines");
		expect(searchDocs("protected branch")[0]?.page.slug).toBe("troubleshooting");
	});

	it("leads to sections that exist", () => {
		for (const hit of searchDocs("secret", 20)) {
			const [path = "", fragment] = hit.href.split("#");
			const page = rendered.get(path);
			expect(page, hit.href).toBeDefined();
			if (fragment) expect(idsOf(page?.html ?? "").has(fragment), hit.href).toBe(true);
		}
	});

	it("finds nothing for nothing, or for words that are not there", () => {
		expect(searchDocs("   ")).toEqual([]);
		expect(searchDocs("zzqx-not-a-word")).toEqual([]);
	});
});
