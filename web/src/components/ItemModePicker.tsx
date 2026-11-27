import type { ItemMode } from "@contract";
import { useId } from "react";
import { ITEM_MODE_WORDS } from "../lib/feature";

/** What the chosen mode costs, in one quiet line under the picker. */
export function ItemModeCost({ id, mode }: { id: string; mode: ItemMode }) {
	return (
		<p className="field-note item-mode-cost" id={id}>
			{mode === "orchestrate"
				? "Adds a planning turn you approve. The feature may spend what you approve for its subtasks, and one Quick item's budget for its planning and review."
				: "Starts one implementer at once, with no plan to approve."}
		</p>
	);
}

export function ItemModePicker({
	value,
	disabled,
	onChange,
	costId,
}: {
	value: ItemMode;
	costId: string;
	disabled: boolean;
	onChange(mode: ItemMode): void;
}) {
	const name = useId();
	return (
		<div className="segmented" role="radiogroup" aria-label="How it runs" aria-describedby={costId}>
			{(["orchestrate", "single"] as const).map(mode => (
				<label
					key={mode}
					className={`segment${mode === value ? " segment-chosen" : ""}`}
					title={ITEM_MODE_WORDS[mode].description}
				>
					<input
						className="segment-radio"
						type="radio"
						name={name}
						value={mode}
						checked={mode === value}
						disabled={disabled}
						onChange={() => onChange(mode)}
					/>
					{ITEM_MODE_WORDS[mode].name}
				</label>
			))}
		</div>
	);
}
