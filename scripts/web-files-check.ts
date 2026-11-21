/**
 * Checks server/src/web.ts, which serves the web app's built files: the app's page for its addresses,
 * the files under assets/ with a cache that never ends, no source maps, and nothing from outside the
 * directory whatever the address looks like.
 *
 *   cd server && npx tsx ../scripts/web-files-check.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webFiles } from "../server/src/web.js";

const root = mkdtempSync(join(tmpdir(), "wlp-web-files-"));
const site = join(root, "site");
mkdirSync(join(site, "assets"), { recursive: true });
writeFileSync(join(site, "index.html"), "<!doctype html><title>landing</title>\n");
writeFileSync(join(site, "assets", "app-abc123.js"), "console.log(1)\n");
writeFileSync(join(site, "assets", "app-abc123.js.map"), "{}\n");
writeFileSync(join(root, "outside.txt"), "not the web app's\n");
// The public pages the build prerenders (web/site-build.ts): the landing takes index.html, a page of its own
// directory takes <path>/index.html, and the app's shell is app.html.
writeFileSync(join(site, "app.html"), "<!doctype html><title>shell</title>\n");
mkdirSync(join(site, "docs", "start"), { recursive: true });
writeFileSync(join(site, "docs", "start", "index.html"), "<!doctype html><title>docs start</title>\n");
writeFileSync(join(site, "sitemap.xml"), "<?xml version=\"1.0\"?><urlset/>\n");
writeFileSync(join(site, "robots.txt"), "User-agent: *\n");
// A build from before there were public pages: index.html is the shell, and there is no app.html.
const legacy = join(root, "legacy");
mkdirSync(legacy);
writeFileSync(join(legacy, "index.html"), "<!doctype html><title>legacy shell</title>\n");

const HTML = "200 text/html; charset=utf-8 no-cache";
const cases: Array<[method: string, address: string, want: string]> = [
	["GET", "/", HTML],
	["GET", "/agents/s_123", HTML],
	["GET", "/repositories/7101", HTML],
	["GET", "/repositories/7101/new", HTML],
	["GET", "/assets", HTML],
	["GET", "/assets/app-abc123.js", "200 text/javascript; charset=utf-8 public, max-age=31536000, immutable"],
	["HEAD", "/assets/app-abc123.js", "200 text/javascript; charset=utf-8 public, max-age=31536000, immutable"],
	["GET", "/assets/app-abc123.js.map", "none"],
	["GET", "/assets/missing.js", "none"],
	["GET", "/../outside.txt", "none"],
	["GET", "/%2e%2e/outside.txt", "none"],
	["GET", "/..%2foutside.txt", "none"],
	["GET", "/assets/..%2f..%2foutside.txt", "none"],
	["GET", "/%00", "none"],
	["GET", "/%zz", "none"],
	["POST", "/", "none"],
	["GET", "/docs/start", HTML],
	["GET", "/sitemap.xml", "200 application/xml; charset=utf-8 no-cache"],
	["GET", "/robots.txt", "200 text/plain; charset=utf-8 no-cache"],
];

/** Which file an address is answered with, by the served page's title. */
const pages: Array<[directory: string, address: string, title: string]> = [
	[site, "/", "landing"],
	[site, "/index.html", "landing"],
	[site, "/agents/s_123", "shell"],
	[site, "/signin", "shell"],
	[site, "/factory", "shell"],
	[site, "/assets", "shell"],
	[site, "/docs/start", "docs start"],
	[site, "/docs/start/", "docs start"],
	[site, "/docs", "shell"],
	[site, "/docs/missing", "shell"],
	[site, "/docs/%2e%2e/%2e%2e/agents", "shell"],
	[legacy, "/", "legacy shell"],
	[legacy, "/agents/s_123", "legacy shell"],
];

let passed = 0;
let failed = 0;
try {
	const serve = webFiles(site);
	for (const scheme of ["http", "https"]) {
		const secure = scheme === "https";
		const origin = scheme + "://engine.example:7443";
		const socket = (secure ? "wss" : "ws") + "://engine.example:7443";
		const served = webFiles(site, { publicUrl: scheme + "://app.example", endpoint: origin + "/prefix" });
		const response = await served(new Request("http://internal/agents/fixture"));
		const csp = response?.headers.get("content-security-policy") ?? "";
		const hsts = response?.headers.get("strict-transport-security");
		for (const [name, ok] of [
			["scoped HTTP and WebSocket connections", csp.split("; ").includes("connect-src 'self' " + origin + " " + socket)],
			["frame, object, base and script restrictions", ["frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "script-src 'self'"].every(rule => csp.split("; ").includes(rule))],
			["app styles and images", ["style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:"].every(rule => csp.split("; ").includes(rule))],
			["HSTS follows the external web origin", secure ? hsts === "max-age=31536000" : hsts === null],
		] as const) {
			console.log((ok ? "PASS" : "FAIL") + "  " + scheme + " " + name);
			if (ok) passed++; else failed++;
		}
	}
	for (const [method, address, want] of cases) {
		const response = await serve(new Request(`http://web.test${address}`, { method }));
		const body = response ? (await response.arrayBuffer()).byteLength : 0;
		let got = response ? `${response.status} ${response.headers.get("content-type")} ${response.headers.get("cache-control")}` : "none";
		if (response && method === "HEAD" && body !== 0) got += " (with a body)";
		if (response && method === "GET" && body === 0) got += " (without a body)";
		const ok = got === want;
		console.log(`${ok ? "PASS" : "FAIL"}  ${method} ${address}  ->  ${got}${ok ? "" : `   (wanted ${want})`}`);
		if (ok) passed += 1;
		else failed += 1;
	}
	for (const [directory, address, want] of pages) {
		const response = await webFiles(directory)(new Request(`http://web.test${address}`));
		const got = response ? (/<title>([^<]*)<\/title>/.exec(await response.text())?.[1] ?? "no title") : "none";
		const ok = got === want;
		console.log(`${ok ? "PASS" : "FAIL"}  GET ${address}${directory === legacy ? " (a build without app.html)" : ""}  ->  ${got}${ok ? "" : `   (wanted ${want})`}`);
		if (ok) passed += 1;
		else failed += 1;
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(`\n${failed === 0 ? "ALL PASSED: " : ""}${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
