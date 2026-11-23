/**
 * The way out for a session's work, in its side panel: for a session launched on a repository of the
 * user's GitHub connection, "Open pull request", and once there is one, the pull request with its
 * number and state, and "Push changes". The platform commits, pushes and opens it; the dialog is where
 * the user reads and edits the message first.
 *
 * The agent pushes the session's own branch by itself whenever it wants (its `push`, which the
 * platform performs and nobody is asked about); the panel then says the branch is pushed, and opens a
 * pull request from it. The agent can also ask the platform to open or update the pull request (the
 * question about that is Question.tsx's). Whether that is asked about each time is the session's own
 * setting, which stands here under the button: one check box and one sentence, with one more that says what the agent's own push does
 * on GitHub (`AGENT_PUSH_MEANS`): it runs the repository's CI, with its secrets.
 *
 * A work item's agent files a `report` and never asks to publish: the item's own step pushes and
 * opens or updates the pull request. The setting means nothing there, so its place has one line that
 * says whose the pull request is. "Open pull request" stays, as the server takes it for any session
 * but an item's second reviewer, which only reads: on it the panel shows the pull request it reviews,
 * with no action and no setting.
 */
import { MAX_PUBLISH_BODY_CHARS, MAX_PUBLISH_TITLE_CHARS, type PublishState, type PullRequestInfo, type SandboxProfile, type SessionSummary } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { acpHarnessName } from "../lib/acp";
import { relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { usePublishRequests } from "../state/sessionChrome";
import { Dialog } from "./Dialog";
import { BranchIcon, CrossIcon, ExternalIcon, LockIcon, MergedIcon, PullRequestIcon, RefreshIcon, WarnIcon } from "./Icons";

/** What letting the agent publish without asking means, in one sentence, as the panel says it. */
export const PUBLISH_UNASKED_MEANS = "The agent may have the platform open or update this session's pull request, with the agent's title and description, without you being asked each time.";

/** In the place of the way out, on an item's second reviewer: the server takes no push or pull request from it. */
export const REVIEWER_PUBLISHES_NOTHING = "The second reviewer reads the commit the item pushed. It pushes nothing and opens no pull request.";

/**
 * What the agent's own push does on GitHub, which no setting holds back: said under the setting in
 * the panel, whichever way it is, and where the setting cannot be on.
 */
export const AGENT_PUSH_MEANS = "The agent pushes this session's own branch whenever it wants, and a push runs the repository's CI workflows on the agent's changes, with the CI's secrets, without you being asked.";

/**
 * Why the setting cannot be on in a sandbox of `profile`, or null where it can: only where Windlass
 * sandboxes every command the agent runs. Elsewhere a command could ask in the agent's name, so the
 * server asks about every request and refuses the setting (`publishUnaskedProblem` there).
 */
export function publishAlwaysAsked(profile: Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">): string | null {
	if (profile.approval === "full") return "In this sandbox the agent's commands run outside Windlass's sandbox, and one of them could ask in the agent's name.";
	if (profile.commandNetwork || profile.commandsCanReadAccessToken) return "In this sandbox it is not established that Windlass's sandbox holds the agent's commands, and one of them could then ask in the agent's name.";
	return null;
}

/**
 * Why an agent that reaches the platform's tools over MCP (Claude Code, OpenCode, Codex) is asked about
 * every publish, whatever the profile: the server refuses the setting for it (`publishAsksEveryTime` there).
 */
export const publishAskedOverMcp = (agent: string) => `${agent} reaches its publish tool from inside the sandbox, where any process could call it in the agent's name.`;

/** The setting itself: on or off, with its sentence. Where it cannot be on, what holds instead stands in its place, with why. */
export function PublishUnaskedCheck({ checked, disabled, onChange, profile, agent = null }: { checked: boolean; disabled: boolean; onChange(checked: boolean): void; profile: SandboxProfile | null; agent?: string | null }) {
	const asked = agent !== null ? publishAskedOverMcp(agent) : profile === null ? null : publishAlwaysAsked(profile);
	if (asked !== null) {
		return (
			<p className="check-text">
				<span className="check-name">You are asked each time the agent wants to publish</span>
				<span className="check-means">{asked}</span>
				<span className="check-means">{AGENT_PUSH_MEANS}</span>
			</p>
		);
	}
	return (
		<label className={`check${checked ? " check-on" : ""}`}>
			<input className="check-input" type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
			<span className="check-box" aria-hidden="true" />
			<span className="check-text">
				<span className="check-name">Let the agent publish without asking</span>
				<span className="check-means">{PUBLISH_UNASKED_MEANS}</span>
				<span className="check-means">{AGENT_PUSH_MEANS}</span>
			</span>
		</label>
	);
}

/** The setting of a session that exists: changed at once, and the session's summary says what it is. */
function AgentPublishing({ sessionId, summary, profile }: { sessionId: string; summary: SessionSummary; profile: SandboxProfile }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (unasked: boolean) => {
		setBusy(true);
		setError(null);
		client
			.session(auth, sessionId)
			.setPublishUnasked(unasked)
			.then(
				() => setBusy(false),
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(false);
				},
			);
	};
	return (
		<div className="gh-agent">
			<PublishUnaskedCheck checked={summary.publishUnasked === true} disabled={busy} onChange={set} profile={profile} agent={acpHarnessName(summary)} />
			{error ? (
				<p className="panel-empty tone-bad" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : null}
		</div>
	);
}

const STATE_WORD: Record<PullRequestInfo["state"], string> = { open: "open", draft: "draft", merged: "merged", closed: "closed" };

export function PullState({ state }: { state: PullRequestInfo["state"] }) {
	return (
		<span className={`gh-pull-state gh-pull-state-${state}`}>
			{state === "merged" ? <MergedIcon size={13} /> : state === "closed" ? <CrossIcon size={13} /> : <PullRequestIcon size={13} />}
			{STATE_WORD[state]}
		</span>
	);
}

/** Whether a pull request still takes pushes: one that was merged or closed is done with. */
const isOpen = (pull: PullRequestInfo | null): boolean => pull !== null && (pull.state === "open" || pull.state === "draft");

/**
 * Whether "Open pull request" opens one from what is pushed: the branch is at GitHub, no pull request
 * was opened from it, and there is nothing to commit or push first. The server opens it then
 * (github/publish.ts `publishWork`), so the button is not held back for having nothing new.
 */
export const opensFromPushed = (pull: PullRequestInfo | null, pushed: string | null, nothing: boolean): boolean => pull === null && pushed !== null && nothing;

/**
 * The line above the action: what pushing would do now, or why there is nothing to push. `pushed`
 * is the commit the branch is at on GitHub; the panel does not know whether the agent or the panel
 * pushed it, so the line names neither (the timeline says who).
 */
export function situation({ pull, branch, pushed, nothing, unknown }: { pull: PullRequestInfo | null; branch: string; pushed: string | null; nothing: boolean; unknown: boolean }): string {
	// A paused sandbox is not started to be asked: saying that it has changes would be a guess.
	if (pull && isOpen(pull) && unknown) return "Whether the workspace has more than the branch is not known while its sandbox is paused.";
	if (pull && isOpen(pull)) return nothing ? "Everything in the workspace is on the branch." : "The workspace has changes that are not on the branch.";
	if (pull) return nothing ? `#${pull.number} is ${STATE_WORD[pull.state]}, and nothing has changed since.` : `#${pull.number} is ${STATE_WORD[pull.state]}. New work goes into a new pull request.`;
	if (pushed !== null) {
		const at = `${branch} is pushed at ${pushed.slice(0, 7)}; no pull request is open.`;
		return nothing || unknown ? at : `${at} The workspace has changes that are not on the branch.`;
	}
	return nothing ? "Nothing to push yet: no file differs from the last commit." : `The work goes to ${branch}.`;
}

function PublishDialog({ sessionId, state, files, fromPushed, onClose, onDone }: { sessionId: string; state: PublishState; files: number | null; fromPushed: boolean; onClose(): void; onDone(state: PublishState): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const ids = { form: useId(), title: useId(), body: useId(), note: useId() };
	const [title, setTitle] = useState(state.draft.title);
	const [body, setBody] = useState(state.draft.body);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const repository = state.repository;
	const opening = !isOpen(state.pullRequest);
	if (!repository) return null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy || title.trim() === "") return;
		setBusy(true);
		setError(null);
		try {
			const result = await client.session(auth, sessionId).publish({ title: title.trim(), body: body.trim() });
			onDone(result.state);
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	const what = files === null || files === 0 ? "what is uncommitted" : files === 1 ? "the 1 changed file" : `the ${files} changed files`;
	return (
		<Dialog
			title={opening ? "Open pull request" : "Push changes"}
			lede={
				<span className="gh-route">
					<span>
						{repository.owner}/{repository.name}
					</span>
					<span className="gh-route-branches">
						<code className="plain-code">{state.branch}</code>
						<span aria-hidden="true"> → </span>
						<span className="visually-hidden"> into </span>
						<code className="plain-code">{repository.branch}</code>
					</span>
				</span>
			}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={busy || title.trim() === ""}>
						{busy ? (opening ? "Opening the pull request…" : "Pushing…") : fromPushed ? "Open pull request" : opening ? "Commit, push and open" : "Commit and push"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="gh-publish" onSubmit={submit} noValidate>
				<div className="field">
					<label className="label" htmlFor={ids.title}>
						{opening ? "Title" : "Commit message"}
					</label>
					<input id={ids.title} className="input" value={title} maxLength={MAX_PUBLISH_TITLE_CHARS} disabled={busy} onChange={(event) => setTitle(event.target.value)} aria-describedby={ids.note} />
				</div>
				<div className="field">
					<label className="label" htmlFor={ids.body}>
						Description <span className="label-optional">optional</span>
					</label>
					<textarea id={ids.body} className="input textarea gh-publish-body" rows={6} value={body} maxLength={MAX_PUBLISH_BODY_CHARS} disabled={busy} onChange={(event) => setBody(event.target.value)} />
				</div>
				<p className="field-note" id={ids.note}>
					{fromPushed
						? `The platform opens the pull request from what is pushed to ${state.branch}, under this title and description. Nothing is committed.`
						: opening
							? `The platform commits ${what} with this message, pushes the branch, and opens the pull request under the same title and description.`
							: `The platform commits ${what} with this message and pushes it to pull request #${state.pullRequest?.number}.`}{" "}
					The agent's sandbox is never given your GitHub access.
				</p>
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span className="callout-text">{error}</span>
					</p>
				) : null}
			</form>
		</Dialog>
	);
}

export function PullRequestSection({ sessionId, summary, profile, turnsEnded, files, onPublished }: { sessionId: string; summary: SessionSummary; profile: SandboxProfile; turnsEnded: number; files: number | null; onPublished(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(60_000);
	const [state, setState] = useState<PublishState | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState(false);
	const [flash, setFlash] = useState(false);
	const section = useRef<HTMLElement>(null);
	const repository = summary.repository ?? null;
	const idle = summary.status === "idle";
	// The second reviewer of an item only reads: the server refuses it a push and a pull request.
	const reviewer = summary.item?.role === "reviewer";

	const load = useCallback(() => {
		let current = true;
		setLoading(true);
		client
			.session(auth, sessionId)
			.publishState()
			.then(
				(next) => {
					if (!current) return;
					setState(next);
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
	}, [client, auth, sessionId, explain]);

	// On open, when a turn ends or starts, when the sandbox comes or goes, and when the changed files were read again.
	useEffect(() => {
		if (!repository) return;
		return load();
	}, [load, repository?.id, turnsEnded, idle, summary.sandbox, files]);

	// "Publish pull request" in the bar: the dialog when it can open, otherwise this section, which says why not.
	usePublishRequests(sessionId, () => {
		const can = repository !== null && !reviewer && state !== null && error === null && (state.blocked ?? null) === null && idle;
		const pending = files !== null && files > 0 ? true : state?.changes;
		if (can && state && (pending !== false || opensFromPushed(summary.pullRequest ?? state.pullRequest ?? null, state.pushed, pending === false))) {
			setDialog(true);
			return;
		}
		const element = section.current;
		if (!element) return;
		element.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
		element.querySelector<HTMLElement>(".panel-title")?.focus({ preventScroll: true });
		setFlash(true);
	});
	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(false), 1400);
		return () => clearTimeout(timer);
	}, [flash]);

	if (!repository) return null;
	// The summary is told of a new pull request and of a change of its state; the panel's own read has the rest.
	const pull = summary.pullRequest ?? state?.pullRequest ?? null;
	const open = isOpen(pull);
	const action = open ? "Push changes" : "Open pull request";
	const blocked = state?.blocked ?? null;
	// With files that differ there is something to push, whatever git has yet to be asked.
	const changes = files !== null && files > 0 && idle ? true : (state?.changes ?? null);
	const nothing = blocked === null && changes === false;
	const unknown = blocked === null && changes === null;
	// Pushed with no pull request: "Open pull request" opens one from the branch, though nothing is new.
	const fromPushed = blocked === null && state !== null && opensFromPushed(pull, state.pushed, nothing);

	return (
		<section className={`panel-section${flash ? " panel-section-flash" : ""}`} aria-labelledby="panel-pull" ref={section}>
			<h2 className="panel-title" id="panel-pull" tabIndex={-1}>
				Pull request
				<button type="button" className="icon-button icon-button-small" onClick={load} disabled={loading} aria-label="Read the pull request's state again" title="Reload">
					<RefreshIcon size={13} className={loading ? "spin" : undefined} />
				</button>
			</h2>
			<p className="gh-target">
				<span className="gh-target-repo" title={`${repository.owner}/${repository.name}${repository.private ? " (private)" : ""}`}>
					{repository.private ? <LockIcon size={12} /> : null}
					<a href={repository.url} target="_blank" rel="noreferrer">
						{repository.owner}/{repository.name}
					</a>
				</span>
				<span className="gh-target-branch" title={`The branch the agent started from: ${repository.branch}`}>
					<BranchIcon size={12} />
					{repository.branch}
				</span>
			</p>
			{pull ? (
				<div className="gh-pull">
					<a className="gh-pull-link" href={pull.url} target="_blank" rel="noreferrer" title={pull.title}>
						<span className="gh-pull-number">#{pull.number}</span>
						<span className="gh-pull-title">{pull.title}</span>
						<ExternalIcon size={12} />
					</a>
					<p className="gh-pull-meta">
						<PullState state={pull.state} />
						<time dateTime={new Date(pull.pushedAt).toISOString()}>pushed {relativeTime(pull.pushedAt, now)}</time>
					</p>
					<p className="gh-pull-branch" title={`The branch the work is on: ${pull.branch}`}>
						<BranchIcon size={12} />
						<span>{pull.branch}</span>
					</p>
				</div>
			) : null}
			{error ? (
				<p className="panel-empty tone-bad" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : state === null ? (
				<p className="panel-empty" aria-busy="true">
					Reading the pull request…
				</p>
			) : reviewer ? null : (
				<>
					<p className="panel-empty gh-pull-note">{blocked ?? situation({ pull, branch: state.branch, pushed: state.pushed, nothing, unknown })}</p>
					<button type="button" className="button button-outline button-small" onClick={() => setDialog(true)} disabled={blocked !== null || (nothing && !fromPushed)}>
						{action}
					</button>
				</>
			)}
			{reviewer ? (
				<p className="panel-empty gh-item-note">{REVIEWER_PUBLISHES_NOTHING}</p>
			) : summary.item ? (
				<p className="panel-empty gh-item-note">The work item's steps push the work and open or update the pull request.</p>
			) : (
				<AgentPublishing sessionId={sessionId} summary={summary} profile={profile} />
			)}
			{dialog && state && !reviewer ? (
				<PublishDialog
					sessionId={sessionId}
					state={state}
					files={files}
					fromPushed={fromPushed}
					onClose={() => setDialog(false)}
					onDone={(next) => {
						setState(next);
						setDialog(false);
						onPublished();
					}}
				/>
			) : null}
		</section>
	);
}
