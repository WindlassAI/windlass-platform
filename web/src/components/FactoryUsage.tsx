/**
 * The usage page's part for work items: the limits for the user, which the deployment's owner sets and
 * nobody can raise from here, and what each item has cost so far against its budget: its tokens
 * cost-weighted, with what was reported beside them.
 * The usage view supplies the effective limits alongside the user's live items: every open one and
 * the newest ended ones (`ItemFeed`), and how many older ended ones there are, which the Factory page lists.
 * Shown only where the deployment offers work items. Hosted sandbox time is a limit only of an item on a
 * hosted sandbox: an item on one of the user's machines shows none.
 */
import { byteSize, compact, count, plural, sandboxTime, sandboxClock } from "../lib/format";
import { linkProps } from "../lib/router";
import { useItems } from "../screens/Items";
import { useApp } from "../state/app";
import type { FactoryLimits } from "@contract";

/** A figure spent, and of how much: "1.2M of 4M". */
function Of({ spent, budget, spell }: { spent: number; budget: number; spell(value: number): string }) {
	return (
		<>
			<span className={spent >= budget ? "tone-warn" : undefined}>{spell(spent)}</span>
			<span className="tone-faint"> / {spell(budget)}</span>
		</>
	);
}

export function FactoryUsage({ value }: { value: FactoryLimits }) {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered);
	if (!offered) return null;
	const list = items.list;
	// The feed carries the newest ended items only; the older ones are on the Factory page.
	const older = items.feed ? items.feed.counts.ended - items.feed.ended.length : 0;
	const machines = Boolean(platform.info?.machines);
	return (
		<section className="usage-section" aria-labelledby="usage-items">
			<h2 className="usage-title" id="usage-items">
				Work items
			</h2>
			<p className="usage-lede">What the platform runs for you at once, and what each item may spend before it asks you for more. Set by this deployment's owner. Your machines have no limit here: their runners' slots are theirs.</p>
			<dl className="usage-facts factory-limits">
				<div>
					<dt>Hosted sandboxes</dt>
					<dd className="usage-number">{count(value.hostedRunning)}</dd>
					<dd className="usage-gloss">running at once on this platform, work items and your own agents together; more wait their turn</dd>
				</div>
				<div>
					<dt>Each item</dt>
					<dd className="usage-number">{compact(value.item.tokens)} tokens</dd>
					<dd className="usage-gloss">
						cost-weighted: cached input counts at a tenth; and {sandboxClock(value.item.hostedSeconds)} of hosted sandbox time{machines ? " (none on your machines)" : ""}. Used up, the item asks you for more and keeps its work
					</dd>
				</div>
				<div>
					<dt>A feature</dt>
					<dd className="factory-limit-text">Its subtasks' budgets, as you approve them in its plan, and one item's for its planning, summary and review</dd>
				</div>
				<div>
					<dt>Items from GitHub</dt>
					<dd className="factory-limit-text">{count(value.githubItemsPerDay)} per UTC day, drafts among them</dd>
				</div>
				<div>
					<dt>Screenshots</dt>
					<dd className="factory-limit-text">
						{byteSize(value.attachments.bytes)} each · {count(value.attachments.perItem)} per item · {byteSize(value.attachments.accountBytes)} per account · kept for {plural(value.attachments.days, "day")} after an item ends
					</dd>
				</div>
			</dl>

			{list === null ? (
				items.error ? <p className="usage-empty tone-bad">The work items could not be loaded: {items.error}</p> : null
			) : list.length === 0 ? (
				<div className="state state-empty factory-empty">
					<p>No work items yet.</p>
				</div>
			) : (
				<table className="usage-table factory-cost">
					<thead>
						<tr>
							<th scope="col">Item, cost so far</th>
							<th scope="col" className="usage-number">
								Tokens
							</th>
							<th scope="col" className="usage-number usage-wide">
								As reported
							</th>
							<th scope="col" className="usage-number usage-wide">
								Working
							</th>
							<th scope="col" className="usage-number">
								Hosted
							</th>
						</tr>
					</thead>
					<tbody>
						{list.map((item) => (
							<tr key={item.id}>
								<th scope="row">
									<a className="usage-agent" {...linkProps({ name: "item", id: item.id })}>
										{item.title}
									</a>
								</th>
								<td className="usage-number">
									<Of spent={item.spent.tokens} budget={item.budget.tokens} spell={compact} />
								</td>
								<td className="usage-number usage-wide tone-dim">{compact(item.spent.rawTokens ?? item.spent.tokens)}</td>
								<td className="usage-number usage-wide tone-dim">{sandboxTime(item.spent.activeSeconds)}</td>
								<td className="usage-number">
									{item.place.kind === "hosted" ? <Of spent={item.spent.hostedSeconds} budget={item.budget.hostedSeconds} spell={sandboxTime} /> : <span className="tone-faint">your machine</span>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{list !== null && older > 0 ? (
				<p className="usage-note factory-cost-older">
					And {plural(older, "older ended item")}, listed under Ended on the{" "}
					<a className="link" {...linkProps({ name: "factory" })}>
						Factory page
					</a>
					.
				</p>
			) : null}
		</section>
	);
}
