/**
 * Settings: the Linear integration, one-way. The owner connects a workspace through Linear's OAuth, then maps a team
 * to one repository of their GitHub connection. An issue of a mapped team that gains the `windlass` label, or is
 * assigned to the Windlass app user, is filed as a work item. Windlass writes nothing back to Linear.
 *
 * The OAuth callback finishes on the server and sends the browser back with `#linear=connected` or
 * `#linear-error=<code>`: the page says so once, then asks again where things stand.
 */
import type { GithubRepository, LinearStatus, LinearTeam } from "@contract";
import { useEffect, useId, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";

const ERRORS: Record<string, string> = {
	access_denied: "Linear was not given access, so nothing is connected.",
	state: "That connection attempt expired. Connect again.",
};

/** What the address says about a return from Linear, read once. */
function returned(): { kind: "connected" } | { kind: "error"; code: string } | null {
	const hash = typeof location === "undefined" ? "" : location.hash;
	if (hash === "#linear=connected") return { kind: "connected" };
	const failed = /^#linear-error=(.+)$/.exec(hash);
	return failed ? { kind: "error", code: decodeURIComponent(failed[1] as string) } : null;
}

export function LinearSettings() {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const ids = { team: useId(), repository: useId() };
	const [status, setStatus] = useState<LinearStatus | null>(null);
	const [teams, setTeams] = useState<LinearTeam[] | null>(null);
	const [repositories, setRepositories] = useState<GithubRepository[] | null>(null);
	const [back] = useState(returned);
	const [teamId, setTeamId] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);

	useEffect(() => {
		if (back) history.replaceState(null, "", location.pathname + location.search);
	}, [back]);

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const api = client.user(auth);
				const next = await api.linear();
				if (!live) return;
				setStatus(next);
				if (next.state !== "connected") return;
				const [list, repos] = await Promise.all([api.linearTeams(), platform.info?.github ? api.githubRepositories("").then((found) => found.repositories) : Promise.resolve([] as GithubRepository[])]);
				if (!live) return;
				setTeams(list.teams);
				setRepositories(repos);
			} catch (failure) {
				if (live) setFailed(explain(failure));
			}
		})();
		return () => {
			live = false;
		};
	}, [client, auth, explain, platform.info?.github]);

	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	};
	const connect = () =>
		run(async () => {
			const { url } = await client.user(auth).linearConnect({ origin: location.origin });
			location.assign(url);
		});
	const save = () =>
		run(async () => {
			const list = await client.user(auth).saveLinearMapping({ teamId, repositoryId: Number(repositoryId) });
			setTeams(list.teams);
			setTeamId("");
			setRepositoryId("");
		});
	const remove = (team: LinearTeam) => run(async () => setTeams((await client.user(auth).removeLinearMapping(team.id)).teams));

	if (status?.state === "off") return null;
	const ready = teamId !== "" && repositoryId !== "";
	return (
		<section className="usage-section" aria-labelledby="settings-linear" data-testid="linear-settings">
			<h2 className="usage-title" id="settings-linear">Linear</h2>
			<p className="usage-lede">
				File work items from Linear issues. An issue in a mapped team that gains the <code>windlass</code> label, or is assigned to the Windlass app user, is filed on that team's repository. Windlass writes nothing back to Linear.
			</p>
			{back?.kind === "connected" ? <p className="callout" role="status">Linear is connected. Choose a repository for a team below.</p> : null}
			{back?.kind === "error" ? (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>{ERRORS[back.code] ?? `Linear could not be connected (${back.code}). Try again.`}</span>
				</p>
			) : null}
			{failed ? (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>{failed}</span>
				</p>
			) : status === null ? (
				<div className="usage-loading" aria-busy="true" aria-label="Loading Linear">
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			) : status.state === "disconnected" ? (
				<p>
					<button type="button" className="button button-outline" onClick={() => void connect()} disabled={busy}>
						{busy ? "Connecting…" : "Connect Linear"}
					</button>
				</p>
			) : (
				<>
					<p className="field-note" data-testid="linear-workspace">
						Connected to {status.connection.workspace.name} as {status.connection.user.name}. An issue you create there starts at once; anyone else's is filed as a draft.
					</p>
					{teams === null || repositories === null ? (
						<div className="usage-loading" aria-busy="true" aria-label="Loading teams">
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					) : (
						<>
							<ul className="linear-teams" aria-label="Teams">
								{teams.map((team) => (
									<li key={team.id} data-testid={`linear-team-${team.key}`}>
										<span>{team.name} ({team.key})</span>{" "}
										{team.mapping ? (
											<>
												<span>files to {team.mapping.repository.owner}/{team.mapping.repository.name}</span>{" "}
												<button type="button" className="button button-quiet button-small" onClick={() => void remove(team)} disabled={busy} aria-label={`Remove the mapping of ${team.name}`}>Remove</button>
											</>
										) : (
											<span>not mapped: its issues are ignored</span>
										)}
									</li>
								))}
							</ul>
							<div className="field">
								<label className="label" htmlFor={ids.team}>Team</label>
								<select id={ids.team} className="select" value={teamId} onChange={(event) => setTeamId(event.target.value)} disabled={busy}>
									<option value="">Choose a team</option>
									{teams.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.key})</option>)}
								</select>
							</div>
							<div className="field">
								<label className="label" htmlFor={ids.repository}>Repository</label>
								<select id={ids.repository} className="select" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} disabled={busy}>
									<option value="">Choose a repository</option>
									{repositories.map((repository) => <option key={repository.id} value={String(repository.id)}>{repository.owner}/{repository.name}</option>)}
								</select>
								<p className="field-note">A team files to one repository of your GitHub connection. Removing a mapping, or unlabelling or unassigning an issue, does not change items already filed.</p>
							</div>
							<button type="button" className="button button-primary" onClick={() => void save()} disabled={!ready || busy}>Save mapping</button>
						</>
					)}
				</>
			)}
			{error ? <p className="callout callout-bad" role="alert"><WarnIcon /><span>{error}</span></p> : null}
		</section>
	);
}
