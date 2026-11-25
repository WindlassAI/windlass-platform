import { useEffect, useRef, useState } from "react";
import { readinessCriteria, readinessItem, readinessLevels, type CriterionId } from "../../../server/src/factory/readiness";
import { ListHeader } from "./WorkspaceFilters";
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
	const reload = page.reload;
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	useEffect(() => {
		if (!data?.running) return;
		const timer = window.setInterval(reload, 5000);
		return () => window.clearInterval(timer);
	}, [data?.running, reload]);
	async function run() {
		setBusy("run");
		setError("");
		try {
			const next = await client.user(auth).runReadiness(page.id);
			if (mounted.current) page.replace(next);
		}
		catch (err) { setError(explain(err)); }
		finally { setBusy(null); }
	}
	async function weekly(enabled: boolean) {
		setBusy("weekly");
		setError("");
		try { await client.user(auth).setSetupWeekly(page.id, enabled); if (mounted.current) reload(); }
		catch (err) { setError(explain(err)); }
		finally { setBusy(null); }
	}
	async function file(id: CriterionId) {
		if (!report) return;
		setBusy(id);
		setError("");
		try {
			const item = await client.user(auth).createItem(readinessItem(page.id, report, id));
			setFiled(old => ({ ...old, [report.at + id]: item.id }));
		} catch (err) { setError(explain(err)); }
		finally { setBusy(null); }
	}
	if (!data) return null;
	const disabled = !!busy || page.access.state !== "usable";
	const sizes = platform.info?.hostedSizes ?? [];
	const rate = sizes.find(s => s.id === startingSize(sizes, page.view?.defaults.hostedSize, false))?.usdPerHour;
	const cost = rate ? ` Five minutes hosted costs about $${(rate / 12).toFixed(2)} in running time.` : " Hosted runs also use a few minutes of running time.";
	const pending = report?.findings.filter(f => f.pass === null).length ?? 0;
	return <section id="repo-setup" className="usage-section ws-section repo-setup" aria-labelledby="setup-title">
		<header className="ws-list-bar">
			<ListHeader id="setup-title" title="Repo setup" />
			<button className="button button-outline button-small" type="button" disabled={disabled || data.running} onClick={run}>{busy === "run" || data.running ? "Checking…" : "Finish setup"}</button>
		</header>
		<p className="usage-note">One agent turn reads the repository and its latest build results. It uses your normal model allowance.{cost}</p>
		<label className="setup-weekly"><input role="switch" type="checkbox" checked={data.weekly} disabled={!!busy || (!data.weekly && page.access.state !== "usable")} onChange={event => weekly(event.target.checked)} /> Run setup checks weekly</label>
		{report ? <>
			<p className="setup-score"><strong>{report.passed} of {readinessCriteria.length} setup checks passed</strong> · {report.level}{pending > 0 && ` · ${pending} pending`}</p>
			{readinessLevels.map(level => <div className="readiness-group" key={level}>
				<h3>{level}</h3>
				<ul>{readinessCriteria.filter(c => c.level === level).map(c => {
					const row = report.findings.find(f => f.id === c.id)!;
					const item = filed[report.at + c.id];
					return <li key={c.id}>
						<span className={row.pass === false ? "tone-warn" : "tone-dim"}>{row.pass === null ? "Pending" : row.pass ? "Pass" : "Fail"}</span>
						<div><strong>{c.title}</strong><p>{row.reason}</p></div>
						{item ? <a className="link" {...linkProps({ name: "item", id: item })}>Open work item</a> : offersItems && row.pass === false && <button className="link" type="button" disabled={disabled} onClick={() => file(c.id)}>{busy === c.id ? "Filing…" : "File as work item"}</button>}
					</li>;
				})}</ul>
			</div>)}
		</> : <p className="usage-empty">{page.access.state === "usable" ? "Waiting for the default branch checks." : "Connect this repository to see its setup checks."}</p>}
		{(error || data.error) && <p role="alert" className="tone-warn">{error || data.error}</p>}
	</section>;
}
