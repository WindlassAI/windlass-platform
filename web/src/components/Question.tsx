/**
 * The question a turn waits on: the tool call needs the user's approval before it runs. It is shown
 * twice, as one question: in full in the conversation at the call it is about, and compact in a dock
 * above the composer, so that a reader scrolled elsewhere still sees it. Both read the same flow
 * (`useQuestionFlow`): one note, one answer in flight, one error, and answering either settles both.
 *
 * The other question is about an MCP server the project's own configuration names
 * (`PendingQuestion.server`): whether Windlass may start it. It is the same control with what differs
 * left out or reworded. There is no call to hang it under, so it stands at the end of its turn; it
 * names the file that defines the server under the command; there is no note, because the answer goes
 * to Windlass and not to the model; and the countdown says what running out means here, which is that
 * the server stays stopped and the turn goes on. What became of it is a line of the platform's in the
 * conversation, not a line under a call.
 *
 * A third is the platform's own about a request of the agent's to publish the session's work
 * (`PendingQuestion.publish`): the same control again, with what would be published in the subject's
 * place, each part named: the branch, the commit's message, the pull request's title and description.
 * It is declined like a call's, with a note for the agent, and it stands at the end of its turn: the
 * call it belongs to is not waiting on Windlass, whose own question the platform answered itself.
 */
import { MAX_NOTE_CHARS } from "@contract";
import type { PendingQuestion, QuestionChoice } from "@contract";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hasReason, type SessionApi } from "../api/client";
import { absoluteTime, countdown } from "../lib/format";
import type { ToolBlock } from "../lib/timeline";
import { useNow } from "../state/hooks";
import { AskIcon, CheckIcon, InfoIcon, RefusedIcon, WarnIcon } from "./Icons";

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------

export interface QuestionFlow {
	question: PendingQuestion | null;
	/** The choice being sent, while it is. */
	sending: string | null;
	/** Why the last answer did not go through, while the question is still there. */
	error: string | null;
	/** Said once the server reported the question gone (answered elsewhere, expired, withdrawn). */
	gone: string | null;
	note: string;
	setNote(note: string): void;
	answer(choice: QuestionChoice): void;
	/** Whether the question is on screen where it stands in the conversation; the dock steps aside then. */
	inlineInView: boolean;
	setInlineInView(inView: boolean): void;
}

const NOTE_LIMIT = MAX_NOTE_CHARS;

const isTextField = (element: Element | null) => element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLInputElement && element.type !== "button") || (element instanceof HTMLElement && element.isContentEditable);

/** How long the line about a question that went away stays. */
const GONE_MS = 7000;

