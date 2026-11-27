/**
 * "Continue in a new PR": a new agent that picks up from this one with the same settings, in a new
 * workspace on a branch of its own, with its own pull request (`continueSession`). The dialog asks
 * only where its branch starts: the repository's default branch, or, once this agent's work is on
 * GitHub, on top of its branch ("Stack on #N"). Also the side panel's rows linking the two agents.
 */
import type { PublishState, PullRequestInfo, SessionSummary } from "@contract";
import { useEffect, useId, useState } from "react";
import { continuedIn } from "../lib/continued";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { WarnIcon } from "./Icons";

/** What "Stack on" starts from, as the server decides it: an open pull request's branch, else the branch the platform pushed. */
export function stackChoice(
	pull: PullRequestInfo | null,
	state: Pick<PublishState, "branch" | "pushed"> | null,
): { branch: string; pull: number | null } | null {
	if (pull && (pull.state === "open" || pull.state === "draft")) return { branch: pull.branch, pull: pull.number };
	if (state?.pushed) return { branch: state.branch, pull: null };
	return null;
}

export function ContinueButton({
	summary,
	stack,
}: {
	summary: SessionSummary;
	stack: { branch: string; pull: number | null } | null;
}) {
	const [open, setOpen] = useState(false);
	const idle = summary.status === "idle";
	return (
		<>
			<button
				type="button"
				className="button button-quiet button-small gh-continue"
				onClick={() => setOpen(true)}
				disabled={!idle}
				title={
					idle
						? "Start a new agent that picks up from this one, with its own pull request"
						: "Available when this turn ends."
				}
			>
				Continue in a new PR
			</button>
			{open ? <ContinueDialog summary={summary} stack={stack} onClose={() => setOpen(false)} /> : null}
		</>
	);
}

export function ContinueDialog({
	summary,
	stack,
	onClose,
}: {
	summary: SessionSummary;
	stack: { branch: string; pull: number | null } | null;
	onClose(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const name = useId();
	const repository = summary.repository ?? null;
	const [base, setBase] = useState<string | null>(null);
	const [stacked, setStacked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [submission, setSubmission] = useState<Submission | null>(null);

	// The default branch's name, for the first choice; "the default branch" until it is known.
	useEffect(() => {
		if (!repository) return;
		let current = true;
		client
			.user(auth)
			.githubBranches(repository.id)
			.then(
				list => current && setBase(list.defaultBranch),
				() => undefined,
			);
		return () => {
			current = false;
		};
	}, [client, auth, repository?.id]);

	const start = async () => {
		const stack = stacked;
		const next = submissionOf(JSON.stringify({ id: summary.id, stack }), submission);
		setSubmission(next);
		setBusy(true);
		setError(null);
		try {
			const made = await client
				.user(auth)
				.continueSession({ id: summary.id, stack, idempotencyKey: next.idempotencyKey });
			onClose();
			navigate({ name: "session", id: made.id });
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	const stackName = stack ? (stack.pull === null ? stack.branch : `#${stack.pull}`) : "";
	const choices = [
		{
			stack: false,
			label: `Start from ${base ?? "the default branch"}`,
			note: "The new pull request is based on the repository's default branch, with none of this agent's unmerged work.",
		},
		...(stack
			? [
					{
						stack: true,
						label: `Stack on ${stackName}`,
						note: `Starts from ${stack.branch}, and the new pull request is based on it.`,
					},
				]
			: []),
	];

	return (
		<Dialog
			title="Continue in a new PR"
			lede="A new agent picks up from this one with the same settings, in a new workspace on its own branch. This agent and its pull request stay as they are."
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="button" className="button button-primary" onClick={start} disabled={busy} data-autofocus>
						{busy ? "Starting…" : "Continue"}
					</button>
				</>
			}
		>
			<fieldset className="continue-choices">
				<legend className="label">Where the new branch starts</legend>
				{choices.map(choice => (
					<label key={String(choice.stack)} className="continue-choice">
						<input
							type="radio"
							name={name}
							checked={stacked === choice.stack}
							disabled={busy}
							onChange={() => setStacked(choice.stack)}
						/>
						<span>
							<strong>{choice.label}</strong>
							<small className="continue-choice-note">{choice.note}</small>
						</span>
					</label>
				))}
			</fieldset>
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

/**
 * The side panel's rows between an agent and the ones continuing it: "continued from" from its own
 * summary, "continued in" from the user's list, read when the panel opens.
 */
export function ContinuedRows({ summary }: { summary: SessionSummary }) {
	const { client } = useApp();
	const auth = useAuth();
	const [later, setLater] = useState<SessionSummary[]>([]);
	useEffect(() => {
		let current = true;
		client
			.user(auth)
			.listSessions()
			.then(
				sessions => current && setLater(continuedIn(sessions, summary.id)),
				() => undefined,
			);
		return () => {
			current = false;
		};
	}, [client, auth, summary.id]);
	const from = summary.continuedFrom ?? null;
	if (!from && later.length === 0) return null;
	return (
		<>
			{from ? (
				<>
					<dt>continued from</dt>
					<dd className="kv-clip" title={from.title}>
						<a className="kv-link" {...linkProps({ name: "session", id: from.id })}>
							{from.title}
						</a>
					</dd>
				</>
			) : null}
			{later.length > 0 ? (
				<>
					<dt>continued in</dt>
					<dd className="kv-clip kv-list">
						{later.map((one, index) => (
							<span key={one.id}>
								{index > 0 ? ", " : null}
								<a className="kv-link" title={one.title} {...linkProps({ name: "session", id: one.id })}>
									{one.title}
								</a>
							</span>
						))}
					</dd>
				</>
			) : null}
		</>
	);
}
