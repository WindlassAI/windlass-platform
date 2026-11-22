/**
 * The conversation: every turn, a line about what is happening now, and the scrolling that goes with
 * a live log. It follows the output while the reader is at the bottom, stops when they scroll up,
 * and offers a way back.
 */
import type { SandboxProfile, SessionSummary } from "@contract";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clockDuration } from "../lib/format";
import type { SessionView, TurnView } from "../lib/timeline";
import { liveStep } from "../lib/workGroups";
import { useNow } from "../state/hooks";
import { PlatformPrompts, Turn } from "./Blocks";
import { ArrowDownIcon, AskIcon, Mark } from "./Icons";

/** How close to the end counts as "at the bottom", in pixels. */
const NEAR = 48;

const STARTERS = ["Run the tests and fix what fails.", "Check what the sandbox allows.", "Run the full build and tell me if it passes."];

/**
 * The line at the end of a live turn: what the agent does now, in a few words and what it acts on
 * (lib/workGroups.ts `liveStep`), which step it is at and how long the turn has run.
 */
function Working({ summary, turn }: { summary: SessionSummary; turn: TurnView | null }) {
	const now = useNow(1000);
	const since = turn?.blocks[0]?.at ?? summary.updatedAt;
	const elapsed = Math.max(0, now - since);
	const waiting = summary.status === "waiting";
	const running = summary.status === "running";
	const step = running ? liveStep(turn) : null;
	const words = summary.status === "starting" ? "getting the sandbox ready" : summary.status === "stopping" ? "stopping" : waiting ? "waiting for your answer" : (step?.words ?? "working");
	return (
		<p className={`working working-${summary.status}`} role="status">
			<span className="working-weight" aria-hidden="true" />
			{waiting ? <AskIcon size={16} /> : <Mark size={17} turning={summary.status !== "stopping"} />}
			<span className="working-words">{words}</span>
			{step?.target ? <code className="working-target">{step.target}</code> : null}
			{running && turn && turn.steps > 0 ? <span className="working-step">step {turn.steps}</span> : null}
			<span className="working-time">{clockDuration(elapsed)}</span>
		</p>
	);
}

function Empty({ summary, profile, onSuggest }: { summary: SessionSummary; profile: SandboxProfile; onSuggest(text: string): void }) {
	return (
		<div className="conversation-empty">
			<Mark size={64} />
			<h2 className="display display-small">Nothing asked of it yet</h2>
			<p>
				This agent will work in <strong>{profile.name}</strong>
				{summary.repoUrl ? (
					<>
						, on a clone of <code>{summary.repoUrl.replace(/^https:\/\//, "")}</code>
					</>
				) : (
					", in an empty repository"
				)}
				. The sandbox is created when {summary.item ? "its work item sends" : "you send"} the first prompt.
			</p>
			{/* A work item's agent takes its prompts from the item's steps, never from here. */}
			{summary.item ? null : (
				<ul className="starters" aria-label="Prompts to start with">
					{STARTERS.map((text) => (
						<li key={text}>
							<button type="button" className="starter" onClick={() => onSuggest(text)}>
								{text}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function Conversation({ view, summary, profile, onSuggest }: { view: SessionView; summary: SessionSummary; profile: SandboxProfile; onSuggest(text: string): void }) {
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const [away, setAway] = useState(false);

	const toEnd = useCallback((smooth = false) => {
		const element = scroller.current;
		if (!element) return;
		element.scrollTo({ top: element.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
	}, []);

	// Start at the end of what is there.
	useLayoutEffect(() => {
		toEnd();
	}, [toEnd]);

	// Whatever makes the content taller (streamed text, a row opening, a font arriving) keeps the end in view while following.
	useEffect(() => {
		const element = content.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (following.current) toEnd();
		});
		observer.observe(element);
		// The viewport shrinks too, when the question dock opens above the composer: keep the end in view.
		// A reader who scrolled up keeps their place, since nothing above the fold moved.
		if (scroller.current) observer.observe(scroller.current);
		return () => observer.disconnect();
	}, [toEnd]);

	const onScroll = () => {
		const element = scroller.current;
		if (!element) return;
		const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR;
		following.current = atEnd;
		setAway(!atEnd);
	};

	const last = view.turns.at(-1) ?? null;
	const active = summary.status !== "idle";

	return (
		<div className="conversation-wrap">
			<div className="conversation" ref={scroller} onScroll={onScroll} tabIndex={0} role="log" aria-label="Conversation" aria-live="off">
				<div className={`conversation-inner${view.turns.length > 0 ? " timeline" : ""}`} ref={content}>
					{view.turns.length === 0 && !active ? <Empty summary={summary} profile={profile} onSuggest={onSuggest} /> : null}
					{/* An item's second reviewer takes only the platform's prompts: they stand as the platform's, never as a person's. */}
					<PlatformPrompts.Provider value={summary.item?.role === "reviewer"}>
						{view.turns.map((turn) => (
							<Turn key={turn.turn} turn={turn} />
						))}
					</PlatformPrompts.Provider>
					{active ? <Working summary={summary} turn={last && last.end === null ? last : null} /> : null}
				</div>
			</div>
			{away ? (
				<button
					type="button"
					className="jump"
					onClick={() => {
						following.current = true;
						setAway(false);
						toEnd(true);
					}}
				>
					<ArrowDownIcon size={14} />
					Jump to latest
				</button>
			) : null}
		</div>
	);
}
