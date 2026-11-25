import { useEffect, useRef, useState } from "react";
import { readinessCriteria, readinessItem, readinessLevels, type CriterionId } from "../../../server/src/factory/readiness";
import { plural } from "../lib/format";
import { startingSize } from "../lib/sizes";
import { linkProps } from "../lib/router";
import type { RepositoryPage } from "../screens/Repository";
import { useApp, useAuth } from "../state/app";

export function RepositorySetupChecks({ page, offersItems }: { page: RepositoryPage; offersItems: boolean }) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<"run" | "notes" | "weekly" | "guides" | CriterionId | null>(null);
	const [error, setError] = useState("");
	const [filed, setFiled] = useState<Record<string, string>>({});
	const data = page.view?.readiness;
	const [paste, setPaste] = useState("");
	const [excluded, setExcluded] = useState<string[]>([]);
	const [answers, setAnswers] = useState<Record<string, "" | "keep" | "drop">>({});
	const upload = useRef<HTMLInputElement>(null);
	const { notes = [], publication } = page.view?.knowledge ?? {};
	const check = page.view?.guideCheck;
	const questions = notes.filter(n => n.decision?.question);
	const selected = notes.filter(n => !excluded.includes(n.id)).map(n => n.id);
	const selectedAnswers: Record<string, "keep" | "drop"> = {};
	for (const { id } of questions) {
		const answer = answers[id];
		if (answer && selected.includes(id)) selectedAnswers[id] = answer;
	}
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
	const cost = rate ? ` (about $${(rate * 26 / 60).toFixed(2)} in running time)` : "";
	const pending = report?.findings.filter(f => f.pass === null).length ?? 0;
	const score = report && <p className="setup-score"><strong>{report.passed} of {readinessCriteria.length} setup checks passed</strong> · Level: {report.level}{pending > 0 && ` · ${pending} pending`}</p>;
	return <section id="repo-setup" className="usage-section ws-section repo-setup" aria-labelledby="setup-title">
		<header className="ws-list-head">
			<h2 id="setup-title" className="ws-section-title">Repo setup</h2>
			<button className="button button-outline button-small" type="button" disabled={disabled || running} onClick={() => submit("run", async () => {
				const next = await client.user(auth).runReadiness(page.id, selected);
				if (mounted.current) page.replace(next);
			})}>{checking ? "Checking…" : data.run === "finished" ? "Run again" : "Finish setup"}</button>
		</header>
		<p className="usage-note">Draft contributor guides and skills from the repository and its latest build. A second reviewer checks the files before the pull request opens.</p>
		<p className="usage-note">Allow up to 26 hosted minutes{cost}, or use your machine for no hosted minutes. Both use your model allowance.</p>
		{check && <label className="check setup-weekly"><input role="switch" type="checkbox" checked={check.enabled} disabled={disabled} onChange={e => submit("guides", async () =>
			page.replace(await client.user(auth).setGuideCheck(page.id, e.target.checked)))} /> Check pull requests for broken guide references</label>}
		{publication && <div className="setup-result">
			<a className="link" href={publication.pull.url} target="_blank" rel="noreferrer">Review guide changes in pull request #{publication.pull.number}</a>
			<p>{publication.files.join(" · ")} · {publication.pull.state}</p>
			{check?.result && <p><a className="link" href={check.result.url} target="_blank" rel="noreferrer">windlass/guides</a> · {check.result.conclusion === "failure" ? "Failed" : "Passed"} · {check.result.title}</p>}
			{questions.map(n => {
				const text = n.text.trim().replace(/\s+/g, " ");
				return <label key={n.id}><strong>“{text.slice(0, 60)}{text.length > 60 && "…"}”</strong> {n.decision?.question} <select value={answers[n.id] ?? ""} onChange={e =>
					setAnswers({ ...answers, [n.id]: e.target.value as "" | "keep" | "drop" })}><option value="">Leave out for now</option><option value="keep">Keep if verified</option><option value="drop">Drop</option></select></label>;
			})}
			{questions.length > 0 && <button className="button button-outline button-small" disabled={disabled || checking || !Object.keys(selectedAnswers).length} onClick={() => submit("run", async () => {
				page.replace(await client.user(auth).runReadiness(page.id, selected, selectedAnswers));
				setAnswers({});
			})}>Apply answers</button>}
		</div>}
		{publication && score}
		<details className="setup-notes" open={!notes.length}>
			<summary><strong>Notes from your agents{notes.length > 0 && ` (${notes.length})`}</strong></summary>
			<div className="setup-note-fields">
				<textarea aria-label="Add a note" id="setup-note" rows={3} value={paste} placeholder="Paste repository notes…" onChange={e => setPaste(e.target.value)} />
				<div className="setup-actions">
					<button className="button button-outline button-small" disabled={disabled || !paste.trim()} onClick={() => submit("notes", async () => {
						if (new Blob([paste]).size > 262144) throw Error("Use up to 256 KB of notes.");
						page.replace(await client.user(auth).addSetupNotes(page.id, [{ label: "Pasted note.md", text: paste }]));
						setPaste("");
					})}>Add note</button>
					<button className="link" disabled={disabled} onClick={() => upload.current?.click()}>Upload files</button>
					<input hidden type="file" multiple accept=".md,.mdc" aria-label="Upload Markdown notes" ref={upload} onChange={e => {
						const files = Array.from(e.target.files ?? []);
						e.target.value = "";
						if (files.length) void submit("notes", async () => {
							if (files.length > 20 || files.reduce((n, f) => n + f.size, 0) > 262144) throw Error("Choose up to 20 Markdown files and 256 KB.");
							page.replace(await client.user(auth).addSetupNotes(page.id, await Promise.all(files.map(async f => ({ label: f.name, text: await f.text() })))));
						});
					}} />
				</div>
				<p className="usage-note">Only you can see saved notes. They are deleted after 30 days or when their pull request closes.</p>
				{notes.map(n => {
					const decision = n.decision;
					const lines = new Set(decision?.uses.map(u => u.path + ":" + u.line)).size;
					const details = [];
					if (lines) details.push(plural(lines, "line") + " used");
					if (decision?.question) details.push("1 question");
					if (decision && !details.length) details.push("Left out: " + (decision.verdict === "question" ? "needs an answer" : decision.verdict));
					return <div className="setup-note-row" key={n.id}>
						<label className="check"><input type="checkbox" checked={!excluded.includes(n.id)} onChange={e => setExcluded(e.target.checked ? excluded.filter(id => id !== n.id) : [...excluded, n.id])} />{n.label}</label>
						<button className="link" disabled={!!busy} onClick={() => submit("notes", async () => page.replace(await client.user(auth).deleteSetupNote(page.id, n.id)))}>Delete</button>
						<details><summary>{details.join(" · ") || "View note"}</summary><p>{n.text}</p>
							{decision && <><p>{decision.reason} {decision.verdict === "secret" && "Replace this secret."}</p>
								{decision.question && <p>{decision.question}</p>}
								{decision.uses.map((u,i) => <p key={i}>{u.path}:{u.line} · {u.evidence}</p>)}</>}
						</details>
					</div>;
				})}
			</div>
		</details>
		<label className="check setup-weekly"><input role="switch" type="checkbox" checked={data.weekly} disabled={!!busy || (!data.weekly && page.access.state !== "usable")} onChange={event => submit("weekly", async () => {
			await client.user(auth).setSetupWeekly(page.id, event.target.checked);
			if (mounted.current) reload();
		})} /> Run setup checks weekly</label>
		{report ? <>
			{!publication && score}
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
