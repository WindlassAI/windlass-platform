import { SUMMARY_DAYS, type CostRates, type FinishedItems, type SummaryDays } from "@contract";
import { useId, useState } from "react";
import {
	summarize,
	type SpentOn,
	type Spread,
	type SummaryGroup,
	type UsageSummary,
} from "../../../server/src/factory/usage-summary.js";
import { SIZE_WORDS, TYPE_WORDS, usd } from "../lib/cost";
import { count, plural, sandboxTime } from "../lib/format";
import { CostFigure } from "./CostFigure";
import { useCostRates, useFinishedItems } from "../state/hooks";

type Words = Record<string, { name: string; what: string }>;

/** A group's median or p90 dollars, or why there are none: all on a plan, or not priced. */
function costCell(group: SummaryGroup<string>, pick: keyof Spread): string {
	if (group.usd) return usd(group.usd[pick]);
	return group.onPlan > 0 ? "On your plan" : "Unknown";
}

/** "9 priced · 3 on your plan · 1 unknown" where not every item of the group is in its dollar figures. */
function pricedNote(group: SummaryGroup<string>): string | null {
	if (group.priced === group.count) return null;
	const parts = [
		...(group.priced ? [`${count(group.priced)} priced`] : []),
		...(group.onPlan ? [`${count(group.onPlan)} on your plan`] : []),
		...(group.unknown ? [`${count(group.unknown)} unknown`] : []),
	];
	return parts.join(" · ");
}

function GroupTable({
	caption,
	heading,
	words,
	groups,
}: {
	caption: string;
	heading: string;
	words: Words;
	groups: SummaryGroup<string>[];
}) {
	return (
		<>
			<h3 className="cost-summary-caption" aria-hidden="true">
				{caption}
			</h3>
			<table className="usage-table cost-summary-table">
				<caption className="visually-hidden">{caption}</caption>
				<thead>
					<tr>
						<th scope="col">{heading}</th>
						<th scope="col" className="usage-number">
							Done
						</th>
						<th scope="col" className="usage-number">
							Median cost
						</th>
						<th scope="col" className="usage-number">
							p90 cost
						</th>
						<th scope="col" className="usage-number usage-wide">
							Median time
						</th>
						<th scope="col" className="usage-number usage-wide">
							p90 time
						</th>
						<th scope="col" className="usage-number">
							Keys + sandbox
						</th>
					</tr>
				</thead>
				<tbody>
					{groups.map(group => {
						const note = pricedNote(group);
						return (
							<tr key={group.key}>
								<th scope="row">
									<span className="cost-summary-name">{words[group.key]!.name}</span>
									<span className="cost-summary-what tone-dim">{words[group.key]!.what}</span>
									{note ? <span className="cost-summary-what tone-faint">{note}</span> : null}
								</th>
								<td className="usage-number">{count(group.count)}</td>
								<td className="usage-number">{costCell(group, "median")}</td>
								<td className="usage-number">{costCell(group, "p90")}</td>
								<td className="usage-number usage-wide tone-dim">
									{group.seconds ? sandboxTime(group.seconds.median) : "–"}
								</td>
								<td className="usage-number usage-wide tone-dim">
									{group.seconds ? sandboxTime(group.seconds.p90) : "–"}
								</td>
								<td className="usage-number">
									{usd(group.modelsUsd)} + {usd(group.sandboxUsd)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</>
	);
}

/** Dollars spent on some items, with "+ N turns on your plan" and "some unknown" where they apply. */
function spentWords(spent: SpentOn): string {
	const parts = [usd(spent.usd)];
	if (spent.planTurns) parts.push(`${plural(spent.planTurns, "turn")} on your plan`);
	if (spent.unknown) parts.push("some unknown");
	return parts.join(" + ");
}

/**
 * The plan's share: the items that ran turns on a subscription plan, in turns, never in dollars. What share of the
 * plan's windows they took goes here once the platform reads it.
 */
function PlanShare({ plan }: { plan: UsageSummary["plan"] }) {
	return (
		<div>
			<dt>On your plan</dt>
			<dd className="usage-number">
				<CostFigure words={plural(plan.turns, "turn")} />
			</dd>
			<dd className="usage-gloss">
				{plan.items ? `in ${plural(plan.items, "item")}, paid by your Claude or ChatGPT plan` : "No item ran on a plan"}
			</dd>
		</div>
	);
}

/** What the summary says once read and priced. Exported for its tests. */
export function SummaryBody({ read, rates }: { read: FinishedItems; rates: CostRates }) {
	if (read.items.length === 0)
		return <p className="usage-empty cost-summary-empty">No work items ended in the last {read.days} days.</p>;
	const summary = summarize(read.items, rates);
	const { retries, abandoned } = summary;
	return (
		<>
			<dl className="usage-facts cost-summary-facts">
				<div>
					<dt>Ended</dt>
					<dd className="usage-number">
						<CostFigure words={count(summary.ended)} />
					</dd>
					<dd className="usage-gloss">{count(summary.done)} done; the tables count those</dd>
				</div>
				<div>
					<dt>Retries</dt>
					<dd className="usage-number">
						<CostFigure words={spentWords(retries)} />
					</dd>
					<dd className="usage-gloss">
						{retries.items
							? `in ${plural(retries.items, "item")}: runs started again and fixes after a failed CI`
							: "Nothing was retried"}
					</dd>
				</div>
				<div>
					<dt>Not finished</dt>
					<dd className="usage-number">
						<CostFigure words={spentWords(abandoned)} />
					</dd>
					<dd className="usage-gloss">
						{abandoned.items
							? `on ${plural(abandoned.items, "item")}: ${count(abandoned.cancelled)} cancelled, ${count(abandoned.failed)} given up or failed`
							: "Every item that ended was done"}
					</dd>
				</div>
				<PlanShare plan={summary.plan} />
			</dl>
			{summary.done ? (
				<>
					<GroupTable caption="By size" heading="Size" words={SIZE_WORDS} groups={summary.bySize} />
					<GroupTable caption="By type" heading="Type" words={TYPE_WORDS} groups={summary.byType} />
				</>
			) : (
				<p className="usage-empty">None of them was done, so there is nothing to group yet.</p>
			)}
			<p className="usage-note">
				Dollars are what your API keys paid for models plus hosted sandbox time, at today's prices. Medians and p90s
				leave out items with turns on a plan rather than guess a figure. Time runs from an item's first start to its
				end.
			</p>
		</>
	);
}

/** The Usage page's summary of finished work over a chosen period. */
export function CostSummary() {
	const [days, setDays] = useState<SummaryDays>(30);
	const { value, error } = useFinishedItems(days);
	const rates = useCostRates();
	const id = useId();
	return (
		<>
			<div className="cost-summary-head">
				<p className="usage-lede">What finished work cost, by size and by the kind of change.</p>
				<div className="segmented" role="radiogroup" aria-label="Period">
					{SUMMARY_DAYS.map(choice => (
						<label key={choice} className={`segment${days === choice ? " segment-chosen" : ""}`}>
							<input
								className="segment-radio"
								type="radio"
								name={id}
								checked={days === choice}
								onChange={() => setDays(choice)}
							/>
							{choice} days
						</label>
					))}
				</div>
			</div>
			{error ? (
				<p className="usage-empty tone-bad">The summary could not be loaded: {error}</p>
			) : value === null || value.days !== days || rates === null ? (
				<p className="usage-note" aria-busy="true">
					Reading the items that ended…
				</p>
			) : (
				<SummaryBody read={value} rates={rates} />
			)}
		</>
	);
}
