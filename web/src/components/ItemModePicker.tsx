import type { ItemMode } from "@contract";
import { useId } from "react";
import { ITEM_MODE_WORDS } from "../lib/feature";

export function ItemModeCost({ id }: { id: string }) {
	return <p className="field-note" id={id}>Adds a planning turn you approve; may spend up to 3× a Quick item.</p>;
}

export function ItemModePicker({ value, disabled, onChange, costId }: { value: ItemMode; costId: string; disabled: boolean; onChange(mode: ItemMode): void }) {
	const name = useId();
	return (
		<div className="segmented" role="radiogroup" aria-label="How it runs" aria-describedby={costId}>
			{(["orchestrate", "single"] as const).map(mode => (
				<label key={mode} className={`segment${mode === value ? " segment-chosen" : ""}`} title={ITEM_MODE_WORDS[mode].description}>
					<input className="segment-radio" type="radio" name={name} value={mode} checked={mode === value} disabled={disabled} onChange={() => onChange(mode)} />
					{ITEM_MODE_WORDS[mode].name}
				</label>
			))}
		</div>
	);
}
