import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const { dirname, join, relative, resolve, matchesGlob } = posix;
const root = "/";

const commandStart = /^(?:cd|node|npx|npm|pnpm|tsx|bash|sh|corepack)\s|^(?:[A-Z_][A-Z_0-9]*=(?:"[^"]*"|'[^']*'|\S+)|(?:\.{0,2}\/)?[\w./-]+\.sh)\s/;
const pathLike = /^(?:\.{1,2}\/|[\w.*-]+\/|[\w*-][\w.*-]*\.[\w-]+$)/;

export function guideTree(files: string[], read: (path: string) => string | undefined, hasBin?: (dir: string, tool: string) => boolean) {
	const paths = new Set(files);
	const dirs = new Set([""]);
	for (const file of paths) {
		for (let dir = dirname(file); dir !== "." && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
	}
	for (const dir of dirs) paths.add(dir);
	return { files, paths, dirs, read, hasBin };
}

export function checkGuide(guide: string, contents: string, { files, dirs, paths, read, hasBin }: ReturnType<typeof guideTree>) {
	const errors: { path: string; line: number; message: string }[] = [];
	function manifest(dir: string) {
		try { return JSON.parse(read(relative(root, join(dir, "package.json"))) ?? "{}"); }
		catch { return {}; }
	}
	const lines = contents.split(/\r?\n/);
	const here = dirname(join(root, guide));
	let line = 0;
	const fail = (message: string) => errors.push({ path: guide, line: line + 1, message });

	function checkPath(target: string, cwd: string) {
		const path = resolve(cwd, target);
		const found = target.includes("*") ? files.some(f => matchesGlob(f, relative(root, path))) : paths.has(relative(root, path));
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
				if (!dirs.has(relative(root, cwd))) fail(`missing directory ${relative(root, cwd)}`);
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
				dir = resolve(dir, args[1] ?? ".");
				args.splice(0, 2);
			}
			if ((tool === "pnpm" && args[0] !== "exec") || (tool === "npm" && args[0] === "run")) {
				if (args[0] === "run") args.shift();
				const script = args.shift();
				if (script && script !== "install" && !Object.hasOwn(manifest(dir)?.scripts ?? {}, script)) {
					fail(`missing script "${script}" in ${relative(root, join(dir, "package.json"))}`);
				}
			} else if (tool === "npx" || tool === "pnpm") {
				if (tool === "pnpm") args.shift();
				tool = args.shift();
				if (tool && hasBin && !hasBin(relative(root, dir), tool)) fail(`missing executable ${tool} in ${relative(root, dir)}`);
			}
			for (const [i, arg] of args.entries()) {
				if (args[i - 1] !== "--base" && pathLike.test(arg)) checkPath(arg, dir);
			}
			if (tool && ["node", "tsx", "bash", "sh"].includes(tool) && args[0] && !args[0].startsWith("-")) checkPath(args[0], dir);
			if (tool === "tsc" && args.includes("-p")) {
				const project = resolve(dir, args[args.indexOf("-p") + 1] ?? ".");
				checkPath(dirs.has(relative(root, project)) ? join(project, "tsconfig.json") : project, dir);
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
			for (const match of prose.matchAll(/(?:^|[\s(])((?:[.\w*-]+\/)*[\w*-][\w.*-]*\.(?:[cm]?[jt]sx?|md|json|ya?ml|sh|py|css)|(?:server|web|runner|scripts|sandbox|docs|fixtures|deploy|\.github)\/[\w./*-]+)(?=[\s.,:;)!?]|$)/g)) {
				checkPath(match[1], here);
			}
		}
		line++;
	}
	return errors;
}

if (import.meta.main) {
	const checkout = fileURLToPath(new URL("../", import.meta.url));
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: checkout, encoding: "utf8",
	}).split("\0").filter(file => file && existsSync(join(checkout, file)));
	const guides = files.filter(file => /(^|\/)AGENTS\.md$/.test(file));
	const tree = guideTree(files, path => existsSync(join(checkout, path)) ? readFileSync(join(checkout, path), "utf8") : undefined,
		(dir, tool) => existsSync(join(checkout, dir, "node_modules/.bin", tool)));
	const errors = guides.flatMap(path => checkGuide(path, readFileSync(join(checkout, path), "utf8"), tree));
	if (errors.length) {
		for (const { path, line, message } of errors) console.error(`${path}:${line}: ${message}`);
		process.exitCode = 1;
	} else console.log(`Checked paths and command targets in ${guides.length} AGENTS.md files.`);
}
