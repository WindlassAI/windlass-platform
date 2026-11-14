/** Agents: the user's sessions, newest first and live, with rename, delete and a way to launch one. */
import { MAX_RUNNING_SESSIONS, MAX_TITLE_CHARS, type SessionSummary } from "@contract";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "../components/Dialog";
import { Mark, PencilIcon, PlusIcon, TrashIcon, WarnIcon } from "../components/Icons";
import { OutcomeWord, SandboxState, StatusBadge, StatusGlyph } from "../components/Status";
import { absoluteTime, plural, relativeTime } from "../lib/format";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useChatgpt, useNow, useSessions } from "../state/hooks";

function repoName(url: string): string {
	return url.replace(/^https:\/\//, "").replace(/\.git$/, "");
}

function SessionRow({ session, profileName, now, onDelete }: { session: SessionSummary; profileName: string; now: number; onDelete(session: SessionSummary): void }) {
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
		<li className={`agent-row${active ? " agent-row-active" : ""}${waiting ? " agent-row-waiting" : ""}`} data-status={session.status}>
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
					{session.repoUrl ? <span className="agent-repo">{repoName(session.repoUrl)}</span> : null}
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

export function Home() {
	const { platform } = useApp();
	const { sessions, connection, error } = useSessions();
	const now = useNow(15_000);
	const [deleting, setDeleting] = useState<SessionSummary | null>(null);

	const profileName = (id: string) => platform.info?.profiles.find((profile) => profile.id === id)?.name ?? id;
	const working = sessions?.filter((session) => session.status !== "idle").length ?? 0;
	const waiting = sessions?.filter((session) => session.status === "waiting").length ?? 0;
	const launch = () => navigate({ name: "new" });

	return (
		<main className="home">
			<header className="home-head">
				<div>
					<p className="eyebrow">
						{sessions === null ? "agents" : `${plural(sessions.length, "agent")} · ${working} of ${MAX_RUNNING_SESSIONS} working`}
						{waiting > 0 ? <span className="eyebrow-waiting"> · {waiting} {waiting === 1 ? "needs" : "need"} you</span> : null}
					</p>
					<h1 className="display">Agents</h1>
					<AccountLine />
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
			) : sessions.length === 0 ? (
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
				<ul className="agents" aria-label="Your agents, newest first">
					{sessions.map((session) => (
						<SessionRow key={session.id} session={session} profileName={profileName(session.profile)} now={now} onDelete={setDeleting} />
					))}
				</ul>
			)}

			{deleting ? <DeleteDialog session={deleting} onClose={() => setDeleting(null)} /> : null}
		</main>
	);
}
