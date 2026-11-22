import { feedbackWords } from "./feedback.js";
/** The report tool's trust boundary. The page reads these strings as text. Only platform records supply facts and links. */
import { MAX_ACCEPTANCE_CRITERIA, MAX_NOTE_CHARS, MAX_PUBLISH_BODY_CHARS, MAX_PUBLISH_TITLE_CHARS, REVIEW_LIMITS as limit, type SandboxPlace, type SandboxProfile, type WindlassEvent, type ItemReview, type ItemReport, type ReviewBlock, type ReviewLocation, type ReviewRecommendation, type ReviewRecord, type ReviewRef, type Verdict } from "../contract.js";
import { type AgentReport, CONTROL, REPORT_TAKEN } from "../agent-publish.js";
import { shotRequest, textOf, type TextRedactor, type ShotRequest } from "./attachments.js";
import { commandSandbox } from "../repo-secrets.js";
import { config } from "../config.js";
import { verdictWords } from "./verdict.js";


export const REVIEW_PROFILE_REASON = "in this sandbox the reviewer's commands would run with the network";

export function reviewerAllowed(place: SandboxPlace, profile: SandboxProfile): boolean {
	return place.kind === "hosted" && commandSandbox(profile) === "windlass";
}

export interface ReviewContext {
	records: ReviewRecord[];
	commands?: ReviewRecord[];
	earlier: Array<{ id: string; severity: string; root?: string }>;
	round: number;
	redactor: TextRedactor;
}

type Refusal = { ok: false; problems: string[] };
type CheckedReview = Refusal | { ok: true; recommendation: ReviewRecommendation; blocks: ReviewBlock[]; records: ReviewRecord[]; shots: ShotRequest[]; notes: string[] };

const number = (n: number) => n.toLocaleString("en-US");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function rawProblem(input: unknown, name: "review" | "report"): string | null {
	try {
		const bytes = Buffer.byteLength(JSON.stringify(input));
		if (bytes <= limit.inputBytes) return null;
		const size = bytes % 1024 === 0 ? `${number(bytes / 1024)} KiB` : `${number(bytes)} bytes`;
		return `the ${name} is ${size}; the limit is ${limit.inputBytes / 1024} KiB`;
	} catch {
		return `the ${name} must be JSON`;
	}
}

