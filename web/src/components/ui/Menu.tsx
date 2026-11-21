/**
 * Menus: a list of choices, grouped under small headers, each row a label with a line of secondary
 * text, a leading glyph, and a check on the chosen one. Opened from a trigger, it is a popover
 * anchored to it on a wide screen and a bottom sheet on a phone (useSurface), from one description
 * (`MenuSpec`) that the caller builds afresh each render, so it is always live.
 *
 * Keyboard: ↑↓ move (wrapping), Home and End, ↵ (or Space) chooses, → opens a row's submenu and ←
 * comes back, Esc closes and gives focus back to the trigger, Tab closes. Without a filter field,
 * typing jumps to the next row that starts with what was typed; with one, typing filters the rows
 * and the letters that match are marked. Focus stays in one place (the list, or the filter field)
 * and the highlighted row is its `aria-activedescendant`.
 *
 * On a phone a row's submenu is pushed into the same sheet, with a back chevron; the row itself is
 * still chosen by tapping it, and its chevron opens the submenu.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "../Icons";
import { Kbd } from "./Kbd";
import { Popover, type CloseReason } from "./Popover";
import type { Align, Side } from "./position";
import { Sheet } from "./Sheet";
import { useSurface, type Surface } from "./useMediaQuery";

export interface MenuItem {
	/** Unique within its menu; also the row's `data-value` unless `value` is given. */
	id: string;
	value?: string;
	label: ReactNode;
	/** What filtering and typeahead match; the label where that is a string. */
	textValue?: string;
	/** The line under the label, in the faint ink. */
	description?: ReactNode;
	/** A glyph before the label. */
	icon?: ReactNode;
	/** Something at the row's end before the check: a "default" tag, a key. */
	trailing?: ReactNode;
	/** The chosen row: a check at its end. Undefined for a row that is an action, not a choice. */
	checked?: boolean;
	disabled?: boolean;
	tone?: "warn" | "accent";
	/** What choosing it does. The menu closes after, unless `keepOpen`. */
	onSelect?(): void;
	keepOpen?: boolean;
	/** A submenu, opened with → (or by hovering, on a wide screen). */
	submenu?: MenuSpec;
	/** Told when its submenu opens: what it lists can be asked for then. */
	onSubmenuOpen?(): void;
	/** In a sheet only: a page of its own (a form) pushed when the row is chosen. */
	panel?: ReactNode;
	/** The whole of a description that may be cut short. */
	title?: string;
	/** The description wraps onto more lines instead of being cut short: for a choice whose line says what it means. */
	wrap?: boolean;
}

export interface MenuGroup {
	id: string;
	label?: ReactNode;
	/** A few words after the label ("· signed in on d5eb81"). */
	note?: ReactNode;
	items: MenuItem[];
}

export interface MenuFilter {
	placeholder: string;
	/** Controlled: the caller filters (an asynchronous search). Uncontrolled: the rows are filtered here. */
	value?: string;
	onChange?(query: string): void;
	/** A search in flight. */
	busy?: boolean;
}

export interface MenuSpec {
	/** Its accessible name, and the sheet's title on a phone. */
	label: string;
	groups: MenuGroup[];
	filter?: MenuFilter;
	/** Shown when no row is left. */
	empty?: ReactNode;
	/** Above the rows: a warning or a note, one line or two. */
	header?: ReactNode;
	/** Under the rows: actions and links that are not choices. */
	footer?: ReactNode;
	/** The key hints at its foot ("↑↓ move ↵ choose → effort esc close"): false to leave them out; a word names what → opens. */
	hints?: boolean | { right?: string };
	/** Its width on a wide screen; 304 by default. */
	width?: number;
	/** The cap on its height on a wide screen; 360 by default. */
	maxHeight?: number;
	/** A submenu's width. */
	submenuWidth?: number;
}

