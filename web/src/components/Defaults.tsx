/**
 * Defaults, in two groups, the same on a repository's page and on the account's settings page:
 *
 *   - Agents you start here: where a new agent starts (the last launch, which the server remembers
 *     and which wins until it is forgotten), then the saved hosted sandbox and model;
 *   - Work items: where they run (a place, and on a machine its profile and fallback), their agent
 *     and its model.
 *
 * Only what applies is shown, and a field left unset says what it comes to in quiet text: the
 * account's default on a repository's page, the deployment's on the account's. A default naming a
 * sandbox or model that cannot be used now is shown as saved and said to be ignored. Each field saves
 * as soon as it is chosen.
 */
import type { AccountDefaults, AccountSettings, ItemPlaceDefaults, HostedSize, LastStart, SandboxProfileId } from "@contract";
import { useId, useState } from "react";
import { HARNESS_NAMES } from "../lib/acp";
import { machineLabel } from "../lib/machines";
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

export function DefaultsSection({
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
	defaults: Saved;
	whose: "repository" | "account";
	/** The account's defaults that can be used, on a repository's page; null on the account's own. */
	under: Pick<StartingChoices, "profile" | "model"> | null;
	/** The account's saved defaults, on a repository's page: where its work items run when the repository says nothing. */
	account: ItemPlaceDefaults | null;
	models: ModelsState;
	save(change: ItemPlaceDefaults & { profile?: SandboxProfileId | null; model?: string | null; hostedSize?: HostedSize | null }): Promise<Saved>;
	onSaved(next: Saved): void;
	/** Where the last agent started: it wins over the saved sandbox until it is forgotten. Undefined while the account is read. */
	lastStart: LastStart | null | undefined;
	forgetLastStart(): Promise<AccountSettings>;
	onForgotten(next: AccountSettings): void;
}) {
	const { platform, explain } = useApp();
	const ids = { agents: useId(), items: useId(), profile: useId(), model: useId(), size: useId(), itemSize: useId(), profileNote: useId(), modelNote: useId() };
	const [saving, setSaving] = useState<"profile" | "model" | "hostedSize" | "place" | "forget" | null>(null);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const info = platform.info;
	const machines = useMachines(!!info?.machines);
	const choices = startingChoices(defaults, info, models.list, whose);
	const savedProfile = info?.profiles.find((profile) => profile.id === defaults.profile) ?? null;
	const inheritedFrom = whose === "repository" ? "account default" : "deployment default";

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
				<p className="field-note">{item ? "The same size as agents above." : "Larger costs more an hour."}</p>
			</div>
		) : null;

	const onMachine = lastStart?.place.kind === "machine";
	const startMachine = onMachine ? (machines.list?.find((machine) => machine.machineId === (lastStart!.place as { machineId: string }).machineId) ?? null) : null;
	const startWhere = !lastStart ? null : lastStart.place.kind === "hosted" ? "Hosted sandbox" : startMachine ? machineLabel(startMachine) : machines.list ? "a machine no longer yours" : "one of your machines";
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
								{lastStart ? (
									<>
										<span className="defaults-start-key">Starts on</span>
										<span className="defaults-start-value">
											{onMachine ? <MachineIcon size={13} /> : <CloudIcon size={13} />}
											{startWhere}
										</span>
										<span className="defaults-start-sep" aria-hidden="true">·</span>
										<span className="defaults-start-value">
											<AgentGlyph harness={lastStart.harness} size={11} inline />
											{HARNESS_NAMES[lastStart.harness]}
										</span>
										<span className="defaults-start-sep" aria-hidden="true">·</span>
										<span className="defaults-start-value">{modeName(lastStart.harness, lastStart.mode)}</span>
										<span className="ui-tag defaults-start-tag">last launch</span>
										<button type="button" className="link defaults-start-forget" onClick={() => void forget()} disabled={saving !== null}>
											{saving === "forget" ? "Forgetting…" : "Forget"}
										</button>
									</>
								) : (
									<>
										<span className="defaults-start-key">Starts on</span>
										<span className="defaults-start-value">
											<CloudIcon size={13} />
											Hosted · {savedProfile?.available ? savedProfile.name : (elseProfile?.name ?? "sandbox")}
										</span>
										<span className="defaults-start-sep" aria-hidden="true">·</span>
										<span className="defaults-start-value">
											<AgentGlyph harness="windlass" size={11} inline accent />
											Windlass
										</span>
									</>
								)}
							</p>
							<p className="field-note">
								{lastStart === undefined
									? "Reading where your last agent started…"
									: !lastStart
										? "Nothing remembered yet; your next launch is kept and wins until you forget it."
										: onMachine
											? "Your last launch wins until you forget it; then the hosted sandbox below."
											: "Your last launch picks place, agent and mode; the fields below fill in the rest."}
							</p>
						</div>
						<div className="defaults-fields defaults-fields-fill">
							<div className="field">
								<label className="label" htmlFor={ids.profile}>
									{onMachine ? "Otherwise" : "Where"}
								</label>
								<select id={ids.profile} className={`select${defaults.profile === null ? " is-inherited" : ""}`} value={defaults.profile ?? ""} onChange={(event) => void change("profile", { profile: (event.target.value as SandboxProfileId) || null })} disabled={saving !== null} aria-describedby={ids.profileNote}>
									<option value="">{elseProfile ? `Hosted · ${elseProfile.name} (${elseProfile.from})` : `The ${inheritedFrom}`}</option>
									<optgroup label="Hosted sandbox">
										{info.profiles
											.filter((profile) => profile.available)
											.map((profile) => (
												<option key={profile.id} value={profile.id}>
													Hosted · {profile.name}
												</option>
											))}
									</optgroup>
									{defaults.profile !== null && !savedProfile?.available ? (
										<option value={defaults.profile} disabled>
											{savedProfile?.name ?? defaults.profile} (not available)
										</option>
									) : null}
								</select>
								<p className={`field-note${choices.ignored.profile ? " tone-warn" : ""}`} id={ids.profileNote}>
									{choices.ignored.profile ?? "A machine uses its own profile."}
								</p>
							</div>
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
							{sizeField("Hosted size", false)}
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
