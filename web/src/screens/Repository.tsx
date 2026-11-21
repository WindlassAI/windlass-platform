/**
 * A repository's page: what the user's actor keeps for one repository of their GitHub connection,
 * gathered in one place, and the agents on it.
 *
 * The page is addressed by GitHub's id for the repository, which a rename does not change. Under one
 * head it has two views, each with its own address, and tabs between them. Its work, the first: the
 * agents launched on it, its work items, and the pull requests its agents opened that are still open,
 * the agents and the pull requests from the summaries the list of agents already has, each pull
 * request with what its description says was verified. A work item's session is not among the agents:
 * it is part of its item, and is opened from the item's row, and a pull request it opened is named
 * after its item. Its settings (`/settings`, in
 * RepositorySettings.tsx): what is kept for it, set once and seldom visited.
 *
 * Two things are asked, apart from each other. What is saved (`repository`) is the user's actor's
 * own and is there at once. Whether the repository can still be launched on (`githubRepository`) is
 * GitHub's to say and can take a moment or fail: the page does not wait for it, and a repository that
 * GitHub no longer shows to this user keeps its page, with what is saved for it and the way to
 * delete that, and with a plain sentence that no new agent can be launched on it.
 */
import type { GithubId, GithubRepository, RepositoryView, SessionSummary } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasReason } from "../api/client";
import { AgentList } from "../components/Agents";
import { ArrowLeftIcon, AskIcon, ExternalIcon, LockIcon, PlusIcon, WarnIcon } from "../components/Icons";
import { PullState } from "../components/PullRequest";
import { TabPanel, Tabs } from "../components/Tabs";
import type { ConnectionState } from "../api/client";
import { absoluteTime, plural, relativeTime } from "../lib/format";
import { LONE_GROUP_SHOWN, openPulls, ownAgents, repositoryName, sessionsOn } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useGithub, type Github } from "../state/github";
import { useNow, useSessions } from "../state/hooks";
import { RepositoryItems, useItems } from "./Items";
import { RepositorySettings } from "./RepositorySettings";

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
	id: GithubId;
	/** "owner/name": GitHub's own once it answered, otherwise as the agents on it or what was saved for it have it. Null when nothing names it. */
	name: string | null;
	/** Null until it was read. */
	view: RepositoryView | null;
	/** Why what is saved could not be read. */
	error: string | null;
	access: RepositoryAccess;
	/** The user's sessions on it, the most recently used first, their work items' among them (`ownAgents` leaves those out); null until the list arrived. */
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
export function useRepository(id: GithubId): RepositoryPage {
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
						{access.why} What you saved for it is still here, and you can change it or delete it under Settings.
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
											{session.item ? (
												<a className="repo-pull-agent" {...linkProps({ name: "item", id: session.item.id })}>
													work item {session.title}
												</a>
											) : (
												<a className="repo-pull-agent" {...linkProps({ name: "session", id: session.id })}>
													{session.title}
												</a>
											)}
										</span>
										<span title={absoluteTime(pull.pushedAt)}>pushed {relativeTime(pull.pushedAt, now)}</span>
										<span title="What its description said was verified when the platform last wrote it">{pull.verified}</span>
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

/** The page's first view: the agents on the repository, its work items and its open pull requests. */
function Work({ page }: { page: RepositoryPage }) {
	const now = useNow(15_000);
	const { access } = page;
	const sessions = page.sessions === null ? null : ownAgents(page.sessions);
	const name = page.name ?? `Repository ${page.id}`;
	const launchable = access.state !== "unusable";
	return (
		<>
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
						<ul className="agents agents-loading repo-agents" aria-busy="true" aria-label="Reading your agents">
							{[0, 1].map((row) => (
								<li key={row} className="agent-row agent-row-skeleton">
									<span className="skeleton skeleton-dot" />
									<div className="agent-main">
										<span className="skeleton skeleton-title" style={{ width: `${46 - row * 9}%` }} />
										<span className="skeleton skeleton-meta" style={{ width: `${62 - row * 8}%` }} />
									</div>
								</li>
							))}
						</ul>
					)
				) : sessions.length === 0 ? (
					<p className="usage-empty">No agent of yours is on this repository.{launchable ? " Launch one with New agent." : ""}</p>
				) : (
					<div className="repo-agents">
						<AgentList sessions={sessions} limit={LONE_GROUP_SHOWN} foldKey={`repository:${page.id}`} label={`Your agents on ${name}, the most recently used first`} grouped now={now} />
					</div>
				)}
			</section>

			<RepositoryItems repositoryId={page.id} name={name} base={access.state === "usable" ? access.repository.defaultBranch : null} launchable={launchable} now={now} />

			<Pulls page={page} now={now} />
		</>
	);
}

