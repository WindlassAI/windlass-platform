import { posix } from "node:path";
import type { Judgment } from "../factory/readiness.js";
import { pushTokenKinds, redact } from "../github/redact.js";
import { checkGuides } from "./guide-check.js";
import type { DraftRequest, NoteDecision, SetupNote, Verdict } from "./types.js";

export interface DraftContext {
	request: DraftRequest;
	notes: SetupNote[];
	paths: string[];
	read: Map<string, string>;
	owner: string;
	host: string;
	redact(text: string): string;
}
export interface AcceptedDraft {
	score: Judgment; files: Map<string, string>; decisions: NoteDecision[]; questions: string[];
}
const verdicts: Verdict[] = ["team", "personal", "private", "secret", "stale", "question", "duplicate"];
const opaqueCredential = /\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{32,}/;
const secret = (s: string) => opaqueCredential.test(s) || redact(s) !== s || pushTokenKinds(s).length > 0 || /(?:password|passwd|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"'<>]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(s);
export function privateLine(s: string, ctx: Pick<DraftContext, "host" | "owner" | "read" | "redact">) {
	if (ctx.redact(s) !== s || secret(s) || /(?:\/home\/|\/Users\/|[a-z]:\\Users\\)|\b[\w.+-]+@[\w.-]+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f\d]{1,4}:){3,}[a-f\d:]+/i.test(s)) return true;
	const owners = [ctx.owner, ...((ctx.read.get(".github/CODEOWNERS") ?? ctx.read.get("CODEOWNERS") ?? "").match(/@[\w/-]+/g) ?? [])].map(v => v.replace(/^@/, "").toLowerCase());
	if ([...s.matchAll(/(?:^|\s)@([\w/-]+)/g)].some(m => !owners.includes(m[1].toLowerCase()))) return true;
	return [...s.matchAll(/(?:https?:\/\/|\bwww\.)([\w.-]+)|\b([\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|internal|local|corp|lan|dev|cloud|test))\b/gi)].some(m => (m[1] ?? m[2]).toLowerCase() !== ctx.host);
}

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
function list(v: unknown, max: number) {
	if (!Array.isArray(v) || v.length > max) throw Error("Check the number of entries in each list.");
	return v.map(row);
}
function short(v: unknown) {
	if (typeof v !== "string" || !v.trim() || v.length > 200 || /[\r\n\x00]/.test(v)) throw Error("Use short, single-line descriptions.");
	return v.trim();
}

