/**
 * What an agent wrote for an item's page, shown as the platform renders it: typed blocks (contract.ts,
 * `ReviewBlock`), never the agent's markup. In R1 the only author is the agent that made the change
 * (`ItemReport`, by "builder"); the reviewer's blocks come from R3 and render the same way.
 *
 * Agent text goes through `ReviewText` alone: paragraphs, "- " bullets, `code` spans and fenced code,
 * as React text nodes. Nothing in it becomes a link, an image or markup: `InlineMarkdown` is never
 * used here. A block's reference to a platform record shows the platform's record beside the author's
 * claim, and says plainly when they disagree.
 */
import { REVIEW_LIMITS, type CheckStatus, type ReviewBlock, type ReviewLocation, type ReviewRecord, type ReviewRef, type Verdict } from "@contract";
import type { ReactNode } from "react";

/** A run's conclusions that are a failure (server/src/factory/verdict.ts, `FAILING_CONCLUSIONS`): `error` is a commit status that errored. */
export const FAILING_CONCLUSIONS = ["failure", "timed_out", "startup_failure", "action_required", "error"];
/** CI's conclusions that mean the check did not run to a result. */
const NOT_RUN_CONCLUSIONS = ["not_run", "skipped", "cancelled", "neutral", "stale"];

export const CHECK_WORD: Record<CheckStatus, string> = { passed: "passed", failed: "failed", timed_out: "timed out", could_not_start: "could not start", interrupted: "was interrupted" };
export const CHECK_TONE: Record<CheckStatus, string> = { passed: "good", failed: "bad", timed_out: "bad", could_not_start: "warn", interrupted: "warn" };

export const conclusionTone = (conclusion: string) => (conclusion === "success" ? "tone-good" : conclusion === "not_run" ? "tone-warn" : FAILING_CONCLUSIONS.includes(conclusion) ? "tone-bad" : "tone-dim");
export const conclusionWord = (conclusion: string) => (conclusion === "" ? "still running" : conclusion.replace(/_/g, " "));

// ---- the text -----------------------------------------------------------------------------------

type Part = { kind: "p"; text: string } | { kind: "ul"; items: string[] } | { kind: "pre"; lines: string[]; cut: number };

