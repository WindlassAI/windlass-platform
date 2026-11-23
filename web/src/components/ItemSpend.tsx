import type { ItemAgent, ItemBudget, ItemSpend as Spend } from "@contract";
import { compact } from "../lib/format";
import { agentTokens } from "../lib/item-agent";

/** A budget figure as a row: its name, and how a figure of it is said. */
export interface SpendField {
	key: keyof ItemBudget;
	label: string;
	spelled(value: number): string;
}

interface Props {
	spent: Spend;
	budget: ItemBudget;
	fields: SpendField[];
	/** The item's agent: where its tokens are not counted, the tokens row says what it reported instead of a meter. */
	agent?: ItemAgent;
}

export function ItemSpend({ spent, budget, fields, agent }: Props) {
	return (
		<dl className="usage-facts item-facts item-cost">
			{fields.map((field) => {
				const words = field.key === "tokens" ? agentTokens(agent) : null;
				if (words !== null) {
					return (
						<div key={field.key}>
							<dt>{field.label}</dt>
							<dd className="usage-number">{words}</dd>
						</div>
					);
				}
				const used = spent[field.key];
				const cap = budget[field.key];
				const reached = used >= cap;
				return (
					<div key={field.key}>
						<dt>
							{field.label}
							{/* Tokens count cost-weighted: what the agent reported is under them. */}
							{field.key === "tokens" ? <span className="tone-faint item-cost-raw">{compact(spent.rawTokens ?? spent.tokens)} as reported</span> : null}
						</dt>
						<dd className="usage-number">
							{field.spelled(used)} <span className="tone-faint">of {field.spelled(cap)}</span>
						</dd>
						<dd className="item-cost-meter">
							<span className="usage-meter" aria-hidden="true">
								<span className={`usage-meter-used${reached ? " item-meter-reached" : ""}`} style={{ width: `${cap > 0 ? Math.min(100, (used / cap) * 100) : 0}%` }} />
							</span>
							{reached ? <span className="tone-warn">reached</span> : null}
						</dd>
					</div>
				);
			})}
		</dl>
	);
}
