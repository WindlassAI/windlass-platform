/**
 * New agent: the sandbox it works in (the centrepiece: every profile as a card, with its layers
 * drawn as they nest and three plain facts), then the model, an optional repository and title, and
 * the first prompt. Creating opens the session.
 *
 * The repository is a pasted address, as it always was. Where the deployment has a GitHub App, a
 * connected user picks one of their own instead, with the branch to start from, and a user who is not
 * connected is offered to connect: that leaves the page, so what the form holds is kept and put back.
 * A repository picked that way can be published to: whether the agent may do that without asking is
 * chosen here for the session (it can be changed in the session's panel).
 * A repository picked that way has a setup command, the user's own: the field shows what is saved for
 * it, and what it holds is saved with the launch (components/SetupCommand.tsx).
 *
 * A repository picked that way can also have defaults, saved on its page: the sandbox and the model
 * the form starts from once it is picked. A choice the user makes in the form itself comes first and
 * is for this agent only; a default that names a sandbox or a model the deployment no longer offers is
 * left out, and the form says so. Opened from a repository's page, the form has that repository chosen.
 *
 * An agent can always be created; what a limit refuses is its first prompt, which starts a sandbox.
 * So the form says beforehand when the day's sandbox time is used up or the user keeps as many
 * sandboxes as they may, and a prompt that is refused all the same goes with the user to the agent's
 * screen, where the composer keeps it and says why.
 */
import { MAX_PROMPT_CHARS, MAX_TITLE_CHARS, USAGE_LOW_SHARE, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, type UsageNumbers } from "@contract";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Dialog } from "../components/Dialog";
import { WarnIcon } from "../components/Icons";
import { Layers, ProfileFacts } from "../components/Layers";
import { RepositoryPicker, type PickedRepository } from "../components/RepositoryPicker";
import { SecretsField } from "../components/Secrets";
import { PublishUnaskedCheck, publishAlwaysAsked } from "../components/PullRequest";
import { SetupField, useSetupDraft } from "../components/SetupCommand";
import { isLimitRefusal } from "../api/errors";
import { localTime, sandboxTime } from "../lib/format";
import { startingChoices, startingModel, startingProfile, type StartingChoices } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { allowanceState, useAllowance } from "../state/hooks";
import { takeLaunchDraft, useGithub } from "../state/github";
import { handOver } from "../state/handover";

function ProfileCard({ profile, name, checked, onChoose }: { profile: SandboxProfile; name: string; checked: boolean; onChoose(id: SandboxProfileId): void }) {
	const id = useId();
	const reasonId = `${id}-reason`;
	return (
		<label className={`profile${checked ? " profile-chosen" : ""}${profile.available ? "" : " profile-unavailable"}`} htmlFor={id}>
			<input id={id} className="profile-radio" type="radio" name={name} value={profile.id} checked={checked} disabled={!profile.available} onChange={() => onChoose(profile.id)} aria-describedby={profile.available ? undefined : reasonId} />
			<span className="profile-head">
				<span className="profile-pick" aria-hidden="true" />
				<span className="profile-name">{profile.name}</span>
				{profile.available ? null : <span className="chip">not available</span>}
			</span>
			<span className="profile-summary">{profile.summary}</span>
			<Layers profile={profile} compact={!profile.available} />
			{profile.available ? (
				<ProfileFacts profile={profile} />
			) : (
				<span className="profile-reason" id={reasonId}>
					<strong>Why not yet.</strong> {profile.unavailableReason ?? "This deployment cannot run it."}
				</span>
			)}
		</label>
	);
}

/**
 * What the chosen repository's defaults did to the form, said beside the repository: the sandbox is
 * chosen further up, so a change of it there would otherwise go unseen. `used` says which defaults the
 * form stands on now; a default the user chose over can be taken back with one press.
 */
