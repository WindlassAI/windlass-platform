import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	cwd: root, encoding: "utf8",
}).split("\0").filter(Boolean);
const guides = files.filter(file => /(^|\/)AGENTS\.md$/.test(file) && existsSync(join(root, file)));
const errors = new Set<string>();
const commandStart = /^(?:cd|node|npx|pnpm|tsx|bash|sh|corepack)\s|^(?:[A-Z_][A-Z_0-9]*=(?:"[^"]*"|'[^']*'|\S+)|(?:\.{0,2}\/)?[\w./-]+\.sh)\s/;
const pathLike = /^(?:\.{1,2}\/|[\w.*-]+\/|[\w*-][\w.*-]*\.[\w-]+$)/;

function manifest(dir: string) {
	const file = join(dir, "package.json");
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
}

function checkGuide(guide: string) {
	const lines = readFileSync(join(root, guide), "utf8").split(/\r?\n/);
	const here = dirname(join(root, guide));
	let line = 0;
	const fail = (message: string) => errors.add(`${guide}:${line + 1}: ${message}`);

	function checkPath(target: string, cwd: string) {
		const path = resolve(cwd, target);
		const found = target.includes("*") ? globSync(target, { cwd }).length > 0 : existsSync(path);
		if (!found) fail(`missing path ${relative(root, path)}`);
	}

	function command(source: string, cwd: string) {
		for (const step of source.split(/\s*&&\s*/)) {
			const words = step.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
			const args = words.map(word => word.replace(/['"]/g, ""));
			while (/^[A-Z_][A-Z_0-9]*=/.test(args[0] ?? "")) args.shift();
			let tool = args.shift();
			if (!tool || tool.startsWith("#")) continue;
			if (pathLike.test(tool)) checkPath(tool, cwd);
			if (tool === "cd" && args[0]) {
				cwd = resolve(cwd, args[0]);
				if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) fail(`missing directory ${relative(root, cwd)}`);
				continue;
			}
			let dir = cwd;
			if (tool === "pnpm" && args[0] === "--filter") {
				const name = args[1];
				const pkg = files.find(file => file.endsWith("/package.json") && manifest(dirname(join(root, file)))?.name === name);
				if (!pkg) {
					fail(`unknown workspace ${name}`);
					continue;
				}
				dir = dirname(join(root, pkg));
				args.splice(0, 2);
			}
			if (tool === "pnpm" && ["--dir", "-C"].includes(args[0])) {
				dir = resolve(dir, args[1]);
				args.splice(0, 2);
			}
			if (tool === "pnpm" && args[0] !== "exec") {
				if (args[0] === "run") args.shift();
				const script = args.shift();
				if (script && script !== "install" && !Object.hasOwn(manifest(dir)?.scripts ?? {}, script)) {
					fail(`missing script "${script}" in ${relative(root, join(dir, "package.json"))}`);
				}
			} else if (tool === "npx" || tool === "pnpm") {
				if (tool === "pnpm") args.shift();
				tool = args.shift();
				if (tool && !existsSync(join(dir, "node_modules/.bin", tool))) fail(`missing executable ${tool} in ${relative(root, dir)}`);
			}
			for (const [i, arg] of args.entries()) {
				if (args[i - 1] !== "--base" && pathLike.test(arg)) checkPath(arg, dir);
			}
			if (tool && ["node", "tsx", "bash", "sh"].includes(tool) && args[0] && !args[0].startsWith("-")) checkPath(args[0], dir);
			if (tool === "tsc" && args.includes("-p")) {
				const project = resolve(dir, args[args.indexOf("-p") + 1]);
				checkPath(statSync(project, { throwIfNoEntry: false })?.isDirectory() ? join(project, "tsconfig.json") : project, dir);
			}
		}
		return cwd;
	}

	let fence: string | undefined;
	let cwd = root;
	for (const contents of lines) {
		const marker = contents.trim().match(/^```(\w*)/);
		if (marker) {
			fence = fence === undefined ? marker[1] : undefined;
			cwd = root;
		} else if (fence !== undefined) {
			if (["", "sh", "bash", "shell"].includes(fence)) cwd = command(contents, cwd);
		} else {
			const prose = contents.replace(/`([^`]+)`/g, (_, code: string) => {
				if (commandStart.test(code)) command(code, root);
				else if (!/\s/.test(code) && pathLike.test(code)) checkPath(code, here);
				return "";
			}).replace(/\]\(([^)]+)\)/g, (_, link: string) => {
				const target = link.split("#")[0];
				if (target && !/^(?:\w+:|\/\/)/.test(target)) checkPath(target, here);
				return "";
			});
			// Also catch ordinary unformatted filenames and repository paths in prose.
			for (const match of prose.matchAll(/(?:^|[\s(])((?:[.\w*-]+\/)*[\w*-][\w.*-]*\.(?:[cm]?[jt]sx?|md|json|ya?ml|sh|py|css)|(?:server|web|runner|scripts|sandbox|docs|fixtures|deploy|\.github)\/[\w./*-]+)(?=[\s.,:;)!?]|$)/g)) {
				checkPath(match[1], here);
			}
		}
		line++;
	}
}

for (const guide of guides) checkGuide(guide);
if (errors.size) {
	console.error([...errors].join("\n"));
	process.exitCode = 1;
} else {
	console.log(`Checked paths and command targets in ${guides.length} AGENTS.md files.`);
}