function longestFence(text: string): number {
	let ticks = 0;
	let lines = 0;
	let longest = 0;
	for (const line of text.split("\n")) {
		const fence = /^\s*(`{3,})(.*)$/.exec(line);
		if (!ticks && fence) {
			ticks = fence[1]!.length;
			lines = 0;
		} else if (ticks && fence && fence[1]!.length >= ticks && !fence[2]!.trim()) {
			ticks = 0;
		} else if (ticks) {
			longest = Math.max(longest, ++lines);
		}
	}
	return longest;
}

/** Read only declared fields. A refusal never hands a partially checked object to the caller. */
class Fields {
	readonly problems: string[] = [];
	chars = 0;
	constructor(readonly redactor: TextRedactor) {}

	problem(field: string, rule: string): void {
		if (this.problems.length < 10) this.problems.push(field ? `${field}: ${rule}` : rule);
	}

	shown(value: string): string {
		// Tool refusals can quote a short identifier. Do not echo arbitrary agent prose as platform words.
		const clean = textOf(value, this.redactor);
		return JSON.stringify(/^[\w./-]{1,80}$/.test(clean) ? clean : "(invalid name)");
	}

	keys(obj: Record<string, unknown>, field: string, allowed: readonly string[]): void {
		for (const key of Object.keys(obj)) if (!allowed.includes(key)) this.problem(field, `unknown field ${this.shown(key)}`);
	}

	choice<const T extends string>(value: unknown, field: string, choices: readonly [T, ...T[]]): T {
		const choice = choices.find((one) => one === value);
		if (choice !== undefined) return choice;
		this.problem(field, `must be one of ${choices.join(", ")}`);
		return choices[0];
	}

	text(value: unknown, field: string, max: number, prose = true): string {
		if (typeof value !== "string") {
			this.problem(field, "must be text");
			return "";
		}
		const text = textOf(value, this.redactor);
		this.chars += text.length;
		if (text.length > max) this.problem(field, `${number(text.length)} characters; the limit is ${number(max)}`);
		if (prose) {
			const lines = longestFence(text);
			if (lines > limit.fenceLines) this.problem(field, `a fence has ${lines} lines; the limit is ${limit.fenceLines}`);
		} else if (text !== value) {
			this.problem(field, "must name the record or path exactly after cleaning");
		}
		return text;
	}

	count(field: string, name: string, count: number, max: number): void {
		if (count > max) this.problem(field, `${max} ${name} at most; this has ${count}`);
	}

	list(value: unknown, field: string, name: string, max: number): unknown[] {
		if (!Array.isArray(value)) {
			this.problem(field, "must be an array");
			return [];
		}
		this.count(field, name, value.length, max);
		return value;
	}
}

const blockFields = {
	summary: ["text"], text: ["heading", "text", "refs"], finding: ["severity", "title", "text", "at", "refs", "continues"], earlier: ["finding", "status", "text"],
	risk: ["text", "at"], question: ["text"], excerpt: ["at", "note"], screenshot: ["file", "caption", "shows", "page"],
} as const;

export function checkReview(input: unknown, context: ReviewContext): CheckedReview {
	const raw = rawProblem(input, "review");
	if (raw) return { ok: false, problems: [raw] };
	if (!isObject(input)) return { ok: false, problems: ["the review must be an object"] };
	const read = new Fields(context.redactor);
	read.keys(input, "review", ["recommendation", "blocks"]);
	const recommendation = read.choice(input.recommendation, "recommendation", ["approve", "changes_requested", "needs_person"]);
	const filed = read.list(input.blocks, "blocks", "blocks", limit.blocks);
	const counts = { summary: 0, finding: 0, risk: 0, question: 0, excerpt: 0, screenshot: 0 };
	for (const block of filed) {
		if (isObject(block) && typeof block.kind === "string" && Object.hasOwn(counts, block.kind)) counts[block.kind as keyof typeof counts]++;
	}
	// Count first so a ninth screenshot's quota survives even when every screenshot is refused.
	read.count("blocks", "findings", counts.finding, limit.findings);
	read.count("blocks", "risks", counts.risk, limit.risks);
	read.count("blocks", "questions", counts.question, limit.questions);
	read.count("blocks", "excerpts", counts.excerpt, limit.excerpts);
	read.count("blocks", "screenshots", counts.screenshot, limit.screenshots);
	if (counts.summary !== 1) read.problem("", `a review has exactly one summary; this has ${counts.summary}`);

	const shots: ShotRequest[] = [];
	const notes: string[] = [];
	const paths = new Set<string>();
	const records = new Map([...context.records.filter(r => r.kind !== "command"), ...(context.commands ?? []).filter(r => r.kind === "command")].map((record) => [record.ref, record]));
	const referenced = new Set<string>();
	const earlier = new Map(context.earlier.map((one) => [one.id, one]));
	const answers = new Map<string, number>();
	const blocks: ReviewBlock[] = [];
	let findings = 0;
	let blocking = 0;

	function location(value: unknown, field: string, excerpt: boolean): ReviewLocation {
		if (!isObject(value)) {
			read.problem(field, "must be a location");
			return { path: "" };
		}
		read.keys(value, field, ["path", "side", "lines"]);
		const name = `${field}.path`;
		if (typeof value.path === "string" && value.path.includes("\0")) read.problem(name, "has a NUL");
		const path = read.text(value.path, name, limit.pathChars, false);
		if (typeof value.path === "string" && !path.trim()) read.problem(name, "must not be empty");
		if (path.startsWith("/") || /^[a-z]:\/|^[a-z][a-z0-9+.-]*:\/\//i.test(path)) read.problem(name, "must be repository-relative");
		if (path.split("/").includes("..")) read.problem(name, 'has ".."');
		if (path.split("/").includes(".") || path.split("/").includes("")) read.problem(name, "must use canonical path segments");
		if (path.includes("\\")) read.problem(name, "has a backslash");
		if (/[\n\t]/.test(path)) read.problem(name, "must not contain a line break or tab");
		paths.add(`${value.side ?? "head"}:${path}`);
		const at: ReviewLocation = { path, side: value.side === undefined ? "head" : read.choice(value.side, `${field}.side`, ["head", "base"]) };
		if (value.lines === undefined && !excerpt) return at;
		const range = `${field}.lines`;
		if (!isObject(value.lines)) {
			read.problem(range, "must give a start and end line");
			return at;
		}
		read.keys(value.lines, range, ["start", "end"]);
		const { start, end } = value.lines;
		const validLine = (line: unknown): line is number => typeof line === "number" && Number.isSafeInteger(line) && line >= 1;
		if (!validLine(start)) read.problem(`${range}.start`, "must be an integer of at least 1");
		if (!validLine(end)) read.problem(`${range}.end`, "must be an integer of at least 1");
		if (validLine(start) && validLine(end)) {
			if (end < start) read.problem(`${range}.end`, "must not be before the start");
			read.count(range, "lines", end - start + 1, excerpt ? limit.excerptLines : limit.locationLines);
			at.lines = { start, end };
		}
		return at;
	}

	function reference(value: unknown, field: string): ReviewRef {
		if (!isObject(value)) {
			read.problem(field, "must be a reference");
			return { ref: "" };
		}
		read.keys(value, field, ["ref", "says"]);
		const ref = read.text(value.ref, `${field}.ref`, limit.totalChars, false);
		referenced.add(ref);
		const record = records.get(ref);
		if (typeof value.ref === "string" && (!record || !ref.startsWith(`${record.kind}/`))) read.problem(field, `no record ${read.shown(ref)}`);
		return value.says === undefined ? { ref } : { ref, says: read.choice(value.says, `${field}.says`, ["passed", "failed", "ran", "not_run"]) };
	}

	function previous(value: unknown, field: string): string {
		const id = read.text(value, field, limit.totalChars, false);
		if (typeof value === "string" && !earlier.has(id)) read.problem(field, `no earlier finding ${read.shown(id)}`);
		return id;
	}

	for (const [index, block] of filed.entries()) {
		const field = `blocks[${index}]`;
		if (!isObject(block)) {
			read.problem(field, "must be an object");
			continue;
		}
		const kind = block.kind;
		if (typeof kind !== "string" || !Object.hasOwn(blockFields, kind)) {
			read.problem(`${field}.kind`, typeof kind === "string" ? `unknown kind ${read.shown(kind)}` : "must name a block kind");
			continue;
		}
		if (kind !== "screenshot") read.keys(block, field, ["kind", ...blockFields[kind as keyof typeof blockFields]]);
		const text = (key: string, max: number) => read.text(block[key], `${field}.${key}`, max);
		const optional = (key: string, max: number) => block[key] === undefined ? null : text(key, max);
		const locations = () => block.at === undefined ? [] : read.list(block.at, `${field}.at`, "locations", limit.locationsPerBlock).map((one, i) => location(one, `${field}.at[${i}]`, false));
		const refs = () => block.refs === undefined ? [] : read.list(block.refs, `${field}.refs`, "refs", limit.refsPerBlock).map((one, i) => reference(one, `${field}.refs[${i}]`));
		switch (kind) {
			case "summary":
				blocks.push({ kind, text: text("text", limit.summaryChars) });
				break;
			case "text":
				blocks.push({ kind, heading: optional("heading", limit.headingChars), text: text("text", limit.textChars), refs: refs() });
				break;
			case "finding": {
				const id = `r${context.round}.f${++findings}`;
				const continues = block.continues === undefined ? id : previous(block.continues, `${field}.continues`);
				const severity = read.choice(block.severity, `${field}.severity`, ["blocking", "should_fix", "note"]);
				if (block.severity === "blocking") blocking++;
				blocks.push({ kind, id, root: earlier.get(continues)?.root ?? continues, severity, title: text("title", limit.findingTitleChars), text: text("text", limit.findingChars), at: locations(), refs: refs() });
				break;
			}
			case "earlier": {
				const finding = previous(block.finding, `${field}.finding`);
				answers.set(finding, (answers.get(finding) ?? 0) + 1);
				blocks.push({ kind, finding, status: read.choice(block.status, `${field}.status`, ["fixed", "not_fixed", "withdrawn"]), text: optional("text", limit.earlierChars) });
				break;
			}
			case "risk":
				blocks.push({ kind, text: text("text", limit.riskChars), at: locations() });
				break;
			case "question":
				blocks.push({ kind, text: text("text", limit.questionChars) });
				break;
			case "excerpt":
				blocks.push({ kind, at: location(block.at, `${field}.at`, true), code: "", note: optional("note", limit.textChars) });
				break;
			case "screenshot": {
				const { kind: _, ...request } = block;
				const checked = shotRequest([request], context.redactor);
				if ("problems" in checked) {
					notes.push(`Screenshot in ${field} omitted: ${checked.problems.join(" ")}`);
				} else if (shots.some(shot => shot.file === checked[0].file)) {
					notes.push(`Screenshot in ${field} omitted: duplicate file.`);
				} else {
					read.chars += checked[0].file.length + checked[0].caption.length + (checked[0].page?.length ?? 0);
					shots.push(checked[0]);
					blocks.push({ kind, attachment: checked[0].file });
				}
				break;
			}
		}
	}
	read.count("blocks", "distinct paths", paths.size, limit.paths);
	read.count("blocks", "distinct refs", referenced.size, limit.refs);
	if (read.chars > limit.totalChars) read.problem("blocks", `${number(read.chars)} characters; the limit is ${number(limit.totalChars)}`);
	if (input.recommendation === "approve" && blocking > 0) read.problem("recommendation", `"approve" with ${blocking} blocking finding${blocking === 1 ? "" : "s"}`);
	if (input.recommendation === "changes_requested" && !blocking) read.problem("recommendation", '"changes_requested" needs a blocking finding');
	if (input.recommendation === "needs_person" && !counts.question) read.problem("recommendation", '"needs_person" needs a question');
	for (const { id, severity } of context.earlier) {
		if (severity !== "blocking") continue;
		const n = answers.get(id) ?? 0;
		if (n === 0) read.problem("blocks", `${id} is blocking and has no "earlier" block`);
		if (n > 1) read.problem("blocks", `${id} is blocking and has ${n} "earlier" blocks`);
	}
	if (read.problems.length) return { ok: false, problems: read.problems };
	return { ok: true, recommendation, blocks, shots, notes, records: Array.from(referenced, (ref) => structuredClone(records.get(ref)!)) };
}

/** Per-turn durable events only. Never treat a tool's text as another tool call. */
export class ReviewCommands {
	private readonly called = new Map<string, string>();
	private readonly ended = new Map<string, Extract<ReviewRecord, { kind: "command" }>>();
	constructor(private readonly redactor: TextRedactor) {}

	note(event: WindlassEvent) {
		const data = event.data;
		if (!data || ![data.messageId, data.callId].every(id => typeof id === "string" && /^[\w.-]{1,128}$/.test(id))) return;
		const ref = `command/${data.messageId}/${data.callId}`;
		if (event.type === "tool.called" && data.name === "shell" && typeof data.input === "string") {
			try {
				const command = JSON.parse(data.input)?.command;
				if (typeof command === "string") this.called.set(ref, textOf(command, this.redactor).slice(0, 1000));
			} catch { /* Malformed inputs supply no evidence. */ }
		}
		if (event.type !== "tool.settled" || !this.called.has(ref)) return;
		const exit = isObject(data.display) ? data.display.exitCode : null;
		const output = textOf(typeof data.output === "string" ? data.output : "", this.redactor);
		this.ended.set(ref, { kind: "command", ref, command: this.called.get(ref)!, exitCode: typeof exit === "number" ? exit : null,
			outcome: typeof data.outcome === "string" ? this.redactor.text(data.outcome).slice(0, 80) : "unknown", tail: output.trimEnd().split("\n").slice(-20).join("\n").slice(-1200) });
	}

	records() { return [...this.called.keys()].flatMap(ref => this.ended.has(ref) ? [this.ended.get(ref)!] : []); }
}

export const NO_REPO_SHOTS = "Screenshots are turned off for this repository. File without screenshots.";

type Filing = Pick<ItemReview, "recommendation" | "blocks" | "records" | "screenshots" | "notes">;
type FilingResult = { answer: string; retryFree?: boolean; filing?: Filing };

export async function fileReview(input: unknown, context: ReviewContext, base: string, head: string, screenshots: boolean,
	fileAt: (path: string, sha: string) => Promise<string>, upload: UploadShots | null, unavailable = upload ? NO_REPO_SHOTS : "This deployment does not store screenshots. File without screenshots."): Promise<FilingResult> {
	if (!screenshots && isObject(input) && Array.isArray(input.blocks) && input.blocks.some(block => isObject(block) && block.kind === "screenshot")) {
		return { answer: "Not filed: " + unavailable };
	}
	const checked = checkReview(input, context);
	if (!checked.ok) return { answer: "Not filed: " + checked.problems.join("\n") + " Fix them and call file_review again." };
	const files = new Map<string, string[]>();
	let excerptChars = 0;
	for (const block of checked.blocks) {
		const locations = block.kind === "excerpt" ? [block.at] : block.kind === "finding" || block.kind === "risk" ? block.at : [];
		for (const loc of locations) {
			const sha = loc.side === "base" ? base : head;
			const key = sha + "/" + loc.path;
			let lines = files.get(key);
			if (!lines) {
				try {
					const text = await fileAt(loc.path, sha);
					lines = text.length ? text.replace(/\n$/, "").split(/\r?\n/) : [];
					files.set(key, lines);
				} catch {
					return { answer: `Not filed: could not read ${JSON.stringify(loc.path)} at ${sha.slice(0, 7)} from GitHub; try again.`, retryFree: true };
				}
			}
			if (loc.lines && loc.lines.end > lines.length) return { answer: `Not filed: the line range for ${JSON.stringify(loc.path)} exceeds the file's ${lines.length} lines.` };
			if (block.kind === "excerpt" && loc.lines) {
				const selected = lines.slice(loc.lines.start - 1, loc.lines.end);
				if (selected.some(line => line.length > limit.excerptLineChars)) return { answer: `Not filed: a line of the excerpt exceeds ${limit.excerptLineChars} characters. Use a location instead.` };
				block.code = context.redactor.text(selected.join("\n"));
				excerptChars += block.code.length;
				if (excerptChars > limit.totalChars) return { answer: "Not filed: the excerpts are too long. Cite a shorter range." };
			}
		}
	}
	const kept = checked.shots.length && upload ? await upload(checked.shots) : { screenshots: [], files: [], problems: [] };
	const ids = new Map(kept.files.map((file, i) => [file, kept.screenshots[i].id]));
	const blocks = checked.blocks.flatMap((block): ReviewBlock[] => block.kind !== "screenshot" ? [block] : ids.has(block.attachment) ? [{ ...block, attachment: ids.get(block.attachment)! }] : []);
	const notes = [...checked.notes, ...kept.problems];
	const blocking = blocks.filter(b => b.kind === "finding" && b.severity === "blocking").length;
	const filing = { recommendation: checked.recommendation, blocks, records: checked.records, screenshots: kept.screenshots, notes };
	if (Buffer.byteLength(JSON.stringify(filing)) > limit.inputBytes) return { answer: "Not filed: the resolved review is too large. Use fewer excerpts or references." };
	return { filing,
		answer: [`Filed as the review of ${head.slice(0, 7)}: ${checked.recommendation.replaceAll("_", " ")}, ${blocking} blocking findings, ${kept.screenshots.length} screenshots.`, ...notes, "End your turn now."].join(" ") };
}

