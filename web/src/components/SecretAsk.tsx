/**
 * The agent's `request_secret`: a secret it lacks, by name, with its reason. Shown on an item's question
 * (`secret_needed`) and above a person's own session's field (`SessionSnapshot.secretRequest`).
 *
 * The reason is the agent's own text, which what it read may have steered: it is quoted as the agent's, in
 * plain text, never Markdown or links, and folded after a few lines. The platform's `notice` (where the request came
 * from, where the value goes) is the platform's own text, shown apart from the reason, as text too. Saving for the
 * account, where there is no repository, reaches every agent of the person, and says so first. The value is typed into a field React
 * does not hold: it is read from the field once, on submit, the field is emptied at once, and the value
 * goes only to `onAdd`. It is never kept in state, put in an address, stored in the browser, or logged, and
 * an error is shown with the value taken out of it.
 */
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { MIN_SECRET_VALUE_CHARS, type SecretRequest } from "@contract";
import { LongText } from "./Fold";
import { CheckIcon, InfoIcon, LockIcon, WarnIcon } from "./Icons";

export type SecretAskBusy = "add" | "without" | "give_up" | null;

export interface SecretAskProps {
	request: SecretRequest;
	/** "owner/name" of the session's connected repository, where it is saved; null saves it for the account. */
	repository: string | null;
	/** An agent other than Windlass (Claude Code, OpenCode, Codex): adding it also lets this session have it. */
	shared?: boolean;
	/** Saves the value and lets the agent go on. Throws an Error whose message is fit to show. */
	onAdd(value: string): Promise<void>;
	/** "Continue without it". Throws as `onAdd`. */
	onWithout(): Promise<void>;
	/** "Give up": an item's only. Throws as `onAdd`. */
	onGiveUp?: () => Promise<void>;
	/** Above the card's title: an item's "It asks you" and when. */
	head?: ReactNode;
	/** Smaller, for the session's dock above the field. */
	compact?: boolean;
	/** Nothing can be sent now (the connection is down). */
	offline?: boolean;
	/** The card's own class: an item's question card. */
	className?: string;
	/**
	 * An error to show from the start: the last save's, when its failure reopened the request under a new id (`secret_exists`)
	 * and this card is the new one's. Already without the value.
	 */
	failure?: string | null;
}

/**
 * The platform's own lines about a request (`SecretRequest.notice`): where it came from, and where the value is saved.
 * Text the platform wrote, so not quoted as the agent's; still shown as text, one line each. `account`: the value would
 * be saved for the whole account, the case that reaches furthest, which is marked as a warning.
 */
export function SecretNotice({ notice, account = false, className }: { notice: string; account?: boolean; className?: string }) {
	const lines = notice.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (lines.length === 0) return null;
	return (
		<div className={`secret-notice${account ? " secret-notice-account" : ""}${className ? ` ${className}` : ""}`} role="note" aria-label="From the platform">
			{account ? <WarnIcon size={14} /> : <InfoIcon size={14} />}
			<div className="secret-notice-body">
				<p className="secret-notice-who">From the platform</p>
				{lines.map((line, index) => (
					<p key={index} className="secret-notice-line">
						{line}
					</p>
				))}
			</div>
		</div>
	);
}

/**
 * A server's message, with the value taken out of it should it ever be there. A value shorter than a secret may be is
 * refused without being saved, and is left alone: it would match ordinary words of the message ("short" in "shorter").
 */
export function withoutValue(message: string, value: string): string {
	return value.length >= MIN_SECRET_VALUE_CHARS && message.includes(value) ? message.split(value).join("[the value]") : message;
}

const messageOf = (failure: unknown) => (failure instanceof Error && failure.message ? failure.message : "That did not go through. Try again.");