function DefaultsNote({
	repository,
	defaults,
	used,
	profileName,
	error,
	disabled,
	onUseDefaults,
}: {
	repository: string;
	defaults: StartingChoices;
	used: { profile: boolean; model: boolean };
	profileName: string | null;
	error: string | null;
	disabled: boolean;
	onUseDefaults(): void;
}) {
	const applied = [used.profile && profileName ? `in ${profileName}` : null, used.model && defaults.model ? `on ${defaults.model}` : null].filter((part) => part !== null);
	const passed = [defaults.profile !== null && !used.profile ? `sandbox (${profileName ?? defaults.profile})` : null, defaults.model !== null && !used.model ? `model (${defaults.model})` : null].filter((part) => part !== null);
	const ignored = [defaults.ignored.profile, defaults.ignored.model].filter((part) => part !== null);
	if (applied.length === 0 && passed.length === 0 && ignored.length === 0 && error === null) return null;
	return (
		<div className="field field-wide new-agent-defaults" role="status">
			{applied.length > 0 ? (
				<p className="field-note">
					This agent starts {applied.join(" and ")}: the {applied.length === 1 ? "default" : "defaults"} saved for {repository}. Choose otherwise above and it holds for this agent only.
				</p>
			) : null}
			{passed.length > 0 ? (
				<p className="field-note">
					{repository} has a default {passed.join(" and a default ")}; this agent uses what you chose instead.{" "}
					<button type="button" className="link" onClick={onUseDefaults} disabled={disabled}>
						Use the {passed.length === 1 ? "default" : "defaults"}
					</button>
				</p>
			) : null}
			{ignored.map((sentence) => (
				<p key={sentence} className="field-note tone-warn">
					{sentence} Change it on the repository's page.
				</p>
			))}
			{error !== null ? (
				<p className="field-note tone-warn">
					The defaults saved for {repository} could not be read, so this form starts from the deployment's: {error}
				</p>
			) : null}
		</div>
	);
}

/** What launching runs into now, before anything is sent: `warn` when the agent could not start at all. */
function launchLimit(numbers: UsageNumbers | null): { text: string; warn: boolean } | null {
	if (numbers === null) return null;
	const left = allowanceState(numbers, USAGE_LOW_SHARE);
	const resets = localTime(numbers.resetsAt);
	if (left === "used") return { warn: true, text: `Today's sandbox time is used up. An agent launched now is created, and cannot start working before ${resets}, when the allowance is whole again.` };
	const { kept, limit } = numbers.sandboxes;
	if (limit !== null && kept >= limit) return { warn: true, text: `You keep ${limit} sandboxes, the most an account may have. An agent launched now is created, and cannot start working until you free a sandbox.` };
	if (left === "low" && numbers.leftSeconds !== null) return { warn: false, text: `${sandboxTime(numbers.leftSeconds)} of today's sandbox time is left. A turn that runs longer is stopped, with its files kept; the allowance is whole again at ${resets}.` };
	return null;
}

