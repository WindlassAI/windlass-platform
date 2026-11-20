/**
 * A list of agents as the home screen and a repository's page show it: one row per agent, with rename
 * and delete, and a long list folded so that the page stays readable. What a fold hides is said in
 * numbers, and an agent that is at work or waits on its user is never among it.
 */
import { MAX_TITLE_CHARS, type SessionSummary } from "@contract";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { absoluteTime, plural, relativeTime } from "../lib/format";
import { foldGroup } from "../lib/repositories";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { PencilIcon, TrashIcon, WarnIcon } from "./Icons";
import { OutcomeWord, SandboxState, StatusBadge, StatusGlyph } from "./Status";

function repoName(url: string): string {
	return url.replace(/^https:\/\//, "").replace(/\.git$/, "");
}

/** `grouped`: the row stands under its repository's name, so it says the branch and not the repository again. */
function AgentRow({ session, profileName, now, grouped, onDelete }: { session: SessionSummary; profileName: string; now: number; grouped: boolean; onDelete(session: SessionSummary): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(session.title);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const renameButton = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (renaming) input.current?.select();
	}, [renaming]);

	const closeRename = () => {
		setRenaming(false);
		setError(null);
		requestAnimationFrame(() => renameButton.current?.focus());
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		const next = title.trim();
		if (next === "" || next === session.title) return closeRename();
		setSaving(true);
		try {
			await client.user(auth).renameSession(session.id, next);
			closeRename();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setSaving(false);
		}
	};

	const active = session.status !== "idle";
	const waiting = session.status === "waiting";
	return (
		<li className={`agent-row${active && !waiting ? " agent-row-active" : ""}`} data-status={session.status}>
			<span className="agent-glyph">
				<StatusGlyph status={session.status} />
			</span>
			<div className="agent-main">
				{renaming ? (
					<form className="agent-rename" onSubmit={save}>
						<label className="visually-hidden" htmlFor={`rename-${session.id}`}>
							New title for {session.title}
						</label>
						<input
							ref={input}
							id={`rename-${session.id}`}
							className="input"
							value={title}
							maxLength={MAX_TITLE_CHARS}
							onChange={(event) => setTitle(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									setTitle(session.title);
									closeRename();
								}
							}}
							disabled={saving}
						/>
						<button type="submit" className="button button-primary button-small" disabled={saving || title.trim() === ""}>
							{saving ? "Saving…" : "Save"}
						</button>
						<button
							type="button"
							className="button button-quiet button-small"
							onClick={() => {
								setTitle(session.title);
								closeRename();
							}}
							disabled={saving}
						>
							Cancel
						</button>
						{error ? (
							<p className="field-note tone-bad" role="alert">
								{error}
							</p>
						) : null}
					</form>
				) : (
					<a className="agent-title" {...linkProps({ name: "session", id: session.id })}>
						{session.title}
						{waiting ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
					</a>
				)}
				<p className="agent-meta">
					<span>{profileName}</span>
					<span>{session.model}</span>
					<span>{session.turns === 0 ? "no turns" : plural(session.turns, "turn")}</span>
					{grouped && session.repository ? <span className="agent-repo">{session.repository.branch}</span> : session.repoUrl ? <span className="agent-repo">{repoName(session.repoUrl)}</span> : null}
				</p>
			</div>
			<div className="agent-state">
				{active ? <StatusBadge status={session.status} /> : <OutcomeWord outcome={session.lastOutcome} />}
				<SandboxState state={session.sandbox} />
			</div>
			<time className="agent-time" dateTime={new Date(session.updatedAt).toISOString()} title={absoluteTime(session.updatedAt)}>
				{relativeTime(session.updatedAt, now)}
			</time>
			<div className="agent-actions">
				<button
					ref={renameButton}
					type="button"
					className="icon-button"
					aria-label={`Rename ${session.title}`}
					title="Rename"
					onClick={() => {
						setTitle(session.title);
						setRenaming(true);
					}}
				>
					<PencilIcon />
				</button>
				<button type="button" className="icon-button icon-button-danger" aria-label={`Delete ${session.title}`} title="Delete" onClick={() => onDelete(session)}>
					<TrashIcon />
				</button>
			</div>
		</li>
	);
}

function DeleteDialog({ session, onClose }: { session: SessionSummary; onClose(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).deleteSession(session.id);
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Delete this agent?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={remove} disabled={busy}>
						{busy ? "Deleting…" : "Delete agent"}
					</button>
				</>
			}
		>
			<p>
				<strong>{session.title}</strong> will be removed with its conversation and its sandbox, including every file in the workspace. This cannot be undone.
			</p>
			{session.status !== "idle" ? <p className="tone-warn">It is working right now; deleting it stops the turn.</p> : null}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

/** The lists a user unfolded, by `foldKey`: they stay unfolded while the page is open, also across a visit to an agent. */
const unfolded = new Set<string>();

export function AgentList({
	sessions,
	limit,
	foldKey,
	label,
	grouped,
	now,
}: {
	/** In the order they are shown. */
	sessions: SessionSummary[];
	/** How many are shown while the list is folded (lib/repositories.ts, `foldGroup`). */
	limit: number;
	foldKey: string;
	label: string;
	grouped: boolean;
	now: number;
}) {
	const { platform } = useApp();
	const [open, setOpen] = useState(() => unfolded.has(foldKey));
	const [deleting, setDeleting] = useState<SessionSummary | null>(null);
	const folded = foldGroup(sessions, limit);
	const shown = open ? sessions : folded.shown;
	const profileName = (id: string) => platform.info?.profiles.find((profile) => profile.id === id)?.name ?? id;
	const toggle = () => {
		if (open) unfolded.delete(foldKey);
		else unfolded.add(foldKey);
		setOpen(!open);
	};

	return (
		<>
			<ul className="agents" aria-label={label}>
				{shown.map((session) => (
					<AgentRow key={session.id} session={session} profileName={profileName(session.profile)} now={now} grouped={grouped} onDelete={setDeleting} />
				))}
			</ul>
			{folded.hidden > 0 ? (
				<p className="agents-fold">
					<button type="button" className="link" onClick={toggle} aria-expanded={open}>
						{open ? "Show fewer" : `Show ${plural(folded.hidden, "more agent")}`}
					</button>
					{open ? null : <span>used before the ones above; none of them is working</span>}
				</p>
			) : null}
			{deleting ? <DeleteDialog session={deleting} onClose={() => setDeleting(null)} /> : null}
		</>
	);
}
