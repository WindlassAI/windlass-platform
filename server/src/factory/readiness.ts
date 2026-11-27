import { MAX_TITLE_CHARS, type CreateItemInput, type GithubId } from "../contract.js";

import {
	trackRecord,
	type ReadinessLevel,
	type ItemRecord,
	type RevertedPulls,
	type TrackRecord,
} from "./readiness-track.js";
export type { ReadinessLevel } from "./readiness-track.js";

export interface CiHistory {
	revertedPulls?: RevertedPulls;
	at: number;
	branch: string;
	checked: number;
	green: number;
	hasCi: boolean;
	flaky: { name: string; count: number }[];
	reverts: number;
	redMerges: number;
}

export const readinessCriteria = [
	{
		id: "setup",
		title: "Set up a checkout with the saved command",
		repair: "Fix the setup command for a fresh checkout",
	},
	{
		id: "checks",
		title: "Pass all saved checks in five minutes or less",
		repair: "Fix slow or failing repository checks",
	},
	{
		id: "guide",
		title: "Put working setup and check commands in the root guide",
		repair: "Correct the setup and check commands in the root guide",
	},
	{
		id: "areas",
		title: "Give folders with 50 or more source files a guide",
		repair: "Add missing guides to large source folders",
	},
	{
		id: "templates",
		title: "Provide templates for both issues and pull requests",
		repair: "Add missing issue and pull request templates",
	},
	{ id: "size", title: "Keep each source file within 1,500 lines", repair: "Split oversized source files" },
	{ id: "ci", title: "Check proposed changes with a workflow", repair: "Add a workflow to check pull requests" },
	{
		id: "secrets",
		title: "Ignore local .env files and scan the repository for secrets",
		repair: "Fix secret scanning and local environment file exclusions",
	},
] as const;
export type CriterionId = (typeof readinessCriteria)[number]["id"];
export interface Finding {
	id: CriterionId;
	pass: boolean | null;
	reason: string;
}
export interface Judgment {
	findings: Finding[];
}
export interface SetupReport {
	record: TrackRecord;
	at: number;
	level: ReadinessLevel;
	ci: CiHistory | null;
	passed: number;
	findings: Finding[];
}
export interface RepositoryReadiness {
	builds?: { passed: number; total: number; setupPassed: number };
	switchNote?: string;
	ciReadFailed?: boolean;
	latest: SetupReport | null;
	run: "new" | "running" | "finished";
	weekly: boolean;
	error: string | null;
	diagnosis?: import("../repo-setup/types.js").SetupDiagnosis;
}

export function setupReport(
	findings: Finding[],
	at: number,
	ci: CiHistory | null,
	items: ItemRecord[] = [],
): SetupReport {
	const proven = (id: CriterionId) => findings.some(f => f.id === id && f.pass);
	const record = trackRecord(items, ci?.revertedPulls);
	// CI history is shown, not a gate: each item reads CI on its own change and the record counts only CI-passed work.
	const ready = proven("setup") && proven("checks");
	const level = ready ? record.level : "Not ready";
	if (!ready) {
		record.earned = {};
		record.progress = "Finish setup to reach Ask first.";
	}
	return { at, level, ci, record, passed: findings.filter(row => row.pass).length, findings };
}

export function readinessItem(id: GithubId, report: SetupReport, criterion: CriterionId | number): CreateItemInput {
	if (typeof criterion === "number") {
		const ci = report.ci;
		const job = ci?.flaky[criterion];
		if (!ci || !job) throw new Error("Choose a flaky job.");
		const title = `Fix intermittent failures in ${job.name}`;
		return {
			repository: { id },
			title: title.slice(0, MAX_TITLE_CHARS),
			body: `${job.name} failed and then passed on the same commit ${job.count} ${job.count === 1 ? "time" : "times"} in 30 days.`,
			idempotencyKey: `setup-${id}-${ci.at}-job-${criterion}`,
		};
	}
	const finding = report.findings.find(row => row.id === criterion && row.pass === false);
	const rule = readinessCriteria.find(row => row.id === criterion);
	if (!finding || !rule) throw new Error("Choose a failed check.");
	return {
		repository: { id },
		title: rule.repair,
		body: rule.title + "\n\n" + finding.reason,
		idempotencyKey: `setup-${id}-${report.at}-${criterion}`,
	};
}

export function plannerReadiness(level: ReadinessLevel | null): string {
	if (!level) return "";
	const smaller = level === "Not ready" || level === "Ask first";
	return `\nRepo setup level: ${level}.${smaller ? " Plan smaller, independently checkable parts." : ""}`;
}
