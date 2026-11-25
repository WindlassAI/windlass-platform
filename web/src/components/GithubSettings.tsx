/**
 * Settings: the GitHub connection. Who connected, the accounts the app is installed on (each with the way to
 * choose its repositories at GitHub), and the ways to add an account or disconnect.
 */
import { useEffect } from "react";
import { useGithub, type GithubNotice } from "../state/github";
import { ExternalIcon, WarnIcon } from "./Icons";

/** Notices said here already: the account menu does not open to say them again. */
export const shownInSettings = new WeakSet<GithubNotice>();

export function GithubSettings() {
	const github = useGithub();
	const { dismiss } = github;
	const notice = github.notice?.where === "account" ? github.notice : null;
	useEffect(() => {
		if (notice) shownInSettings.add(notice);
	}, [notice]);
	// Leaving Settings puts it away.
	useEffect(() => dismiss, [dismiss]);
	if (!github.enabled) return null;
	const connection = github.status?.connection ?? null;
	const busy = github.busy !== null;
	const opening = github.busy === "leaving" ? "Opening GitHub…" : github.busy === "popup" ? "In the GitHub window…" : null;
	return (
		<section className="usage-section repo-saved" id="settings-github" aria-labelledby="settings-github-title">
			<h3 className="usage-title" id="settings-github-title">
				GitHub
				{connection ? (
					<span className="gh-settings-actions">
						<button type="button" className="link secret-add" onClick={() => github.connect({ where: "account", install: true })} disabled={busy && github.busy !== "popup"}>
							{opening ?? "Add an account"}
						</button>
						<button type="button" className="link secret-add" onClick={() => void github.disconnect()} disabled={busy}>
							{github.busy === "disconnecting" ? "Disconnecting…" : "Disconnect…"}
						</button>
					</span>
				) : github.status !== null && !github.error ? (
					<button type="button" className="link secret-add" onClick={() => github.connect({ where: "account" })} disabled={busy && github.busy !== "popup"}>
						{opening ?? "Connect GitHub…"}
					</button>
				) : null}
			</h3>
			<p className="usage-lede">
				{connection ? (
					<>
						Connected as <strong>{connection.login}</strong>. Agents work on the repositories the app may see in these accounts.
					</>
				) : (
					"Launch agents on your own repositories, private ones included, and get their work back as pull requests."
				)}
			</p>
			{notice ? (
				<p className={`callout${notice.tone === "bad" ? " callout-warn" : ""}`} role={notice.tone === "bad" ? "alert" : "status"}>
					{notice.tone === "bad" ? <WarnIcon /> : null}
					<span>{notice.text}</span>
				</p>
			) : null}
			{github.busy === "finishing" ? (
				<p className="usage-empty" aria-busy="true">
					Finishing the GitHub connection…
				</p>
			) : github.error ? (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>
						{github.error}{" "}
						<button type="button" className="link" onClick={github.reload}>
							Try again
						</button>
					</span>
				</p>
			) : github.status === null ? (
				<div className="usage-loading" aria-busy="true" aria-label="Loading GitHub">
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			) : connection ? (
				<ul className="settings-list" aria-label="GitHub accounts">
					{connection.accounts.map((account) => (
						<li key={account.installationId} className="usage-kept-row">
							<div className="usage-kept-main">
								<span className="usage-kept-title">{account.login}</span>
								<p className="agent-meta">{account.kind === "organization" ? "Organization" : "Personal account"}</p>
							</div>
							<a className="button button-outline button-small" href={account.manageUrl} target="_blank" rel="noreferrer">
								Repositories
								<span className="visually-hidden"> of {account.login}, at GitHub</span>
								<ExternalIcon size={11} />
							</a>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}
