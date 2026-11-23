/**
 * The usage page's part for work items: the factory's limits for the user, which the deployment's
 * owner sets and nobody can raise from here, and what each item has cost so far against its budget.
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
			<p className="usage-lede">What the factory may run for you at once, and what each item may spend. Set by this deployment's owner.</p>
			<dl className="usage-facts factory-limits">
				<div>
					<dt>Running turns</dt>
					<dd className="usage-number">{count(value.runningTurns)}</dd>
					<dd className="usage-gloss">of yours at once: the factory's and your own prompts; your own agents on your machines are not counted</dd>
				</div>
				<div>
					<dt>Factory turns</dt>
					<dd className="usage-number">{count(value.factoryTurns)}</dd>
					<dd className="usage-gloss">of those, for work items; the rest stay free for your own prompts</dd>
				</div>
				<div>
					<dt>Sandboxes</dt>
					<dd className="usage-number">{count(value.hostedRunning)}</dd>
					<dd className="usage-gloss">hosted sandboxes of yours running at once</dd>
				</div>
				<div>
					<dt>In review</dt>
					<dd className="usage-number">{count(value.reviewCap)}</dd>
					<dd className="usage-gloss">items of yours in review before new ones wait; work already started goes on</dd>
				</div>
				<div>
					<dt>Each item</dt>
					<dd className="usage-number">{count(value.item.tokens)} tokens</dd>
					<dd className="usage-gloss">
						and {plural(value.item.turns, "turn")}, {sandboxClock(value.item.activeSeconds)} of work and {sandboxClock(value.item.hostedSeconds)} of hosted sandbox time{machines ? " (none on your machines)" : ""}; when one is used up, the item asks you
					</dd>
				</div>
				<div>
					<dt>Feature budget</dt>
					<dd className="factory-limit-text">{value.featureMultiplier}× the item budget</dd>
				</div>
				<div>
					<dt>Items from GitHub</dt>
					<dd className="factory-limit-text">{count(value.githubItemsPerDay)} per UTC day · {count(value.githubDrafts)} open drafts</dd>
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
								Turns
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
								<td className="usage-number usage-wide">
									<Of spent={item.spent.turns} budget={item.budget.turns} spell={count} />
								</td>
								<td className="usage-number usage-wide">
									<Of spent={item.spent.activeSeconds} budget={item.budget.activeSeconds} spell={sandboxTime} />
								</td>
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
