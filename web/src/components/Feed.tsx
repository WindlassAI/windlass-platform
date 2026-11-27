/**
 * The Agents home's feed (lib/feed.ts): one row per agent or work item, under "Needs you", "Working
 * now" and "Recent". A row says what it is (its title, "work item" for an item), its agent and model
 * with the agent's logo, one line on where it stands, its repository as a quiet label with its tile,
 * when, and what to do: Answer for an agent that asks, Open for a work item that does (its page holds
 * the question and its context), the pull request once there is one.
 */
import type { GithubId, ItemSummary, SessionSummary } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { HARNESS_NAMES, acpHarnessName, sessionModelWords } from "../lib/acp";
import { ITEM_MODE_WORDS } from "../lib/feature";
import { feedKey, type FeedEntry } from "../lib/feed";
import { absoluteTime, count, plural, relativeTime } from "../lib/format";
import { linkProps, type Route } from "../lib/router";
import { STATE_WORD } from "../lib/items";
import { LongText } from "./Fold";
import { ChevronRightIcon, CrossIcon, Mark, MergedIcon, PullRequestIcon } from "./Icons";
import { RepoTile } from "./RepoTile";
import { AgentGlyph } from "./ui/Pill";

type Tone = "needs" | "working" | "recent";

function Glyph({ tone, failed }: { tone: Tone; failed: boolean }) {
	if (tone === "needs") return <span className="feed-lamp" aria-hidden="true" />;
	if (tone === "working") return <Mark size={16} turning className="status-glyph status-running" />;
	if (failed) return <CrossIcon size={14} className="tone-bad" />;
	return (
		<svg
			width={15}
			height={15}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			className="feed-done"
		>
			<circle cx="8" cy="8" r="6.2" />
			<path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
		</svg>
	);
}

/** What a row shows, worked out once for an agent or an item. */
interface Row {
	key: string;
	route: Route;
	title: string;
	item: boolean;
	harness: string;
	agentWords: string;
	/** A few words on where it stands, on the agent's line. */
	line: ReactNode;
	/** What it asks or reports, which may run long: under the agent's line, clamped to two lines. */
	long: string | null;
	repository: { owner: string; name: string; id: GithubId } | null;
	at: number;
	failed: boolean;
	action: { words: string; route: Route; needs: boolean } | null;
	pull: { number: number; state: "open" | "draft" | "merged" | "closed" | null; title?: string } | null;
}

function agentRow(session: SessionSummary, tone: Tone): Row {
	const place = session.place.kind === "machine" ? "your machine" : "hosted";
	const line =
		tone === "needs"
			? "Asks before it goes on"
			: tone === "working"
				? `${session.status === "starting" ? "Starting" : "Working"} · turn ${Math.max(1, session.turns)}`
				: [place, session.repository?.branch ?? null, session.turns === 0 ? "no turns" : plural(session.turns, "turn")]
						.filter(part => part !== null)
						.join(" · ");
	const pull = session.pullRequest ?? null;
	return {
		key: `a:${session.id}`,
		route: { name: "session", id: session.id },
		title: session.title,
		item: false,
		harness: session.harness ?? "windlass",
		agentWords: `${acpHarnessName(session) ?? "Windlass"} · ${sessionModelWords(session)}`,
		line,
		long: null,
		repository: session.repository
			? { owner: session.repository.owner, name: session.repository.name, id: session.repository.id }
			: null,
		at: session.updatedAt,
		failed: session.lastOutcome === "failed" || session.lastOutcome === "error",
		action: tone === "needs" ? { words: "Answer", route: { name: "session", id: session.id }, needs: true } : null,
		pull: pull ? { number: pull.number, state: pull.state, title: pull.title } : null,
	};
}

function itemRow(item: ItemSummary, tone: Tone, at: number): Row {
	const harness = item.agent?.harness ?? "windlass";
	const model = item.agent?.model;
	const how = ITEM_MODE_WORDS[item.mode ?? "single"].name;
	const line = item.question ? null : `${how} · ${STATE_WORD[item.state]}`;
	return {
		key: `i:${item.id}`,
		route: { name: "item", id: item.id },
		title: item.title,
		item: true,
		harness,
		agentWords: `${HARNESS_NAMES[harness]}${model ? ` · ${model}` : ""}`,
		line,
		long: item.question?.text ?? null,
		repository: { owner: item.repository.owner, name: item.repository.name, id: item.repository.id },
		at,
		failed: item.state === "failed",
		action: tone === "needs" ? { words: "Open", route: { name: "item", id: item.id }, needs: true } : null,
		pull: item.pullRequest ? { number: item.pullRequest.number, state: item.state === "done" ? "merged" : null } : null,
	};
}