/** The agent's text in parts: fences first (a fence runs to its closing ``` or to the end), then lists and paragraphs on blank lines. */
export function partsOf(text: string): Part[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const parts: Part[] = [];
	let paragraph: string[] = [];
	let list: string[] | null = null;
	const close = () => {
		if (paragraph.length > 0) parts.push({ kind: "p", text: paragraph.join("\n") });
		if (list) parts.push({ kind: "ul", items: list });
		paragraph = [];
		list = null;
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (/^\s*```/.test(line)) {
			close();
			const code: string[] = [];
			for (index += 1; index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? ""); index++) code.push(lines[index] ?? "");
			const shown = code.slice(0, REVIEW_LIMITS.fenceLines);
			parts.push({ kind: "pre", lines: shown, cut: code.length - shown.length });
			continue;
		}
		if (line.trim() === "") {
			close();
			continue;
		}
		if (line.startsWith("- ")) {
			if (paragraph.length > 0) close();
			list ??= [];
			list.push(line.slice(2));
			continue;
		}
		if (list) close();
		paragraph.push(line);
	}
	close();
	return parts;
}

/** A line with its `code` spans: text nodes and `code` elements only. */
export function Inline({ text }: { text: string }) {
	const out: ReactNode[] = [];
	const span = /`([^`\n]+)`/g;
	let last = 0;
	for (let match = span.exec(text); match; match = span.exec(text)) {
		if (match.index > last) out.push(text.slice(last, match.index));
		out.push(<code key={match.index}>{match[1]}</code>);
		last = match.index + match[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return <>{out}</>;
}

/** An agent's text, as the platform renders it: paragraphs, bullets, `code` spans and fenced code (at most REVIEW_LIMITS.fenceLines lines each). Nothing else is read into it. */
export function ReviewText({ text }: { text: string }) {
	return (
		<div className="review-text">
			{partsOf(text).map((part, index) =>
				part.kind === "p" ? (
					<p key={index}>
						<Inline text={part.text} />
					</p>
				) : part.kind === "ul" ? (
					<ul key={index}>
						{part.items.map((item, at) => (
							<li key={at}>
								<Inline text={item} />
							</li>
						))}
					</ul>
				) : (
					<pre key={index} tabIndex={0}>
						<code>{part.lines.join("\n") + (part.cut > 0 ? "\n…" : "")}</code>
					</pre>
				),
			)}
		</div>
	);
}

// ---- places and records -------------------------------------------------------------------------

/** `path:line`, `path:start–end`, or the path alone; "(base)" for a place before the change. */
export function locationText(at: ReviewLocation): string {
	const lines = at.lines ? (at.lines.end > at.lines.start ? `:${at.lines.start}–${at.lines.end}` : `:${at.lines.start}`) : "";
	return `${at.path}${lines}${at.side === "base" ? " (base)" : ""}`;
}

function Locations({ at }: { at: ReviewLocation[] }) {
	if (at.length === 0) return null;
	return (
		<p className="review-at">
			{at.map((one, index) => (
				<code key={index} className="item-paths">
					{locationText(one)}
				</code>
			))}
		</p>
	);
}

type Outcome = "passed" | "failed" | "not_run" | "other";

/**
 * The platform's record a reference names: the report's own snapshot of it (`records`, as it was when
 * the text was filed) first, else the verdict the report is read against; null when neither has one by
 * that name.
 */
export function recordOf(ref: string, records: ReviewRecord[], verdict: Verdict | null): ReviewRecord | null {
	const kept = records.find((record) => record.ref === ref);
	if (kept) return kept;
	if (!verdict) return null;
	const [kind, ...rest] = ref.split("/");
	const name = rest.join("/");
	const index = /^(0|[1-9][0-9]{0,3})$/.test(name) ? Number(name) : -1;
	if (kind === "check") {
		const check = verdict.gate.required[index];
		return check ? { ref, kind: "check", name: check.name, status: check.status } : null;
	}
	if (kind === "ci") {
		const run = verdict.ci.runs[index];
		return run ? { ref, kind: "ci", ...run } : null;
	}
	if (kind === "flag") {
		const flag = verdict.flags.find((one) => one.kind === name);
		return flag ? { ref, kind: "flag", flag } : null;
	}
	return null;
}

function outcomeOf(record: ReviewRecord): Outcome | null {
	switch (record.kind) {
		case "check":
			return record.status === "passed" ? "passed" : record.status === "failed" || record.status === "timed_out" ? "failed" : record.status === "could_not_start" ? "not_run" : "other";
		case "ci":
			return record.conclusion === "success" ? "passed" : FAILING_CONCLUSIONS.includes(record.conclusion) ? "failed" : NOT_RUN_CONCLUSIONS.includes(record.conclusion) ? "not_run" : "other";
		case "command":
			return record.exitCode === 0 ? "passed" : record.exitCode === null ? "not_run" : "failed";
		case "flag":
			return null;
	}
}

/** Whether the author's claim is not what the record says. A flag has no outcome to claim. */
export function disagrees(says: ReviewRef["says"], record: ReviewRecord): boolean {
	const outcome = outcomeOf(record);
	if (says === undefined || outcome === null) return false;
	switch (says) {
		case "passed":
			return outcome !== "passed";
		case "failed":
			return outcome !== "failed";
		case "ran":
			return outcome === "not_run";
		case "not_run":
			return outcome === "passed" || outcome === "failed";
	}
}

const SAYS: Record<NonNullable<ReviewRef["says"]>, string> = { passed: "it passed", failed: "it failed", ran: "it ran", not_run: "it did not run" };

/** The record in words: "CI lint failure", "Your check unit tests passed", a flag in the verdict's sentence. */
function RecordWords({ record, verdict }: { record: ReviewRecord; verdict: Verdict | null }) {
	switch (record.kind) {
		case "check":
			return (
				<>
					your check <span className="item-check-name">{record.name}</span> <span className={`tone-${CHECK_TONE[record.status]}`}>{CHECK_WORD[record.status]}</span>
				</>
			);
		case "ci":
			return (
				<>
					CI <span className="item-check-name">{record.name}</span> <span className={conclusionTone(record.conclusion)}>{conclusionWord(record.conclusion)}</span>
				</>
			);
		case "flag": {
			const at = verdict?.flags.findIndex((flag) => flag.kind === record.flag.kind) ?? -1;
			return (
				<>
					flagged, <Inline text={verdict?.said?.flags?.[at] ?? record.flag.kind.replace(/_/g, " ")} />
					{record.flag.where.length > 0 ? (
						<>
							{": "}
							<code className="item-paths">{record.flag.where.join(", ")}</code>
						</>
					) : null}
				</>
			);
		}
		case "command":
			return (
				<>
					ran <code className="item-paths">{record.command}</code> <span className={record.exitCode === 0 ? "tone-good" : "tone-bad"}>{record.exitCode === null ? record.outcome : `exit ${record.exitCode}`}</span>
				</>
			);
	}
}

/** What a block names of the platform's records, each beside the author's claim; a claim the record does not bear out is said so plainly. */
function Refs({ refs, records, verdict, author }: { refs: ReviewRef[]; records: ReviewRecord[]; verdict: Verdict | null; author: string }) {
	if (refs.length === 0) return null;
	return (
		<ul className="item-checks review-refs" aria-label="The platform's records it names">
			{refs.map((ref, index) => {
				const record = recordOf(ref.ref, records, verdict);
				if (!record)
					return (
						<li key={index} className="tone-warn" data-disagrees="">
							{author} names <code className="item-paths">{ref.ref}</code>
							{ref.says ? ` and says ${SAYS[ref.says]}` : ""}; the platform has no such record.
						</li>
					);
				if (ref.says && disagrees(ref.says, record))
					return (
						<li key={index} className="review-ref-disagrees" data-disagrees="">
							<span className="tone-warn">
								{author} says {SAYS[ref.says]}; the platform's record:
							</span>{" "}
							<RecordWords record={record} verdict={verdict} />.
						</li>
					);
				return (
					<li key={index}>
						<span className="tone-dim">The platform's record: </span>
						<RecordWords record={record} verdict={verdict} />
						{ref.says ? <span className="tone-dim">, as {author.toLowerCase()} says</span> : null}
						{record.kind === "command" && record.tail ? (
							<details className="review-tail">
								<summary className="tone-dim">its last lines</summary>
								<pre tabIndex={0}>
									<code>{record.tail}</code>
								</pre>
							</details>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

// ---- the blocks ---------------------------------------------------------------------------------

const SEVERITY: Record<Extract<ReviewBlock, { kind: "finding" }>["severity"], string> = { blocking: "Blocking", should_fix: "Should fix", note: "Note" };
const EARLIER: Record<Extract<ReviewBlock, { kind: "earlier" }>["status"], string> = { fixed: "fixed", not_fixed: "not fixed", withdrawn: "withdrawn" };

function Excerpt({ block }: { block: Extract<ReviewBlock, { kind: "excerpt" }> }) {
	const lines = block.code.replace(/\r\n?/g, "\n").split("\n").slice(0, REVIEW_LIMITS.excerptLines);
	const first = block.at.lines?.start ?? 1;
	const width = String(first + lines.length - 1).length;
	return (
		<>
			<Locations at={[block.at]} />
			<pre className="review-excerpt" tabIndex={0}>
				<code>
					{lines.map((line, index) => (
						<span key={index} className="review-line">
							<span className="review-ln" aria-hidden="true">
								{String(first + index).padStart(width, " ")}
							</span>
							{line}
							{"\n"}
						</span>
					))}
				</code>
			</pre>
			{block.note ? <ReviewText text={block.note} /> : null}
		</>
	);
}

/** One block as a row of the page's facts: its kind on the left, the author's words on the right. */
function Block({ block, records, verdict, author }: { block: ReviewBlock; records: ReviewRecord[]; verdict: Verdict | null; author: string }) {
	let label: ReactNode;
	let body: ReactNode;
	switch (block.kind) {
		case "summary":
			label = "Summary";
			body = <ReviewText text={block.text} />;
			break;
		case "text":
			label = block.heading ?? "Notes";
			body = (
				<>
					<ReviewText text={block.text} />
					<Refs refs={block.refs} records={records} verdict={verdict} author={author} />
				</>
			);
			break;
		case "finding":
			label = <span className="review-severity">{SEVERITY[block.severity]}</span>;
			body = (
				<>
					<p className="review-title">{block.title}</p>
					<Locations at={block.at} />
					<ReviewText text={block.text} />
					<Refs refs={block.refs} records={records} verdict={verdict} author={author} />
				</>
			);
			break;
		case "earlier":
			label = "Earlier finding";
			body = (
				<>
					<p className="review-title">
						<code className="item-paths">{block.finding}</code> <span className="review-severity">{EARLIER[block.status]}</span>
					</p>
					{block.text ? <ReviewText text={block.text} /> : null}
				</>
			);
			break;
		case "risk":
			label = "Unsure of";
			body = (
				<>
					<Locations at={block.at} />
					<ReviewText text={block.text} />
				</>
			);
			break;
		case "question":
			label = "It asks";
			body = <ReviewText text={block.text} />;
			break;
		case "excerpt":
			label = "Excerpt";
			body = <Excerpt block={block} />;
			break;
		case "screenshot":
			label = "Screenshot";
			body = <p className="tone-dim">A screenshot was filed; screenshots are not shown on this platform yet.</p>;
			break;
	}
	return (
		<div className={`review-block review-block-${block.kind}`}>
			<dt>{label}</dt>
			<dd>{body}</dd>
		</div>
	);
}

/**
 * The author's blocks, in the order filed, as rows of the page's facts. A reference is read from
 * `records` (the platform's records as they were when the text was filed), else from `verdict`;
 * `author` names who wrote them as a sentence starts ("The agent").
 */
export function ReviewBlocks({ blocks, records, verdict, author }: { blocks: ReviewBlock[]; records: ReviewRecord[]; verdict: Verdict | null; author: string }) {
	return (
		<dl className="usage-facts item-facts review-blocks">
			{blocks.map((block, index) => (
				<Block key={index} block={block} records={records} verdict={verdict} author={author} />
			))}
		</dl>
	);
}
