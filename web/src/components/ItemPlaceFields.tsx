import { machineLabel, type HarnessId, type ItemPlaceDefaults, type MachineSummary, type SandboxProfileId } from "@contract";
import { useId, type ReactNode } from "react";
import { placeMachines, profilesForItems } from "../../../server/src/factory/default-place";
import { machineProfileName } from "../lib/machines";
import { HARNESS_NAMES } from "../lib/acp";
import { effortsOf, harnessOptions } from "../lib/models";
import { useCatalogs } from "../state/hooks";
import { EffortSelect, ModelSelect, agentDefaultLabel, modelDisplay } from "./ModelPicker";


/** A saved work-item place in a few words: "nas · Claude Code · waits". */
export function placeWords(policy: ItemPlaceDefaults, machines: readonly MachineSummary[] | null): string {
	const { place, harness, placeFallback } = policy;
	if (!place || place === "hosted") return "Hosted";
	const where = place === "any-machine" ? "Any of my machines" : (machines?.find((m) => m.machineId === place.machine) ? machineLabel(machines.find((m) => m.machineId === place.machine)!) : "a removed machine");
	return [where, HARNESS_NAMES[harness ?? "windlass"], placeFallback === "hosted" ? "else hosted" : "waits"].join(" · ");
}

/**
 * Where work items run, as the composer says it: the place, and for a machine its profile and what
 * happens when it is unavailable; then the agent and its model. Only what applies is shown: the
 * hosted size where the item (or its fallback) runs hosted, nothing below the place while it is
 * inherited. `size` draws the hosted size field under the label it is given.
 */
