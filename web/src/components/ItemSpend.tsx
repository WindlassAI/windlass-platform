import type { ItemAgent, ItemBudget } from "@contract";
import type { PlanField } from "../lib/feature";
import { agentTokens } from "../lib/item-agent";

interface Props {
	spent: ItemBudget;
	budget: ItemBudget;
	fields: Pick<PlanField, "key" | "label" | "spelled">[];
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
						<dt>{field.label}</dt>
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
