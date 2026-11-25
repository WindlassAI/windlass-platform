/**
 * Settings: the Linear integration. The owner connects a workspace through Linear's OAuth, then maps a team
 * to one repository of their GitHub connection. An issue of a mapped team that gains a Windlass filing label, or is
 * assigned to the Windlass app user, is filed as a work item.
 *
 * The signed-in user redeems the ticket returned by the OAuth callback.
 */
import type { GithubRepository, LinearStatus, LinearTeam } from "@contract";
import { useEffect, useId, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";

const ERRORS: Record<string, string> = {
	access_denied: "Linear was not given access, so nothing is connected.",
	state: "That connection attempt expired. Connect again.",
};

export function LinearSettings() {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const ids = { team: useId(), repository: useId() };
	const [status, setStatus] = useState<LinearStatus | null>(null);
	const [teams, setTeams] = useState<LinearTeam[] | null>(null);
	const [repositories, setRepositories] = useState<GithubRepository[] | null>(null);
	const [connected, setConnected] = useState(false);
	const [teamId, setTeamId] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [repositoryProblem, setRepositoryProblem] = useState<string | null>(null);

	useEffect(() => {
		const back = /^#(linear|linear-error)=(.+)$/.exec(location.hash);
		if (!back) return;
		history.replaceState(null, "", location.pathname + location.search);
		const [, kind, value] = back;
		if (kind === "linear-error") {
			setError(ERRORS[value === "denied" ? "access_denied" : value!] ?? `Linear could not be connected (${value}). Try again.`);
			return;
		}
		void client.user(auth).linearComplete(value!).then(() => setConnected(true), failure => setError(explain(failure)));
	}, [client, auth, explain]);

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const api = client.user(auth);
				const next = await api.linear();
				if (!live) return;
				setStatus(next);
				if (next.state !== "connected") return;
				const list = await api.linearTeams();
				if (!live) return;
				setTeams(list.teams);
				// A GitHub problem leaves the connection and its teams on show: only choosing a repository needs GitHub.
				const repos = platform.info?.github ? await api.githubRepositories("").then((found) => found.repositories).catch((failure: unknown) => explain(failure)) : [];
				if (!live) return;
				if (typeof repos === "string") setRepositoryProblem(repos);
				else setRepositories(repos);
			} catch (failure) {
				if (live) setFailed(explain(failure));
			}
		})();
		return () => {
			live = false;
		};
	}, [client, auth, explain, platform.info?.github, connected]);

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
	const disconnect = () => {
		if (!confirm("Disconnect Linear? Its team mappings are removed and nothing more is filed from Linear. Items already filed stay.")) return;
		void run(async () => {
			setStatus(await client.user(auth).disconnectLinear());
			setConnected(false);
			setTeams(null);
		});
	};
	const remove = (team: LinearTeam) => run(async () => setTeams((await client.user(auth).removeLinearMapping(team.id)).teams));

	if (status?.state === "off") return null;
	const ready = teamId !== "" && repositoryId !== "";
	const unmapped = teams?.filter((team) => !team.mapping) ?? [];
	return (
		<section className="usage-section repo-saved" aria-labelledby="settings-linear" data-testid="linear-settings">
			<h3 className="usage-title" id="settings-linear">
				Linear
				{status?.state === "disconnected" ? (
					<button type="button" className="link secret-add" onClick={() => void connect()} disabled={busy}>
						{busy ? "Connecting…" : "Connect Linear…"}
					</button>
				) : status?.state === "connected" ? (
					<button type="button" className="link secret-add" onClick={disconnect} disabled={busy}>
						Disconnect…
					</button>
				) : null}
			</h3>
			<p className="usage-lede">
				File work items from Linear issues labelled <code>windlass</code>.
			</p>
			{connected && status?.state === "connected" ? <p className="callout" role="status">Linear is connected. Choose a repository for a team below.</p> : null}
			{failed ? (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>{failed}</span>
				</p>
			) : status === null ? (
				<div className="usage-loading" aria-busy="true" aria-label="Loading Linear">
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			) : status.state === "connected" ? (
				<>
					<details className="field-note">
						<summary>Details</summary>
						Label an issue <code>windlass</code> or assign it to Windlass. Use <code>windlass-quick</code> or <code>windlass:quick</code> for Quick mode.
					</details>
					<p className="field-note" data-testid="linear-workspace">
						Connected to {status.connection.workspace.name} as {status.connection.user.name}. Review and start filed drafts in Windlass.
					</p>
					{teams === null ? (
						<div className="usage-loading" aria-busy="true" aria-label="Loading teams">
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					) : (
						<ul className="usage-kept" aria-label="Teams">
							{teams.map((team) => (
								<li key={team.id} className="usage-kept-row" data-testid={`linear-team-${team.key}`}>
									<div className="usage-kept-main">
										<span className="usage-kept-title">{team.name}</span>
										<p className="agent-meta">
											{team.key} {team.mapping ? <>→ {team.mapping.repository.owner}/{team.mapping.repository.name}</> : "· not mapped, its issues are ignored"}
										</p>
									</div>
									<span />
									{team.mapping ? (
										<button type="button" className="button button-outline button-small" onClick={() => void remove(team)} disabled={busy}>
											Remove<span className="visually-hidden"> the mapping of {team.name}</span>
										</button>
									) : (
										<span />
									)}
								</li>
							))}
						</ul>
					)}
					{repositoryProblem ? (
						<p className="usage-note tone-warn">{repositoryProblem} Connect GitHub to map a team to a repository.</p>
					) : teams !== null && repositories !== null && unmapped.length > 0 ? (
						<>
							<div className="linear-map">
								<label className="visually-hidden" htmlFor={ids.team}>Team</label>
								<select id={ids.team} className="select" value={teamId} onChange={(event) => setTeamId(event.target.value)} disabled={busy}>
									<option value="">Choose a team</option>
									{unmapped.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.key})</option>)}
								</select>
								<label className="visually-hidden" htmlFor={ids.repository}>Repository</label>
								<select id={ids.repository} className="select" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} disabled={busy}>
									<option value="">Choose a repository</option>
									{repositories.map((repository) => <option key={repository.id} value={String(repository.id)}>{repository.owner}/{repository.name}</option>)}
								</select>
								<button type="button" className="button button-outline" onClick={() => void save()} disabled={!ready || busy}>Map team</button>
							</div>
							<p className="field-note">A team files to one repository of your GitHub connection. Removing a mapping, or unlabelling or unassigning an issue, does not change items already filed.</p>
						</>
					) : null}
				</>
			) : null}
			{error ? <p className="callout callout-bad" role="alert"><WarnIcon /><span>{error}</span></p> : null}
		</section>
	);
}