// For commands, a citation must actually show the command or declare the named package script.
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
	const scoreRows = list(a.score, 3);
	const findings = (["setup", "checks", "guide"] as const).map(id => {
		const r = scoreRows.find(r => r.id === id);
		if (typeof r?.pass !== "boolean") throw Error("File all three setup checks.");
		return { id, pass: r.pass, reason: safe(r.reason) };
	});
	const notes = list(a.notes, 200);
	if (notes.length !== ctx.notes.length) throw Error("Classify every selected note once.");
	const decisions = ctx.notes.map((n): NoteDecision => {
		const r = notes.find(r => r.noteId === n.id);
		if (!r || !verdicts.includes(r.verdict as Verdict)) throw Error("Give each selected note a classification.");
		const unanswered = ctx.request.answers && n.decision?.question && !ctx.request.answers[n.id];
		const verdict = secret(n.text) || ctx.redact(n.text) !== n.text ? "secret" : privateLine(n.text, ctx) ? "private" : unanswered ? "question" : r.verdict as Verdict;
		return { noteId: n.id, verdict, reason: verdict === "secret" || verdict === "private" ? "Sensitive details omitted." : safe(r.reason), uses: [] };
	});
	const excludedLines = ctx.notes.flatMap((n, i) => ["team", "duplicate"].includes(decisions[i].verdict) ? [] :
		n.text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length >= 8));
	const questions: string[] = [];
	for (const q of list(a.questions, 8)) {
		const ask = short(q.ask);
		if (privateLine(ask, ctx)) continue;
		if (!q.noteId) questions.push(ask);
		else {
			const d = decisions.find(d => d.noteId === q.noteId);
			if (d?.verdict === "question") d.question = ask;
		}
	}
	const files = new Map<string, string>();
	const allowed = new Set(["AGENTS.md", ...ctx.request.areas.map(d => d + "/AGENTS.md")]);
	const rawFiles = list(a.files, 20);
	let bytes = 0;
	for (const f of rawFiles) {
		if (typeof f.path !== "string" || !allowed.delete(f.path) || typeof f.content !== "string" || f.kind !== (f.path === "AGENTS.md" ? "guide" : "area")) throw Error("File only the requested guides, one per folder.");
		if (!safeTarget(f.path) || privateLine(f.path, ctx)) throw Error("An area name cannot be published safely.");
		if (ctx.paths.includes(f.path) && !ctx.read.has(f.path)) throw Error("An existing guide could not be read safely.");
		if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(f.content)) throw Error("Remove the entire private key before filing.");
		const size = Buffer.byteLength(f.content);
		bytes += size;
		if (size > 12 * 1024 || bytes > 80 * 1024 || f.content.trimEnd().split("\n").length > (f.path === "AGENTS.md" ? 150 : 40) || f.content.includes("\0")) throw Error("Shorten the guides to the requested limits.");
		if (ctx.redact(f.content) !== f.content) throw Error("Remove saved secret values before filing.");
		files.set(f.path, f.content);
	}
	if (allowed.size) throw Error("Include the root guide and every chosen area.");
	const issues = checkGuides(files, ctx.paths, p => ctx.read.get(p));
	for (const f of rawFiles) {
		const path = String(f.path);
		const original = ctx.read.get(path)?.split(/\r?\n/) ?? [];
		const old = new Set(original);
		const proposed = new Set(files.get(path)!.split(/\r?\n/));
		const removed = list(f.removed ?? [], 150);
		if (original.some((line, i) => line.trim() && !proposed.has(line) && !privateLine(line, ctx) && !removed.some(r => r.line === i + 1 && evidence(r.evidence, ctx))))
			throw Error("Keep existing guide text, or cite evidence for each removed line.");
		const refs = list(f.lines, 450);
		const kept: string[] = [];
		for (const [i, line] of files.get(path)!.split(/\r?\n/).entries()) {
			const claims = refs.filter(r => r.line === i + 1);
			const sources = claims.map(r => decisions.find(n => n.noteId === r.noteId));
			if (privateLine(line, ctx) || issues.some(e => e.path === path && e.line === i + 1)) continue;
			if (claims.some((r, j) => r.noteId && (!sources[j] || !["team", "duplicate"].includes(sources[j]!.verdict) || ctx.request.answers?.[String(r.noteId)] === "drop"))) continue;
			if (excludedLines.some(q => line.includes(q))) continue;
			const proofs = claims.map(r => evidence(r.evidence, ctx, line));
			// Require proof for all new prose and command lines. Keep headings, fences and table dividers.
			const layout = /^\s*(?:$|`{3}\w*$|[| :\-]+$|#{1,6} [\w &-]{1,50}$)/.test(line);
			if ((!layout && !old.has(line) && !claims.length) || proofs.some(p => !p)) continue;
			kept.push(line);
			sources.forEach((d, j) => d?.uses.push({ path, line: kept.length, evidence: proofs[j]! }));
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
	for (const d of decisions) if (d.verdict === "team" && !d.uses.length) {
		d.verdict = "stale"; d.reason = "No guide line passed the evidence checks.";
	}
	return { score: { findings }, files, questions, decisions };
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
	return !posix.isAbsolute(path) && path.split("/").every(p => /^[\w.-]+$/.test(p) && !["..", ".", ".git"].includes(p.toLowerCase()));
}
