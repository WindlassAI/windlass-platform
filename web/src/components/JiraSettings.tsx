import type { GithubRepository, JiraProject, JiraSite, JiraStatus } from "@contract";
import { useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { SettingsSection } from "./SettingsGroups";

function callbackError(reason: string | undefined) {
	switch (reason) {
		case "denied": return "Jira was not given access. Connect again when you’re ready.";
		case "scope": return "Jira did not grant the required permissions. Connect again.";
		case "sites": return "No Jira sites granted all the required permissions. Check your site access and connect again.";
		default: return "Jira could not be connected. Try again.";
	}
}

export function JiraSettings() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [status, setStatus] = useState<JiraStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [siteId, setSiteId] = useState("");

	useEffect(() => {
		// The grant stays on the server. The return fragment is a hint, never a credential.
		const back = /^#(jira|jira-error)=(.*)$/.exec(location.hash);
		if (back) {
			history.replaceState(history.state, "", location.pathname + location.search);
			document.getElementById("settings-jira")?.scrollIntoView?.({ block: "center" });
			if (back[1] === "jira-error" || back[2] !== "select-site") {
				setError(callbackError(back[1] === "jira-error" ? back[2] : undefined));
			}
		}
		let live = true;
		void client.user(auth).jira().then(value => { if (live) setStatus(value); }, failure => { if (live) setError(explain(failure)); });
		return () => { live = false; };
	}, [client, auth, explain]);

	async function run(work: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try { await work(); } catch (failure) { setError(explain(failure)); } finally { setBusy(false); }
	}
	if (status?.state === "off") return null;
	const api = client.user(auth);
	const connection = status?.state === "connected" ? status.connection : null;
	return <SettingsSection id="settings-jira" title="Jira Cloud">
		<p className="usage-lede">File drafts from Jira issues in projects you map to GitHub repositories.</p>
		{!status && !error && <p className="field-note" aria-busy="true">Loading Jira…</p>}
		{status?.state === "disconnected" && <button className="button button-outline" disabled={busy} onClick={() => void run(async () => {
			const { url } = await api.jiraConnect({ origin: location.origin });
			location.assign(url);
		})}>Connect Jira…</button>}
		{connection && <>
			{connection.site ? <>
				<p className="field-note">Connected to {connection.site.name} ({connection.site.url}) as {connection.user.name}.</p>
				<JiraProjects key={connection.site.id} site={connection.site} busy={busy} run={run} />
			</> : <div className="linear-map">
				<select aria-label="Jira site" className="select" value={siteId} onChange={event => setSiteId(event.target.value)} disabled={busy}>
					<option value="">Choose a Jira site</option>
					{connection.sites.map(site => <option key={site.id} value={site.id}>{site.name} ({site.url})</option>)}
				</select>
				<button className="button button-outline" disabled={busy || !siteId} onClick={() => void run(async () => setStatus(await api.jiraSelectSite(siteId)))}>Connect site</button>
			</div>}
			<button className="link" disabled={busy} onClick={() => {
				if (confirm("Disconnect Jira and remove its project mappings? Items already filed stay.")) void run(async () => {
					setStatus(await api.disconnectJira());
					setSiteId("");
				});
			}}>Disconnect Jira…</button>
		</>}
		{error && <p className="callout callout-bad" role="alert">{error}</p>}
	</SettingsSection>;
}

function JiraProjects({ site, busy, run }: { site: JiraSite; busy: boolean; run: (work: () => Promise<void>) => Promise<void> }) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [projects, setProjects] = useState<JiraProject[] | null>(null);
	const [repositories, setRepositories] = useState<GithubRepository[] | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);
	const [repoError, setRepoError] = useState<string | null>(null);
	const [projectId, setProjectId] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		void api.jiraProjects().then(list => { if (live) setProjects(list.projects); }, failure => { if (live) setProjectError(explain(failure)); });
		if (!platform.info?.github) setRepositories([]);
		else void api.githubRepositories("").then(list => { if (live) setRepositories(list.repositories.filter(repo => repo.canPush)); }, failure => { if (live) setRepoError(explain(failure)); });
		return () => { live = false; };
	}, [client, auth, explain, platform.info?.github]);
	const unmapped = projects?.filter(project => !project.mapping) ?? [];
	const repository = repositories?.find(repo => String(repo.id) === repositoryId);
	const api = client.user(auth);
	return <>
		<details className="field-note"><summary>How filing works</summary>In a mapped project, add <code>windlass</code> or assign the issue to the Jira account shown above to file a draft. Use <code>windlass-quick</code> to file in Quick mode. A qualifying issue with the Bug type or a <code>bug</code> label also uses Quick. Review and start drafts in Windlass.</details>
		{projectError ? <p className="callout callout-warn" role="alert">{projectError}</p> : projects === null ? <p className="field-note" aria-busy="true">Loading Jira projects…</p> : projects.length === 0 ? <p>No Jira projects found on this site.</p> :
			<ul className="settings-list" aria-label="Jira projects">{projects.map(project => <li key={project.id} className="usage-kept-row">
				<div className="usage-kept-main"><span className="usage-kept-title">{project.name} ({project.key})</span>
					<p className="agent-meta">{project.mapping ? `${project.mapping.repository.owner}/${project.mapping.repository.name}` : "Not mapped"}</p>
				</div>
				{project.mapping && <button className="button button-outline button-small" disabled={busy} aria-label={`Remove the mapping of ${project.name}`} onClick={() => void run(async () => {
					setProjects((await api.removeJiraMapping({ siteId: site.id, projectId: project.id })).projects);
				})}>Remove</button>}
			</li>)}</ul>}
		{repoError && <p className="callout callout-warn" role="alert">{repoError}</p>}
		{unmapped.length > 0 && repositories !== null && (repositories.length ? <div className="linear-map">
			<select aria-label="Jira project" className="select" disabled={busy} value={projectId} onChange={event => setProjectId(event.target.value)}>
				<option value="">Choose a project</option>
				{unmapped.map(project => <option key={project.id} value={project.id}>{project.name} ({project.key})</option>)}
			</select>
			<select aria-label="GitHub repository" className="select" disabled={busy} value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>
				<option value="">Choose a repository</option>
				{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.owner}/{repo.name}</option>)}
			</select>
			<button className="button button-outline" disabled={busy || !projectId || !repository} onClick={() => void run(async () => {
				if (!repository) return;
				setProjects((await api.saveJiraMapping({ siteId: site.id, projectId, repositoryId: repository.id })).projects);
				setProjectId("");
				setRepositoryId("");
			})}>Map project</button>
		</div> : <p className="field-note">Connect a GitHub repository you can write to before mapping a Jira project.</p>)}
	</>;
}
