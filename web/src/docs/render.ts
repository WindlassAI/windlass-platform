/**
 * The docs' Markdown, as HTML, with what a page needs around it: its headings for the page's contents, and its
 * sections as plain text for search. Unlike the assistant's Markdown (lib/markdown.ts) this is the platform's own
 * text, written in this repository and built into the app, so it is not sanitised: nothing here is anyone's input.
 * It needs no DOM, so a build step can render it in Node the same way the page does.
 *
 * What it adds to plain GFM:
 * - each `##` and `###` heading gets an id from its text and a link to itself;
 * - a link to `/docs/...` stays in the tab, other links on the site load their page, links elsewhere open a new tab;
 * - a code block gets a bar with its language and a copy button (the page wires the button);
 * - a quote whose first word is **Note**, **Tip** or **Careful** becomes a callout of that kind;
 * - a table's cells carry their column's name, so a narrow screen can show each row as a card.
 */
import { Marked, type Token, type Tokens } from "marked";

export interface DocsHeading {
	id: string;
	text: string;
	depth: 2 | 3;
}

export interface DocsRendered {
	html: string;
	headings: DocsHeading[];
}

/** One part of a page for search: the text under one heading, or before the first. */
export interface DocsSectionText {
	/** The heading's id, "" for the text before the first heading. */
	id: string;
	heading: string;
	text: string;
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** "Turn limit and queueing" → "turn-limit-and-queueing". */
export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/<[^>]*>/g, "")
			.replace(/&[a-z#0-9]+;/g, "")
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-") || "section"
	);
}

/** The text a run of inline tokens shows, without its marks. */
function plain(tokens: Token[] | undefined): string {
	if (!tokens) return "";
	return tokens
		.map((token) => {
			if ("tokens" in token && Array.isArray(token.tokens)) return plain(token.tokens);
			if (token.type === "codespan" || token.type === "text" || token.type === "escape") return decode((token as Tokens.Text).text);
			if (token.type === "br") return " ";
			if (token.type === "html") return "";
			return "raw" in token ? token.raw : "";
		})
		.join("");
}