/** What is saved as the defaults of the repository that is chosen: read when the choice changes. `defaults` is null while it is read and when it could not be. */
function useDefaults(repositoryId: number | null): { defaults: RepositoryDefaults | null; reading: boolean; error: string | null } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ repositoryId: number | null; defaults: RepositoryDefaults | null; error: string | null }>({ repositoryId: null, defaults: null, error: null });
	useEffect(() => {
		setState({ repositoryId, defaults: null, error: null });
		if (repositoryId === null) return;
		let current = true;
		client
			.user(auth)
			.repository(repositoryId)
			.then(
				(view) => current && setState({ repositoryId, defaults: view.defaults, error: null }),
				(failure: unknown) => current && setState({ repositoryId, defaults: null, error: explain(failure) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId]);
	// What was read for another repository is not this one's.
	const mine = state.repositoryId === repositoryId;
	return { defaults: mine ? state.defaults : null, reading: repositoryId !== null && (!mine || (state.defaults === null && state.error === null)), error: mine ? state.error : null };
}

/** `repositoryId`: GitHub's id for the repository the form opens with, when it was opened from that repository's page. */
export function NewAgent({ repositoryId }: { repositoryId?: number } = {}) {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const info = platform.info;
	const group = useId();
	const ids = { model: useId(), repo: useId(), repoLabel: useId(), title: useId(), prompt: useId(), repoNote: useId() };
	const github = useGithub();
	const limit = launchLimit(useAllowance());
	// What the form held before its user left to connect GitHub, once.
	const [draft] = useState(takeLaunchDraft);

	// The user's own choices in this form: none until they make one, so that a repository's defaults can stand in.
	const [profileChoice, setProfile] = useState<SandboxProfileId | null>((draft?.profile as SandboxProfileId | null | undefined) ?? null);
	const [modelChoice, setModel] = useState(draft?.model ?? "");
	const [repoUrl, setRepoUrl] = useState(draft?.repoUrl ?? "");
	const [title, setTitle] = useState(draft?.title ?? "");
	const [prompt, setPrompt] = useState(draft?.prompt ?? "");
	const [picked, setPicked] = useState<PickedRepository | null>(null);
	// The repository the form was opened with, while GitHub is asked for it, and why it could not be chosen.
	const [opening, setOpening] = useState<{ reading: boolean; error: string | null }>({ reading: repositoryId !== undefined, error: null });
	// Whether the agent may publish without asking: off unless its user says otherwise.
	const [publishUnasked, setPublishUnasked] = useState(false);
	// Where the repository comes from: the user's choice once they made one, otherwise GitHub when it is connected.
	const [chosenSource, setChosenSource] = useState<"github" | "address" | null>(draft?.repoUrl ? "address" : null);
	const [busy, setBusy] = useState<"creating" | "prompting" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Back from GitHub: the form opens where its user left it, at the repository.
	const returned = github.notice?.where === "launch" || github.busy === "finishing";
	useEffect(() => {
		if (returned && info) document.getElementById(ids.repo)?.scrollIntoView({ block: "center" });
	}, [returned, info, ids.repo]);

	const close = () => navigate(repositoryId === undefined ? { name: "home" } : { name: "repository", id: repositoryId });
	const connection = github.enabled ? (github.status?.connection ?? null) : null;
	const connected = connection !== null;

	// Opened from a repository's page: GitHub says what that repository is now, and it is chosen.
	const knowsConnection = !github.enabled || github.status !== null || github.error !== null;
	useEffect(() => {
		if (repositoryId === undefined || !knowsConnection) return;
		if (!connected) {
			setOpening({ reading: false, error: github.enabled ? "GitHub is not connected, so the repository this was opened for cannot be chosen." : null });
			return;
		}
		let current = true;
		setOpening({ reading: true, error: null });
		client
			.user(auth)
			.githubRepository(repositoryId)
			.then(
				(repository) => {
					if (!current) return;
					// A choice the user made while GitHub was asked stays.
					setPicked((now) => now ?? { repository, branch: repository.defaultBranch });
					setOpening({ reading: false, error: null });
				},
				(failure: unknown) => current && setOpening({ reading: false, error: explain(failure) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId, connected, knowsConnection, github.enabled]);

	const source = connection ? (chosenSource ?? "github") : "address";
	const repo = source === "address" ? repoUrl.trim() : "";
	const repoInvalid = repo !== "" && !/^https:\/\/[^\s/]+\/\S+$/.test(repo);
	const notice = github.notice?.where === "launch" ? github.notice : null;
	const chosen = source === "github" && picked ? picked : null;
	// What the chosen repository's page says new agents on it start with, held against what this deployment offers.
	const saved = useDefaults(chosen?.repository.id ?? null);
	const defaults = startingChoices(saved.defaults, info);
	const profile = startingProfile(profileChoice, defaults, info);
	const model = startingModel(modelChoice, defaults, info);
	const fromDefaults = { profile: defaults.profile !== null && profile === defaults.profile, model: defaults.model !== null && model === defaults.model };
	// The defaults are read before the agent is created, so that it is not launched on other ones a moment too early.
	const canCreate = info !== null && profile !== null && !repoInvalid && busy === null && !saved.reading && !(opening.reading && source === "github" && picked === null);
	const setup = useSetupDraft(chosen?.repository.id ?? null);
	const chosenProfile = info?.profiles.find((candidate) => candidate.id === profile) ?? null;

	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (!canCreate || profile === null) return;
		setError(null);
		setBusy("creating");
		let sessionId: string;
		try {
			const repository = chosen ? { id: chosen.repository.id, branch: chosen.branch } : undefined;
			const session = await client.user(auth).createSession({
				profile,
				model: model || undefined,
				repoUrl: repo || undefined,
				repository,
				setupCommand: repository ? setup.toSave : undefined,
				publishUnasked: repository && chosen?.repository.canPush && chosenProfile !== null && publishAlwaysAsked(chosenProfile) === null ? publishUnasked : undefined,
				title: title.trim() || undefined,
			});
			sessionId = session.id;
		} catch (failure) {
			setError(explain(failure));
			setBusy(null);
			return;
		}
		const text = prompt.trim();
		if (text !== "") {
			setBusy("prompting");
			try {
				await client.session(auth, sessionId).prompt({ text });
			} catch (failure) {
				// The agent exists; its screen shows why the prompt was not accepted, with the text kept.
				handOver(sessionId, { text, error: explain(failure), limit: isLimitRefusal(failure) });
			}
		}
		navigate({ name: "session", id: sessionId });
	};

	const available = info?.profiles.filter((candidate) => candidate.available) ?? [];
	const unavailable = info?.profiles.filter((candidate) => !candidate.available) ?? [];

	return (
		<Dialog
			title="Launch an agent"
			lede="Choose where it works first. Everything else can wait."
			size="large"
			onClose={close}
			dismissable={busy === null}
			footer={
				<>
					{error ? (
						<p className="dialog-error tone-bad" role="alert">
							<WarnIcon size={14} /> {error}
						</p>
					) : null}
					<button type="button" className="button button-quiet" onClick={close} disabled={busy !== null}>
						Cancel
					</button>
					<button type="submit" form="new-agent" className="button button-primary" disabled={!canCreate}>
						{busy === "creating" ? "Creating the agent…" : busy === "prompting" ? "Sending the prompt…" : prompt.trim() === "" ? "Create agent" : "Launch agent"}
					</button>
				</>
			}
		>
			{platform.loading && !info ? (
				<div className="state state-loading" aria-busy="true">
					<span className="spinner" aria-hidden="true" />
					<p>Asking the server which sandboxes it has…</p>
				</div>
			) : !info ? (
				<div className="state state-error" role="alert">
					<WarnIcon size={22} />
					<h3>The sandboxes could not be loaded</h3>
					<p>{platform.error ?? "The server did not answer."}</p>
					<button type="button" className="button button-outline" onClick={platform.reload}>
						Try again
					</button>
				</div>
			) : (
				<form id="new-agent" className="new-agent" onSubmit={create} noValidate>
					{limit ? (
						<p className={`callout ${limit.warn ? "callout-warn" : "callout-info"}`} role="status">
							<WarnIcon />
							<span>
								{limit.text}{" "}
								<a className="link" {...linkProps({ name: "usage" })}>
									Usage
								</a>
							</span>
						</p>
					) : null}
					<fieldset className="new-agent-section">
						<legend className="section-title">
							<span className="section-number">1</span> Sandbox
						</legend>
						<p className="section-text">Where the agent's files live and its commands run. The boxes show what isolates it, outermost first.</p>
						{available.length === 0 ? (
							<p className="callout callout-warn">
								<WarnIcon />
								<span>This deployment has no sandbox that can be used right now.</span>
							</p>
						) : null}
						<div className="profiles">
							{available.map((candidate) => (
								<ProfileCard key={candidate.id} profile={candidate} name={group} checked={profile === candidate.id} onChoose={setProfile} />
							))}
						</div>
						{unavailable.length > 0 ? (
							<>
								<p className="profiles-divider">Listed, but not usable on this deployment</p>
								<div className="profiles profiles-unavailable">
									{unavailable.map((candidate) => (
										<ProfileCard key={candidate.id} profile={candidate} name={group} checked={false} onChoose={setProfile} />
									))}
								</div>
							</>
						) : null}
					</fieldset>

					<fieldset className="new-agent-section">
						<legend className="section-title">
							<span className="section-number">2</span> Task
						</legend>
						<div className="field-grid">
							<div className="field">
								<label className="label" htmlFor={ids.model}>
									Model
								</label>
								<select id={ids.model} className="select" value={model} onChange={(event) => setModel(event.target.value)}>
									{info.models.map((name, index) => (
										<option key={name} value={name}>
											{name}
											{index === 0 ? " (default)" : ""}
										</option>
									))}
								</select>
							</div>
							<div className="field">
								<label className="label" htmlFor={ids.title}>
									Title <span className="label-optional">optional</span>
								</label>
								<input id={ids.title} className="input" value={title} maxLength={MAX_TITLE_CHARS} placeholder="Named after the first prompt if left empty" onChange={(event) => setTitle(event.target.value)} />
							</div>
							<div className="field field-wide">
								<div className="gh-field-head">
									<label className="label" id={ids.repoLabel} htmlFor={ids.repo}>
										{github.enabled ? "Repository" : "Git repository to clone"} <span className="label-optional">optional</span>
									</label>
									{connection ? (
										<button type="button" className="link gh-switch" onClick={() => setChosenSource(source === "github" ? "address" : "github")} disabled={busy !== null}>
											{source === "github" ? "Paste an address instead" : "Choose from GitHub"}
										</button>
									) : null}
								</div>
								{source === "github" && connection ? (
									<RepositoryPicker
										value={picked}
										onChange={(next) => {
											setPicked(next);
											github.dismiss();
										}}
										accounts={connection.accounts}
										disabled={busy !== null}
										inputId={ids.repo}
										labelledBy={ids.repoLabel}
										describedBy={ids.repoNote}
									/>
								) : (
									<input
										id={ids.repo}
										className={`input input-mono${repoInvalid ? " input-invalid" : ""}`}
										type="url"
										inputMode="url"
										spellCheck={false}
										autoComplete="off"
										placeholder="https://github.com/you/project.git"
										value={repoUrl}
										onChange={(event) => setRepoUrl(event.target.value)}
										aria-invalid={repoInvalid}
										aria-describedby={ids.repoNote}
									/>
								)}
								<p className={`field-note${repoInvalid || (source === "github" && picked && !picked.repository.canPush) ? " tone-warn" : ""}`} id={ids.repoNote}>
									{source === "github" && connection
										? picked
											? picked.repository.canPush
												? `Cloned at ${picked.branch} when the sandbox is created. The work can come back as a pull request.`
												: `You can read ${picked.repository.owner}/${picked.repository.name} on GitHub but not push to it: the agent can work on it, and no pull request can be opened.`
											: notice?.tone === "good"
												? `${notice.text} Choose a repository, or leave this empty to start in an empty one.`
												: "One of your repositories at GitHub, private ones included. Without one the agent starts in an empty repository."
										: repoInvalid
											? "Use the repository's https address, for example https://github.com/you/project.git."
											: "Cloned into the workspace when the sandbox is created. Without one the agent starts in an empty repository."}
								</p>
								{opening.error !== null && picked === null ? (
									<p className="field-note tone-warn" role="status">
										{opening.error} Choose another repository, or launch without one.
									</p>
								) : opening.reading && picked === null && source === "github" ? (
									<p className="field-note" aria-busy="true">
										Asking GitHub for the repository this form was opened for…
									</p>
								) : null}
								{github.enabled && !connection ? (
									// One line, whatever it says: the form below it does not move when the connection is known.
									<p className={`field-note gh-connect-line${notice?.tone === "bad" || github.error ? " tone-bad" : ""}`} role={notice?.tone === "bad" ? "alert" : undefined}>
										{github.busy === "finishing" ? (
											"Finishing the GitHub connection…"
										) : github.busy === "leaving" ? (
											"Going to GitHub…"
										) : github.status === null && !github.error ? (
											"Checking the GitHub connection…"
										) : (
											<>
												{notice?.tone === "bad" ? `${notice.text} ` : github.error ? `${github.error} ` : null}
												<button type="button" className="link" onClick={() => github.connect({ where: "launch", draft: { profile: profileChoice, model: modelChoice, title, prompt, repoUrl } })} disabled={busy !== null}>
													Connect GitHub
												</button>{" "}
												to choose one of your own repositories, private ones included, and get the work back as a pull request.
											</>
										)}
									</p>
								) : null}
							</div>
							{chosen ? (
								<DefaultsNote
									repository={`${chosen.repository.owner}/${chosen.repository.name}`}
									defaults={defaults}
									used={fromDefaults}
									profileName={info.profiles.find((candidate) => candidate.id === defaults.profile)?.name ?? null}
									error={saved.error}
									disabled={busy !== null}
									onUseDefaults={() => {
										setProfile(null);
										setModel("");
									}}
								/>
							) : null}
							{chosen ? <SetupField setup={setup} repository={`${chosen.repository.owner}/${chosen.repository.name}`} disabled={busy !== null} /> : null}
							{chosen ? <SecretsField repositoryId={chosen.repository.id} repository={`${chosen.repository.owner}/${chosen.repository.name}`} profile={profile} disabled={busy !== null} /> : null}
							{chosen?.repository.canPush ? (
								<div className="field field-wide">
									<PublishUnaskedCheck checked={publishUnasked} disabled={busy !== null} onChange={setPublishUnasked} profile={chosenProfile} />
								</div>
							) : null}
							<div className="field field-wide">
								<label className="label" htmlFor={ids.prompt}>
									First prompt <span className="label-optional">optional</span>
								</label>
								<textarea id={ids.prompt} className="input textarea" rows={4} maxLength={MAX_PROMPT_CHARS} placeholder="What should it do? Leave empty to create the agent and write to it later." value={prompt} onChange={(event) => setPrompt(event.target.value)} />
							</div>
						</div>
					</fieldset>
				</form>
			)}
		</Dialog>
	);
}
