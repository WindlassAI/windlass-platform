/**
 * The Agents home's right side when no one repository is chosen (screens/Workspace.tsx): "Everything",
 * or with `scope` "none" the agents on no repository of the GitHub connection.
 *
 * Agents: the user's sessions, live, with rename and delete, and the start composer at the top
 * (components/StartComposer.tsx): a task and Enter launch one. Without agents, the composer is the
 * empty page's one action. The agents stand under the
 * repository they were launched on, the repository that was used last first, and each repository's
 * name leads to its page; the agents on no repository of the GitHub connection come last. A list with
 * no such repository in it is shown as it always was, without a heading.
 *
 * Under the groups, the repositories something is saved for that have no agent: their pages are
 * where what was saved is changed or deleted, and nothing else leads there.
 *
 * The sessions of work items are not listed: each is part of its item, and is opened from the item's
 * row and page. A repository that has only work items keeps its heading, with how many, so that its
 * page is still a click away. The count of what is at work is the server's, against the ceiling on
 * running turns, and says how much of it is work items'.
 *
 * The filters of the home (lib/workspace.ts) narrow the lists: with any of them on, the work items they
 * leave are listed too, under the agents.
 */
import { USAGE_LOW_SHARE, type ItemSummary, type MachineSummary, type SavedRepository, type SessionSummary, type UsageNumbers } from "@contract";
import { useEffect, useId, useState } from "react";
import { AgentList } from "../components/Agents";
import { Mark, WarnIcon } from "../components/Icons";
import { ItemTable, itemsByUrgency } from "../components/ItemTable";
import { NeedsYouCard } from "../components/NeedsYouCard";
import { StartComposer } from "../components/StartComposer";
import { FilterBar, ListHeader } from "../components/WorkspaceFilters";
import { count, localTime, plural, sandboxTime } from "../lib/format";
import { NO_REPOSITORY, groupSessions, ownAgents, shownLimit, workingCounts, workingWords, type SessionGroup } from "../lib/repositories";
import { linkProps } from "../lib/router";
import { filterCount, matchesItem, matchesSession, type Filters } from "../lib/workspace";
import { useApp, useAuth } from "../state/app";
import { asking } from "./Items";
import { allowanceState, useChatgpt, useFactoryLimits, useNow, type SessionsState } from "../state/hooks";

/** One repository's agents under its name, or the agents on none. `headed` is false for a list that has only the latter. */
function Group({ group, limit, headed, now }: { group: SessionGroup; limit: number; headed: boolean; now: number }) {
	const heading = useId();
	const repository = group.repository;
	const name = repository ? `${repository.owner}/${repository.name}` : "No connected repository";
	return (
		<section className="agent-group" aria-labelledby={headed ? heading : undefined} aria-label={headed ? undefined : "Your agents"}>
			{headed ? (
				<h2 className="agent-group-head" id={heading}>
					{repository ? (
						<a className="agent-group-name" {...linkProps({ name: "repository", id: repository.id })} title={`What is saved for ${name}, and its pull requests`}>
							<span className="agent-group-owner">{repository.owner}/</span>
							{repository.name}
						</a>
					) : (
						<span className="agent-group-name">{name}</span>
					)}
					<span className="agent-group-count">
						{[group.sessions.length > 0 ? plural(group.sessions.length, "agent") : null, group.working > 0 ? `${group.working} working` : null, group.items > 0 ? plural(group.items, "work item") : null].filter((part) => part !== null).join(" · ")}
					</span>
				</h2>
			) : null}
			{group.sessions.length > 0 ? (
				<AgentList sessions={group.sessions} limit={limit} foldKey={`home:${group.key}`} label={repository ? `Your agents on ${name}, the most recently used first` : "Your agents on no connected repository, the most recently used first"} grouped={repository !== null} now={now} />
			) : null}
		</section>
	);
}

/** The repositories something is saved for: asked when the screen opens and when a session is added or deleted. Empty until they arrive, or where they could not be read. */
export function useSavedRepositories(sessions: readonly SessionSummary[] | null): SavedRepository[] {
	const { client } = useApp();
	const auth = useAuth();
	const [saved, setSaved] = useState<SavedRepository[]>([]);
	const known = sessions?.length ?? -1;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `known` is not read here; a change of it is when to ask again
	useEffect(() => {
		let current = true;
		client
			.user(auth)
			.savedRepositories()
			.then(
				(list) => current && setSaved(list),
				// The list of agents does not depend on it: without it, the line is left out.
				() => current && setSaved([]),
			);
		return () => {
			current = false;
		};
	}, [client, auth, known]);
	return saved;
}

/** Of those, the ones no session is on (one with only work items has its heading). */
export function savedWithoutAgents(saved: readonly SavedRepository[], sessions: readonly SessionSummary[] | null): SavedRepository[] {
	if (sessions === null) return [];
	const used = new Set(sessions.map((session) => session.repository?.id));
	return saved.filter((repository) => !used.has(repository.id));
}

