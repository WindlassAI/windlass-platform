/**
 * The second review on an item's page (Reviewer slice R3): what a second agent, in its own sandbox and
 * with no part in making the change, wrote about the pushed commit (contract.ts, `ItemReview`). It
 * stands in a section of its own, under the platform's verdict and above the builder's report, and is
 * labelled as the agent's throughout: its recommendation is a quiet word, never the verdict's pill, and
 * the verdict never rests on it. In R3 a recommendation does nothing by itself: every one hands over.
 *
 * The section says where the review is while there is none to show (`ItemSummary.review.state`): it
 * waits, a second agent reads the change, it was cut off and is tried again, or there was none and why
 * (the server's reason, as the log has it). The reviewer's text goes through `ReviewText` alone, as the
 * builder's does; the only links in its blocks are the places in the code, built by the platform from
 * the repository, the reviewed commit and a path the contract allows (`blobLink`).
 */
import type { ItemAttachment, ItemReview, ItemSummary, ItemView, ReviewBlock, ReviewLocation, ReviewRecommendation, Verdict } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { linkProps } from "../lib/router";
import { plural } from "../lib/format";
import { ChevronIcon } from "./Icons";
import { Block, blobLink, ReviewText, type LinkTo } from "./ReviewBlocks";
import { Screenshots, type ScreenshotLinks } from "./Screenshots";

export type ReviewState = NonNullable<ItemSummary["review"]>["state"];

/** A recommendation as a word, the row's and the page's: what the reviewer says, never what the platform found. */
export const RECOMMENDATION_WORD: Record<ReviewRecommendation, string> = { approve: "approves", changes_requested: "asks for changes", needs_person: "needs you" };

/** The cut-offs a review step is tried again after (server/src/factory/blueprint.ts, `RULES.interruptions`). */
const INTERRUPTIONS = 3;

const ORDINAL = ["first", "second", "third", "fourth", "fifth"];
const ordinal = (n: number) => ORDINAL[n - 1] ?? `${n}th`;

/** A review's screenshots, the item's records of them (`ItemReview.screenshots`). */
export function reviewShots(review: ItemReview): ItemAttachment[] {
	return review.screenshots ?? [];
}

/** A server sentence after "No second review: ", as the log words it: its first letter lower unless it starts a name, its last stop dropped. */
function clause(said: string): string {
	const text = said.trim().replace(/\.$/, "");
	return /^[A-Z][a-z]/.test(text) ? text[0]?.toLowerCase() + text.slice(1) : text;
}

const NONE = "No second review: ";

/**
 * Why there was no second review, in the server's words: the review's own `said` when the platform kept
 * a review that was not filed, else the item's reason (`ItemView.reviewNone`), else the log's line for
 * it in the run shown (blueprint.ts, `handoff`).
 */
export function noneLine(view: Pick<ItemView, "events" | "run" | "reviewNone">, review: ItemReview | null, state: ReviewState): string {
	if (review?.state === "none" && review.said) return `${NONE}${clause(review.said)}.`;
	if (view.reviewNone) return `${NONE}${clause(view.reviewNone)}.`;
	const run = view.run?.n ?? null;
	const logged = view.events.findLast((event) => event.said.startsWith(NONE) && (run === null || event.step === null || event.step.run === run));
	if (logged) return logged.said;
	return state === "off" ? "No second review for this item: turned off for this deployment." : "No second review of this commit.";
}

/** The second review's state while there is no review of the run to show, in a sentence; null when the review is what is shown. */
export function stateLine(view: Pick<ItemView, "events" | "run" | "head" | "wait" | "state" | "reviewNone">, state: ReviewState, review: ItemReview | null): string | null {
	const step = view.run?.step;
	const at = (view.head ?? "").slice(0, 7);
	const reviewing = step?.kind === "review" && view.run?.endedAt === null;
	if ((state === "running" || state === "waiting") && reviewing && step && step.interruptions > 0 && !view.wait) {
		return `The review was cut off by a deploy or a restart; it is tried again (${step.interruptions} of ${INTERRUPTIONS}).`;
	}
	switch (state) {
		case "waiting":
			if (reviewing && view.wait) return `The second review of ${at} waits: ${clause(view.wait.sentence)}.`;
			return "A second agent reviews the work once CI has finished on the pushed commit.";
		case "running":
			return "The second reviewer is reading the change.";
		case "none":
		case "off":
			return noneLine(view, review, state);
		case "filed":
			return null;
	}
}