/** The props a menu's trigger takes: spread them on the button. */
export interface TriggerProps {
	ref: Ref<HTMLButtonElement>;
	"aria-haspopup": "menu" | "dialog";
	"aria-expanded": boolean;
	"aria-controls"?: string;
	"data-state": "open" | "closed";
	onClick(): void;
	onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

const textOf = (item: MenuItem) => item.textValue ?? (typeof item.label === "string" ? item.label : item.id);

/** The rows a query leaves, by group. */
function filtered(groups: MenuGroup[], query: string): MenuGroup[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return groups;
	return groups.map((group) => ({ ...group, items: group.items.filter((item) => textOf(item).toLowerCase().includes(needle)) })).filter((group) => group.items.length > 0);
}

/** A string label with the letters the query matched marked. */
function Highlight({ text, query }: { text: string; query: string }) {
	const needle = query.trim().toLowerCase();
	const at = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
	if (at < 0) return <>{text}</>;
	return (
		<>
			{text.slice(0, at)}
			<mark className="ui-mark">{text.slice(at, at + needle.length)}</mark>
			{text.slice(at + needle.length)}
		</>
	);
}

export interface MenuListProps {
	spec: MenuSpec;
	surface: Surface;
	/** The menu is done: a row was chosen, or Escape, Tab, ← in a submenu. */
	onClose(reason: CloseReason): void;
	/** On a phone: push this row's submenu into the sheet. */
	onPush?(item: MenuItem): void;
	/** A submenu: ← closes it. */
	nested?: boolean;
	/** Where focus starts: on the list (or its filter), or nowhere (a submenu opened by hovering). */
	takeFocus?: boolean;
	/** Set by the parent when this list is a submenu the pointer opened: keys do not reach it until it has focus. */
	listRef?: RefObject<HTMLDivElement | null>;
}

/** The rows and their keyboard, on whichever surface holds them. */
export function MenuList({ spec, surface, onClose, onPush, nested = false, takeFocus = true, listRef }: MenuListProps) {
	const ids = { list: useId(), option: useId(), label: useId() };
	const [localQuery, setLocalQuery] = useState("");
	const controlled = spec.filter?.onChange !== undefined;
	const query = controlled ? (spec.filter?.value ?? "") : localQuery;
	const groups = useMemo(() => (spec.filter && !controlled ? filtered(spec.groups, query) : spec.groups), [spec.filter, spec.groups, controlled, query]);
	const rows = groups.flatMap((group) => group.items);
	const enabled = rows.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);
	const chosen = rows.findIndex((item) => item.checked && !item.disabled);
	const [active, setActive] = useState(() => (chosen >= 0 ? chosen : (enabled[0] ?? -1)));
	const [sub, setSub] = useState<{ id: string; focus: boolean } | null>(null);
	const ownList = useRef<HTMLDivElement>(null);
	const list = listRef ?? ownList;
	const input = useRef<HTMLInputElement>(null);
	const rowRefs = useRef(new Map<string, HTMLElement>());
	const typed = useRef({ text: "", at: 0 });
	const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
	const subList = useRef<HTMLDivElement>(null);
	const subAnchor = useRef<HTMLElement | null>(null);