function decode(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Ids for a page's headings, in order, made unique the way GitHub does: a second "Usage" is "usage-1". */
function idMaker(): (text: string) => string {
	const seen = new Map<string, number>();
	return (text) => {
		const base = slugify(text);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count}`;
	};
}

const CALLOUTS: Record<string, string> = { note: "Note", tip: "Tip", careful: "Careful" };

/** The glyphs drawn beside a callout's label and in the copy button: the app's own icons, as markup. */
const svg = (paths: string) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const CALLOUT_ICONS: Record<string, string> = {
	note: svg('<circle cx="8" cy="8" r="5.6"/><path d="M8 7.4v3.4M8 5.2v.2"/>'),
	tip: svg('<path d="M6.2 12.4h3.6M6.6 14h2.8M8 2.2a4 4 0 00-2.4 7.2c.4.3.6.8.6 1.3v.2h3.6v-.2c0-.5.2-1 .6-1.3A4 4 0 008 2.2z"/>'),
	careful: svg('<path d="M8 2.4l6 10.6H2z"/><path d="M8 6.6v3M8 11.4v.2"/>'),
};
const COPY_ICON = svg('<rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.4"/><path d="M10.4 5.6V4.2a1.4 1.4 0 00-1.4-1.4H4.2a1.4 1.4 0 00-1.4 1.4V9a1.4 1.4 0 001.4 1.4h1.4"/>');

const LANGUAGES: Record<string, string> = { sh: "shell", bash: "shell", shell: "shell", console: "shell", text: "text", json: "json", yaml: "yaml", ts: "typescript", js: "javascript" };

const cache = new Map<string, DocsRendered>();

export function renderDocs(source: string): DocsRendered {
	const cached = cache.get(source);
	if (cached) return cached;
	const nextId = idMaker();
	const headings: DocsHeading[] = [];
	const marked = new Marked({
		gfm: true,
		breaks: false,
		renderer: {
			heading({ tokens, depth }) {
				const inner = this.parser.parseInline(tokens);
				if (depth !== 2 && depth !== 3) return `<h${depth}>${inner}</h${depth}>\n`;
				const text = plain(tokens);
				const id = nextId(text);
				headings.push({ id, text, depth });
				return `<h${depth} id="${id}" class="docs-heading"><a class="docs-anchor" href="#${id}" aria-label="${escapeHtml(`Link to ${text}`)}">#</a>${inner}</h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const titled = title ? ` title="${escapeHtml(title)}"` : "";
				if (href.startsWith("/docs") || href.startsWith("#")) return `<a href="${escapeHtml(href)}" data-docs-link${titled}>${inner}</a>`;
				if (href.startsWith("/")) return `<a href="${escapeHtml(href)}"${titled}>${inner}</a>`;
				return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titled}>${inner}<span class="visually-hidden"> (opens in a new tab)</span></a>`;
			},
			code({ text, lang }) {
				const key = (lang ?? "").trim().toLowerCase();
				const label = LANGUAGES[key] ?? (key || "text");
				return `<div class="docs-code"><div class="docs-code-bar"><span class="docs-code-lang">${escapeHtml(label)}</span><button type="button" class="docs-copy" data-docs-copy>${COPY_ICON}<span>Copy</span></button></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
			},
			blockquote({ tokens }) {
				const inner = this.parser.parse(tokens);
				const match = /^<p><strong>(Note|Tip|Careful)<\/strong>:?\s*/i.exec(inner);
				if (!match?.[1]) return `<blockquote>${inner}</blockquote>\n`;
				const kind = match[1].toLowerCase();
				const body = `<p>${inner.slice(match[0].length)}`;
				return `<aside class="docs-callout docs-callout-${kind}" aria-label="${CALLOUTS[kind]}"><p class="docs-callout-label">${CALLOUT_ICONS[kind] ?? ""}${CALLOUTS[kind]}</p>${body}</aside>\n`;
			},
			table(token) {
				const head = token.header.map((cell) => `<th${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`).join("");
				// Each cell carries its column's name, so a narrow screen can show a row as a card of labelled lines.
				const labels = token.header.map((cell) => escapeHtml(plain(cell.tokens)));
				const rows = token.rows.map((row) => `<tr>${row.map((cell, at) => `<td data-label="${labels[at] ?? ""}"${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`).join("\n");
				return `<div class="docs-table" role="region" aria-label="Table" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
			},
		},
	});
	const html = marked.parse(source, { async: false });
	const rendered = { html, headings };
	cache.set(source, rendered);
	return rendered;
}

/** A page's text in parts, one per `##` or `###` heading, for search. Code is kept: commands are worth finding. */
export function docsSections(source: string): DocsSectionText[] {
	const nextId = idMaker();
	const tokens = new Marked({ gfm: true }).lexer(source);
	const sections: DocsSectionText[] = [{ id: "", heading: "", text: "" }];
	const add = (text: string) => {
		const current = sections[sections.length - 1];
		if (current && text.trim()) current.text += `${current.text ? " " : ""}${text.replace(/\s+/g, " ").trim()}`;
	};
	const walk = (list: Token[]) => {
		for (const token of list) {
			if (token.type === "heading") {
				const heading = token as Tokens.Heading;
				const text = plain(heading.tokens);
				if (heading.depth === 2 || heading.depth === 3) sections.push({ id: nextId(text), heading: text, text: "" });
				else add(text);
			} else if (token.type === "code") add((token as Tokens.Code).text);
			else if (token.type === "paragraph" || token.type === "text") add(plain((token as Tokens.Paragraph).tokens ?? []) || (token as Tokens.Text).text);
			else if (token.type === "list") for (const item of (token as Tokens.List).items) walk(item.tokens);
			else if (token.type === "blockquote") walk((token as Tokens.Blockquote).tokens);
			else if (token.type === "table") {
				const table = token as Tokens.Table;
				add([table.header, ...table.rows].map((row) => row.map((cell) => plain(cell.tokens)).join(" ")).join(" "));
			}
		}
	};
	walk(tokens);
	return sections.filter((section) => section.heading !== "" || section.text !== "");
}
