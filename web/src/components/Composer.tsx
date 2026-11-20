/**
 * The composer: Enter sends, Shift-Enter makes a new line. While a turn runs (or waits on a question)
 * what is sent steers that turn, and Stop sits beside Send. While the sandbox starts or the turn stops
 * it cannot send and says why. The model and effort for the next turn sit beside it; they do not
 * apply to a steer, so they are off while a turn runs. The models are the user's own, the efforts
 * are the chosen model's, and a few words beside them say whose list it is. A prompt that one of the user's limits refused
 * keeps its text and points to the usage page, and a quiet line above the field says beforehand when
 * little of the day's sandbox time is left.
 *
 * A message that was sent and not taken stays in the field, and stays one submission: sending it
 * again unchanged goes with the key it was sent with first, so the server takes it once even when
 * the first attempt did arrive and only its answer was lost. A message whose text changed is a new
 * submission, with a key of its own (lib/submission.ts).
 *
 * An agent of another harness (Claude Code, `harness`) has the models and efforts that harness offered
 * (`SessionSummary.harnessModels`): a picker is drawn only when there is a choice to make, and otherwise
 * one quiet word says the harness's default is used. Where that harness takes no message while a turn
 * runs, the server says so (`steer_unavailable`), and the message is held here and sent as the next
 * prompt once the turn ends.
 *
 * The agent's mode sits before the model (components/Modes.tsx): its list is the session's, and what it
 * shows is the live summary's, so a mode the agent changes itself shows at once. A change made while a
 * turn runs applies from the next prompt, and a few words beside the picker say so until the turn ends.
 *
 * A work item's agent takes no prompt from a person: the item's steps send them, and the server
 * refuses any other (`item_session`). Its page has `ItemNote` in the composer's place: one quiet line
 * that says so and links to the item, with Stop beside it while a turn runs, which the server allows.
 */
import { MAX_PROMPT_CHARS, type ModelList, type PromptInput, type SessionMode, type SessionStatus } from "@contract";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, hasReason } from "../api/client";
import { isLimitRefusal } from "../api/errors";
import { count } from "../lib/format";
import { effortsOf, modelIds, modelsNote, modelsNoteShort } from "../lib/models";
import { linkProps } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { ChevronIcon, SendIcon, SteerIcon, StopIcon, WarnIcon } from "./Icons";
import { ModePicker } from "./Modes";

export interface ComposerProps {
	status: SessionStatus;
	/** False while the connection is down: nothing can be sent. */
	online: boolean;
	/** The models the user may choose and the efforts of each; null until they are known. */
	models: ModelList | null;
	/** The model the session is on. */
	model: string;
	/** Rejects with what the client threw: a `turn_running` or `steer_unavailable` refusal is shown briefly and the text kept. */
	onSend(input: PromptInput): Promise<void>;
	onStop(): Promise<void>;
	/**
	 * Text to start with, and why it is there (a prompt that could not be sent earlier); `limit` when one
	 * of the user's limits refused it, and the key it was sent with, which it keeps while it is unchanged.
	 */
	initial?: { text: string; error?: string; limit?: boolean; idempotencyKey?: string } | null;
	/** What there is to say about the user's limits before anything is sent: little sandbox time left, none, or no room for a sandbox. */
	limitNote?: string | null;
	/** Text put in from outside (a suggested prompt); `key` changes to apply it again. */
	suggestion?: { key: number; text: string } | null;
	/** Set when nothing can be sent to this agent again, with why (its machine was removed). */
	closed?: string | null;
	/** The name of the harness the agent runs when it is not Windlass ("Claude Code"): its pickers are drawn only where it offers a choice. */
	harness?: string | null;
	/** The modes the agent can be put in; no picker without them. */
	modes?: SessionMode[];
	/** The mode its next prompt runs in, as the live summary says. */
	mode?: string | null;
	/** Puts the agent in a mode from its next prompt; rejects with what the client threw. */
	onMode?(mode: string): Promise<void>;
}

/** Why nothing can be sent right now. */
const REASON: Partial<Record<SessionStatus, string>> = {
	starting: "The sandbox is starting. You can steer the agent once it is working, or stop it.",
	stopping: "Stopping the turn…",
};

/** How long a refusal to take a steer stays. */
const TRANSIENT_MS = 6000;

