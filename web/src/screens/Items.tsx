/**
 * Work items in lists: on a repository's page, its items grouped by where each is, with the way to
 * file a new one; on the home page, the items that ask their person something ("Needs you"); on the
 * Factory page (screens/Factory.tsx), every item, grouped by what its person must do.
 *
 * The list is the user's actor's (`listItems`): read when a screen opens, replaced whenever the actor
 * says an item changed (the user's live feed, `onItems`), and read again when that feed comes back
 * after a drop, since what was said meanwhile is lost. Nothing is asked on a timer. Every sentence a
 * row shows of why an item waits is the server's (`Waiting.sentence`), shown as it was written.
 *
 * Filing one, where the deployment offers machines and the user has one, says where it runs as the
 * start composer of an agent does, with the same cards (components/PlaceChoice.tsx): this platform, or one of the user's
 * machines. On a machine the server gives it that machine's first available sandbox.
 */
import { type GithubId, type StepKind, MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS, type CreateItemInput, type ItemState, type ItemSummary } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hasReason } from "../api/client";
import { Dialog } from "../components/Dialog";
import { PlaceChoice, machineUnusable } from "../components/PlaceChoice";
import { AskIcon, ChevronIcon, CrossIcon, ExternalIcon, Mark, MergedIcon, PullRequestIcon, RingIcon, StopIcon, WarnIcon } from "../components/Icons";
import { absoluteTime, count, plural, relativeTime } from "../lib/format";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { RECOMMENDATION_WORD } from "../components/SecondReview";
import { StatusBadge } from "../components/Status";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { clockTime, useMachines } from "./Machines";
import { hardenedItemNote, machineLabel } from "../lib/machines";
import { ITEM_MODE_WORDS } from "../lib/feature";

export interface ItemsState {
	/** Null until it was read, and when it could not be. */
	list: ItemSummary[] | null;
	/** Why it could not be read the last time it was asked for. */
	error: string | null;
	reload(): void;
}

/**
 * The user's work items: read when the screen opens, then as the user's actor sends them, and again
 * after the live feed was down. `enabled` false asks nothing: for a deployment that offers no work
 * items (`PlatformInfo.items`), and while its information loads.
 */
