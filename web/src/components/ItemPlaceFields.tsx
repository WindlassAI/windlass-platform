import { machineLabel, type HarnessId, type ItemPlaceDefaults, type MachineSummary, type SandboxProfileId } from "@contract";
import { useId } from "react";
import { placeMachines, profilesForItems } from "../../../server/src/factory/default-place";
import { HARNESS_NAMES } from "../lib/acp";
import { effortChoices, effortsOf, harnessOptions, modelLabel } from "../lib/models";
import { useCatalogs } from "../state/hooks";

export function ItemPlaceFields({ defaults, machines, repository, disabled, change }: {
	defaults: ItemPlaceDefaults; machines: readonly MachineSummary[]; repository: boolean; disabled: boolean;
	change(policy: ItemPlaceDefaults): void;
}) {
	const id = useId();
	const { place, harness, machineProfile, placeFallback, machineModel, machineEffort } = defaults;
	const value = typeof place === "object" ? place?.machine ?? "" : place ?? "";
	const candidates = placeMachines(place, machines);
	const agents = (Object.keys(HARNESS_NAMES) as HarnessId[]).filter(h => candidates.some(m => profilesForItems(m, h).length));
	const profiles = new Map(candidates.flatMap(m => profilesForItems(m, harness ?? "windlass").map(p => [p.id, p] as const)));
	const available = (list: readonly MachineSummary[]) => list.some(m => profilesForItems(m, "windlass").length);
	// A machine agent's models, as the first selected machine that reports them lists them.
	const catalogs = useCatalogs(candidates);
	const models = harness && harness !== "windlass" ? candidates.map(m => harnessOptions(m, harness, catalogs[m.machineId]?.[harness]).models).find(Boolean) ?? null : null;
	const efforts = effortsOf(models, machineModel ?? models?.defaultModel ?? "");
	const pick = (choice: Pick<ItemPlaceDefaults, "machineModel" | "machineEffort">) => change({ place, harness, machineProfile, placeFallback, ...choice });
	return <fieldset className="item-place-fields" disabled={disabled}>
		<legend className="usage-title">Where work items run</legend>
		<div className="field">
			<label className="label" htmlFor={id}>Place</label>
			<select className="select" id={id} value={value} onChange={e => {
				const v = e.target.value;
				change({ place: !v ? null : v === "hosted" || v === "any-machine" ? v : { machine: v }, harness: null, machineProfile: null, placeFallback: null });
			}}>
				<option value="">{repository ? "Use account default" : "Default (hosted)"}</option>
				<option value="hosted">Hosted</option>
				{machines.map(m => <option key={m.machineId} value={m.machineId} disabled={!available([m])}>{machineLabel(m)}</option>)}
				{typeof place === "object" && place && !candidates.length && <option value={value} disabled>Removed machine</option>}
				<option value="any-machine" disabled={!available(machines)}>Any of my machines</option>
			</select>
		</div>
		{place && place !== "hosted" && <>
			<div className="field">
				<label className="label" htmlFor={id + "-agent"}>Agent</label>
				<select className="select" id={id + "-agent"} value={harness ?? "windlass"} onChange={e => change({ place, harness: e.target.value as HarnessId, machineProfile: null, placeFallback })}>
					{agents.map(h => <option key={h} value={h}>{HARNESS_NAMES[h]}</option>)}
					{!agents.includes(harness ?? "windlass") && <option value={harness ?? "windlass"} disabled>{HARNESS_NAMES[harness ?? "windlass"]} (unavailable)</option>}
				</select>
			</div>
			{models || machineModel ? <div className="field">
				<label className="label" htmlFor={id + "-model"}>Agent model</label>
				<select className="select" id={id + "-model"} value={machineModel ?? ""} onChange={e => pick({ machineModel: e.target.value || null, machineEffort: null })}>
					<option value="">Agent default</option>
					{models?.models.map(m => <option key={m.id} value={m.id}>{modelLabel(models, m.id)}</option>)}
					{machineModel && !models?.models.some(m => m.id === machineModel) && <option value={machineModel} disabled>{machineModel} (unavailable)</option>}
				</select>
			</div> : null}
			{efforts.length || machineEffort ? <div className="field">
				<label className="label" htmlFor={id + "-effort"}>Agent effort</label>
				<select className="select" id={id + "-effort"} value={machineEffort ?? ""} onChange={e => pick({ machineModel, machineEffort: e.target.value || null })}>
					<option value="">Default</option>
					{effortChoices(efforts).map(effort => <option key={effort} value={effort}>{effort}</option>)}
					{machineEffort && !efforts.includes(machineEffort) && <option value={machineEffort} disabled>{machineEffort} (unavailable)</option>}
				</select>
			</div> : null}
			<div className="field">
				<label className="label" htmlFor={id + "-profile"}>Machine profile</label>
				<select className="select" id={id + "-profile"} value={machineProfile ?? ""} onChange={e => change({ place, harness, machineProfile: e.target.value as SandboxProfileId || null, placeFallback })}>
					<option value="">Agent default</option>
					{[...profiles.keys()].map(p => <option key={p} value={p}>{p === "docker-hardened" ? "Docker, hardened" : "Docker + Windlass sandbox"}</option>)}
					{machineProfile && !profiles.has(machineProfile) && <option value={machineProfile} disabled>{machineProfile} (unavailable)</option>}
				</select>
			</div>
			<div className="field">
				<label className="label" htmlFor={id + "-fallback"}>If unavailable</label>
				<select className="select" id={id + "-fallback"} value={placeFallback ?? "wait"} onChange={e => change({ place, harness, machineProfile, placeFallback: e.target.value as "wait" | "hosted" })}>
					<option value="wait">Wait for a machine</option><option value="hosted">Run hosted with Windlass</option>
				</select>
			</div>
		</>}
	</fieldset>;
}
