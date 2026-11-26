import { MAX_TITLE_CHARS, type CreateItemInput, type GithubId } from "../contract.js";

import { trackRecord, type ReadinessLevel, type ItemRecord, type RevertedPulls, type TrackRecord } from "./readiness-track.js";
export type { ReadinessLevel } from "./readiness-track.js";
const MIN_GREEN_RATE = 0.8;
const MAX_FLAKES = 3;
export const RECENT_COMMITS = 20;

export interface CiHistory {
	revertedPulls?: RevertedPulls;
	at: number; branch: string; checked: number; green: number; hasCi: boolean;
	/** The newest RECENT_COMMITS finished commits: the Not ready bar, so an old red stretch stops counting once main is green again. */
	recent?: { checked: number; green: number };
	flaky: { name: string; count: number }[]; reverts: number; redMerges: number;
}

export const readinessCriteria = [
	{ id: "setup", title: "Set up a checkout with the saved command" },
	{ id: "checks", title: "Pass all saved checks in five minutes or less" },
	{ id: "guide", title: "Put working setup and check commands in the root guide" },
	{ id: "areas", title: "Give folders with 50 or more source files a guide" },
	{ id: "templates", title: "Provide templates for both issues and pull requests" },
	{ id: "size", title: "Keep each source file within 1,500 lines" },
	{ id: "ci", title: "Check proposed changes with a workflow" },
	{ id: "secrets", title: "Ignore local .env files and scan the repository for secrets" },
] as const;
export type CriterionId = typeof readinessCriteria[number]["id"];
export interface Finding { id: CriterionId; pass: boolean | null; reason: string }
export interface Judgment { findings: Finding[] }
export interface SetupReport { record: TrackRecord; at: number; level: ReadinessLevel; ci: CiHistory | null; passed: number; findings: Finding[] }
export interface RepositoryReadiness { builds?: { passed: number; total: number; setupPassed: number }; switchNote?: string; ciReadFailed?: boolean; latest: SetupReport | null; run: "new" | "running" | "finished"; weekly: boolean; error: string | null; diagnosis?: import("../repo-setup/types.js").SetupDiagnosis }

export function setupReport(findings: Finding[], at: number, ci: CiHistory | null, items: ItemRecord[] = []): SetupReport {
	const proven = (id: CriterionId) => findings.some(f => f.id === id && f.pass);
	const bar = ci?.recent ?? ci;
	const healthy = ci && bar && bar.checked > 0 && bar.green / bar.checked >= MIN_GREEN_RATE && ci.flaky.every(job => job.count <= MAX_FLAKES);
	const record = trackRecord(items, ci?.revertedPulls);
	const level = proven("setup") && proven("checks") && healthy ? record.level : "Not ready";
	if (!proven("setup") || !proven("checks") || !healthy) { record.earned = {}; record.progress = "Finish setup and pass CI to reach Ask first."; }
	return { at, level, ci, record, passed: findings.filter(row => row.pass).length, findings };
}

export function readinessItem(id: GithubId, report: SetupReport, criterion: CriterionId | number): CreateItemInput {
	if (typeof criterion === "number") {
		const ci = report.ci;
		const job = ci?.flaky[criterion];
		if (!ci || !job) throw new Error("Choose a flaky job.");
		const title = `Make ${job.name} reliable`;
		return { repository: { id }, title: title.slice(0, MAX_TITLE_CHARS), body: `${job.name} failed and then passed on the same commit ${job.count} ${job.count === 1 ? "time" : "times"} in 30 days.`,
			useDefaultPlace: true, idempotencyKey: `setup-${id}-${ci.at}-job-${criterion}` };
	}
	const finding = report.findings.find(row => row.id === criterion && row.pass === false);
	const rule = readinessCriteria.find(row => row.id === criterion);
	if (!finding || !rule) throw new Error("Choose a failed check.");
	return { repository: { id }, title: rule.title, body: rule.title + "\n\n" + finding.reason,
		useDefaultPlace: true, idempotencyKey: `setup-${id}-${report.at}-${criterion}` };
}

export function plannerReadiness(level: ReadinessLevel | null): string {
	if (!level) return "";
	const smaller = level === "Not ready" || level === "Ask first";
	return `\nRepo setup level: ${level}.${smaller ? " Plan smaller, independently checkable parts." : ""}`;
}
