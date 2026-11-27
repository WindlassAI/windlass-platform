import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Node runs this wrapper directly in CI.
// @ts-expect-error The native TypeScript loader requires the source extension.
import { checkGuide, guideTree, isGuide } from "../server/src/repo-setup/guide-check.ts";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	cwd: checkout,
	encoding: "utf8",
})
	.split("\0")
	.filter(file => file && existsSync(join(checkout, file)));
const guides = files.filter(isGuide);
const tree = guideTree(
	files,
	path => (existsSync(join(checkout, path)) ? readFileSync(join(checkout, path), "utf8") : undefined),
	(dir, tool) => existsSync(join(checkout, dir, "node_modules/.bin", tool)),
);
const errors = guides.flatMap(path => checkGuide(path, readFileSync(join(checkout, path), "utf8"), tree));
if (errors.length) {
	for (const { path, line, message } of errors) console.error(`${path}:${line}: ${message}`);
	process.exitCode = 1;
} else console.log(`Checked paths and command targets in ${guides.length} guide files.`);
