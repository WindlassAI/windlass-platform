import type { CreateItemInput, GithubId } from "../contract.js";

export const readinessLevels = ["Functional", "Documented", "Standardized"] as const;
export type ReadinessLevel = "not reached yet" | typeof readinessLevels[number];

export const readinessCriteria = [
	{ id: "setup", level: "Functional", title: "Set up with one command" },
	{ id: "checks", level: "Functional", title: "Saved checks pass within five minutes" },
	{ id: "guide", level: "Documented", title: "Accurate instructions for agents" },
	{ id: "areas", level: "Documented", title: "Guides for large folders" },
	{ id: "templates", level: "Documented", title: "Pull request and issue templates" },
	{ id: "size", level: "Standardized", title: "Source files at most 1,500 lines" },
	{ id: "ci", level: "Standardized", title: "Automatic checks on pull requests" },
	{ id: "secrets", level: "Standardized", title: "Scan for secrets and ignore environment files" },
] as const;
export type CriterionId = typeof readinessCriteria[number]["id"];
export interface Finding { id: CriterionId; pass: boolean | null; reason: string }
export interface Judgment { findings: Finding[] }
export interface ReadinessReport { at: number; level: ReadinessLevel; passed: number; findings: Finding[] }
export interface RepositoryReadiness { latest: ReadinessReport | null; run: "new" | "running" | "finished"; weekly: boolean; error: string | null; diagnosis?: import("../repo-setup/types.js").SetupDiagnosis }

export function scoreReadiness(findings: Finding[], at: number): ReadinessReport {
	let level: ReadinessLevel = "not reached yet";
	for (const name of readinessLevels) {
		const group = readinessCriteria.filter(c => c.level === name);
		if (group.filter(c => findings.some(f => f.id === c.id && f.pass)).length < group.length * 0.8) break;
		level = name;
	}
	return { at, level, passed: findings.filter(row => row.pass).length, findings };
}

export function readinessItem(id: GithubId, report: ReadinessReport, criterion: CriterionId): CreateItemInput {
	const finding = report.findings.find(row => row.id === criterion && row.pass === false);
	const rule = readinessCriteria.find(row => row.id === criterion);
	if (!finding || !rule) throw new Error("Choose a failed check.");
	return { repository: { id }, title: rule.title, body: rule.title + "\n\n" + finding.reason,
		useDefaultPlace: true, idempotencyKey: `setup-${id}-${report.at}-${criterion}` };
}

export function plannerReadiness(level: ReadinessLevel | null): string {
	if (!level) return "";
	const smaller = level === "not reached yet" || level === "Functional";
	return `\nRepo setup level: ${level}.${smaller ? " Plan smaller, independently checkable parts." : ""}`;
}