/** Findings blocking first, then those to fix, then notes; each kind in the order filed. */
const SEVERITY_ORDER = { blocking: 0, should_fix: 1, note: 2 } as const;

/**
 * A review's blocks in the order the page reads them (design §3.2): its questions, the summary, the
 * findings (blocking first), the answers to earlier findings; then, after its screenshots, its other
 * text, risks and excerpts in the order filed.
 */
export function reviewOrder(blocks: ReviewBlock[]): { questions: Extract<ReviewBlock, { kind: "question" }>[]; lead: ReviewBlock[]; rest: ReviewBlock[] } {
	const questions = blocks.filter((block): block is Extract<ReviewBlock, { kind: "question" }> => block.kind === "question");
	const findings = blocks.filter((block): block is Extract<ReviewBlock, { kind: "finding" }> => block.kind === "finding");
	findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
	const lead = [...blocks.filter((block) => block.kind === "summary"), ...findings, ...blocks.filter((block) => block.kind === "earlier")];
	const rest = blocks.filter((block) => block.kind === "text" || block.kind === "risk" || block.kind === "excerpt");
	return { questions, lead, rest };
}

/** The verdict a review's references are read against: the one it was given, else the one at its commit. */
function verdictOf(review: ItemReview, verdicts: Verdict[]): Verdict | null {
	return verdicts.find((verdict) => verdict.id === review.verdictId) ?? verdicts.findLast((verdict) => verdict.head === review.head) ?? null;
}

interface ReviewProps {
	view: ItemView;
	review: ItemReview;
	links: ScreenshotLinks;
	when(at: number): ReactNode;
	/** Earlier rounds' finding titles, by id: what an answer to one names. */
	named(finding: string): string | null;
}

/** One review: its line, the platform's notes on it, its questions, its blocks and its screenshots. */
function Review({ view, review, links, when, named }: ReviewProps) {
	const latest = view.verdicts[view.verdicts.length - 1];
	const earlierCommit = latest !== undefined && latest.head !== review.head;
	const verdict = verdictOf(review, view.verdicts);
	const linkTo: LinkTo = (at: ReviewLocation) => blobLink(view.repository, at.side === "base" ? review.base : review.head, at);
	const author = "The reviewer";
	if (review.state === "none") {
		return (
			<article className="item-verdict-block review-article">
				<p className="item-verdict-head">
					<span className="review-says">{noneLine(view, review, "none")}</span>
					<span className="agent-meta">
						<span>at {review.head.slice(0, 7)}</span>
						{earlierCommit ? <span>of an earlier commit</span> : null}
						<span>{when(review.at)}</span>
					</span>
				</p>
			</article>
		);
	}
	const { questions, lead, rest } = reviewOrder(review.blocks);
	const shots = reviewShots(review);
	const shown = review.blocks.flatMap((block) => {
		const shot = block.kind === "screenshot" ? shots.find((one) => one.id === block.attachment) : undefined;
		return shot ? [shot] : [];
	});
	return (
		<article className="item-verdict-block review-article">
			<p className="item-verdict-head">
				<span className="review-says">
					Second review: <span className="review-word">{review.recommendation ? RECOMMENDATION_WORD[review.recommendation] : "no recommendation"}</span>
				</span>
				<span className="agent-meta">
					<span>at {review.head.slice(0, 7)}</span>
					{earlierCommit ? <span>of an earlier commit</span> : null}
					{review.round > 1 ? <span>the {ordinal(review.round)} round</span> : null}
					<span className="review-model">{review.by.model}</span>
					<span>filed {when(review.at)}</span>
				</span>
			</p>
			{review.notes.length > 0 ? (
				<ul className="review-notes" aria-label="The platform's notes on this review">
					{review.notes.map((note, index) => (
						<li key={index} className="usage-gloss">
							{note}
						</li>
					))}
				</ul>
			) : null}
			{questions.length > 0 ? (
				<div className="review-asks">
					<p className="machine-label review-asks-label">The reviewer asks you</p>
					{questions.map((block, index) => (
						<ReviewText key={index} text={block.text} />
					))}
					{view.state === "review" ? <p className="usage-gloss">No answer is sent from here. You can send it back with a note.</p> : null}
				</div>
			) : null}
			{lead.length > 0 ? (
				<dl className="usage-facts item-facts review-blocks">
					{lead.map((block, index) => (
						<Block key={index} block={block} records={review.records} verdict={verdict} author={author} linkTo={linkTo} named={named} />
					))}
				</dl>
			) : null}
			{shown[0] ? <Screenshots by="reviewer" head={shown[0].head} shots={shown} links={links} /> : null}
			{rest.length > 0 ? (
				<dl className="usage-facts item-facts review-blocks">
					{rest.map((block, index) => (
						<Block key={index} block={block} records={review.records} verdict={verdict} author={author} linkTo={linkTo} named={named} />
					))}
				</dl>
			) : null}
		</article>
	);
}

