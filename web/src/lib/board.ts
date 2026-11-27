/**
 * The Factory's board (`/factory`, Board view): every work item as one card in the column of where it
 * really is on its way to its person, read from the summary the feed already carries (its state, the
 * step its run is at, what it waits for, its second review). Nothing here is a state of the server's:
 * the columns are a reading of those fields.
 *
 * A feature is one card: its open subtasks (`ItemFeed.children`) are its parts, and a subtask the list
 * carries because it asks (`listedItems`, "feature — subtask") folds into its feature's card, which then
 * stands under "Needs you". A subtask whose feature is not in the list (filtered out) stands as a card
 * of its own.
 *
 * A card has a kind: "item" today. The person's own agents can join the board later as another kind,
 * read into the same columns (an agent that asks: "Needs you"; one at work: "Building"; one idle: its
 * own lane), without changing the item cards.
 */
import type { ItemSummary } from "@contract";

/** The board's columns, in order. "needs" is the tray above the pipeline; "ended" its narrow last column. */
export const BOARD_COLUMNS = ["needs", "planning", "building", "ci", "review", "ready", "ended"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Each column's name; "review" is the hand-over where the deployment runs no second review. */
export function columnName(column: BoardColumn, reviewer = true): string {
	switch (column) {
		case "needs":
			return "Needs you";
		case "planning":
			return "Planning";
		case "building":
			return "Building";
		case "ci":
			return "CI";
		case "review":
			return reviewer ? "Review" : "Handing over";
		case "ready":
			return "Ready for you";
		case "ended":
			return "Ended";
	}
}

type Columned = Pick<ItemSummary, "state" | "question" | "wait" | "pullRequest" | "review" | "step">;

/**
 * The one column an item stands in. A question puts it under "Needs you" whatever else it is; then its
 * state, and for an item at work the step its run is at (`ItemSummary.step`), or without one what it
 * waits for and whether it has pushed.
 */
export function boardColumn(item: Columned, reviewer = true): BoardColumn {
	if (item.question) return "needs";
	switch (item.state) {
		case "draft":
		case "queued":
			return "planning";
		case "done":
		case "failed":
		case "cancelled":
			return "ended";
		case "review":
			return reviewer && (item.review?.state === "running" || item.review?.state === "waiting") ? "review" : "ready";
		case "working":
		case "waiting":
			break;
	}
	const reason = item.state === "waiting" ? item.wait?.reason : undefined;
	if (reason === "ci" || reason === "integration") return "ci";
	if (reason === "children") return "building";
	switch (item.step?.kind) {
		case "plan_review":
			return "planning";
		case "subtasks":
		case "refine":
		case "implement":
		case "run_checks":
		case "gate":
		case "publish":
		case "conflict":
			return "building";
		case "ci":
		case "ci_fix":
		case "integration":
			return "ci";
		case "review":
		case "review_fix":
			return reviewer ? "review" : "ci";
		case "summary":
		case "handoff":
		case "merged":
			return "review";
		case undefined:
			break;
	}
	if (item.pullRequest) return "ci";
	// Waiting with nothing built yet (a turn, a machine, the provider): it has not started building.
	return item.state === "working" ? "building" : "planning";
}

/** A card on the board. `parts`: a feature's open subtasks, oldest first. */
export interface BoardCard {
	kind: "item";
	item: ItemSummary;
	parts: ItemSummary[];
	column: BoardColumn;
}

/**
 * The board's cards by column. `list` is the Factory's (filtered) list, `children` the feed's open
 * subtasks. Each card stands in exactly one column; "Needs you" the longest asking first, the rest
 * the newest changed first.
 */
export function boardCards(
	list: readonly ItemSummary[],
	children: readonly ItemSummary[] | undefined,
	reviewer = true,
): Record<BoardColumn, BoardCard[]> {
	const top = new Map(list.filter(item => !item.parent).map(item => [item.id, item]));
	const partsOf = new Map<string, ItemSummary[]>();
	const add = (parentId: string, child: ItemSummary) => {
		const parts = partsOf.get(parentId) ?? [];
		if (!parts.some(part => part.id === child.id)) parts.push(child);
		partsOf.set(parentId, parts);
	};
	for (const child of children ?? []) if (child.parent && top.has(child.parent.itemId)) add(child.parent.itemId, child);
	// A subtask the list carries because it asks: its feature's part, under its own title (the list prefixes the feature's).
	const alone: ItemSummary[] = [];
	for (const item of list) {
		if (!item.parent) continue;
		if (!top.has(item.parent.itemId)) {
			alone.push(item);
			continue;
		}
		const prefix = `${item.parent.title} — `;
		const own = { ...item, title: item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title };
		const parts = partsOf.get(item.parent.itemId) ?? [];
		const at = parts.findIndex(part => part.id === item.id);
		if (at >= 0) parts[at] = { ...parts[at]!, question: item.question };
		else add(item.parent.itemId, own);
	}
	const columns = Object.fromEntries(BOARD_COLUMNS.map(column => [column, [] as BoardCard[]])) as Record<
		BoardColumn,
		BoardCard[]
	>;
	for (const item of [...top.values(), ...alone]) {
		const parts = (partsOf.get(item.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
		const column =
			parts.some(part => part.question) &&
			item.state !== "done" &&
			item.state !== "failed" &&
			item.state !== "cancelled"
				? "needs"
				: boardColumn(item, reviewer);
		columns[column].push({ kind: "item", item, parts, column });
	}
	const askedAt = (card: BoardCard) =>
		Math.min(card.item.question?.askedAt ?? Infinity, ...card.parts.map(part => part.question?.askedAt ?? Infinity));
	columns.needs.sort((a, b) => askedAt(a) - askedAt(b));
	for (const column of BOARD_COLUMNS)
		if (column !== "needs") columns[column].sort((a, b) => b.item.updatedAt - a.item.updatedAt);
	return columns;
}

/** The pipeline's columns, after the tray. */
export const PIPELINE_COLUMNS = BOARD_COLUMNS.filter(column => column !== "needs") as Exclude<BoardColumn, "needs">[];

/** The width of a column with nothing in it: a slim strip with its name and "0" standing up. */
export const SLIM_COLUMN = "44px";

/**
 * The pipeline's grid tracks by how many each column holds: an empty column is a slim strip, and the
 * ones with cards share the width ("Ended", narrower).
 */
export function boardTracks(totals: Record<Exclude<BoardColumn, "needs">, number>): string {
	return PIPELINE_COLUMNS.map(column =>
		totals[column] === 0 ? SLIM_COLUMN : column === "ended" ? "minmax(160px, 0.8fr)" : "minmax(188px, 1fr)",
	).join(" ");
}

/** Wider than a phone: the Factory shows the board; a phone has the list. */
export const BOARD_QUERY = "(min-width: 761px)";
