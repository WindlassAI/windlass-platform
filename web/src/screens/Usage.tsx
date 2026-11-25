/**
 * Usage: today's sandbox time against the day's allowance and when it resets, what each agent's
 * sandbox ran today, the sandboxes the user keeps with a way to free one, the last two weeks day by
 * day, and what all of it is estimated to cost.
 *
 * Every number is the user's actor's (`UsageView`): the page reads it when it opens, again whenever the
 * actor says something changed, and once a minute. Lengths of time in the tables are written as
 * h:mm:ss so that they line up; a day is a UTC day, and the time it ends is said in the viewer's own
 * time zone.
 *
 * A work item's agent session is part of its item. Its sandbox time today is not listed by agent: the
 * work items' is one row of the day's table, with the way to the items' own costs (FactoryUsage.tsx),
 * which say what each item has spent in all against its budget. Which sessions are items' is read from
 * the summaries the page's own live feed sends.
 */
import { HostedNotice, MonthFigure } from "../components/Plan";
import { monthName, monthReset } from "../lib/hosted";
import { USAGE_HISTORY_DAYS, type HostedSize, type KeptSandbox, type SessionSummary, type UsageView } from "@contract";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "../components/Dialog";
import { FoldRows } from "../components/Fold";
import { FactoryUsage } from "../components/FactoryUsage";
import { MachineUsage } from "../components/MachineUsage";
import { ArrowLeftIcon, WarnIcon } from "../components/Icons";
import { SandboxState } from "../components/Status";
import { absoluteTime, compact, count, localTime, plural, relativeTime, sandboxClock, sandboxTime as spelledTime, usd, utcDay } from "../lib/format";
import { linkProps } from "../lib/router";
import { perHour, sizeName, sizeSpec } from "../lib/sizes";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { readTwice } from "../lib/retry";

/** A length of sandbox time in a sentence: the number and its unit stay on one line. */
const sandboxTime = (seconds: number) => spelledTime(seconds).replace(/ /g, "\u00a0");

/** What the top bar shows on this page: the way back and where one is. */
export function UsageCrumb() {
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
				Usage
			</span>
		</nav>
	);
}

/** The page's numbers, read again when the user's actor says they changed and once a minute; and which of the user's sessions are work items', by session. */
function useUsage(): { view: UsageView | null; error: string | null; items: Map<string, string> | null; reload(): void; replace(view: UsageView): void } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [view, setView] = useState<UsageView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const reading = useRef(false);
	const again = useRef(false);

	const read = useCallback(() => {
		// One reading at a time: a change that comes meanwhile is read after it.
		if (reading.current) {
			again.current = true;
			return;
		}
		reading.current = true;
		readTwice(() => client.user(auth).usage())
			.then(
				(value) => {
					setView(value);
					setError(null);
				},
				(failure: unknown) => setError(explain(failure)),
			)
			.finally(() => {
				reading.current = false;
				if (again.current) {
					again.current = false;
					read();
				}
			});
	}, [client, auth, explain]);

	useEffect(() => {
		read();
		const timer = setInterval(read, 60_000);
		const close = client.user(auth).watch({ onSessions: setSessions, onUsage: read });
		return () => {
			clearInterval(timer);
			close();
		};
	}, [client, auth, read]);

	const items = sessions === null ? null : new Map<string, string>();
	for (const session of sessions ?? []) {
		if (!session.item) continue;
		items?.set(session.id, session.item.id);
		if (session.item.reviewer) items?.set(session.item.reviewer.id, session.item.id);
	}
	return { view, error, items, reload: read, replace: setView };
}

