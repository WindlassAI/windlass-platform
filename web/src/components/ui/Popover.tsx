/**
 * A panel that floats beside the control that opened it: anchored to it (below and start-aligned by
 * default, flipped above when the room is there, shifted to stay on screen), sized to its content
 * with a cap on its height, and scrolling inside past that. It is drawn at the end of the page, so
 * nothing it sits in clips it.
 *
 * Non-modal: the page stays usable. Escape closes it, as do a press outside it and focus leaving it;
 * focus goes back to the control that opened it when it closes from inside. Panels opened from
 * inside it (a submenu) share its layer, so a press in one is not outside the other; a native
 * <dialog> opened from it (a secrets dialog) is part of it too.
 */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { place, type Align, type Side } from "./position";

export type CloseReason = "escape" | "outside" | "select" | "trigger" | "tab" | "back";

/** The layer a panel belongs to: its outermost panel's id. */
const LayerContext = createContext<string | null>(null);

export const useLayer = () => useContext(LayerContext);

/** Whether a node is inside any panel of this layer, or a dialog opened from one. */
export function inLayer(node: Node | null, layer: string): boolean {
	const element = node instanceof Element ? node : (node?.parentElement ?? null);
	if (!element) return false;
	if (element.closest("dialog") !== null) return true;
	for (let at: Element | null = element.closest("[data-layer]"); at !== null; at = at.parentElement?.closest("[data-layer]") ?? null) if (at.getAttribute("data-layer") === layer) return true;
	return false;
}

export interface PopoverProps {
	open: boolean;
	onClose(reason: CloseReason): void;
	/** The control it is anchored to; focus goes back there when it closes. */
	anchor: RefObject<HTMLElement | null>;
	side?: Side;
	align?: Align;
	offset?: number;
	/** The cap on its height (360 by default); the room on its side caps it too. */
	maxHeight?: number;
	/** Its width: a number, the trigger's ("anchor"), or its content's ("auto", the default, between minWidth and maxWidth). */
	width?: number | "anchor" | "auto";
	minWidth?: number;
	maxWidth?: number;
	role?: "dialog" | "menu" | "listbox" | "group";
	/** Its accessible name, where nothing in it names it. */
	label?: string;
	labelledBy?: string;
	id?: string;
	className?: string;
	/** Where focus goes when it opens: its first control, the panel itself, a given element, or nowhere (it stays where it was). */
	initialFocus?: "first" | "panel" | "none" | RefObject<HTMLElement | null>;
	/** Whether a press outside closes it: a submenu leaves that to its parent. */
	dismissable?: boolean;
	children: ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Popover({ open, ...props }: PopoverProps) {
	if (!open || typeof document === "undefined") return null;
	return createPortal(<Panel {...props} />, document.body);
}

function Panel({ onClose, anchor, side = "bottom", align = "start", offset = 6, maxHeight = 360, width = "auto", minWidth = 220, maxWidth = 360, role = "dialog", label, labelledBy, id, className, initialFocus = "first", dismissable = true, children }: Omit<PopoverProps, "open">) {
	const own = useId();
	const parent = useLayer();
	const layer = parent ?? own;
	const panel = useRef<HTMLDivElement>(null);
	// Unplaced, it is drawn transparent rather than hidden: what is in it can take focus from the start.
	const [style, setStyle] = useState<CSSProperties>({ opacity: 0, left: 0, top: 0 });
	const [placedSide, setPlacedSide] = useState<Side>(side);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	// Placed before it is painted, and again when the page scrolls or resizes, or its content changes size.
	useLayoutEffect(() => {
		const element = panel.current;
		if (!element) return;
		const update = () => {
			const target = anchor.current;
			if (!target) return;
			const rect = target.getBoundingClientRect();
			const own = { width: element.offsetWidth, height: element.scrollHeight };
			const placed = place({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, own, { width: window.innerWidth, height: window.innerHeight }, { side, align, offset, padding: 8, maxHeight });
			setPlacedSide(placed.side);
			setStyle({ left: placed.x, top: placed.y, maxHeight: placed.maxHeight, transformOrigin: placed.origin, ...(width === "anchor" ? { width: rect.width } : typeof width === "number" ? { width } : { minWidth, maxWidth }) });
		};
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
		observer?.observe(element);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			observer?.disconnect();
		};
	}, [anchor, side, align, offset, maxHeight, width, minWidth, maxWidth]);

	// Focus in, when it opens; and back to the trigger when it closes with focus inside.
	useEffect(() => {
		const element = panel.current;
		if (!element) return;
		const opener = anchor.current;
		if (initialFocus === "panel") element.focus({ preventScroll: true });
		else if (initialFocus === "first") (element.querySelector<HTMLElement>("[data-autofocus]") ?? element.querySelector<HTMLElement>(FOCUSABLE) ?? element).focus({ preventScroll: true });
		else if (initialFocus !== "none") initialFocus.current?.focus({ preventScroll: true });
		return () => {
			const active = document.activeElement;
			const inside = active === null || active === document.body || !active.isConnected || element.contains(active);
			if (inside && opener?.isConnected && parent === null) opener.focus({ preventScroll: true });
		};
		// Once per opening.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// A press outside the layer and its trigger closes it.
	useEffect(() => {
		if (!dismissable) return;
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (inLayer(target, layer) || (target && anchor.current?.contains(target))) return;
			closeRef.current("outside");
		};
		document.addEventListener("pointerdown", onPointer, true);
		return () => document.removeEventListener("pointerdown", onPointer, true);
	}, [dismissable, layer, anchor]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// A dialog opened from inside has its own Escape.
		if (event.key !== "Escape" || (event.target as Element).closest?.("dialog")) return;
		event.preventDefault();
		event.stopPropagation();
		onClose("escape");
	};

	return (
		<LayerContext.Provider value={layer}>
			<div
				ref={panel}
				id={id}
				className={`ui-pop${className ? ` ${className}` : ""}`}
				data-layer={layer}
				data-side={placedSide}
				role={role}
				aria-label={label}
				aria-labelledby={labelledBy}
				tabIndex={-1}
				style={style}
				onKeyDown={onKeyDown}
				onBlur={(event) => {
					// Focus that leaves the layer (Tab past its end) closes it; focus that leaves the page does not.
					const next = event.relatedTarget as Node | null;
					if (dismissable && next !== null && !inLayer(next, layer) && !anchor.current?.contains(next)) onClose("tab");
				}}
			>
				{children}
			</div>
		</LayerContext.Provider>
	);
}