function rowOf(entry: FeedEntry, tone: Tone): Row {
	return entry.kind === "agent" ? agentRow(entry.session, tone) : itemRow(entry.item, tone, entry.at);
}

function FeedRow({ row, tone, now }: { row: Row; tone: Tone; now: number }) {
	const repoName = row.repository ? `${row.repository.owner}/${row.repository.name}` : null;
	return (
		<li className={`feed-row feed-row-${tone}`} data-kind={row.item ? "item" : "agent"}>
			<span className="feed-glyph">
				<Glyph tone={tone} failed={row.failed} />
			</span>
			<div className="feed-main">
				<p className="feed-title">
					<a className="feed-link" {...linkProps(row.route)}>
						{row.title}
					</a>
					{row.item ? <span className="feed-tag">work item</span> : null}
				</p>
				<p className={`feed-line${row.line ? "" : " feed-line-agent"}`}>
					<span className="feed-agent">
						<AgentGlyph harness={row.harness} size={11} inline />
						<span className="feed-agent-words">{row.agentWords}</span>
					</span>
					{row.line ? <span className="feed-state">{row.line}</span> : null}
				</p>
				{row.long ? (
					<LongText lines={2} className="feed-long">
						{row.long}
					</LongText>
				) : null}
			</div>
			{row.repository && repoName ? (
				<a className="feed-repo" {...linkProps({ name: "repository", id: row.repository.id })} title={repoName}>
					<RepoTile name={row.repository.name} size="xs" />
					<span className="feed-repo-name">{row.repository.name}</span>
				</a>
			) : (
				<span className="feed-repo feed-repo-none">no repository</span>
			)}
			<time className="feed-time" dateTime={new Date(row.at).toISOString()} title={absoluteTime(row.at)}>
				{relativeTime(row.at, now)}
			</time>
			<span className="feed-act">
				{row.action ? (
					<a
						className={`feed-button${row.action.needs && row.action.words === "Answer" ? " feed-button-needs" : ""}`}
						{...linkProps(row.action.route)}
						aria-label={`${row.action.words}: ${row.title}`}
					>
						{row.action.words}
						<ChevronRightIcon size={12} />
					</a>
				) : row.pull ? (
					<span
						className={`feed-pull${row.pull.state === "merged" ? " feed-pull-merged" : row.pull.state === "open" || row.pull.state === "draft" ? " feed-pull-open" : ""}`}
						title={row.pull.title ?? `Pull request #${row.pull.number}${row.pull.state ? `, ${row.pull.state}` : ""}`}
					>
						{row.pull.state === "merged" ? <MergedIcon size={11} /> : <PullRequestIcon size={11} />}#{row.pull.number}
					</span>
				) : null}
			</span>
		</li>
	);
}

/** One section of the feed, with its heading: nothing when it is empty, unless `always`. */
export function FeedSection({
	title,
	tone,
	entries,
	now,
	limit,
	tools,
	empty,
}: {
	title: string;
	tone: Tone;
	entries: readonly FeedEntry[];
	now: number /** How many show before "Show more". */;
	limit?: number /** At the heading's end: the filter. */;
	tools?: ReactNode /** Said when there is nothing; without it an empty section is left out. */;
	empty?: ReactNode;
}) {
	const heading = useId();
	const [all, setAll] = useState(false);
	if (entries.length === 0 && empty === undefined) return null;
	const shown = limit !== undefined && !all ? entries.slice(0, limit) : entries;
	const hidden = entries.length - shown.length;
	return (
		<section className={`feed feed-${tone}`} aria-labelledby={heading}>
			<div className="feed-head">
				<h2 className="feed-heading" id={heading}>
					{title}
					<span className="feed-count">{count(entries.length)}</span>
				</h2>
				{tools}
			</div>
			{entries.length === 0 ? (
				<p className="feed-empty">{empty}</p>
			) : (
				<ul className="feed-rows" aria-label={title}>
					{shown.map(entry => (
						<FeedRow key={feedKey(entry)} row={rowOf(entry, tone)} tone={tone} now={now} />
					))}
				</ul>
			)}
			{hidden > 0 || (all && limit !== undefined && entries.length > limit) ? (
				<p className="feed-more">
					<button
						type="button"
						className="button button-quiet button-small"
						onClick={() => setAll(!all)}
						aria-expanded={all}
					>
						{all ? "Show fewer" : `Show ${count(hidden)} more`}
					</button>
				</p>
			) : null}
		</section>
	);
}