/** What freeing a sandbox takes with it and what it leaves, for the agent it belongs to. */
function FreeDialog({ sandbox, memory, onClose, onFreed }: { sandbox: KeptSandbox; memory: UsageView["memory"]; onClose(): void; onFreed(view: UsageView): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const free = async () => {
		setBusy(true);
		setError(null);
		try {
			onFreed(await client.user(auth).freeSandbox(sandbox.sessionId));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Free this sandbox?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={free} disabled={busy}>
						{busy ? "Freeing…" : "Free sandbox"}
					</button>
				</>
			}
		>
			{sandbox.title === null ? (
				<p>This sandbox was left behind by an agent that no longer exists. Nothing uses it; freeing it removes it with the files in it.</p>
			) : (
				<>
					<p>
						The sandbox of <strong>{sandbox.title}</strong> is removed to make room for another. The agent itself stays.
					</p>
					<dl className="usage-ledger">
						<dt>Lost</dt>
						<dd>
							{sandbox.repository === null
								? "Every file in its workspace: what it wrote, installed and built. It has no repository at GitHub, so none of it comes back."
								: "Every file in its workspace that is not on GitHub: changes that were not committed, commits that were not pushed, installed dependencies, anything it built. "}
							{sandbox.repository === null
								? null
								: sandbox.pushed
									? `What was pushed to ${sandbox.repository} is cloned again into its next sandbox.`
									: `Nothing of its work was pushed to ${sandbox.repository}, so its next sandbox starts from the repository as GitHub has it.`}
						</dd>
						{memory === "lost" ? (
							<dd>The agent's own memory of the conversation: this deployment keeps it in the sandbox only, so the agent starts its next turn without it.</dd>
						) : null}
						<dt>Kept</dt>
						<dd>The agent and its conversation, as you see them here.</dd>
						{memory === "lost" ? null : <dd>The agent's own memory of the conversation. It is told that its workspace is a new one.</dd>}
					</dl>
					<p>Its next prompt starts a new sandbox. This cannot be undone.</p>
				</>
			)}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

/** Today's allowance as a bar: what was counted, what running sandboxes hold, and what is left. */
function Meter({ view }: { view: UsageView }) {
	const allowance = view.allowanceSeconds;
	if (allowance === null) return null;
	const spent = view.usedSeconds + view.heldSeconds;
	const share = (seconds: number) => `${Math.min(100, (seconds / Math.max(allowance, spent)) * 100)}%`;
	return (
		<div className="usage-meter" role="meter" aria-label="Hosted time used or held today" aria-valuemin={0} aria-valuemax={allowance} aria-valuenow={Math.min(allowance, spent)} aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowance)}`}>
			{view.usedSeconds > 0 ? <span className="usage-meter-used" style={{ width: share(view.usedSeconds) }} /> : null}
			{view.heldSeconds > 0 ? <span className="usage-meter-held" style={{ width: share(view.heldSeconds) }} /> : null}
		</div>
	);
}

/** The views under the page's summary, each named by the id its tab has. */
type UsageTab = "usage-agents" | "usage-items" | "usage-kept" | "usage-machines" | "usage-history";
const USAGE_TABS: readonly UsageTab[] = ["usage-agents", "usage-items", "usage-kept", "usage-machines", "usage-history"];

/** The chosen view, kept in the address's fragment so that a link to `#usage-items` opens that view. */
function useTabFromHash(): [UsageTab, (tab: UsageTab) => void] {
	const read = (): UsageTab => USAGE_TABS.find((one) => `#${one}` === location.hash) ?? "usage-agents";
	const [tab, setTab] = useState<UsageTab>(read);
	useEffect(() => {
		const follow = () => setTab(read());
		addEventListener("hashchange", follow);
		return () => removeEventListener("hashchange", follow);
	}, []);
	const choose = useCallback((next: UsageTab) => {
		setTab(next);
		history.replaceState(history.state, "", next === "usage-agents" ? location.pathname + location.search : `#${next}`);
	}, []);
	return [tab, choose];
}

/** The row of tabs: one in the order of Tab at a time; the arrow keys, Home and End move between them. */
function UsageTabs({ tabs, selected, onSelect }: { tabs: { id: UsageTab; label: string; count?: string }[]; selected: UsageTab; onSelect(tab: UsageTab): void }) {
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const at = tabs.findIndex((one) => one.id === selected);
		const to = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
		const next = to === null ? undefined : tabs[to];
		if (!next) return;
		event.preventDefault();
		onSelect(next.id);
		document.getElementById(next.id)?.focus();
	};
	return (
		<div className="tabs usage-tabs" role="tablist" aria-label="Usage in detail" onKeyDown={onKeyDown}>
			{tabs.map((one) => (
				<button key={one.id} type="button" id={one.id} className="tab" role="tab" aria-selected={one.id === selected} aria-controls={one.id === selected ? `${one.id}-panel` : undefined} tabIndex={one.id === selected ? 0 : -1} onClick={() => onSelect(one.id)}>
					{one.label}
					{one.count ? <span className="tab-count">{one.count}</span> : null}
				</button>
			))}
		</div>
	);
}

export function Usage() {
	const { platform } = useApp();
	const { view, error, items, reload, replace } = useUsage();
	const now = useNow(15_000);
	const [showHeld, setShowHeld] = useState(false);
	const [freeing, setFreeing] = useState<KeptSandbox | null>(null);
	const [tab, setTab] = useTabFromHash();

	if (view === null) {
		return (
			<main className="home usage">
				<header className="home-head">
					<div>
						<p className="eyebrow">usage</p>
						<h1 className="display">Usage</h1>
					</div>
				</header>
				{error ? (
					<div className="state state-error" role="alert">
						<WarnIcon size={22} />
						<h2>Your usage could not be loaded</h2>
						<p>{error}</p>
						<button type="button" className="button button-outline" onClick={reload}>
							Try again
						</button>
					</div>
				) : (
					<div className="usage-loading" aria-busy="true" aria-label="Loading your usage">
						<span className="skeleton skeleton-title" style={{ width: "34%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "46%" }} />
					</div>
				)}
			</main>
		);
	}

	const allowance = view.allowanceSeconds;
	const spent = view.usedSeconds;
	const left = view.leftSeconds;
	const price = view.price;
	// Where there are hosted sizes, each agent's time is priced at its own size's rate; the allowance counts seconds alike.
	const sizes = view.hostedSizes && view.hostedSizes.length > 1 ? view.hostedSizes : null;
	const rate = (size?: HostedSize) => {
		const hourly = size && sizes?.find((one) => one.id === size)?.usdPerHour;
		return typeof hourly === "number" ? hourly / 3600 : (price?.usdPerSecond ?? 0);
	};
	const costAt = (seconds: number, size?: HostedSize) => (price === null ? null : usd(seconds * rate(size)));
	const todayUsd = sizes ? view.today.reduce((sum, row) => sum + row.seconds * rate(row.hostedSize), 0) : null;
	const cost = (seconds: number) => (price === null ? null : usd(seconds * price.usdPerSecond));
	const running = view.today.filter((row) => row.heldSeconds > 0).length;
	const unreported = view.today.reduce((sum, row) => sum + row.unreportedSeconds, 0);
	// The agents' rows, and the work items' sessions' together in one.
	const agentRows = view.today.filter((row) => !items?.has(row.sessionId));
	const itemRows = view.today.filter((row) => items?.has(row.sessionId));
	const itemTotal = itemRows.reduce((sum, row) => ({ seconds: sum.seconds + row.seconds, held: sum.held + row.heldSeconds, unreported: sum.unreported + row.unreportedSeconds }), { seconds: 0, held: 0, unreported: 0 });
	const { kept, limit } = view.sandboxes;
	const most = Math.max(allowance ?? 0, ...view.days.map((day) => day.seconds), 1);
	const historyTotal = view.days.reduce((sum, day) => sum + day.seconds, 0);
	const resets = localTime(view.resetsAt);
	// A viewer whose own time is UTC is told the hour once.
	const abroad = new Date(view.resetsAt).getTimezoneOffset() !== 0;
	const untilReset = sandboxTime(Math.max(60, Math.ceil((view.resetsAt - now) / 60_000) * 60));

	const tabs: { id: UsageTab; label: string; count?: string }[] = [
		{ id: "usage-agents", label: "Today by agent" },
		...(platform.info?.items ? [{ id: "usage-items" as const, label: "Work items" }] : []),
		{ id: "usage-kept", label: "Kept sandboxes", count: limit === null ? count(kept) : `${count(kept)} of ${count(limit)}` },
		...(platform.info?.machines ? [{ id: "usage-machines" as const, label: "My machines" }] : []),
		{ id: "usage-history", label: `Last ${USAGE_HISTORY_DAYS} days` },
	];
	const shown = tabs.some((one) => one.id === tab) ? tab : "usage-agents";
	const historyUsd = price === null ? null : cost(historyTotal);
	// The figures at the top in whole cents; the tables keep their finer amounts.
	const cents = (amount: number) => `$${amount.toFixed(2)}`;
	const leftWords = left === null ? "No daily limit" : left < view.startSeconds ? (left === 0 ? "None left" : `${sandboxTime(left)} left, too little for a turn`) : `${sandboxTime(left)} left`;

	return (
		<main className="home usage">
			<header className="home-head">
				<div>
					<p className="eyebrow">The day ends {resets}</p>
					<h1 className="display">Usage</h1>
				</div>
			</header>

			{error ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{error} <button className="link" onClick={reload}>Try again</button></span>
				</p>
			) : null}

			{view.hosted ? <HostedNotice numbers={view} pro={platform.info?.billing?.plans.find((plan) => plan.id === "pro") ?? null} /> : null}

			<section className="usage-summary" aria-label="At a glance">
				<div className="usage-summary-figures">
					<div className="usage-summary-cell usage-summary-main">
						<h2 className="usage-summary-label">Hosted time today</h2>
						<p className="usage-summary-figure">
							<strong>{sandboxTime(spent)}</strong>
							{allowance === null ? null : <span> of {sandboxTime(allowance)}</span>}
						</p>
						<Meter view={view} />
						<p className="usage-summary-sub">
							{leftWords}
							{allowance === null ? null : <> · resets in {untilReset}</>}
						</p>
					</div>
					<div className="usage-summary-cell">
						<h2 className="usage-summary-label">Model tokens today</h2>
						<p className="usage-summary-figure">
							<strong>{compact(view.usedModelTokens)}</strong>
							{view.factoryLimits.dailyTokens === null ? null : <span> of {compact(view.factoryLimits.dailyTokens)}</span>}
						</p>
						<p className="usage-summary-sub">{view.factoryLimits.dailyTokens === null ? "No daily cap" : "On Windlass’s sign-in"}</p>
						{view.providerTokens?.map((row) => (
							<p key={row.provider} className="usage-summary-sub">
								Your {row.provider} key: {compact(row.tokens)}
							</p>
						))}
					</div>
					{price ? (
						<div className="usage-summary-cell">
							<h2 className="usage-summary-label">Estimated today</h2>
							<p className="usage-summary-figure" title="Estimate">
								<strong>≈ {cents(todayUsd ?? view.usedSeconds * price.usdPerSecond)}</strong>
							</p>
							<p className="usage-summary-sub">
								{cents(historyTotal * price.usdPerSecond)} in {USAGE_HISTORY_DAYS} days
							</p>
						</div>
					) : null}
				</div>
				{view.hosted ? (
					<div className="usage-summary-month">
						<h2 className="usage-summary-label">
							Hosted time{view.hosted.plan === "pro" ? "" : " this month"} · {monthName(view.hosted)}
						</h2>
						<MonthFigure month={view.hosted} />
						<p className="usage-summary-sub">
							Resets on {monthReset(view.hosted)}.
							{platform.info?.billing ? (
								<>
									{" "}
									<a className="link" {...linkProps({ name: "settings" })}>
										Manage your plan
									</a>
								</>
							) : null}
						</p>
					</div>
				) : null}
				<div className="usage-summary-foot">
					<span>
						Kept sandboxes <strong>{limit === null ? count(kept) : `${count(kept)} of ${count(limit)}`}</strong>
					</span>
					<span>
						Running now <strong>{count(running)}</strong>
					</span>
					<details className="usage-summary-details">
						<summary>Details</summary>
						<div className="usage-summary-more">
							<dl className="usage-facts">
								<div>
									<dt>
										<span className="usage-swatch usage-swatch-used" aria-hidden="true" />
										Counted
									</dt>
									<dd className="usage-number">{sandboxClock(view.usedSeconds)}</dd>
									<dd className="usage-gloss">what your sandboxes ran today before they stopped</dd>
								</div>
								<div>
									<dt>
										<span className="usage-swatch usage-swatch-held" aria-hidden="true" />
										Held
									</dt>
									<dd className="usage-number">{sandboxClock(view.heldSeconds)}</dd>
									<dd className="usage-gloss">{running === 0 ? "no sandbox is running now" : `for ${plural(running, "sandbox", "sandboxes")} running now; what one does not use is free again when it stops`}</dd>
								</div>
								{allowance !== null ? (
									<div>
										<dt>Resets</dt>
										<dd className="usage-number">{resets}</dd>
										<dd className="usage-gloss">
											in {untilReset}
											{abroad ? ", at 00:00 UTC" : ""}
										</dd>
									</div>
								) : null}
							</dl>
							{sizes ? (
								<ul className="usage-size-list" aria-label="Estimated prices">
									{sizes.map((size) => (
										<li key={size.id}>
											<span className="usage-size-name">{sizeName(size.id)}</span>
											<span className="tone-dim">{sizeSpec(size.id)}</span>
											<span className="usage-number">{perHour(size.usdPerHour) ?? "–"}</span>
										</li>
									))}
								</ul>
							) : null}
						</div>
					</details>
				</div>
			</section>

			<UsageTabs tabs={tabs} selected={shown} onSelect={setTab} />

			{shown === "usage-agents" ? (
				<section className="usage-panel" role="tabpanel" id="usage-agents-panel" aria-labelledby="usage-agents">
					{view.today.length === 0 ? (
						<p className="usage-empty">No sandbox has run today.</p>
					) : (
						<table className="usage-table">
							<thead>
								<tr>
									<th scope="col">Agent</th>
									<th scope="col" className="usage-number">
										Used
									</th>
									<th scope="col" className="usage-number" hidden={!showHeld}>
										Held
									</th>
									{price === null ? null : (
										<th scope="col" className="usage-number">
											Est. cost
										</th>
									)}
								</tr>
							</thead>
							<tbody>
								{agentRows.map((row) => (
									<tr key={row.sessionId}>
										<th scope="row">
											{row.title === null ? (
												<span className="tone-dim">an agent that was deleted</span>
											) : (
												<a className="usage-agent" {...linkProps({ name: "session", id: row.sessionId })}>
													{row.title}
												</a>
											)}
											{sizes && row.hostedSize ? <span className="usage-size-tag">{sizeName(row.hostedSize)}</span> : null}
											{row.unreportedSeconds > 0 ? (
												<span className="usage-mark" title="Includes estimated time">
													{" "}
													*
												</span>
											) : null}
										</th>
										<td className="usage-number">{sandboxClock(row.seconds)}</td>
										<td className="usage-number" hidden={!showHeld}>
											{row.heldSeconds > 0 ? sandboxClock(row.heldSeconds) : <span className="tone-faint">–</span>}
										</td>
										{price === null ? null : <td className="usage-number">{costAt(row.seconds, row.hostedSize)}</td>}
									</tr>
								))}
								{itemRows.length > 0 ? (
									<tr>
										<th scope="row">
											<a
												className="usage-agent"
												href="#usage-items"
												onClick={(event) => {
													event.preventDefault();
													setTab("usage-items");
												}}
											>
												{plural(new Set(itemRows.map((row) => items?.get(row.sessionId))).size, "work item")}
											</a>
											{itemTotal.unreported > 0 ? (
												<span className="usage-mark" title="Includes estimated time">
													{" "}
													*
												</span>
											) : null}
										</th>
										<td className="usage-number">{sandboxClock(itemTotal.seconds)}</td>
										<td className="usage-number" hidden={!showHeld}>
											{itemTotal.held > 0 ? sandboxClock(itemTotal.held) : <span className="tone-faint">–</span>}
										</td>
										{price === null ? null : <td className="usage-number">{sizes ? usd(itemRows.reduce((sum, row) => sum + row.seconds * rate(row.hostedSize), 0)) : cost(itemTotal.seconds)}</td>}
									</tr>
								) : null}
							</tbody>
							<tfoot>
								<tr>
									<th scope="row">Today</th>
									<td className="usage-number">{sandboxClock(view.usedSeconds)}</td>
									<td className="usage-number" hidden={!showHeld}>
										{view.heldSeconds > 0 ? sandboxClock(view.heldSeconds) : <span className="tone-faint">–</span>}
									</td>
									{price === null ? null : <td className="usage-number">{todayUsd !== null ? usd(todayUsd) : cost(view.usedSeconds)}</td>}
								</tr>
							</tfoot>
						</table>
					)}
					<div className="usage-panel-notes">
						{unreported > 0 ? <p className="usage-note">* Includes up to {sandboxTime(unreported)} estimated.</p> : null}
						{view.today.length > 0 ? (
							<button type="button" className="link usage-panel-toggle" aria-pressed={showHeld} onClick={() => setShowHeld((on) => !on)}>
								{showHeld ? "Hide held time" : "Show held time"}
							</button>
						) : null}
					</div>
				</section>
			) : null}

			{shown === "usage-items" ? (
				<section className="usage-panel" role="tabpanel" id="usage-items-panel" aria-labelledby="usage-items">
					<FactoryUsage value={view.factoryLimits} />
				</section>
			) : null}

			{shown === "usage-kept" ? (
				<section className="usage-panel" role="tabpanel" id="usage-kept-panel" aria-labelledby="usage-kept">
					<p className="usage-lede">{limit === null ? "Your hosted workspaces, running or paused." : "Free one to make room for more agents."}</p>
					{view.kept.length === 0 ? (
						<p className="usage-empty">You keep no sandbox.</p>
					) : (
						<FoldRows items={view.kept} shown={8}>
							{(rows, id) => (
								<ul className="usage-kept" id={id}>
									{rows.map((sandbox) => (
										<li key={sandbox.sessionId} className="usage-kept-row">
											<div className="usage-kept-main">
												{sandbox.title === null ? (
													<span className="usage-kept-title tone-dim">Left behind by an agent that no longer exists</span>
												) : (
													<a className="usage-kept-title usage-agent" {...linkProps(items?.has(sandbox.sessionId) ? { name: "item", id: items.get(sandbox.sessionId) as string } : { name: "session", id: sandbox.sessionId })}>
														{sandbox.title}
													</a>
												)}
												<p className="agent-meta">
													{items?.has(sandbox.sessionId) ? <span>work item</span> : null}
													{sizes && sandbox.hostedSize ? <span>{`${sizeName(sandbox.hostedSize)}, ${perHour(sizes.find((one) => one.id === sandbox.hostedSize)?.usdPerHour) ?? ""}`.replace(/, $/, "")} while running</span> : null}
													{sandbox.repository ? <span className="agent-repo">{sandbox.repository}</span> : <span>no repository at GitHub</span>}
													{sandbox.repository ? <span>{sandbox.pushed ? "work pushed" : "nothing pushed"}</span> : null}
													{sandbox.usedAt !== null ? <span title={absoluteTime(sandbox.usedAt)}>used {relativeTime(sandbox.usedAt, now)}</span> : null}
												</p>
											</div>
											{sandbox.state === "starting" ? <span className="sandbox-state">being made</span> : <SandboxState state={sandbox.state} />}
											<button type="button" className="button button-outline button-small" onClick={() => setFreeing(sandbox)} disabled={sandbox.busy || sandbox.state === "starting"} title={sandbox.busy ? "It is working: stop its turn first" : undefined}>
												{sandbox.busy ? "Working" : "Free…"}
											</button>
										</li>
									))}
								</ul>
							)}
						</FoldRows>
					)}
				</section>
			) : null}

			{shown === "usage-machines" ? (
				<section className="usage-panel" role="tabpanel" id="usage-machines-panel" aria-labelledby="usage-machines">
					<MachineUsage />
				</section>
			) : null}

			{shown === "usage-history" ? (
				<section className="usage-panel" role="tabpanel" id="usage-history-panel" aria-labelledby="usage-history">
					<table className="usage-table usage-history">
						<thead>
							<tr>
								<th scope="col">Day</th>
								<th scope="col" aria-hidden="true" />
								<th scope="col" className="usage-number">
									Hosted time
								</th>
								{price === null ? null : (
									<th scope="col" className="usage-number">
										Est. cost
									</th>
								)}
							</tr>
						</thead>
						<tbody>
							{[...view.days].reverse().map((day) => {
								const today = day.day === view.day;
								const atLimit = allowance !== null && day.seconds >= allowance;
								return (
									<tr key={day.day} className={today ? "usage-day-today" : undefined}>
										<th scope="row">
											{utcDay(day.day)}
											{today ? <span className="usage-day-note">today so far</span> : atLimit ? <span className="usage-day-note">at the limit</span> : null}
										</th>
										<td className="usage-bar-cell" aria-hidden="true">
											{day.seconds > 0 ? <span className="usage-bar" style={{ width: `${Math.max(1, (day.seconds / most) * 100)}%` }} /> : null}
										</td>
										<td className="usage-number">{day.seconds === 0 ? <span className="tone-faint">0:00:00</span> : sandboxClock(day.seconds)}</td>
										{price === null ? null : <td className="usage-number">{day.seconds === 0 ? <span className="tone-faint">–</span> : usd(day.seconds * price.usdPerSecond)}</td>}
									</tr>
								);
							})}
						</tbody>
						<tfoot>
							<tr>
								<th scope="row">{USAGE_HISTORY_DAYS} days</th>
								<td />
								<td className="usage-number">{sandboxClock(historyTotal)}</td>
								{price === null ? null : <td className="usage-number">{historyUsd}</td>}
							</tr>
						</tfoot>
					</table>
					<p className="usage-note">
						UTC days{abroad ? `, ending at ${resets} your time` : ""}.{sizes && price !== null ? " Earlier days are priced at the small size." : ""}
					</p>
				</section>
			) : null}

			{freeing ? <FreeDialog sandbox={freeing} memory={view.memory} onClose={() => setFreeing(null)} onFreed={replace} /> : null}
		</main>
	);
}
