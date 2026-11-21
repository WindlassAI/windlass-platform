/**
 * The public pages, prerendered at build time. After `vite build` has written the app, this renders
 * every page of src/site/pages.tsx to static HTML that links the app's own stylesheet, keeps the app's
 * shell as app.html, and writes sitemap.xml, robots.txt, llms.txt and llms-full.txt beside them
 * (src/site/render.tsx). The server (server/src/web.ts) answers an address with `<path>/index.html`
 * where the build wrote one, and with app.html otherwise; `vite preview` does the same here.
 *
 * The pages are loaded through a Vite server of their own, so they compile exactly as the app does
 * (TypeScript, JSX, the `@contract` alias, `import.meta.env`). A build that does not write files (the
 * web stage check's) writes no pages either.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, type Plugin, type ResolvedConfig } from "vite";
import type { AppAssets } from "./src/site/documents";
import type { SiteFile } from "./src/site/render";

/** The fonts the landing's first paint is set in: the display serif, upright and italic, latin only. */
const PRELOAD_FONTS = [/^newsreader-latin-opsz-normal-[\w-]+\.woff2$/, /^newsreader-latin-opsz-italic-[\w-]+\.woff2$/];

/** What the built index.html links: its stylesheets and its entry module. */
export function appAssets(builtIndex: string, assetFiles: string[]): AppAssets {
	const stylesheets = [...builtIndex.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] as string);
	const entry = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(builtIndex)?.[1];
	if (!entry || stylesheets.length === 0) throw new Error("The built index.html has no entry module or no stylesheet to give the public pages.");
	const fonts = PRELOAD_FONTS.flatMap((pattern) => assetFiles.filter((file) => pattern.test(file)).slice(0, 1)).map((file) => `/assets/${file}`);
	return { stylesheets, entry, fonts };
}

export function publicSite({ alias }: { alias: Record<string, string> }): Plugin {
	let config: ResolvedConfig;
	return {
		name: "wlp-public-site",
		configResolved(resolved) {
			config = resolved;
		},
		async closeBundle() {
			if (config.command !== "build" || config.build.ssr || config.build.write === false) return;
			const outDir = resolve(config.root, config.build.outDir);
			const builtIndex = readFileSync(join(outDir, "index.html"), "utf8");
			const assetsDir = join(outDir, config.build.assetsDir);
			const assets = appAssets(builtIndex, existsSync(assetsDir) ? readdirSync(assetsDir) : []);

			const server = await createServer({
				root: config.root,
				mode: config.mode,
				envDir: config.envDir,
				configFile: false,
				logLevel: "error",
				appType: "custom",
				resolve: { alias },
				plugins: [react()],
				server: { middlewareMode: true, hmr: false, ws: false },
				optimizeDeps: { noDiscovery: true, include: [] },
			});
			try {
				const { renderSite } = (await server.ssrLoadModule("/src/site/render.tsx")) as { renderSite(assets: AppAssets, builtIndex: string): SiteFile[] };
				const files = renderSite(assets, builtIndex);
				for (const { file, text } of files) {
					const path = resolve(outDir, file);
					if (!path.startsWith(outDir + sep)) throw new Error(`A public page would be written outside the build: ${file}`);
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, text);
				}
				config.logger.info(`public pages: ${files.map((entry) => entry.file).join(", ")}`);
			} finally {
				await server.close();
			}
		},
		// `vite preview` answers as the server does: a public page's file where there is one, the app's shell otherwise.
		configurePreviewServer(server) {
			const outDir = resolve(server.config.root, server.config.build.outDir);
			server.middlewares.use((request, _response, next) => {
				const url = new URL(request.url ?? "/", "http://preview");
				if ((request.method === "GET" || request.method === "HEAD") && extname(url.pathname) === "") {
					const page = resolve(outDir, `.${decodeURIComponent(url.pathname)}`, "index.html");
					const served = page.startsWith(outDir + sep) && existsSync(page) ? page.slice(outDir.length).split(sep).join("/") : "/app.html";
					request.url = served + url.search;
				}
				next();
			});
		},
	};
}
