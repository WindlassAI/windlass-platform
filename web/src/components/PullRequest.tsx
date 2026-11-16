/**
 * The way out for a session's work, in its side panel: for a session launched on a repository of the
 * user's GitHub connection, "Open pull request", and once there is one, the pull request with its
 * number and state, and "Push changes". The platform commits, pushes and opens it; the dialog is where
 * the user reads and edits the message first.
 */
import { MAX_PUBLISH_BODY_CHARS, MAX_PUBLISH_TITLE_CHARS, type PublishState, type PullRequestInfo, type SessionSummary } from "@contract";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { Dialog } from "./Dialog";
import { BranchIcon, CrossIcon, ExternalIcon, LockIcon, MergedIcon, PullRequestIcon, RefreshIcon, WarnIcon } from "./Icons";

const STATE_WORD: Record<PullRequestInfo["state"], string> = { open: "open", draft: "draft", merged: "merged", closed: "closed" };

function PullState({ state }: { state: PullRequestInfo["state"] }) {
	return (
		<span className={`gh-pull-state gh-pull-state-${state}`}>
			{state === "merged" ? <MergedIcon size={13} /> : state === "closed" ? <CrossIcon size={13} /> : <PullRequestIcon size={13} />}
			{STATE_WORD[state]}
		</span>
	);
}

/** Whether a pull request still takes pushes: one that was merged or closed is done with. */
const isOpen = (pull: PullRequestInfo | null): boolean => pull !== null && (pull.state === "open" || pull.state === "draft");

/** The line above the action: what pushing would do now, or why there is nothing to push. */
function situation(pull: PullRequestInfo | null, branch: string, nothing: boolean, unknown: boolean): string {
	// A paused sandbox is not started to be asked: saying that it has changes would be a guess.
	if (pull && isOpen(pull) && unknown) return "Whether the workspace has more than the branch is not known while its sandbox is paused.";
	if (pull && isOpen(pull)) return nothing ? "Everything in the workspace is on the branch." : "The workspace has changes that are not on the branch.";
	if (pull) return nothing ? `#${pull.number} is ${STATE_WORD[pull.state]}, and nothing has changed since.` : `#${pull.number} is ${STATE_WORD[pull.state]}. New work goes into a new pull request.`;
	return nothing ? "Nothing to push yet: no file differs from the last commit." : `The work goes to ${branch}.`;
}

function PublishDialog({ sessionId, state, files, onClose, onDone }: { sessionId: string; state: PublishState; files: number | null; onClose(): void; onDone(state: PublishState): void }) {
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
						{busy ? (opening ? "Opening the pull request…" : "Pushing…") : opening ? "Commit, push and open" : "Commit and push"}
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
					{opening
						? `The platform commits ${what} with this message, pushes the branch, and opens the pull request under the same title and description.`
						: `The platform commits ${what} with this message and pushes it to pull request #${state.pullRequest?.number}.`}{" "}
					The agent takes no part: its sandbox is never given your GitHub access.
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

export function PullRequestSection({ sessionId, summary, turnsEnded, files, onPublished }: { sessionId: string; summary: SessionSummary; turnsEnded: number; files: number | null; onPublished(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(60_000);
	const [state, setState] = useState<PublishState | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState(false);
	const repository = summary.repository ?? null;
	const idle = summary.status === "idle";

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

	return (
		<section className="panel-section" aria-labelledby="panel-pull">
			<h2 className="panel-title" id="panel-pull">
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
			) : (
				<>
					<p className="panel-empty gh-pull-note">{blocked ?? situation(pull, state.branch, nothing, unknown)}</p>
					<button type="button" className="button button-outline button-small" onClick={() => setDialog(true)} disabled={blocked !== null || nothing}>
						{action}
					</button>
				</>
			)}
			{dialog && state ? (
				<PublishDialog
					sessionId={sessionId}
					state={state}
					files={files}
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