export function ItemPlaceFields({ defaults, machines, inherited, disabled, change, size, windlassModel }: {
	defaults: ItemPlaceDefaults;
	machines: readonly MachineSummary[];
	/** What an unset place comes to, said in the empty choice: "Account default: nas · Windlass · waits". */
	inherited: string;
	disabled: boolean;
	change(policy: ItemPlaceDefaults): void;
	/** The hosted size field, under this label; null where sizes are not offered. */
	size: ((label: string, item: true) => ReactNode) | null;
	/** The model Windlass work items start on: the agents' default above. */
	windlassModel: string;
}) {
	const id = useId();
	const { place, harness, machineProfile, placeFallback, machineModel, machineEffort } = defaults;
	const value = typeof place === "object" ? (place?.machine ?? "") : (place ?? "");
	const candidates = placeMachines(place, machines);
	const agents = (Object.keys(HARNESS_NAMES) as HarnessId[]).filter((h) => candidates.some((m) => profilesForItems(m, h).length));
	const agent = harness ?? "windlass";
	const profiles = new Map(candidates.flatMap((m) => profilesForItems(m, agent).map((p) => [p.id, p] as const)));
	const available = (list: readonly MachineSummary[]) => list.some((m) => profilesForItems(m, "windlass").length);
	// A machine agent's models, as the first selected machine that reports them lists them.
	const catalogs = useCatalogs(candidates);
	const reporting = agent === "windlass" ? null : (candidates.find((m) => harnessOptions(m, agent, catalogs[m.machineId]?.[agent]).models) ?? null);
	const models = reporting && agent !== "windlass" ? harnessOptions(reporting, agent, catalogs[reporting.machineId]?.[agent]).models : null;
	const efforts = effortsOf(models, machineModel ?? models?.defaultModel ?? "");
	const pick = (choice: Pick<ItemPlaceDefaults, "machineModel" | "machineEffort">) => change({ place, harness, machineProfile, placeFallback, ...choice });
	const onMachine = !!place && place !== "hosted";
	const fallback = placeFallback ?? "wait";
	const firstProfile = [...profiles.keys()][0];

	return (
		<fieldset className="defaults-fields" disabled={disabled}>
			<legend className="visually-hidden">Where work items run</legend>
			<div className="field">
				<label className="label" htmlFor={id}>
					Where
				</label>
				<select
					className={`select${value === "" ? " is-inherited" : ""}`}
					id={id}
					value={value}
					onChange={(e) => {
						const v = e.target.value;
						change({ place: !v ? null : v === "hosted" || v === "any-machine" ? v : { machine: v }, harness: null, machineProfile: null, placeFallback: null });
					}}
				>
					<option value="">{inherited}</option>
					<option value="hosted">Hosted sandbox</option>
					{machines.length ? (
						<optgroup label="Your machines">
							{machines.map((m) => (
								<option key={m.machineId} value={m.machineId} disabled={!available([m])}>
									{machineLabel(m)}
								</option>
							))}
							<option value="any-machine" disabled={!available(machines)}>
								Any of my machines
							</option>
						</optgroup>
					) : null}
					{typeof place === "object" && place && !candidates.length && (
						<option value={value} disabled>
							Removed machine
						</option>
					)}
				</select>
				{!onMachine && place === "hosted" ? <p className="field-note">Windlass, on the model above.</p> : null}
			</div>
			{onMachine && (
				<>
					<div className="field">
						<label className="label" htmlFor={id + "-profile"}>
							Machine profile
						</label>
						<select className={`select${machineProfile ? "" : " is-inherited"}`} id={id + "-profile"} value={machineProfile ?? ""} onChange={(e) => change({ place, harness, machineProfile: (e.target.value as SandboxProfileId) || null, placeFallback })}>
							<option value="">{firstProfile ? `${machineProfileName(firstProfile)} (default)` : "The agent's default"}</option>
							{[...profiles.keys()].map((p) => (
								<option key={p} value={p}>
									{machineProfileName(p)}
								</option>
							))}
							{machineProfile && !profiles.has(machineProfile) && (
								<option value={machineProfile} disabled>
									{machineProfileName(machineProfile)} (unavailable)
								</option>
							)}
						</select>
					</div>
					<div className="field">
						<label className="label" htmlFor={id + "-fallback"}>
							If unavailable
						</label>
						<select className="select" id={id + "-fallback"} value={fallback} onChange={(e) => change({ place, harness, machineProfile, placeFallback: e.target.value as "wait" | "hosted" })}>
							<option value="wait">Wait for a machine</option>
							<option value="hosted">Run hosted with Windlass</option>
						</select>
					</div>
					<div className="field">
						<label className="label" htmlFor={id + "-agent"}>
							Agent
						</label>
						<select className="select" id={id + "-agent"} value={agent} onChange={(e) => change({ place, harness: e.target.value as HarnessId, machineProfile: null, placeFallback })}>
							{agents.map((h) => (
								<option key={h} value={h}>
									{HARNESS_NAMES[h]}
								</option>
							))}
							{!agents.includes(agent) && (
								<option value={agent} disabled>
									{HARNESS_NAMES[agent]} (unavailable)
								</option>
							)}
						</select>
						{agent === "windlass" ? <p className="field-note">On {windlassModel}, the model above.</p> : null}
					</div>
					{agent !== "windlass" && (models || machineModel) ? (
						<div className="field">
							<label className="label" htmlFor={id + "-model"}>
								Model
							</label>
							<ModelSelect
								id={id + "-model"}
								harness={agent}
								list={models}
								value={machineModel ?? ""}
								inherit={{ label: agentDefaultLabel(agent, models) }}
								entry={reporting?.harnesses?.find((h) => h.id === agent) ?? null}
								machine={reporting ? machineLabel(reporting) : null}
								onChange={(model) => pick({ machineModel: model || null, machineEffort: null })}
								disabled={disabled}
							/>
						</div>
					) : null}
					{agent !== "windlass" && (efforts.length || machineEffort) ? (
						<div className="field field-effort">
							<label className="label" htmlFor={id + "-effort"}>
								Effort
							</label>
							<EffortSelect id={id + "-effort"} efforts={efforts} value={machineEffort ?? ""} model={modelDisplay(agent, models, machineModel ?? models?.defaultModel ?? "")} onChange={(level) => pick({ machineModel, machineEffort: level && level !== "default" ? level : null })} disabled={disabled} />
						</div>
					) : null}
					{fallback === "hosted" ? size?.("Hosted size if it falls back", true) : null}
				</>
			)}
			{place === "hosted" ? size?.("Hosted size", true) : null}
		</fieldset>
	);
}
