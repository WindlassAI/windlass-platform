/** The pieces of a conversation: one component per kind of block the timeline reducer produces. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { parseDiff } from "../lib/diff";
import { absoluteTime, count, duration, percent, plural } from "../lib/format";
import { codeText, toolCopyLabels, toolInputText, toolOutputText } from "../lib/copy";
import { reasoningTitle, renderMarkdown } from "../lib/markdown";
import { callKey, type Block, type ChecksBlock, type ErrorBlock, type NoteBlock, type NoticeBlock, type PlatformBlock, type ReasoningBlock, type TextBlock, type ToolBlock, type ToolState, type TurnView, type UserBlock } from "../lib/timeline";
import { formatInput, summarizeTool } from "../lib/toolSummary";
import { useNow } from "../state/hooks";
import { CopyButton, useLatest } from "./Copy";
import { DiffHunks } from "./DiffView";
import { AskIcon, CheckIcon, ChevronIcon, CrossIcon, InfoIcon, Mark, RefusedIcon, RingIcon, SandboxedIcon, SteerIcon, StopIcon, ThoughtIcon, WarnIcon } from "./Icons";
import { AnswerLine, AskedLine, InlineQuestion, useInteractive } from "./Question";
import { OUTCOME_TONE, OUTCOME_WORD, OutcomeGlyph } from "./Status";

// ---------------------------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------------------------

export function Markdown({ text, streaming = false, className = "", copyCode = false }: { text: string; streaming?: boolean; className?: string; copyCode?: boolean }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	const root = useRef<HTMLDivElement>(null);
	// The HTML is sanitised by DOMPurify in renderMarkdown.
	return (
		<>
			<div ref={root} className={`prose${streaming ? " prose-streaming" : ""}${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
			{/* Not while the text streams in: the HTML is replaced with every chunk, and the last block may be half written. */}
			{copyCode && !streaming ? <CodeCopies root={root} html={html} /> : null}
		</>
	);
}

/**
 * A copy control beside each code block of rendered Markdown. The blocks are HTML, not React, so each
 * `pre` is wrapped in a box once the HTML is in place, and the control is portalled into a slot at the
 * start of that box. A sibling of the prose rather than part of it, so that only this re-renders when
 * the boxes are found, never the text.
 */
function CodeCopies({ root, html }: { root: RefObject<HTMLDivElement | null>; html: string }) {
	const [slots, setSlots] = useState<HTMLElement[]>([]);
	useLayoutEffect(() => {
		const prose = root.current;
		if (!prose) return;
		const found = Array.from(prose.querySelectorAll("pre"), (pre) => {
			let box = pre.parentElement;
			if (!box?.classList.contains("code-block")) {
				box = document.createElement("div");
				box.className = "code-block";
				pre.replaceWith(box);
				box.append(pre);
			}
			let slot = box.querySelector<HTMLElement>(":scope > .code-copy");
			if (!slot) {
				slot = document.createElement("span");
				slot.className = "code-copy";
				box.prepend(slot);
			}
			return slot;
		});
		setSlots(found);
	}, [root, html]);
	return slots.map((slot, index) =>
		createPortal(
			<CopyButton
				text={() => {
					const pre = slot.parentElement?.querySelector("pre");
					return pre ? codeText(pre) : "";
				}}
				label={slots.length > 1 ? `Copy code block ${index + 1} of ${slots.length}` : "Copy this code block"}
			/>,
			slot,
			String(index),
		),
	);
}

