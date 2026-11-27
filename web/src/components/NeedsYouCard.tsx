/**
 * The home page's "Needs you": one amber card, above the agents, with everything that waits on its
 * person. The user's own agents that wait on an answer, then the work items that ask something, the
 * longest waiting first. Each row says what waits and leads to where it is answered: the agent's page
 * (its question stands under the call it is about) or the item's.
 *
 * The agents stay in their lists below as well: the card is where to look first, not where they move.
 */
import type { ItemSummary, SessionSummary } from "@contract";
import { useId } from "react";
import { acpHarnessName, sessionModelWords } from "../lib/acp";
import { absoluteTime, plural, relativeTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { asking, questionLine } from "../lib/items";
import { LongText } from "./Fold";
import { ChevronRightIcon } from "./Icons";
import { AgentGlyph } from "./ui/Pill";

/** The lamp left on: a still amber dot with a slow ring round it. */
function Lamp() {
	return <span className="needs-lamp" aria-hidden="true" />;
}

function Since({ at, now }: { at: number; now: number }) {
	return (
		<time dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
			{relativeTime(at, now)}
		</time>
	);
}

function AgentNeed({ session, now }: { session: SessionSummary; now: number }) {
	return (
		<li className="needs-row">
			<Lamp />
			<div className="needs-main">
				<p className="needs-title">
					<a className="needs-link" {...linkProps({ name: "session", id: session.id })}>
						{session.title}
					</a>
				</p>
				<p className="needs-what">Its agent asks before it goes on. The question is on its page, under the call it is about.</p>
				<p className="needs-meta">
					<span>
						<AgentGlyph harness={session.harness ?? "windlass"} size={11} inline />
						{acpHarnessName(session) ?? "Windlass"} · {sessionModelWords(session)}
					</span>
					{session.repository ? <span>{session.repository.name}</span> : null}
					<Since at={session.updatedAt} now={now} />
				</p>
			</div>
			<a className="needs-answer" {...linkProps({ name: "session", id: session.id })} aria-label={`Answer ${session.title}`}>
				Answer
				<ChevronRightIcon size={13} className="needs-answer-arrow" />
			</a>
		</li>
	);
}

/**
 * What an item asks, in a line: the agent's own first line for its question, else the Factory list's
 * line (`questionLine`), so a plan to approve says so rather than printing its figures.
 */
export function needLine(item: ItemSummary): string | null {
	const asked = item.question?.kind === "agent_ask" ? item.question.asked?.text.trim().split("\n")[0]?.trim() : undefined;
	return asked || questionLine(item);
}

function ItemNeed({ item, now }: { item: ItemSummary; now: number }) {
	const question = item.question;
	const line = needLine(item);
	return (
		<li className="needs-row">
			<Lamp />
			<div className="needs-main">
				<p className="needs-title">
					<a className="needs-link" {...linkProps({ name: "item", id: item.id })}>
						{item.title}
					</a>
					<span className="needs-tag">work item</span>
				</p>
				{line ? (
					<LongText lines={2} className="needs-what">
						{line}
					</LongText>
				) : null}
				<p className="needs-meta">
					<span>
						{item.repository.owner}/{item.repository.name}
					</span>
					{item.state === "draft" ? null : (
						<span>
							<a className="needs-agent" {...linkProps({ name: "session", id: item.sessionId })} aria-label={`The agent of ${item.title}`}>
								its agent
							</a>
						</span>
					)}
					<Since at={question?.askedAt ?? item.updatedAt} now={now} />
				</p>
			</div>
			<a className="needs-answer" {...linkProps({ name: "item", id: item.id })} aria-label={`Open ${item.title}`}>
				Open
				<ChevronRightIcon size={13} className="needs-answer-arrow" />
			</a>
		</li>
	);
}

/** `sessions`: the user's own agents (no work item's); `items`: their work items, null until read. Nothing when nothing waits. */
export function NeedsYouCard({ sessions, items, now }: { sessions: readonly SessionSummary[]; items: readonly ItemSummary[] | null; now: number }) {
	const heading = useId();
	const agents = sessions.filter((session) => session.status === "waiting").sort((a, b) => a.updatedAt - b.updatedAt);
	const asked = asking(items ?? []);
	const total = agents.length + asked.length;
	if (total === 0) return null;
	const parts = [agents.length > 0 ? plural(agents.length, "agent") : null, asked.length > 0 ? plural(asked.length, "work item") : null].filter((part) => part !== null);
	return (
		<section className="needs" aria-labelledby={heading}>
			<h2 className="needs-head" id={heading}>
				Needs you
				<span className="needs-count">{parts.join(" · ")}</span>
			</h2>
			<ul className="needs-card">
				{agents.map((session) => (
					<AgentNeed key={session.id} session={session} now={now} />
				))}
				{asked.map((item) => (
					<ItemNeed key={item.id} item={item} now={now} />
				))}
			</ul>
		</section>
	);
}
