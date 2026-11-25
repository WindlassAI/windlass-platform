import { useEffect, useRef, useState } from "react";
import { readinessCriteria, readinessItem, readinessLevels, type CriterionId } from "../../../server/src/factory/readiness";
import { startingSize } from "../lib/sizes";
import { linkProps } from "../lib/router";
import type { RepositoryPage } from "../screens/Repository";
import { useApp, useAuth } from "../state/app";

export function RepositorySetupChecks({ page, offersItems }: { page: RepositoryPage; offersItems: boolean }) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<"run" | "weekly" | CriterionId | null>(null);
	const [error, setError] = useState("");
	const [filed, setFiled] = useState<Record<string, string>>({});
	const data = page.view?.readiness;
	const report = data?.latest;
	const running = data?.run === "running";
	const reload = page.reload;
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(reload, 5000);
		return () => window.clearInterval(timer);
	}, [running, reload]);
	async function submit(action: NonNullable<typeof busy>, work: () => Promise<void>) {
		setBusy(action);
		setError("");
		try { await work(); }
		catch (err) { setError(explain(err)); }
		finally { setBusy(null); }
	}
	if (!data) return null;
	const disabled = !!busy || page.access.state !== "usable";
	const checking = busy === "run" || running;
	const sizes = platform.info?.hostedSizes ?? [];
	const rate = sizes.find(s => s.id === startingSize(sizes, page.view?.defaults.hostedSize, false))?.usdPerHour;
	const cost = rate ? ` Five minutes hosted costs about $${(rate / 12).toFixed(2)} in running time.` : " Hosted runs also use a few minutes of running time.";
	const pending = report?.findings.filter(f => f.pass === null).length ?? 0;
	return <section id="repo-setup" className="usage-section ws-section repo-setup" aria-labelledby="setup-title">
		<header className="ws-list-head">
			<h2 id="setup-title" className="ws-section-title">Repo setup</h2>
			<button className="button button-outline button-small" type="button" disabled={disabled || running} onClick={() => submit("run", async () => {
				const next = await client.user(auth).runReadiness(page.id);
				if (mounted.current) page.replace(next);
			})}>{checking ? "Checking…" : data.run === "finished" ? "Run again" : "Finish setup"}</button>
		</header>
		<p className="usage-note">One agent turn reads the repository and its latest build results. It uses your normal model allowance.{cost}</p>
		<label className="check setup-weekly"><input role="switch" type="checkbox" checked={data.weekly} disabled={!!busy || (!data.weekly && page.access.state !== "usable")} onChange={event => submit("weekly", async () => {
			await client.user(auth).setSetupWeekly(page.id, event.target.checked);
			if (mounted.current) reload();
		})} /> Run setup checks weekly</label>
		{report ? <>
			<p className="setup-score"><strong>{report.passed} of {readinessCriteria.length} setup checks passed</strong> · Level: {report.level}{pending > 0 && ` · ${pending} pending`}</p>
			{readinessLevels.map(level => <div className="readiness-group" key={level}>
				<h3>{level}</h3>
				<ul>{readinessCriteria.filter(c => c.level === level).map(c => {
					const row = report.findings.find(f => f.id === c.id)!;
					const key = report.at + c.id;
					const item = filed[key];
					const canFile = offersItems && row.pass === false && !item;
					return <li key={c.id}>
						<span className={canFile ? "tone-warn" : "tone-dim"}>{row.pass === null ? "Pending" : row.pass ? "Pass" : "Fail"}</span>
						<div><strong>{c.title}</strong><p>{row.reason}</p></div>
						{item ? <a className="link" {...linkProps({ name: "item", id: item })}>Open work item</a> : canFile && <button className="link" type="button" disabled={disabled} onClick={() => submit(c.id, async () => {
							const made = await client.user(auth).createItem(readinessItem(page.id, report, c.id));
							setFiled(old => ({ ...old, [key]: made.id }));
						})}>{busy === c.id ? "Filing…" : "File as work item"}</button>}
					</li>;
				})}</ul>
			</div>)}
		</> : <p className="usage-empty">{page.access.state === "usable" ? "Waiting for the default branch checks." : "Connect this repository to see its setup checks."}</p>}
		{(error || data.error) && <p role="alert" className="usage-note">{error || data.error}</p>}
	</section>;
}
