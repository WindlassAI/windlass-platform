/**
 * New agent: what it should do first, then an optional repository, the model and a title, and last
 * the sandbox it works in. The sandbox is one line that names the choice and its three plain facts;
 * every profile as a card, with its layers drawn as they nest, opens from that line. Creating opens
 * the session.
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
 * the form starts from once it is picked. The account has defaults too, saved in its settings, for
 * what the repository leaves open and for an agent on no repository. Each of the two fields goes by
 * the user's own choice in the form, then the chosen repository's default, then the account's, then
 * the deployment's first sandbox and the default of the user's models; a choice made in the form is
 * for this agent only. A default that names a sandbox the deployment no longer offers, or a model
 * that is not among the user's, is left out, and the form says so and whose it was. The models are
 * the user's own, and a line under the field says whose list it is. Opened from a repository's page,
 * the form has that repository chosen.
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
import { modelsNote } from "../lib/models";
import { layerChoices, startingChoices, startingModel, startingProfile, type DefaultSource, type LayeredChoices } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { allowanceState, useAccount, useAllowance, useModels } from "../state/hooks";
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

/** The chosen sandbox in one line: its name and the three facts of `ProfileFacts`, each in a few words. What is open is said in the warning tone. */
function ChosenSandbox({ profile }: { profile: SandboxProfile }) {
	return (
		<span className="sandbox-chosen-text">
			<span className="sandbox-chosen-name">{profile.name}</span>
			<span className="sandbox-chosen-facts">
				<span className={profile.approval === "full" ? "fact-open" : undefined}>{profile.approval === "auto" ? "runs what the sandbox contains, refuses the rest" : "runs every call without asking"}</span>
				<span className={profile.commandNetwork ? "fact-open" : undefined}>{profile.commandNetwork ? "commands can reach the network" : "commands have no network"}</span>
				<span className={profile.commandsCanReadAccessToken ? "fact-open" : undefined}>{profile.commandsCanReadAccessToken ? "commands can read the session's access token" : "commands cannot read the session's access token"}</span>
			</span>
		</span>
	);
}

/**
 * Which defaults the form stands on, said beside the repository: the sandbox is chosen further down
 * and folded, so what it starts on would otherwise go unseen. `defaults` are the ones that hold, each
 * field with whose it is: the chosen repository's, or the account's where the repository has none.
 * `used` says which of them the form stands on now; one the user chose over can be taken back with
 * one press. A saved default that cannot be used is said with whose it was and where it is changed.
 */
