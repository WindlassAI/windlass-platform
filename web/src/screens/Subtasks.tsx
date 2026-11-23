/**
 * A feature's subtasks while they run, where a person looks for them:
 *
 * - `SubtasksBlock`, on the feature's page once its plan is approved: the tally ("2 running · 1 asks
 *   you · 1 of 6 done") with a bar of one segment a subtask, then one row a subtask in plan order:
 *   what it is doing now (its step and fix round, from the run), where it runs, what it spent of its
 *   budget, and its session. A subtask that asks gets the start of its question and Answer.
 * - `SubtaskStrip`, on a subtask's page: "Subtask 4 of 6", a numbered chip a sibling, and the ones
 *   before and after it.
 * - `FactorySubtasks`, under a feature's row in the Factory: the tally of the subtasks that are open,
 *   and only the active ones (running or asking), each with its step word and place.
 *
 * All of them read the summaries the live feed keeps current (`ItemFeed.children`), and none assumes
 * one subtask at a time.
 */
import type { FeaturePlan, ItemSummary, ItemView } from "@contract";
import { LongText } from "../components/Fold";
import { compact, plural, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { activeSubtasks, doingNow, doneKeys, plannedSubtasks, siblingsOf, subtaskState, tallyOf, tallyParts, type PlannedSubtask, type SubtaskState, type SubtaskTally } from "../lib/subtasks";
import { ItemGlyph } from "./Items";

const STATE_LABEL: Record<SubtaskState, string> = { running: "running", asks: "asks you", done: "done", stopped: "stopped", to_go: "not started" };

/** The tally in a line, each count in ink and its word dim; asking in its hue. */
export function Tally({ tally }: { tally: SubtaskTally }) {
	return (
		<span className="subtask-tally">
			{tallyParts(tally).map((part) => (
				<span key={part.tone} className={`subtask-tally-part subtask-tally-${part.tone}`}>
					<strong>{part.n}</strong> {part.word}
				</span>
			))}
		</span>
	);
}

/** One segment a subtask, in plan order, coloured by where it is. */
export function SegmentBar({ states }: { states: SubtaskState[] }) {
	return (
		<span className="subtask-segments" role="img" aria-label={states.map((state, index) => `${index + 1} ${STATE_LABEL[state]}`).join(", ")}>
			{states.map((state, index) => (
				<i key={index} className={`subtask-segment subtask-segment-${state}`} />
			))}
		</span>
	);
}

/** Where a subtask runs: where it was placed, with its overflow, or where it is planned to. */
function placeOf(entry: PlannedSubtask): { name: string | null; note: string | null } {
	const prefer = entry.task.place?.prefer ?? null;
	const placed = entry.child?.placement?.name ?? null;
	if (placed) return { name: placed, note: prefer && placed !== prefer ? `overflow from ${prefer}` : null };
	return { name: prefer, note: prefer && !entry.child ? "planned" : null };
}

/** The start of what a subtask asks: the agent's own words where it asked in them, else the platform's sentence. */
const askedText = (child: ItemSummary): string => child.question?.asked?.text ?? child.question?.text ?? "";

function SubtaskRunRow({ entry, numbers, done, now }: { entry: PlannedSubtask; numbers: ReadonlyMap<string, number>; done: ReadonlySet<string>; now: number }) {
	const { child, task, n, state } = entry;
	const doing = doingNow(entry, numbers, done, now);
	const place = placeOf(entry);
	const spent = child?.spent.tokens ?? 0;
	const budget = child?.budget.tokens ?? task.budget.tokens;
	const share = Math.min(100, (spent / Math.max(1, budget)) * 100);
	const options = child?.question?.asked?.options.length ?? 0;
	return (
		<li className={`subtask-run subtask-run-${state}`}>
			<span className="subtask-run-glyph" aria-hidden="true">
				{child ? <ItemGlyph item={child} /> : <span className="item-glyph-waiting" />}
			</span>
			<div className="subtask-run-main">
				<p className="subtask-run-title">
					<span className="subtask-run-n">{n}</span>
					{child ? (
						<a className="subtask-run-link" {...linkProps({ name: "item", id: child.id })}>
							{task.title}
						</a>
					) : (
						<span>{task.title}</span>
					)}
				</p>
				<p className="subtask-run-doing">
					<span className="subtask-run-word">{doing.word}</span>
					{doing.fact ? <span className="subtask-run-fact">{doing.fact}</span> : null}
					{doing.code ? <code className="plan-code subtask-run-fact">{doing.code}</code> : null}
				</p>
				{child?.question ? (
					<div className="subtask-run-asks">
						<LongText lines={2}>{askedText(child)}</LongText>
						<p className="subtask-run-answer">
							<a className="button button-primary button-small" {...linkProps({ name: "item", id: child.id })}>
								Answer
							</a>
							{options > 0 ? <span className="tone-dim">{plural(options, "suggested answer")}</span> : null}
						</p>
					</div>
				) : null}
			</div>
			<p className="subtask-run-place">
				{place.name ? <span className="subtask-run-place-name">{place.name}</span> : null}
				{place.note ? <span className="subtask-run-place-note">{place.note}</span> : null}
			</p>
			<p className="subtask-run-spend" aria-label={child ? `Spent ${compact(spent)} of ${compact(budget)} tokens` : `Budget ${compact(budget)} tokens`}>
				{child ? (
					<>
						<span className="usage-meter subtask-run-meter" aria-hidden="true">
							<span className="usage-meter-used" style={{ width: `${share}%` }} />
						</span>
						<span className="subtask-run-spent">
							{compact(spent)} <span className="tone-faint">of {compact(budget)}</span>
						</span>
					</>
				) : (
					<span className="subtask-run-spent tone-faint">{compact(budget)} budget</span>
				)}
			</p>
			<p className="subtask-run-session">
				{child && child.state !== "draft" ? (
					<a className="link" {...linkProps({ name: "session", id: child.sessionId })} aria-label={`Session of ${task.title}`}>
						Session
					</a>
				) : null}
			</p>
		</li>
	);
}

/** Whether the feature's page shows its subtasks as they run: its plan is approved and the feature has not ended. */
export function showsSubtasks(view: Pick<ItemView, "plan" | "children" | "state" | "mode">): boolean {
	return view.mode === "orchestrate" && view.plan?.status === "approved" && view.plan.subtasks.length > 0 && !["done", "failed", "cancelled"].includes(view.state);
}

/** The feature page's block of its subtasks: the tally and bar, a row a subtask, and what they spent together. */
export function SubtasksBlock({ plan, children, now }: { plan: FeaturePlan; children: readonly ItemSummary[]; now: number }) {
	const subtasks = plannedSubtasks(plan, children);
	const tally = tallyOf(subtasks);
	const numbers = new Map(subtasks.map((entry) => [entry.task.key, entry.n]));
	const done = doneKeys(subtasks);
	const made = subtasks.map((entry) => entry.child).filter((child): child is ItemSummary => child !== null);
	const spent = made.reduce((sum, child) => sum + child.spent.tokens, 0);
	const budget = subtasks.reduce((sum, entry) => sum + (entry.child?.budget.tokens ?? entry.task.budget.tokens), 0);
	const worked = made.reduce((sum, child) => sum + child.spent.activeSeconds, 0);
	return (
		<section className="subtasks-block" aria-label="Subtasks">
			<header className="subtasks-head">
				<h2 className="subtasks-title">Subtasks</h2>
				<Tally tally={tally} />
				<SegmentBar states={subtasks.map((entry) => entry.state)} />
			</header>
			<ol className="subtask-runs">
				{subtasks.map((entry) => (
					<SubtaskRunRow key={entry.task.key} entry={entry} numbers={numbers} done={done} now={now} />
				))}
			</ol>
			<p className="subtasks-foot">
				<span>
					{compact(spent)} <span className="tone-faint">of {compact(budget)} tokens</span>
				</span>
				{worked > 0 ? <span>{sandboxTime(worked)} working</span> : null}
			</p>
		</section>
	);
}

/** A subtask's place among its siblings: "Subtask 4 of 6", a chip a sibling, and the ones before and after it. */
export function SubtaskStrip({ plan, children, current }: { plan: FeaturePlan; children: readonly ItemSummary[]; current: string }) {
	const subtasks = plannedSubtasks(plan, children);
	const around = siblingsOf(subtasks, current);
	if (!around) return null;
	const step = (entry: PlannedSubtask | null, dir: "previous" | "next") =>
		entry?.child ? (
			<a className={`link subtask-strip-${dir}`} {...linkProps({ name: "item", id: entry.child.id })} title={entry.task.title}>
				{dir === "previous" ? "‹ " : ""}
				<span className="subtask-strip-n">{entry.n}</span> <span className="subtask-strip-name">{entry.task.title}</span>
				{dir === "next" ? " ›" : ""}
			</a>
		) : entry ? (
			<span className={`subtask-strip-${dir} tone-faint`} title={`${entry.task.title}: not started`}>
				{dir === "previous" ? "‹ " : ""}
				<span className="subtask-strip-n">{entry.n}</span> <span className="subtask-strip-name">{entry.task.title}</span>
				{dir === "next" ? " ›" : ""}
			</span>
		) : null;
	return (
		<nav className="subtask-strip" aria-label="Subtasks of the feature">
			<span className="subtask-strip-at">
				Subtask {around.at.n} of {subtasks.length}
			</span>
			<ol className="subtask-chips">
				{subtasks.map((entry) => {
					const label = `${entry.n}. ${entry.task.title}: ${STATE_LABEL[entry.state]}`;
					const className = `subtask-chip subtask-chip-${entry.state}${entry.task.key === current ? " subtask-chip-current" : ""}`;
					return (
						<li key={entry.task.key}>
							{entry.child && entry.task.key !== current ? (
								<a className={className} {...linkProps({ name: "item", id: entry.child.id })} aria-label={label} title={label}>
									{entry.n}
								</a>
							) : (
								<span className={className} aria-label={label} title={label} aria-current={entry.task.key === current ? "page" : undefined}>
									{entry.n}
								</span>
							)}
						</li>
					);
				})}
			</ol>
			<span className="subtask-strip-steps">
				{step(around.previous, "previous")}
				{step(around.next, "next")}
			</span>
		</nav>
	);
}

/** The open subtasks of a feature in the feed, newest filed last: what the Factory's row counts. */
export const childrenOf = (feature: Pick<ItemSummary, "id">, children: readonly ItemSummary[] | undefined): ItemSummary[] => (children ?? []).filter((child) => child.parent?.itemId === feature.id).sort((a, b) => a.createdAt - b.createdAt);

/**
 * Under a feature's row in the Factory: how many of its subtasks run and ask, and the active ones,
 * each with its step word and place, linking to it. The feed carries open subtasks only, so the row
 * counts those; the feature's page has the whole plan.
 */
export function FactorySubtasks({ feature, children, now }: { feature: ItemSummary; children: readonly ItemSummary[]; now: number }) {
	const mine = childrenOf(feature, children);
	if (mine.length === 0) return null;
	// The feed has no plan: each open subtask stands for itself, in the order it was made.
	const entries: PlannedSubtask[] = mine.map((child, index) => ({ n: index + 1, child, state: subtaskState(child), task: { key: child.parent!.key, title: child.title, brief: "", acceptance: [], dependsOn: [], owns: [], budget: child.budget } }));
	const active = activeSubtasks(entries);
	const running = entries.filter((entry) => entry.state === "running").length;
	const asks = entries.filter((entry) => entry.state === "asks").length;
	return (
		<div className="factory-subtasks">
			<p className="factory-subtasks-tally">
				<span className="subtask-tally">
					{running > 0 ? (
						<span className="subtask-tally-part subtask-tally-running">
							<strong>{running}</strong> running
						</span>
					) : null}
					{asks > 0 ? (
						<span className="subtask-tally-part subtask-tally-asks">
							<strong>{asks}</strong> {asks === 1 ? "asks you" : "ask you"}
						</span>
					) : null}
				</span>
				<SegmentBar states={entries.map((entry) => entry.state)} />
			</p>
			{active.length > 0 ? (
				<ul className="factory-subtask-list" aria-label={`Active subtasks of ${feature.title}`}>
					{active.map((entry) => {
						const doing = doingNow(entry, new Map(), new Set(), now);
						const place = entry.child!.placement?.name ?? null;
						return (
							<li key={entry.child!.id} className={`factory-subtask factory-subtask-${entry.state}`}>
								<span className="factory-subtask-dot" aria-hidden="true" />
								<a className="factory-subtask-title" {...linkProps({ name: "item", id: entry.child!.id })}>
									{entry.task.title}
								</a>
								<span className="factory-subtask-doing">
									{doing.word}
									{place ? ` · ${place}` : ""}
								</span>
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}
