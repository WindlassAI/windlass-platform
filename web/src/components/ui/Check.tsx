/**
 * The app's one checkbox: a box drawn beside its words, the native input kept for keys and assistive
 * technology. Its words are the children: a `check-name` and a `check-means` line under it for a setting,
 * or a plain line (`label`) for a short choice. Styled in base.css (`.check`).
 */
import type { ReactNode, Ref } from "react";

export interface CheckProps {
	checked: boolean;
	onChange(checked: boolean): void;
	disabled?: boolean;
	/** Extra classes on the label. */
	className?: string;
	/** A short choice in one plain line, instead of children. */
	label?: ReactNode;
	inputRef?: Ref<HTMLInputElement>;
	children?: ReactNode;
}

export function Check({ checked, onChange, disabled = false, className, label, inputRef, children }: CheckProps) {
	return (
		<label className={`check${label !== undefined ? " check-plain" : ""}${checked ? " check-on" : ""}${className ? ` ${className}` : ""}`}>
			<input className="check-input" type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} ref={inputRef} />
			<span className="check-box" aria-hidden="true" />
			<span className="check-text">{label !== undefined ? <span className="check-label">{label}</span> : children}</span>
		</label>
	);
}
