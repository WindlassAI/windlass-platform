/**
 * A short label for a control, shown on hover after a moment and at once on keyboard focus; once one
 * has shown, the next opens without the wait (and without motion). It names or explains; it never
 * holds the only way to do something. The control is described by it while it shows.
 */
import {
	cloneElement,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { place, type Side } from "./position";

/** When the last tooltip closed: one opened soon after skips the wait. */
let lastClosed = 0;
const WAIT_MS = 450;
const WARM_MS = 400;

export function Tooltip({
	content,
	side = "top",
	children,
}: {
	content: ReactNode;
	side?: Side;
	children: ReactElement<Record<string, unknown>>;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [warm, setWarm] = useState(false);
	const wrap = useRef<HTMLSpanElement>(null);
	const tip = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [style, setStyle] = useState<{ left: number; top: number; visibility?: "hidden" }>({
		left: 0,
		top: 0,
		visibility: "hidden",
	});

	const show = (now: boolean) => {
		if (timer.current) clearTimeout(timer.current);
		const quick = now || Date.now() - lastClosed < WARM_MS;
		setWarm(quick);
		if (quick) setOpen(true);
		else timer.current = setTimeout(() => setOpen(true), WAIT_MS);
	};
	const hide = () => {
		if (timer.current) clearTimeout(timer.current);
		if (open) lastClosed = Date.now();
		setOpen(false);
	};
	useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
	const mine = (target: EventTarget) => target instanceof Node && wrap.current?.contains(target) === true;

	useLayoutEffect(() => {
		if (!open || !wrap.current || !tip.current) return;
		const target = (wrap.current.firstElementChild as HTMLElement | null) ?? wrap.current;
		const rect = target.getBoundingClientRect();
		const placed = place(
			{ x: rect.left, y: rect.top, width: rect.width, height: rect.height },
			{ width: tip.current.offsetWidth, height: tip.current.offsetHeight },
			{ width: window.innerWidth, height: window.innerHeight },
			{ side, align: "start", offset: 6, padding: 8 },
		);
		// Centred on the control, then kept on screen.
		const left = Math.max(
			8,
			Math.min(
				rect.left + rect.width / 2 - tip.current.offsetWidth / 2,
				window.innerWidth - tip.current.offsetWidth - 8,
			),
		);
		setStyle({ left: side === "top" || side === "bottom" ? left : placed.x, top: placed.y });
	}, [open, side]);

	return (
		<span
			ref={wrap}
			className="ui-tooltip-anchor"
			// Events from a menu or popover the control opened reach here through React's tree: only the control's own count.
			onPointerEnter={event => event.pointerType === "mouse" && mine(event.target) && show(false)}
			onPointerLeave={hide}
			onPointerDown={hide}
			onFocus={event => mine(event.target) && (event.target as HTMLElement).matches?.(":focus-visible") && show(true)}
			onBlur={hide}
			onKeyDown={event => event.key === "Escape" && open && hide()}
		>
			{cloneElement(children, {
				"aria-describedby": open ? id : (children.props["aria-describedby"] as string | undefined),
			})}
			{open && typeof document !== "undefined"
				? createPortal(
						<div
							ref={tip}
							id={id}
							role="tooltip"
							className={`ui-tooltip${warm ? " ui-tooltip-warm" : ""}`}
							style={style}
						>
							{content}
						</div>,
						document.body,
					)
				: null}
		</span>
	);
}
