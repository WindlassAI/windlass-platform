/**
 * Work items in lists: on a repository's page, its items grouped by where each is, with the way to
 * file a new one; on the home page, the items that ask their person something ("Needs you"); on the
 * Factory page (screens/Factory.tsx), every item, grouped by what its person must do.
 *
 * The list is the user's actor's live feed (`itemFeed`): every open item and the newest filed ended
 * ones, with counts beside them. It is read when a screen opens, replaced whenever the actor says an
 * item changed (`onItems`), and read again when that feed comes back after a drop, since what was said
 * meanwhile is lost. Nothing is asked on a timer. The ended items beyond come from the server a page at
 * a time (`listItems` with a page, `useEndedPages`), on the Factory page and on a repository's. Every sentence a
 * row shows of why an item waits is the server's (`Waiting.sentence`), shown as it was written.
 *
 * Filing one, where the deployment offers machines and the user has one, says where it runs as the
 * start composer of an agent does, with the same cards (components/PlaceChoice.tsx): this platform, or one of the user's
 * machines. On a machine the server gives it that machine's first available sandbox.
 */
import { originIssue } from "../lib/origin";
import { type GithubId, type HarnessId, type StepKind, ITEM_PAGE_DEFAULT, MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS, type CreateItemInput, type ItemCursor, type ItemFeed, type ItemMode, type ItemState, type ItemSummary } from "@contract";
import { savedPlace, resolveDefaultPlace } from "../../../server/src/factory/default-place";
import { byFiling, nextCursor } from "../../../server/src/item-pages";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hasReason } from "../api/client";
import { Dialog } from "../components/Dialog";
import { PlaceChoice, itemAgentLine, itemHarnesses, itemProfilesHere, machineUnusable } from "../components/PlaceChoice";
import { hostedAgentProblem, itemProfiles } from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_NAMES, type ReportedHarness } from "../lib/acp";
import { AskIcon, ChevronIcon, CrossIcon, ExternalIcon, Mark, MergedIcon, PullRequestIcon, RingIcon, StopIcon, WarnIcon } from "../components/Icons";
import { absoluteTime, count, plural, relativeTime } from "../lib/format";
import { feedCounts, type FeedFilters } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { RECOMMENDATION_WORD } from "../components/SecondReview";
import { StatusBadge } from "../components/Status";
import { useApp, useAuth } from "../state/app";
import { useAccount, useHostedProviders, useModels, useNow } from "../state/hooks";
import { useDefaults, useCatalog } from "../components/StartComposer";
import { effortChoices, effortsOf, harnessOptions } from "../lib/models";
import { EffortSelect, ModelSelect, agentDefaultLabel, modelDisplay } from "../components/ModelPicker";
import { clockTime, useMachines } from "./Machines";
import { hardenedItemNote, machineLabel } from "../lib/machines";
import { ItemModeCost, ItemModePicker } from "../components/ItemModePicker";
import { ITEM_MODE_WORDS } from "../lib/feature";
import { Check } from "../components/ui/Check";
import { AgentGlyph } from "../components/ui/Pill";
import { LongText } from "../components/Fold";
import { childrenOf, FactorySubtasks } from "./Subtasks";

export interface ItemsState {
	/** What the feed holds, open items first: every open item and the newest ended ones. Null until it was read, and when it could not be. */
	list: ItemSummary[] | null;
	/** The feed itself, with the counts of every item (`ItemFeed.counts`). Null as `list` is. */
	feed: ItemFeed | null;
	/** Why it could not be read the last time it was asked for. */
	error: string | null;
	reload(): void;
}

const listOf = (feed: ItemFeed): ItemSummary[] => [...feed.open, ...feed.ended];

/**
 * The user's work items: read when the screen opens, then as the user's actor sends them, and again
 * after the live feed was down. `enabled` false asks nothing: for a deployment that offers no work
 * items (`PlatformInfo.items`), and while its information loads.
 */
