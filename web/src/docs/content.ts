/** The docs' Markdown, built into the docs' own chunk: each page's text by its `file` (pages.ts). */
import { DOCS_PAGES, type DocsPage } from "./pages";

const files = import.meta.glob<string>("./content/*.md", { query: "?raw", import: "default", eager: true });

/** A page's Markdown. A page in the list without its file is a mistake the docs' test catches. */
export function docsSource(page: DocsPage): string {
	return files[`./content/${page.file}`] ?? "";
}

/** Every page with its text, in reading order. */
export function docsWithSources(): { page: DocsPage; source: string }[] {
	return DOCS_PAGES.map(page => ({ page, source: docsSource(page) }));
}
