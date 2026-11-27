/**
 * The Agents home's Everything view as one feed: what needs its person, then what is at work, then the
 * rest, each newest first. It mixes the user's own agents and their work items (a feature's subtasks
 * are part of their feature, and a work item's session is part of its item). The repository is a
 * label on each row, not a heading: the rail is where repositories are chosen, and a repository with
 * nothing on it has no place here.
 */
import type { ItemSummary, SessionSummary } from "@contract";
import { ownAgents } from "./repositories";
import { itemStatus, matchesItem, matchesSession, sessionStatus, NO_FILTERS, type Filters } from "./workspace";

export type FeedEntry =
	| { kind: "agent"; session: SessionSummary; at: number }
	| { kind: "item"; item: ItemSummary; at: number };

export interface Feed {
	needs: FeedEntry[];
	working: FeedEntry[];
	recent: FeedEntry[];
}

export interface FeedInput {
	sessions: readonly SessionSummary[] | null;
	items: readonly ItemSummary[] | null;
	filters?: Filters;
	/** "none": only the agents on no repository of the GitHub connection (work items are always on one). */
	scope?: "all" | "none";
}

const newestFirst = (a: FeedEntry, b: FeedEntry) => b.at - a.at;

export function feedOf({ sessions, items, filters = NO_FILTERS, scope = "all" }: FeedInput): Feed {
	const feed: Feed = { needs: [], working: [], recent: [] };
	for (const session of ownAgents(sessions ?? [])) {
		if (scope === "none" && session.repository) continue;
		if (!matchesSession(session, filters)) continue;
		const status = sessionStatus(session);
		const entry: FeedEntry = { kind: "agent", session, at: session.updatedAt };
		(status === "needs" ? feed.needs : status === "running" ? feed.working : feed.recent).push(entry);
	}
	if (scope === "all") {
		for (const item of items ?? []) {
			if (item.parent || !matchesItem(item, filters)) continue;
			const status = itemStatus(item);
			const entry: FeedEntry = {
				kind: "item",
				item,
				at: status === "needs" ? (item.question?.askedAt ?? item.updatedAt) : item.updatedAt,
			};
			// Queued, or waiting on CI or a free turn: still under way.
			const going = status === "running" || (status === null && (item.state === "queued" || item.state === "waiting"));
			(status === "needs" ? feed.needs : going ? feed.working : feed.recent).push(entry);
		}
	}
	feed.needs.sort(newestFirst);
	feed.working.sort(newestFirst);
	feed.recent.sort(newestFirst);
	return feed;
}

export const feedKey = (entry: FeedEntry): string =>
	entry.kind === "agent" ? `a:${entry.session.id}` : `i:${entry.item.id}`;
