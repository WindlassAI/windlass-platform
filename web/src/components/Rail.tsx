/**
 * The rail beside a page's main side: the Agents home's repositories, and the Factory's. Its frame, its
 * fold (Ctrl+B, ⌘B on a Mac, which this browser remembers for both), the arrow keys between its rows,
 * and a row with its badges: a lime ring while something runs, an amber count of what asks the user.
 */
import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { linkProps, type Route } from "../lib/router";
import { plural } from "../lib/format";
import { loadRailFolded, saveRailFolded } from "../lib/workspace";
import { ChevronLeftIcon, ChevronRightIcon, RingIcon } from "./Icons";

/** Whether the rail is folded away, and the way to fold it; Ctrl+B (⌘B) folds it and back, where there is one (not on a phone). */
export function useRailFold(phone: boolean): [boolean, (next: boolean) => void] {
	const [folded, setFolded] = useState(() => loadRailFolded());
	const fold = useCallback((next: boolean) => {
		setFolded(next);
		saveRailFolded(next);
	}, []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || phone) return;
			if ((event.key === "b" || event.key === "B") && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
				event.preventDefault();
				fold(!folded);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [phone, folded, fold]);
	return [folded, fold];
}

/** The rail and the main side; folded, a button brings the rail back. A phone has no rail here: its page offers its own way. */
export function RailFrame({ label, rail, folded, phone, onUnfold, children }: { label: string; rail: ReactNode; folded: boolean; phone: boolean; onUnfold(): void; children: ReactNode }) {
	return (
		<div className={`ws${folded && !phone ? " ws-folded" : ""}`}>
			{phone ? null : (
				<nav className="ws-rail" aria-label={label} hidden={folded}>
					{rail}
				</nav>
			)}
			<div className="ws-main">
				{folded && !phone ? (
					<button type="button" className="ws-unfold" onClick={onUnfold} aria-label={`Show the ${label.toLowerCase()}`} title={`Show the ${label.toLowerCase()} (Ctrl+B)`}>
						<ChevronRightIcon size={14} />
						<span>{label}</span>
					</button>
				) : null}
				{children}
			</div>
		</div>
	);
}

/** The button at the rail's top that folds it away. */
export function RailFoldButton({ label, onFold }: { label: string; onFold(): void }) {
	return (
		<button type="button" className="ws-fold" onClick={onFold} aria-label={`Hide the ${label.toLowerCase()}`} title={`Hide the ${label.toLowerCase()} (Ctrl+B)`}>
			<ChevronLeftIcon size={14} />
		</button>
	);
}

/** Three dots in a row: everything at once. */
export function EverythingIcon() {
	return (
		<svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
			<circle cx="3" cy="8" r="1.4" />
			<circle cx="8" cy="8" r="1.4" />
			<circle cx="13" cy="8" r="1.4" />
		</svg>
	);
}

/** The rows a key moves between: the rail's links, in the order they stand; above the first, its search, where it has one. */
export function moveFocus(event: ReactKeyboardEvent<HTMLElement>, list: HTMLElement | null) {
	if (!list) return;
	const rows = [...list.querySelectorAll<HTMLElement>("[data-rail-row]")];
	if (rows.length === 0) return;
	const at = rows.indexOf(document.activeElement as HTMLElement);
	const to = event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : event.key === "ArrowUp" ? (at <= 0 ? -1 : at - 1) : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
	if (to === null) return;
	event.preventDefault();
	if (to === -1) {
		list.closest(".ws-rail-body")?.querySelector<HTMLInputElement>(".ws-search input")?.focus();
		return;
	}
	rows[to]?.focus();
	rows[to]?.scrollIntoView?.({ block: "nearest" });
}

/** A ring while something runs, the amber count of what asks, otherwise how many. */
/** `runningWord`: what the ring's number counts, said to a screen reader. */
export function Badges({ running, needs, count: total, saved = false, label, runningWord = "running" }: { running: boolean | number; needs: number; count: number | null; saved?: boolean; label: string; runningWord?: string }) {
	const words = [running ? (typeof running === "number" ? `${running} ${runningWord}` : "something running") : null, needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null, total !== null ? plural(total, "thing") : null, saved ? "saved settings only" : null].filter((part) => part !== null);
	return (
		<span className="ws-rail-badges">
			{running ? (
				<span className="ws-badge-running">
					<RingIcon size={12} className="ws-ring" />
					{typeof running === "number" ? <span className="ws-badge-number">{running}</span> : null}
				</span>
			) : null}
			{needs > 0 ? <span className="ws-badge-needs">{needs}</span> : null}
			{total !== null ? <span className="ws-badge-count">{total}</span> : null}
			{saved ? <span className="ws-badge-saved">saved</span> : null}
			<span className="visually-hidden">{words.length > 0 ? `, ${words.join(", ")}` : `, ${label} has nothing yet`}</span>
		</span>
	);
}

/** One row of a rail: a glyph, a name and its badges, leading to `route`. */
/** `before`: words for a screen reader ahead of the name; `children`, the row's actions beside it. */
export function RailLink({ route, current, label, icon, badges, title, quiet = false, replace = false, before, children }: { route: Route; replace?: boolean; current: boolean; label: string; icon: ReactNode; badges: ReactNode; title?: string; quiet?: boolean; before?: ReactNode; children?: ReactNode }) {
	return (
		<li className={`ws-rail-item${children ? " ws-rail-item-repo" : ""}${quiet ? " ws-rail-quiet" : ""}`}>
			<a className="ws-rail-row" data-rail-row="" aria-current={current ? "page" : undefined} title={title} {...linkProps(route, { replace })}>
				<span className="ws-rail-icon">{icon}</span>
				{before}
				<span className="ws-rail-name">{label}</span>
				{badges}
			</a>
			{children}
		</li>
	);
}
