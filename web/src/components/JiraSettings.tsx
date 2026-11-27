import type { JiraProject, JiraSite, JiraStatus } from "@contract";
import { useEffect, useRef, useState } from "react";
import { useHash } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useRepositorySearch } from "./RepositoryMenu";

const callbackErrors = new Map([
	["denied", "Jira was not given access. Connect again when you’re ready."],
	["scope", "Jira did not grant the required permissions. Connect again."],
	["sites", "No Jira sites granted all the required permissions. Check your site access and connect again."],
]);

export function JiraSettings() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const hash = useHash();
	const [status, setStatus] = useState<JiraStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [siteId, setSiteId] = useState("");

	// StrictMode can restart the effect after the single-use fragment has been stripped.
	const redemption = useRef<{ auth: typeof auth; client: typeof client; result: Promise<JiraStatus> } | null>(null);
	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		const back = /^#(jira|jira-error)=(.*)$/.exec(location.hash);
		if (back) {
			history.replaceState(history.state, "", location.pathname + location.search);
			document.getElementById("settings-jira")?.scrollIntoView?.({ block: "center" });
			if (back[1] === "jira-error") setError(callbackErrors.get(back[2]!) ?? "Jira could not be connected. Try again.");
			else redemption.current = { auth, client, result: api.jiraComplete(back[2]!) };
		}
		const pending = redemption.current;
		const result =
			pending?.auth === auth && pending.client === client
				? pending.result.catch(failure => {
						if (live) setError(explain(failure));
						return api.jira();
					})
				: api.jira();
		void result.then(
			next => {
				if (live) {
					setStatus(next);
					redemption.current = null;
				}
			},
			failure => {
				if (live) setError(explain(failure));
			},
		);
		return () => {
			live = false;
		};
	}, [client, auth, explain, hash]);

	async function run(work: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}
	if (status?.state === "off") return null;
	const api = client.user(auth);
	const connection = status?.state === "connected" ? status.connection : null;
	function disconnect() {
		if (!confirm("Disconnect Jira and remove its project mappings? Items already filed stay.")) return;
		void run(async () => {
			setStatus(await api.disconnectJira());
			setSiteId("");
		});
	}
	return (
		<section className="usage-section repo-saved" aria-labelledby="settings-jira">
			<h3 className="usage-title" id="settings-jira">
				Jira Cloud
				{connection && (
					<button type="button" className="link secret-add" disabled={busy} onClick={disconnect}>
						Disconnect Jira…
					</button>
				)}
			</h3>
			<p className="usage-lede">File drafts from Jira issues in projects you map to GitHub repositories.</p>
			{!status && !error && (
				<p className="field-note" aria-busy="true">
					Loading Jira…
				</p>
			)}
			{status?.state === "disconnected" && (
				<button
					className="button button-outline"
					disabled={busy}
					onClick={() =>
						void run(async () => {
							const { url } = await api.jiraConnect({ origin: location.origin });
							location.assign(url);
						})
					}
				>
					Connect Jira…
				</button>
			)}
			{connection && (
				<>
					{connection.site ? (
						<>
							<p className="field-note">
								Connected to {connection.site.name} ({connection.site.url}) as {connection.user.name}.
							</p>
							<JiraProjects key={connection.site.id} site={connection.site} busy={busy} run={run} />
						</>
					) : (
						<div className="linear-map">
							<select
								aria-label="Jira site"
								className="select"
								value={siteId}
								onChange={event => setSiteId(event.target.value)}
								disabled={busy}
							>
								<option value="">Choose a Jira site</option>
								{connection.sites.map(site => (
									<option key={site.id} value={site.id}>
										{site.name} ({site.url})
									</option>
								))}
							</select>
							<button
								className="button button-outline"
								disabled={busy || !siteId}
								onClick={() => void run(async () => setStatus(await api.jiraSelectSite(siteId)))}
							>
								Connect site
							</button>
						</div>
					)}
				</>
			)}
			{error && (
				<p className="callout callout-bad" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

function JiraProjects({
	site,
	busy,
	run,
}: {
	site: JiraSite;
	busy: boolean;
	run: (work: () => Promise<void>) => Promise<void>;
}) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [projects, setProjects] = useState<JiraProject[] | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);
	const [projectId, setProjectId] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		void api.jiraProjects().then(
			list => {
				if (live) setProjects(list.projects);
			},
			failure => {
				if (live) setProjectError(explain(failure));
			},
		);
		return () => {
			live = false;
		};
	}, [client, auth, explain]);
	const unmapped = projects?.filter(project => !project.mapping) ?? [];
	const { query, setQuery, found } = useRepositorySearch(!!platform.info?.github && unmapped.length > 0);
	const searching = found.loading || found.query !== query.trim() || !found.list;
	const repositories = searching ? [] : found.list!.repositories.filter(repo => repo.canPush);
	const repository = repositories.find(repo => String(repo.id) === repositoryId);
	const api = client.user(auth);
	return (
		<>
			<details className="field-note">
				<summary>How filing works</summary>Add <code>windlass</code> or assign the issue to the Jira account shown above
				to file a draft. Use <code>windlass-quick</code> to file in Quick mode. Qualifying bugs also use Quick.
			</details>
			{projectError ? (
				<p className="callout callout-warn" role="alert">
					{projectError}
				</p>
			) : projects === null ? (
				<p className="field-note" aria-busy="true">
					Loading Jira projects…
				</p>
			) : projects.length === 0 ? (
				<p>No Jira projects found on this site.</p>
			) : (
				<ul className="settings-list" aria-label="Jira projects">
					{projects.map(project => (
						<li key={project.id} className="usage-kept-row">
							<div className="usage-kept-main">
								<span className="usage-kept-title">
									{project.name} ({project.key})
								</span>
								<p className="agent-meta">
									{project.mapping
										? `${project.mapping.repository.owner}/${project.mapping.repository.name}`
										: "Not mapped"}
								</p>
							</div>
							{project.mapping && (
								<button
									className="button button-outline button-small"
									disabled={busy}
									aria-label={`Remove the mapping of ${project.name}`}
									onClick={() =>
										void run(async () => {
											setProjects((await api.removeJiraMapping({ siteId: site.id, projectId: project.id })).projects);
										})
									}
								>
									Remove
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			{found.error && (
				<p className="callout callout-warn" role="alert">
					{found.error}
				</p>
			)}
			{unmapped.length > 0 &&
				(platform.info?.github ? (
					<div className="linear-map">
						<select
							aria-label="Jira project"
							className="select"
							disabled={busy}
							value={projectId}
							onChange={event => setProjectId(event.target.value)}
						>
							<option value="">Choose a project</option>
							{unmapped.map(project => (
								<option key={project.id} value={project.id}>
									{project.name} ({project.key})
								</option>
							))}
						</select>
						<input
							type="search"
							className="input"
							aria-label="Search GitHub repositories"
							placeholder="Search repositories"
							value={query}
							disabled={busy}
							onChange={event => {
								setQuery(event.target.value);
								setRepositoryId("");
							}}
						/>
						<select
							aria-label="GitHub repository"
							className="select"
							disabled={busy}
							value={repositoryId}
							onChange={event => setRepositoryId(event.target.value)}
						>
							<option value="">
								{searching
									? found.error
										? "Repositories unavailable"
										: "Searching repositories…"
									: repositories.length
										? "Choose a repository"
										: "No writable matches"}
							</option>
							{repositories.map(repo => (
								<option key={repo.id} value={repo.id}>
									{repo.owner}/{repo.name}
								</option>
							))}
						</select>
						<button
							className="button button-outline"
							disabled={busy || !projectId || !repository}
							onClick={() =>
								void run(async () => {
									if (!repository) return;
									setProjects(
										(await api.saveJiraMapping({ siteId: site.id, projectId, repositoryId: repository.id })).projects,
									);
									setProjectId("");
									setRepositoryId("");
									setQuery("");
								})
							}
						>
							Map project
						</button>
						{found.list?.more && <p className="field-note">Search by name to see more repositories.</p>}
						{found.list?.incomplete && <p className="field-note">GitHub returned a partial list.</p>}
					</div>
				) : (
					<p className="field-note">Connect a GitHub repository you can write to before mapping a Jira project.</p>
				))}
		</>
	);
}
