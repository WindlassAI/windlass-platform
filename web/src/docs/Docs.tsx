/**
 * The docs: a public part of the site, open without signing in. A bar with search, the chapters down the side,
 * the page, its contents beside it, and the way to the page before and after.
 *
 * `DocsView` renders from its props alone (the slug and the address's fragment), with no browser in sight, so a
 * build step can render a page to HTML. `DocsApp` is the page in a browser: it follows the address, the theme and
 * the title.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeftIcon, ChevronIcon, CrossIcon, SearchIcon } from "../components/Icons";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { href, lastAppHref, navigate, useHash, useRoute } from "../lib/router";
import { useTheme, type Theme } from "../lib/theme";
import { docsSource } from "./content";
import { DOCS_PAGES, DOCS_SECTIONS, docsPage, docsPath, docsTitle, type DocsPage } from "./pages";
import { renderDocs, type DocsHeading } from "./render";
import { searchDocs, terms, type DocsHit } from "./search";

/** A chapter's number as the sidebar and the page's eyebrow show it: the overview has none. */
function chapter(page: DocsPage): string {
	const at = DOCS_PAGES.indexOf(page);
	return at <= 0 ? "" : String(at).padStart(2, "0");
}

/** An address of the docs, `/docs/runner#status`, as the docs' route. */
function docsRoute(address: string): { slug: string; section?: string } | null {
	const match = /^\/docs(?:\/([a-z0-9-]+))?\/?(?:#(.+))?$/.exec(address);
	if (!match) return null;
	return { slug: match[1] ?? "", ...(match[2] ? { section: decodeURIComponent(match[2]) } : {}) };
}

function go(address: string): boolean {
	const route = docsRoute(address);
	if (!route) return false;
	navigate({ name: "docs", ...route });
	return true;
}

/** A link inside the docs: no page load, and a new tab on a modified click. */
function DocsLink({ to, className, children, current, onFollow }: { to: string; className?: string; children: React.ReactNode; current?: boolean; onFollow?(): void }) {
	return (
		<a
			className={className}
			href={to}
			aria-current={current ? "page" : undefined}
			onClick={(event) => {
				if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				if (go(to)) {
					event.preventDefault();
					onFollow?.();
				}
			}}
		>
			{children}
		</a>
	);
}

/** The app's home, keeping `?mock=1` when there is one; plain "/" where there is no browser. */
function appHref(): string {
	return typeof location === "undefined" ? "/" : href({ name: "home" });
}

// ---- search --------------------------------------------------------------------------------------

function Highlight({ text, query }: { text: string; query: string }) {
	const words = terms(query)
		.filter((word) => word.length > 1)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (words.length === 0) return <>{text}</>;
	const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
	return <>{parts.map((part, at) => (at % 2 === 1 ? <mark key={at}>{part}</mark> : part))}</>;
}

/**
 * What a visitor typed into the prerendered page's search before the app took the page over: the app starts
 * its search from it, so no keystroke is lost while the docs load.
 */
export interface StaticSearch {
	query: string;
	focused: boolean;
	selection: [number, number] | null;
}

/** The prerendered search field's state, read just before the app replaces the static page. */
export function takeStaticSearch(container: HTMLElement): StaticSearch | null {
	const field = container.querySelector<HTMLInputElement>("input[data-docs-search]");
	if (!field) return null;
	const focused = document.activeElement === field;
	if (!focused && field.value === "") return null;
	return { query: field.value, focused, selection: field.selectionStart !== null && field.selectionEnd !== null ? [field.selectionStart, field.selectionEnd] : null };
}

function DocsSearch({ autoFocus = false, onDone, initial, bar = false }: { autoFocus?: boolean; onDone?(): void; initial?: StaticSearch; bar?: boolean }) {
	const [query, setQuery] = useState(initial?.query ?? "");
	const [open, setOpen] = useState(initial?.focused ?? false);
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();
	const hits: DocsHit[] = useMemo(() => searchDocs(query), [query]);
	const showing = open && query.trim() !== "";

	useEffect(() => {
		if (autoFocus) input.current?.focus();
	}, [autoFocus]);

	// Take over the static page's field where the visitor left it: focused, with the caret where it was.
	const carried = useRef(initial);
	useLayoutEffect(() => {
		const from = carried.current;
		const field = input.current;
		carried.current = undefined;
		if (!from?.focused || !field) return;
		field.focus({ preventScroll: true });
		if (from.selection) field.setSelectionRange(from.selection[0], from.selection[1]);
	}, []);

	// ⌘K (Ctrl K elsewhere) from anywhere, or "/" from anywhere but a field, puts you in the search.
	useEffect(() => {
		if (autoFocus) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.repeat) return;
			const chord = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
			const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
			if (!chord && !slash) return;
			const target = event.target instanceof Element ? event.target : null;
			if (slash && target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
			const field = input.current;
			if (!field || field.offsetParent === null) return;
			event.preventDefault();
			field.focus();
			field.select();
			setOpen(true);
		};
		// The capture phase, so that nothing on the page can swallow the key first.
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [autoFocus]);

	// The chord as this machine writes it: known only in a browser, so the static page shows "/".
	const [chordLabel, setChordLabel] = useState<string | null>(null);
	useEffect(() => {
		const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
		setChordLabel(/mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K");
	}, []);

	const follow = (hit: DocsHit) => {
		setOpen(false);
		setQuery("");
		input.current?.blur();
		go(hit.href);
		onDone?.();
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setOpen(true);
			setActive((at) => Math.min(at + 1, hits.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((at) => Math.max(at - 1, 0));
		} else if (event.key === "Enter") {
			const hit = hits[active];
			if (hit) {
				event.preventDefault();
				follow(hit);
			}
		} else if (event.key === "Escape") {
			// A query or open results close first; the drawer around the field closes on the next Escape.
			if (query || showing) event.stopPropagation();
			if (query) setQuery("");
			else input.current?.blur();
			setOpen(false);
		}
	};

	return (
		<div className="docs-search" role="search">
			<label className="docs-search-field">
				<SearchIcon size={15} />
				<span className="visually-hidden">Search the docs</span>
				<input
					ref={input}
					type="search"
					data-docs-search={bar ? "" : undefined}
					placeholder="Search the docs"
					value={query}
					role="combobox"
					aria-expanded={showing}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={showing && hits[active] ? `${listId}-${active}` : undefined}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					onBlur={() => setTimeout(() => setOpen(false), 120)}
					onKeyDown={onKeyDown}
				/>
				{autoFocus ? null : (
					<kbd className="docs-search-key" aria-hidden="true">
						{chordLabel ?? "/"}
					</kbd>
				)}
			</label>
			{showing ? (
				<div className="docs-results">
					{hits.length === 0 ? (
						<p className="docs-results-empty" role="status">
							Nothing in the docs matches “{query.trim()}”.
						</p>
					) : (
						<ul id={listId} role="listbox" aria-label="Results">
							{hits.map((hit, at) => (
								<li key={hit.href} id={`${listId}-${at}`} role="option" aria-selected={at === active} className="docs-result" onMouseEnter={() => setActive(at)}>
									<a
										href={hit.href}
										tabIndex={-1}
										onMouseDown={(event) => event.preventDefault()}
										onClick={(event) => {
											if (event.metaKey || event.ctrlKey || event.shiftKey) return;
											event.preventDefault();
											follow(hit);
										}}
									>
										<span className="docs-result-where">
											{hit.page.title}
											{hit.heading ? (
												<>
													<span aria-hidden="true"> › </span>
													<span className="visually-hidden">, </span>
													<Highlight text={hit.heading} query={query} />
												</>
											) : null}
										</span>
										<span className="docs-result-text">
											<Highlight text={hit.snippet} query={query} />
										</span>
									</a>
								</li>
							))}
						</ul>
					)}
					<p className="docs-results-keys" aria-hidden="true">
						<span>
							<kbd>↑</kbd>
							<kbd>↓</kbd> move
						</span>
						<span>
							<kbd>↵</kbd> open
						</span>
						<span>
							<kbd>esc</kbd> close
						</span>
					</p>
				</div>
			) : null}
		</div>
	);
}

// ---- navigation ----------------------------------------------------------------------------------

function DocsNav({ current, onFollow }: { current: DocsPage | undefined; onFollow?(): void }) {
	return (
		<nav className="docs-nav-list" aria-label="Documentation">
			{DOCS_SECTIONS.map((section) => (
				<div key={section} className="docs-nav-group">
					<p className="docs-nav-heading">{section}</p>
					<ul>
						{DOCS_PAGES.filter((page) => page.section === section).map((page) => (
							<li key={page.slug}>
								<DocsLink to={docsPath(page.slug)} className="docs-nav-link" current={page === current} onFollow={onFollow}>
									<span className="docs-nav-num" aria-hidden="true">
										{chapter(page) || "··"}
									</span>
									<span>{page.slug === "" ? "Overview" : page.title}</span>
								</DocsLink>
							</li>
						))}
					</ul>
				</div>
			))}
		</nav>
	);
}

/** The page's own headings, with the one you are reading marked. */
function Contents({ headings, active }: { headings: DocsHeading[]; active: string }) {
	return (
		<ul className="docs-toc-list">
			{headings.map((heading) => (
				<li key={heading.id} className={heading.depth === 3 ? "docs-toc-sub" : undefined}>
					<a href={`#${heading.id}`} aria-current={heading.id === active ? "location" : undefined}>
						{heading.text}
					</a>
				</li>
			))}
		</ul>
	);
}

function Pager({ page }: { page: DocsPage }) {
	const at = DOCS_PAGES.indexOf(page);
	const previous = at > 0 ? DOCS_PAGES[at - 1] : undefined;
	const next = DOCS_PAGES[at + 1];
	return (
		<nav className="docs-pager" aria-label="Previous and next pages">
			{previous ? (
				<DocsLink to={docsPath(previous.slug)} className="docs-pager-link docs-pager-previous">
					<span className="docs-pager-dir">Previous</span>
					<span className="docs-pager-title">{previous.slug === "" ? "Overview" : previous.title}</span>
				</DocsLink>
			) : (
				<span />
			)}
			{next ? (
				<DocsLink to={docsPath(next.slug)} className="docs-pager-link docs-pager-next">
					<span className="docs-pager-dir">Next</span>
					<span className="docs-pager-title">{next.title}</span>
				</DocsLink>
			) : null}
		</nav>
	);
}

/** The overview's chapters, as cards. */
function Chapters() {
	return (
		<ol className="docs-chapters">
			{DOCS_PAGES.slice(1).map((page) => (
				<li key={page.slug}>
					<DocsLink to={docsPath(page.slug)} className="docs-chapter">
						<span className="docs-chapter-num" aria-hidden="true">
							{chapter(page)}
						</span>
						<span className="docs-chapter-title">{page.title}</span>
						<span className="docs-chapter-text">{page.description}</span>
					</DocsLink>
				</li>
			))}
		</ol>
	);
}

// ---- the page ------------------------------------------------------------------------------------

export interface DocsViewProps {
	slug: string;
	theme: Theme;
	onToggleTheme(): void;
	/** The heading you are reading, for the contents. */
	activeHeading?: string;
	returnHref?: string;
	/** What was typed into the static page's search before the app started. */
	initialSearch?: StaticSearch;
}

export function DocsView({ slug, theme, onToggleTheme, activeHeading = "", returnHref = "/", initialSearch }: DocsViewProps) {
	const page = docsPage(slug);
	const rendered = useMemo(() => (page ? renderDocs(docsSource(page)) : null), [page]);
	const [menu, setMenu] = useState<"closed" | "nav" | "search">("closed");
	const prose = useRef<HTMLDivElement>(null);

	// The drawer closes when the page changes, and on Escape.
	useEffect(() => setMenu("closed"), [slug]);
	useEffect(() => {
		if (menu === "closed") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu("closed");
		};
		document.addEventListener("keydown", onKey);
		document.body.classList.add("docs-locked");
		return () => {
			document.removeEventListener("keydown", onKey);
			document.body.classList.remove("docs-locked");
		};
	}, [menu]);

	// The prose is HTML: its links to other pages of the docs and its copy buttons are handled here.
	const onProseClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		const copy = target.closest<HTMLButtonElement>("[data-docs-copy]");
		if (copy) {
			const code = copy.closest(".docs-code")?.querySelector("code")?.textContent ?? "";
			void navigator.clipboard?.writeText(code).then(
				() => {
					const label = copy.querySelector("span") ?? copy;
					label.textContent = "Copied";
					copy.dataset.state = "done";
					setTimeout(() => {
						label.textContent = "Copy";
						delete copy.dataset.state;
					}, 1600);
				},
				() => {
					(copy.querySelector("span") ?? copy).textContent = "Select and copy";
				},
			);
			return;
		}
		const link = target.closest<HTMLAnchorElement>("a[data-docs-link]");
		if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const address = link.getAttribute("href") ?? "";
		if (address.startsWith("#")) return;
		if (go(address)) event.preventDefault();
	}, []);

	const headings = rendered?.headings.filter((heading) => heading.depth === 2 || heading.depth === 3) ?? [];

	return (
		<div className="docs">
			<a className="docs-skip" href="#docs-main">
				Skip to the page
			</a>
			<header className="docs-bar">
				<DocsLink to="/docs" className="docs-brand">
					<Wordmark />
					<span className="docs-brand-tag">docs</span>
				</DocsLink>
				<div className="docs-bar-search">
					<DocsSearch bar initial={initialSearch} />
				</div>
				<div className="docs-bar-end">
					<button type="button" className="icon-button docs-bar-narrow" aria-label="Search the docs" onClick={() => setMenu("search")}>
						<SearchIcon />
					</button>
					<ThemeToggle theme={theme} onToggle={onToggleTheme} />
					<a className="button button-outline button-small docs-open" href={returnHref}>
						Open Windlass
					</a>
					<button type="button" className="icon-button docs-bar-narrow" aria-label="Menu" aria-expanded={menu === "nav"} aria-controls="docs-drawer" onClick={() => setMenu(menu === "nav" ? "closed" : "nav")}>
						<span className="docs-burger" aria-hidden="true" />
					</button>
				</div>
			</header>

			{menu !== "closed" ? (
				<div className="docs-drawer-backdrop" onClick={() => setMenu("closed")} aria-hidden="true" />
			) : null}
			<div id="docs-drawer" className="docs-drawer" data-open={menu !== "closed" ? "" : undefined} role="dialog" aria-modal="true" aria-label="Docs menu" hidden={menu === "closed"}>
				<div className="docs-drawer-head">
					<span className="eyebrow">Docs</span>
					<button type="button" className="icon-button" aria-label="Close the menu" onClick={() => setMenu("closed")}>
						<CrossIcon />
					</button>
				</div>
				{menu !== "closed" ? <DocsSearch autoFocus={menu === "search"} onDone={() => setMenu("closed")} /> : null}
				<DocsNav current={page} onFollow={() => setMenu("closed")} />
				<a className="button button-outline docs-drawer-open" href={returnHref}>
					Open Windlass
				</a>
			</div>

			<div className="docs-frame">
				<aside className="docs-side">
					<DocsNav current={page} />
				</aside>

				<main id="docs-main" className="docs-main" tabIndex={-1}>
					{page && rendered ? (
						<article className={`docs-article${page.slug === "" ? " docs-article-home" : ""}`}>
							<header className="docs-head">
								<p className="docs-eyebrow">
									{page.slug === "" ? (
										"Documentation"
									) : (
										<>
											<span className="docs-eyebrow-num">{chapter(page)}</span>
											<span aria-hidden="true">/</span>
											{page.section}
										</>
									)}
								</p>
								<h1 className="docs-title" tabIndex={-1}>
									{page.slug === "" ? (
										<>
											Run agents in the open,
											<br />
											<em>turn by turn.</em>
										</>
									) : (
										page.title
									)}
								</h1>
								<p className="docs-lede">{page.description}</p>
							</header>

							{page.slug === "" ? <Chapters /> : null}

							{headings.length > 2 ? (
								<details className="docs-toc-inline">
									<summary>
										On this page
										<ChevronIcon size={14} />
									</summary>
									<Contents headings={headings} active={activeHeading} />
								</details>
							) : null}

							<div ref={prose} className="docs-prose" onClick={onProseClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />

							<Pager page={page} />
						</article>
					) : (
						<article className="docs-article docs-missing">
							<header className="docs-head">
								<p className="docs-eyebrow">404</p>
								<h1 className="docs-title" tabIndex={-1}>
									No page here
								</h1>
								<p className="docs-lede">The docs have no page at this address. It may have moved: the overview lists every page, and search finds what is on them.</p>
							</header>
							<DocsLink to="/docs" className="button button-outline">
								<ArrowLeftIcon />
								The overview
							</DocsLink>
						</article>
					)}

					{headings.length > 2 ? (
						<aside className="docs-toc" aria-label="On this page">
							<p className="docs-toc-heading">On this page</p>
							<Contents headings={headings} active={activeHeading} />
						</aside>
					) : null}
				</main>
			</div>

			<footer className="docs-foot">
				<span>Windlass</span>
				<span aria-hidden="true">·</span>
				<DocsLink to="/docs">Docs</DocsLink>
				<span aria-hidden="true">·</span>
				<a href={appHref()}>Sign in</a>
			</footer>
		</div>
	);
}

/** The heading nearest above the top of the window, as you scroll. */
function useActiveHeading(slug: string): string {
	const [active, setActive] = useState("");
	useEffect(() => {
		let frame = 0;
		const measure = () => {
			frame = 0;
			const headings = Array.from(document.querySelectorAll<HTMLElement>(".docs-prose .docs-heading"));
			let current = headings[0]?.id ?? "";
			for (const heading of headings) {
				if (heading.getBoundingClientRect().top <= 140) current = heading.id;
				else break;
			}
			// At the bottom of the page, the last heading is the one you are reading.
			if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4 && headings.length) current = headings[headings.length - 1]?.id ?? current;
			setActive(current);
		};
		const onScroll = () => {
			if (frame === 0) frame = requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [slug]);
	return active;
}

function setDescription(text: string): void {
	let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "description";
		document.head.append(meta);
	}
	meta.content = text;
}

/** The docs in a browser: the address's page, its title, and the scroll to where the address points. */
export function DocsApp({ theme: given, onToggleTheme: givenToggle, initialSearch }: { theme?: Theme; onToggleTheme?(): void; initialSearch?: StaticSearch } = {}) {
	const route = useRoute();
	const hash = useHash();
	const [ownTheme, ownToggle] = useTheme();
	const theme = given ?? ownTheme;
	const onToggleTheme = givenToggle ?? ownToggle;
	const slug = route.name === "docs" ? route.slug : "";
	const active = useActiveHeading(slug);
	const first = useRef(true);

	useEffect(() => {
		const page = docsPage(slug);
		document.title = page ? docsTitle(page) : "Not found · Windlass docs";
		setDescription(page?.description ?? DOCS_PAGES[0]?.description ?? "");
	}, [slug]);

	// A new page starts at its top, or at the section the address names; a later one takes the focus to its heading.
	useEffect(() => {
		const id = decodeURIComponent(hash.replace(/^#/, ""));
		const target = id ? document.getElementById(id) : null;
		if (target) target.scrollIntoView({ block: "start" });
		else if (!first.current) window.scrollTo(0, 0);
		if (!first.current && !id) document.querySelector<HTMLElement>(".docs-title")?.focus({ preventScroll: true });
		first.current = false;
	}, [slug, hash]);

	return <DocsView slug={slug} theme={theme} onToggleTheme={onToggleTheme} activeHeading={active} returnHref={lastAppHref()} initialSearch={initialSearch} />;
}