/**
 * The Work tab's name while Settings is shown, with the mark a row has when it waits for its person's
 * answer, when an agent on the repository or one of its work items does.
 */
function WorkLabel({ repositoryId, sessions }: { repositoryId: GithubId; sessions: SessionSummary[] | null }) {
	const { platform } = useApp();
	const items = useItems(Boolean(platform.info?.items));
	const asks = ownAgents(sessions ?? []).some((session) => session.status === "waiting") || (items.list ?? []).some((item) => item.repository.id === repositoryId && item.question !== null);
	return (
		<>
			Work
			{asks ? (
				<>
					<AskIcon size={14} className="status-glyph status-waiting" />
					<span className="visually-hidden"> (something here waits for your answer)</span>
				</>
			) : null}
		</>
	);
}

/** The two views of a repository's page: its work, and what is kept for it. */
export type RepositoryTab = "work" | "settings";

export function Repository({ page, view: tab }: { page: RepositoryPage; view: RepositoryTab }) {
	const github = useGithub();
	const { access } = page;
	const sessions = page.sessions === null ? null : ownAgents(page.sessions);
	const name = page.name ?? `Repository ${page.id}`;
	const launchable = access.state !== "unusable";
	const working = sessions?.filter((session) => session.status !== "idle").length ?? 0;

	return (
		<main className="home usage repo">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">
						repository
						{sessions === null ? "" : ` · ${plural(sessions.length, "agent")}${working > 0 ? ` · ${working} working` : ""}`}
					</p>
					<h1 className="display display-small repo-name">
						{page.name !== null && page.name.includes("/") ? (
							<>
								<span className="repo-name-owner">{page.name.slice(0, page.name.indexOf("/") + 1)}</span>
								{page.name.slice(page.name.indexOf("/") + 1)}
							</>
						) : (
							name
						)}
					</h1>
					{page.name === null && page.view !== null ? <p className="home-account">Nothing here says what it is called: no agent of yours is on it, and GitHub was not heard on it. {page.id} is GitHub's number for it.</p> : null}
					<AccessLine page={page} github={github} />
				</div>
				<button type="button" className="button button-primary button-large" onClick={() => navigate({ name: "new", repository: page.id, ...(tab === "settings" ? { over: "settings" as const } : {}) })} disabled={!launchable} title={launchable ? undefined : "No agent can be launched on this repository now"}>
					<PlusIcon />
					New agent
				</button>
			</header>

			<Tabs
				id="repo-views"
				label={name}
				selected={tab}
				tabs={[
					{ key: "work", label: tab === "settings" ? <WorkLabel repositoryId={page.id} sessions={page.sessions} /> : "Work", route: { name: "repository", id: page.id } },
					{ key: "settings", label: "Settings", route: { name: "repository", id: page.id, view: "settings" } },
				]}
			/>

			<AccessNotice page={page} github={github} />
			<TabPanel id="repo-views" selected={tab}>
				{tab === "settings" ? <RepositorySettings page={page} /> : <Work page={page} />}
			</TabPanel>
		</main>
	);
}
