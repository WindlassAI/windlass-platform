/**
 * Markdown to safe HTML for the assistant's prose. `marked` parses, DOMPurify removes anything that
 * could run or load: scripts, event handlers, styles, forms, images from elsewhere, odd URL schemes.
 * Links open in a new tab without a referrer.
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

const ALLOWED_TAGS = ["a", "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "input", "span"];
const ALLOWED_ATTR = ["href", "title", "align", "type", "checked", "disabled", "class", "start"];

let hooked = false;

function purifier(): typeof DOMPurify {
	if (!hooked) {
		hooked = true;
		DOMPurify.addHook("afterSanitizeAttributes", (node) => {
			if (node.tagName === "A") {
				node.setAttribute("target", "_blank");
				node.setAttribute("rel", "noopener noreferrer nofollow");
			}
			// Only the checkboxes of a task list survive as inputs, and they cannot be changed.
			if (node.tagName === "INPUT") {
				if (node.getAttribute("type") !== "checkbox") node.remove();
				else node.setAttribute("disabled", "");
			}
		});
	}
	return DOMPurify;
}

const cache = new Map<string, string>();

export function renderMarkdown(source: string): string {
	const cached = cache.get(source);
	if (cached !== undefined) return cached;
	const raw = marked.parse(source, { async: false });
	// DOMPurify holds every attribute value to the URI pattern unless the attribute is declared safe; the
	// pattern here admits web and mail links only, so the non-link attributes are declared.
	const html = purifier().sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i, ADD_URI_SAFE_ATTR: ["type", "align", "start", "checked", "disabled"] });
	// Finished answers are rendered again whenever the list re-renders; streaming ones are not worth keeping.
	if (cache.size > 400) cache.clear();
	cache.set(source, html);
	return html;
}

/** The first heading or bold line of a reasoning summary, for its collapsed row: "**Locating the test**" → "Locating the test". */
export function reasoningTitle(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	const title = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
	return title.length > 90 ? `${title.slice(0, 88)}…` : title;
}
