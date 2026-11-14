/**
 * The composer: Enter sends, Shift-Enter makes a new line. While a turn runs (or waits on a question)
 * what is sent steers that turn, and Stop sits beside Send. While the sandbox starts or the turn stops
 * it cannot send and says why. The model and effort for the next turn sit beside it; they do not
 * apply to a steer, so they are off while a turn runs.
 */
import { MAX_PROMPT_CHARS, type SessionStatus } from "@contract";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, hasReason } from "../api/client";
import { count } from "../lib/format";
import { ChevronIcon, SendIcon, SteerIcon, StopIcon, WarnIcon } from "./Icons";

export interface ComposerProps {
	status: SessionStatus;
	/** False while the connection is down: nothing can be sent. */
	online: boolean;
	models: string[];
	efforts: string[];
	model: string;
	/** Rejects with what the client threw: a `turn_running` refusal is shown briefly and the text kept. */
	onSend(input: { text: string; model?: string; effort?: string }): Promise<void>;
	onStop(): Promise<void>;
	/** Text to start with, and why it is there (a prompt that could not be sent earlier). */
	initial?: { text: string; error: string } | null;
	/** Text put in from outside (a suggested prompt); `key` changes to apply it again. */
	suggestion?: { key: number; text: string } | null;
}

/** Why nothing can be sent right now. */
const REASON: Partial<Record<SessionStatus, string>> = {
	starting: "The sandbox is starting. You can steer the agent once it is working, or stop it.",
	stopping: "Stopping the turn…",
};

/** How long a refusal to take a steer stays. */
const TRANSIENT_MS = 6000;

export function Composer({ status, online, models, efforts, model, onSend, onStop, initial, suggestion }: ComposerProps) {
	const [text, setText] = useState(initial?.text ?? "");
	const [error, setError] = useState<string | null>(initial?.error ?? null);
	/** A refusal that clears itself: the turn could not take the message just now. */
	const [notice, setNotice] = useState<string | null>(null);
	const [chosenModel, setChosenModel] = useState<string | null>(null);
	const [effort, setEffort] = useState("");
	const [sending, setSending] = useState(false);
	const [stopping, setStopping] = useState(false);
	const area = useRef<HTMLTextAreaElement>(null);
	const ids = { text: useId(), model: useId(), effort: useId(), reason: useId() };

	const idle = status === "idle";
	/** A turn is under way and takes messages: what is sent steers it. */
	const steering = status === "running" || status === "waiting";
	const writable = idle || steering;
	const busy = !writable || sending;
	const currentModel = chosenModel ?? model;
	const tooLong = text.length > MAX_PROMPT_CHARS;
	const canSend = writable && online && !sending && text.trim() !== "" && !tooLong;
	const reason = !online ? "The connection is down. Reconnecting…" : (REASON[status] ?? (sending ? "Sending…" : null));

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
	}, [idle]);

	const send = async () => {
		if (!canSend) return;
		setSending(true);
		setError(null);
		setNotice(null);
		try {
			// The model and effort do not apply to a steer.
			await onSend(steering ? { text: text.trim() } : { text: text.trim(), model: chosenModel !== null && chosenModel !== model ? chosenModel : undefined, effort: effort || undefined });
			setText("");
		} catch (failure) {
			if (hasReason(failure, "turn_running")) setNotice(errorMessage(failure));
			else setError(failure instanceof Error ? errorMessage(failure) : "The message could not be sent.");
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
					<span>{error}</span>
				</p>
			) : notice ? (
				<p className="composer-error composer-notice" role="status">
					<WarnIcon size={14} />
					<span>{notice} Your message is still here.</span>
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
					placeholder={idle ? "Tell the agent what to do" : steering ? "Steer it: add to or change what it is doing" : status === "stopping" ? "Stopping…" : "Starting…"}
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
					<label className="mini-select" htmlFor={ids.model}>
						<span>model</span>
						<select id={ids.model} value={currentModel} onChange={(event) => setChosenModel(event.target.value)} disabled={!idle} title={idle ? undefined : "For the next turn; a message to the running turn uses its model"}>
							{(models.includes(currentModel) ? models : [currentModel, ...models]).map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
					</label>
					<label className="mini-select" htmlFor={ids.effort}>
						<span>effort</span>
						<select id={ids.effort} value={effort} onChange={(event) => setEffort(event.target.value)} disabled={!idle} title={idle ? undefined : "For the next turn; a message to the running turn uses its effort"}>
							<option value="">default</option>
							{efforts.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
					</label>
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