function AccountLine() {
	const auth = useAuth();
	const { status } = useChatgpt();
	if (auth.profile.demo) {
		return (
			<p className="home-account">
				<span className="chip chip-warn">demo</span>
				Signed in as a demo user. Its agents run a scripted model with real tool calls.
			</p>
		);
	}
	return (
		<p className="home-account">
			<span className="home-account-who">{auth.profile.email ?? auth.profile.uid}</span>
			{status === null ? <span className="tone-faint">checking ChatGPT…</span> : status.connected ? <span className="home-account-ok">ChatGPT connected</span> : <span className="tone-warn">ChatGPT not connected</span>}
		</p>
	);
}

/**
 * The day's sandbox time as a small meter, and the sandboxes kept, leading to the usage page. It takes
 * the warning hue when the day's time runs low or out, or no more sandboxes may be kept.
 */
export function UsageMeter({ numbers }: { numbers: UsageNumbers | null }) {
	if (numbers === null) return null;
	const { allowanceSeconds, leftSeconds, sandboxes } = numbers;
	const spent = numbers.usedSeconds + numbers.heldSeconds;
	const state = allowanceState(numbers, USAGE_LOW_SHARE);
	const full = sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	const share = allowanceSeconds === null || allowanceSeconds === 0 ? null : Math.min(1, spent / allowanceSeconds);
	const kept = sandboxes.limit === null ? plural(sandboxes.kept, "sandbox kept", "sandboxes kept") : `${count(sandboxes.kept)} of ${count(sandboxes.limit)} kept`;
	return (
		<a className={`home-usage${state !== "plenty" ? " home-usage-warn" : ""}`} {...linkProps({ name: "usage" })} title="Usage: sandbox time and sandboxes">
			<span className="home-usage-time">
				Sandbox today <strong>{sandboxTime(spent)}</strong>
				{allowanceSeconds === null ? null : ` of ${sandboxTime(allowanceSeconds)}`}
				{state !== "plenty" && leftSeconds !== null ? <span className="home-usage-left">{state === "used" ? `, used up until ${localTime(numbers.resetsAt)}` : `, ${sandboxTime(leftSeconds)} left`}</span> : null}
			</span>
			{share === null ? null : (
				<span className="home-meter" role="meter" aria-label="Sandbox time used today" aria-valuemin={0} aria-valuemax={allowanceSeconds ?? 0} aria-valuenow={Math.min(spent, allowanceSeconds ?? spent)} aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowanceSeconds ?? 0)}`}>
					<span className="home-meter-fill" style={{ width: `${Math.max(share, spent > 0 ? 0.04 : 0) * 100}%` }} />
				</span>
			)}
			<span className={full ? "home-usage-full" : undefined}>
				{kept}
				{full ? <span className="visually-hidden"> (the most an account may keep)</span> : null}
			</span>
		</a>
	);
}

/** What the page holds at a glance: how many agents, how many at work, and how many wait on their user. */
function Facts({ agents, counts, ceiling, waiting }: { agents: number | null; counts: ReturnType<typeof workingCounts>; ceiling: number | null; waiting: number }) {
	const sep = <span className="visually-hidden">, </span>;
	const working = counts.ceilinged + counts.onMachines;
	return (
		<p className="home-facts">
			<span>
				<strong>{agents === null ? "–" : count(agents)}</strong> {agents === 1 ? "agent" : "agents"}
			</span>
			{sep}
			<span className={`home-fact${working > 0 ? " home-fact-working" : ""}`}>{workingWords(counts, ceiling)}</span>
			{counts.onMachines > 0 ? (
				<>
					{sep}
					<span className="home-fact home-fact-working">{counts.onMachines}&nbsp;on&nbsp;your&nbsp;machines</span>
				</>
			) : null}
			{waiting > 0 ? (
				<>
					{sep}
					<span className="home-fact home-fact-needs">
						{waiting} {waiting === 1 ? "needs" : "need"} you
					</span>
				</>
			) : null}
		</p>
	);
}

export interface HomeProps {
	/** The user's sessions, live, as the home reads them once for the rail and this side both. */
	state: SessionsState;
	/** The user's work items, read once for the page and the bar (null until they arrive; none where the deployment offers none). */
	items: readonly ItemSummary[] | null;
	/** The repositories something is saved for. */
	saved: readonly SavedRepository[];
	usage: UsageNumbers | null;
	/** "none": the agents on no repository of the GitHub connection alone. */
	scope?: "all" | "none";
	filters: Filters;
	onFilters(filters: Filters): void;
	machines: readonly MachineSummary[];
}

export function Home({ state, items, saved: savedAll, usage, scope = "all", filters, onFilters, machines }: HomeProps) {
	const { sessions, connection, error } = state;
	const now = useNow(15_000);
	const filtering = filterCount(filters) > 0;
	const agents = sessions === null ? null : ownAgents(sessions);
	// The ceiling is the deployment's, on hosted sandboxes: the user's agents and work items on the platform's sandboxes count against it, never a machine's.
	const ceiling = useFactoryLimits().value?.hostedRunning ?? null;
	const counts = workingCounts(sessions ?? []);

	// With a filter on, a work item's session is not counted under its repository: its item is listed below instead.
	const shown = sessions === null ? null : sessions.filter((session) => (session.item !== undefined ? !filtering : matchesSession(session, filters)));
	const grouped = shown === null ? [] : groupSessions(shown);
	const groups = scope === "none" ? grouped.filter((group) => group.key === NO_REPOSITORY) : grouped;
	const saved = scope === "none" ? [] : savedWithoutAgents(savedAll, sessions);
	const waiting = agents?.filter((session) => session.status === "waiting").length ?? 0;
	const asked = asking(items ?? []).length;
	const matchingItems = scope === "none" || !filtering ? [] : itemsByUrgency((items ?? []).filter((item) => !item.parent && matchesItem(item, filters)));
	// Without agents the composer stands in the empty page; otherwise at the top, over the list.
	const empty = sessions !== null && connection !== "failed" && (agents?.length ?? 0) === 0 && grouped.length === 0;
	const needsSessions = (agents ?? []).filter((session) => (scope === "none" ? !session.repository : true) && matchesSession(session, filters));
	const needsItems = scope === "none" ? [] : items === null ? null : items.filter((item) => matchesItem(item, filters));
	const nothingLeft = !empty && sessions !== null && groups.length === 0 && matchingItems.length === 0;

	return (
		<main className="home home-agents ws-pane">
			<header className="home-head">
				<div className="home-title">
					<h1 className="display">{scope === "none" ? "No repository" : "Agents"}</h1>
					<Facts agents={agents === null ? null : agents.length} counts={counts} ceiling={ceiling} waiting={waiting + asked} />
					<AccountLine />
				</div>
				<div className="ws-head-usage">
					<UsageMeter numbers={usage} />
				</div>
			</header>

			{empty ? null : (
				<section className="home-start" aria-label="Launch an agent">
					<StartComposer sessions={sessions} />
				</section>
			)}

			{connection === "reconnecting" ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The connection dropped. Reconnecting; the list may be behind.</span>
				</p>
			) : null}

			<NeedsYouCard sessions={needsSessions} items={needsItems} now={now} />

			{empty || connection === "failed" ? null : (
				<div className="ws-list-bar">
					<h2 className="ws-section-title">{scope === "none" ? "Agents" : "By repository"}</h2>
					<FilterBar filters={filters} onChange={onFilters} machines={machines} />
				</div>
			)}

			{connection === "failed" ? (
				<div className="state state-error" role="alert">
					<WarnIcon size={22} />
					<h2>The list of agents could not be loaded</h2>
					<p>{error?.message ?? "The server could not be reached."}</p>
					<button type="button" className="button button-outline" onClick={() => location.reload()}>
						Try again
					</button>
				</div>
			) : sessions === null ? (
				<ul className="agents agents-loading" aria-busy="true" aria-label="Loading agents">
					{[0, 1, 2, 3].map((row) => (
						<li key={row} className="agent-row agent-row-skeleton">
							<span className="skeleton skeleton-dot" />
							<div className="agent-main">
								<span className="skeleton skeleton-title" style={{ width: `${46 - row * 7}%` }} />
								<span className="skeleton skeleton-meta" style={{ width: `${62 - row * 5}%` }} />
							</div>
						</li>
					))}
				</ul>
			) : empty ? (
				<div className="state state-empty home-empty">
					<Mark size={56} />
					<h2>No agents yet</h2>
					<p>Say what it should do and press Enter. The repository, where it runs and its sandbox are under the field.</p>
					<StartComposer sessions={sessions} autoFocus />
				</div>
			) : nothingLeft ? (
				<p className="usage-empty ws-empty">{filtering ? "Nothing here matches the filters." : scope === "none" ? "No agent of yours is on no repository." : "Nothing here yet."}</p>
			) : (
				groups.map((group) => <Group key={group.key} group={group} limit={shownLimit(groups.length)} headed={scope === "all" && (groups.length > 1 || group.key !== NO_REPOSITORY)} now={now} />)
			)}

			{matchingItems.length > 0 ? (
				<section className="ws-section" aria-labelledby="home-items">
					<ListHeader id="home-items" title="Work items" count={matchingItems.length} />
					<ItemTable items={matchingItems.slice(0, 12)} now={now} label="Work items the filters leave, what asks you first" repository />
					{matchingItems.length > 12 ? (
						<p className="agents-fold">
							<a className="link" {...linkProps({ name: "factory" })}>
								All {count(matchingItems.length)} in Factory
							</a>
						</p>
					) : null}
				</section>
			) : null}

			{saved.length > 0 ? (
				<p className="home-saved">
					<span>Saved settings for repositories with no agent:</span>
					{saved.map((repository) => (
						<a key={repository.id} className="link" {...linkProps({ name: "repository", id: repository.id, view: "settings" })}>
							{repository.name ?? `repository ${repository.id}`}
						</a>
					))}
				</p>
			) : null}
		</main>
	);
}
