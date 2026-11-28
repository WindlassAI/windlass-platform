import type { CostRates, ItemSummary, ItemView } from "@contract";
import type { ItemCost as Cost } from "../../../server/src/factory/cost.js";
import { HARNESS_NAMES } from "../lib/acp";
import { costWords, lineWords, payerWords, summaryCost, usd } from "../lib/cost";
import { compact, plural, sandboxTime } from "../lib/format";
import { modelWords } from "../lib/models";
import { linkProps } from "../lib/router";
import { itemCost } from "../../../server/src/factory/cost.js";

/** The models' share of a cost in words, as `costWords` says the whole. */
function modelsWords(cost: Cost): string {
	return (
		costWords({
			...cost,
			usd: cost.models.usd,
			unknown: cost.models.unknown,
			sandbox: { usd: 0, seconds: 0, unknown: false },
		}) ?? "None yet"
	);
}

function sandboxWords(cost: Cost, view: Pick<ItemView, "place">, rates: CostRates): string {
	if (view.place.kind === "machine") return "$0.00: your machine";
	if (cost.sandbox.seconds === 0) return "None yet";
	if (rates.sandbox === null) return `${sandboxTime(cost.sandbox.seconds)}, not billed by time here`;
	const amount = cost.sandbox.unknown ? "cost unknown" : usd(cost.sandbox.usd);
	return `${amount} for ${sandboxTime(cost.sandbox.seconds)}`;
}

const modelName = (model: string) => (model === "default" ? "agent's default" : modelWords(model));

/**
 * An item's cost in dollars: the total, the models' and the sandbox's shares, each part's for a feature, and by
 * model who paid. Plans' turns say so instead of a dollar figure (lib/cost.ts); tokens are details.
 */
export function ItemCost({ view, rates }: { view: ItemView; rates: CostRates | null }) {
	if (!rates) return <p className="usage-note item-dollars-wait">Reading prices…</p>;
	const total = summaryCost(view, rates);
	const own = itemCost(view.spent.usage, rates);
	const parts: ItemSummary[] = view.children ?? [];
	return (
		<div className="item-dollars">
			<dl className="usage-facts item-facts item-cost">
				<div>
					<dt>Total</dt>
					<dd className="usage-number">{costWords(total) ?? "Nothing yet"}</dd>
				</div>
				<div>
					<dt>Models</dt>
					<dd className="usage-number">{modelsWords(total)}</dd>
				</div>
				<div>
					<dt>Sandbox</dt>
					<dd className="usage-number">{sandboxWords(total, view, rates)}</dd>
				</div>
			</dl>
			{parts.length > 0 ? (
				<table className="usage-table item-dollars-table">
					<caption className="visually-hidden">Cost of each part</caption>
					<thead>
						<tr>
							<th scope="col">Part</th>
							<th scope="col" className="usage-number">
								Cost
							</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row">Planning, review and summary</th>
							<td className="usage-number">{costWords(own) ?? "Nothing yet"}</td>
						</tr>
						{parts.map(part => (
							<tr key={part.id}>
								<th scope="row">
									<a className="link" {...linkProps({ name: "item", id: part.id })}>
										{part.title}
									</a>
								</th>
								<td className="usage-number">{costWords(summaryCost(part, rates)) ?? "Nothing yet"}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			{total.lines.length > 0 ? (
				<details className="usage-note item-dollars-models">
					<summary>By model</summary>
					<table className="usage-table item-dollars-table">
						<thead>
							<tr>
								<th scope="col">Model</th>
								<th scope="col">Paid by</th>
								<th scope="col" className="usage-number">
									Tokens
								</th>
								<th scope="col" className="usage-number">
									Cost
								</th>
							</tr>
						</thead>
						<tbody>
							{total.lines.map(line => (
								<tr key={`${line.harness}:${line.model}:${line.provider}:${line.payer}`}>
									<th scope="row">
										{HARNESS_NAMES[line.harness] ?? line.harness} · {modelName(line.model)}
									</th>
									<td>{payerWords(line)}</td>
									<td className="usage-number tone-dim">
										{compact(line.tokens.inputTokens)} in ({compact(line.tokens.cachedInputTokens)} cached),{" "}
										{compact(line.tokens.outputTokens)} out · {plural(line.turns, "turn")}
									</td>
									<td className="usage-number">{lineWords(line)}</td>
								</tr>
							))}
						</tbody>
					</table>
					{rates.source ? (
						<p>
							Token prices from {rates.source.name}, read {new Date(rates.source.fetchedAt).toISOString().slice(0, 10)}.
							Claude Code's own cost is used where it runs on an API key.
						</p>
					) : (
						<p>Token prices could not be read, so only what an agent reported of its own cost is counted.</p>
					)}
				</details>
			) : null}
		</div>
	);
}
