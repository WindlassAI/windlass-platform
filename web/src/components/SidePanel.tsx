/**
 * The session's side panel, after the terminal interface's: the session's facts, where it runs,
 * token counts, one bar per model call showing how much of its input came from the cache, the files
 * the agent changed, for a session on a repository of the user's GitHub connection its pull request,
 * and, where the project names MCP servers, those and the user's approvals of them.
 */
import type { PendingQuestion, SandboxProfile, SessionSummary, TurnUsage, WorkspaceFile } from "@contract";
import { useCallback, useEffect, useState } from "react";
import { absoluteTime, compact, count, percent, plural, shortId } from "../lib/format";
import { cachedShare, lastTurn, sessionUsage, turnUsage, type ModelCall, type SessionView } from "../lib/timeline";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { DiffView } from "./DiffView";
import { RefreshIcon, WarnIcon } from "./Icons";
import { Layers, ProfileFacts } from "./Layers";
import { PullRequestSection } from "./PullRequest";
import { ServersSection } from "./Servers";
import { SandboxState, StatusBadge } from "./Status";

function Facts({ summary, view }: { summary: SessionSummary; view: SessionView }) {
	const id = view.windlassSessionId;
	return (
		<section className="panel-section" aria-labelledby="panel-session">
			<h2 className="panel-title" id="panel-session">
				Session
			</h2>
			<dl className="kv">
				<dt>title</dt>
				<dd className="kv-clip" title={summary.title}>
					{summary.title}
				</dd>
				<dt>id</dt>
				<dd title={id ?? undefined}>{id ? <code className="plain-code">{shortId(id)}</code> : <span className="tone-faint">none until the first turn</span>}</dd>
				<dt>state</dt>
				<dd>
					<StatusBadge status={summary.status} />
				</dd>
				<dt>model</dt>
				<dd>{summary.model}</dd>
				<dt>turns</dt>
				<dd>{summary.turns}</dd>
				{summary.repository ? (
					<>
						<dt>repo</dt>
						<dd className="kv-clip" title={`${summary.repository.owner}/${summary.repository.name}, from ${summary.repository.branch}`}>
							{summary.repository.owner}/{summary.repository.name}
							<span className="tone-faint"> at </span>
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
				<dt>created</dt>
				<dd>{absoluteTime(summary.createdAt)}</dd>
			</dl>
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
			<Layers profile={profile} />
			<ProfileFacts profile={profile} />
		</section>
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
			</h2>
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
			{unreported ? <p className="panel-empty panel-note">No token counts were reported.</p> : null}
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
				Changes
				{hasSandbox ? (
					<button type="button" className="icon-button icon-button-small" onClick={load} disabled={loading} aria-label="Reload the changed files" title="Reload">
						<RefreshIcon size={13} className={loading ? "spin" : undefined} />
					</button>
				) : null}
			</h2>
			{!hasSandbox ? (
				<p className="panel-empty">The sandbox is created on the first prompt. Files the agent changes will be listed here.</p>
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
										{file.path}
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

export function SidePanel({ sessionId, summary, profile, view, turnsEnded, question = null }: { sessionId: string; summary: SessionSummary; profile: SandboxProfile; view: SessionView; turnsEnded: number; question?: PendingQuestion | null }) {
	// How many files differ from the last commit, once the list was read; and a count that asks for it again.
	const [files, setFiles] = useState<number | null>(null);
	const [reloads, setReloads] = useState(0);
	const published = useCallback(() => setReloads((value) => value + 1), []);
	return (
		<aside className="panel" id="details" aria-label="Session details">
			<Facts summary={summary} view={view} />
			<Sandbox summary={summary} profile={profile} />
			<Tokens view={view} />
			<CacheBars calls={view.calls} anyTurns={view.turns.length > 0} />
			<Changes sessionId={sessionId} summary={summary} turnsEnded={turnsEnded} reloads={reloads} onFiles={setFiles} />
			<PullRequestSection sessionId={sessionId} summary={summary} turnsEnded={turnsEnded} files={files} onPublished={published} />
			{/* Last: it is there only where the project names a server, and so its arrival moves no other section. */}
			<ServersSection sessionId={sessionId} summary={summary} question={question} />
		</aside>
	);
}
