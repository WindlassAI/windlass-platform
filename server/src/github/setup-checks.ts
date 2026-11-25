import { minimatch } from "minimatch";
import { parse } from "yaml";
import type { ScanEntry } from "../repository-network.js";
import type { Finding } from "../factory/readiness.js";
import { GithubError, type GithubApp, type Repository } from "./app.js";

export interface SetupScan { commit: string | null; findings: Finding[]; areas: string[]; later: number }
const workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const source = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|sh|vue|svelte|dart|exs?|hs|lua)$/i;
const generated = /(?:^|\/)(?:node_modules|vendor|third_party|generated|__generated__|dist|build|target|coverage)\/|(?:\.min|\.generated|\.g|\.pb)\.[^/]+$/i;
function folders(path: string) {
	const parts = path.split("/").slice(0, -1);
	if (parts.some(p => !/^[\w.-]+$/.test(p) || [".", "..", ".git"].includes(p.toLowerCase()))) return [];
	return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
const bytesPerFile = 1024 * 1024;

function ignored(text: string, path: string) {
	let ignored = false;
	for (const line of text.split(/\r?\n/)) {
		const rule = line.trimEnd();
		if (!rule || rule.startsWith("#")) continue;
		const pattern = rule.replace(/^!/, "");
		if (minimatch(path, pattern.replace(/^\//, ""), { nonegate: true, dot: true, matchBase: !pattern.includes("/") })) ignored = !rule.startsWith("!");
	}
	return ignored;
}

export async function scanRepoSetup(app: GithubApp, token: string, repo: Repository): Promise<SetupScan> {
	let paths: string[] = [];
	let sources: ScanEntry[] = [];
	let truncated = false;
	const scan = await app.scanFiles(token, repo.owner, repo.name, repo.defaultBranch, (tree, short) => {
		const entries = tree.filter(f => f.type === "blob");
		paths = entries.map(f => f.path);
		truncated = short;
		const config = entries.filter(f => workflow.test(f.path) || f.path === ".gitignore");
		// Fewer than 1,501 bytes cannot contain more than 1,500 lines. Read the largest candidates first.
		sources = entries.filter(f => source.test(f.path) && f.mode !== "120000" && !generated.test(f.path));
		const large = sources.filter(f => (f.size ?? Infinity) > 1500).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
		// Small files can collectively meet the line threshold. Skip folders already qualified by count.
		const totals = new Map<string, { files: number; bytes: number }>();
		for (const file of sources) for (const dir of folders(file.path)) {
			const total = totals.get(dir) ?? { files: 0, bytes: 0 };
			total.files++;
			total.bytes += file.size ?? bytesPerFile;
			totals.set(dir, total);
		}
		const small = sources.filter(f => f.size !== null && f.size <= 1500 && folders(f.path).some(dir => {
			const t = totals.get(dir)!;
			return t.files < 50 && t.bytes + t.files >= 5000;
		}));
		const selected = [...config, ...large, ...small].filter(f => f.size === null || f.size <= bytesPerFile).slice(0, 96).map(f => f.path);
		return { paths: selected, more: false, maxBytes: 6 * bytesPerFile, maxFileBytes: bytesPerFile };
	}).catch((error: unknown) => {
		if (error instanceof GithubError && error.status === 409 && /repository is empty/i.test(error.said))
			return { commit: null, files: [] };
		throw error;
	});
	const files = new Map(scan.files.map(f => [f.path, f.text]));
	const known = new Set(paths);
	const rootGuide = paths.find(p => /^(AGENTS|CLAUDE)\.md$/.test(p));
	const dirs = new Map<string, number>();
	const lines = new Map<string, number>();
	let oversized: string | undefined;
	let unreadSource = truncated;
	for (const entry of sources) {
		const text = files.get(entry.path);
		const sourceLines = text ? text.replace(/\n$/, "").split("\n").length : 0;
		for (const dir of folders(entry.path)) {
			lines.set(dir, (lines.get(dir) ?? 0) + sourceLines);
			dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
		}
		if (entry.size !== null && entry.size <= 1500) continue;
		if (text === undefined) unreadSource = true;
		else if (sourceLines > 1500) oversized ??= entry.path;
	}
	const missingGuide = [...dirs].find(([dir, count]) => count >= 50 && !["AGENTS.md", "CLAUDE.md", "README.md"].some(name => known.has(dir + "/" + name)));
	const pr = paths.some(p => /^(?:(?:docs|\.github)\/)?pull_request_template(?:\.md|\/[^/]+\.md)$/i.test(p));
	const issue = paths.some(p => /^(?:(?:docs|\.github)\/)?issue_template(?:\.md|\/(?!config\.ya?ml$)[^/]+\.(?:md|ya?ml))$/i.test(p));
	let pullChecks = false, scanner = !!repo.secretScanning, unreadWorkflow = truncated;
	for (const path of paths.filter(p => workflow.test(p))) {
		const text = files.get(path);
		if (text === undefined) { unreadWorkflow = true; continue; }
		try {
			const config = parse(text, { maxAliasCount: 30 });
			const trigger = config?.on;
			const events = typeof trigger === "string" ? [trigger] : Array.isArray(trigger) ? trigger : Object.keys(trigger ?? {});
			if (!Object.keys(config?.jobs ?? {}).length || !events.length) continue;
			pullChecks ||= events.includes("pull_request") || events.includes("pull_request_target");
			for (const job of Object.values(config.jobs) as { steps?: { uses?: string; run?: string }[] }[])
				scanner ||= (job.steps ?? []).some(step => /^(?:gacts\/gitleaks|gitleaks\/gitleaks-action|trufflesecurity\/trufflehog)@/i.test(step.uses ?? "") || /^\s*(?:gitleaks|trufflehog)\s/m.test(step.run ?? ""));
		} catch { /* Invalid workflows cannot run. */ }
	}
	const ignore = files.get(".gitignore");
	const env = ignore !== undefined && [".env", ".env.local"].every(path => ignored(ignore, path));
	const unknown = "The file list was incomplete.";
	const found = (yes: boolean, partial = truncated) => yes ? true : partial ? null : false;
	const missingIgnore = ignore === undefined && (known.has(".gitignore") || truncated);
	const protectedEnv = missingIgnore ? null : env && found(scanner, unreadWorkflow);
	const protectionReason = missingIgnore ? "The ignore rules could not be checked."
		: !env ? "The ignore rules do not cover .env and .env.local."
		: scanner ? "Environment files are ignored and secret scanning is enabled."
		: unreadWorkflow ? "Some workflows could not be checked for a secret scan."
		: "Environment files are ignored. No secret scan was found.";
	const areas = [...dirs].filter(([dir, count]) => count >= 50 || lines.get(dir)! >= 5000)
		.sort(([a, n], [b, m]) => m - n || lines.get(b)! - lines.get(a)! || a.localeCompare(b)).map(([dir]) => dir);
	return { commit: scan.commit, areas: areas.slice(0, 8), later: Math.max(0, areas.length - 8), findings: [
		{ id: "guide", pass: rootGuide || truncated ? null : false, reason: rootGuide ? `${rootGuide} found. Finish setup to check its instructions.` : truncated ? unknown : "The root folder has no AGENTS.md or CLAUDE.md." },
		{ id: "areas", pass: missingGuide ? false : truncated ? null : true, reason: missingGuide ? `${missingGuide[0]} has ${missingGuide[1]} source files and no guide.` : truncated ? unknown : "Every folder with 50 or more source files has a guide." },
		{ id: "templates", pass: found(pr && issue), reason: pr && issue ? "Both templates are present." : truncated ? unknown : `Missing ${[!pr && "pull request", !issue && "issue"].filter(Boolean).join(" and ")} template.` },
		{ id: "size", pass: oversized ? false : unreadSource ? null : true, reason: oversized ? `${oversized} exceeds 1,500 lines.` : unreadSource ? "Some source files exceeded the automatic scan limit." : "No source file exceeds 1,500 lines." },
		{ id: "ci", pass: found(pullChecks, unreadWorkflow), reason: pullChecks ? "A workflow runs on pull requests." : unreadWorkflow ? "Some workflows could not be checked." : "No workflow runs on pull requests." },
		{ id: "secrets", pass: protectedEnv, reason: protectionReason },
	] };
}