export function useItems(enabled = true): ItemsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ list: ItemSummary[] | null; feed: ItemFeed | null; error: string | null }>({ list: null, feed: null, error: null });
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		setState((now) => ({ ...now, error: null }));
		client
			.user(auth)
			.itemFeed()
			.then(
				(feed) => mine === asked.current && setState({ list: listOf(feed), feed, error: null }),
				(failure: unknown) => mine === asked.current && setState((now) => ({ ...now, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: (feed) => {
				asked.current += 1;
				setState({ list: listOf(feed), feed, error: null });
			},
			onConnection: (connection) => {
				if (connection !== "connected") return;
				// What the actor sent while the feed was down is lost: the list is read again when it is back.
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, reload, enabled]);

	return { ...state, reload };
}

// ---- the words for an item, shared by its row and its page -------------------------------------

/** The groups of a repository's page, in the plan's words, in the order they stand. */
export const STATE_WORD: Record<ItemState, string> = { draft: "Draft", queued: "Queued", working: "Working", waiting: "Waiting", review: "In review", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/**
 * A verdict in a few words (server/src/factory/verdict.ts, `verdictWords`): a pass with flags needs a look, and a pass whose CI
 * was not read or had not finished says so; neither is "ready".
 */
export function verdictWord(verdict: NonNullable<ItemSummary["verdict"]>): { word: string; tone: "good" | "warn" | "bad" | "dim" } {
	switch (verdict.result) {
		case "pass":
			if (verdict.flags.length > 0) return { word: "Needs a look", tone: "warn" };
			if (CI_WORD[verdict.ci].word === "CI unknown") return { word: "Your checks passed · CI unknown", tone: "dim" };
			return { word: "Ready for review", tone: "good" };
		case "fail":
			return { word: "Failing", tone: "bad" };
		case "incomplete":
			return { word: "Incomplete", tone: "dim" };
		case "unverified":
			return { word: "Not verified", tone: "dim" };
	}
}

export function VerdictWord({ verdict }: { verdict: NonNullable<ItemSummary["verdict"]> }) {
	const { word, tone } = verdictWord(verdict);
	return <span className={`outcome item-verdict tone-${tone}`}>{word}</span>;
}

/**
 * Whether the item is in its review step: the second reviewer runs, or waits to. The platform makes the
 * verdict before the reviewer runs, so one is there already; it is not handed over until the review is
 * filed, and its word is not shown until then.
 */
export function inSecondReview(item: Pick<ItemSummary, "review">): boolean {
	return item.review?.state === "running" || item.review?.state === "waiting";
}

/**
 * Where an item stands beside its row: the verdict's word once it is handed over, with the second
 * reviewer's recommendation; while the reviewer runs or waits to, a quiet working word in its place.
 * A merged item has nothing left to review: its glyph and track say done, and no word stands there.
 */
export function ItemStanding({ item, reviewer = true }: { item: Pick<ItemSummary, "review" | "verdict" | "state">; reviewer?: boolean }) {
	if (item.state === "done") return null;
	if (reviewer && inSecondReview(item)) return <ReviewWord item={item} />;
	return (
		<>
			{item.verdict ? <VerdictWord verdict={item.verdict} /> : null}
			{reviewer ? <ReviewWord item={item} /> : null}
		</>
	);
}

/** CI on the pushed commit, in two or three words: what a row of the Factory page says beside its verdict. */
export const CI_WORD: Record<NonNullable<ItemSummary["verdict"]>["ci"], { word: string; tone: "good" | "warn" | "bad" | "dim" }> = {
	passed: { word: "CI passed", tone: "dim" },
	failed: { word: "CI failed", tone: "warn" },
	none: { word: "no CI", tone: "dim" },
	skipped: { word: "CI skipped", tone: "dim" },
	cancelled: { word: "CI unknown", tone: "dim" },
	not_run: { word: "CI unknown", tone: "dim" },
	timed_out: { word: "CI unknown", tone: "dim" },
	not_permitted: { word: "CI unknown", tone: "dim" },
	unread: { word: "CI unknown", tone: "dim" },
};

/** The second reviewer's recommendation, in a quiet word beside the verdict: the agent's, never the verdict's. While it runs, or waits to, a quiet working word. */
export function ReviewWord({ item }: { item: Pick<ItemSummary, "review"> }) {
	const review = item.review;
	if (review?.state === "running") return <span className="item-row-review">being reviewed</span>;
	if (review?.state === "waiting") return <span className="item-row-review">waiting for its reviewer</span>;
	if (review?.state !== "filed" || !review.recommendation) return null;
	return <span className="item-row-review">reviewed: {RECOMMENDATION_WORD[review.recommendation]}</span>;
}

/** Where an item is, as a glyph: still unless a turn of it runs, and in the calm hue when it asks its person. */
export function ItemGlyph({ item }: { item: Pick<ItemSummary, "state" | "question"> }) {
	switch (item.state) {
		case "working":
			return <Mark size={18} turning className="status-glyph status-running" />;
		case "waiting":
			return item.question ? <AskIcon size={16} className="status-glyph status-waiting" /> : <span className="item-glyph-waiting" aria-hidden="true" />;
		case "queued":
			return <span className="item-glyph-waiting" aria-hidden="true" />;
		case "review":
			return <PullRequestIcon size={16} className="tone-accent" />;
		case "done":
			return <MergedIcon size={16} className="tone-good" />;
		case "failed":
			return <CrossIcon size={16} className="tone-bad" />;
		case "cancelled":
			return <StopIcon size={16} className="tone-faint" />;
		case "draft":
			return <RingIcon size={16} className="status-glyph status-idle" />;
	}
}

/** What a wait is for, in a word or two beside the track. */
const WAIT_WORD: Record<NonNullable<ItemSummary["wait"]>["reason"], string> = { provider: "provider", children: "subtasks", capacity: "for a turn", machine: "machine", ci: "CI", person: "for you", budget: "budget", integration: "testing", sandboxes: "sandbox" };

/**
 * Where an item is on its way to you, as a track of short bars (Helm's steps): built, pushed, CI, the
 * second review (where the deployment runs one), and yours. Read from the summary only: the bar it is
 * at, whether it moves there now, and a word. Null for a draft and for an item that ended without
 * reaching you.
 */
export function itemTrack(item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review">, reviewer = true): { stages: string[]; at: number; now: boolean; word: string; tone: "work" | "wait" | "yours" | "done" } | null {
	const stages = reviewer ? ["built", "pushed", "CI", "review", "yours"] : ["built", "pushed", "CI", "yours"];
	const pushed = item.pullRequest !== null;
	switch (item.state) {
		case "queued":
			return { stages, at: 0, now: false, word: "queued", tone: "wait" };
		case "working":
			return { stages, at: 1, now: true, word: pushed ? "fixing" : "building", tone: "work" };
		case "waiting": {
			const reason = item.wait?.reason;
			if (reason === "ci") return { stages, at: 3, now: true, word: "CI", tone: "work" };
			return { stages, at: pushed ? 2 : 0, now: false, word: reason ? WAIT_WORD[reason] : "waiting", tone: "wait" };
		}
		case "review":
			if (reviewer && inSecondReview(item)) return { stages, at: 4, now: true, word: "review", tone: "work" };
			return { stages, at: stages.length, now: false, word: "yours", tone: "yours" };
		case "done":
			return { stages, at: stages.length, now: false, word: "done", tone: "done" };
		default:
			return null;
	}
}

/** The stage (from 1) a step of the blueprint belongs to: building and the checks, the push, CI and its fixes, the second review, the hand-over. */
function stageOfStep(step: StepKind, stages: number, reviewer: boolean): number {
	switch (step) {
		case "subtasks":
		case "refine":
		case "plan_review":
		case "implement":
		case "run_checks":
		case "gate":
			return 1;
		case "publish":
		case "conflict":
			return 2;
		case "ci":
		case "ci_fix":
		case "integration":
			return 3;
		case "review":
		case "review_fix":
			return reviewer ? 4 : 3;
		case "summary":
		case "handoff":
		case "merged":
			return stages;
	}
}

/** The track beside a row: one bar a stage, the one it is at lit, and its word. Named for assistive technology in one phrase. */
export function ItemTrack({ item, reviewer = true }: { item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review">; reviewer?: boolean }) {
	const track = itemTrack(item, reviewer);
	if (track === null) return <span className="item-track item-track-none" aria-hidden="true" />;
	const label = track.at === 0 ? `Not built yet: ${track.word}` : `${track.stages[Math.min(track.at, track.stages.length) - 1]}, ${Math.min(track.at, track.stages.length)} of ${track.stages.length}: ${track.word}`;
	return (
		<span className={`item-track item-track-${track.tone}`} role="img" aria-label={label} title={track.stages.join(" → ")}>
			<span className="item-track-bars" aria-hidden="true">
				{track.stages.map((stage, index) => (
					<i key={stage} className={index < track.at - 1 || (index === track.at - 1 && !track.now) ? "f" : index === track.at - 1 ? "now" : undefined} />
				))}
			</span>
			<span className="item-track-word" aria-hidden="true">
				{track.word}
			</span>
		</span>
	);
}

/**
 * The item page's stepper: the same stages as a row's track, each named, the one it is at lit (and
 * moving, while a turn or CI runs there). An ordered list, so a screen reader reads where it is.
 */
export function ItemStages({ item, reviewer = true, step = null }: { item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review">; reviewer?: boolean; step?: StepKind | null }) {
	const summary = itemTrack(item, reviewer);
	if (summary === null) return null;
	// The page knows the step the run is at, which the summary does not: a working or waiting item stands at that step's stage.
	const at = step !== null && (item.state === "working" || item.state === "waiting") ? stageOfStep(step, summary.stages.length, reviewer) : null;
	const track = at === null ? summary : { ...summary, at };
	return (
		<ol className={`item-stages item-stages-${track.tone}`} aria-label="Where it is on its way to you">
			{track.stages.map((stage, index) => {
				// The step's own stage is not done while the item works or waits in it (a question while it builds): it is where it stands.
				const standing = at !== null && index === track.at - 1;
				const done = index < track.at - 1 || (index === track.at - 1 && !track.now && !standing);
				const now = index === track.at - 1 && track.now;
				return (
					<li key={stage} className={`item-stage${done ? " item-stage-done" : ""}${now ? " item-stage-now" : standing ? " item-stage-at" : ""}`} aria-current={now || (track.at === index + 1 && !track.now) ? "step" : undefined}>
						<span className="item-stage-bar" aria-hidden="true" />
						<span className="item-stage-name">{stage}</span>
					</li>
				);
			})}
		</ol>
	);
}

/** What an item asks, in a line for a list: a feature's plan question is its whole plan, so the list says only that it waits. */
export function questionLine(item: ItemSummary): string | null {
	if (!item.question) return null;
	if (item.question.kind === "plan_approval") return "Its plan waits for your approval.";
	if (item.question.kind === "replan_approval") return "Its revised plan waits for your approval.";
	// The agent's own question says more than "The agent stopped to ask you…": its first line.
	const asked = item.question.kind === "agent_ask" ? item.question.asked?.text.trim().split("\n")[0] : undefined;
	return asked || item.question.text;
}

/** Why the item is where it is, in a line: the server's sentence while it waits, and what ended it. */
function rowWhy(item: ItemSummary): string | null {
	if (item.question) return questionLine(item);
	if (item.state === "waiting" && item.wait) return item.wait.sentence;
	if (item.state === "draft") return "Not started.";
	if (item.state === "queued") return "Started; waiting for its first turn.";
	return null;
}

/** A row's title: a subtask, listed where it asks its person, says its feature first (the list's title is "feature — subtask"). */
function RowTitle({ item }: { item: ItemSummary }) {
	const prefix = item.parent ? `${item.parent.title} — ` : null;
	if (!prefix || !item.title.startsWith(prefix)) return <>{item.title}</>;
	return (
		<>
			<span className="item-row-feature">{item.parent!.title}</span>
			<span className="item-row-feature-sep" aria-hidden="true">
				/
			</span>
			<span className="visually-hidden">, subtask </span>
			{item.title.slice(prefix.length)}
		</>
	);
}

/**
 * One item as a row of a list. `repository`: the row stands under no repository's name, so it says which.
 * An item filed from a GitHub issue links to it, beside its pull request. `ci` says CI's state beside
 * them, and an issue's outside author; `reviewer` false leaves out the second review's word, for a
 * deployment without one.
 * The item's agent session is part of it and is in no list of agents: the row leads to it, once the
 * item has started, as the place to see what the agent did.
 */
/** "filed 3 Nov" this year, "filed Nov 2025" before it: an ended list is in the order items were filed, and says so. */
export function filedDay(at: number, now: number): string {
	return dayWord("filed", at, now);
}

/** "ended 5 Nov" this year, "ended Nov 2025" before it. */
export function dayWord(word: string, at: number, now: number): string {
	const date = new Date(at);
	const thisYear = date.getFullYear() === new Date(now).getFullYear();
	return `${word} ${date.toLocaleDateString("en-GB", thisYear ? { day: "numeric", month: "short" } : { month: "short", year: "numeric" })}`;
}

/** `filed`: the row says when the item was filed, not when it last changed (an ended list, in filing order). */
/** `subtasks`: the feed's open subtasks; a feature's row counts its own and lists the active ones in place of the wait sentence. */
export function ItemRow({ item, now, repository = false, why, ci = false, reviewer = true, filed = false, subtasks }: { item: ItemSummary; now: number; repository?: boolean; why?: ReactNode; ci?: boolean; reviewer?: boolean; filed?: boolean; subtasks?: readonly ItemSummary[] }) {
	const asks = item.question !== null;
	const line = why ?? rowWhy(item);
	const running = !asks && item.mode === "orchestrate" && subtasks !== undefined && childrenOf(item, subtasks).length > 0;
	return (
		<li className={`agent-row item-row item-row-is-${item.state}${asks ? " item-row-asks" : ""}${item.state === "working" ? " agent-row-active" : ""}${filed ? " item-row-filed" : ""}`}>
			<span className="agent-glyph">
				<ItemGlyph item={item} />
			</span>
			<div className="agent-main">
				<a className="agent-title" {...linkProps({ name: "item", id: item.id })}>
					<RowTitle item={item} />
					{asks ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
				</a>
				{running ? (
					<FactorySubtasks feature={item} children={subtasks!} now={now} />
				) : line ? (
					<LongText lines={2} className="item-row-why">
						{line}
					</LongText>
				) : null}
				<p className="agent-meta">
					{repository ? (
						<span className="agent-repo">
							{item.repository.owner}/{item.repository.name}
						</span>
					) : (
						<span className="agent-repo">into {item.repository.branch}</span>
					)}
					{item.pullRequest ? (
						<span>
							<a className="item-pull" href={item.pullRequest.url} target="_blank" rel="noreferrer">
								#{item.pullRequest.number}
								<ExternalIcon size={10} />
							</a>
						</span>
					) : null}
					{item.origin ? (
						<span>
							<a className="item-pull" href={originIssue(item.origin).url} target="_blank" rel="noreferrer" aria-label={item.origin.issue ? `Issue #${item.origin.issue.number} on GitHub` : `Issue ${item.origin.linear.identifier} on Linear`}>
								{originIssue(item.origin).label}
								<ExternalIcon size={10} />
							</a>
						</span>
					) : null}
					{ci && item.origin && !originIssue(item.origin).trusted ? <span>from an outside author</span> : null}
					{item.source === "api" ? <span>from the API</span> : null}
					{item.agent && item.agent.harness !== "windlass" ? (
						<span>
							<AgentGlyph harness={item.agent.harness} size={11} inline />
							{HARNESS_NAMES[item.agent.harness]}
						</span>
					) : null}
					{ci && item.verdict ? <span className={`tone-${CI_WORD[item.verdict.ci].tone}`}>{CI_WORD[item.verdict.ci].word}</span> : null}
					{item.state === "draft" || item.awaitingPlace ? null : (
						<span>
							<a className="item-pull" {...linkProps({ name: "session", id: item.sessionId })} title="What its agent did, turn by turn" aria-label={`The agent of ${item.title}`}>
								its agent
							</a>
						</span>
					)}
				</p>
			</div>
			<div className="agent-state">
				{asks ? <StatusBadge status="waiting" /> : null}
				<ItemStanding item={item} reviewer={reviewer} />
			</div>
			<ItemTrack item={item} reviewer={reviewer} />
			{filed ? (
				<span className="agent-time item-row-dates">
					<time dateTime={new Date(item.createdAt).toISOString()} title={`Filed ${absoluteTime(item.createdAt)}; last changed ${absoluteTime(item.updatedAt)}`}>
						{filedDay(item.createdAt, now)}
					</time>
					{item.endedAt !== undefined ? (
						<time dateTime={new Date(item.endedAt).toISOString()} title={`Ended ${absoluteTime(item.endedAt)}`}>
							{dayWord("ended", item.endedAt, now)}
						</time>
					) : null}
				</span>
			) : (
				<time className="agent-time" dateTime={new Date(item.updatedAt).toISOString()} title={absoluteTime(item.updatedAt)}>
					{relativeTime(item.updatedAt, now)}
				</time>
			)}
		</li>
	);
}

// ---- the ended items, a page at a time ----------------------------------------------------------

const ENDED_STATES: ReadonlySet<ItemState> = new Set(["done", "failed", "cancelled"]);
/** Whether an item stands on or before the cursor in the list's order (filed no earlier than the cursor's item). */
const onOrBefore = (item: ItemSummary, cursor: ItemCursor) => byFiling(item, cursor) <= 0;

export interface EndedPages {
	/** The ended items shown, newest filed first: the pages read, as the live feed has them now. */
	items: ItemSummary[];
	/** Whether the server has more after them. */
	more: boolean;
	loading: boolean;
	error: string | null;
	/** Reads the next page; the first again, when it could not be read. */
	loadMore(): void;
}

/**
 * The ended rows: the pages read, held against the live feed (`live`, under the same filters). A row
 * the feed has shows the item as the feed has it now, and leaves once it is no longer ended; one the
 * feed does not carry (it carries only the newest ended ones) shows as it was read. One that ended
 * since and is filed among those shown joins them (anywhere, once `cursor` is null: the last page is in).
 */
export function mergeEnded(read: readonly ItemSummary[], live: readonly ItemSummary[] | null, cursor: ItemCursor | null): ItemSummary[] {
	const current = new Map((live ?? []).map((item) => [item.id, item]));
	const rows = new Map<string, ItemSummary>();
	for (const item of read) {
		const now = current.get(item.id) ?? item;
		if (ENDED_STATES.has(now.state)) rows.set(item.id, now);
	}
	// Ended since, and filed among the rows shown (or anywhere, once the last page is read).
	for (const item of live ?? []) if (ENDED_STATES.has(item.state) && !rows.has(item.id) && (cursor === null || onOrBefore(item, cursor))) rows.set(item.id, item);
	return [...rows.values()].sort(byFiling);
}

/** The ended items, read from the server a page at a time once `open`, under the filters; other filters start again from the first page. */
export function useEndedPages(open: boolean, filters: FeedFilters, live: readonly ItemSummary[] | null): EndedPages {
	const { client, explain } = useApp();
	const auth = useAuth();
	const key = `${filters.repository ?? ""}|${filters.from ?? ""}`;
	const [state, setState] = useState<{ key: string; read: ItemSummary[]; cursor: ItemCursor | null; started: boolean; loading: boolean; error: string | null }>({ key, read: [], cursor: null, started: false, loading: false, error: null });
	const asked = useRef(0);
	const mine = state.key === key ? state : { key, read: [], cursor: null, started: false, loading: false, error: null };

	const read = useCallback(
		(from: ItemCursor | null, before: ItemSummary[]) => {
			const ask = ++asked.current;
			setState({ key, read: before, cursor: from, started: true, loading: true, error: null });
			client
				.user(auth)
				.listItems({ ended: true, before: from, limit: ITEM_PAGE_DEFAULT, repository: filters.repository ?? null, source: filters.from ?? null })
				.then(
					(page) => ask === asked.current && setState({ key, read: [...before, ...page], cursor: nextCursor(page, ITEM_PAGE_DEFAULT), started: true, loading: false, error: null }),
					(failure: unknown) => ask === asked.current && setState({ key, read: before, cursor: from, started: true, loading: false, error: explain(failure) }),
				);
		},
		[client, auth, explain, key, filters.repository, filters.from],
	);

	// The first page, when the ended ones are unfolded, and again under other filters.
	useEffect(() => {
		if (open && !mine.started) read(null, []);
	}, [open, mine.started, read]);
	useEffect(
		() => () => {
			asked.current += 1;
		},
		[],
	);

	// Nothing is shown before the first page is in: the feed alone would draw only the newest ended items.
	const loaded = mine.started && !(mine.read.length === 0 && (mine.loading || mine.error !== null));
	return {
		items: loaded ? mergeEnded(mine.read, live, mine.cursor) : [],
		more: loaded && mine.cursor !== null,
		loading: mine.loading,
		error: mine.error,
		loadMore: () => {
			if (mine.loading) return;
			if (mine.error !== null && mine.read.length === 0) read(null, []);
			else if (mine.cursor !== null) read(mine.cursor, mine.read);
		},
	};
}

/** Under the ended rows: the way to the next page, or what is in the way of it. */
export function EndedFoot({ pages }: { pages: EndedPages }) {
	if (pages.loading) {
		return (
			<p className="agents-fold items-fold factory-more" aria-busy="true" role="status">
				{pages.items.length === 0 ? "Reading the ended items…" : "Reading more…"}
			</p>
		);
	}
	if (pages.error !== null) {
		return (
			<p className="agents-fold items-fold factory-more tone-bad" role="alert">
				{pages.error}{" "}
				<button type="button" className="link" onClick={pages.loadMore}>
					Try again
				</button>
			</p>
		);
	}
	if (!pages.more) return null;
	return (
		<p className="agents-fold items-fold factory-more">
			<button type="button" className="link machine-toggle" onClick={pages.loadMore}>
				<ChevronIcon size={11} className="machine-chevron" />
				Show {ITEM_PAGE_DEFAULT} more
			</button>
		</p>
	);
}

/** "25 done, 2 failed, 3 cancelled": what a fold of ended items holds, from the feed's counts. */
export function endedWords(counts: { done: number; failed: number; cancelled: number }): string {
	return (["done", "failed", "cancelled"] as const)
		.filter((state) => counts[state] > 0)
		.map((state) => `${counts[state]} ${state}`)
		.join(", ");
}

// ---- a repository's items -----------------------------------------------------------------------

const SHOWN: ItemState[] = ["draft", "queued", "working", "waiting", "review"];

function Group({ name, items, now, count: said, filed = false, children }: { name: string; items: ItemSummary[]; now: number; count?: string; filed?: boolean; children?: ReactNode }) {
	const heading = useId();
	return (
		<div className="items-group">
			<h3 className="items-group-head" id={heading}>
				{name}
				<span className="items-group-count">{said ?? count(items.length)}</span>
			</h3>
			<ul className="agents" aria-labelledby={heading}>
				{items.map((item) => (
					<ItemRow key={item.id} item={item} now={now} filed={filed} />
				))}
			</ul>
			{children}
		</div>
	);
}

/**
 * The "Work items" section of a repository's page, where the deployment offers them. `launchable`: new
 * work can be filed on it now. The open items come from the live feed; the ended ones are folded, said
 * by the feed's counts, and read from the server a page at a time once unfolded, newest filed first.
 */
export function RepositoryItems({ repositoryId, name, base, launchable, now, filter }: { repositoryId: GithubId; name: string; base: string | null; launchable: boolean; now: number; filter?: (item: ItemSummary) => boolean }) {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered);
	const [filing, setFiling] = useState(false);
	const [open, setOpen] = useState(false);
	const ended = useId();
	// `filter`: the Agents home's filters, which narrow the open items and the ended ones read so far; the counts stay the feed's.
	const onIt = (item: ItemSummary) => !item.parent && String(item.repository.id) === String(repositoryId);
	const shown = (item: ItemSummary) => filter?.(item) ?? true;
	const live = items.list?.filter(onIt) ?? null;
	const mine = items.feed?.open.filter((item) => onIt(item) && shown(item)) ?? null;
	const counts = feedCounts(items.feed, { repository: repositoryId });
	const pages = useEndedPages(open, { repository: repositoryId }, live);
	const of = (state: ItemState) => mine?.filter((item) => item.state === state) ?? [];
	const total = mine === null ? null : mine.length + counts.ended;
	if (!offered) return null;

	return (
		<section className="usage-section" aria-labelledby="repo-items">
			<h2 className="usage-title" id="repo-items">
				Work items
				{total !== null && total > 0 ? <span className="usage-count">{total}</span> : null}
				<button type="button" className="link secret-add" onClick={() => setFiling(true)} disabled={!launchable} title={launchable ? undefined : "No work can be filed on this repository now"}>
					New work item…
				</button>
			</h2>
			<p className="usage-lede">An agent works on each by itself. CI on its pull request decides whether the work passes; your checks for the repository, where you set them, run first and send the agent back when one fails. It is handed to you as a pull request with what the verdict rests on. Merging it is yours.</p>
			{mine === null ? (
				items.error ? (
					<div className="state state-error" role="alert">
						<WarnIcon size={22} />
						<h2>The work items could not be loaded</h2>
						<p>{items.error}</p>
						<button type="button" className="button button-outline" onClick={items.reload}>
							Try again
						</button>
					</div>
				) : (
					<div className="usage-loading" aria-busy="true" aria-label="Loading the work items">
						<span className="skeleton skeleton-title" style={{ width: "34%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
					</div>
				)
			) : total === 0 ? (
				<p className="usage-empty">No work item on this repository yet.{launchable ? " File one with New work item." : ""}</p>
			) : (
				<>
					{items.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{items.error} What is shown may be behind.</span>
						</p>
					) : null}
					{SHOWN.map((state) => (of(state).length > 0 ? <Group key={state} name={STATE_WORD[state]} items={of(state)} now={now} /> : null))}
					{counts.ended > 0 ? (
						<>
							<p className="agents-fold items-fold">
								<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={ended} onClick={() => setOpen((value) => !value)}>
									<ChevronIcon size={11} className="machine-chevron" />
									{open ? "Hide the ended ones" : `Show ${plural(counts.ended, "ended item")}`}
								</button>
								{open ? null : <span>{endedWords(counts)}</span>}
							</p>
							<div id={ended} hidden={!open}>
								{open ? (
									<Group name="Ended" items={filter ? pages.items.filter(shown) : pages.items} now={now} filed count={pages.items.length < counts.ended ? `${count(pages.items.length)} of ${count(counts.ended)}` : undefined}>
										<EndedFoot pages={pages} />
									</Group>
								) : null}
							</div>
						</>
					) : null}
				</>
			)}
			{filing ? <NewItemDialog repositoryId={repositoryId} name={name} base={base} onClose={() => setFiling(false)} /> : null}
		</section>
	);
}

/** The refusals of a machine that the list of machines may be behind on: it is read again. */
const MACHINE_REFUSALS = ["machine_not_found", "machine_not_connected", "runner_outdated", "bad_profile"];

/** Filing a work item: what to do, and what a person will check. It runs on a hosted sandbox, or on one of the user's machines where they have one. */
export function NewItemDialog({ repositoryId, name, base, onClose }: { repositoryId: GithubId; name: string; base: string | null; onClose(): void }) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	// Where it runs: offered where the deployment has both work items and machines, and the user has a machine.
	const machinesInfo = platform.info?.items ? (platform.info.machines ?? null) : null;
	const machines = useMachines(machinesInfo !== null);
	const now = useNow(30_000);
	const mine = machinesInfo === null ? [] : (machines.list ?? []);
	const [placeChoice, setPlace] = useState<string | null>();
	const saved = useDefaults(repositoryId);
	const account = useAccount();
	const policy = placeChoice === undefined ? savedPlace(saved.defaults, account.settings?.defaults) : undefined;
	const [modeChoice, setMode] = useState<ItemMode>("orchestrate");
	const [agentChoice, setAgent] = useState<HarnessId | null>(null);
	const usePolicy = !!policy && agentChoice === null;
	const destination = policy && resolveDefaultPlace(policy, mine, usePolicy && platform.info?.items?.orchestrate ? modeChoice : "single");
	const machineId = placeChoice ?? (destination?.place.kind === "machine" ? destination.place.machineId : null);
	// A machine that was removed or can no longer be chosen while the form is open leaves the item on this platform, which the line then says.
	const chosenMachine = mine.find((machine) => machine.machineId === machineId && machineUnusable(machine, machinesInfo?.minRunnerVersion ?? "", "item") === null) ?? null;
	// The builder's agent: Windlass, or one the chosen machine reports signed in, in its default item profile (Codex: Docker + Windlass
	// sandbox, the others their hardened container). The start composer picks another profile.
	function fitsDestination(offered: ReportedHarness) {
		const profiles = itemProfilesHere(chosenMachine, offered.id);
		if (destination?.harness === offered.id && destination.profile) return profiles.includes(destination.profile);
		return profiles[0] === itemProfiles(offered.id)[0];
	}
	const keys = useHostedProviders();
	const hostedProfile = platform.info?.profiles.find(p => p.available && p.platformKeys);
	const agents = chosenMachine
		? itemHarnesses(chosenMachine).filter(fitsDestination).map(({ id }) => ({ id, reason: null }))
		: (["claude", "codex", "opencode"] as const).map(id => ({ id, reason: hostedAgentProblem(id, keys, !!hostedProfile) }));
	const preferredAgent = agentChoice ?? destination?.harness ?? "windlass";
	const agent: HarnessId = agents.some(offered => offered.id === preferredAgent && !offered.reason) ? preferredAgent : "windlass";
	// Plan first is Windlass's: its planner files the plan with a tool only Windlass has.
	const mode: ItemMode = agent === "windlass" || usePolicy ? modeChoice : "single";
	// The model and effort: the account's models for Windlass, what the machine reported for another agent. "" is the agent's default.
	const accountModels = useModels();
	const modelAgent = mode === "orchestrate" && platform.info?.items?.orchestrate ? "windlass" : agent;
	const catalog = useCatalog(modelAgent === "windlass" ? null : chosenMachine, modelAgent === "windlass" ? "claude" : modelAgent);
	const modelList = modelAgent === "windlass" ? accountModels.list : harnessOptions(chosenMachine, modelAgent, catalog.options, keys).models;
	const [modelChoice, setModel] = useState("");
	const [effortChoice, setEffort] = useState("");
	const model = modelList?.models.some((one) => one.id === modelChoice) ? modelChoice : "";
	const efforts = effortChoices(effortsOf(modelList, model || (modelList?.defaultModel ?? ""))).filter((level) => level !== "" && level !== "default");
	const effort = efforts.includes(effortChoice) ? effortChoice : "";
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [criteria, setCriteria] = useState("");
	const [start, setStart] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const last = useRef<Submission | null>(null);
	const ids = { form: useId(), title: useId(), body: useId(), criteria: useId(), criteriaNote: useId(), model: useId(), effort: useId(), effortNote: useId() };
	const acceptance = criteria
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const tooMany = acceptance.length > MAX_ACCEPTANCE_CRITERIA;
	const tooLong = acceptance.some((line) => line.length > MAX_NOTE_CHARS);
	const defaultsLoading = saved.reading || (account.reading && !account.settings);
	const machinesLoading = policy && machinesInfo && !machines.list && !machines.error;
	const ready = !defaultsLoading && !machinesLoading && title.trim() !== "" && !tooMany && !tooLong && body.length <= MAX_ITEM_BODY_CHARS;

	const file = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready || busy) return;
		const input: Omit<CreateItemInput, "idempotencyKey"> = { repository: { id: repositoryId }, title: title.trim(), body: body.trim(), acceptance, start, mode: platform.info?.items?.orchestrate ? mode : "single", ...(usePolicy ? { useDefaultPlace: true } : chosenMachine ? { place: { kind: "machine" as const, machineId: chosenMachine.machineId } } : {}), ...(!usePolicy && agent !== "windlass" ? { harness: agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
		// Every attempt of the same form is one submission: a call that was answered late is not taken twice.
		const submission = submissionOf(JSON.stringify(input), last.current);
		last.current = submission;
		setBusy(true);
		setError(null);
		try {
			const item = await client.user(auth).createItem({ ...input, idempotencyKey: submission.idempotencyKey });
			last.current = null;
			onClose();
			navigate({ name: "item", id: item.id });
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
			if (MACHINE_REFUSALS.some((reason) => hasReason(failure, reason))) machines.reload();
		}
	};

	return (
		<Dialog
			title="New work item"
			lede={
				<>
					On {name}, as a pull request into {base ?? "its default branch"}.{destination?.note ? " " + destination.note : mine.length > 0 ? null : " It runs on a hosted sandbox."}
				</>
			}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={!ready || busy}>
						{busy ? "Filing…" : start ? "File and start" : "File as a draft"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={file}>
				{platform.info?.items?.orchestrate ? (
					<div>
						<span className="label">
							How it runs
						</span>
						<ItemModePicker costId={ids.form + "-cost"} value={mode} onChange={setMode} disabled={busy || (!usePolicy && agent !== "windlass")} />
						<ItemModeCost id={ids.form + "-cost"} mode={mode} />
						<p className="field-note">{ITEM_MODE_WORDS[mode].description}</p>
					</div>
				) : null}
				<div>
					<label className="label" htmlFor={ids.title}>
						Title
					</label>
					<input id={ids.title} className="input" value={title} maxLength={MAX_TITLE_CHARS} onChange={(event) => setTitle(event.target.value)} readOnly={busy} data-autofocus />
				</div>
				<div>
					<label className="label" htmlFor={ids.body}>
						What to do
					</label>
					<textarea id={ids.body} className="input textarea item-body" value={body} maxLength={MAX_ITEM_BODY_CHARS} onChange={(event) => setBody(event.target.value)} readOnly={busy} />
					<p className="field-note">The agent is given this and the title as your own words.</p>
				</div>
				<div>
					<label className="label" htmlFor={ids.criteria}>
						Acceptance criteria<span className="label-optional">optional</span>
					</label>
					<textarea id={ids.criteria} className={`input textarea item-criteria${tooMany || tooLong ? " input-invalid" : ""}`} value={criteria} onChange={(event) => setCriteria(event.target.value)} readOnly={busy} aria-describedby={ids.criteriaNote} aria-invalid={tooMany || tooLong || undefined} />
					<p className={`field-note${tooMany || tooLong ? " tone-bad" : ""}`} id={ids.criteriaNote}>
						{tooMany
							? `At most ${MAX_ACCEPTANCE_CRITERIA}; there are ${acceptance.length}.`
							: tooLong
								? `Each is at most ${count(MAX_NOTE_CHARS)} characters.`
								: "One per line. The agent is given them, and the verdict lists them for you to check: no machine checks them."}
					</p>
				</div>
				{mine.length > 0 || agents.length > 0 ? (
					<PlaceChoice machines={mine} chosen={chosenMachine} minRunnerVersion={machinesInfo?.minRunnerVersion ?? ""} now={now} purpose="item" onChoose={setPlace}>
						{chosenMachine ? (
							<p className="field-note place-note">
								It runs without asking on “{machineLabel(chosenMachine)}”, inside its container, and costs no hosted time.{" "}
								{chosenMachine.status === "online" ? "If the machine is away, the item waits until it is back." : `“${machineLabel(chosenMachine)}” is offline since ${clockTime(chosenMachine.since, now)}, so the item waits until it is back.`}
								{hardenedItemNote(chosenMachine)}
							</p>
						) : null}
						{agents.length > 0 ? (
							<div className="harness-pick">
								<span className="label">Agent</span>
								<div className="segmented" role="radiogroup" aria-label="Agent">
									{[{ id: "windlass" as const, reason: null }, ...agents].map(({ id, reason }) => (
										<label key={id} title={reason ?? undefined} className={`segment${id === agent ? " segment-chosen" : ""}`}>
											<input className="segment-radio" type="radio" name={ids.form + "-agent"} value={id} checked={id === agent} disabled={busy || !!reason} onChange={() => setAgent(id)} />
											{HARNESS_NAMES[id]}
										</label>
									))}
								</div>
								<p className="field-note">
									{agent === "windlass"
										? "Windlass runs your repository's checks before it hands the work over."
										: chosenMachine ? itemAgentLine(agent, itemProfiles(agent)[0] ?? "docker-hardened") : `${HARNESS_NAMES[agent]} runs with your Settings key.`}
								</p>
							</div>
						) : null}
					</PlaceChoice>
				) : null}
				{modelList && modelList.models.length > 0 ? (
					<div className="item-agent-fields">
						<div>
							<label className="label" htmlFor={ids.model}>
								Model
							</label>
							<ModelSelect
								id={ids.model}
								harness={modelAgent}
								list={modelList}
								value={model}
								inherit={{ label: agentDefaultLabel(modelAgent, modelList) }}
								entry={chosenMachine?.harnesses?.find((one) => one.id === modelAgent) ?? null}
								machine={chosenMachine ? machineLabel(chosenMachine) : null}
								onChange={setModel}
								disabled={busy}
							/>
						</div>
						{efforts.length > 0 ? (
							<div>
								<label className="label" htmlFor={ids.effort}>
									Effort
								</label>
								<EffortSelect id={ids.effort} efforts={efforts} value={effort} model={modelDisplay(modelAgent, modelList, model || modelList.defaultModel)} onChange={setEffort} disabled={busy} />
							</div>
						) : null}
						<p className="field-note" id={ids.effortNote}>
							{efforts.length > 0 ? "Every turn of the item runs at this effort." : "This model takes no reasoning effort."}
						</p>
					</div>
				) : null}
				<Check checked={start} disabled={busy} onChange={(on) => setStart(on)}>
					<span className="check-name">Start now</span>
					<span className="check-means">
						{start
							? chosenMachine
								? `It starts as soon as “${machineLabel(chosenMachine)}” is online and has a free slot; until then it waits, and says for what.`
								: "It starts as soon as one of your hosted sandboxes is free; until then it waits, and says for what."
							: "It is kept as a draft until you start it from its page."}
					</span>
				</Check>
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span>{error}</span>
					</p>
				) : null}
			</form>
		</Dialog>
	);
}

// ---- what asks its person ---------------------------------------------------------------------

/** The items that ask their person something, across repositories, the longest waiting first. */
export function asking(list: readonly ItemSummary[]): ItemSummary[] {
	return list.filter((item) => item.question !== null).sort((a, b) => (a.question?.askedAt ?? 0) - (b.question?.askedAt ?? 0));
}
