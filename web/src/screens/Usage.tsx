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
import { USAGE_HISTORY_DAYS, type KeptSandbox, type SessionSummary, type UsageView } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { FactoryUsage } from "../components/FactoryUsage";
import { MachineUsage } from "../components/MachineUsage";
import { ArrowLeftIcon, WarnIcon } from "../components/Icons";
import { SandboxState } from "../components/Status";
import { absoluteTime, count, localTime, plural, relativeTime, sandboxClock, sandboxTime as spelledTime, usd, utcDay } from "../lib/format";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";

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
		client
			.user(auth)
			.usage()
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
		<div className="usage-meter" role="meter" aria-label="Sandbox time used today" aria-valuemin={0} aria-valuemax={allowance} aria-valuenow={Math.min(allowance, spent)} aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowance)}`}>
			{view.usedSeconds > 0 ? <span className="usage-meter-used" style={{ width: share(view.usedSeconds) }} /> : null}
			{view.heldSeconds > 0 ? <span className="usage-meter-held" style={{ width: share(view.heldSeconds) }} /> : null}
		</div>
	);
}

export function Usage() {
	const { view, error, items, reload, replace } = useUsage();
	const now = useNow(15_000);
	const [freeing, setFreeing] = useState<KeptSandbox | null>(null);

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
	const spent = view.usedSeconds + view.heldSeconds;
	const left = view.leftSeconds;
	const price = view.price;
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

	return (
		<main className="home usage">
			<header className="home-head">
				<div>
					<p className="eyebrow">usage · the day ends {resets}</p>
					<h1 className="display">Usage</h1>
					<p className="home-account">Sandbox time is the time your agents' sandboxes run: while an agent works, and for a short while after. A paused sandbox uses none.</p>
				</div>
			</header>

			{error ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{error} What is shown may be behind.</span>
				</p>
			) : null}

			<section className="usage-section" aria-labelledby="usage-tokens">
				<h2 className="usage-title" id="usage-tokens">Model tokens today</h2>
				<p className="usage-figure"><strong>{count(view.usedModelTokens)}</strong> {view.factoryLimits.dailyTokens === null ? "used · no daily cap" : `of ${count(view.factoryLimits.dailyTokens)} used`}</p>
				<p>Counts input and output reported by model requests using the platform’s model sign-in. The day resets at 00:00 UTC.</p>
			</section>
			<section className="usage-section" aria-labelledby="usage-today">
				<h2 className="usage-title" id="usage-today">
					Sandbox time today
				</h2>
				<div className="usage-card usage-today">
				<p className="usage-figure">
					<strong>{sandboxTime(spent)}</strong>
					{allowance === null ? <span> used. This deployment sets no daily limit.</span> : <span> of {sandboxTime(allowance)} used</span>}
					{left !== null ? <span className={`usage-figure-left${left < view.startSeconds ? " tone-warn" : ""}`}>{left < view.startSeconds ? (left === 0 ? "none left" : `${sandboxTime(left)} left, too little for a turn`) : `${sandboxTime(left)} left`}</span> : null}
				</p>
				<Meter view={view} />
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
						<dd className="usage-gloss">
							{running === 0 ? "no sandbox is running now" : `for ${plural(running, "sandbox", "sandboxes")} running now, a few minutes at a time; what one does not use is free again when it stops`}
						</dd>
					</div>
					{left !== null ? (
						<div>
							<dt>
								<span className="usage-swatch usage-swatch-left" aria-hidden="true" />
								Left
							</dt>
							<dd className="usage-number">{sandboxClock(left)}</dd>
							<dd className="usage-gloss">{left < view.startSeconds ? "a turn needs more than this to start, and one that is running is stopped when the time it holds is over" : "for turns that start now"}</dd>
						</div>
					) : null}
					{allowance !== null ? (
						<div>
							<dt>Resets</dt>
							<dd className="usage-number">{resets}</dd>
							<dd className="usage-gloss">
								in {untilReset}
								{abroad ? ", at 00:00 UTC" : ""}, when the allowance is whole again
							</dd>
						</div>
					) : null}
					<div>
						<dt>Cost</dt>
						<dd className="usage-number">{cost(view.usedSeconds) ?? "–"}</dd>
						<dd className="usage-gloss">
							{price === null
								? "nothing is estimated: this deployment's sandboxes run on its own machine and are not billed by the second"
								: `an estimate: ${count(view.usedSeconds)} s counted, at $${price.usdPerSecond.toFixed(7)} a second for ${price.basis}. The provider's bill is what counts`}
						</dd>
					</div>
				</dl>
				</div>
			</section>

			<section className="usage-section" aria-labelledby="usage-agents">
				<h2 className="usage-title" id="usage-agents">
					Today by agent
				</h2>
				{view.today.length === 0 ? (
					<p className="usage-empty">No sandbox has run today.</p>
				) : (
					<table className="usage-table">
						<thead>
							<tr>
								<th scope="col">Agent</th>
								<th scope="col" className="usage-number">
									Counted
								</th>
								<th scope="col" className="usage-number usage-wide">
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
										{row.unreportedSeconds > 0 ? (
											<span className="usage-mark" title="Counted in full: see the note below">
												{" "}
												*
											</span>
										) : null}
									</th>
									<td className="usage-number">{sandboxClock(row.seconds)}</td>
									<td className="usage-number usage-wide">{row.heldSeconds > 0 ? sandboxClock(row.heldSeconds) : <span className="tone-faint">–</span>}</td>
									{price === null ? null : <td className="usage-number">{cost(row.seconds)}</td>}
								</tr>
							))}
							{itemRows.length > 0 ? (
								<tr>
									<th scope="row">
										<a className="usage-agent" href="#usage-items">
											{plural(new Set(itemRows.map(row => items?.get(row.sessionId))).size, "work item")}
										</a>
										{itemTotal.unreported > 0 ? (
											<span className="usage-mark" title="Counted in full: see the note below">
												{" "}
												*
											</span>
										) : null}
									</th>
									<td className="usage-number">{sandboxClock(itemTotal.seconds)}</td>
									<td className="usage-number usage-wide">{itemTotal.held > 0 ? sandboxClock(itemTotal.held) : <span className="tone-faint">–</span>}</td>
									{price === null ? null : <td className="usage-number">{cost(itemTotal.seconds)}</td>}
								</tr>
							) : null}
						</tbody>
						<tfoot>
							<tr>
								<th scope="row">Today</th>
								<td className="usage-number">{sandboxClock(view.usedSeconds)}</td>
								<td className="usage-number usage-wide">{view.heldSeconds > 0 ? sandboxClock(view.heldSeconds) : <span className="tone-faint">–</span>}</td>
								{price === null ? null : <td className="usage-number">{cost(view.usedSeconds)}</td>}
							</tr>
						</tfoot>
					</table>
				)}
				{itemRows.length > 0 ? <p className="usage-note">The work items' row is their agents' sandboxes together, today. What each item has spent in all, against its budget, is under Work items below.</p> : null}
				{unreported > 0 ? (
					<p className="usage-note">
						* {sandboxTime(unreported)} of this were counted in full without a measurement: the server an agent was on stopped while its sandbox ran, so nobody saw when the sandbox stopped. It ran that long at most.
					</p>
				) : null}
			</section>

			<section className="usage-section" aria-labelledby="usage-kept">
				<h2 className="usage-title" id="usage-kept">
					Hosted sandboxes you keep
					<span className="usage-count">{limit === null ? count(kept) : `${count(kept)} of ${count(limit)}`}</span>
				</h2>
				<p className="usage-lede">
					Each agent that has worked on the platform's own sandboxes has one with its files, running or paused. Those on your own machines are not counted here.{" "}
					{limit === null
						? "This deployment sets no limit on how many you keep."
						: kept >= limit
							? `You keep as many as an account may have, so an agent that has none cannot start until you free one here or delete an agent.`
							: `An account may keep ${count(limit)}; an agent that needs one beyond that cannot start until you free one here or delete an agent.`}{" "}
					Nothing is removed to make room by itself.
				</p>
				{view.kept.length === 0 ? (
					<p className="usage-empty">You keep no sandbox.</p>
				) : (
					<ul className="usage-kept">
						{view.kept.map((sandbox) => (
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
			</section>

			<MachineUsage />

			<FactoryUsage value={view.factoryLimits} />

			<section className="usage-section" aria-labelledby="usage-history">
				<h2 className="usage-title" id="usage-history">
					The last {USAGE_HISTORY_DAYS} days
				</h2>
				<p className="usage-lede">A day here is a UTC day{abroad ? `: it ends at ${resets} your time` : ""}.{allowance === null ? "" : ` Each bar is drawn against the daily allowance of ${sandboxTime(allowance)}.`}</p>
				<table className="usage-table usage-history">
					<thead>
						<tr>
							<th scope="col">Day</th>
							<th scope="col" aria-hidden="true" />
							<th scope="col" className="usage-number">
								Sandbox time
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
							{price === null ? null : <td className="usage-number">{cost(historyTotal)}</td>}
						</tr>
					</tfoot>
				</table>
			</section>

			{freeing ? <FreeDialog sandbox={freeing} memory={view.memory} onClose={() => setFreeing(null)} onFreed={replace} /> : null}
		</main>
	);
}
