/**
 * A bottom sheet, for a phone: a panel that rises from the bottom edge over a dimmed page, with a
 * grab handle, a title, the way back when a list was pushed into it, and Done. Rows in it are 44px
 * or taller; its foot keeps clear of the home indicator (safe-area padding).
 *
 * Modal: focus is kept inside it and goes back to the control that opened it; Escape, a press on
 * the dimmed page, Done and dragging it down by its handle close it. The page behind does not
 * scroll while it is open.
 */
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon } from "../Icons";

export interface SheetProps {
	open: boolean;
	onClose(): void;
	title: ReactNode;
	/** A list pushed into it: the back chevron, and the title of where it goes back to. */
	onBack?(): void;
	backLabel?: string;
	/** "Done" by default; false for none. */
	done?: string | false;
	/** Where focus goes back to; the element focused before it opened otherwise. */
	returnFocus?: RefObject<HTMLElement | null>;
	/** Under the title, above the scrolling body: tabs, a summary. */
	toolbar?: ReactNode;
	/** Kept at the bottom, outside the scrolling body. */
	footer?: ReactNode;
	id?: string;
	children: ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** How far the sheet is dragged down before letting go closes it. */
const DISMISS_PX = 96;

export function Sheet({ open, ...props }: SheetProps) {
	if (!open || typeof document === "undefined") return null;
	return createPortal(<SheetPanel {...props} />, document.body);
}

function SheetPanel({ onClose, title, onBack, backLabel, done = "Done", returnFocus, toolbar, footer, id, children }: Omit<SheetProps, "open">) {
	const titleId = useId();
	const panel = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<{ from: number; by: number } | null>(null);

	useEffect(() => {
		const opener = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		const element = panel.current;
		(element?.querySelector<HTMLElement>("[data-autofocus]") ?? element)?.focus({ preventScroll: true });
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = overflow;
			if (opener?.isConnected) opener.focus({ preventScroll: true });
		};
		// Once per opening.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape" && !(event.target as Element).closest?.("dialog")) {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (event.key === "Tab") {
			// Focus stays inside.
			const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (!first || !last) return;
			if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		setDrag({ from: event.clientY, by: 0 });
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (drag) setDrag({ from: drag.from, by: Math.max(0, event.clientY - drag.from) });
	};
	const onPointerUp = () => {
		if (drag && drag.by > DISMISS_PX) onClose();
		setDrag(null);
	};

	return (
		<div className="ui-sheet-root">
			<div className="ui-sheet-scrim" aria-hidden="true" onPointerDown={() => onClose()} />
			<div
				ref={panel}
				id={id}
				className={`ui-sheet${drag ? " ui-sheet-dragging" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				style={drag ? { transform: `translateY(${drag.by}px)` } : undefined}
				onKeyDown={onKeyDown}
			>
				<div className="ui-sheet-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
					<span aria-hidden="true" />
				</div>
				<div className="ui-sheet-head">
					{onBack ? (
						<button type="button" className="ui-sheet-back" onClick={onBack}>
							<ChevronLeftIcon size={16} />
							<span>{backLabel ?? "Back"}</span>
						</button>
					) : (
						<span />
					)}
					<h2 className="ui-sheet-title" id={titleId}>
						{title}
					</h2>
					{done === false ? (
						<span />
					) : (
						<button type="button" className="ui-sheet-done" onClick={onClose}>
							{done}
						</button>
					)}
				</div>
				{toolbar ? <div className="ui-sheet-toolbar">{toolbar}</div> : null}
				<div className="ui-sheet-body">{children}</div>
				{footer ? <div className="ui-sheet-foot">{footer}</div> : null}
			</div>
		</div>
	);
}
