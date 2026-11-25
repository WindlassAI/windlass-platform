import type { ActorCron } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { config } from "../config.js";
import type { EnvironmentBuild, GithubId, RepositoryCheck } from "../contract.js";
import { environmentInputs, readEnvironments, sameInputs } from "../environments.js";
import { scoreReadiness, type Finding, type Judgment, type RepositoryReadiness } from "../factory/readiness.js";
import type { SetupDiagnosis } from "../repo-setup/types.js";
import type { SetupScan } from "../github/setup-checks.js";
import { digest } from "../sandbox/snapshot-key.js";

type Db = Pick<RawAccess, "execute">;
export const READINESS_TICK = "internalReadinessTick";
export const scheduleName = (id: GithubId) => "repo-setup-" + id;
export async function scheduleSetup(cron: Pick<ActorCron, "set" | "delete">, id: GithubId, enabled: boolean) {
	const name = scheduleName(id);
	if (!enabled) return cron.delete(name);
	const minute = Number(BigInt(id) % 10080n);
	await cron.set({ name, expression: `${minute % 60} ${Math.floor(minute / 60) % 24} * * ${Math.floor(minute / 1440)}`, action: READINESS_TICK, args: [id], maxHistory: 0 });
}

export const READINESS_TABLE = `CREATE TABLE IF NOT EXISTS readiness (
	project TEXT NOT NULL, session TEXT PRIMARY KEY, at INTEGER NOT NULL, inputs TEXT, judgment TEXT, error TEXT, diagnosis TEXT)`;
export const SETUP_TURN_MS = Math.min(config.turnTimeoutMs, 20 * 60_000);
export const SETUP_LEASE_MS = SETUP_TURN_MS + 6 * 60_000;

export async function cachedScan(db: Db, project: string) {
	const [row] = await db.execute<{ at: number; scan: string }>("SELECT at, scan FROM setup_scan WHERE project=?", project);
	return row && { at: row.at, ...JSON.parse(row.scan) as SetupScan };
}

export function buildProof(build: EnvironmentBuild | undefined, checks: RepositoryCheck[]) {
	const results = build?.checks ?? [];
	const durationMs = results.reduce((total, check) => total + check.durationMs, 0);
	return {
		setupPassed: !!build && build.failure?.kind !== "setup" && build.failure?.kind !== "clone" && !!build.commit,
		checksPassed: checks.length > 0 && results.length === checks.length && checks.every(c => results.some(r => r.name === c.name && r.status === "passed")) && durationMs <= 300_000,
		durationMs, measured: results.map(({ name, status, durationMs }) => ({ name, status, durationMs })),
	};
}

export async function setupInputs(db: Db, project: string, scan: SetupScan & { at: number }, setup: string, checks: RepositoryCheck[]) {
	const hashes = environmentInputs(setup, checks);
	const measured = (await readEnvironments(db, project)).flatMap(row => [row.attempt, row.ready])
		.filter((b): b is EnvironmentBuild => !!b?.finishedAt && sameInputs(b, hashes))
		.sort((a, b) => b.finishedAt! - a.finishedAt!).at(0);
	const evidence = { hasSavedSetup: !!setup, savedChecks: checks.map(c => c.name), buildCommit: measured?.commit ?? null, ...buildProof(measured, checks) };
	const findings: Finding[] = [
		{ id: "setup", pass: setup ? null : false, reason: setup ? "Setup command saved. Finish setup to check that it works." : "No setup command is saved." },
		{ id: "checks", pass: checks.length ? null : false, reason: checks.length ? "Checks saved. Finish setup to check their results and time." : "No checks are saved." },
		...scan.findings,
	];
	return { key: digest([scan.commit, hashes, evidence]), findings, evidence, at: scan.at };
}

export async function repositoryReadiness(db: Db, project: string, inputs: Awaited<ReturnType<typeof setupInputs>> | null, weekly: boolean, scanError: string | null = null): Promise<RepositoryReadiness> {
	const [attempt] = await db.execute<{ judgment: string | null; error: string | null; diagnosis: string | null; at: number }>("SELECT judgment,error,diagnosis,at FROM readiness WHERE project=? ORDER BY at DESC, rowid DESC LIMIT 1", project);
	const pending = !!attempt && !attempt.judgment && !attempt.error;
	const running = pending && Date.now() - attempt.at < SETUP_LEASE_MS;
	let latest = null;
	if (inputs) {
		const [last] = await db.execute<{ judgment: string; at: number }>("SELECT judgment,at FROM readiness WHERE project=? AND inputs=? AND judgment IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1", project, inputs.key);
		const result: Judgment | undefined = last && JSON.parse(last.judgment);
		const findings = inputs.findings.map(f => {
			const answer = result?.findings.find(r => r.id === f.id);
			if (f.pass !== null || !answer) return f;
			if (f.id === "setup" && !inputs.evidence.setupPassed) return { ...f, pass: false, reason: "No matching build shows that setup completed." };
			if (f.id === "checks" && !inputs.evidence.checksPassed) return { ...f, pass: false, reason: "No matching build passed all saved checks within five minutes." };
			return answer;
		});
		latest = scoreReadiness(findings, last?.at ?? inputs.at);
	}
	return { latest, weekly, ...(attempt?.diagnosis && { diagnosis: JSON.parse(attempt.diagnosis) as SetupDiagnosis }), run: running ? "running" : attempt ? "finished" : "new", error: scanError ?? (pending && !running ? "The setup check was interrupted." : attempt?.error ?? null) };
}

export async function claimAssessment(db: Db, project: string, session: string, now: number): Promise<boolean> {
	const rows = await db.execute(`INSERT OR IGNORE INTO readiness(project,session,at) SELECT ?,?,?
		WHERE NOT EXISTS (SELECT 1 FROM readiness WHERE project=? AND judgment IS NULL AND error IS NULL AND at>?) RETURNING session`,
		project, session, now, project, now - SETUP_LEASE_MS);
	return rows.length > 0;
}

export async function finishAssessment(db: Db, session: string, result: Judgment | string, diagnosis?: SetupDiagnosis | null) {
	await db.execute("UPDATE readiness SET judgment=?,error=?,diagnosis=? WHERE session=? AND judgment IS NULL AND error IS NULL",
		typeof result === "string" ? null : JSON.stringify(result), typeof result === "string" ? result : null, diagnosis ? JSON.stringify(diagnosis) : null, session);
}
