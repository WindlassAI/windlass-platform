/**
 * The docs as public pages, for the build that prerenders the site's public addresses and writes its
 * sitemap and llms.txt. Each entry has the shape that build's page list takes (`PublicPage`: path, title,
 * description, a body that renders without a browser, the page as Markdown, and its line in llms.txt), so
 * registering the docs there is one spread: `...docsPublicPages()`.
 *
 * The body is `DocsView` at that page, in the dark theme: effects do not run in a prerender, and the app
 * replaces the markup when it starts. The docs' stylesheet is imported in main.tsx, so the pages need no
 * stylesheet of their own.
 */
import { createElement, type ReactElement } from "react";
import { docsSource } from "./content";
import { DocsView } from "./Docs";
import { DOCS_PAGES, docsPath, docsTitle } from "./pages";

export interface DocsPublicPage {
	path: string;
	title: string;
	description: string;
	render(): ReactElement;
	markdown(): string;
	llms: { section: string; summary: string };
	ogType: "article";
}

/** The section the docs are listed under in llms.txt. */
export const DOCS_LLMS_SECTION = "Docs";

export function docsPublicPages(): DocsPublicPage[] {
	return DOCS_PAGES.map(page => ({
		path: docsPath(page.slug),
		title: docsTitle(page),
		description: page.description,
		render: () => createElement(DocsView, { slug: page.slug, theme: "dark", onToggleTheme: () => {} }),
		markdown: () => `# ${page.title}\n\n${page.description}\n\n${docsSource(page).trim()}\n`,
		llms: { section: DOCS_LLMS_SECTION, summary: page.description },
		ogType: "article",
	}));
}
