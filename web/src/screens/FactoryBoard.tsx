/**
 * The Factory as a board (lib/board.ts): what asks its person in a tray of its own, in the calm amber,
 * over the pipeline of where every other item is: Planning, Building, CI, Review, Ready for you, and
 * the ended ones in a narrow last column. Read-only: a card's title opens its item, and the one button a
 * card has is the list's (Answer where it asks, Open where it is yours); every other action stays on the
 * item's page. A feature is one card, its open parts as compact rows with a state dot each.
 */
import type { ItemSummary } from "@contract";
import { useId } from "react";
import { BOARD_COLUMNS, boardCards, columnName, type BoardCard, type BoardColumn } from "../lib/board";
import { HARNESS_NAMES } from "../lib/acp";
import { absoluteTime, compact, plural, relativeTime } from "../lib/format";
import { machineLabel } from "../lib/machines";
import { linkProps } from "../lib/router";
import { doingNow, subtaskState, type PlannedSubtask } from "../lib/subtasks";
import { useMachines } from "./Machines";
import { ItemStanding, questionLine } from "./Items";

const PIPELINE = BOARD_COLUMNS.filter((column) => column !== "needs" && column !== "ended");
/** The ended column lists this many of the newest; the list has the rest. */
const ENDED_SHOWN = 8;

const ENDED_WORD: Record<"done" | "failed" | "cancelled", string> = { done: "merged", failed: "failed", cancelled: "cancelled" };

/** A summary as a plan entry with no plan: what `doingNow` reads. */
const entryOf = (item: ItemSummary): PlannedSubtask => ({ n: 1, child: item, state: subtaskState(item), task: { key: item.parent?.key ?? item.id, title: item.title, brief: "", acceptance: [], dependsOn: [], owns: [], budget: item.budget } });

function doingLine(item: ItemSummary, now: number): string {
	const doing = doingNow(entryOf(item), new Map(), new Set(), now);
	return doing.fact ? `${doing.word} · ${doing.fact}` : doing.word;
}

/** The one thing a card waits on, in a line. */
function waitingOn(card: BoardCard, now: number): { text: string | null; standing: boolean } {
	const { item, parts } = card;
	if (item.question) return { text: questionLine(item), standing: false };
	const asking = parts.find((part) => part.question);
	if (asking) return { text: `${asking.title}: ${questionLine(asking)}`, standing: false };
	if (item.state === "review") return { text: null, standing: true };
	if (item.state === "draft") return { text: "Draft, not started.", standing: false };
	// A feature's parts say what it waits for better than its sentence that lists them.
	if (parts.length > 0) return { text: null, standing: false };
	if (item.state === "waiting" && item.wait) return { text: item.wait.sentence, standing: false };
	return { text: doingLine(item, now), standing: false };
}

/** What a card has cost so far: the agent's own figure where it reports one, else the tokens counted (a feature's parts among them). */
function costSoFar(card: BoardCard): string | null {
	const cost = card.item.agent?.cost;
	if (cost) return new Intl.NumberFormat("en-US", { style: "currency", currency: cost.currency, maximumFractionDigits: 2 }).format(cost.amount);
	const tokens = card.item.spent.tokens + card.parts.reduce((sum, part) => sum + part.spent.tokens, 0);
	return tokens > 0 ? `${compact(tokens)} tokens` : null;
}

function placeOf(item: ItemSummary, machines: Map<string, string>): string | null {
	if (item.state === "draft") return null;
	if (item.placement?.name) return item.placement.name;
	if (item.place.kind === "hosted") return "hosted";
	return machines.get(item.place.machineId) ?? "your machine";
}

