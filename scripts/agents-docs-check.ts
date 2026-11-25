import { checkGuides } from "../server/src/repo-setup/guide-check.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	cwd: root, encoding: "utf8",
}).split("\0").filter(file => file && existsSync(join(root, file)));
const guides = files.filter(file => /(^|\/)AGENTS\.md$/.test(file));
const errors = checkGuides(new Map(guides.map(path => [path, readFileSync(join(root, path), "utf8")])), files,
	path => existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined,
	(dir, tool) => existsSync(join(root, dir, "node_modules/.bin", tool)));
if (errors.length) {
	for (const { path, line, message } of errors) console.error(`${path}:${line}: ${message}`);
	process.exitCode = 1;
} else console.log(`Checked paths and command targets in ${guides.length} AGENTS.md files.`);