export function reportOf(input: unknown, redactor: TextRedactor): Refusal | { ok: true; report: AgentReport; shots: ShotRequest[] } {
	const raw = rawProblem(input, "report");
	if (raw) return { ok: false, problems: [raw] };
	if (!isObject(input)) return { ok: false, problems: ["the report must be an object"] };
	const read = new Fields(redactor);
	read.keys(input, "report", ["title", "description", "concerns", "look_at", "screenshots"]);
	const title = read.text(input.title, "title", MAX_PUBLISH_TITLE_CHARS);
	if (typeof input.title === "string" && !title.trim()) read.problem("title", "the report needs a title");
	if (title.includes("\n")) read.problem("title", "must be one line");
	const optional = (key: string, max: number) => input[key] === undefined ? "" : read.text(input[key], key, max);
	const shots = shotRequest(input.screenshots, redactor);
	if ("problems" in shots) read.problems.push(...shots.problems);
	const report: AgentReport = { screenshots: [], title, description: optional("description", MAX_PUBLISH_BODY_CHARS), concerns: optional("concerns", MAX_PUBLISH_BODY_CHARS), lookAt: optional("look_at", limit.lookAtChars) };
	return read.problems.length || "problems" in shots ? { ok: false, problems: read.problems } : { ok: true, report, shots };
}

