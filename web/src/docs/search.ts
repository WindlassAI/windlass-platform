/**
 * Search across the docs, in the page: a small index of every section's text, built once, and a scorer that
 * wants every word of the query somewhere in a section and ranks titles above headings above body text.
 */
import { docsWithSources } from "./content";
import { docsPath, type DocsPage } from "./pages";
import { docsSections } from "./render";

export interface DocsHit {
	page: DocsPage;
	/** The heading's id, "" for the top of the page. */
	sectionId: string;
	heading: string;
	/** The address to go to: the page, and the section's fragment. */
	href: string;
	/** A little of the text around the first word found. */
	snippet: string;
	score: number;
}

interface Entry {
	page: DocsPage;
	id: string;
	heading: string;
	text: string;
	title: string;
	lowerTitle: string;
	lowerHeading: string;
	lowerText: string;
}

let index: Entry[] | null = null;

function entries(): Entry[] {
	if (index) return index;
	index = docsWithSources().flatMap(({ page, source }) =>
		docsSections(source).map((section) => ({
			page,
			id: section.id,
			heading: section.heading,
			text: section.text,
			title: page.title,
			lowerTitle: page.title.toLowerCase(),
			lowerHeading: section.heading.toLowerCase(),
			lowerText: `${section.id === "" ? `${page.description} ` : ""}${section.text}`.toLowerCase(),
		})),
	);
	return index;
}

/** A word's stem, roughly: "protected" finds "protects", "pairing" finds "paired". Options and paths are kept whole. */
function stem(term: string): string {
	if (/[^a-z]/.test(term)) return term;
	const cut = term.replace(/(ing|ed|es|s)$/, "");
	return cut.length >= 4 ? cut : term;
}

export function terms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9_.@/-]+/)
		.map((term) => term.replace(/^[-.]+|[-.]+$/g, ""))
		.filter((term) => term.length > 0)
		.map(stem);
}

function count(haystack: string, needle: string): number {
	let found = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1 && found < 5) {
		found += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return found;
}

function snippet(text: string, words: string[]): string {
	const lower = text.toLowerCase();
	const at = Math.min(...words.map((word) => lower.indexOf(word)).filter((position) => position !== -1));
	if (!Number.isFinite(at)) return text.slice(0, 150) + (text.length > 150 ? "…" : "");
	const start = Math.max(0, at - 50);
	const end = Math.min(text.length, start + 160);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function searchDocs(query: string, limit = 8): DocsHit[] {
	const words = terms(query);
	if (words.length === 0) return [];
	const phrase = query.trim().toLowerCase();
	const hits: DocsHit[] = [];
	for (const entry of entries()) {
		let score = 0;
		let all = true;
		for (const word of words) {
			const inTitle = entry.lowerTitle.includes(word);
			const inHeading = entry.lowerHeading.includes(word);
			const inText = count(entry.lowerText, word);
			if (!inTitle && !inHeading && inText === 0) {
				all = false;
				break;
			}
			score += (inTitle ? 6 : 0) + (inHeading ? 8 : 0) + inText;
		}
		if (!all) continue;
		if (phrase.includes(" ") && (entry.lowerHeading.includes(phrase) || entry.lowerText.includes(phrase))) score += 10;
		// The top of a page only wins for its title; its sections say more.
		if (entry.id === "" && !words.some((word) => entry.lowerTitle.includes(word))) score -= 1;
		hits.push({
			page: entry.page,
			sectionId: entry.id,
			heading: entry.heading,
			href: docsPath(entry.page.slug) + (entry.id ? `#${entry.id}` : ""),
			snippet: snippet(entry.text || entry.page.description, words),
			score,
		});
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
