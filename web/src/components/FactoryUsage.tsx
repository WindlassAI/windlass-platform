/**
 * The usage page's part for work items: the factory's limits for the user, which the deployment's
 * owner sets and nobody can raise from here, and what each item has cost so far against its budget.
 * The limits are read once when the page opens; the items are the user's live list (`useItems`).
 */
import { compact, count, plural, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { useItems } from "../screens/Items";
import { useFactoryLimits } from "../state/hooks";

/** A figure spent, and of how much: "1.2M of 4M". */
function Of({ spent, budget, spell }: { spent: number; budget: number; spell(value: number): string }) {
	return (
		<>
			<span className={spent >= budget ? "tone-warn" : undefined}>{spell(spent)}</span>
			<span className="tone-faint"> / {spell(budget)}</span>
		</>
	);
}

export function FactoryUsage() {
	const items = useItems();
	const limits = useFactoryLimits();
	const { value } = limits;
	const list = items.list;
	return (
		<section className="usage-section" aria-labelledby="usage-items">
			<h2 className="usage-title" id="usage-items">
				Work items
			</h2>
			<p className="usage-lede">What the factory may run for you at once, and what each item may spend. Set by this deployment's owner.</p>
			{value === null ? (
				limits.error ? (
					<p className="usage-empty tone-bad">The limits could not be loaded: {limits.error}</p>
				) : (
					<p className="usage-empty" aria-busy="true">
						Reading the limits…
					</p>
				)
			) : (
				<dl className="usage-facts factory-limits">
					<div>
						<dt>Running turns</dt>
						<dd className="usage-number">{count(value.runningTurns)}</dd>
						<dd className="usage-gloss">of yours at once: the factory's and your own prompts, not counting your machines</dd>
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
						<dd className="usage-number">{compact(value.item.tokens)} tokens</dd>
						<dd className="usage-gloss">
							and {plural(value.item.turns, "turn")}, {sandboxTime(value.item.activeSeconds)} of work and {sandboxTime(value.item.hostedSeconds)} of hosted sandbox time; when one is used up, the item asks you
						</dd>
					</div>
				</dl>
			)}

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
									<Of spent={item.spent.hostedSeconds} budget={item.budget.hostedSeconds} spell={sandboxTime} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
