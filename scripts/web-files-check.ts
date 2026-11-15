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
writeFileSync(join(site, "index.html"), "<!doctype html><title>app</title>\n");
writeFileSync(join(site, "assets", "app-abc123.js"), "console.log(1)\n");
writeFileSync(join(site, "assets", "app-abc123.js.map"), "{}\n");
writeFileSync(join(root, "outside.txt"), "not the web app's\n");

const HTML = "200 text/html; charset=utf-8 no-cache";
const cases: Array<[method: string, address: string, want: string]> = [
	["GET", "/", HTML],
	["GET", "/agents/s_123", HTML],
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
];

let passed = 0;
let failed = 0;
try {
	const serve = webFiles(site);
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
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(`\n${failed === 0 ? "ALL PASSED: " : ""}${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