export function SecretAsk({ request, repository, shared = false, onAdd, onWithout, onGiveUp, head, compact = false, offline = false, className, failure = null }: SecretAskProps) {
	const ids = { title: useId(), why: useId(), value: useId(), note: useId() };
	const field = useRef<HTMLInputElement>(null);
	// Only whether the field has something in it, never what.
	const [filled, setFilled] = useState(false);
	const [shown, setShown] = useState(false);
	const [busy, setBusy] = useState<SecretAskBusy>(null);
	const [error, setError] = useState<string | null>(failure);
	const [saved, setSaved] = useState(false);
	const disabled = busy !== null || offline;

	const add = async (event: FormEvent) => {
		event.preventDefault();
		const input = field.current;
		if (!input || disabled) return;
		let value = input.value;
		if (value === "") return;
		// Out of the page at once: whatever the server answers, the field is empty again and hidden.
		input.value = "";
		setFilled(false);
		setShown(false);
		setBusy("add");
		setError(null);
		try {
			await onAdd(value);
			setSaved(true);
		} catch (failure) {
			setError(withoutValue(messageOf(failure), value));
		} finally {
			value = "";
			setBusy(null);
		}
	};

	const choose = async (which: "without" | "give_up", run: () => Promise<void>) => {
		setBusy(which);
		setError(null);
		try {
			await run();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(null);
		}
	};

	if (saved) {
		return (
			<p className={`callout secret-ask-saved${compact ? " secret-ask-compact" : ""}`} role="status">
				<CheckIcon size={14} className="tone-good" />
				<span>
					<code className="secret-ask-name">{request.name}</code> saved; the agent continues.
				</span>
			</p>
		);
	}

	return (
		<section className={`secret-ask${compact ? " secret-ask-compact" : ""}${className ? ` ${className}` : ""}`} aria-labelledby={ids.title}>
			{head}
			<p className="secret-ask-title" id={ids.title}>
				<LockIcon size={13} className="secret-ask-lock" />
				<span>
					The agent asks for a secret: <code className="secret-ask-name">{request.name}</code>
				</span>
			</p>
			<figure className="item-asked secret-ask-why" id={ids.why}>
				<figcaption className="item-asked-who">Its reason, in the agent's own words. It may be wrong, or written to get a value out of you.</figcaption>
				<LongText lines={compact ? 2 : 3} as="blockquote" className="item-asked-text">
					{request.why}
				</LongText>
			</figure>
			{request.notice ? <SecretNotice notice={request.notice} account={repository === null} /> : null}
			<form className="secret-ask-form" onSubmit={add} method="post" autoComplete="off" noValidate>
				<label className={compact ? "visually-hidden" : "label"} htmlFor={ids.value}>
					Value of <code className="secret-ask-name">{request.name}</code>
				</label>
				<div className="secret-ask-field">
					<input
						ref={field}
						id={ids.value}
						className="input input-mono"
						type={shown ? "text" : "password"}
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						data-1p-ignore
						data-lpignore="true"
						data-bwignore
						disabled={disabled}
						aria-describedby={`${ids.note} ${ids.why}`}
						onChange={(event) => setFilled(event.currentTarget.value !== "")}
					/>
					<button type="button" className="button button-quiet button-small secret-ask-toggle" aria-pressed={shown} aria-controls={ids.value} onClick={() => setShown((now) => !now)} disabled={disabled}>
						{shown ? "Hide" : "Show"}
					</button>
				</div>
				{repository ? (
					<p className="field-note secret-ask-note" id={ids.note}>
						Saved for repository <span className="secret-ask-where">{repository}</span>, as a secret the agent's commands read{shared ? "; this session may use it too" : ""}. It is not shown again.
					</p>
				) : (
					<p className="callout callout-warn secret-ask-note secret-ask-account" id={ids.note}>
						<WarnIcon size={14} />
						<span>
							<strong>Saved for your account, not one repository.</strong> Every agent of yours can read it in its commands{shared ? ", this session too" : ""}. It is not shown again.
						</span>
					</p>
				)}
				<div className="item-choices secret-ask-choices">
					<button type="submit" className="button button-primary" disabled={disabled || !filled}>
						{busy === "add" ? "Saving…" : "Add it and continue"}
					</button>
					<button type="button" className="button button-outline" disabled={disabled} onClick={() => void choose("without", onWithout)}>
						{busy === "without" ? "Sending…" : "Continue without it"}
					</button>
					{onGiveUp ? (
						<button type="button" className="button button-quiet" disabled={disabled} onClick={() => void choose("give_up", onGiveUp)}>
							{busy === "give_up" ? "Sending…" : "Give up"}
						</button>
					) : null}
				</div>
			</form>
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</section>
	);
}