/** The server's refusal of a message to a running turn that cannot take it now (`steer_unavailable`): another harness's message is sent when the turn ends. */
export const steerUnavailable = (failure: unknown): boolean => hasReason(failure, "steer_unavailable");

/** The way to the usage page, after a sentence about a limit. */
function UsageLink() {
	return (
		<a className="link" {...linkProps({ name: "usage" })}>
			Usage
		</a>
	);
}

/** In the composer's place on a work item's agent: what sends its prompts, the way to the item, and Stop while a turn runs. On the item's second reviewer, that it is that. */
export function ItemNote({ item, status, online, onStop }: { item: { id: string; role?: "builder" | "reviewer" }; status: SessionStatus; online: boolean; onStop(): Promise<void> }) {
	const [error, setError] = useState<string | null>(null);
	const [stopping, setStopping] = useState(false);
	const idle = status === "idle";
	useEffect(() => {
		if (idle) setStopping(false);
	}, [idle]);
	const stop = async () => {
		setStopping(true);
		setError(null);
		try {
			await onStop();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "The turn could not be stopped.");
			setStopping(false);
		}
	};
	return (
		<div className="composer composer-item">
			{error ? (
				<p className="composer-error" role="alert">
					<WarnIcon size={14} />
					<span>{error}</span>
				</p>
			) : null}
			<div className="item-note">
				{item.role === "reviewer" ? (
					<p className="item-note-text">
						This agent is the second reviewer of a{" "}
						<a className="link" {...linkProps({ name: "item", id: item.id })}>
							work item
						</a>
						: it reads the commit the item pushed and files one review. The item sends its prompts.
					</p>
				) : (
					<p className="item-note-text">
						This agent works for a{" "}
						<a className="link" {...linkProps({ name: "item", id: item.id })}>
							work item
						</a>
						, whose steps send its prompts.
					</p>
				)}
				{!idle ? (
					<button type="button" className="button button-stop button-small" onClick={stop} disabled={status === "stopping" || stopping || !online} title="The item tries this step again. To end its work, cancel the item.">
						<StopIcon size={13} />
						<span>{status === "stopping" || stopping ? "Stopping" : "Stop the turn"}</span>
					</button>
				) : null}
			</div>
		</div>
	);
}

