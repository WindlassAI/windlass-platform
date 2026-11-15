/**
 * The one copy control of the conversation: a small icon button that puts some text on the
 * clipboard, shows a check for a moment when it did and says so when it could not, and tells a
 * screen reader either way. Where it sits and when it shows are up to the block it belongs to
 * (session.css, "copy controls"); how it looks and behaves is the same everywhere.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/copy";
import { CheckIcon, CopyIcon } from "./Icons";

export type CopyState = "idle" | "copied" | "failed";

/** How long the check stays after copying, and the words after a refusal (longer: they have to be read). */
export const COPIED_MS = 1500;
export const FAILED_MS = 4000;

const ANNOUNCED: Record<CopyState, string> = { idle: "", copied: "Copied", failed: "Could not copy: the browser refused the clipboard" };

/**
 * `text` is the text itself, or a function that reads it when the button is pressed: for text that
 * is still growing, a stable function keeps the button from re-rendering with every chunk.
 */
export const CopyButton = memo(function CopyButton({ text, label, className }: { text: string | (() => string); label: string; className?: string }) {
	// `attempt` restarts the timer when the button is pressed again before the check has gone.
	const [status, setStatus] = useState<{ state: CopyState; attempt: number }>({ state: "idle", attempt: 0 });
	const button = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (status.state === "idle") return;
		const timer = setTimeout(() => setStatus((current) => ({ ...current, state: "idle" })), status.state === "copied" ? COPIED_MS : FAILED_MS);
		return () => clearTimeout(timer);
	}, [status]);

	const onClick = async () => {
		const copied = await copyText(typeof text === "function" ? text() : text, button.current);
		setStatus((current) => ({ state: copied ? "copied" : "failed", attempt: current.attempt + 1 }));
	};

	const { state } = status;
	return (
		<span className={`copy copy-${state}${className ? ` ${className}` : ""}`}>
			<button ref={button} type="button" className="icon-button icon-button-small copy-button" aria-label={label} title={label} onClick={onClick}>
				{state === "copied" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
			</button>
			{state === "failed" ? (
				<span className="copy-note" aria-hidden="true">
					Couldn't copy
				</span>
			) : null}
			<span className="visually-hidden" role="status">
				{ANNOUNCED[state]}
			</span>
		</span>
	);
});

/** A stable function that returns the latest `value`: what a copy control is given for text that changes while it is shown. */
export function useLatest<T>(value: T): () => T {
	const latest = useRef(value);
	latest.current = value;
	return useCallback(() => latest.current, []);
}