function DefaultsNote({
	repository,
	defaults,
	used,
	profileName,
	ignored,
	errors,
	disabled,
	onUseDefaults,
}: {
	/** "owner/name" of the chosen repository; null when none is chosen. */
	repository: string | null;
	defaults: LayeredChoices;
	used: { profile: boolean; model: boolean };
	profileName: string | null;
	/** What is saved and not used: the repository's, and the account's where the repository's does not stand in for it. */
	ignored: { repository: Array<string | null>; account: Array<string | null> };
	/** Why the repository's defaults, or the account's, could not be read. */
	errors: { repository: string | null; account: string | null };
	disabled: boolean;
	onUseDefaults(): void;
}) {
	const whose = (source: DefaultSource | null, count = 1) => (source === "repository" ? `the default${count === 1 ? "" : "s"} saved for ${repository ?? "the repository"}` : `your account's default${count === 1 ? "" : "s"}`);
	const applied = [used.profile && profileName ? { text: `in ${profileName}`, from: defaults.from.profile } : null, used.model && defaults.model ? { text: `on ${defaults.model}`, from: defaults.from.model } : null].filter((part) => part !== null);
	const passed = [
		defaults.profile !== null && !used.profile ? `sandbox (${profileName ?? defaults.profile}, ${defaults.from.profile === "repository" ? (repository ?? "the repository's") : "your account's"})` : null,
		defaults.model !== null && !used.model ? `model (${defaults.model}, ${defaults.from.model === "repository" ? (repository ?? "the repository's") : "your account's"})` : null,
	].filter((part) => part !== null);
	const left = { repository: ignored.repository.filter((part) => part !== null), account: ignored.account.filter((part) => part !== null) };
	if (applied.length === 0 && passed.length === 0 && left.repository.length === 0 && left.account.length === 0 && errors.repository === null && errors.account === null) return null;
	const one = applied.length === 2 && applied[0]?.from === applied[1]?.from;
	return (
		<div className="field field-wide new-agent-defaults" role="status">
			{applied.length > 0 ? (
				<p className="field-note">
					This agent starts {one ? `${applied.map((part) => part.text).join(" and ")}: ${whose(applied[0]?.from ?? null, 2)}` : applied.map((part) => `${part.text}, ${whose(part.from)}`).join(", and ")}. Choose otherwise in this form and it holds for this agent only.
				</p>
			) : null}
			{passed.length > 0 ? (
				<p className="field-note">
					There is a default {passed.join(" and a default ")}; this agent uses what you chose instead.{" "}
					<button type="button" className="link" onClick={onUseDefaults} disabled={disabled}>
						Use the {passed.length === 1 ? "default" : "defaults"}
					</button>
				</p>
			) : null}
			{left.repository.map((sentence) => (
				<p key={sentence} className="field-note tone-warn">
					{sentence} Change it on the repository's page.
				</p>
			))}
			{left.account.map((sentence) => (
				<p key={sentence} className="field-note tone-warn">
					{sentence} Change it in{" "}
					<a className="link" {...linkProps({ name: "settings" })}>
						your settings
					</a>
					.
				</p>
			))}
			{errors.repository !== null ? (
				<p className="field-note tone-warn">
					The defaults saved for {repository ?? "the repository"} could not be read, so this form goes by {defaults.from.profile === "account" || defaults.from.model === "account" ? "your account's and the deployment's" : "the deployment's"}: {errors.repository}
				</p>
			) : null}
			{errors.account !== null ? <p className="field-note tone-warn">Your account's defaults could not be read, so this form goes without them: {errors.account}</p> : null}
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
	const ids = { model: useId(), modelNote: useId(), repo: useId(), repoLabel: useId(), title: useId(), prompt: useId(), repoNote: useId(), profiles: useId() };
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
	// The sandboxes as cards: folded until their user asks for them, so the task comes first.
	const [profilesOpen, setProfilesOpen] = useState(false);
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
	// What the chosen repository's page says new agents on it start with, and what the account's settings say of every
	// new agent, each held against what this deployment offers: the repository's first, field by field.
	const saved = useDefaults(chosen?.repository.id ?? null);
	const account = useAccount();
	const models = useModels();
	const repositoryDefaults = startingChoices(saved.defaults, info, models.list);
	const accountDefaults = startingChoices(account.settings?.defaults ?? null, info, models.list, "account");
	const defaults = layerChoices(repositoryDefaults, accountDefaults);
	const profile = startingProfile(profileChoice, defaults, info);
	const model = startingModel(modelChoice, defaults, models.list);
	const fromDefaults = { profile: defaults.profile !== null && profile === defaults.profile, model: defaults.model !== null && model === defaults.model };
	// The defaults and the models are read before the agent is created, so that it is not launched on other ones a moment too early.
	const accountReading = account.reading && account.settings === null;
	const canCreate = info !== null && profile !== null && !repoInvalid && busy === null && !saved.reading && !accountReading && !models.reading && !(opening.reading && source === "github" && picked === null);
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
			lede="Say what it should do. Everything else can wait."
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
					<div className="field-grid">
						<div className="field field-wide">
							<label className="label" htmlFor={ids.prompt}>
								First prompt <span className="label-optional">optional</span>
							</label>
							<textarea id={ids.prompt} className="input textarea" rows={5} data-autofocus maxLength={MAX_PROMPT_CHARS} placeholder="What should it do? Leave empty to create the agent and write to it later." value={prompt} onChange={(event) => setPrompt(event.target.value)} />
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
						<DefaultsNote
							repository={chosen ? `${chosen.repository.owner}/${chosen.repository.name}` : null}
							defaults={defaults}
							used={fromDefaults}
							profileName={info.profiles.find((candidate) => candidate.id === defaults.profile)?.name ?? null}
							ignored={{
								repository: [repositoryDefaults.ignored.profile, repositoryDefaults.ignored.model],
								// An account's default that cannot be used matters here only where the repository's does not stand in for it.
								account: [repositoryDefaults.profile === null ? accountDefaults.ignored.profile : null, repositoryDefaults.model === null ? accountDefaults.ignored.model : null],
							}}
							errors={{ repository: chosen ? saved.error : null, account: account.settings === null ? account.error : null }}
							disabled={busy !== null}
							onUseDefaults={() => {
								setProfile(null);
								setModel("");
							}}
						/>
						{chosen ? <SetupField setup={setup} repository={`${chosen.repository.owner}/${chosen.repository.name}`} disabled={busy !== null} /> : null}
						{chosen ? <SecretsField repositoryId={chosen.repository.id} repository={`${chosen.repository.owner}/${chosen.repository.name}`} profile={profile} disabled={busy !== null} /> : null}
						{chosen?.repository.canPush ? (
							<div className="field field-wide">
								<PublishUnaskedCheck checked={publishUnasked} disabled={busy !== null} onChange={setPublishUnasked} profile={chosenProfile} />
							</div>
						) : null}
						<div className="field">
							<label className="label" htmlFor={ids.model}>
								Model
							</label>
							<select id={ids.model} className="select" value={model} onChange={(event) => setModel(event.target.value)} disabled={models.list === null} aria-describedby={ids.modelNote}>
								{models.list === null ? <option value={model}>{model || "Your default model"}</option> : null}
								{models.list?.models.map(({ id }) => (
									<option key={id} value={id}>
										{id}
										{id === models.list?.defaultModel ? " (default)" : ""}
									</option>
								))}
							</select>
							<p className="field-note" id={ids.modelNote} aria-busy={models.reading}>
								{models.list ? modelsNote(models.list) : models.reading ? "Reading your models…" : `${models.error ?? "Your models could not be read."} The agent starts on your default model.`}
							</p>
						</div>
						<div className="field">
							<label className="label" htmlFor={ids.title}>
								Title <span className="label-optional">optional</span>
							</label>
							<input id={ids.title} className="input" value={title} maxLength={MAX_TITLE_CHARS} placeholder="Named after the first prompt if left empty" onChange={(event) => setTitle(event.target.value)} />
						</div>
					</div>
					<fieldset className="new-agent-section sandbox-pick">
						<legend className="label">Sandbox</legend>
						{available.length === 0 ? (
							<p className="callout callout-warn">
								<WarnIcon />
								<span>This deployment has no sandbox that can be used right now.</span>
							</p>
						) : null}
						<div className="sandbox-chosen">
							{chosenProfile ? <ChosenSandbox profile={chosenProfile} /> : <span className="sandbox-chosen-text">None chosen</span>}
							<button type="button" className="link" aria-expanded={profilesOpen} aria-controls={ids.profiles} onClick={() => setProfilesOpen((open) => !open)}>
								{profilesOpen ? "Hide" : available.length > 1 ? "Change" : "Details"}
							</button>
						</div>
						<div id={ids.profiles} className="sandbox-cards" hidden={!profilesOpen}>
							<p className="section-text">Where the agent's files live and its commands run. The boxes show what isolates it, outermost first.</p>
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
						</div>
					</fieldset>
				</form>
			)}
		</Dialog>
	);
}
