/**
 * The build's way into the public pages (web/site-build.ts loads this through Vite, so the pages are
 * compiled as the app is): each page's file and its whole HTML, and the site's other files.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
	appShellHtml,
	fileOf,
	llmsFullTxt,
	llmsTxt,
	pageHtml,
	robotsTxt,
	sitemapXml,
	type AppAssets,
} from "./documents";
import { PUBLIC_PAGES } from "./pages";

export interface SiteFile {
	/** Relative to the build's directory. */
	file: string;
	text: string;
}

export function renderSite(assets: AppAssets, builtIndex: string): SiteFile[] {
	const paths = new Set<string>();
	for (const page of PUBLIC_PAGES) {
		if (
			!/^\/(?:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)?$/.test(page.path) ||
			/\.[a-z0-9]+$/i.test(page.path)
		) {
			throw new Error(
				`A public page's path must be "/" or lowercase segments without a trailing slash or an extension: ${page.path}`,
			);
		}
		if (page.path === "/app" || page.path.startsWith("/assets"))
			throw new Error(`A public page cannot take ${page.path}: the app's files are there.`);
		if (paths.has(page.path)) throw new Error(`Two public pages have the path ${page.path}.`);
		paths.add(page.path);
	}
	return [
		// The app's shell first: the landing takes index.html after it.
		{ file: "app.html", text: appShellHtml(builtIndex) },
		...PUBLIC_PAGES.map(page => ({
			file: fileOf(page),
			text: pageHtml(page, renderToStaticMarkup(page.render()), assets),
		})),
		{ file: "sitemap.xml", text: sitemapXml(PUBLIC_PAGES) },
		{ file: "robots.txt", text: robotsTxt() },
		{ file: "llms.txt", text: llmsTxt(PUBLIC_PAGES) },
		{ file: "llms-full.txt", text: llmsFullTxt(PUBLIC_PAGES) },
	];
}
