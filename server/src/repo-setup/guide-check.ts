import { posix } from "node:path";

const { dirname, join, relative, resolve, matchesGlob } = posix;
const root = "/";

const commandStart =
	/^(?:test|ls|cd|node|npx|npm|pnpm|bun|tsx|bash|sh|corepack)\s|^(?:[A-Z_][A-Z_0-9]*=(?:"[^"]*"|'[^']*'|\S+)|(?:\.{0,2}\/)?[\w./-]+\.sh)\s/;
const glob = /[*?\[{]/;
const pathLike = /^(?:\.{1,2}\/|[\w.*-]+\/|[\w*-][\w.*-]*\.[\w-]+$)/;

// Paths named in guides and skills start at the checkout unless explicitly file-relative.
export function guideReference(guide: string, target: string) {
	return relative(root, resolve(root, /^\.{1,2}\//.test(target) ? dirname(guide) : "", target));
}

export function guideTree(
	files: string[],
	read: (path: string) => string | undefined,
	hasBin?: (dir: string, tool: string) => boolean,
) {
	const paths = new Set(files);
	const dirs = new Set([""]);
	for (const file of paths) {
		for (let dir = dirname(file); dir !== "." && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
	}
	for (const dir of dirs) paths.add(dir);
	return { files, paths, dirs, read, hasBin };
}

export function checkGuide(
	guide: string,
	contents: string,
	{ files, dirs, paths, read, hasBin }: ReturnType<typeof guideTree>,
	citedCommand?: (line: number, command: string) => boolean,
) {
	const errors: { path: string; line: number; message: string }[] = [];
	function manifest(dir: string) {
		try {
			return JSON.parse(read(relative(root, join(dir, "package.json"))) ?? "{}");
		} catch {
			return {};
		}
	}
	const lines = contents.split(/\r?\n/);
	let line = 0;
	const fail = (message: string) => errors.push({ path: guide, line: line + 1, message });

	function checkPath(target: string, cwd: string) {
		const path = relative(root, resolve(cwd, target));
		const found = glob.test(target) ? files.some(f => matchesGlob(f, path)) : paths.has(path);
		const fromRoot = path.split("/").slice(1).join("/");
		if (!found)
			fail(
				fromRoot && paths.has(fromRoot)
					? `missing path ${path}: write paths from the repository root, such as ${fromRoot}`
					: `missing path ${path}`,
			);
	}

	function command(source: string, cwd: string) {
		const verified = citedCommand?.(line + 1, source.trim());
		for (const step of source.split(/\s*&&\s*/)) {
			const words = step.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
			const args = words.map(word => word.replace(/['"]/g, ""));
			while (/^[A-Z_][A-Z_0-9]*=/.test(args[0] ?? "")) args.shift();
			let tool = args.shift();
			if (!tool || tool.startsWith("#")) continue;
			if (pathLike.test(tool)) checkPath(tool, cwd);
			if (tool === "test" && /^-[efrd]$/.test(args[0]) && args[1] && !/[$`]/.test(args[1])) {
				checkPath(args[1], cwd);
				continue;
			}
			if (tool === "cd" && args[0]) {
				cwd = resolve(cwd, args[0]);
				if (!dirs.has(relative(root, cwd))) fail(`missing directory ${relative(root, cwd)}`);
				continue;
			}
			let dir = cwd;
			if (tool === "pnpm" && args[0] === "--filter") {
				const name = args[1];
				const pkg = files.find(
					file => file.endsWith("/package.json") && manifest(dirname(join(root, file)))?.name === name,
				);
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
			if ((tool === "pnpm" && args[0] !== "exec") || (["npm", "bun"].includes(tool) && args[0] === "run")) {
				if (args[0] === "run") args.shift();
				const script = args.shift();
				// pnpm also has builtins such as audit that need no package script.
				if (script && script !== "install" && !verified && !Object.hasOwn(manifest(dir)?.scripts ?? {}, script)) {
					fail(`missing script "${script}" in ${relative(root, join(dir, "package.json"))}`);
				}
			} else if (tool === "npx" || tool === "pnpm") {
				if (tool === "pnpm") args.shift();
				tool = args.shift();
				if (tool && hasBin && !hasBin(relative(root, dir), tool))
					fail(`missing executable ${tool} in ${relative(root, dir)}`);
			}
			for (const [i, arg] of args.entries()) {
				const value = arg.replace(/^--[\w-]+=/, "");
				if (args[i - 1] !== "--base" && !arg.startsWith("--base=") && pathLike.test(value)) checkPath(value, dir);
			}
			if (tool && ["node", "tsx", "bash", "sh"].includes(tool) && args[0] && !args[0].startsWith("-"))
				checkPath(args[0], dir);
			if (tool === "tsc" && args.includes("-p")) {
				const project = resolve(dir, args[args.indexOf("-p") + 1] ?? ".");
				checkPath(dirs.has(relative(root, project)) ? join(project, "tsconfig.json") : project, dir);
			}
		}
		return cwd;
	}

	const checkingSkill = skillPath.test(guide);
	function reference(target: string) {
		const path = guideReference(guide, target);
		checkPath(!target.includes("/") && glob.test(target) ? "**/" + path : path, root);
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
		} else if (checkingSkill && commandStart.test(contents.trim())) {
			command(contents.trim(), root);
		} else {
			const prose = contents
				.replace(/`([^`]+)`/g, (_, code: string) => {
					if (commandStart.test(code)) command(code, root);
					else if (/^--?[a-z][\w-]*[=\s]/i.test(code)) {
						const value = code.replace(/^--?[\w-]+[=\s]+/, "").replace(/^(["'])(.*)\1$/, "$2");
						if (pathLike.test(value)) checkPath(value, root);
					} else if (!/\s/.test(code) && (pathLike.test(code) || glob.test(code))) reference(code);
					return "";
				})
				.replace(/\]\(([^)]+)\)/g, (_, link: string) => {
					const target = link.split("#")[0];
					if (target && !/^(?:\w+:|\/\/)/.test(target)) reference(target);
					return "";
				});
			for (const match of prose.matchAll(
				/(?:^|[\s(])((?:[.\w*-]+\/)*[\w*-][\w.*-]*\.(?:[cm]?[jt]sx?|md|json|ya?ml|sh|py|css)|(?:packages|server|web|runner|scripts|sandbox|docs|fixtures|deploy|\.github|\.{1,2})\/[\w./*-]+)(?=[\s.,:;)!?]|$)/g,
			)) {
				reference(match[1].replace(/\.$/, ""));
			}
		}
		line++;
	}
	return errors;
}

export const skillPath = /^\.agents\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
export const isGuide = (path: string) => /(^|\/)AGENTS\.md$/.test(path) || skillPath.test(path);
