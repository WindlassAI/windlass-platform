/**
 * Check the files the image needs to build the web app.
 *   cd server && npx tsx ../scripts/web-stage-check.ts
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));

function webCopySources(): string[] {
	const sources: string[] = [];
	let inWeb = false;
	const dockerfile = readFileSync(join(root, "server/Dockerfile"), "utf8");
	for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
		const [instruction, ...args] = line.trim().split(/\s+/);
		if (instruction?.toUpperCase() === "FROM") {
			inWeb = args.at(-2)?.toUpperCase() === "AS" && args.at(-1)?.toLowerCase() === "web";
		}
		if (!inWeb || instruction?.toUpperCase() !== "COPY" || args.some(arg => arg.startsWith("--from="))) continue;
		for (const source of args.slice(0, -1).filter(arg => !arg.startsWith("--"))) {
			sources.push(posix.join(".", source).replace(/\/$/, ""));
		}
	}
	return sources;
}

// With verbatimModuleSyntax, Vite can preserve an empty runtime import for
// `import { type T } from "./types"`. Omit declarations with only type specifiers.
// Leave mixed declarations, default imports and explicit side-effect imports intact.
function onlyTypeSpecifiers(node: ts.Statement): boolean {
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		const names = clause?.namedBindings;
		return !clause?.name && !!names && ts.isNamedImports(names)
			&& names.elements.length > 0 && names.elements.every(spec => spec.isTypeOnly);
	}
	if (ts.isExportDeclaration(node)) {
		const names = node.exportClause;
		return !!names && ts.isNamedExports(names)
			&& names.elements.length > 0 && names.elements.every(spec => spec.isTypeOnly);
	}
	return false;
}

const sources = webCopySources();
const required = new Map<string, string[]>();
const cssImports = new Map<string, string[]>();
await build({
	root: join(root, "web"),
	logLevel: "error",
	build: { write: false, minify: false, sourcemap: false, reportCompressedSize: false },
	// PostCSS inlines CSS @imports before Vite constructs the module graph.
	css: { postcss: { plugins: [{
		postcssPlugin: "collect-css-imports",
		OnceExit(_root, { result }) {
			for (const message of result.messages) {
				if (message.type !== "dependency" || !message.parent) continue;
				const imports = cssImports.get(message.parent) ?? [];
				imports.push(message.file);
				cssImports.set(message.parent, imports);
			}
		},
	}] } },
	plugins: [{
		name: "check-web-stage-inputs",
		enforce: "pre",
		transform(code, id) {
			if (!/\.[cm]?tsx?$/.test(id) || id.includes("/node_modules/") || !code.includes("type")) return;
			const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest);
			const omitted = source.statements.filter(onlyTypeSpecifiers);
			if (!omitted.length) return;
			for (const node of omitted.reverse()) {
				code = code.slice(0, node.getStart(source)) + code.slice(node.end);
			}
			return code;
		},
		buildEnd(error) {
			if (error) return;
			// Breadth first so each diagnostic shows a shortest chain from an actual entry.
			const parents = new Map<string, string | null>();
			for (const id of this.getModuleIds()) {
				if (this.getModuleInfo(id)?.isEntry) parents.set(id, null);
			}
			if (!parents.size) throw new Error("Vite found no web build entries.");
			for (const id of parents.keys()) {
				const file = localFile(id);
				if (file && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
				const info = this.getModuleInfo(id);
				const imports = info ? [...info.importedIds, ...info.dynamicallyImportedIds] : [];
				for (const dep of imports.concat(cssImports.get(id) ?? [])) {
					if (!parents.has(dep)) parents.set(dep, id);
				}
				if (!file || file.startsWith("web/") || required.has(file)) continue;
				const chain: string[] = [];
				for (let step: string | null = id; step !== null; step = parents.get(step) ?? null) {
					const path = localFile(step);
					if (path) chain.push(path);
				}
				required.set(file, chain.reverse());
			}
		},
	}],
});

function localFile(id: string): string | undefined {
	const [path] = id.split("?");
	if (!path || !isAbsolute(path)) return;
	const file = relative(root, path);
	if (!file.startsWith("../") && !file.split("/").includes("node_modules")) return file;
}

for (const [file, chain] of required) {
	if (sources.some(source => source === "." || file === source || file.startsWith(source + "/"))) continue;
	console.error(`FAIL  The web stage is missing ${file}, imported via ${chain.join(" -> ")}.`);
	process.exitCode = 1;
}
if (!process.exitCode) console.log(`PASS  The web stage copies all ${required.size} bundled files outside web/.`);
