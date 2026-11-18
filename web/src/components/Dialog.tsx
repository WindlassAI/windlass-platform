/**
 * A modal dialog on the native <dialog> element: Escape closes it, focus stays inside it and goes
 * back to where it was, and the page behind is inert.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { CrossIcon } from "./Icons";

interface DialogProps {
	title: string;
	/** A line under the title. */
	lede?: ReactNode;
	onClose(): void;
	size?: "small" | "medium" | "large" | "full";
	children: ReactNode;
	/** Kept at the bottom, outside the scrolling body. */
	footer?: ReactNode;
	/** False while something is in flight that closing would lose. */
	dismissable?: boolean;
}

export function Dialog({ title, lede, onClose, size = "medium", children, footer, dismissable = true }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (!dialog.open) dialog.showModal();
		// Focus starts on the control the dialog marks as where its user begins (`data-autofocus`), or on the
		// dialog itself rather than on its close button: Tab then reaches the first control.
		(dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog).focus();
		return () => {
			if (dialog.open) dialog.close();
			// React has already taken the dialog out of the page, so the browser does not hand focus back by itself.
			if (opener?.isConnected) opener.focus();
		};
	}, []);

	return (
		<dialog
			ref={ref}
			className={`dialog dialog-${size}`}
			tabIndex={-1}
			aria-labelledby={titleId}
			onCancel={(event) => {
				// Escape: close through React so the route and state follow. A dialog opened from inside this one is
				// its child to React wherever it is in the page, and its Escape arrives here too: that one is not ours.
				if (event.target !== ref.current) return;
				event.preventDefault();
				if (dismissable) onClose();
			}}
			onClick={(event) => {
				// A click on the backdrop lands on the dialog element itself.
				if (event.target === ref.current && dismissable) onClose();
			}}
		>
			<div className="dialog-frame">
				<header className="dialog-head">
					<div>
						<h2 id={titleId} className="dialog-title">
							{title}
						</h2>
						{lede ? <p className="dialog-lede">{lede}</p> : null}
					</div>
					<button type="button" className="icon-button" onClick={onClose} disabled={!dismissable} aria-label="Close">
						<CrossIcon />
					</button>
				</header>
				<div className="dialog-body">{children}</div>
				{footer ? <footer className="dialog-foot">{footer}</footer> : null}
			</div>
		</dialog>
	);
}
