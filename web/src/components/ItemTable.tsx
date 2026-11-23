/**
 * Work items as the Agents home lists them: one dense row each, with a tag for where it stands, its
 * title leading to its page, its agent and its mode or pull request, and an amber Answer where it asks
 * its person something. The full list, grouped, with filing and the ended pages, is the repository's
 * Work items tab (screens/Items.tsx, `RepositoryItems`) and the Factory page.
 */
import type { HarnessId, ItemSummary } from "@contract";
import { HARNESS_NAMES } from "../lib/acp";
import { ITEM_MODE_WORDS } from "../lib/feature";
import { absoluteTime, relativeTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { itemStatus } from "../lib/workspace";
import { STATE_WORD } from "../screens/Items";
import { CheckIcon, MergedIcon, PullRequestIcon } from "./Icons";
import { AgentGlyph } from "./ui/Pill";

/**
 * An agent's mark beside its work. The one place the home draws it, so that the shared logo
 * component replaces the initial here alone.
 */
export function AgentMark({ harness }: { harness: HarnessId }) {
	return (
		<span className="ws-agent-mark" title={HARNESS_NAMES[harness]}>
			<AgentGlyph harness={harness} accent={harness === "windlass"} />
		</span>
	);
}

/** Where an item stands, as a tag: amber where it asks its person, the good hue once done, the bad one when it failed. */
export function ItemStateTag({ item }: { item: Pick<ItemSummary, "state" | "question" | "pullRequest"> }) {
	const status = itemStatus(item);
	const tone = status === "needs" ? "needs" : status === "running" ? "live" : status === "done" ? "good" : status === "failed" ? "bad" : item.state === "draft" || item.state === "cancelled" ? "quiet" : "plain";
	const word = item.question !== null ? "Needs you" : STATE_WORD[item.state];
	return (
		<span className={`ws-tag ws-tag-${tone}`}>
			{item.state === "review" && item.question === null ? <PullRequestIcon size={11} /> : null}
			{item.state === "done" && item.pullRequest ? <MergedIcon size={11} /> : item.state === "done" ? <CheckIcon size={11} /> : null}
			{word}
		</span>
	);
}

export function ItemTable({ items, now, label, repository = false }: { items: readonly ItemSummary[]; now: number; label: string; repository?: boolean }) {
	return (
		<ul className="ws-items" aria-label={label}>
			{items.map((item) => (
				<li key={item.id} className="ws-item" data-state={item.state}>
					<span className="ws-item-state">
						<ItemStateTag item={item} />
					</span>
					<span className="ws-item-main">
						<a className="ws-item-title" {...linkProps({ name: "item", id: item.id })}>
							{item.title}
						</a>
						{repository ? <span className="ws-item-repo">{item.repository.name}</span> : null}
					</span>
					<span className="ws-item-agent">
						<AgentMark harness={item.agent?.harness ?? "windlass"} />
						<span className="ws-item-how">{item.pullRequest ? `PR #${item.pullRequest.number}` : ITEM_MODE_WORDS[item.mode ?? "single"].name}</span>
					</span>
					<span className="ws-item-act">
						{item.question !== null ? (
							<a className="button button-small ws-needs-button" {...linkProps({ name: "item", id: item.id })} aria-label={`Answer: ${item.title}`}>
								Answer
							</a>
						) : null}
					</span>
					<time className="ws-item-time" dateTime={new Date(item.updatedAt).toISOString()} title={absoluteTime(item.updatedAt)}>
						{relativeTime(item.updatedAt, now)}
					</time>
				</li>
			))}
		</ul>
	);
}

/** The items to show first: those that ask, then those at work, then the rest, each newest first. */
export function itemsByUrgency(items: readonly ItemSummary[]): ItemSummary[] {
	const rank = (item: ItemSummary) => {
		const status = itemStatus(item);
		return status === "needs" ? 0 : status === "running" ? 1 : item.state === "queued" || item.state === "waiting" ? 2 : item.state === "review" ? 3 : item.state === "draft" ? 4 : 5;
	};
	return [...items].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}