function UserPrompt({ block }: { block: UserBlock }) {
	if (block.steer) {
		return (
			<div className="user user-steer">
				<span className="user-caret" aria-hidden="true">
					<SteerIcon size={14} />
				</span>
				<div className="user-body">
					<p className="user-text">
						<span className="visually-hidden">You, while it worked: </span>
						{block.text}
					</p>
					<div className="user-foot">
						<p className="user-meta">
							<span>steer</span>
							{block.at !== null ? <time dateTime={new Date(block.at).toISOString()}>{absoluteTime(block.at)}</time> : null}
						</p>
						<CopyButton text={block.text} label="Copy this message" />
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="user">
			<span className="user-caret" aria-hidden="true">
				<ChevronIcon size={15} />
			</span>
			<div className="user-body">
				<p className="user-text">
					<span className="visually-hidden">You: </span>
					{block.text}
				</p>
				<div className="user-foot">
					<p className="user-meta">
						<span>{block.model}</span>
						{block.effort ? <span>effort {block.effort}</span> : null}
						{block.at !== null ? <time dateTime={new Date(block.at).toISOString()}>{absoluteTime(block.at)}</time> : null}
					</p>
					<CopyButton text={block.text} label="Copy this prompt" />
				</div>
			</div>
		</div>
	);
}

function AssistantText({ block }: { block: TextBlock }) {
	// Read when pressed: while the answer streams, the control copies what has arrived without re-rendering with it.
	const text = useLatest(block.text);
	return (
		<div className="answer">
			<Markdown text={block.text} streaming={block.streaming} copyCode />
			<CopyButton text={text} label="Copy this answer as Markdown" />
		</div>
	);
}

function Reasoning({ block }: { block: ReasoningBlock }) {
	const [open, setOpen] = useState(false);
	const title = reasoningTitle(block.text);
	return (
		<div className={`reasoning${block.streaming ? " reasoning-streaming" : ""}`}>
			<button type="button" className="line-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span className="line-glyph tone-dim">
					<ThoughtIcon size={13} />
				</span>
				<span className="reasoning-word">{block.streaming ? "thinking" : "thought"}</span>
				{title ? <span className="reasoning-title">{title}</span> : null}
				<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
			</button>
			{open ? <Markdown text={block.text} streaming={block.streaming} className="reasoning-body" /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

const TOOL_STATE_WORD: Record<ToolState, string> = {
	input: "writing the call",
	queued: "queued",
	asking: "waiting for you",
	running: "running",
	done: "done",
	failed: "failed",
	refused: "refused",
};

function ToolGlyph({ block }: { block: ToolBlock }) {
	switch (block.state) {
		case "input":
			return <span className="dots" aria-hidden="true" />;
		case "queued":
			return <RingIcon size={14} className="tone-faint" />;
		case "asking":
			return <AskIcon size={14} className="tone-info" />;
		case "running":
			return block.stopRequested ? <StopIcon size={14} className="tone-warn pulse" /> : <Mark size={15} turning className="tone-accent" />;
		case "done":
			return <CheckIcon size={14} className="tone-accent settle" />;
		case "refused":
			return <RefusedIcon size={14} className="tone-warn settle" />;
		case "failed":
			return block.interrupted ? <StopIcon size={14} className="tone-warn settle" /> : <CrossIcon size={14} className="tone-bad settle" />;
	}
}

const OUTPUT_LINES = 24;

/** Monospace output, capped: the first lines of a finished output, or the last lines of one still arriving. */
export function Output({ text, tail = false, limit = OUTPUT_LINES, label }: { text: string; tail?: boolean; limit?: number; label: string }) {
	const [all, setAll] = useState(false);
	const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
	const hidden = Math.max(0, lines.length - limit);
	const shown = all || hidden === 0 ? lines : tail ? lines.slice(-limit) : lines.slice(0, limit);
	return (
		<div className="output">
			{tail && hidden > 0 && !all ? <p className="output-more output-more-top">{plural(hidden, "earlier line")} above</p> : null}
			<pre className="output-text" tabIndex={0} aria-label={label}>
				{shown.join("\n")}
			</pre>
			{hidden > 0 ? (
				<button type="button" className="output-more" onClick={() => setAll((value) => !value)}>
					{all ? "show less" : `show ${plural(hidden, "more line")}`}
				</button>
			) : null}
		</div>
	);
}

function ToolBody({ block }: { block: ToolBlock }) {
	const input = formatInput(block);
	const diff = typeof block.display?.diff === "string" ? parseDiff(block.display.diff) : [];
	const output = block.output ?? block.progress;
	// Read when pressed, so that a running call's output is copied as far as it has come.
	const latest = useLatest(block);
	const copyInput = useCallback(() => toolInputText(latest()), [latest]);
	const copyOutput = useCallback(() => toolOutputText(latest()), [latest]);
	const labels = toolCopyLabels(block);
	return (
		<div className="tool-body">
			<section className="tool-part" aria-label="Input">
				<div className="tool-part-head">
					<h4 className="tool-part-title">input</h4>
					{input.trim() !== "" ? <CopyButton text={copyInput} label={labels.input} /> : null}
				</div>
				{input.trim() === "" ? <p className="tool-part-empty">no arguments</p> : <Output text={input} label={`Input of ${block.name}`} limit={16} />}
			</section>
			<section className="tool-part" aria-label="Output">
				<div className="tool-part-head">
					<h4 className="tool-part-title">
						{block.output === null ? (block.state === "running" ? "output so far" : "output") : "output"}
						{block.truncated ? <span className="tool-part-note">capped by Windlass: {count(block.truncated.originalLines)} lines in total</span> : null}
					</h4>
					{diff.length > 0 || (output !== null && output !== "") ? <CopyButton text={copyOutput} label={labels.output} /> : null}
				</div>
				{diff.length > 0 ? (
					<div className="tool-diff">
						{diff.map((file) => (
							<DiffHunks key={file.path} file={file} />
						))}
					</div>
				) : output === null || output === "" ? (
					<p className="tool-part-empty">{block.state === "running" ? "nothing yet" : block.state === "input" || block.state === "queued" || block.state === "asking" ? "not run yet" : "no output"}</p>
				) : (
					<Output text={output} tail={block.output === null} label={`Output of ${block.name}`} />
				)}
			</section>
		</div>
	);
}

/** How many lines of a failed or running call are shown without opening it. */
const PREVIEW_LINES = 5;

/** "Stop this call": an icon button beside a running call's row. */
function StopCallButton({ block, stop }: { block: ToolBlock; stop: (block: ToolBlock) => Promise<{ stopped: boolean; message: string | null }> }) {
	const [asking, setAsking] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const target = summarizeTool(block).target;

	useEffect(() => {
		if (refusal === null) return;
		const timer = setTimeout(() => setRefusal(null), 6000);
		return () => clearTimeout(timer);
	}, [refusal]);

	const onClick = async () => {
		setAsking(true);
		setRefusal(null);
		try {
			const result = await stop(block);
			if (!result.stopped) setRefusal(result.message ?? "This call could not be asked to stop.");
		} catch (failure) {
			setRefusal(failure instanceof Error ? failure.message : "This call could not be asked to stop.");
		} finally {
			setAsking(false);
		}
	};

	return (
		<>
			<button type="button" className="icon-button icon-button-small tool-stop" onClick={onClick} disabled={asking || block.stopRequested} aria-label={`Stop this call: ${block.name}${target ? ` ${target}` : ""}`} title="Stop this call">
				<StopIcon size={12} />
			</button>
			{refusal ? (
				<p className="tool-stop-refused" role="status">
					{refusal}
				</p>
			) : null}
		</>
	);
}

function toolStateWord(block: ToolBlock, exitCode: number | null): string | null {
	switch (block.state) {
		case "done":
			return null;
		case "failed":
			if (block.stoppedByUser) return "stopped by you";
			if (block.interrupted) return "stopped";
			return exitCode !== null ? null : "failed";
		case "refused":
			if (block.answer && !block.answer.approve) return block.answer.by === "platform" ? "declined, no answer" : "declined";
			return TOOL_STATE_WORD.refused;
		case "running":
			return block.stopRequested ? "stopping" : TOOL_STATE_WORD.running;
		default:
			return TOOL_STATE_WORD[block.state];
	}
}

const ToolRow = memo(function ToolRow({ block }: { block: ToolBlock }) {
	const [open, setOpen] = useState(false);
	const interactive = useInteractive();
	const running = block.state === "running";
	const now = useNow(1000, running);
	const summary = summarizeTool(block);
	const elapsed = running && block.startedAt !== null ? Math.max(0, now - block.startedAt) : null;
	const question = interactive?.flow.question ?? null;
	const asked = question !== null && block.state === "asking" && callKey(question) === callKey(block) ? question : null;
	const stopCall = running && !block.stopRequested ? (interactive?.stopCall ?? null) : null;

	const stateWord = toolStateWord(block, summary.exitCode);
	// Under the row, without opening it: output as it arrives, and the end of what a failed call printed.
	const preview = open ? null : running ? block.progress : block.state === "failed" ? block.output : null;
	const previewLines = preview
		? preview
				.split("\n")
				.filter((line) => line.trim() !== "")
				.slice(-PREVIEW_LINES)
		: [];

	return (
		<div className={`tool tool-${block.state}${block.interrupted ? " tool-interrupted" : ""}${stopCall ? " tool-stoppable" : ""}`}>
			<div className="tool-head">
				<button type="button" className="line-button tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					<span className="line-glyph">
						<ToolGlyph block={block} />
					</span>
					<span className="tool-name">{block.name || "tool"}</span>
					<span className="tool-target">{summary.target}</span>
					{block.sandboxed === true ? (
						<span className="tool-sandboxed" title="Ran inside Windlass's own sandbox">
							<SandboxedIcon size={12} />
							<span className="visually-hidden">sandboxed</span>
						</span>
					) : null}
					<span className="tool-facts">
						{summary.facts
							// A call the user stopped ends with a signal's exit code, which says nothing they do not know.
							.filter((fact) => !(block.stoppedByUser && fact.startsWith("exit ")))
							.map((fact) => (
								<span key={fact} className={fact.startsWith("exit ") && summary.exitCode !== 0 ? "tone-bad" : undefined}>
									{fact}
								</span>
							))}
						{stateWord ? <span className={`tool-state tool-state-${block.state}`}>{stateWord}</span> : null}
						{elapsed !== null ? <span>{duration(Math.max(1000, Math.floor(elapsed / 1000) * 1000))}</span> : block.durationMs !== null ? <span>{duration(block.durationMs)}</span> : null}
					</span>
					<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
				</button>
				{stopCall ? <StopCallButton block={block} stop={stopCall} /> : null}
			</div>
			{block.refusal ? <p className="tool-refusal">{block.refusal.text}</p> : null}
			{asked && interactive ? (
<InlineQuestion question={asked} flow={interactive.flow} underItsCall />
			) : block.state === "asking" ? (
				<AskedLine block={block} />
			) : (
				<AnswerLine block={block} />
			)}
			{previewLines.length > 0 ? (
				<pre className="tool-preview" aria-hidden={running ? undefined : true}>
					{previewLines.join("\n")}
				</pre>
			) : null}
			{open ? <ToolBody block={block} /> : null}
		</div>
	);
});

// ---------------------------------------------------------------------------------------------
// Checks, notices, errors, system lines
// ---------------------------------------------------------------------------------------------

function Checks({ block }: { block: ChecksBlock }) {
	const [open, setOpen] = useState(false);
	const failing = block.results.filter((result) => result.status !== "passed");
	const words =
		block.state === "running"
			? "running"
			: block.state === "passed"
				? `${plural(block.results.length, "check")} passed`
				: block.state === "failed"
					? `${failing.map((result) => result.name).join(", ")} failed`
					: (block.message ?? "did not finish");
	const expandable = block.results.length > 0 || block.report !== null;
	const row = (
		<>
			<span className="line-glyph">
				{block.state === "running" ? <Mark size={15} turning className="tone-accent" /> : block.state === "passed" ? <CheckIcon size={14} className="tone-accent settle" /> : block.state === "failed" ? <CrossIcon size={14} className="tone-bad settle" /> : <WarnIcon size={14} className="tone-warn settle" />}
			</span>
			<span className="tool-name">checks</span>
			<span className="tool-target">{block.names.join(", ")}</span>
			<span className="tool-facts">
				<span className={block.state === "failed" ? "tone-bad" : block.state === "error" ? "tone-warn" : undefined}>{words}</span>
				<span>run {block.run}</span>
			</span>
		</>
	);
	return (
		<div className={`tool tool-checks tool-checks-${block.state}`}>
			{expandable ? (
				<button type="button" className="line-button tool-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					{row}
					<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
				</button>
			) : (
				<div className="line-button tool-row tool-row-static">{row}</div>
			)}
			{open ? (
				<div className="tool-body">
					{block.results.length > 0 ? (
						<section className="tool-part" aria-label="Results">
							<h4 className="tool-part-title">the project's checks</h4>
							<ul className="check-list">
								{block.results.map((result) => (
									<li key={result.name}>
										{result.status === "passed" ? <CheckIcon size={13} className="tone-accent" /> : <CrossIcon size={13} className="tone-bad" />}
										<span className="check-name">{result.name}</span>
										<code>{result.command}</code>
										<span className={result.status === "passed" ? "tone-dim" : "tone-bad"}>
											{result.status.replace(/_/g, " ")}
											{result.exitCode !== null && result.exitCode !== 0 ? `, exit ${result.exitCode}` : ""}
										</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
					{block.report !== null ? (
						<section className="tool-part" aria-label="What the model was told">
							<h4 className="tool-part-title">what Windlass told the model</h4>
							<Output text={block.report} label="Check report" />
						</section>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function Callout({ tone, title, children, detail }: { tone: "warn" | "bad" | "info"; title: string; children: ReactNode; detail?: string | null }) {
	return (
		<div className={`callout callout-${tone} callout-block`} role={tone === "bad" ? "alert" : "note"}>
			{tone === "info" ? <InfoIcon /> : <WarnIcon />}
			<div>
				<p className="callout-title">{title}</p>
				{children}
				{detail ? <p className="callout-detail">{detail}</p> : null}
			</div>
		</div>
	);
}

/** Windlass's one sentence that untrusted content is now in the conversation: said once, quietly. */
function TaintLine({ block }: { block: NoticeBlock }) {
	return (
		<p className="taint" role="note">
			<InfoIcon size={13} />
			<span>{block.text}</span>
		</p>
	);
}

function Notice({ block }: { block: NoticeBlock }) {
	if (block.noticeKind === "taint") return <TaintLine block={block} />;
	const [open, setOpen] = useState(false);
	const [first = "", ...rest] = block.text.split("\n");
	const more = rest.join("\n").trim();
	return (
		<Callout tone={block.noticeKind === "no_closing_answer" ? "info" : "warn"} title={block.title}>
			<p className="callout-text">{first}</p>
			{more !== "" ? (
				<>
					{open ? <pre className="callout-more">{more}</pre> : null}
					<button type="button" className="link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
						{open ? "hide the details" : "what would fix it"}
					</button>
				</>
			) : null}
		</Callout>
	);
}

function ErrorLine({ block }: { block: ErrorBlock }) {
	return (
		<Callout tone="bad" title={block.title} detail={block.detail}>
			<p className="callout-text">{block.message}</p>
		</Callout>
	);
}

function SystemLine({ block }: { block: PlatformBlock | NoteBlock }) {
	const tone = block.kind === "platform" ? (block.level === "error" ? "bad" : block.level === "warn" ? "warn" : "dim") : block.tone;
	return (
		<p className={`system tone-${tone}`}>
			<span className="system-rule" aria-hidden="true" />
			<span className="system-source">{block.kind === "platform" ? "platform" : "windlass"}</span>
			<span className="system-text">{block.text}</span>
		</p>
	);
}

// ---------------------------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------------------------

const VERIFICATION_WORD: Record<string, string> = {
	not_configured: "no checks configured",
	not_needed: "checks not needed",
	passed: "checks passed",
	unresolved: "checks unresolved",
};

function TurnSummary({ turn }: { turn: TurnView }) {
	const end = turn.end;
	if (!end) return null;
	const tone = OUTCOME_TONE[end.outcome];
	const steps = end.steps ?? (turn.steps > 0 ? turn.steps : null);
	const usage = end.usage;
	const share = end.cachedShare ?? (usage && usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : null);
	const files = turn.changedFiles;
	return (
		<div className={`turn-end turn-end-${tone}`}>
			<p className="turn-end-line">
				<span className="line-glyph">
					<OutcomeGlyph outcome={end.outcome} />
				</span>
				<strong className={`tone-${tone}`}>{OUTCOME_WORD[end.outcome]}</strong>
				{turn.verification && VERIFICATION_WORD[turn.verification] && end.outcome !== "unresolved" ? <span>{VERIFICATION_WORD[turn.verification]}</span> : null}
				{steps !== null ? <span>{plural(steps, "step")}</span> : null}
				<span>{duration(end.durationMs)}</span>
				<span>turn {turn.turn}</span>
				{end.exitCode !== null && end.exitCode !== 0 ? <span>exit {end.exitCode}</span> : null}
			</p>
			{end.message ? <p className="turn-end-message">{end.message}</p> : null}
			{files && files.length > 0 ? (
				<p className="turn-end-line turn-end-sub">
					<span>
						changed {plural(files.length, "file")}:{" "}
						{files.slice(0, 4).map((file, index) => (
							<span key={file}>
								{index > 0 ? ", " : ""}
								<code>{file}</code>
							</span>
						))}
						{files.length > 4 ? ` and ${files.length - 4} more` : ""}
					</span>
				</p>
			) : null}
			{usage ? (
				<p className="turn-end-line turn-end-sub">
					<span>tokens</span>
					<span>{count(usage.inputTokens)} in</span>
					<span>
						{count(usage.cachedInputTokens)} cached ({percent(share)})
					</span>
					<span>{count(usage.outputTokens)} out</span>
				</p>
			) : end.outcome !== "error" ? (
				<p className="turn-end-line turn-end-sub">
					<span>no token counts were reported</span>
				</p>
			) : null}
		</div>
	);
}

function renderBlock(block: Block): ReactNode {
	switch (block.kind) {
		case "user":
			return <UserPrompt block={block} />;
		case "text":
			return <AssistantText block={block} />;
		case "reasoning":
			return <Reasoning block={block} />;
		case "tool":
			return <ToolRow block={block} />;
		case "checks":
			return <Checks block={block} />;
		case "notice":
			return <Notice block={block} />;
		case "error":
			return <ErrorLine block={block} />;
		case "platform":
		case "note":
			return <SystemLine block={block} />;
	}
}

/** One turn: the prompt, what happened, and how it ended. Re-renders only when the turn changed. */
export const Turn = memo(function Turn({ turn }: { turn: TurnView }) {
	const interactive = useInteractive();
	const question = interactive?.flow.question ?? null;
	// A question about a call this timeline does not show (a subagent's own call) goes at the end of its turn.
	const loose = question !== null && question.turn === turn.turn && !turn.blocks.some((block) => block.kind === "tool" && block.state === "asking" && callKey(block) === callKey(question)) ? question : null;
	return (
		<section className="turn" aria-label={`Turn ${turn.turn}`}>
			{turn.blocks.map((block) => (
				<div key={block.id} className={`block block-${block.kind}${block.kind === "user" && block.steer ? " block-steer" : ""}${block.kind === "notice" && block.noticeKind === "taint" ? " block-taint" : ""}`}>
					{renderBlock(block)}
				</div>
			))}
			{loose && interactive ? (
				<InlineQuestion question={loose} flow={interactive.flow} className="block block-question" />
			) : null}
			<TurnSummary turn={turn} />
		</section>
	);
});
