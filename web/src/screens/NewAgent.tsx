/**
 * New agent: the sandbox it works in (the centrepiece: every profile as a card, with its layers
 * drawn as they nest and three plain facts), then the model, an optional repository and title, and
 * the first prompt. Creating opens the session.
 *
 * The repository is a pasted address, as it always was. Where the deployment has a GitHub App, a
 * connected user picks one of their own instead, with the branch to start from, and a user who is not
 * connected is offered to connect: that leaves the page, so what the form holds is kept and put back.
 */
import { MAX_PROMPT_CHARS, MAX_TITLE_CHARS, type SandboxProfile, type SandboxProfileId } from "@contract";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Dialog } from "../components/Dialog";
import { WarnIcon } from "../components/Icons";
import { Layers, ProfileFacts } from "../components/Layers";
import { RepositoryPicker, type PickedRepository } from "../components/RepositoryPicker";
import { navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
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

export function NewAgent() {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const info = platform.info;
	const group = useId();
	const ids = { model: useId(), repo: useId(), repoLabel: useId(), title: useId(), prompt: useId(), repoNote: useId() };
	const github = useGithub();
	// What the form held before its user left to connect GitHub, once.
	const [draft] = useState(takeLaunchDraft);

	const [profile, setProfile] = useState<SandboxProfileId | null>((draft?.profile as SandboxProfileId | null | undefined) ?? null);
	const [model, setModel] = useState(draft?.model ?? "");
	const [repoUrl, setRepoUrl] = useState(draft?.repoUrl ?? "");
	const [title, setTitle] = useState(draft?.title ?? "");
	const [prompt, setPrompt] = useState(draft?.prompt ?? "");
	const [picked, setPicked] = useState<PickedRepository | null>(null);
	// Where the repository comes from: the user's choice once they made one, otherwise GitHub when it is connected.
	const [chosenSource, setChosenSource] = useState<"github" | "address" | null>(draft?.repoUrl ? "address" : null);
	const [busy, setBusy] = useState<"creating" | "prompting" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Start on the first sandbox that can be chosen and on the default model.
	useEffect(() => {
		if (!info) return;
		setProfile((current) => (current !== null && info.profiles.some((candidate) => candidate.id === current && candidate.available) ? current : (info.profiles.find((candidate) => candidate.available)?.id ?? null)));
		setModel((current) => current || (info.models[0] ?? ""));
	}, [info]);

	// Back from GitHub: the form opens where its user left it, at the repository.
	const returned = github.notice?.where === "launch" || github.busy === "finishing";
	useEffect(() => {
		if (returned && info) document.getElementById(ids.repo)?.scrollIntoView({ block: "center" });
	}, [returned, info, ids.repo]);

	const close = () => navigate({ name: "home" });
	const connection = github.enabled ? (github.status?.connection ?? null) : null;
	const source = connection ? (chosenSource ?? "github") : "address";
	const repo = source === "address" ? repoUrl.trim() : "";
	const repoInvalid = repo !== "" && !/^https:\/\/[^\s/]+\/\S+$/.test(repo);
	const canCreate = info !== null && profile !== null && !repoInvalid && busy === null;
	const notice = github.notice?.where === "launch" ? github.notice : null;

	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (!canCreate || profile === null) return;
		setError(null);
		setBusy("creating");
		let sessionId: string;
		try {
			const repository = source === "github" && picked ? { id: picked.repository.id, branch: picked.branch } : undefined;
			const session = await client.user(auth).createSession({ profile, model: model || undefined, repoUrl: repo || undefined, repository, title: title.trim() || undefined });
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
				handOver(sessionId, { text, error: explain(failure) });
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
												<button type="button" className="link" onClick={() => github.connect({ where: "launch", draft: { profile, model, title, prompt, repoUrl } })} disabled={busy !== null}>
													Connect GitHub
												</button>{" "}
												to choose one of your own repositories, private ones included, and get the work back as a pull request.
											</>
										)}
									</p>
								) : null}
							</div>
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