export function Composer({ status, online, models, model, onSend, onStop, initial, suggestion, limitNote, closed, harness = null, modes = [], mode = null, onMode }: ComposerProps) {
	const [text, setText] = useState(initial?.text ?? "");
	const [error, setError] = useState<string | null>(initial?.error ?? null);
	/** Whether `error` is a refusal by one of the user's limits. */
	const [limited, setLimited] = useState(initial?.limit === true);
	/** A refusal that clears itself: the turn could not take the message just now. */
	const [notice, setNotice] = useState<string | null>(null);
	const [chosenModel, setChosenModel] = useState<string | null>(null);
	const [effort, setEffort] = useState("");
	const [sending, setSending] = useState(false);
	const [stopping, setStopping] = useState(false);
	/** The mode chosen here, until the summary says it is the session's (or the choice was refused). */
	const [pendingMode, setPendingMode] = useState<string | null>(null);
	/** Whether a mode was chosen while the running turn keeps its own: said beside the picker until the turn ends. */
	const [modeLater, setModeLater] = useState(false);
	/** The message that was sent and not taken, with its key: the same text again is another attempt of it. */
	const untaken = useRef<Submission | null>(initial?.idempotencyKey ? { content: initial.text, idempotencyKey: initial.idempotencyKey } : null);
	/** A message the running turn's harness could not take: sent, with its key, once the turn ends. */
	const [held, setHeld] = useState<Submission | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const ids = { text: useId(), model: useId(), effort: useId(), reason: useId() };

	const idle = status === "idle";
	/** A turn is under way and takes messages: what is sent steers it. */
	const steering = status === "running" || status === "waiting";
	const writable = (idle || steering) && !closed;
	const busy = !writable || sending;
	const currentModel = chosenModel ?? model;
	const offered = modelIds(models);
	const efforts = effortsOf(models, currentModel);
	// An effort the chosen model does not take is not sent: the picker is back at the default.
	const currentEffort = efforts.includes(effort) ? effort : "";
	// Another harness's pickers are drawn only where it offers a choice.
	const modelPicker = harness === null || offered.length > 1;
	const effortPicker = harness === null || efforts.length > 0;
	const tooLong = text.length > MAX_PROMPT_CHARS;
	const canSend = writable && online && !sending && text.trim() !== "" && !tooLong;
	const reason = closed || (!online ? "The connection is down. Reconnecting…" : (REASON[status] ?? (sending ? "Sending…" : null)));

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), TRANSIENT_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	// Grow with the text, up to a limit; then it scrolls.
	useLayoutEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
	}, [text]);

	useEffect(() => {
		if (!suggestion) return;
		setText(suggestion.text);
		area.current?.focus();
	}, [suggestion]);

	// Back to the field when a turn ends, if the user has not gone elsewhere.
	const wasIdle = useRef(idle);
	useEffect(() => {
		if (idle && !wasIdle.current && (document.activeElement === document.body || document.activeElement?.closest(".composer"))) area.current?.focus();
		wasIdle.current = idle;
		if (idle) setStopping(false);
		if (idle) setModeLater(false);
	}, [idle]);

	// The summary's mode is the session's: a choice made here is shown until it arrives there.
	useEffect(() => setPendingMode(null), [mode]);

	const shownMode = pendingMode ?? mode;
	const chooseMode = (next: string) => {
		if (!onMode || next === shownMode) return;
		setPendingMode(next);
		setError(null);
		if (!idle) setModeLater(true);
		onMode(next).catch((failure: unknown) => {
			setPendingMode(null);
			setModeLater(false);
			setError(failure instanceof Error ? errorMessage(failure) : "The mode could not be changed.");
		});
	};

	// The held message goes as the next prompt once the turn has ended; refused then, it is back in the field.
	useEffect(() => {
		if (!idle || !online || held === null || closed) return;
		const message = held;
		setHeld(null);
		setSending(true);
		onSend({ text: message.content, idempotencyKey: message.idempotencyKey }).then(
			() => setSending(false),
			(failure: unknown) => {
				untaken.current = message;
				setText((current) => (current.trim() === "" ? message.content : current));
				setError(failure instanceof Error ? errorMessage(failure) : "The message could not be sent.");
				setLimited(isLimitRefusal(failure));
				setSending(false);
			},
		);
	}, [idle, online, held, closed, onSend]);

	const send = async () => {
		if (!canSend) return;
		setSending(true);
		setError(null);
		setNotice(null);
		const { content, idempotencyKey } = submissionOf(text.trim(), untaken.current);
		untaken.current = { content, idempotencyKey };
		try {
			// The model and effort do not apply to a steer.
			await onSend(steering ? { text: content, idempotencyKey } : { text: content, idempotencyKey, model: chosenModel !== null && chosenModel !== model ? chosenModel : undefined, effort: currentEffort || undefined });
			untaken.current = null;
			setText("");
		} catch (failure) {
			// Another harness's message waits for the turn's end; Windlass's turn is asked again by its user.
			if (steering && harness !== null && steerUnavailable(failure) && held === null) {
				setHeld({ content, idempotencyKey });
				untaken.current = null;
				setText("");
			} else if (hasReason(failure, "turn_running") || steerUnavailable(failure)) setNotice(errorMessage(failure));
			else {
				setError(failure instanceof Error ? errorMessage(failure) : "The message could not be sent.");
				setLimited(isLimitRefusal(failure));
			}
		} finally {
			setSending(false);
		}
	};

	const stop = async () => {
		setStopping(true);
		setError(null);
		try {
			await onStop();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "The turn could not be stopped.");
			setStopping(false);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void send();
	};

	return (
		<form
			className={`composer${busy ? " composer-busy" : ""}`}
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			{error ? (
				<p className="composer-error" role="alert">
					<WarnIcon size={14} />
					<span>
						{error}
						{limited ? (
							<>
								{" "}
								{text.trim() === "" ? null : "Your message is still here. "}
								<UsageLink />
							</>
						) : null}
					</span>
				</p>
			) : notice ? (
				<p className="composer-error composer-notice" role="status">
					<WarnIcon size={14} />
					<span>{notice} Your message is still here.</span>
				</p>
			) : held ? (
				<p className="composer-error composer-held" role="status">
					<SteerIcon size={14} />
					<span>
						<span className="composer-held-text">{held.content}</span> Sent when this turn ends.{" "}
						<button
							type="button"
							className="link"
							onClick={() => {
								setText((current) => (current.trim() === "" ? held.content : `${held.content}\n${current}`));
								untaken.current = held;
								setHeld(null);
								area.current?.focus();
							}}
						>
							Take it back
						</button>
					</span>
				</p>
			) : limitNote ? (
				<p className="composer-error composer-allowance" role="status">
					<WarnIcon size={14} />
					<span>
						{limitNote} <UsageLink />
					</span>
				</p>
			) : null}
			<div className="composer-box">
				<label className="composer-caret" htmlFor={ids.text}>
					{steering ? <SteerIcon size={15} /> : <ChevronIcon size={16} />}
					<span className="visually-hidden">{steering ? "Message to the running turn" : "Prompt"}</span>
				</label>
				<textarea
					ref={area}
					id={ids.text}
					className="composer-text"
					rows={1}
					value={text}
					placeholder={closed ? "Nothing can be sent to this agent" : idle ? "Tell the agent what to do" : steering ? "Steer it: add to or change what it is doing" : status === "stopping" ? "Stopping…" : "Starting…"}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={!writable || sending}
					aria-describedby={ids.reason}
					enterKeyHint="send"
				/>
				{idle || steering ? (
					<button type="submit" className={`button composer-action ${idle ? "button-primary" : "button-outline composer-steer"}`} disabled={!canSend} aria-label={steering ? "Steer: send to the running turn" : undefined}>
						{steering ? <SteerIcon size={15} /> : <SendIcon size={15} />}
						<span>{sending ? "Sending" : steering ? "Steer" : "Send"}</span>
					</button>
				) : null}
				{!idle ? (
					<button type="button" className="button button-stop composer-action" onClick={stop} disabled={status === "stopping" || stopping || !online}>
						<StopIcon size={15} />
						<span>{status === "stopping" || stopping ? "Stopping" : "Stop"}</span>
					</button>
				) : null}
			</div>
			<div className="composer-foot">
				<div className="composer-selects">
					{modes.length > 0 && shownMode !== null ? (
						<>
							<ModePicker modes={modes} current={shownMode} onChoose={chooseMode} disabled={!online || !!closed || !onMode} title={idle ? undefined : "For the next prompt; the running turn keeps its mode"} />
							{modeLater && !idle ? (
								<span className="mini-note" role="status">
									applies from the next prompt
								</span>
							) : null}
						</>
					) : null}
					{modelPicker ? (
						<label className="mini-select" htmlFor={ids.model}>
							<span>model</span>
							<select id={ids.model} value={currentModel} onChange={(event) => setChosenModel(event.target.value)} disabled={!idle} title={idle ? undefined : "For the next turn; a message to the running turn uses its model"}>
								{(offered.includes(currentModel) ? offered : [currentModel, ...offered]).map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						</label>
					) : null}
					{effortPicker ? (
						<label className="mini-select" htmlFor={ids.effort}>
							<span>effort</span>
							<select id={ids.effort} value={currentEffort} onChange={(event) => setEffort(event.target.value)} disabled={!idle} title={idle ? undefined : "For the next turn; a message to the running turn uses its effort"}>
								<option value="">default</option>
								{efforts.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						</label>
					) : null}
					{!modelPicker ? (
						<span className="mini-note" title={`The model is the one ${harness} starts on; it offered no other.`}>
							{harness}'s default model
						</span>
					) : models ? (
						<span className="mini-note" title={modelsNote(models)}>
							{harness === null ? modelsNoteShort(models) : `${harness}'s models`}
						</span>
					) : null}
				</div>
				<p className={`composer-hint${reason ? " composer-reason" : steering ? " composer-steer-hint" : ""}${tooLong ? " tone-bad" : ""}`} id={ids.reason} role={reason ? "status" : undefined}>
					{tooLong ? (
						`${count(text.length - MAX_PROMPT_CHARS)} characters over the limit of ${count(MAX_PROMPT_CHARS)}`
					) : (
						(reason ??
						(steering ? (
							<>
								<kbd>Enter</kbd> steer <span aria-hidden="true">·</span> the agent reads it after its current step
							</>
						) : (
							<>
								<kbd>Enter</kbd> send <span aria-hidden="true">·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
							</>
						)))
					)}
				</p>
			</div>
		</form>
	);
}
