import type { ItemBudget } from "@contract";
import type { PlanField } from "../lib/feature";

interface Props {
	spent: ItemBudget;
	budget: ItemBudget;
	fields: Pick<PlanField, "key" | "label" | "spelled">[];
}

export function ItemSpend({ spent, budget, fields }: Props) {
	return (
		<dl className="usage-facts item-facts item-cost">
			{fields.map((field) => {
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
