import type { GitlabProjectList, GitlabStatus } from "@contract";
import { useEffect, useMemo, useState } from "react";
import { useApp, useAuth } from "../state/app";

export function useGitlabSettings() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const api = useMemo(() => client.user(auth), [client, auth]);
	const [status, setStatus] = useState<GitlabStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	// Both StrictMode subscriptions await the same one-time ticket redemption.
	const load = useMemo(() => {
		let pending: Promise<{ status: GitlabStatus; error?: string }> | undefined;
		async function read() {
			const back = /^#(gitlab|gitlab-error)=(.*)$/.exec(location.hash);
			if (!back) return { status: await api.gitlab() };
			history.replaceState(history.state, "", location.pathname + location.search);
			let message = "GitLab could not be connected. Try again.";
			if (back[1] === "gitlab") {
				try { return { status: await api.gitlabComplete(back[2]!) }; }
				catch (failure) { message = explain(failure); }
			} else if (["access_denied", "denied"].includes(back[2]!)) message = "GitLab was not given access.";
			return { status: await api.gitlab(), error: message };
		}
		return () => pending ??= read();
	}, [api, explain, attempt]);
	useEffect(() => {
		let live = true;
		void load().then(result => {
			if (live) { setStatus(result.status); setError(result.error ?? null); }
		}, failure => { if (live) setError(explain(failure)); });
		return () => { live = false; };
	}, [load, explain]);
	return { api, status, setStatus, error, setError, reload: () => retry(n => n + 1) };
}

export function GitlabSettings({ connection }: { connection: ReturnType<typeof useGitlabSettings> }) {
	const { api, status, setStatus, error, setError, reload } = connection;
	const { explain } = useApp();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState("");
	const [list, setList] = useState<GitlabProjectList | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	const [busy, setBusy] = useState(false);
	const connected = status?.state === "connected";
	useEffect(() => {
		if (!connected) return;
		let live = true;
		setList(null);
		setListError(null);
		setSelected("");
		const timer = setTimeout(() => void api.gitlabProjects(query).then(next => {
			if (live) setList(next);
		}, failure => { if (live) setListError(explain(failure)); }), query ? 200 : 0);
		return () => { live = false; clearTimeout(timer); };
	}, [api, connected, query, explain, attempt]);
	async function run(work: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try { await work(); } catch (failure) { setError(explain(failure)); } finally { setBusy(false); }
	}
	if (status?.state === "off" || (!status && !error)) return null;
	return (
		<section className="usage-section repo-saved" id="settings-gitlab" aria-labelledby="settings-gitlab-title">
			<h3 className="usage-title" id="settings-gitlab-title">GitLab
				{status?.state === "disconnected" && <button className="link secret-add" disabled={busy} onClick={() => void run(async () => {
					location.assign((await api.gitlabConnect({ origin: location.origin })).url);
				})}>Connect GitLab…</button>}
				{connected && <button className="link secret-add" disabled={busy} onClick={() => {
					if (confirm("Disconnect GitLab and forget the selected project?")) void run(async () => { setStatus(await api.gitlabDisconnect()); setQuery(""); });
				}}>Disconnect…</button>}
			</h3>
			{error && <p className="callout callout-warn" role="alert">{error} {!status && <button className="link" onClick={reload}>Try again</button>}</p>}
			{status?.state === "disconnected" && (status.reconnect
				? <p className="callout callout-warn" role="status">GitLab no longer accepts Windlass's access. Reconnect GitLab and choose the project again.</p>
				: <p className="usage-lede">Connect GitLab to choose a project for Windlass.</p>)}
			{status?.state === "connected" && <>
				<p className="usage-lede">Connected to <strong>{status.baseUrl}</strong>.</p>
				<p className="field-note" role="status">{status.project ? <>Selected project: <strong>{status.project.owner}/{status.project.name}</strong> · <code>{status.project.branch}</code></> : "No project selected."}</p>
				<p className="field-note" id="gitlab-hook-note">Saving registers a webhook on the selected GitLab project. You need Maintainer access or higher.</p>
				<div className="linear-map">
					<label className="visually-hidden" htmlFor="gitlab-query">Search GitLab projects</label>
					<input className="input" type="search" maxLength={256} id="gitlab-query" placeholder="Search projects" value={query} onChange={e => setQuery(e.target.value)} disabled={busy} />
					<label className="visually-hidden" htmlFor="gitlab-project">GitLab project</label>
					<select className="select" id="gitlab-project" value={selected} onChange={e => setSelected(e.target.value)} disabled={busy || !list?.projects.length}>
						<option value="">{listError ? "Projects unavailable" : !list ? "Loading projects…" : !list.projects.length ? "No matching projects" : "Choose a project"}</option>
						{list?.projects.map(p => <option key={p.id} value={String(p.id)}>{p.owner}/{p.name}</option>)}
					</select>
					<button className="button button-outline button-small" aria-describedby="gitlab-hook-note" disabled={busy || !selected || selected === String(status.project?.id)} onClick={() => void run(async () => setStatus(await api.gitlabPickProject(selected)))}>Save project</button>
				</div>
				{list?.more && <p className="field-note">Search by project name to narrow the list.</p>}
				{listError && <p className="callout callout-warn" role="alert">{listError} <button className="link" onClick={() => retry(n => n + 1)}>Try again</button></p>}
			</>}
		</section>
	);
}
