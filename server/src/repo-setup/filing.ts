import { parse } from "yaml";
import { workflowCommands } from "./workflow-commands.js";
import { requireGuideStructure } from "./guide-structure.js";
import { record as row } from "../github/app.js";
import { readinessJudgment } from "../factory/readiness-filing.js";
import type { Judgment } from "../factory/readiness.js";
import { pushTokenKinds, redact } from "../github/redact.js";
import { checkGuide, guideTree, skillPath } from "./guide-check.js";
import type { DraftRequest, NoteDecision, SetupNote, SkillFiling, Verdict } from "./types.js";

interface DraftContext {
	revision?: boolean;
	savedCommands?: readonly string[];
	onRefusedLine?(path: string, line: number, text: string, reason: string): void;
	request: DraftRequest;
	notes: SetupNote[];
	paths: string[];
	read: Map<string, string>;
	owner: string;
	host: string;
	redact(text: string): string;
}
export interface AcceptedDraft {
	leftOut?: string[];
	score: Judgment; files: Map<string, string>; decisions: NoteDecision[]; skills: Map<string, "ran" | "static only">;
}
const verdicts: Verdict[] = ["team", "personal", "private", "secret", "stale", "question", "duplicate"];
const opaqueCredential = /\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{32,}/;
const secret = (s: string) => opaqueCredential.test(s) || redact(s) !== s || pushTokenKinds(s).length > 0 || /(?:password|passwd|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"'<>]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(s);
// Bare domains in prose can look like filenames. These are common repository file extensions.
const fileExtension = /\.(?:[cm]?[jt]sx?|mdc?|rst|txt|json[c5]?|ya?ml|toml|lockb?|sql|css|scss|html?|xml|svg|png|jpe?g|gif|webp|sh|bash|zsh|py|go|rs|java|kt|swift|cs|cpp|hpp|rb|php|scala|vue|svelte|dart|exs?|hs|lua|env|conf|config|ini|mod|sum|gradle|properties|proto|tf|hcl|csv|tsv|pdf|gz|zip)$/i;
export function privateLine(s: string, ctx: Pick<DraftContext, "host" | "owner" | "read" | "redact">) {
	if (ctx.redact(s) !== s || secret(s) || /(?:\/home\/|\/Users\/|[a-z]:\\Users\\)|\b[\w.+-]+@[\w.-]+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f\d]{1,4}:){3,}[a-f\d:]+/i.test(s)) return true;
	const owners = [ctx.owner, ...((ctx.read.get(".github/CODEOWNERS") ?? ctx.read.get("CODEOWNERS") ?? "").match(/@[\w/-]+/g) ?? [])].map(v => v.replace(/^@/, "").toLowerCase());
	if ([...s.matchAll(/(?:^|[^\w@])@([\w/-]+)/g)].some(m => !owners.includes(m[1].toLowerCase()))) return true;
	for (const m of s.matchAll(/(?:https?:\/\/|\bwww\.)([\w.-]+)|\b([\w-]+(?:\.[\w-]+)*\.[a-z]{2,24})\b/gi)) {
		const host = (m[1] ?? m[2]).replace(/\.$/, "").toLowerCase();
		if (host !== ctx.host && (m[1] || !fileExtension.test(host))) return true;
	}
	return false;
}

function list(v: unknown, max: number) {
	if (!Array.isArray(v) || v.length > max) throw Error("Check the number of entries in each list.");
	return v.map(row);
}
function short(v: unknown) {
	if (typeof v !== "string" || !v.trim() || v.length > 200 || /[\r\n\x00]/.test(v)) throw Error("Use short, single-line descriptions.");
	return v.trim();
}

interface Proof { label: string; file?: string; source?: string; savedCommand?: string; run?: string }

function evidence(value: unknown, ctx: DraftContext, workflows: Map<string, Map<number, string>>, allowSaved = true): Proof | null {
	const e = row(value);
	if (typeof e.file === "string" && ctx.paths.includes(e.file) && !privateLine(e.file, ctx)) {
		if (e.line === undefined) return { label: e.file, file: e.file };
		if (Number.isSafeInteger(e.line) && Number(e.line) > 0) {
			const contents = ctx.read.get(e.file);
			const source = contents?.split("\n")[Number(e.line) - 1];
			if (contents && source?.trim()) {
				const proof = { label: e.file + ":" + e.line, file: e.file };
				if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.file)) return { ...proof, source };
				if (!workflows.has(e.file)) workflows.set(e.file, workflowCommands(contents));
				return { ...proof, run: workflows.get(e.file)?.get(Number(e.line)) };
			}
		}
	}
	if (allowSaved && typeof e.command === "string" && ctx.savedCommands?.includes(e.command))
		return { label: "Saved repository command", savedCommand: e.command };
	// Replay only path-existence checks against the trusted tree. Never execute submitted commands.
	if (typeof e.command === "string" && e.exit === 0 && typeof e.said === "string" && e.said.length <= 200) {
		const path = /^(?:test -[ef]|ls --|git ls-files --error-unmatch) ([\w./-]+)$/.exec(e.command)?.[1];
		if (path && ctx.paths.includes(path) && !privateLine(e.command, ctx)) return { label: e.command };
	}
	return null;
}

