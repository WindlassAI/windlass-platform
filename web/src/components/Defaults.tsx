import type { AccountDefaults, AccountSettings, RepositoryDefaultsPatch, HostedSize, LastStart, SandboxProfileId } from "@contract";
import { resolveStartPlace, startProfiles } from "../../../server/src/start-place";
import { useId, useState } from "react";
import { HARNESS_NAMES } from "../lib/acp";
import { machineLabel, machineProfileName } from "../lib/machines";
import { modeName } from "../lib/modes";
import { sizeLabel, sizeName, startingSize } from "../lib/sizes";
import { type StartingChoices, startingChoices } from "../lib/repositories";
import { CloudIcon, MachineIcon } from "./Icons";
import { ItemPlaceFields, placeWords } from "./ItemPlaceFields";
import { ModelSelect, modelDisplay } from "./ModelPicker";
import { useMachines } from "../screens/Machines";
import { useApp } from "../state/app";
import type { ModelsState } from "../state/hooks";
import { AgentGlyph } from "./ui/Pill";

type Saved = AccountDefaults & { hostedSize?: HostedSize | null };

export function DefaultsSection<T extends Saved>({
	id,
	lede,
	defaults,
	whose,
	under,
	account,
	models,
	save,
	onSaved,
	lastStart,
	forgetLastStart,
	onForgotten,
}: {
	/** The id of the section's heading. */
	id: string;
	/** What these defaults are for, in a sentence. */
	lede: string;
	defaults: T;
	whose: "repository" | "account";
	/** The account's defaults that can be used, on a repository's page; null on the account's own. */
	under: Pick<StartingChoices, "profile" | "model"> | null;
	/** The account defaults a repository inherits. */
	account: AccountDefaults | null;
	models: ModelsState;
	save(change: RepositoryDefaultsPatch): Promise<T>;
	onSaved(next: T): void;
	/** Where the last agent started. Its place wins until forgotten. Undefined while the account is read. */
	lastStart: LastStart | null | undefined;
	forgetLastStart(): Promise<AccountSettings>;
	onForgotten(next: AccountSettings): void;
}) {
	const { platform, explain } = useApp();
	const ids = { agents: useId(), items: useId(), where: useId(), profile: useId(), model: useId(), size: useId(), itemSize: useId(), modelNote: useId() };
	const [saving, setSaving] = useState<"profile" | "model" | "hostedSize" | "place" | "forget" | null>(null);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const info = platform.info;
	const machines = useMachines(!!info?.machines);
	const choices = startingChoices(defaults, info, models.list, whose);
	const inheritedFrom = whose === "repository" ? "account default" : "deployment default";
	const savedProfile = info?.profiles.find((profile) => profile.id === defaults.profile) ?? null;

	// What an unset field comes to: the account's usable default on a repository's page, else the deployment's.
	const underProfile = under?.profile != null ? (info?.profiles.find((profile) => profile.id === under.profile && profile.available) ?? null) : null;
	const first = info?.profiles.find((profile) => profile.available) ?? null;
	const elseProfile = underProfile ? { from: "account default", name: underProfile.name } : first ? { from: "deployment default", name: first.name } : null;
	const underModel = under?.model != null && models.list?.models.some((model) => model.id === under.model) ? under.model : null;
	const elseModel = underModel ? { from: "account default", id: underModel } : models.list ? { from: "deployment default", id: models.list.defaultModel } : null;
	const effectiveModel = defaults.model ?? elseModel?.id ?? "";

	// Hosted sizes, where the deployment offers more than one: saved for a repository only (its agents and its work items).
	const sizes = whose === "repository" ? (info?.hostedSizes ?? []) : [];
	const savedSize = defaults.hostedSize ?? null;

	const persist = async (field: NonNullable<typeof saving>, run: () => Promise<void>) => {
		if (saving !== null) return;
		setSaving(field);
		setSaid(null);
		try {
			await run();
			setSaid({ tone: "good", text: field === "forget" ? "Forgotten." : "Saved." });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setSaving(null);
		}
	};
	const change = (field: "profile" | "model" | "hostedSize" | "place", patch: Parameters<typeof save>[0]) => persist(field, async () => onSaved(await save(patch)));

	const sizeField = (label: string, item: boolean) =>
		sizes.length > 1 ? (
			<div className="field" key={label}>
				<label className="label" htmlFor={item ? ids.itemSize : ids.size}>
					{label}
				</label>
				<select id={item ? ids.itemSize : ids.size} className={`select${savedSize === null ? " is-inherited" : ""}`} value={savedSize ?? ""} onChange={(event) => void change("hostedSize", { hostedSize: (event.target.value as HostedSize) || null })} disabled={saving !== null}>
					<option value="">{`${sizeName(startingSize(sizes, null, item))} (deployment default)`}</option>
					{sizes.map((size) => (
						<option key={size.id} value={size.id}>
							{sizeLabel(size)}
						</option>
					))}
				</select>
				<p className="field-note">{item ? "Also used for hosted agents." : "Larger costs more an hour."}</p>
			</div>
		) : null;

	const machinesReading = !!info?.machines && machines.list === null && machines.error === null;
	const inventory = machinesReading ? null : (info?.machines ? machines.list ?? [] : []);
	const place = defaults.startPlace;
	const repositoryPlace = whose === "repository" ? place : null;
	const accountPlace = whose === "account" ? place : account?.startPlace;
	const start = resolveStartPlace({ last: lastStart?.place, repository: repositoryPlace, account: accountPlace, machines: inventory });
	const inherited = resolveStartPlace({ account: account?.startPlace, machines: inventory });
	const remembered = start.source === "last launch" ? lastStart : null;
	const reading = start.pending || lastStart === undefined;
	const savedMachine = place?.kind === "machine" ? inventory?.find(m => m.machineId === place.machineId) : null;
	const profiles = savedMachine ? startProfiles(savedMachine) : [];
	const selectedWhere = place?.kind === "machine" ? place.machineId : place?.kind ?? "";
	const selectWhere = (value: string) => {
		if (!value || value === "hosted") return change("place", { startPlace: value ? { kind: "hosted" } : null });
		const machine = inventory?.find(m => m.machineId === value);
		const profile = machine && startProfiles(machine)[0];
		if (profile) return change("place", { startPlace: { kind: "machine", machineId: value, profile: profile.id } });
	};
	const inheritedName = inherited.machine ? machineLabel(inherited.machine) : "Hosted";
	const showHosted = place?.kind === "hosted" || (!place && !inherited.machine && !inherited.pending);
	const forget = () => persist("forget", async () => onForgotten(await forgetLastStart()));

	return (
		<section className="usage-section" aria-labelledby={id}>
			<h2 className="usage-title" id={id}>
				Defaults
			</h2>
			<p className="usage-lede">{lede}</p>
			{info === null ? (
				<p className="usage-empty" aria-busy={platform.loading}>
					{platform.loading ? "Asking the server which sandboxes it has…" : (platform.error ?? "The server did not say which sandboxes it has.")}
				</p>
			) : (
				<div className="repo-fields defaults">
					<section className="defaults-group" aria-labelledby={ids.agents}>
						<h3 className="defaults-title" id={ids.agents}>
							Agents you start here
						</h3>
						<div className="defaults-start">
							<p className="defaults-start-line" data-testid="last-start">
								<span className="defaults-start-key">Starts on</span>
								<span className="defaults-start-value">
									{reading ? "Reading…" : start.machine ? <><MachineIcon size={13} />{machineLabel(start.machine)}</> : <><CloudIcon size={13} />Hosted</>}
								</span>
								{remembered && !reading && <>
									<span className="defaults-start-sep" aria-hidden="true">·</span>
									<span className="defaults-start-value"><AgentGlyph harness={remembered.harness} size={11} inline />{HARNESS_NAMES[remembered.harness]}</span>
									<span className="defaults-start-sep" aria-hidden="true">·</span>
									<span className="defaults-start-value">{modeName(remembered.harness, remembered.mode)}</span>
								</>}
								{!reading && <span className="ui-tag defaults-start-tag">{start.source}</span>}
								{lastStart && <button type="button" className="link defaults-start-forget" onClick={() => void forget()} disabled={saving !== null}>
									{saving === "forget" ? "Forgetting…" : "Forget"}
								</button>}
							</p>
							{start.notes.length ? <p className="field-note tone-warn">{start.notes.join(" ")} Using the {start.source}.</p>
								: machines.error ? <p className="field-note tone-warn">{machines.error}</p>
								: !reading && <p className="field-note">{lastStart ? "Your last launch wins until you forget it." : "Nothing remembered yet. Your next launch will be remembered."}</p>}
						</div>
						<div className="defaults-fields defaults-fields-fill">
							<div className="field">
								<label className="label" htmlFor={ids.where}>Where</label>
								<select id={ids.where} className={`select${!place ? " is-inherited" : ""}`} value={selectedWhere} onChange={e => void selectWhere(e.target.value)} disabled={saving !== null || machinesReading}>
									<option value="">{inherited.pending ? "Reading machines…" : `${inheritedName} (${inherited.source})`}</option>
									<option value="hosted">Hosted</option>
									{inventory?.length ? <optgroup label="Your machines">
										{inventory.map(m => <option key={m.machineId} value={m.machineId} disabled={!startProfiles(m).length}>{machineLabel(m)}</option>)}
									</optgroup> : null}
									{place?.kind === "machine" && !savedMachine && <option value={place.machineId} disabled>{inventory ? "Removed machine" : "Machine"}</option>}
								</select>
								{!place && inherited.profile && <p className="field-note">{machineProfileName(inherited.profile)}</p>}
							</div>
							{place?.kind === "machine" && savedMachine && <div className="field">
								<label className="label" htmlFor={ids.profile}>Machine profile</label>
								<select id={ids.profile} className="select" value={place.profile} onChange={e => void change("place", { startPlace: { ...place, profile: e.target.value as SandboxProfileId } })} disabled={saving !== null}>
									{profiles.map(p => <option key={p.id} value={p.id}>{machineProfileName(p.id)}</option>)}
									{!profiles.some(p => p.id === place.profile) && <option value={place.profile} disabled>{machineProfileName(place.profile)} (unavailable)</option>}
								</select>
							</div>}
							{showHosted && <div className="field">
								<label className="label" htmlFor={ids.profile}>Hosted sandbox</label>
								<select id={ids.profile} className={`select${defaults.profile === null ? " is-inherited" : ""}`} value={defaults.profile ?? ""} onChange={e => void change("profile", { profile: (e.target.value as SandboxProfileId) || null })} disabled={saving !== null}>
									<option value="">{elseProfile ? `${elseProfile.name} (${elseProfile.from})` : "Deployment default"}</option>
									{info.profiles.filter(p => p.available).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
									{defaults.profile && !savedProfile?.available && <option value={defaults.profile} disabled>{savedProfile?.name ?? defaults.profile} (unavailable)</option>}
								</select>
								{choices.ignored.profile && <p className="field-note tone-warn">{choices.ignored.profile}</p>}
							</div>}
							<div className="field">
								<label className="label" htmlFor={ids.model}>
									Model
								</label>
								<ModelSelect
									id={ids.model}
									harness="windlass"
									list={models.list}
									value={defaults.model ?? ""}
									inherit={{ label: elseModel ? `${modelDisplay("windlass", models.list, elseModel.id)} (${elseModel.from})` : `The ${inheritedFrom}` }}
									onChange={(model) => void change("model", { model: model || null })}
									disabled={saving !== null}
									describedBy={ids.modelNote}
								/>
								<p className={`field-note${choices.ignored.model ? " tone-warn" : ""}`} id={ids.modelNote} aria-busy={models.reading}>
									{choices.ignored.model ?? (models.list ? "Change it with any prompt." : models.reading ? "Reading your models…" : (models.error ?? "Your models could not be read."))}
								</p>
							</div>
							{showHosted && sizeField("Hosted size", false)}
						</div>
					</section>
					{info.items ? (
						<section className="defaults-group" aria-labelledby={ids.items}>
							<h3 className="defaults-title" id={ids.items}>
								Work items
							</h3>
							<ItemPlaceFields
								defaults={defaults}
								machines={machines.list ?? []}
								inherited={whose === "repository" && account?.place ? `${placeWords(account, machines.list)} (account default)` : "Hosted sandbox (deployment default)"}
								disabled={saving !== null || (!!info.machines && machines.list === null && !machines.error)}
								change={(patch) => void change("place", patch)}
								size={sizes.length > 1 ? sizeField : null}
								windlassModel={effectiveModel ? modelDisplay("windlass", models.list, effectiveModel) : "your default model"}
							/>
						</section>
					) : null}
				</div>
			)}
			<p className={`repo-said${said?.tone === "bad" ? " tone-bad" : ""}`} role={said?.tone === "bad" ? "alert" : "status"}>
				{saving !== null ? (saving === "forget" ? "Forgetting…" : "Saving…") : (said?.text ?? "")}
			</p>
		</section>
	);
}