export function useQuestionFlow(api: SessionApi, question: PendingQuestion | null, explain: (error: unknown) => string): QuestionFlow {
	const [sending, setSending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [gone, setGone] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const [inlineInView, setInlineInView] = useState(false);
	const id = question?.id ?? null;

	// A new question starts clean; a settled one takes its note and error with it.
	useEffect(() => {
		setSending(null);
		setError(null);
		setNote("");
		if (id !== null) setGone(null);
	}, [id]);

	useEffect(() => {
		if (gone === null) return;
		const timer = setTimeout(() => setGone(null), GONE_MS);
		return () => clearTimeout(timer);
	}, [gone]);

	const answer = useCallback(
		(choice: QuestionChoice) => {
			if (!question || sending !== null) return;
			const trimmed = note.trim();
			setSending(choice.id);
			setError(null);
			api.answer({ questionId: question.id, choice: choice.id, note: !choice.approve && trimmed !== "" ? trimmed.slice(0, NOTE_LIMIT) : undefined }).then(
				// The question goes when the server says so (the `question` event), not before.
				() => undefined,
				(failure: unknown) => {
					setSending(null);
					if (hasReason(failure, "no_question")) {
						setGone(explain(failure));
						// The server says it is gone: take the session as it is now.
						api.resync();
					} else setError(explain(failure));
				},
			);
		},
		[api, question, sending, note, explain],
	);

	return useMemo(() => ({ question, sending, error, gone, note, setNote, answer, inlineInView, setInlineInView }), [question, sending, error, gone, note, answer, inlineInView]);
}

// ---------------------------------------------------------------------------------------------
// What the conversation's blocks can reach without threading props through every turn
// ---------------------------------------------------------------------------------------------

export interface Interactive {
	flow: QuestionFlow;
	/** Stops one running call. Null when nothing can be sent (the connection is down). */
	stopCall: ((block: ToolBlock) => Promise<{ stopped: boolean; message: string | null }>) | null;
}

const InteractiveContext = createContext<Interactive | null>(null);

export function InteractiveProvider({ value, children }: { value: Interactive; children: ReactNode }) {
	return <InteractiveContext.Provider value={value}>{children}</InteractiveContext.Provider>;
}

export function useInteractive(): Interactive | null {
	return useContext(InteractiveContext);
}

export const questionAnchor = (question: PendingQuestion) => `question-${question.id}`;

/** Who asks, for a screen reader: a subagent, the agent, or (about a project's server) the platform, before the agent has it. */
const asker = (question: PendingQuestion) => (question.server ? "The platform asks: " : question.subagent ? "A subagent asks: " : "The agent asks: ");

/** What a server is left as when nobody says to start it: one that is reached at an address is not started in the first place. */
const leftAs = (question: PendingQuestion) => (question.server?.remote ? "unconnected" : "stopped");

// ---------------------------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------------------------

function Countdown({ question }: { question: PendingQuestion }) {
	const now = useNow(1000);
	const expiresAt = question.expiresAt;
	const left = expiresAt - now;
	const soon = left < 60_000;
	// A call nobody allows is declined. A server nobody starts only stays as it is, and the turn goes on without it.
	const server = question.server;
	const title = server ? `If nobody answers by ${absoluteTime(expiresAt)}, the server stays ${leftAs(question)}${server.holdsTurn ? " and the turn goes on without it" : ""}.` : `If nobody answers by ${absoluteTime(expiresAt)}, the platform declines for you.`;
	return (
		<p className={`q-countdown${soon ? " q-countdown-soon" : ""}`} title={title}>
			{left <= 0 ? (
				server ? (
					`Leaving it ${leftAs(question)} now…`
				) : (
					"Declining for you now…"
				)
			) : (
				<>
					{server ? `stays ${leftAs(question)} in` : "declines in"} <time dateTime={new Date(expiresAt).toISOString()}>{countdown(left)}</time>
				</>
			)}
		</p>
	);
}

function ChoiceButton({ choice, flow, describedBy }: { choice: QuestionChoice; flow: QuestionFlow; describedBy?: string }) {
	const busy = flow.sending !== null;
	const mine = flow.sending === choice.id;
	return (
		<button type="button" className={`q-choice ${choice.approve ? "q-choice-approve" : "q-choice-decline"}${mine ? " q-choice-sending" : ""}`} disabled={busy} aria-describedby={describedBy} title={choice.remembers ? `Remembers ${choice.remembers}` : undefined} onClick={() => flow.answer(choice)}>
			<span className="q-choice-label">{mine ? "Sending…" : choice.label}</span>
			{choice.remembers ? <span className="visually-hidden">, remembers {choice.remembers}</span> : null}
		</button>
	);
}

/** The note that goes with declining. In the dock it opens on request; in the conversation it is always there. */
function DeclineNote({ flow, id, compact }: { flow: QuestionFlow; id: string; compact: boolean }) {
	return (
		<label className="q-note" htmlFor={id}>
			<span className="visually-hidden">Note for the agent, sent if you decline (optional)</span>
			<input
				id={id}
				className="input q-note-input"
				value={flow.note}
				maxLength={NOTE_LIMIT}
				placeholder={compact ? "Why, or what instead (optional)" : "Tell the agent why, or what to do instead (optional)"}
				onChange={(event) => flow.setNote(event.target.value)}
				disabled={flow.sending !== null}
				autoComplete="off"
				enterKeyHint="send"
				onKeyDown={(event) => {
					// Enter in the note declines with it: the note only goes with declining.
					if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
					event.preventDefault();
					const decline = flow.question?.choices.find((choice) => !choice.approve);
					if (decline) flow.answer(decline);
				}}
			/>
		</label>
	);
}

/**
 * The question itself. `compact` is the dock's form: the title and subject on one line, the details
 * left to the full form, the note behind a link.
 */
export function QuestionCard({
	question,
	flow,
	compact = false,
	underItsCall = false,
	children,
}: {
	question: PendingQuestion;
	flow: QuestionFlow;
	compact?: boolean;
	/** Shown right under the row of the call it is about, which already spells the subject out in full. */
	underItsCall?: boolean;
	children?: ReactNode;
}) {
	const ids = { title: useId(), subject: useId(), note: useId(), details: useId() };
	const [noteOpen, setNoteOpen] = useState(false);
	const approving = question.choices.filter((choice) => choice.approve);
	const declining = question.choices.filter((choice) => !choice.approve);
	const showNote = noteOpen || flow.note !== "";
	const server = question.server;
	const publishing = question.publish;

	return (
		<div className={`q ${compact ? "q-compact" : "q-full"}${server || publishing ? " q-server" : ""}`} aria-labelledby={ids.title} role="group">
			<div className="q-head">
				<p className="q-title" id={ids.title}>
					<span className="visually-hidden">{asker(question)}</span>
					{question.title || "May this call run?"}
				</p>
				<Countdown question={question} />
			</div>
			{question.subagent ? (
				<p className="q-subagent">
					<span className="q-subagent-key">asked by a subagent working on</span> {question.subagent}
				</p>
			) : null}
			{publishing && !compact ? (
				<dl className="q-publish" aria-label="What would be published">
					<dt>repository</dt>
					<dd>{publishing.repository}</dd>
					<dt>branch</dt>
					<dd>
						{publishing.branch}
						<span aria-hidden="true"> → </span>
						<span className="visually-hidden"> into </span>
						{publishing.base}
					</dd>
					<dt>commit</dt>
					<dd tabIndex={0}>{publishing.commit}</dd>
					<dt>{publishing.pullRequest === null ? "pull request" : `pull request #${publishing.pullRequest}`}</dt>
					<dd>{publishing.title}</dd>
					<dt>description</dt>
					<dd tabIndex={0} className={publishing.description === "" ? "q-publish-none" : undefined}>
						{publishing.description === "" ? "none" : publishing.description}
					</dd>
				</dl>
			) : question.subject && !underItsCall ? (
				<pre className="q-subject" id={ids.subject} tabIndex={compact ? undefined : 0} aria-label={server ? (server.remote ? "The address it is reached at" : "The command that starts it") : "What it is about"}>
					{question.subject}
				</pre>
			) : null}
			{server?.file && !compact ? (
				<p className="q-where">
					<span className="q-where-key">defined in</span> {server.file}
				</p>
			) : null}
			{!compact && question.details.length > 0 ? (
				<div className="q-details" id={ids.details}>
					{question.details.map((detail) => (
						<p key={detail}>{detail}</p>
					))}
				</div>
			) : null}
			<div className="q-choices">
				<div className="q-approve">
					{approving.map((choice) => (
						<ChoiceButton key={choice.id} choice={choice} flow={flow} describedBy={compact ? undefined : ids.details} />
					))}
				</div>
				<div className="q-decline">
					{declining.map((choice) => (
						<ChoiceButton key={choice.id} choice={choice} flow={flow} />
					))}
					{server ? null : showNote ? (
						<DeclineNote flow={flow} id={ids.note} compact={compact} />
					) : (
						<button type="button" className="link q-note-open" onClick={() => setNoteOpen(true)} disabled={flow.sending !== null}>
							add a note
						</button>
					)}
				</div>
			</div>
			{flow.error ? (
				<p className="q-error" role={compact ? "alert" : undefined}>
					<WarnIcon size={14} />
					<span>{flow.error}</span>
				</p>
			) : null}
			{children}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The question where it stands in the conversation
// ---------------------------------------------------------------------------------------------

/**
 * The question at its place in the conversation. It tells the flow whether it is on screen, from the
 * element it actually renders, so the dock knows when to step aside.
 */
export function InlineQuestion({ question, flow, underItsCall = false, className = "" }: { question: PendingQuestion; flow: QuestionFlow; underItsCall?: boolean; className?: string }) {
	const element = useRef<HTMLDivElement>(null);
	const { setInlineInView } = flow;

	useEffect(() => {
		const node = element.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		let focused = false;
		const observer = new IntersectionObserver(
			([entry]) => {
				const inView = entry !== undefined && entry.intersectionRatio >= 0.75;
				setInlineInView(inView);
				// With the dock aside, the question here takes the focus the dock would have taken.
				if (inView && !focused && !isTextField(document.activeElement)) {
					focused = true;
					node.querySelector<HTMLElement>(".q-choice")?.focus({ preventScroll: true });
				}
			},
			{ threshold: [0, 0.75, 1] },
		);
		observer.observe(node);
		return () => {
			observer.disconnect();
			setInlineInView(false);
		};
	}, [question.id, setInlineInView]);

	return (
		<div className={`q-inline${className ? ` ${className}` : ""}`} id={questionAnchor(question)} ref={element}>
			<QuestionCard question={question} flow={flow} underItsCall={underItsCall} />
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The dock above the composer
// ---------------------------------------------------------------------------------------------


export function QuestionDock({ flow }: { flow: QuestionFlow }) {
	const dock = useRef<HTMLElement>(null);
	const question = flow.question;
	const id = question?.id ?? null;

	// The same question stands at its call in the conversation. While that one is on screen the dock
	// would only repeat it, so it steps aside and comes back when the user scrolls away.
	const inlineInView = flow.inlineInView;

	// A new question takes the focus, unless the user is typing somewhere.
	useEffect(() => {
		if (id === null) return;
		if (isTextField(document.activeElement)) return;
		dock.current?.focus({ preventScroll: true });
	}, [id]);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		// Escape answers nothing; it only leaves a note field.
		if (event.key === "Escape" && event.target instanceof HTMLInputElement) {
			event.preventDefault();
			dock.current?.focus({ preventScroll: true });
		}
	};

	if (!question) {
		return flow.gone ? (
			<div className="q-dock-wrap">
				<p className="q-gone" role="status">
					<InfoIcon size={14} />
					<span>{flow.gone}</span>
				</p>
			</div>
		) : null;
	}

	if (inlineInView) {
		return (
			<p className="visually-hidden" role="status">
				{asker(question)}
				{question.title}
			</p>
		);
	}

	return (
		<div className="q-dock-wrap">
			<section className="q-dock" ref={dock} tabIndex={-1} aria-label={question.server && !question.server.holdsTurn ? "A question is waiting for your answer" : "The agent is waiting for your answer"} onKeyDown={onKeyDown}>
				<p className="visually-hidden" role="status">
					{asker(question)}
					{question.title}
				</p>
				<QuestionCard question={question} flow={flow} compact>
					<button
						type="button"
						className="link q-show"
						onClick={() => {
							const target = document.getElementById(questionAnchor(question));
							target?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
							target?.querySelector<HTMLElement>(".q-choice")?.focus({ preventScroll: true });
						}}
					>
						show in the conversation
					</button>
				</QuestionCard>
			</section>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// After it was settled
// ---------------------------------------------------------------------------------------------

/** What became of a call's question, as history: who answered, and what it remembers. */
export function AnswerLine({ block }: { block: ToolBlock }) {
	const answer = block.answer;
	if (!answer) return null;
	let words: ReactNode;
	let tone: "allowed" | "declined" | "platform";
	if (answer.by === "platform") {
		tone = "platform";
		words = <>{answer.platformText ?? "Nobody answered in time, so the platform declined."}</>;
	} else if (answer.approve) {
		tone = "allowed";
		words = answer.remembers ? `You allowed ${answer.remembers}` : answer.choice === "once" ? "You allowed this once" : "You allowed this";
	} else {
		tone = "declined";
		words = answer.note ? (
			<>
				You declined: <q className="q-history-note">{answer.note}</q>
			</>
		) : (
			"You declined"
		);
	}
	return (
		<p className={`q-history q-history-${tone}`}>
			<span className="q-history-glyph" aria-hidden="true">
				{tone === "allowed" ? <CheckIcon size={13} /> : tone === "platform" ? <InfoIcon size={13} /> : <RefusedIcon size={13} />}
			</span>
			<span className="q-history-text">
				{block.question?.title ? <span className="q-history-asked">{block.question.title}</span> : null}
				<span className="q-history-answer">{words}</span>
			</span>
		</p>
	);
}

/** A question the conversation shows read-only: asked, and not (or no longer) pending here. */
export function AskedLine({ block }: { block: ToolBlock }) {
	if (!block.question) return null;
	return (
		<div className="q-asked">
			<p className="q-history">
				<span className="q-history-glyph" aria-hidden="true">
					<AskIcon size={13} />
				</span>
				<span className="q-history-text">
					<span className="q-history-asked">{block.question.title}</span>
					<span className="q-history-answer">waiting for the answer to reach the agent</span>
				</span>
			</p>
		</div>
	);
}