function containsLiteral(source: string, value: string) {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp("(?<![\\w-])" + escaped + "(?![\\w-])").test(source);
}

const installLocks = new Map<string, string[]>([
	["npm ci", ["package-lock.json", "npm-shrinkwrap.json"]], ["npm install", ["package-lock.json", "npm-shrinkwrap.json"]],
	["pnpm install", ["pnpm-lock.yaml"]], ["yarn install", ["yarn.lock"]], ["bun install", ["bun.lock", "bun.lockb"]],
]);

function citedInvocation(command: string, proof: Proof | null) {
	return proof?.savedCommand === command || !!proof?.run && containsLiteral(proof.run, command);
}

function supportsCommand(command: string, proof: Proof | null, ctx: DraftContext) {
	if (!proof) return false;
	if (citedInvocation(command, proof)) return true;
	const { source, file } = proof;
	if (!file) return false;
	const locks = installLocks.get(command);
	if (locks?.includes(file)) return true;
	if (locks && file === "package.json" && (command !== "npm ci" || locks.some(path => ctx.paths.includes(path)))) return true;
	if (!/(^|\/)package\.json$/.test(file)) return !!source && containsLiteral(source, command);
	const script = command === "npm test" ? "test" : /^(?:(?:npm run|bun run|pnpm(?: run)?|yarn(?: run)?) )?([\w.:-]+)$/.exec(command)?.[1];
	try {
		const scripts = JSON.parse(ctx.read.get(file) ?? "{}").scripts ?? {};
		return Object.entries(scripts).some(([name, value]) => {
			if (typeof value !== "string") return false;
			if (name === script && (!source || [...source.matchAll(/"([\w.:-]+)"\s*:/g)].some(m => m[1] === name))) return true;
			return !!source && source.includes(JSON.stringify(value)) && containsLiteral(value, command);
		});
	} catch { return false; }
}

function supportsCommands(line: string, proofs: (Proof | null)[], ctx: DraftContext, shellLine: boolean, quickCommands: boolean) {
	const snippets = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
	const commands = snippets.filter(s => /\s|^--?[a-z]|^[\w-]+:[\w:-]+$/i.test(s) ||
		quickCommands && /^[a-z][\w-]*$/.test(s) && !ctx.paths.some(p => p === s || p.startsWith(s + "/")));
	if (shellLine || /^\s*(?:npm|pnpm|bun|yarn|node|npx|make|cargo|go|python3?|git|bash|sh)\s/.test(line)) commands.push(line.trim());
	// A saved command proves only an invocation of that command on this guide line.
	if (proofs.some(p => p?.savedCommand && ![...snippets, line.trim()].includes(p.savedCommand))) return false;
	return commands.every(command => proofs.some(proof => supportsCommand(command, proof, ctx)));
}