export function useItems(enabled = true): ItemsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ list: ItemSummary[] | null; error: string | null }>({ list: null, error: null });
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		setState((now) => ({ list: now.list, error: null }));
		client
			.user(auth)
			.listItems()
			.then(
				(list) => mine === asked.current && setState({ list, error: null }),
				(failure: unknown) => mine === asked.current && setState((now) => ({ list: now.list, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: (list) => {
				asked.current += 1;
				setState({ list, error: null });
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
			if (verdict.ci === "not_run") return { word: "Your checks passed; CI did not start", tone: "warn" };
			if (verdict.ci === "unread") return { word: "Your checks passed; CI not read", tone: "warn" };
			if (verdict.ci === "timed_out") return { word: "Your checks passed; CI unfinished", tone: "warn" };
			return { word: "Ready for review", tone: "good" };
		case "fail":
			return { word: "Failing", tone: "bad" };
		case "incomplete":
			return { word: "Incomplete", tone: "warn" };
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
 */
export function ItemStanding({ item, reviewer = true }: { item: Pick<ItemSummary, "review" | "verdict">; reviewer?: boolean }) {
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
	failed: { word: "CI failed", tone: "bad" },
	none: { word: "no CI", tone: "dim" },
	skipped: { word: "CI skipped", tone: "dim" },
	not_run: { word: "CI did not start", tone: "warn" },
	timed_out: { word: "CI unfinished", tone: "warn" },
	not_permitted: { word: "CI not readable", tone: "warn" },
	unread: { word: "CI not read", tone: "warn" },
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
const WAIT_WORD: Record<NonNullable<ItemSummary["wait"]>["reason"], string> = { children: "subtasks", capacity: "for a turn", machine: "for its machine", review_cap: "review cap", ci: "CI", person: "for you", budget: "budget" };

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
		case "implement":
		case "gate":
			return 1;
		case "publish":
		case "conflict":
			return 2;
		case "ci":
		case "ci_fix":
			return 3;
		case "review":
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
				const done = index < track.at - 1 || (index === track.at - 1 && !track.now);
				const now = index === track.at - 1 && track.now;
				return (
					<li key={stage} className={`item-stage${done ? " item-stage-done" : ""}${now ? " item-stage-now" : ""}`} aria-current={now || (track.at === index + 1 && !track.now) ? "step" : undefined}>
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
	if (item.question.kind === "replan_approval") return "A subtask stopped: its revised plan waits for your approval.";
	return item.question.text;
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
export function ItemRow({ item, now, repository = false, why, ci = false, reviewer = true }: { item: ItemSummary; now: number; repository?: boolean; why?: ReactNode; ci?: boolean; reviewer?: boolean }) {
	const asks = item.question !== null;
	const line = why ?? rowWhy(item);
	return (
		<li className={`agent-row item-row item-row-is-${item.state}${asks ? " item-row-asks" : ""}${item.state === "working" ? " agent-row-active" : ""}`}>
			<span className="agent-glyph">
				<ItemGlyph item={item} />
			</span>
			<div className="agent-main">
				<a className="agent-title" {...linkProps({ name: "item", id: item.id })}>
					<RowTitle item={item} />
					{asks ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
				</a>
				{line ? <p className="item-row-why">{line}</p> : null}
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
							<a className="item-pull" href={item.origin.issue.url} target="_blank" rel="noreferrer" aria-label={`Issue #${item.origin.issue.number} on GitHub`}>
								issue #{item.origin.issue.number}
								<ExternalIcon size={10} />
							</a>
						</span>
					) : null}
					{ci && item.origin && !item.origin.issue.trusted ? <span>from an outside author</span> : null}
					{item.source === "api" ? <span>from the API</span> : null}
					{ci && item.verdict ? <span className={`tone-${CI_WORD[item.verdict.ci].tone}`}>{CI_WORD[item.verdict.ci].word}</span> : null}
					{item.state === "draft" ? null : (
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
			<time className="agent-time" dateTime={new Date(item.updatedAt).toISOString()} title={absoluteTime(item.updatedAt)}>
				{relativeTime(item.updatedAt, now)}
			</time>
		</li>
	);
}

// ---- a repository's items -----------------------------------------------------------------------

const SHOWN: ItemState[] = ["draft", "queued", "working", "waiting", "review", "failed"];
const FOLDED: ItemState[] = ["done", "cancelled"];

function Group({ state, items, now }: { state: ItemState; items: ItemSummary[]; now: number }) {
	const heading = useId();
	return (
		<div className="items-group">
			<h3 className="items-group-head" id={heading}>
				{STATE_WORD[state]}
				<span className="items-group-count">{count(items.length)}</span>
			</h3>
			<ul className="agents" aria-labelledby={heading}>
				{items.map((item) => (
					<ItemRow key={item.id} item={item} now={now} />
				))}
			</ul>
		</div>
	);
}

/** The "Work items" section of a repository's page, where the deployment offers them. `launchable`: new work can be filed on it now. */
export function RepositoryItems({ repositoryId, name, base, launchable, now }: { repositoryId: GithubId; name: string; base: string | null; launchable: boolean; now: number }) {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered);
	const [filing, setFiling] = useState(false);
	const [open, setOpen] = useState(false);
	const ended = useId();
	const mine = items.list?.filter((item) => !item.parent && item.repository.id === repositoryId) ?? null;
	const of = (state: ItemState) => mine?.filter((item) => item.state === state) ?? [];
	const folded = FOLDED.flatMap((state) => of(state));
	if (!offered) return null;

	return (
		<section className="usage-section" aria-labelledby="repo-items">
			<h2 className="usage-title" id="repo-items">
				Work items
				{mine && mine.length > 0 ? <span className="usage-count">{mine.length}</span> : null}
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
			) : mine.length === 0 ? (
				<p className="usage-empty">No work item on this repository yet.{launchable ? " File one with New work item." : ""}</p>
			) : (
				<>
					{items.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{items.error} What is shown may be behind.</span>
						</p>
					) : null}
					{SHOWN.map((state) => (of(state).length > 0 ? <Group key={state} state={state} items={of(state)} now={now} /> : null))}
					{folded.length > 0 ? (
						<>
							<p className="agents-fold items-fold">
								<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={ended} onClick={() => setOpen((value) => !value)}>
									<ChevronIcon size={11} className="machine-chevron" />
									{open ? "Hide the ended ones" : `Show ${plural(folded.length, "ended item")}`}
								</button>
								{open ? null : <span>{FOLDED.filter((state) => of(state).length > 0).map((state) => `${of(state).length} ${STATE_WORD[state].toLowerCase()}`).join(", ")}</span>}
							</p>
							<div id={ended} hidden={!open}>
								{FOLDED.map((state) => (of(state).length > 0 ? <Group key={state} state={state} items={of(state)} now={now} /> : null))}
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
	const [placeChoice, setPlace] = useState<string | null>(null);
	// A machine that was removed or can no longer be chosen while the form is open leaves the item on this platform, which the line then says.
	const chosenMachine = mine.find((machine) => machine.machineId === placeChoice && machineUnusable(machine, machinesInfo?.minRunnerVersion ?? "", "item") === null) ?? null;
	const [orchestrate, setOrchestrate] = useState(false);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [criteria, setCriteria] = useState("");
	const [start, setStart] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const last = useRef<Submission | null>(null);
	const ids = { form: useId(), title: useId(), body: useId(), criteria: useId(), criteriaNote: useId(), mode: useId() };
	const acceptance = criteria
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const tooMany = acceptance.length > MAX_ACCEPTANCE_CRITERIA;
	const tooLong = acceptance.some((line) => line.length > MAX_NOTE_CHARS);
	const ready = title.trim() !== "" && !tooMany && !tooLong && body.length <= MAX_ITEM_BODY_CHARS;

	const file = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready || busy) return;
		const input: Omit<CreateItemInput, "idempotencyKey"> = { repository: { id: repositoryId }, title: title.trim(), body: body.trim(), acceptance, start, ...(orchestrate && platform.info?.items?.orchestrate && { mode: "orchestrate" as const }), ...(chosenMachine ? { place: { kind: "machine" as const, machineId: chosenMachine.machineId } } : {}) };
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
					On {name}, as a pull request into {base ?? "its default branch"}.{mine.length > 0 ? null : " It runs on a hosted sandbox."}
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
						<span className="label" id={ids.mode}>
							How it runs
						</span>
						<div className="segmented" role="radiogroup" aria-labelledby={ids.mode}>
							{(["single", "orchestrate"] as const).map((option) => (
								<label key={option} className={`segment${(option === "orchestrate") === orchestrate ? " segment-chosen" : ""}`}>
									<input className="segment-radio" type="radio" name={ids.mode} value={option} checked={(option === "orchestrate") === orchestrate} disabled={busy} onChange={() => setOrchestrate(option === "orchestrate")} />
									{ITEM_MODE_WORDS[option].name}
								</label>
							))}
						</div>
						<p className="field-note">{orchestrate ? `${ITEM_MODE_WORDS.orchestrate.description} Approving the plan needs saved checks and CI that reports on pushes.` : ITEM_MODE_WORDS.single.description}</p>
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
				{mine.length > 0 ? (
					<PlaceChoice machines={mine} chosen={chosenMachine} minRunnerVersion={machinesInfo?.minRunnerVersion ?? ""} now={now} purpose="item" onChoose={setPlace}>
						{chosenMachine ? (
							<p className="field-note place-note">
								It runs without asking on “{machineLabel(chosenMachine)}”, inside its container, and costs no hosted time.{" "}
								{chosenMachine.status === "online" ? "If the machine is away, the item waits until it is back." : `“${machineLabel(chosenMachine)}” is offline since ${clockTime(chosenMachine.since, now)}, so the item waits until it is back.`}
								{hardenedItemNote(chosenMachine)}
							</p>
						) : null}
					</PlaceChoice>
				) : null}
				<label className={`check${start ? " check-on" : ""}`}>
					<input className="check-input" type="checkbox" checked={start} disabled={busy} onChange={(event) => setStart(event.target.checked)} />
					<span className="check-box" aria-hidden="true" />
					<span className="check-text">
						<span className="check-name">Start now</span>
						<span className="check-means">
							{start
								? chosenMachine
									? `It starts as soon as one of your factory turns is free and “${machineLabel(chosenMachine)}” is online; until then it waits, and says for what.`
									: "It starts as soon as one of your factory turns and a sandbox are free; until then it waits, and says for what."
								: "It is kept as a draft until you start it from its page."}
						</span>
					</span>
				</label>
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
