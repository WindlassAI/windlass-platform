/**
 * The session's side panel, after the terminal interface's: the session's facts, where it runs,
 * token counts, one bar per model call showing how much of its input came from the cache, the files
 * the agent changed, for a session on a repository of the user's GitHub connection its pull request
 * and that repository's setup command, and, where the project names MCP servers, those and the user's
 * approvals of them.
 *
 * An agent of another harness (Claude Code) reports no token counts and has no prompt cache to chart:
 * in their place the panel says how full its context is, and what it has cost so far when the harness
 * says. Its saved secrets are not handed to it, so they are not listed as if they were.
 *
 * The session's facts include the mode its next prompt runs in, for every agent, a work item's too,
 * which keeps its profile's. For Claude Code the sandbox's facts say that mode in place of the
 * profile's approval, and that its commands can use the Claude login it runs with.
 */
import type { EgressMode, PendingQuestion, SandboxProfile, SessionSummary, TurnUsage, WorkspaceFile } from "@contract";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { acpHarnessName, contextWords, costWords, sessionModelWords } from "../lib/acp";
import { currentMode } from "../lib/modes";
import { absoluteTime, compact, count, percent, plural, shortId } from "../lib/format";
import { linkProps } from "../lib/router";
import { cachedShare, lastTurn, sessionUsage, turnUsage, type ModelCall, type SessionView } from "../lib/timeline";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { DiffView } from "./DiffView";
import { BranchIcon, ChevronIcon, RefreshIcon, WarnIcon } from "./Icons";
import { Layers, ProfileFacts } from "./Layers";
import { PullRequestSection } from "./PullRequest";
import { ServersSection } from "./Servers";
import { SecretsSection } from "./Secrets";
import { SetupSection } from "./SetupCommand";
import { SandboxState, StatusBadge } from "./Status";
import { AgentGlyph } from "./ui";

