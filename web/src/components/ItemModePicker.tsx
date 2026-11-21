import type { ItemMode } from "@contract";
import { useId } from "react";
import { ITEM_MODE_WORDS } from "../lib/feature";

export function ItemModePicker({ value, disabled, onChange }: { value: ItemMode; disabled: boolean; onChange(mode: ItemMode): void }) {
	const name = useId();
	return (
		<div className="segmented" role="radiogroup" aria-label="How it runs">
			{(["orchestrate", "single"] as const).map(mode => (
				<label key={mode} className={`segment${mode === value ? " segment-chosen" : ""}`} title={ITEM_MODE_WORDS[mode].description}>
					<input className="segment-radio" type="radio" name={name} value={mode} checked={mode === value} disabled={disabled} onChange={() => onChange(mode)} />
					{ITEM_MODE_WORDS[mode].name}
				</label>
			))}
		</div>
	);
}
