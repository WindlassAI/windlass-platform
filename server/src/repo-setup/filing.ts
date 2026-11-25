import { record as row } from "../github/app.js";
import { readinessJudgment } from "../factory/readiness-filing.js";
import type { Judgment } from "../factory/readiness.js";
import { pushTokenKinds, redact } from "../github/redact.js";
import { checkGuide, guideTree, skillPath } from "./guide-check.js";
import type { DraftRequest, NoteDecision, SetupNote, Verdict } from "./types.js";

interface DraftContext {
	revision?: boolean;
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
const fileExtension = /\.(?:[cm]?[jt]sx?|mdc?|rst|txt|json[c5]?|ya?ml|toml|lock|sql|css|scss|html?|xml|svg|png|jpe?g|gif|webp|sh|bash|zsh|py|go|rs|java|kt|swift|cs|cpp|hpp|rb|php|scala|vue|svelte|dart|exs?|hs|lua|env|conf|config|ini|mod|sum|gradle|properties|proto|tf|hcl|csv|tsv|pdf|gz|zip)$/i;
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

function supportsCommands(line: string, source: string) {
	const commands = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
	if (/^\s*(?:npm|pnpm|yarn|node|npx|make|cargo|go|python3?|git|bash|sh)\s/.test(line)) commands.push(line.trim());
	return commands.every(command => {
		if (!command.includes(" ") || source.includes(command)) return true;
		const script = /^(?:npm run|pnpm(?: run)?|yarn(?: run)?) ([\w:-]+)$/.exec(command)?.[1];
		return !!script && source.includes(JSON.stringify(script) + ":");
	});
}
function evidence(value: unknown, ctx: DraftContext, claim = "") {
	const e = row(value);
	if (typeof e.file === "string" && ctx.paths.includes(e.file) && !privateLine(e.file, ctx)) {
		const text = ctx.read.get(e.file);
		if (!supportsCommands(claim, text ?? "")) return null;
		if (e.line === undefined) return e.file;
		if (Number.isSafeInteger(e.line) && Number(e.line) > 0 && text?.split("\n")[Number(e.line) - 1]?.trim()) return e.file + ":" + e.line;
	}
	// Replay only path-existence checks against the trusted tree. Never execute submitted commands.
	if (typeof e.command === "string" && e.exit === 0 && typeof e.said === "string" && e.said.length <= 200) {
		const path = /^(?:test -[ef]|ls --|git ls-files --error-unmatch) ([\w./-]+)$/.exec(e.command)?.[1];
		if (path && ctx.paths.includes(path) && supportsCommands(claim, "") && !privateLine(e.command, ctx)) return e.command;
	}
	return null;
}

export function validateDraft(args: unknown, ctx: DraftContext): AcceptedDraft {
	const a = row(args);
	const safe = (v: unknown) => { const s = short(v); return privateLine(s, ctx) ? "Details withheld." : s; };
	const score = readinessJudgment(a.score, safe);
	const notes = list(a.notes, 200);
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
	const tree = guideTree([...ctx.paths, ...allowed], path => ctx.read.get(path));
	const skills: AcceptedDraft["skills"] = new Map();
	const seen = new Set<string>();
	let skillCount = 0, bytes = 0;
	for (const f of list(a.files, 20)) {
		if (typeof f.path !== "string" || typeof f.content !== "string" || seen.has(f.path)) throw Error("File each guide once.");
		seen.add(f.path);
		const skill = skillPath.exec(f.path)?.[1];
		if (skill) {
			if (f.kind !== "skill" || ++skillCount > 5) throw Error("Use at most five skill files.");
		} else if (!allowed.delete(f.path) || f.kind !== (f.path === "AGENTS.md" ? "guide" : "area")) throw Error("File the requested guides.");
		if (!safeTarget(f.path) || privateLine(f.path, ctx)) throw Error("An area name cannot be published safely.");
		if (ctx.paths.includes(f.path) && !ctx.read.has(f.path)) throw Error("An existing guide could not be read safely.");
		if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(f.content)) throw Error("Remove the entire private key before filing.");
		const size = Buffer.byteLength(f.content);
		bytes += size;
		if (size > 12 * 1024 || bytes > 80 * 1024 || f.content.trimEnd().split("\n").length > (skill ? 60 : f.path === "AGENTS.md" ? 150 : 40) || f.content.includes("\0")) throw Error("Shorten the guides to the requested limits.");
		if (ctx.redact(f.content) !== f.content) throw Error("Remove saved secret values before filing.");
		const path = f.path;
		const command = skill && smokeCommand(f.content);
		const proposed = f.content.split(/\r?\n/);
		const issues = checkGuide(path, f.content, tree);
		if (skill && (issues.length || !skillFormat(proposed, skill))) continue;
		const original = ctx.read.get(path)?.split(/\r?\n/) ?? [];
		const old = new Set(original);
		const removed = list(f.removed ?? [], 150);
		if (original.some((line, i) => line.trim() && !proposed.includes(line) && !privateLine(line, ctx) && !removed.some(r => r.line === i + 1 && evidence(r.evidence, ctx))))
			throw Error("Keep existing guide text, or cite evidence for each removed line.");
		const refs = list(f.lines, 450);
		const kept: string[] = [];
		for (const [i, line] of proposed.entries()) {
			const claims = refs.filter(r => r.line === i + 1);
			const sources = claims.map(r => decisions.find(n => n.noteId === r.noteId));
			if (privateLine(line, ctx) || issues.some(e => e.line === i + 1)) continue;
			if (claims.some((r, j) => r.noteId && (!sources[j] || !["team", "duplicate"].includes(sources[j]!.verdict) || ctx.request.answers?.[String(r.noteId)] === "drop"))) continue;
			if (excludedLines.some(q => line.includes(q))) continue;
			const proofs = claims.map(r => evidence(r.evidence, ctx, line));
			const layout = /^\s*(?:$|`{3}\w*$|[| :\-]+$|#{1,6} [\w &-]{1,50}$)/.test(line);
			const format = skill && (i < 4 || command && (line === command || line === "`" + command + "`"));
			if ((!layout && !format && !old.has(line) && !claims.length) || proofs.some(p => !p)) continue;
			kept.push(line);
			sources.forEach((d, j) => d?.uses.push({ path, line: kept.length, evidence: proofs[j]! }));
		}
		if (skill) {
			if (kept.length !== proposed.length) continue;
			skills.set(path, "static only");
		}
		if (!kept.some(l => l.trim()) || (path === "AGENTS.md" && !kept.includes("## Terms"))) throw Error("Include a Terms section in the root guide.");
		if (path === "AGENTS.md") {
			const start = kept.indexOf("## Terms") + 1;
			const end = kept.findIndex((l, i) => i >= start && /^##? /.test(l));
			const terms = kept.slice(start, end < 0 ? undefined : end).filter(l => l.trim());
			if (!terms.length || terms.length > 15) throw Error("Include one to fifteen verified terms.");
		}
		files.set(path, kept.join("\n").trimEnd() + "\n");
	}
	if (allowed.size && !ctx.revision) throw Error("Include the root guide and every chosen area.");
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

function skillFormat(lines: string[], name: string) {
	const header = lines.slice(1, 3);
	if (lines[0] !== "---" || lines[3] !== "---" || !header.includes("name: " + name) ||
		!header.some(l => /^description: \S/.test(l))) return false;
	return ["When to use", "Steps", "Check"].every(title => {
		const start = lines.indexOf("## " + title);
		return start >= 4 && lines.slice(start + 1).find(l => l.trim())?.startsWith("#") === false;
	});
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
