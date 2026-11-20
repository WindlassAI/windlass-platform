/**
 * The agent's mode, in the two places it is chosen (lib/modes.ts says whose modes they are).
 *
 * - `ModeChoice`, on the launch form, under the agent: a segmented choice when there are only a few
 *   modes, as the agent's own choice is, and the form's select when there are more; the chosen mode's
 *   description under it, quietly.
 * - `ModePicker`, in the composer beside the model: one word that opens the list, each mode with its
 *   description, so the choice can be made without knowing the names.
 */
import type { SessionMode } from "@contract";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

/** Up to this many modes are a segmented choice; more are a select. */
const SEGMENTED_MAX = 3;

export function ModeChoice({ modes, chosen, disabled = false, onChoose }: { modes: SessionMode[]; chosen: string; disabled?: boolean; onChoose(mode: string): void }) {
	const ids = { label: useId(), group: useId(), select: useId(), note: useId() };
	const current = modes.find((mode) => mode.id === chosen) ?? null;
	return (
		<div className="harness-pick mode-pick">
			{modes.length <= SEGMENTED_MAX ? (
				<>
					<span className="label" id={ids.label}>
						Mode
					</span>
					<div className="segmented" role="radiogroup" aria-labelledby={ids.label} aria-describedby={ids.note}>
						{modes.map((mode) => (
							<label key={mode.id} className={`segment${chosen === mode.id ? " segment-chosen" : ""}`}>
								<input className="segment-radio" type="radio" name={ids.group} value={mode.id} checked={chosen === mode.id} disabled={disabled} onChange={() => onChoose(mode.id)} />
								{mode.name}
							</label>
						))}
					</div>
				</>
			) : (
				<>
					<label className="label" htmlFor={ids.select}>
						Mode
					</label>
					<select id={ids.select} className="select mode-select" value={chosen} disabled={disabled} onChange={(event) => onChoose(event.target.value)} aria-describedby={ids.note}>
						{modes.map((mode) => (
							<option key={mode.id} value={mode.id}>
								{mode.name}
							</option>
						))}
					</select>
				</>
			)}
			<p className="field-note" id={ids.note}>
				{current?.description ?? " "}
			</p>
		</div>
	);
}

/**
 * "mode Auto", in the composer's quiet picker style; pressed, the modes open above it as a list, each
 * with its description. `current` is the mode shown as chosen; `title` says what a choice applies to.
 */
export function ModePicker({ modes, current, disabled = false, title, onChoose }: { modes: SessionMode[]; current: string; disabled?: boolean; title?: string; onChoose(mode: string): void }) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const box = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const ids = { label: useId(), button: useId(), list: useId(), option: useId() };
	const chosen = modes.find((mode) => mode.id === current) ?? null;
	const chosenIndex = Math.max(0, modes.findIndex((mode) => mode.id === current));

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		list.current?.focus();
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [open]);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const show = (at: number) => {
		setActive(at);
		setOpen(true);
	};
	const close = () => {
		setOpen(false);
		button.current?.focus();
	};
	const choose = (mode: SessionMode) => {
		close();
		if (mode.id !== current) onChoose(mode.id);
	};

	const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		show(chosenIndex);
	};
	const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
		const last = modes.length - 1;
		const moves: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last };
		if (event.key in moves) {
			event.preventDefault();
			setActive(moves[event.key] as number);
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			const mode = modes[active];
			if (mode) choose(mode);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === "Tab") setOpen(false);
	};

	return (
		<div className="mini-select mode-picker" ref={box}>
			<span id={ids.label}>mode</span>
			<button
				ref={button}
				id={ids.button}
				type="button"
				className="mini-pick"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? ids.list : undefined}
				aria-labelledby={`${ids.label} ${ids.button}`}
				disabled={disabled}
				title={title}
				onClick={() => (open ? setOpen(false) : show(chosenIndex))}
				onKeyDown={onButtonKey}
			>
				{chosen?.name ?? current}
			</button>
			{open ? (
				<ul ref={list} id={ids.list} className="mode-menu" role="listbox" aria-labelledby={ids.label} tabIndex={-1} aria-activedescendant={`${ids.option}-${active}`} onKeyDown={onListKey}>
					{modes.map((mode, index) => (
						<li
							key={mode.id}
							id={`${ids.option}-${index}`}
							className={`mode-option${index === active ? " mode-option-active" : ""}`}
							role="option"
							aria-selected={mode.id === current}
							onPointerEnter={() => setActive(index)}
							onClick={() => choose(mode)}
						>
							<span className="mode-option-name">{mode.name}</span>
							{mode.description ? <span className="mode-option-text">{mode.description}</span> : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