/** The host tool's reply. A refusal leaves the previously filed report alone. */
type UploadShots = (shots: ShotRequest[]) => Promise<{ screenshots: AgentReport["screenshots"]; files: string[]; problems: string[] }>;
type TakeReport = (report: AgentReport, answer: string) => void;
export function fileReport(given: unknown, redactor: TextRedactor, take: TakeReport): string;
export function fileReport(given: unknown, redactor: TextRedactor, take: TakeReport, upload: UploadShots | null): string | Promise<string>;
export function fileReport(given: unknown, redactor: TextRedactor, take: TakeReport, upload?: UploadShots | null): string | Promise<string> {
	const checked = reportOf(given, redactor);
	if (!checked.ok) return checked.problems.join("\n");
	const finish = (answer: string) => {
		take(checked.report, answer);
		return answer;
	};
	if (!checked.shots.length) return finish(REPORT_TAKEN);
	if (!upload) return finish("Screenshots are not kept on this deployment (no storage is configured); your report was filed without them.");
	return upload(checked.shots).then(({ screenshots, files, problems }) => {
		checked.report.screenshots = screenshots;
		const n = files.length;
		const what = n ? ` with ${n} screenshot${n === 1 ? "" : "s"} (${files.map(f => "`" + f + "`").join(", ")})` : " without screenshots";
		return finish([`Your report was filed${what}.`, ...problems, "End your turn now."].join(" "));
	});
}