function Facts({ summary, profile, view }: { summary: SessionSummary; profile: SandboxProfile; view: SessionView }) {
	const id = view.windlassSessionId;
	const [showOptions, setShowOptions] = useState(false);
	const harness = acpHarnessName(summary);
	const mode = currentMode(summary, profile);
	return (
		<section className="panel-section" aria-labelledby="panel-session">
			<h2 className="panel-title" id="panel-session">
				Session
				<span className="panel-title-aside">{summary.turns === 0 ? "no turns yet" : `turn ${summary.turns}`}</span>
			</h2>
			<dl className="kv">
				<dt>agent</dt>
				<dd>
					<AgentGlyph harness={summary.harness ?? "windlass"} />
					{harness ?? "Windlass"}
				</dd>
				<dt>model</dt>
				<dd>{sessionModelWords(summary)}</dd>
				<dt>mode</dt>
				<dd title={mode.description ?? undefined}>{mode.name}</dd>
				<dt>state</dt>
				<dd>
					<StatusBadge status={summary.status} />
				</dd>
				{summary.repository ? (
					<>
						<dt>repo</dt>
						<dd className="kv-clip" title={`${summary.repository.owner}/${summary.repository.name}, from ${summary.repository.branch}`}>
							<a className="kv-link" {...linkProps({ name: "repository", id: summary.repository.id })} title={`What is saved for ${summary.repository.owner}/${summary.repository.name}, and its other agents`}>
								{summary.repository.owner}/{summary.repository.name}
							</a>
						</dd>
						<dt>branch</dt>
						<dd className="kv-clip kv-mono" title={summary.repository.branch}>
							<BranchIcon size={12} className="tone-faint" />
							{summary.repository.branch}
						</dd>
					</>
				) : summary.repoUrl ? (
					<>
						<dt>repo</dt>
						<dd className="kv-clip" title={summary.repoUrl}>
							{summary.repoUrl.replace(/^https:\/\//, "")}
						</dd>
					</>
				) : null}
				<dt>id</dt>
				<dd className="kv-mono" title={id ?? undefined}>
					{id ? <code className="plain-code">{shortId(id)}</code> : <span className="tone-faint">none until the first turn</span>}
				</dd>
				<dt>created</dt>
				<dd>{absoluteTime(summary.createdAt)}</dd>
			</dl>
			{harness && summary.harnessModels && (
				<details className="panel-more" onToggle={event => setShowOptions(event.currentTarget.open)}>
					<summary><ChevronIcon size={12} className="panel-more-chevron" />Available models and modes</summary>
					{showOptions && <div className="panel-catalog">
						<strong>Models</strong>
						<ul aria-label="Available models">{summary.harnessModels.models.map(model =>
							<li key={model.id}>{model.name || model.id}{model.efforts.length > 0 && <small> · {model.efforts.join(", ")}</small>}</li>)}</ul>
						{summary.availableModes.length > 0 && <><strong>Modes</strong><ul aria-label="Available modes">{summary.availableModes.map(mode =>
							<li key={mode.id} title={mode.description ?? undefined}>{mode.name}</li>)}</ul></>}
					</div>}
				</details>
			)}
		</section>
	);
}

function Sandbox({ summary, profile }: { summary: SessionSummary; profile: SandboxProfile }) {
	return (
		<section className="panel-section" aria-labelledby="panel-sandbox">
			<h2 className="panel-title" id="panel-sandbox">
				Sandbox
				<SandboxState state={summary.sandbox} />
			</h2>
			<p className="panel-lede">{profile.name}</p>
			<ProfileFacts profile={profile} claude={summary.harness && summary.harness !== "windlass" ? { codex: summary.harness === "codex", opencode: summary.harness === "opencode", mode: currentMode(summary, profile) } : null} />
			<details className="panel-more">
				<summary>
					<ChevronIcon size={12} className="panel-more-chevron" />
					How it is held
				</summary>
				<Layers profile={profile} />
			</details>
		</section>
	);
}

/** A figure in a card: its name, the number, an optional meter, a line under it. */
function Stat({ label, value, unit, share, meter, sub }: { label: string; value: string; unit?: string; share?: number | null; meter?: string; sub?: ReactNode }) {
	return (
		<div className="stat">
			<p className="stat-label">{label}</p>
			<p className="stat-value">
				{value}
				{unit ? <span className="stat-unit">{unit}</span> : null}
			</p>
			{share !== undefined && share !== null ? (
				<div className="stat-meter" role="meter" aria-label={meter ?? label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
					<span style={{ width: `${Math.min(100, share * 100)}%` }} />
				</div>
			) : null}
			{sub ? <p className="stat-sub">{sub}</p> : null}
		</div>
	);
}

function Tokens({ view }: { view: SessionView }) {
	const session = sessionUsage(view);
	const last = lastTurn(view);
	const turn: TurnUsage | null = last ? turnUsage(last) : null;
	const calls = view.calls.length;
	const lastCalls = last ? view.calls.filter((call) => call.turn === last.turn).length : 0;
	// A scripted model reports no usage at all: say so rather than show zeros.
	const unreported = view.turns.some((one) => one.end !== null) && calls === 0 && view.turns.every((one) => one.end === null || one.end.usage === null);
	const lastUnreported = last !== null && last.end !== null && last.end.usage === null && lastCalls === 0;
	const cell = (value: number | null) => (value === null ? "–" : count(value));
	const total = (value: number) => (unreported ? "–" : count(value));
	const turnCell = (value: number | null) => (lastUnreported ? "–" : cell(value));
	return (
		<section className="panel-section" aria-labelledby="panel-tokens">
			<h2 className="panel-title" id="panel-tokens">
				Tokens
				<span className="panel-title-aside">{plural(calls, "call")}</span>
			</h2>
			<div className="stats">
				<Stat label="Input" value={unreported ? "–" : compact(session.inputTokens)} share={unreported || session.inputTokens === 0 ? null : cachedShare(session)} meter="Input read from the prompt cache" sub={unreported ? "not reported" : `${percent(cachedShare(session))} cached`} />
				<Stat label="Output" value={unreported ? "–" : compact(session.outputTokens)} sub={unreported ? "not reported" : `${compact(session.reasoningTokens)} reasoning`} />
			</div>
			<details className="panel-more">
				<summary>
					<ChevronIcon size={12} className="panel-more-chevron" />
					Every count, this session and its last turn
				</summary>
			<table className="tokens">
				<thead>
					<tr>
						<td />
						<th scope="col">session</th>
						<th scope="col">last turn</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">input</th>
						<td>{total(session.inputTokens)}</td>
						<td>{turnCell(turn?.inputTokens ?? null)}</td>
					</tr>
					<tr className="tokens-sub">
						<th scope="row">cached</th>
						<td>{total(session.cachedInputTokens)}</td>
						<td>{turnCell(turn?.cachedInputTokens ?? null)}</td>
					</tr>
					<tr className="tokens-sub">
						<th scope="row">cache share</th>
						<td>{unreported ? "–" : percent(cachedShare(session))}</td>
						<td>{turn && !lastUnreported ? percent(cachedShare(turn)) : "–"}</td>
					</tr>
					<tr>
						<th scope="row">output</th>
						<td>{total(session.outputTokens)}</td>
						<td>{turnCell(turn?.outputTokens ?? null)}</td>
					</tr>
					<tr className="tokens-sub">
						<th scope="row">reasoning</th>
						<td>{total(session.reasoningTokens)}</td>
						<td>{turnCell(turn?.reasoningTokens ?? null)}</td>
					</tr>
					<tr>
						<th scope="row">calls</th>
						<td>{calls}</td>
						<td>{last ? lastCalls : "–"}</td>
					</tr>
				</tbody>
			</table>
			</details>
			{unreported ? <p className="panel-empty panel-note">No token counts were reported.</p> : null}
		</section>
	);
}

/** An ACP harness's usage: how full its context is, and its cost so far when it says. */
function Context({ view, harness, turns }: { view: SessionView; harness: string; turns: number }) {
	const context = view.context;
	const share = context ? Math.min(1, context.used / context.size) : 0;
	return (
		<section className="panel-section" aria-labelledby="panel-context">
			<h2 className="panel-title" id="panel-context">
				Usage
			</h2>
			{context ? (
				<div className="stats">
					<div className="stat">
						<p className="stat-label">Context</p>
						<p className="stat-value">
							{contextWords(context).replace(/ used$/, "")}
							<span className="stat-unit"> used</span>
						</p>
						<div className="stat-meter" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={context.size} aria-valuenow={Math.min(context.size, context.used)} aria-valuetext={contextWords(context)}>
							{share > 0 ? <span style={{ width: `${share * 100}%` }} /> : null}
						</div>
						<p className="stat-sub">
							{compact(context.used)} of {compact(context.size)} tokens
						</p>
					</div>
					{context.fiveHourUsedPct != null && <Stat label="5-hour window" value={`${Math.round(context.fiveHourUsedPct)}%`} sub="estimated usage" />}
					<Stat label="Cost so far" value={context.cost ? costWords(context.cost).replace(/ so far$/, "") : "–"} sub={context.cost ? plural(turns, "turn") : "not reported"} />
				</div>
			) : (
				<p className="panel-empty">{harness} says how full its context is once a turn has run. It reports no token counts.</p>
			)}
		</section>
	);
}

/** How many of the latest calls the chart draws. */
const MAX_BARS = 40;

function CacheBars({ calls, anyTurns }: { calls: ModelCall[]; anyTurns: boolean }) {
	const shown = calls.slice(-MAX_BARS);
	const offset = calls.length - shown.length;
	const scale = Math.max(1, ...shown.map((call) => call.inputTokens));
	return (
		<section className="panel-section" aria-labelledby="panel-cache">
			<h2 className="panel-title" id="panel-cache">
				Cache per call
				<span className="legend" aria-hidden="true">
					<span className="legend-key">
						<span className="swatch swatch-cached" /> cached
					</span>
					<span className="legend-key">
						<span className="swatch swatch-new" /> new
					</span>
				</span>
			</h2>
			{shown.length === 0 ? (
				<p className="panel-empty">{anyTurns ? "No model call has reported its token counts." : "One bar per model call will appear here."}</p>
			) : (
				<>
					{offset > 0 ? <p className="panel-empty">Showing the last {MAX_BARS} of {calls.length} calls.</p> : null}
					<ol className="bars" aria-label="Input tokens per model call: the part read from the prompt cache and the new part">
						{shown.map((call, index) => {
							const fresh = Math.max(0, call.inputTokens - call.cachedInputTokens);
							const share = cachedShare(call);
							const label = `Call ${offset + index + 1}: ${count(call.inputTokens)} input tokens, ${count(call.cachedInputTokens)} from the cache (${percent(share)}), ${count(fresh)} new${call.failed ? "; the call did not complete" : ""}`;
							return (
								<li key={`${call.turn}-${call.messageId}-${index}`} className={`bar-row${call.failed ? " bar-row-failed" : ""}`} title={label}>
									<span className="bar-index" aria-hidden="true">
										{offset + index + 1}
									</span>
									<span className="bar-track" aria-hidden="true">
										<span className="bar bar-cached" style={{ width: `${(call.cachedInputTokens / scale) * 100}%` }} />
										<span className="bar bar-new" style={{ width: `${(fresh / scale) * 100}%` }} />
									</span>
									<span className="bar-total" aria-hidden="true">
										{compact(call.inputTokens)}
									</span>
									<span className="bar-share" aria-hidden="true">
										{percent(share)}
									</span>
									<span className="visually-hidden">{label}</span>
								</li>
							);
						})}
					</ol>
				</>
			)}
		</section>
	);
}

const GIT_STATUS: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged", "?": "untracked", "!": "ignored" };

function statusOf(status: string): { letter: string; word: string } {
	const letter = status.trim().charAt(0) || "M";
	return { letter, word: GIT_STATUS[letter] ?? "changed" };
}

function Changes({ sessionId, summary, turnsEnded, reloads, onFiles }: { sessionId: string; summary: SessionSummary; turnsEnded: number; reloads: number; onFiles(count: number | null): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [diff, setDiff] = useState<{ text: string | null; error: string | null } | null>(null);
	const hasSandbox = summary.sandbox !== "none";

	const load = useCallback(() => {
		let current = true;
		setLoading(true);
		client
			.session(auth, sessionId)
			.changes()
			.then(
				(list) => {
					if (!current) return;
					setFiles(list);
					onFiles(list.length);
					setError(null);
					setLoading(false);
				},
				(failure: unknown) => {
					if (!current) return;
					setError(explain(failure));
					setLoading(false);
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, sessionId, explain, onFiles]);

	// On open, when the sandbox first exists, whenever a turn ends, and after the platform committed the work.
	useEffect(() => {
		if (!hasSandbox) return;
		return load();
	}, [load, hasSandbox, turnsEnded, reloads]);

	const openDiff = () => {
		setDiff({ text: null, error: null });
		client
			.session(auth, sessionId)
			.diff()
			.then(
				(text) => setDiff((current) => (current ? { text, error: null } : null)),
				(failure: unknown) => setDiff((current) => (current ? { text: null, error: explain(failure) } : null)),
			);
	};

	return (
		<section className="panel-section" aria-labelledby="panel-changes">
			<h2 className="panel-title" id="panel-changes">
				Files changed
				{files && files.length > 0 ? <span className="panel-title-aside">{files.length}</span> : null}
				{hasSandbox ? (
					<button type="button" className="icon-button icon-button-small" onClick={load} disabled={loading} aria-label="Reload the changed files" title="Reload">
						<RefreshIcon size={13} className={loading ? "spin" : undefined} />
					</button>
				) : null}
			</h2>
			{!hasSandbox ? (
				<p className="panel-empty">The sandbox is created on {summary.item ? "the work item's first prompt" : "the first prompt"}. Files the agent changes will be listed here.</p>
			) : error ? (
				<p className="panel-empty tone-bad" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : files === null ? (
				<p className="panel-empty" aria-busy="true">
					Reading the workspace…
				</p>
			) : files.length === 0 ? (
				<p className="panel-empty">No file differs from the last commit.</p>
			) : (
				<>
					<ul className="changes" aria-label="Files that differ from the last commit">
						{files.map((file) => {
							const { letter, word } = statusOf(file.status);
							return (
								<li key={file.path}>
									<span className={`change-status change-status-${letter === "?" ? "new" : letter}`} title={word}>
										{letter}
										<span className="visually-hidden"> {word}</span>
									</span>
									<span className="change-path" title={file.path}>
										<span className="change-dir">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : ""}</span>
										<span className="change-name">{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
									</span>
								</li>
							);
						})}
					</ul>
					<button type="button" className="button button-outline button-small" onClick={openDiff}>
						View the diff
					</button>
				</>
			)}
			{diff ? (
				<Dialog title="Changes" lede={`${summary.title} · the workspace against its last commit${files ? ` · ${plural(files.length, "file")}` : ""}`} size="full" onClose={() => setDiff(null)}>
					{diff.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h3>The diff could not be loaded</h3>
							<p>{diff.error}</p>
							<button type="button" className="button button-outline" onClick={openDiff}>
								Try again
							</button>
						</div>
					) : diff.text === null ? (
						<div className="state state-loading" aria-busy="true">
							<span className="spinner" aria-hidden="true" />
							<p>Reading the diff from the sandbox…</p>
						</div>
					) : (
						<DiffView diff={diff.text} />
					)}
				</Dialog>
			) : null}
		</section>
	);
}

export function SidePanel({ sessionId, summary, profile, view, turnsEnded, question = null, egress, hosted }: { egress?: EgressMode; hosted?: boolean; sessionId: string; summary: SessionSummary; profile: SandboxProfile; view: SessionView; turnsEnded: number; question?: PendingQuestion | null }) {
	// How many files differ from the last commit, once the list was read; and a count that asks for it again.
	const [files, setFiles] = useState<number | null>(null);
	const [reloads, setReloads] = useState(0);
	const published = useCallback(() => setReloads((value) => value + 1), []);
	const harness = acpHarnessName(summary);
	return (
		<aside className="panel" id="details" aria-label="Session details">
			<Facts summary={summary} profile={profile} view={view} />
			<Sandbox summary={summary} profile={profile} />
			{harness ? (
				<Context view={view} harness={harness} turns={summary.turns} />
			) : (
				<>
					<Tokens view={view} />
					<CacheBars calls={view.calls} anyTurns={view.turns.length > 0} />
				</>
			)}
			<Changes sessionId={sessionId} summary={summary} turnsEnded={turnsEnded} reloads={reloads} onFiles={setFiles} />
			<PullRequestSection sessionId={sessionId} summary={summary} profile={profile} turnsEnded={turnsEnded} files={files} onPublished={published} />
			<SetupSection egress={egress} hosted={hosted} summary={summary} />
			{harness ? null : <SecretsSection summary={summary} />}
			{/* Last: it is there only where the project names a server, and so its arrival moves no other section. */}
			<ServersSection sessionId={sessionId} summary={summary} question={question} />
		</aside>
	);
}
