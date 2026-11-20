/**
 * Defaults for new agents: a sandbox and a model, each saved as soon as it is chosen. The same section
 * on a repository's page, for the agents launched on that repository, and on the account's settings
 * page, for every agent where neither its launch nor its repository says otherwise.
 *
 * The start composer goes by the user's own choice, then the chosen repository's default, then the
 * account's, then what their newest agent was launched with, then the deployment's first, each field
 * by itself. So what a field left without a default
 * comes to depends on the level below: `under` is that level's defaults that can be used, the
 * account's for a repository and nothing for the account, and the notes name what it comes to. A
 * default that names a sandbox this deployment no longer offers, or a model that is not among the
 * user's, is shown as it was saved and said to be ignored. The models are the user's own
 * (`useModels`), and a line under the field says whose list it is.
 */
import type { AccountDefaults, SandboxProfileId } from "@contract";
import { useId, useState } from "react";
import { modelIds, modelsNote } from "../lib/models";
import { type StartingChoices, startingChoices } from "../lib/repositories";
import { useApp } from "../state/app";
import type { ModelsState } from "../state/hooks";

export function DefaultsSection({
	id,
	lede,
	defaults,
	whose,
	under,
	models,
	save,
	onSaved,
}: {
	/** The id of the section's heading. */
	id: string;
	/** What these defaults are for, in a sentence. */
	lede: string;
	/** A sandbox and a model: a repository's defaults carry more (`screenshots`), which this section neither shows nor saves. */
	defaults: AccountDefaults;
	whose: "repository" | "account";
	/** The defaults of the level below that can be used: the account's, on a repository's page. Null on the account's own page. */
	under: Pick<StartingChoices, "profile" | "model"> | null;
	/** The models the user may choose, as the page read them. */
	models: ModelsState;
	/** Saves the fields the change names and answers with what is saved then. */
	save(change: { profile?: SandboxProfileId | null; model?: string | null }): Promise<AccountDefaults>;
	onSaved(next: AccountDefaults): void;
}) {
	const { platform, explain } = useApp();
	const ids = { profile: useId(), model: useId(), profileNote: useId(), modelNote: useId() };
	const [saving, setSaving] = useState<"profile" | "model" | null>(null);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const info = platform.info;
	const choices = startingChoices(defaults, info, models.list, whose);
	const offered = modelIds(models.list);
	const savedProfile = info?.profiles.find((profile) => profile.id === defaults.profile) ?? null;
	// What a new agent starts with where this level has no default that can be used.
	const underProfile = under?.profile != null ? (info?.profiles.find((profile) => profile.id === under.profile && profile.available) ?? null) : null;
	const first = info?.profiles.find((profile) => profile.available) ?? null;
	const elseProfile = underProfile ? `${underProfile.name}, your account's default` : (first?.name ?? null);
	const underModel = under?.model != null && offered.includes(under.model) ? under.model : null;
	const elseModel = underModel ? `${underModel}, your account's default` : (models.list?.defaultModel ?? null);

	const change = async (field: "profile" | "model", value: string) => {
		if (saving !== null) return;
		setSaving(field);
		setSaid(null);
		try {
			onSaved(await save(field === "profile" ? { profile: value === "" ? null : (value as SandboxProfileId) } : { model: value === "" ? null : value }));
			setSaid({ tone: "good", text: "Saved." });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setSaving(null);
		}
	};

	return (
		<section className="usage-section" aria-labelledby={id}>
			<h2 className="usage-title" id={id}>
				Defaults for new agents
			</h2>
			<p className="usage-lede">{lede}</p>
			{info === null ? (
				<p className="usage-empty" aria-busy={platform.loading}>
					{platform.loading ? "Asking the server which sandboxes it has…" : (platform.error ?? "The server did not say which sandboxes it has.")}
				</p>
			) : (
				<div className="field-grid repo-fields">
					<div className="field">
						<label className="label" htmlFor={ids.profile}>
							Sandbox
						</label>
						<select id={ids.profile} className="select" value={defaults.profile ?? ""} onChange={(event) => void change("profile", event.target.value)} disabled={saving !== null} aria-describedby={ids.profileNote}>
							<option value="">No default</option>
							{info.profiles
								.filter((profile) => profile.available)
								.map((profile) => (
									<option key={profile.id} value={profile.id}>
										{profile.name}
									</option>
								))}
							{defaults.profile !== null && !savedProfile?.available ? (
								<option value={defaults.profile} disabled>
									{savedProfile?.name ?? defaults.profile} (not available)
								</option>
							) : null}
						</select>
						<p className={`field-note${choices.ignored.profile ? " tone-warn" : ""}`} id={ids.profileNote}>
							{choices.ignored.profile
								? `${choices.ignored.profile} New agents start in ${elseProfile ?? "no sandbox"} until you choose another.`
								: `Where a new agent's files live and its commands run.${defaults.profile === null && elseProfile ? ` Without a default: ${elseProfile}.` : ""}`}
						</p>
					</div>
					<div className="field">
						<label className="label" htmlFor={ids.model}>
							Model
						</label>
						<select id={ids.model} className="select" value={defaults.model ?? ""} onChange={(event) => void change("model", event.target.value)} disabled={saving !== null} aria-describedby={ids.modelNote}>
							<option value="">No default</option>
							{offered.map((model) => (
								<option key={model} value={model}>
									{model}
								</option>
							))}
							{defaults.model !== null && !offered.includes(defaults.model) ? (
								<option value={defaults.model} disabled>
									{defaults.model}
									{models.list === null ? "" : " (not offered)"}
								</option>
							) : null}
						</select>
						<p className={`field-note${choices.ignored.model ? " tone-warn" : ""}`} id={ids.modelNote}>
							{choices.ignored.model
								? `${choices.ignored.model} New agents start on ${elseModel ?? "your default model"} until you choose another.`
								: `The model a new agent starts on. It can be changed with any prompt.${defaults.model === null && elseModel ? ` Without a default: ${elseModel}.` : ""}`}
						</p>
						<p className="field-note" aria-busy={models.reading}>
							{models.list ? modelsNote(models.list) : models.reading ? "Reading your models…" : (models.error ?? "Your models could not be read.")}
						</p>
					</div>
				</div>
			)}
			<p className={`repo-said${said?.tone === "bad" ? " tone-bad" : ""}`} role={said?.tone === "bad" ? "alert" : "status"}>
				{saving !== null ? "Saving…" : (said?.text ?? "")}
			</p>
		</section>
	);
}