export function validateDraft(args: unknown, ctx: DraftContext, stats?: SkillFiling): AcceptedDraft {
	const a = row(args);
	const safe = (v: unknown) => { const s = short(v); return privateLine(s, ctx) ? "Details withheld." : s; };
	const score = readinessJudgment(a.score, safe);
	// With no notes selected, whatever the agent sends under `notes` (often repository files named like notes) is ignored.
	const notes = ctx.notes.length ? list(a.notes, 200) : [];
	if (notes.length !== ctx.notes.length) throw Error("Classify every selected note once.");
	const decisions = ctx.notes.map((n): NoteDecision => {
		const r = notes.find(r => r.noteId === n.id);
		if (!r || !verdicts.includes(r.verdict as Verdict)) throw Error("Give each selected note a classification.");
		const unanswered = ctx.request.answers && n.decision?.question && !ctx.request.answers[n.id];
		const verdict = secret(n.text) || ctx.redact(n.text) !== n.text ? "secret" : privateLine(n.text, ctx) ? "private" : unanswered ? "question" : r.verdict as Verdict;
		const question = verdict === "question" && (unanswered ? n.decision?.question : short(r.question));
		return { noteId: n.id, verdict, question: question && !privateLine(question, ctx) ? question : undefined, reason: verdict === "secret" || verdict === "private" ? "Sensitive details omitted." : safe(r.reason), uses: [] };
	});
	const excludedLines = ctx.notes.flatMap((n, i) => ["team", "duplicate"].includes(decisions[i].verdict) ? [] :
		n.text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length >= 8));
	if (decisions.filter(d => d.question).length > 8) throw Error("Ask up to eight questions.");
	const files = new Map<string, string>();
	const allowed = new Set(["AGENTS.md", ...ctx.request.areas.map(d => d + "/AGENTS.md")]);
	const entries = list(a.files, 20);
	const repoFiles = new Set(ctx.paths);
	const workflows = new Map<string, Map<number, string>>();
	const tree = guideTree(ctx.paths, path => ctx.read.get(path));
	for (const { path } of entries) if (typeof path === "string" && allowed.has(path)) tree.paths.add(path);
	const skills: AcceptedDraft["skills"] = new Map();
	const seen = new Set<string>();
	let skillCount = 0, bytes = 0;
	for (const f of entries) {
		if (typeof f.path !== "string" || typeof f.content !== "string" || seen.has(f.path)) throw Error("File each guide once.");
		seen.add(f.path);
		const skill = skillPath.exec(f.path)?.[1];
		const rejectSkill = (reason: string) => stats?.staticallyRejected.push({ path: String(f.path), reason });
		if (skill || f.kind === "skill") {
			if (++skillCount > 5) throw Error("Use at most five skill files.");
			if (!skill || f.kind !== "skill") {
				rejectSkill("Use kind skill and .agents/skills/<kebab-name>/SKILL.md.");
				continue;
			}
		} else if (!allowed.delete(f.path) || f.kind !== (f.path === "AGENTS.md" ? "guide" : "area")) throw Error("File the requested guides.");
		if (!safeTarget(f.path) || privateLine(f.path, ctx)) throw Error("An area name cannot be published safely.");
		if (ctx.paths.includes(f.path) && !ctx.read.has(f.path)) throw Error("An existing guide could not be read safely.");
		if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(f.content)) throw Error("Remove the entire private key before filing.");
		const size = Buffer.byteLength(f.content);
		bytes += size;
		if (bytes > 80 * 1024) throw Error("Keep the total filing under 80 KiB.");
		if (size > 12 * 1024 || f.content.trimEnd().split("\n").length > (skill ? 60 : f.path === "AGENTS.md" ? 150 : 40) || f.content.includes("\0")) {
			if (!skill) throw Error("Shorten the guides to the requested limits.");
			rejectSkill("Use at most 60 lines and 12 KiB of text.");
			continue;
		}
		if (ctx.redact(f.content) !== f.content) throw Error("Remove saved secret values before filing.");
		const path = f.path;
		const command = skill && smokeCommand(f.content);
		const proposed = f.content.split(/\r?\n/);
		const cited = list(f.lines, 450).map(r => ({ ref: r, proof: evidence(r.evidence, ctx, workflows) }));
		const shellLines = new Set<number>();
		const issues = checkGuide(path, f.content, tree, (line, command) => {
			if (command && !command.startsWith("#") && command === proposed[line - 1].trim()) shellLines.add(line);
			return cited.some(c => c.ref.line === line && citedInvocation(command, c.proof));
		});
		const headerEnd = skill ? skillHeaderEnd(proposed, skill) : -1;
		if (skill && (headerEnd < 0 || issues.length)) {
			rejectSkill(headerEnd < 0 ? "Supply matching YAML name and description and nonempty When to use, Steps and Check sections."
				: `Line ${issues[0].line}: ${issues[0].message}`);
			continue;
		}
		const original = ctx.read.get(path)?.split(/\r?\n/) ?? [];
		const old = new Set(original);
		const removed = list(f.removed ?? [], 150);
		const missing = original.findIndex((line, i) => line.trim() && !proposed.includes(line) && !privateLine(line, ctx) &&
			!removed.some(r => r.line === i + 1 && evidence(r.evidence, ctx, workflows, false)));
		if (missing !== -1) {
			const reason = "Keep existing guide text, or cite evidence for each removed line.";
			ctx.onRefusedLine?.(path, missing + 1, original[missing], reason);
			throw Error(reason);
		}
		let quickCommands = false;
		const kept: string[] = [];
		let skillIssue = "";
		for (const [i, line] of proposed.entries()) {
			const claims = cited.filter(c => c.ref.line === i + 1);
			const sources = claims.map(({ ref }) => decisions.find(n => n.noteId === ref.noteId));
			const proofs = claims.map(c => c.proof);
			if (/^#{1,2}\s/.test(line)) quickCommands = line.trim() === "## Quick commands";
			const referenceIssue = issues.find(e => e.line === i + 1);
			const layout = /^\s*(?:$|`{3}\w*$|[| :\-]+$|#{1,6} [\w &-]{1,50}$)/.test(line);
			const format = skill && (i <= headerEnd || command && (line === command || line === "`" + command + "`"));
			let issue = "";
			if (privateLine(line, ctx) || excludedLines.some(q => line.includes(q))) issue = "Contains private or excluded content.";
			else if (referenceIssue) issue = referenceIssue.message;
			else if (claims.some(({ ref: r }, j) => r.noteId && (!sources[j] || !["team", "duplicate"].includes(sources[j]!.verdict) || ctx.request.answers?.[String(r.noteId)] === "drop")))
				issue = "The cited note was excluded.";
			else if (!layout && !format && !old.has(line) && !claims.length) issue = "A new instruction needs a repository citation.";
			else if (proofs.some(p => !p)) issue = "The citation does not identify repository evidence.";
			else if (claims.length && !supportsCommands(line, proofs, ctx, shellLines.has(i + 1), quickCommands)) issue = "The cited evidence does not support the command.";
			if (issue) {
				ctx.onRefusedLine?.(path, i + 1, issue === "Contains private or excluded content." ? "[redacted]" : line, issue);
				if (!skill) continue;
				skillIssue = `Line ${i + 1}: ${issue}`;
				break;
			}
			kept.push(line);
			sources.forEach((d, j) => d?.uses.push({ path, line: kept.length, evidence: proofs[j]!.label }));
		}
		if (skill) {
			if (skillIssue) {
				rejectSkill(skillIssue);
				continue;
			}
			skills.set(path, "static only");
		} else requireGuideStructure(path, kept, repoFiles);
		files.set(path, kept.join("\n").trimEnd() + "\n");
	}
	if (allowed.has("AGENTS.md") && !ctx.revision) throw Error("Include the root AGENTS.md guide.");
	const draft = { score, files, decisions, skills };
	pruneCitations(draft);
	return draft;
}

export function pruneCitations({ files, decisions }: AcceptedDraft) {
	for (const d of decisions) d.uses = d.uses.filter(u => files.has(u.path));
	for (const d of decisions) if (d.verdict === "team" && !d.uses.length) {
		d.verdict = "stale"; d.reason = "No guide line passed the evidence checks.";
	}
}

export function evidencePaths(args: unknown) {
	const paths = new Set<string>();
	for (const f of list(row(args).files, 20)) for (const r of [...list(f.lines, 450), ...list(f.removed ?? [], 150)]) {
		const file = row(r.evidence).file;
		if (typeof file === "string") paths.add(file);
	}
	return paths;
}

export function safeTarget(path: string) {
	return path.split("/").every(p => /^[\w.-]+$/.test(p) && !["..", ".", ".git"].includes(p.toLowerCase()));
}

export function skillFrontmatter(lines: string[]) {
	const end = lines.indexOf("---", 1);
	if (lines[0] !== "---" || end < 2) return;
	try {
		const header = parse(lines.slice(1, end).join("\n"), { maxAliasCount: 0 });
		return { end, header };
	} catch { return; }
}

function skillHeaderEnd(lines: string[], name: string) {
	const parsed = skillFrontmatter(lines);
	if (!parsed) return -1;
	const { header, end } = parsed;
	if (header?.name !== name || typeof header.description !== "string" || !header.description.trim() ||
		Object.keys(header).some(key => key !== "name" && key !== "description")) return -1;
	for (const title of ["When to use", "Steps", "Check"]) {
		const start = lines.indexOf("## " + title);
		const first = lines.slice(start + 1).find(l => l.trim());
		if (start <= end || !first || first.startsWith("#")) return -1;
	}
	return end;
}

// Only these single, read-only checks may be replayed by the host in the pinned checkout.
export function smokeCommand(content: string) {
	const section = content.split(/^## Check\s*$/m)[1]?.split(/^## /m)[0];
	const line = section?.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("```"));
	if (line?.length !== 1) return null;
	const command = line[0].replace(/^`([^`]+)`$/, "$1");
	const path = /^(?:test -[efd]|ls --) ([\w.-]+(?:\/[\w.-]+)*)$/.exec(command)?.[1];
	return path && safeTarget(path) ? command : null;
}
