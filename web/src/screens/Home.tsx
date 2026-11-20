/**
 * Agents: the user's sessions, live, with rename, delete and a way to launch one. They stand under the
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
 */
import { USAGE_LOW_SHARE, type SavedRepository, type UsageNumbers } from "@contract";
import { useEffect, useId, useState } from "react";
import { AgentList } from "../components/Agents";
import { Mark, PlusIcon, WarnIcon } from "../components/Icons";
import { count, localTime, plural, sandboxTime } from "../lib/format";
import { NO_REPOSITORY, groupSessions, ownAgents, shownLimit, workingCounts, workingWords, type SessionGroup } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { NeedsYou } from "./Items";
import { allowanceState, useAllowance, useChatgpt, useFactoryLimits, useNow, useSessions } from "../state/hooks";

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

/** The repositories something is saved for and no session is on (one with only work items has its heading): asked when the screen opens and when a session is added or deleted. */
function useSavedWithoutAgents(sessions: ReturnType<typeof useSessions>["sessions"]): SavedRepository[] {
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
			Signed in as <strong>{auth.profile.email ?? auth.profile.uid}</strong>
			<span className="home-account-sep" aria-hidden="true">
				·
			</span>
			{status === null ? <span className="tone-dim">checking ChatGPT…</span> : status.connected ? <span className="tone-good">ChatGPT connected</span> : <span className="tone-warn">ChatGPT not connected</span>}
		</p>
	);
}

/** The day's sandbox time and the sandboxes kept, in one line, with the way to the usage page. */
function UsageLine({ numbers }: { numbers: UsageNumbers | null }) {
	if (numbers === null) return null;
	const { allowanceSeconds, leftSeconds, sandboxes } = numbers;
	const spent = numbers.usedSeconds + numbers.heldSeconds;
	const state = allowanceState(numbers, USAGE_LOW_SHARE);
	const full = sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	return (
		<p className="home-account home-usage">
			<span>
				Sandbox time today: <strong>{sandboxTime(spent)}</strong>
				{allowanceSeconds === null ? null : ` of ${sandboxTime(allowanceSeconds)}`}
			</span>
			{state !== "plenty" && leftSeconds !== null ? <span className="tone-warn">{state === "used" ? `used up until ${localTime(numbers.resetsAt)}` : `${sandboxTime(leftSeconds)} left`}</span> : null}
			<span className="home-account-sep" aria-hidden="true">
				·
			</span>
			<span className={full ? "tone-warn" : undefined}>
				{sandboxes.limit === null ? plural(sandboxes.kept, "sandbox kept", "sandboxes kept") : `${count(sandboxes.kept)} of ${count(sandboxes.limit)} sandboxes kept`}
			</span>
			<span className="home-account-sep" aria-hidden="true">
				·
			</span>
			<a className="link" {...linkProps({ name: "usage" })}>
				Usage
			</a>
		</p>
	);
}

export function Home() {
	const { sessions, connection, error } = useSessions();
	const now = useNow(15_000);
	const agents = sessions === null ? null : ownAgents(sessions);
	const working = sessions?.filter((session) => session.status !== "idle").length ?? 0;
	// The ceiling on running turns is the deployment's: the user's agents on the platform's sandboxes and every work item's turn count against it.
	const ceiling = useFactoryLimits().value?.runningTurns ?? null;
	const counts = workingCounts(sessions ?? []);
	// Asked again when a session starts or stops working, and when one is added or deleted.
	const usage = useAllowance(`${working}:${sessions?.length ?? 0}`);

	const groups = sessions === null ? [] : groupSessions(sessions);
	const saved = useSavedWithoutAgents(sessions);
	const waiting = agents?.filter((session) => session.status === "waiting").length ?? 0;
	const launch = () => navigate({ name: "new" });

	return (
		<main className="home">
			<header className="home-head">
				<div>
					<p className="eyebrow">
						{agents === null ? "agents" : `${plural(agents.length, "agent")} · ${workingWords(counts, ceiling)}${counts.onMachines > 0 ? ` · ${counts.onMachines}\u00a0on\u00a0your\u00a0machines` : ""}`}
						{waiting > 0 ? <span className="eyebrow-waiting"> · {waiting} {waiting === 1 ? "needs" : "need"} you</span> : null}
					</p>
					<h1 className="display">Agents</h1>
					<AccountLine />
					<UsageLine numbers={usage} />
				</div>
				<button type="button" className="button button-primary button-large" onClick={launch}>
					<PlusIcon />
					Launch an agent
				</button>
			</header>

			{connection === "reconnecting" ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The connection dropped. Reconnecting; the list may be behind.</span>
				</p>
			) : null}

			<NeedsYou now={now} />

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
			) : groups.length === 0 ? (
				<div className="state state-empty">
					<Mark size={56} />
					<h2>No agents yet</h2>
					<p>Launch one: choose the sandbox it works in, point it at a repository if you have one, and tell it what to do.</p>
					<button type="button" className="button button-primary" onClick={launch}>
						<PlusIcon />
						Launch an agent
					</button>
				</div>
			) : (
				groups.map((group) => <Group key={group.key} group={group} limit={shownLimit(groups.length)} headed={groups.length > 1 || group.key !== NO_REPOSITORY} now={now} />)
			)}

			{saved.length > 0 ? (
				<p className="home-saved">
					<span>Saved settings for repositories with no agent:</span>
					{saved.map((repository) => (
						<a key={repository.id} className="link" {...linkProps({ name: "repository", id: repository.id })}>
							{repository.name ?? `repository ${repository.id}`}
						</a>
					))}
				</p>
			) : null}
		</main>
	);
}