	// The highlight follows the rows: back onto the list when a filter takes its row away.
	const current = rows[active] && !rows[active]?.disabled ? active : chosen >= 0 ? chosen : (enabled[0] ?? -1);
	useEffect(() => {
		if (current !== active) setActive(current);
	}, [current, active]);
	// A new query highlights the first row it leaves.
	useEffect(() => {
		if (query !== "") setActive(enabled[0] ?? -1);
		// Only when the query changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query]);

	useEffect(() => {
		if (!takeFocus) return;
		(spec.filter ? input.current : list.current)?.focus({ preventScroll: true });
		// Once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// The highlighted row stays in view.
	const activeItem = rows[current];
	useEffect(() => {
		if (activeItem) rowRefs.current.get(activeItem.id)?.scrollIntoView?.({ block: "nearest" });
	}, [activeItem]);

	useEffect(() => () => void (hover.current && clearTimeout(hover.current)), []);

	const focusSelf = () => (spec.filter ? input.current : list.current)?.focus({ preventScroll: true });

	const choose = (item: MenuItem) => {
		if (item.disabled) return;
		if (!item.onSelect && (item.submenu || item.panel)) {
			openSub(item, true);
			return;
		}
		item.onSelect?.();
		if (!item.keepOpen) onClose("select");
	};

	const openSub = (item: MenuItem, focus: boolean) => {
		if ((!item.submenu && !item.panel) || item.disabled) return;
		item.onSubmenuOpen?.();
		if (surface === "sheet") onPush?.(item);
		else if (item.submenu) setSub({ id: item.id, focus });
	};

	const move = (to: number) => {
		if (enabled.length === 0) return;
		setActive(to);
		setSub(null);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.nativeEvent.isComposing) return;
		const at = enabled.indexOf(current);
		const key = event.key;
		if (key === "ArrowDown" || key === "ArrowUp") {
			event.preventDefault();
			if (enabled.length === 0) return;
			const next = at < 0 ? 0 : (at + (key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length;
			move(enabled[next] as number);
		} else if ((key === "Home" || key === "End") && !(spec.filter && event.target === input.current && query !== "")) {
			event.preventDefault();
			move((key === "Home" ? enabled[0] : enabled[enabled.length - 1]) ?? -1);
		} else if (key === "Enter" || (key === " " && !spec.filter && Date.now() - typed.current.at >= 500)) {
			event.preventDefault();
			if (activeItem) choose(activeItem);
		} else if (key === "ArrowRight" && activeItem?.submenu && !(spec.filter && event.target === input.current && (input.current?.selectionStart ?? 0) < query.length)) {
			event.preventDefault();
			openSub(activeItem, true);
		} else if (key === "ArrowLeft" && nested && !(spec.filter && event.target === input.current && query !== "")) {
			event.preventDefault();
			onClose("back");
		} else if (key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose(nested ? "back" : "escape");
		} else if (key === "Tab") {
			onClose("tab");
		} else if (!spec.filter && key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
			// Typeahead: the next row that starts with what was typed in the last half second.
			const now = Date.now();
			typed.current = { text: now - typed.current.at < 500 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
			const text = typed.current.text;
			const order = [...enabled.slice(at + (text.length === 1 ? 1 : 0)), ...enabled.slice(0, at + (text.length === 1 ? 1 : 0))];
			const found = order.find((index) => textOf(rows[index] as MenuItem).toLowerCase().startsWith(text));
			if (found !== undefined) move(found);
		}
	};

	const hints = spec.hints === undefined ? true : spec.hints;
	const subItem = sub ? rows.find((item) => item.id === sub.id) : undefined;
	subAnchor.current = subItem ? (rowRefs.current.get(subItem.id) ?? null) : null;
	const optionId = (item: MenuItem) => `${ids.option}-${item.id}`;
	const anySub = rows.some((item) => item.submenu);

	return (
		<div className={`ui-menu ui-menu-${surface}`}>
			{spec.header ? <div className="ui-menu-header">{spec.header}</div> : null}
			{spec.filter ? (
				<div className="ui-menu-filter">
					<SearchIcon size={14} aria-hidden="true" className={spec.filter.busy ? "ui-menu-filter-busy" : undefined} />
					<input
						ref={input}
						className="ui-menu-filter-input"
						type="text"
						value={query}
						placeholder={spec.filter.placeholder}
						aria-label={spec.filter.placeholder}
						aria-controls={ids.list}
						aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => (controlled ? spec.filter?.onChange?.(event.target.value) : setLocalQuery(event.target.value))}
						onKeyDown={onKeyDown}
					/>
				</div>
			) : null}
			<div
				ref={list}
				id={ids.list}
				className="ui-menu-list"
				role="menu"
				aria-label={spec.label}
				tabIndex={spec.filter ? undefined : -1}
				aria-activedescendant={!spec.filter && activeItem ? optionId(activeItem) : undefined}
				aria-busy={spec.filter?.busy || undefined}
				onKeyDown={spec.filter ? undefined : onKeyDown}
			>
				{rows.length === 0 ? (
					<div className="ui-menu-empty">{spec.empty ?? (query ? `Nothing matches “${query.trim()}”.` : "Nothing to choose from.")}</div>
				) : (
					groups.map((group, groupIndex) => (
						<div key={group.id} role="group" aria-labelledby={group.label ? `${ids.label}-${group.id}` : undefined} className="ui-menu-group">
							{groupIndex > 0 ? <div className="ui-menu-sep" role="separator" /> : null}
							{group.label ? (
								<div className="ui-menu-group-label" id={`${ids.label}-${group.id}`}>
									<b>{group.label}</b>
									{group.note ? <span className="ui-menu-group-note">{group.note}</span> : null}
								</div>
							) : null}
							{group.items.map((item) => {
								const index = rows.indexOf(item);
								const highlighted = index === current;
								const label = typeof item.label === "string" && spec.filter && !controlled ? <Highlight text={item.label} query={query} /> : item.label;
								return (
									<div
										key={item.id}
										ref={(element) => {
											if (element) rowRefs.current.set(item.id, element);
											else rowRefs.current.delete(item.id);
										}}
										id={optionId(item)}
										role={item.checked === undefined ? "menuitem" : "menuitemradio"}
										aria-checked={item.checked === undefined ? undefined : item.checked}
										aria-disabled={item.disabled || undefined}
										aria-haspopup={item.submenu ? "menu" : undefined}
										aria-expanded={item.submenu && surface === "popover" ? sub?.id === item.id : undefined}
										data-value={item.value ?? item.id}
										title={item.title}
										data-highlighted={highlighted || undefined}
										className={`ui-item${item.tone ? ` ui-item-${item.tone}` : ""}${item.description ? " ui-item-two" : ""}${item.wrap ? " ui-item-wrap" : ""}`}
										// The focus stays where it is (the list or the filter): a press must not take it.
										onPointerDown={(event) => event.preventDefault()}
										onPointerMove={() => {
											if (item.disabled || index === current) return;
											setActive(index);
											if (hover.current) clearTimeout(hover.current);
											if (surface === "popover")
												hover.current = setTimeout(() => {
													if (item.submenu) item.onSubmenuOpen?.();
													setSub(item.submenu ? { id: item.id, focus: false } : null);
												}, item.submenu ? 120 : 160);
										}}
										onClick={() => choose(item)}
									>
										{item.icon ? <span className="ui-item-icon">{item.icon}</span> : null}
										<span className="ui-item-text">
											<span className="ui-item-label">{label}</span>
											{item.description ? <span className="ui-item-description">{item.description}</span> : null}
										</span>
										<span className="ui-item-end">
											{item.trailing}
											{item.checked ? <CheckIcon size={15} className="ui-item-check" /> : null}
											{item.submenu || (item.panel && surface === "sheet") ? (
												surface === "sheet" && item.onSelect ? (
													<button
														type="button"
														className="ui-item-push"
														aria-label={`${item.submenu?.label ?? textOf(item)}…`}
														onClick={(event) => {
															event.stopPropagation();
															openSub(item, true);
														}}
													>
														<ChevronRightIcon size={16} />
													</button>
												) : (
													<ChevronRightIcon size={14} className="ui-item-chevron" />
												)
											) : null}
										</span>
									</div>
								);
							})}
						</div>
					))
				)}
			</div>
			{spec.footer ? <div className="ui-menu-footer">{spec.footer}</div> : null}
			{hints && surface === "popover" && rows.length > 0 ? (
				<div className="ui-menu-hints" aria-hidden="true">
					<span>
						<Kbd>↑↓</Kbd>move
					</span>
					<span>
						<Kbd>↵</Kbd>choose
					</span>
					{anySub ? (
						<span>
							<Kbd>→</Kbd>
							{typeof hints === "object" && hints.right ? hints.right : "more"}
						</span>
					) : null}
					<span className="ui-menu-hints-end">
						<Kbd>esc</Kbd>
						{nested ? "back" : "close"}
					</span>
				</div>
			) : null}
			{surface === "popover" && subItem?.submenu ? (
				<SubmenuPopover
					key={subItem.id}
					item={subItem}
					anchor={subAnchor}
					focus={sub?.focus ?? false}
					listRef={subList}
					onClose={(reason) => {
						setSub(null);
						if (reason === "back") focusSelf();
						else onClose(reason);
					}}
				/>
			) : null}
		</div>
	);
}

function SubmenuPopover({ item, anchor, focus, listRef, onClose }: { item: MenuItem; anchor: RefObject<HTMLElement | null>; focus: boolean; listRef: RefObject<HTMLDivElement | null>; onClose(reason: CloseReason): void }) {
	const spec = item.submenu as MenuSpec;
	return (
		<Popover open anchor={anchor} onClose={onClose} side="right" align="start" offset={6} width={spec.width ?? 200} dismissable={false} initialFocus="none" role="group" label={spec.label} className="ui-pop-menu ui-pop-sub">
			<MenuList spec={{ ...spec, hints: false }} surface="popover" onClose={onClose} nested takeFocus={focus} listRef={listRef} />
		</Popover>
	);
}

export interface MenuProps {
	spec: MenuSpec;
	/** The control that opens it: spread the props it is given on a button. */
	trigger(props: TriggerProps): ReactNode;
	/** Controlled, when the caller opens it from elsewhere too; otherwise it keeps its own state. */
	open?: boolean;
	onOpenChange?(open: boolean): void;
	side?: Side;
	align?: Align;
	/** Forced, for a test or a page that wants one; by the screen's width otherwise. */
	surface?: Surface;
}

/** A trigger and its menu: popover or bottom sheet by the screen's width. */
export function Menu({ spec, trigger, open: controlledOpen, onOpenChange, side = "bottom", align = "start", surface: forced }: MenuProps) {
	const auto = useSurface();
	const surface = forced ?? auto;
	const [ownOpen, setOwnOpen] = useState(false);
	const open = controlledOpen ?? ownOpen;
	const setOpen = (next: boolean) => {
		if (controlledOpen === undefined) setOwnOpen(next);
		onOpenChange?.(next);
	};
	const anchor = useRef<HTMLButtonElement>(null);
	const id = useId();
	const close = () => setOpen(false);

	const triggerProps: TriggerProps = {
		ref: anchor,
		"aria-haspopup": surface === "sheet" ? "dialog" : "menu",
		"aria-expanded": open,
		"aria-controls": open ? id : undefined,
		"data-state": open ? "open" : "closed",
		onClick: () => setOpen(!open),
		onKeyDown: (event) => {
			if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
				event.preventDefault();
				setOpen(true);
			}
		},
	};

	return (
		<>
			{trigger(triggerProps)}
			{surface === "popover" ? (
				<Popover open={open} anchor={anchor} onClose={close} side={side} align={align} width={spec.width ?? 304} maxHeight={spec.maxHeight ?? 360} role="group" label={spec.label} id={id} initialFocus="none" className="ui-pop-menu">
					<MenuList spec={spec} surface="popover" onClose={close} />
				</Popover>
			) : (
				<MenuSheet open={open} spec={spec} onClose={close} anchor={anchor} id={id} />
			)}
		</>
	);
}

/**
 * A menu in a bottom sheet: its submenus (and its rows' own pages, `panel`) pushed into the same
 * sheet, with the way back. With `settings`, choosing in a pushed list goes back to the first page
 * rather than closing: a sheet of settings is left with Done.
 */
export function MenuSheet({ open, spec, onClose, anchor, id, title, settings = false, toolbar, footer }: { open: boolean; spec: MenuSpec; onClose(): void; anchor?: RefObject<HTMLElement | null>; id?: string; title?: string; settings?: boolean; toolbar?: ReactNode; footer?: ReactNode }) {
	const [path, setPath] = useState<string[]>([]);
	useEffect(() => {
		if (!open) setPath([]);
	}, [open]);
	// The page shown: the spec, then each pushed row's submenu or panel, found again in this render's spec so it is live.
	const pages: Array<{ label: string; spec: MenuSpec | null; panel: ReactNode }> = [{ label: spec.label, spec, panel: null }];
	for (const itemId of path) {
		const page = pages[pages.length - 1]?.spec;
		const item = page?.groups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
		if (!item || (!item.submenu && !item.panel)) break;
		pages.push(item.submenu ? { label: item.submenu.label, spec: item.submenu, panel: null } : { label: textOf(item), spec: null, panel: item.panel });
	}
	const page = pages[pages.length - 1] as (typeof pages)[number];
	const depth = pages.length - 1;
	const back = () => setPath((current) => current.slice(0, Math.max(0, depth - 1)));
	return (
		<Sheet open={open} onClose={onClose} title={depth === 0 ? (title ?? spec.label) : page.label} onBack={depth > 0 ? back : undefined} backLabel={depth > 0 ? (pages[depth - 1]?.label ?? "Back") : undefined} returnFocus={anchor} id={id} toolbar={toolbar} footer={depth === 0 ? footer : undefined}>
			{page.spec ? (
				<MenuList
					key={depth}
					spec={page.spec}
					surface="sheet"
					nested={depth > 0}
					onPush={(item) => setPath((current) => [...current.slice(0, depth), item.id])}
					onClose={(reason) => {
						if (reason === "back") back();
						else if (settings && depth > 0 && reason === "select") setPath([]);
						else onClose();
					}}
				/>
			) : (
				<div className="ui-sheet-panel" key={depth}>
					{page.panel}
				</div>
			)}
		</Sheet>
	);
}

/** A form that opens from a control: a popover anchored to it on a wide screen, a bottom sheet on a phone. */
export function PickerPanel({ open, onClose, anchor, title, width = 340, surface: forced, children, id }: { open: boolean; onClose(): void; anchor: RefObject<HTMLElement | null>; title: string; width?: number; surface?: Surface; children: ReactNode; id?: string }) {
	const auto = useSurface();
	const surface = forced ?? auto;
	const labelId = useId();
	if (surface === "sheet") {
		return (
			<Sheet open={open} onClose={onClose} title={title} returnFocus={anchor} id={id}>
				<div className="ui-sheet-panel">{children}</div>
			</Sheet>
		);
	}
	return (
		<Popover open={open} anchor={anchor} onClose={onClose} width={width} labelledBy={labelId} id={id} maxHeight={520} className="ui-pop-panel">
			<p className="ui-pop-panel-title" id={labelId}>
				{title}
			</p>
			{children}
		</Popover>
	);
}
