/**
 * The one way long text is shown, wherever planners, agents and reviewers write it: the start of it,
 * then one control that shows the rest in place.
 *
 * - `LongText`, for prose: the author's line breaks kept, at most 68 characters wide, clamped to a few
 *   lines by its place (2 in a list row, 3 in a card or a subtask's row, 6 in a page's section). "Show
 *   all" is offered only when the text is cut, as measured, never by counting characters.
 * - `FoldList`, for a list: the first three items, then "Show N more". A single item is never folded away.
 * - `PathList`, for paths: how many there are, the first few as chips, then "+N".
 *
 * Code and command output keep `Output` (Blocks.tsx), which folds by lines with the same control.
 *
 * The control is a link with a chevron and `aria-expanded`, and says one of three things: "Show all",
 * "Show N more", or "Hide". Nothing folded sits on a tinted panel.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronIcon } from "./Icons";

/** The words of the control: there are only these. */
export const FOLD_WORDS = { all: "Show all", hide: "Hide", more: (count: number, noun = "more") => `Show ${count} ${noun}` } as const;

/** The control itself: `controls` is the id of what it shows and hides. */
export function FoldToggle({ open, controls, label, onToggle, className }: { open: boolean; controls: string; label: string; onToggle(): void; className?: string }) {
	return (
		<button type="button" className={`link machine-toggle fold-toggle${className ? ` ${className}` : ""}`} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
			<ChevronIcon size={11} className="machine-chevron" />
			{open ? FOLD_WORDS.hide : label}
		</button>
	);
}

/** Whether an element's text is cut by its clamp: measured after each layout, and again when its width changes. */
function useClamped(): [(node: HTMLElement | null) => void, boolean] {
	const [cut, setCut] = useState(false);
	const node = useRef<HTMLElement | null>(null);
	const observer = useRef<ResizeObserver | null>(null);
	const measure = useCallback(() => {
		const element = node.current;
		if (!element) return;
		setCut(element.scrollHeight > element.clientHeight + 1);
	}, []);
	const ref = useCallback(
		(element: HTMLElement | null) => {
			observer.current?.disconnect();
			node.current = element;
			if (!element) return;
			measure();
			if (typeof ResizeObserver !== "undefined") {
				observer.current = new ResizeObserver(measure);
				observer.current.observe(element);
			}
		},
		[measure],
	);
	useLayoutEffect(measure);
	return [ref, cut];
}

/**
 * Prose, clamped to `lines` with "Show all" when it is cut. `children` is the text as its place draws
 * it (plain, with `code` spans, or Markdown); `as` the element it is, a paragraph by default.
 */
export function LongText({ lines = 3, as: Tag = "p", className, children }: { lines?: 2 | 3 | 6; as?: "p" | "div" | "blockquote"; className?: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const [ref, cut] = useClamped();
	const style = { "--lines": lines } as CSSProperties;
	return (
		<div className="long-text">
			<Tag id={id} ref={ref as never} className={`long-text-body${className ? ` ${className}` : ""}`} data-clamped={open ? undefined : "true"} style={style}>
				{children}
			</Tag>
			{cut || open ? <FoldToggle open={open} controls={id} label={FOLD_WORDS.all} onToggle={() => setOpen((value) => !value)} /> : null}
		</div>
	);
}

/** How many items a folded list shows. */
export const FOLD_SHOWN = 3;

/** Whether a list of `count` folds: one item more than those shown is shown whole, as folding it saves nothing. */
export const listFolds = (count: number, shown = FOLD_SHOWN) => count > shown + 1;

/** A list, its first `shown` items and then "Show N more". `render` draws one item's content inside its `li`. */
export function FoldList<T>({ items, render, shown = FOLD_SHOWN, className, label, ordered = false }: { items: readonly T[]; render(item: T, index: number): ReactNode; shown?: number; className?: string; label?: string; ordered?: boolean }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const folds = listFolds(items.length, shown);
	const visible = folds && !open ? items.slice(0, shown) : items;
	const List = ordered ? "ol" : "ul";
	return (
		<>
			<List id={id} className={className} aria-label={label}>
				{visible.map((item, index) => (
					<li key={index}>{render(item, index)}</li>
				))}
			</List>
			{folds ? <FoldToggle open={open} controls={id} label={FOLD_WORDS.more(items.length - shown)} onToggle={() => setOpen((value) => !value)} className="fold-list-toggle" /> : null}
		</>
	);
}

/** Paths: their count first, a few as chips, then "+N" for the rest, which shows them in place. Monospace is for the paths only. */
export function PathList({ paths, shown = FOLD_SHOWN, noun = "path" }: { paths: readonly string[]; shown?: number; noun?: string }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	if (paths.length === 0) return null;
	const folds = listFolds(paths.length, shown);
	const visible = folds && !open ? paths.slice(0, shown) : paths;
	return (
		<span className="path-list" id={id}>
			<span className="path-list-count">
				{paths.length} {paths.length === 1 ? noun : `${noun}s`}:
			</span>
			{visible.map((path) => (
				<code key={path} className="plan-path">
					{path}
				</code>
			))}
			{folds ? (
				<button type="button" className="link path-list-more" aria-expanded={open} aria-controls={id} aria-label={open ? FOLD_WORDS.hide : FOLD_WORDS.more(paths.length - shown)} onClick={() => setOpen((value) => !value)}>
					{open ? FOLD_WORDS.hide : `+${paths.length - shown}`}
				</button>
			) : null}
		</span>
	);
}

/**
 * A long table or list cut to its first `shown` rows, then "Show N more": `children` draws the rows it
 * is given, all of them or the first ones. A list one row longer than that is shown whole.
 */
export function FoldRows<T>({ items, shown, children }: { items: readonly T[]; shown: number; children(rows: readonly T[], id: string): ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const folds = listFolds(items.length, shown);
	return (
		<>
			{children(folds && !open ? items.slice(0, shown) : items, id)}
			{folds ? <FoldToggle open={open} controls={id} label={FOLD_WORDS.more(items.length - shown)} onToggle={() => setOpen((value) => !value)} className="fold-rows-toggle" /> : null}
		</>
	);
}
