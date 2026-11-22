/**
 * "From GitHub" on an item's page (G4): the reviews and comments on the item's pull request that the
 * platform collected, batch by batch, and what became of each batch: waiting, held, asking you, taken
 * into a run, or not taken and why (the server's reason, `FeedbackBatch.reason`). Feedback from people
 * without write access is never stored, so it shows only as a count.
 *
 * Bodies and paths came from GitHub and are shown through `ReviewText` alone, as plain text. The only
 * links are each entry's own address on GitHub, kept only when it is an https address.
 */
import type { FeedbackBatch, FeedbackEntry, ItemView } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { plural } from "../lib/format";
import { ChevronIcon, ExternalIcon } from "./Icons";
import { ReviewText } from "./ReviewBlocks";

/** The batch's state as one word: the reason after it says the rest. */
const STATE_WORD: Record<FeedbackBatch["state"], string> = { pending: "Waiting", held: "Held", question: "Needs you", taken: "Taken", declined: "Not taken" };

const KIND_WORD: Record<FeedbackEntry["kind"], string> = { changes_requested: "Changes requested", commented: "Review", issue_comment: "Comment", review_comment: "Line comment" };

/** Open batches first, then the rest, newest first. */
const OPEN = new Set<FeedbackBatch["state"]>(["question", "pending", "held"]);

/** How many settled batches show before the fold. */
const SHOWN = 2;

/** A body longer than this shows its start, with a button for the rest. */
const LONG = 700;

