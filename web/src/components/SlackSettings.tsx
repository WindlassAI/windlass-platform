import type { GithubRepository, SlackStatus } from "@contract";
import { useEffect, useRef, useState } from "react";
import { useApp, useAuth } from "../state/app";

const callbackErrors = new Map([
	["denied", "Slack was not given access. Connect again when you’re ready."],
	["state", "That connection attempt expired. Connect Slack again."],
	["used", "That connection attempt has already been used. Connect Slack again."],
	["scope", "Slack did not grant the required permissions. Connect Slack again."],
]);

export function SlackSettings() {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [status, setStatus] = useState<SlackStatus | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [channel, setChannel] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [repositories, setRepositories] = useState<GithubRepository[] | null>(null);
	const [repoProblem, setRepoProblem] = useState("");
	const [proof, setProof] = useState("");
	const card = useRef<HTMLElement>(null);
	const repoSelect = useRef<HTMLSelectElement>(null);
	const confirmLink = useRef<HTMLButtonElement>(null);
	const showReturn = useRef(false);
	const initial = useRef<Promise<SlackStatus> | null>(null);

	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		// StrictMode may replay this effect, but a callback ticket can only be redeemed once.
		if (!initial.current) {
			const back = /^#(slack|slack-error|slack-link)=(.*)$/.exec(location.hash);
			if (back) {
				showReturn.current = true;
				history.replaceState(history.state, "", location.pathname + location.search);
			}
			initial.current = (async () => {
				if (back?.[1] === "slack") {
					try { return await api.slackComplete(back[2]!); }
					catch { setError("That connection could not be completed. Connect Slack again."); }
				} else if (back?.[1] === "slack-error") {
					setError(callbackErrors.get(back[2]!) ?? "Slack could not be connected. Try again.");
				} else if (back?.[1] === "slack-link") setProof(back[2]!);
				return api.slack();
			})();
		}
		initial.current.then(next => { if (live) setStatus(next); }, failure => { if (live) setError(explain(failure)); });
		return () => { live = false; };
	}, [client, auth, explain]);

	useEffect(() => {
		if (status?.state !== "connected" || !platform.info?.github) return;
		let live = true;
		client.user(auth).githubRepositories("").then(list => {
			if (live) { setRepositories(list.repositories.filter(repo => repo.canPush)); setRepoProblem(""); }
		}, failure => { if (live) setRepoProblem(explain(failure)); });
		return () => { live = false; };
	}, [client, auth, explain, status?.state, platform.info?.github]);

	useEffect(() => {
		if (!showReturn.current || (!status && !error) || !card.current) return;
		showReturn.current = false;
		card.current.scrollIntoView?.({ block: "start" });
		confirmLink.current?.focus({ preventScroll: true });
	}, [status, error]);

	async function run(work: () => Promise<void>) {
		setBusy(true);
		setError("");
		try { await work(); } catch (failure) { setError(explain(failure)); } finally { setBusy(false); }
	}
	if (status?.state === "off") return null;
	const api = client.user(auth);
	const repository = repositories?.find(repo => String(repo.id) === repositoryId);
	return <section ref={card} className="usage-section repo-saved" aria-labelledby="settings-slack" data-testid="slack-settings">
		<h3 className="usage-title" id="settings-slack">Slack
			{status?.state === "disconnected" && <button type="button" className="link secret-add" disabled={busy} onClick={() => void run(async () => {
				location.assign((await api.slackConnect({ origin: location.origin })).url);
			})}>Connect Slack…</button>}
			{status?.state === "connected" && <button type="button" className="link secret-add" disabled={busy} onClick={() => {
				if (confirm("Disconnect Slack and remove all its channel mappings? Items already filed stay.")) void run(async () => setStatus(await api.disconnectSlack()));
			}}>Disconnect…</button>}
		</h3>
		<p className="usage-lede">File work items with <code>/windlass</code> or by mentioning Windlass in a mapped channel.</p>
		{!status && !error && <p aria-busy="true">Loading Slack…</p>}
		{status && <h4 className="usage-title">Workspace</h4>}
		{status?.state === "disconnected" && <p className="field-note">No workspace connected.</p>}
		{status?.state === "connected" && <>
			<p className="field-note">Connected to {status.connection.workspace.name}. Invite the bot to a channel, then map its Slack channel ID to a repository.</p>
			<ul className="settings-list" aria-label="Mapped channels">{status.mappings.map(mapping => <li key={mapping.channel.id} className="usage-kept-row">
				<div className="usage-kept-main"><span className="usage-kept-title">#{mapping.channel.name}</span><p className="agent-meta">{mapping.repository.owner}/{mapping.repository.name}</p></div>
				<button type="button" className="button button-outline button-small" disabled={busy} aria-label={`Change mapping for ${mapping.channel.name}`} onClick={() => {
					setChannel(mapping.channel.id);
					setRepositoryId(String(mapping.repository.id));
					repoSelect.current?.focus();
				}}>Change…</button>
				<button type="button" className="button button-outline button-small" disabled={busy} aria-label={`Remove mapping for ${mapping.channel.name}`} onClick={() => void run(async () => setStatus(await api.removeSlackMapping(mapping.channel.id)))}>Remove</button>
			</li>)}</ul>
			{repoProblem && <p role="alert">{repoProblem}</p>}
			{(!platform.info?.github || repositories?.length === 0) && <p className="field-note">A GitHub repository you can push to is needed to map a channel.</p>}
			<form className="linear-map" onSubmit={event => {
				event.preventDefault();
				if (repository && channel.trim()) void run(async () => {
					setStatus(await api.saveSlackMapping({ channelId: channel.trim(), repositoryId: repository.id }));
					setChannel(""); setRepositoryId("");
				});
			}}>
				<input aria-label="Slack channel ID" className="input" placeholder="Channel ID" value={channel} onChange={event => setChannel(event.target.value)} disabled={busy} />
				<select ref={repoSelect} aria-label="Repository" className="select" value={repositoryId} onChange={event => setRepositoryId(event.target.value)} disabled={busy}>
					<option value="">Choose a repository</option>{repositories?.map(repo => <option value={repo.id} key={repo.id}>{repo.owner}/{repo.name}</option>)}
				</select>
				<button className="button button-outline" disabled={!repository || !channel.trim() || busy}>Map channel</button>
			</form>
		</>}
		{status && <>
			<h4 className="usage-title">Your Slack account</h4>
			{status.links.length === 0 && <p className="field-note">Not linked. To file work as this account, open the private, one-time link Windlass sends you in Slack.</p>}
			<ul className="settings-list" aria-label="Linked Slack identities">{status.links.map(link => <li className="usage-kept-row" key={link.teamId}>
				<div className="usage-kept-main"><span className="usage-kept-title">{link.userId}</span><p className="agent-meta">Workspace {link.teamId}</p></div>
				<span />
				<button type="button" className="button button-outline button-small" aria-label={`Unlink Slack identity in ${link.teamId}`} disabled={busy} onClick={() => void run(async () => setStatus(await api.unlinkSlack(link.teamId)))}>Unlink</button>
			</li>)}</ul>
			{proof && <button ref={confirmLink} type="button" className="button button-outline" disabled={busy} onClick={() => {
				const ticket = proof; setProof("");
				void run(async () => setStatus(await api.linkSlack(ticket)));
			}}>Link Slack identity</button>}
		</>}
		{error && <p className="callout callout-warn" role="alert">{error}</p>}
	</section>;
}