/** Only the parts the builder filed become blocks. Its concerns have the builder's 4,000-character allowance. */
export function reportBlocks(report: Omit<AgentReport, "screenshots"> & Partial<Pick<AgentReport, "screenshots">>): ReviewBlock[] {
	const blocks: ReviewBlock[] = [];
	if (report.description) blocks.push({ kind: "text", heading: "What it did", text: report.description, refs: [] });
	if (report.lookAt) blocks.push({ kind: "text", heading: "Where to look", text: report.lookAt, refs: [] });
	if (report.concerns) blocks.push({ kind: "risk", text: report.concerns, at: [] });
	for (const shot of report.screenshots ?? []) blocks.push({ kind: "screenshot", attachment: shot.id });
	return blocks;
}

/** Bound outside text before escaping, so twenty all-punctuation criteria still fit in GitHub's comment. */
export function commentText(value: string, max: number): string {
	const line = value.replace(/\s+/g, " ").replace(CONTROL, "").trim();
	const bounded = line.length > max ? `${line.slice(0, max)}…` : line;
	return bounded.replace(/([\\`*_{}\[\]()<>!&~|@#:$.])/g, "\\$1").replace(/^([-+=])/, "\\$1");
}

/** Allow only heading/list prefixes and complete, single-line code spans from agent prose. */
function agentMarkdown(value: string, max: number): string {
	const clean = value.replace(/\r\n?/g, "\n").replace(CONTROL, "");
	const bounded = clean.length > max ? clean.slice(0, max) + "…" : clean;
	const literal = (text: string) => text
		// GitHub also linkifies plain text after Markdown parsing. Break its triggers in the text itself.
		.replace(/@|#(?=\d)|(?:https?|ftp)(?=:)|www(?=\.)|\bgh(?=-\d)/gi, "$&\u200B")
		.replace(/\b[a-f\d]{7,64}\b/gi, sha => sha.replace(/.{6}(?=.)/g, "$&\u200B"))
		.replace(/([\\`*_{}\[\]()<>!&~|#$])/g, "\\$1");
	return bounded.split("\n").map(line => {
		const prefix = /^(\s*(?:#{1,6}|[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line)?.[0] ?? "";
		const content = line.slice(prefix.length);
		const parts: string[] = [prefix];
		let end = 0;
		for (const span of content.matchAll(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
			parts.push(literal(content.slice(end, span.index)), span[0]);
			end = span.index + span[0].length;
		}
		parts.push(literal(content.slice(end)));
		return parts.join("");
	}).join("\n");
}

type CommentReview = { filed: ItemReview | null; reason: string | null; owner: string; name: string };

function reviewParagraphs(item: string, review: CommentReview): string[] {
	const r = review.filed;
	if (!r?.recommendation) return review.reason ? [`No second review: ${commentText(review.reason.replace(/\.$/, ""), 500)}.`] : [];
	const words = { approve: "approves", changes_requested: "asks for changes", needs_person: "needs you" };
	const summary = r.blocks.find(block => block.kind === "summary");
	const paragraphs = [`Second review at ${r.head.slice(0, 7)}: ${words[r.recommendation]}.`];
	if (summary?.text) paragraphs.push(agentMarkdown(summary.text, limit.summaryChars));
	const rank = { blocking: 0, should_fix: 1, note: 2 };
	const labels = { blocking: "Blocking", should_fix: "Should fix", note: "Note" };
	const findings = r.blocks.filter(block => block.kind === "finding").sort((a,b) => rank[a.severity] - rank[b.severity]);
	const component = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
	const lines = findings.slice(0, 15).map(f => {
		const at = f.at[0];
		let location = "";
		if (at) {
			const sha = at.side === "base" ? r.base : r.head;
			const path = at.path.split("/").map(component).join("/");
			const anchor = at.lines ? `#L${at.lines.start}-L${at.lines.end}` : "";
			location = `[${commentText(at.path, 300)}${at.lines ? ":" + at.lines.start : ""}](https://github.com/${component(review.owner)}/${component(review.name)}/blob/${sha}/${path}${anchor}) · `;
		}
		return `- ${labels[f.severity]} · ${location}${agentMarkdown(f.title, limit.findingTitleChars).replaceAll("\n", "\n  ")}`;
	});
	if (findings.length > lines.length) lines.push(`and ${findings.length - lines.length} more on the item's page`);
	if (lines.length) paragraphs.push(lines.join("\n"));
	const n = r.screenshots.length;
	paragraphs.push(`The whole review${n ? ` and ${n} screenshot${n === 1 ? "" : "s"}` : ""}: ${config.origins[0]}/items/${item} (opens for the item's owner only)`);
	return paragraphs;
}

export function feedbackComment(who: string, run: number) {
	return commentText(feedbackWords.working(who, run), 2000);
}

export function itemComment(verdict: Verdict, words: string, report: ItemReport | null, review?: CommentReview, feedback?: { who: string; run: number }): string {
	// The marker is an HTML comment GitHub must find byte for byte. Only a platform id belongs there.
	if (!/^[\w-]{1,128}$/.test(verdict.item) || verdict.item.includes("--")) throw new Error("Invalid item id for the verdict comment.");
	const headline = verdictWords(verdict, null).split(".", 1)[0];
	const paragraphs = [`<!-- windlass-item:${verdict.item} -->`, `**Windlass at ${commentText(verdict.head.slice(0, 7), 7)}: ${headline}**`, commentText(words, MAX_NOTE_CHARS)];
	if (feedback) paragraphs.push(feedbackComment(feedback.who, feedback.run));
	const criteria = verdict.acceptance.slice(0, MAX_ACCEPTANCE_CRITERIA).map((one) => `- ${commentText(one, 1000)}`);
	if (criteria.length) paragraphs.push(`Acceptance criteria left to you:\n\n${criteria.join("\n")}`);
	if (review) paragraphs.push(...reviewParagraphs(verdict.item, review));
	if (report) {
		paragraphs.push("## Builder's report", agentMarkdown(report.title, MAX_PUBLISH_TITLE_CHARS));
		for (const block of report.blocks) {
			if (block.kind === "text") {
				const where = block.heading === "Where to look";
				paragraphs.push(where ? "### Where to look" : "### What it did", agentMarkdown(block.text, where ? limit.lookAtChars : MAX_PUBLISH_BODY_CHARS));
			}
			if (block.kind === "risk") paragraphs.push("### What the builder is unsure of", agentMarkdown(block.text, MAX_PUBLISH_BODY_CHARS));
		}
	}
	const count = report?.blocks.filter(block => block.kind === "screenshot").length ?? 0;
	const maxBytes = 60_000;
	let link = count ? `\n\n${count} screenshot${count === 1 ? "" : "s"} on the item's page: ${config.origins[0]}/items/${verdict.item} (opens for the item's owner only)` : "";
	const body = paragraphs.join("\n\n");
	// Even an oversized configured origin must leave room for the item marker.
	if (Buffer.byteLength(paragraphs[0] + "\n…" + link) > maxBytes) link = "";
	const budget = maxBytes - Buffer.byteLength(link);
	if (Buffer.byteLength(body) <= budget) return body + link;
	// Truncate between lines so no code span, generated link or UTF-8 character is cut in half.
	const prefix = Buffer.from(body).subarray(0, budget - Buffer.byteLength("…"));
	return prefix.subarray(0, prefix.lastIndexOf(10) + 1).toString() + "…" + link;
}
