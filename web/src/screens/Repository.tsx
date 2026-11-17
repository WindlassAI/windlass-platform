/**
 * A repository's page: what the user's actor keeps for one repository of their GitHub connection,
 * gathered in one place, and the agents on it.
 *
 * The page is addressed by GitHub's id for the repository, which a rename does not change. It shows
 * the agents launched on it and the pull requests they opened that are still open, both from the
 * summaries the list of agents already has; what new agents on it start with; its setup command and
 * its secrets, in the same components a session's panel has; and the approvals of its MCP servers
 * that are remembered, each with the way to forget it.
 *
 * Two things are asked, apart from each other. What is saved (`repository`) is the user's actor's
 * own and is there at once. Whether the repository can still be launched on (`githubRepository`) is
 * GitHub's to say and can take a moment or fail: the page does not wait for it, and a repository that
 * GitHub no longer shows to this user keeps its page, with what is saved for it and the way to
 * delete that, and with a plain sentence that no new agent can be launched on it.
 */
import type { GithubRepository, RepositoryView, SandboxProfileId, SessionSummary } from "@contract";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { hasReason } from "../api/client";
import { AgentList } from "../components/Agents";
import { Dialog } from "../components/Dialog";
import { ArrowLeftIcon, ExternalIcon, LockIcon, PlusIcon, WarnIcon } from "../components/Icons";
import { PullState } from "../components/PullRequest";
import { SecretsBlock } from "../components/Secrets";
import { RepositoryApprovals } from "../components/Servers";
import { SetupEditor } from "../components/SetupCommand";
import type { ConnectionState } from "../api/client";
import { absoluteTime, plural, relativeTime } from "../lib/format";
import { LONE_GROUP_SHOWN, openPulls, repositoryName, sessionsOn, startingChoices } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useGithub, type Github } from "../state/github";
import { useNow, useSessions } from "../state/hooks";

/** Whether new agents can be launched on the repository, as GitHub says now. */
export type RepositoryAccess =
	| { state: "checking" }
	/** The connection covers it and the connected user may read it. */
	| { state: "usable"; repository: GithubRepository }
	/** It cannot be launched on, and asking again does not change that: `why` says what is in the way. */
	| { state: "unusable"; reason: "github_off" | "github_not_connected" | "github_gone" | "github_denied"; why: string }
	/** GitHub could not be asked: nothing is known either way. */
	| { state: "unknown"; why: string };

export interface RepositoryPage {
	id: number;
	/** "owner/name": GitHub's own once it answered, otherwise as the agents on it or what was saved for it have it. Null when nothing names it. */
	name: string | null;
	/** Null until it was read. */
	view: RepositoryView | null;
	/** Why what is saved could not be read. */
	error: string | null;
	access: RepositoryAccess;
	/** The user's agents on it, the most recently used first; null until the list of agents arrived. */
	sessions: SessionSummary[] | null;
	connection: ConnectionState;
	/** Reads what is saved again. */
	reload(): void;
	/** Takes the page as an action answered it. */
	replace(view: RepositoryView): void;
	/** Asks GitHub again. */
	recheck(): void;
}

const UNUSABLE = ["github_off", "github_not_connected", "github_gone", "github_denied"] as const;