function Card({ card, now, reviewer, machines }: { card: BoardCard; now: number; reviewer: boolean; machines: Map<string, string> }) {
	const { item, parts } = card;
	const needs = card.column === "needs";
	const asking = item.question ? item : parts.find((part) => part.question);
	const line = waitingOn(card, now);
	const place = placeOf(item, machines);
	const cost = costSoFar(card);
	const agent = item.agent ? HARNESS_NAMES[item.agent.harness] : HARNESS_NAMES.windlass;
	const action = needs && asking ? { words: "Answer", id: asking.id } : card.column === "ready" ? { words: "Open", id: item.id } : null;
	return (
		<li className={`board-card board-card-${card.column} board-card-is-${item.state}`} data-kind={card.kind}>
			<a className="board-card-title" {...linkProps({ name: "item", id: item.id })}>
				{item.title}
				{needs ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
			</a>
			{line.text ? <p className="board-card-why">{line.text}</p> : null}
			{line.standing ? (
				<p className="board-card-standing">
					<ItemStanding item={item} reviewer={reviewer} />
				</p>
			) : null}
			{parts.length > 0 ? (
				<ul className="board-parts" aria-label={`Open parts of ${item.title}`}>
					{parts.slice(0, 5).map((part) => {
						const state = subtaskState(part);
						return (
							<li key={part.id} className={`board-part board-part-${state}`}>
								<span className="board-part-dot" aria-hidden="true" />
								<a className="board-part-title" {...linkProps({ name: "item", id: part.id })} title={part.title}>
									{part.title}
								</a>
								<span className="board-part-doing">{state === "asks" ? "asks you" : doingNow(entryOf(part), new Map(), new Set(), now).word}</span>
							</li>
						);
					})}
					{parts.length > 5 ? <li className="board-part board-part-more">{plural(parts.length - 5, "more part")}</li> : null}
				</ul>
			) : null}
			<p className="board-card-meta">
				<span>
					{item.repository.owner}/{item.repository.name}
					{item.pullRequest ? `#${item.pullRequest.number}` : ""}
				</span>
				<span>{place ? `${agent} · ${place}` : agent}</span>
			</p>
			<div className="board-card-foot">
				<span className="board-card-cost">{cost ?? ""}</span>
				{action ? (
					<a className={`board-card-action${needs ? " board-card-action-needs" : ""}`} {...linkProps({ name: "item", id: action.id })} aria-label={`${action.words}: ${item.title}`}>
						{action.words}
					</a>
				) : (
					<time className="board-card-time" dateTime={new Date(item.updatedAt).toISOString()} title={absoluteTime(item.updatedAt)}>
						{relativeTime(item.updatedAt, now)}
					</time>
				)}
			</div>
		</li>
	);
}

function Column({ column, cards, now, reviewer, machines }: { column: BoardColumn; cards: BoardCard[]; now: number; reviewer: boolean; machines: Map<string, string> }) {
	const id = useId();
	return (
		<section className={`board-column board-column-${column}`} aria-labelledby={id}>
			<h3 className="board-column-head" id={id}>
				<span className="board-column-bar" aria-hidden="true" />
				<span className="board-column-name">{columnName(column, reviewer)}</span>
				<span className="board-column-count">{cards.length}</span>
			</h3>
			{cards.length > 0 ? (
				<ul className="board-cards">
					{cards.map((card) => (
						<Card key={card.item.id} card={card} now={now} reviewer={reviewer} machines={machines} />
					))}
				</ul>
			) : (
				<p className="board-column-empty">Nothing here</p>
			)}
		</section>
	);
}

export function FactoryBoard({ list, children, endedCount, now, reviewer, onAllEnded }: { list: readonly ItemSummary[]; children: readonly ItemSummary[] | undefined; endedCount: number; now: number; reviewer: boolean; onAllEnded(): void }) {
	const columns = boardCards(list, children, reviewer);
	const needsId = useId();
	const endedId = useId();
	// Machine names for cards that run on one and carry no placement name; read only when one does.
	const onMachine = list.some((item) => item.place.kind === "machine" && !item.placement?.name && item.state !== "draft");
	const machineList = useMachines(onMachine).list;
	const machines = new Map((machineList ?? []).map((machine) => [machine.machineId, machineLabel(machine)]));
	const ended = columns.ended.slice(0, ENDED_SHOWN);
	return (
		<div className="factory-board">
			{columns.needs.length > 0 ? (
				<section className="board-tray" aria-labelledby={needsId}>
					<h2 className="board-tray-head" id={needsId}>
						Needs you <span className="board-column-count">{columns.needs.length}</span>
					</h2>
					<ul className="board-cards board-tray-cards">
						{columns.needs.map((card) => (
							<Card key={card.item.id} card={card} now={now} reviewer={reviewer} machines={machines} />
						))}
					</ul>
				</section>
			) : null}
			<div className="board-pipeline" role="group" aria-label="Where each work item is" tabIndex={0}>
				{PIPELINE.map((column) => (
					<Column key={column} column={column} cards={columns[column]} now={now} reviewer={reviewer} machines={machines} />
				))}
				<section className="board-column board-column-ended" aria-labelledby={endedId}>
					<h3 className="board-column-head" id={endedId}>
						<span className="board-column-bar" aria-hidden="true" />
						<span className="board-column-name">Ended</span>
						<span className="board-column-count">{endedCount}</span>
					</h3>
					{ended.length > 0 ? (
						<ul className="board-ended">
							{ended.map(({ item }) => (
								<li key={item.id} className={`board-ended-row board-ended-${item.state}`}>
									<a className="board-ended-title" {...linkProps({ name: "item", id: item.id })}>
										{item.title}
									</a>
									<span className="board-ended-meta">
										{ENDED_WORD[item.state as keyof typeof ENDED_WORD] ?? item.state}
										{item.pullRequest ? ` · #${item.pullRequest.number}` : ""}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="board-column-empty">Nothing here</p>
					)}
					{endedCount > ended.length ? (
						<button type="button" className="link board-ended-all" onClick={onAllEnded}>
							All {endedCount} in the list
						</button>
					) : null}
				</section>
			</div>
		</div>
	);
}