/**
 * The section, when the item has a second review to speak of: the review of the run shown (or where it
 * is while there is none), then the earlier ones, folded. Nothing when the item has no review state and
 * no review: an item that has not reached it, or a view of a platform without reviewer sessions.
 */
export function SecondReview({ view, links, when }: { view: ItemView; links: ScreenshotLinks; when(at: number): ReactNode }) {
	const [open, setOpen] = useState(false);
	const folded = useId();
	const { reviews } = view;
	const state = view.review?.state ?? null;
	if (state === null && reviews.length === 0) return null;
	const run = view.run?.n ?? null;
	const last = reviews[reviews.length - 1] ?? null;
	// The review of the run shown is shown when it was filed; any other, earlier or not filed, is folded under it.
	const current = last !== null && (run === null || last.run === run) && (state === null || state === "filed" || last.state === "none") ? last : null;
	const before = reviews.filter((one) => one !== current).reverse();
	const line = current ? null : state === null ? null : stateLine(view, state, null);
	const titles = new Map(reviews.flatMap((one) => one.blocks.flatMap((block) => (block.kind === "finding" ? [[block.id, block.title] as const] : []))));
	const named = (finding: string) => titles.get(finding) ?? null;
	const session = view.reviewerSessionId;
	return (
		<section className="usage-section item-second" aria-labelledby="item-second" data-author="reviewer">
			<h2 className="usage-title" id="item-second">
				From the second reviewer
			</h2>
			<p className="usage-lede">
				{current?.state === "filed"
					? view.mode === "orchestrate"
						? "A second agent, with no part in making the change, checked out the pushed commit in its own sandbox and read it against the task. Its own words: the verdict above does not rest on them, and its recommendation does nothing by itself."
						: "A second agent, with no part in making the change, checked out the pushed commit in its own sandbox and read it against the task. Its own words: the verdict above does not rest on them. When it asks for changes, the agent that made the change works on its blocking findings and it reviews again, at most twice; when it has questions, you decide."
					: "Once CI has finished, a second agent with no part in making the change reviews the pushed commit in its own sandbox. Its words are its own: the verdict above never rests on them."}
			</p>
			{line ? (
				<p className={`review-state review-state-${state}`}>
					<span>{line}</span>
					{state === "running" && session ? (
						<a className="repo-link review-session" {...linkProps({ name: "session", id: session })}>
							Open the reviewer's session
						</a>
					) : null}
				</p>
			) : null}
			{current ? <Review view={view} review={current} links={links} when={when} named={named} /> : null}
			{current?.state === "filed" && session ? (
				<p className="usage-note">
					<a className="link" {...linkProps({ name: "session", id: session })}>
						Open the reviewer's session
					</a>{" "}
					to see what it ran.
				</p>
			) : null}
			{before.length > 0 ? (
				<>
					<p className="agents-fold items-fold">
						<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={folded} onClick={() => setOpen((value) => !value)}>
							<ChevronIcon size={11} className="machine-chevron" />
							{open ? "Hide the earlier reviews" : `Show ${plural(before.length, "earlier review")}`}
						</button>
					</p>
					<div id={folded} hidden={!open}>
						{before.map((one) => (
							<Review key={one.id} view={view} review={one} links={links} when={when} named={named} />
						))}
					</div>
				</>
			) : null}
		</section>
	);
}