/** Everything a repository's page shows, live: what is saved, what GitHub says, and the agents on it. */
export function useRepository(id: number): RepositoryPage {
	const { client, explain } = useApp();
	const auth = useAuth();
	const github = useGithub();
	const { sessions, connection } = useSessions();
	const [view, setView] = useState<RepositoryView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [access, setAccess] = useState<RepositoryAccess>({ state: "checking" });
	const [asked, setAsked] = useState(0);
	const reading = useRef(0);

	const reload = useCallback(() => {
		const mine = ++reading.current;
		client
			.user(auth)
			.repository(id)
			.then(
				(next) => {
					if (mine !== reading.current) return;
					setView(next);
					setError(null);
				},
				(failure: unknown) => mine === reading.current && setError(explain(failure)),
			);
	}, [client, auth, explain, id]);

	useEffect(() => {
		setView(null);
		setError(null);
		reload();
		return () => {
			reading.current += 1;
		};
	}, [reload]);

	// GitHub is asked when the page opens, when the connection changes, and when the user asks again.
	const connected = github.enabled ? (github.status === null ? null : (github.status.connection?.connectedAt ?? 0)) : 0;
	const connectionError = github.status === null ? github.error : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is not read here; a change of it is when to ask again
	useEffect(() => {
		if (!github.enabled) {
			setAccess({ state: "unusable", reason: "github_off", why: "This deployment has no GitHub App any more, so no agent can be launched on a repository of GitHub's here." });
			return;
		}
		// Until the connection is known there is nothing to ask with; when it could not be read, nothing is known.
		if (connected === null) {
			setAccess(connectionError === null ? { state: "checking" } : { state: "unknown", why: connectionError });
			return;
		}
		if (connected === 0) {
			setAccess({ state: "unusable", reason: "github_not_connected", why: "GitHub is not connected, so no agent can be launched on it." });
			return;
		}
		let current = true;
		setAccess({ state: "checking" });
		client
			.user(auth)
			.githubRepository(id)
			.then(
				(repository) => current && setAccess({ state: "usable", repository }),
				(failure: unknown) => {
					if (!current) return;
					const reason = UNUSABLE.find((code) => hasReason(failure, code));
					setAccess(reason ? { state: "unusable", reason, why: explain(failure) } : { state: "unknown", why: explain(failure) });
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, id, github.enabled, connected, connectionError, asked]);

	const mine = sessions === null ? null : sessionsOn(sessions, id);
	const newest = mine?.reduce<SessionSummary | null>((found, session) => (found === null || session.createdAt > found.createdAt ? session : found), null)?.repository;
	const name = access.state === "usable" ? repositoryName(access.repository) : newest ? repositoryName(newest) : (view?.name ?? null);
	const reloadGithub = github.reload;
	const recheck = useCallback(() => {
		// Without the connection there is nothing to ask GitHub with: that is read again first.
		if (connectionError !== null) reloadGithub();
		setAsked((count) => count + 1);
	}, [connectionError, reloadGithub]);
	return { id, name, view, error, access, sessions: mine, connection, reload, replace: setView, recheck };
}

/** What the top bar shows on this page: the way back and which repository it is. */
export function RepositoryCrumb({ name }: { name: string | null }) {
	return (
		<nav className="crumb" aria-label="Where you are">
			<a className="crumb-back" {...linkProps({ name: "home" })}>
				<ArrowLeftIcon size={14} />
				<span>Agents</span>
			</a>
			<span className="crumb-sep" aria-hidden="true">
				/
			</span>
			<span className="crumb-title" aria-current="page">
				{name ?? "Repository"}
			</span>
		</nav>
	);
}

/** What GitHub says of the repository, in the page's head: where it is, and what can be done there. */
function AccessLine({ page, github }: { page: RepositoryPage; github: Github }) {
	const { access } = page;
	const address = page.sessions?.find((session) => session.repository)?.repository?.url ?? (page.name ? `${github.url}/${page.name}` : null);
	const repository = access.state === "usable" ? access.repository : null;
	const isPrivate = repository?.private ?? page.sessions?.find((session) => session.repository)?.repository?.private ?? null;
	return (
		<p className="home-account repo-facts">
			{address ? (
				<a className="repo-link" href={repository ? `${github.url}/${repository.owner}/${repository.name}` : address} target="_blank" rel="noreferrer">
					On GitHub
					<ExternalIcon size={11} />
				</a>
			) : null}
			{isPrivate === null ? null : (
				<span className="repo-fact">
					{isPrivate ? <LockIcon size={12} /> : null}
					{isPrivate ? "private" : "public"}
				</span>
			)}
			{access.state === "checking" ? <span className="tone-dim">checking it at GitHub…</span> : null}
			{repository ? <span className="repo-fact">default branch {repository.defaultBranch}</span> : null}
			{repository ? <span className={repository.canPush ? "repo-fact" : "repo-fact tone-warn"}>{repository.canPush ? "you can push to it" : "read only for you: no pull request can be opened"}</span> : null}
		</p>
	);
}

/** Why no agent can be launched on it, or that GitHub could not be asked: said once, above everything that is saved. */
function AccessNotice({ page, github }: { page: RepositoryPage; github: Github }) {
	const { access } = page;
	if (access.state === "unusable") {
		return (
			<div className="callout callout-warn" role="status">
				<WarnIcon />
				<div>
					<p className="callout-title">This repository cannot be used for new agents.</p>
					<p className="callout-text">
						{access.why} What you saved for it is still here, and you can change it or delete it below.
						{access.reason === "github_not_connected" ? (
							<>
								{" "}
								<button type="button" className="link" onClick={() => github.connect({ where: "menu" })} disabled={github.busy !== null}>
									{github.busy === "leaving" ? "Going to GitHub…" : "Connect GitHub"}
								</button>
							</>
						) : null}
					</p>
				</div>
			</div>
		);
	}
	if (access.state === "unknown") {
		return (
			<p className="callout callout-info" role="status">
				<WarnIcon />
				<span>
					Whether new agents can be launched on it is not known: {access.why}{" "}
					<button type="button" className="link" onClick={page.recheck}>
						Ask GitHub again
					</button>
				</span>
			</p>
		);
	}
	return null;
}

/** The pull requests its agents opened that are still open, as the platform last saw them. */
function Pulls({ page, now }: { page: RepositoryPage; now: number }) {
	const pulls = page.sessions === null ? null : openPulls(page.sessions, page.id);
	return (
		<section className="usage-section" aria-labelledby="repo-pulls">
			<h2 className="usage-title" id="repo-pulls">
				Open pull requests
				{pulls && pulls.length > 0 ? <span className="usage-count">{pulls.length}</span> : null}
			</h2>
			{pulls === null ? null : pulls.length === 0 ? (
				<p className="usage-empty">None of its agents has a pull request that is open.</p>
			) : (
				<>
					<ul className="repo-pulls">
						{pulls.map(({ pull, session }) => (
							<li key={session.id} className="repo-pull">
								<PullState state={pull.state} />
								<div className="repo-pull-main">
									<a className="repo-pull-title" href={pull.url} target="_blank" rel="noreferrer">
										<span className="repo-pull-number">#{pull.number}</span> {pull.title}
										<ExternalIcon size={11} />
									</a>
									<p className="agent-meta">
										<span>
											{pull.branch} into {pull.base}
										</span>
										<span>
											by{" "}
											<a className="repo-pull-agent" {...linkProps({ name: "session", id: session.id })}>
												{session.title}
											</a>
										</span>
										<span title={absoluteTime(pull.pushedAt)}>pushed {relativeTime(pull.pushedAt, now)}</span>
									</p>
								</div>
							</li>
						))}
					</ul>
					<p className="usage-note">As the platform last saw each at GitHub. An agent's panel asks GitHub again, and a pull request merged or closed since then leaves this list.</p>
				</>
			)}
		</section>
	);
}

/** What new agents on it start with: a sandbox and a model, each saved as soon as it is chosen. */
function Defaults({ page, view, name }: { page: RepositoryPage; view: RepositoryView; name: string }) {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const ids = { profile: useId(), model: useId(), profileNote: useId(), modelNote: useId() };
	const [saving, setSaving] = useState<"profile" | "model" | null>(null);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const info = platform.info;
	const { defaults } = view;
	const choices = startingChoices(defaults, info);
	const first = info?.profiles.find((profile) => profile.available) ?? null;
	const savedProfile = info?.profiles.find((profile) => profile.id === defaults.profile) ?? null;

	const save = async (field: "profile" | "model", value: string) => {
		if (saving !== null) return;
		setSaving(field);
		setSaid(null);
		try {
			const next = await client.user(auth).saveRepositoryDefaults(page.id, field === "profile" ? { profile: value === "" ? null : (value as SandboxProfileId) } : { model: value === "" ? null : value });
			page.replace({ ...view, defaults: next });
			setSaid({ tone: "good", text: "Saved." });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setSaving(null);
		}
	};

	return (
		<section className="usage-section" aria-labelledby="repo-defaults">
			<h2 className="usage-title" id="repo-defaults">
				Defaults for new agents
			</h2>
			<p className="usage-lede">The launch form starts from these when {name} is chosen. They can still be changed there for one agent, and an agent that exists keeps what it was launched with.</p>
			{info === null ? (
				<p className="usage-empty" aria-busy={platform.loading}>
					{platform.loading ? "Asking the server which sandboxes and models it has…" : (platform.error ?? "The server did not say which sandboxes and models it has.")}
				</p>
			) : (
				<div className="field-grid repo-fields">
					<div className="field">
						<label className="label" htmlFor={ids.profile}>
							Sandbox
						</label>
						<select id={ids.profile} className="select" value={defaults.profile ?? ""} onChange={(event) => void save("profile", event.target.value)} disabled={saving !== null} aria-describedby={ids.profileNote}>
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
								? `${choices.ignored.profile} New agents start in ${first?.name ?? "no sandbox"} until you choose another.`
								: `Where a new agent's files live and its commands run.${defaults.profile === null && first ? ` Without a default: ${first.name}.` : ""}`}
						</p>
					</div>
					<div className="field">
						<label className="label" htmlFor={ids.model}>
							Model
						</label>
						<select id={ids.model} className="select" value={defaults.model ?? ""} onChange={(event) => void save("model", event.target.value)} disabled={saving !== null} aria-describedby={ids.modelNote}>
							<option value="">No default</option>
							{info.models.map((model) => (
								<option key={model} value={model}>
									{model}
								</option>
							))}
							{defaults.model !== null && !info.models.includes(defaults.model) ? (
								<option value={defaults.model} disabled>
									{defaults.model} (not offered)
								</option>
							) : null}
						</select>
						<p className={`field-note${choices.ignored.model ? " tone-warn" : ""}`} id={ids.modelNote}>
							{choices.ignored.model
								? `${choices.ignored.model} New agents start on ${info.models[0] ?? "the deployment's model"} until you choose another.`
								: `The model a new agent starts on. It can be changed with any prompt.${defaults.model === null && info.models[0] ? ` Without a default: ${info.models[0]}.` : ""}`}
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

/** What deleting everything saved takes with it, and what it leaves. */
function ForgetDialog({ page, view, name, agents, onClose, onDone }: { page: RepositoryPage; view: RepositoryView; name: string; agents: number; onClose(): void; onDone(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const parts = [
		view.saved.setup ? "the setup command" : null,
		view.saved.secrets > 0 ? (view.saved.secrets === 1 ? "its one secret" : `its ${view.saved.secrets} secrets`) : null,
		view.defaults.profile !== null || view.defaults.model !== null ? "the defaults for new agents" : null,
		view.approvals.length > 0 ? (view.approvals.length === 1 ? "the remembered approval of one MCP server" : `the remembered approvals of ${view.approvals.length} MCP servers`) : null,
	].filter((part): part is string => part !== null);
	const listed = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

	const forget = async () => {
		setBusy(true);
		setError(null);
		try {
			page.replace(await client.user(auth).forgetRepository(page.id));
			onDone();
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Delete what is saved?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={forget} disabled={busy}>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</>
			}
		>
			<p>
				What you saved for <strong>{name}</strong> is deleted: {listed}. This cannot be undone; a secret's value cannot be read back from here, so keep a copy of any you still need.
			</p>
			{agents > 0 ? (
				<p>
					{agents === 1 ? "The agent on it stays" : `The ${agents} agents on it stay`}, with {agents === 1 ? "its conversation and its workspace" : "their conversations and their workspaces"}. A sandbox made after this is set up without them, and{" "}
					{agents === 1 ? "its" : "their"} MCP servers are asked about again.
				</p>
			) : null}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

export function Repository({ page }: { page: RepositoryPage }) {
	const { platform } = useApp();
	const github = useGithub();
	const now = useNow(15_000);
	const ids = { setup: useId() };
	const [forgetting, setForgetting] = useState(false);
	/** Counted up when everything saved was deleted: the setup command and the secrets are read anew. */
	const [generation, setGeneration] = useState(0);
	const { view, access, sessions } = page;
	const name = page.name ?? `Repository ${page.id}`;
	const info = platform.info;
	// What a secret reaches depends on the sandbox: the list is said for the one new agents here start in.
	const choices = startingChoices(view?.defaults ?? null, info);
	const reachProfile = info?.profiles.find((profile) => profile.id === choices.profile) ?? info?.profiles.find((profile) => profile.available) ?? info?.profiles[0] ?? null;
	const launchable = access.state !== "unusable";
	const anything = view !== null && (view.saved.setup || view.saved.secrets > 0 || view.defaults.profile !== null || view.defaults.model !== null || view.approvals.length > 0);
	const working = sessions?.filter((session) => session.status !== "idle").length ?? 0;

	return (
		<main className="home usage repo">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">
						repository
						{sessions === null ? "" : ` · ${plural(sessions.length, "agent")}${working > 0 ? ` · ${working} working` : ""}`}
					</p>
					<h1 className="display repo-name">{name}</h1>
					{page.name === null && view !== null ? <p className="home-account">Nothing here says what it is called: no agent of yours is on it, and GitHub was not heard on it. {page.id} is GitHub's number for it.</p> : null}
					<AccessLine page={page} github={github} />
				</div>
				<button type="button" className="button button-primary button-large" onClick={() => navigate({ name: "new", repository: page.id })} disabled={!launchable} title={launchable ? undefined : "No agent can be launched on this repository now"}>
					<PlusIcon />
					New agent
				</button>
			</header>

			<AccessNotice page={page} github={github} />
			{page.connection === "reconnecting" ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The connection dropped. Reconnecting; the agents below may be behind.</span>
				</p>
			) : null}

			<section className="usage-section" aria-labelledby="repo-agents">
				<h2 className="usage-title" id="repo-agents">
					Agents
					{sessions && sessions.length > 0 ? <span className="usage-count">{sessions.length}</span> : null}
				</h2>
				{sessions === null ? (
					page.connection === "failed" ? (
						<p className="usage-empty tone-bad">The list of agents could not be loaded.</p>
					) : (
						<p className="usage-empty" aria-busy="true">
							Reading your agents…
						</p>
					)
				) : sessions.length === 0 ? (
					<p className="usage-empty">No agent of yours is on this repository.{launchable ? " Launch one with New agent." : ""}</p>
				) : (
					<div className="repo-agents">
						<AgentList sessions={sessions} limit={LONE_GROUP_SHOWN} foldKey={`repository:${page.id}`} label={`Your agents on ${name}, the most recently used first`} grouped now={now} />
					</div>
				)}
			</section>

			<Pulls page={page} now={now} />

			{view === null ? (
				<section className="usage-section">
					{page.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h2>What is saved for this repository could not be loaded</h2>
							<p>{page.error}</p>
							<button type="button" className="button button-outline" onClick={page.reload}>
								Try again
							</button>
						</div>
					) : (
						<div className="usage-loading" aria-busy="true" aria-label="Loading what is saved for this repository">
							<span className="skeleton skeleton-title" style={{ width: "34%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					)}
				</section>
			) : (
				<>
					{page.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{page.error} What is shown may be behind.</span>
						</p>
					) : null}

					<Defaults key={generation} page={page} view={view} name={name} />

					<section className="usage-section repo-saved" aria-labelledby={ids.setup}>
						<h2 className="usage-title" id={ids.setup}>
							Setup command
						</h2>
						<SetupEditor key={generation} repositoryId={page.id} name={name} labelledBy={ids.setup} applies="A change applies to workspaces created after it: an agent that has one is not set up again." onSaved={page.reload} />
					</section>

					<section className="usage-section repo-saved" aria-labelledby="repo-secrets">
						<SecretsBlock
							key={generation}
							repositoryId={page.id}
							name={name}
							profile={reachProfile?.id ?? null}
							onChanged={page.reload}
							title={(add) => (
								<h2 className="usage-title" id="repo-secrets">
									Secrets
									{view.saved.secrets > 0 ? <span className="usage-count">{view.saved.secrets}</span> : null}
									{add}
								</h2>
							)}
						/>
						{reachProfile && view.saved.secrets > 0 ? (
							<p className="usage-note">
								What each reaches is said for {reachProfile.name}, {choices.profile === reachProfile.id ? "the sandbox new agents here start in" : "the sandbox a new agent starts in when none is chosen"}. An agent's own panel says it for the sandbox that agent has.
							</p>
						) : null}
					</section>

					<section className="usage-section repo-saved" aria-labelledby="repo-servers">
						<h2 className="usage-title" id="repo-servers">
							MCP server approvals
							{view.approvals.length > 0 ? <span className="usage-count">{view.approvals.length}</span> : null}
						</h2>
						<RepositoryApprovals repositoryId={page.id} name={name} approvals={view.approvals} forgetting={view.forgetting} now={now} onChanged={page.replace} />
					</section>

					<section className="usage-section" aria-labelledby="repo-forget">
						<h2 className="usage-title" id="repo-forget">
							Delete what is saved
						</h2>
						<p className="usage-lede">
							{anything
								? `Deletes the setup command, the secrets, the defaults and the remembered approvals saved for ${name}, all at once. Its agents are not deleted with them.`
								: `Nothing is saved for ${name}.`}
						</p>
						{anything ? (
							<p className="repo-forget">
								<button type="button" className="button button-outline button-small" onClick={() => setForgetting(true)}>
									Delete what is saved…
								</button>
							</p>
						) : null}
					</section>

					{forgetting ? <ForgetDialog page={page} view={view} name={name} agents={sessions?.length ?? 0} onClose={() => setForgetting(false)} onDone={() => setGeneration((count) => count + 1)} /> : null}
				</>
			)}
		</main>
	);
}