const githubUrl = (url: string) => (/^https:\/\/[^\s/]+\//.test(url) ? url : null);

function Body({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	if (!text.trim()) return <p className="gh-empty">No text.</p>;
	const long = text.length > LONG;
	return (
		<>
			<ReviewText text={long && !open ? text.slice(0, LONG - 100).trimEnd() + "…" : text} />
			{long ? (
				<button type="button" className="link gh-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					{open ? "Show less" : "Show all of it"}
				</button>
			) : null}
		</>
	);
}

function Entry({ entry, head, when }: { entry: FeedbackEntry; head: string | null; when(at: number): ReactNode }) {
	const url = githubUrl(entry.url);
	const earlier = entry.commit !== null && head !== null && entry.commit !== head;
	const commit = entry.commit ? (earlier ? `on an earlier commit, ${entry.commit.slice(0, 7)}` : `at ${entry.commit.slice(0, 7)}`) : null;
	return (
		<li className="gh-entry">
			<p className="gh-entry-head">
				<span className="gh-who">@{entry.author}</span>
				<span className="agent-meta gh-meta">
					<span>{entry.access === "owner" ? "you" : "write access"}</span>
					<span>{KIND_WORD[entry.kind]}</span>
					{entry.commit && !entry.path ? <span>{commit}</span> : null}
					<span>{when(entry.at)}</span>
				</span>
				{url ? (
					<a className="gh-open" href={url} target="_blank" rel="noreferrer noopener" aria-label={`Open @${entry.author}'s ${KIND_WORD[entry.kind].toLowerCase()} on GitHub`}>
						On GitHub
						<ExternalIcon size={11} />
					</a>
				) : null}
			</p>
			{entry.path ? (
				<p className="gh-where">
					<code className="gh-path">
						{entry.path}
						{entry.line ? <span className="gh-line">:{entry.line}</span> : null}
					</code>
					{commit ? <span className="gh-commit">{commit}</span> : null}
				</p>
			) : null}
			<div className="gh-quote">
				<Body text={entry.body} />
			</div>
		</li>
	);
}

function Batch({ view, batch, when }: { view: ItemView; batch: FeedbackBatch; when(at: number): ReactNode }) {
	const [planOpen, setPlanOpen] = useState(false);
	const planId = useId();
	const current = batch.plan !== null && view.plan?.version === batch.plan;
	const saved = batch.plan !== null && !current ? batch.savedPlan : undefined;
	return (
		<li className="gh-batch" data-state={batch.state}>
			<p className="gh-batch-head">
				<span className="gh-state">{STATE_WORD[batch.state]}</span>
				<span className="gh-reason">{batch.state === "question" ? "Answer it above, under It asks you." : batch.reason}</span>
				{current ? (
					<a className="link gh-plan-link" href={`#feature-plan-${batch.plan}`}>
						See plan {batch.plan}
					</a>
				) : saved ? (
					<button type="button" className="link gh-plan-link" aria-expanded={planOpen} aria-controls={planId} onClick={() => setPlanOpen((value) => !value)}>
						{planOpen ? `Hide plan ${batch.plan}` : `Show plan ${batch.plan}`}
					</button>
				) : null}
			</p>
			{saved ? (
				<div id={planId} className="gh-plan" hidden={!planOpen}>
					<ReviewText text={[saved.goal, ...saved.subtasks.map((title) => "- " + title)].join("\n")} />
				</div>
			) : null}
			<ul className="gh-entries" aria-label={plural(batch.entries.length, "entry", "entries")}>
				{batch.entries.map((entry) => (
					<Entry key={entry.id} entry={entry} head={view.head} when={when} />
				))}
			</ul>
		</li>
	);
}

/** The section, when the item has feedback to speak of; nothing otherwise. */
export function GithubFeedback({ view, when }: { view: ItemView; when(at: number): ReactNode }) {
	const [open, setOpen] = useState(false);
	const folded = useId();
	const feedback = view.feedback;
	if (!feedback || (!feedback.batches.length && !feedback.notTaken)) return null;
	const latest = (batch: FeedbackBatch) => Math.max(...batch.entries.map((entry) => entry.at));
	const batches = feedback.batches.filter((batch) => batch.entries.length > 0);
	const active = batches.filter((batch) => OPEN.has(batch.state)).sort((a, b) => latest(b) - latest(a));
	const settled = batches.filter((batch) => !OPEN.has(batch.state)).sort((a, b) => latest(b) - latest(a));
	const shown = [...active, ...settled.slice(0, SHOWN)];
	const rest = settled.slice(SHOWN);
	const pr = view.pullRequest ? `pull request #${view.pullRequest.number}` : "the pull request";
	return (
		<section className="usage-section item-github" aria-labelledby="github-feedback-title">
			<h2 className="usage-title" id="github-feedback-title">
				From GitHub
			</h2>
			<p className="usage-lede">
				Reviews and comments on {pr} from you and from people with write access, quoted as they wrote them. A taken batch starts a new run; the agent reads others' words as review, not as your instructions.
			</p>
			{shown.length > 0 ? (
				<ol className="gh-batches">
					{shown.map((batch) => (
						<Batch key={batch.state + ":" + batch.entries[0]!.id} view={view} batch={batch} when={when} />
					))}
				</ol>
			) : null}
			{rest.length > 0 ? (
				<>
					<p className="agents-fold items-fold">
						<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={folded} onClick={() => setOpen((value) => !value)}>
							<ChevronIcon size={11} className="machine-chevron" />
							{open ? "Hide the earlier batches" : `Show ${plural(rest.length, "earlier batch", "earlier batches")}`}
						</button>
					</p>
					<ol className="gh-batches" id={folded} hidden={!open}>
						{rest.map((batch) => (
							<Batch key={batch.state + ":" + batch.entries[0]!.id} view={view} batch={batch} when={when} />
						))}
					</ol>
				</>
			) : null}
			{feedback.notTaken > 0 ? (
				<p className="gh-batch-head gh-counted" data-state="counted">
					<span className="gh-state">Counted only</span>
					<span className="gh-reason">
						{plural(feedback.notTaken, "review or comment", "reviews or comments")} from people without write access. Not shown here, not sent to the agent, and not answered on GitHub.
					</span>
				</p>
			) : null}
		</section>
	);
}
