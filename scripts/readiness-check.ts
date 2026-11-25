import "./check-secret.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { buildProof, claimAssessment, finishAssessment, READINESS_TABLE, repositoryReadiness, scheduleSetup } from "../server/src/actors/user-readiness.js";
import type { EnvironmentBuild } from "../server/src/contract.js";
import { fileReadiness } from "../server/src/factory/readiness-filing.js";
import { plannerReadiness, readinessCriteria, readinessItem, scoreReadiness, type CriterionId, type Judgment } from "../server/src/factory/readiness.js";
import { GithubError, type GithubApp, type Repository } from "../server/src/github/app.js";
import { scanRepoSetup } from "../server/src/github/setup-checks.js";

const now = Date.now();
const answers = (...fail: CriterionId[]) => readinessCriteria.map(({ id }) => ({ id, pass: !fail.includes(id), reason: "Evidence for " + id }));

test("levels require all earlier levels, and only failures can be filed", () => {
	for (const [fails, expected] of [[[], "Standardized"], [["ci"], "Documented"], [["areas"], "Functional"], [["checks"], "not reached yet"]] as const) {
		const report = scoreReadiness(answers(...fails).reverse(), now);
		assert.equal(report.level, expected);
		assert.equal(report.passed, 8 - fails.length);
	}
	const partial = scoreReadiness([{ id: "guide", pass: null, reason: "Pending" }, { id: "areas", pass: false, reason: "Missing guide" }], now);
	assert.throws(() => readinessItem(7, partial, "guide"));
	assert.deepEqual(readinessItem(7, partial, "areas"), readinessItem(7, partial, "areas"));
	assert.match(plannerReadiness("Functional"), /smaller/);
	assert.doesNotMatch(plannerReadiness("Documented"), /smaller/);
	assert.equal(plannerReadiness(null), "");
});

test("server reads default-branch paths and bounded blob contents without an agent", async () => {
	const files = new Map<string, string>([
		["CLAUDE.md", ""], [".github/ISSUE_TEMPLATE/bug.yml", ""], ["docs/pull_request_template.md", ""],
		[".github/workflows/tests.yml", "on: [push, pull_request]\njobs:\n  test:\n    steps:\n      - uses: gacts/gitleaks@v1"],
		[".gitignore", ".env*\n!.env.example"], ["src/long.ts", "x\n".repeat(1501)], ["vendor/large.ts", "x\n".repeat(2000)],
	]);
	for (let i = 1; i < 50; i++) files.set(`src/f${i}.ts`, "x");
	let truncated = false;
	const scanFiles: GithubApp["scanFiles"] = async (_token, _owner, _name, branch, pick) => {
		assert.equal(branch, "trunk");
		const tree = [...files].map(([path, text]) => ({ path, type: "blob", size: text.length }));
		const { paths } = pick(tree, truncated);
		assert.ok(!paths.includes("vendor/large.ts") && !paths.includes("src/f1.ts"));
		return { commit: "a".repeat(40), files: paths.map(path => ({ path, text: files.get(path)! })), incomplete: truncated };
	};
	const scan = async () => Object.fromEntries((await scanRepoSetup({ scanFiles } as GithubApp, "read", { defaultBranch: "trunk" } as Repository)).findings.map(f => [f.id, f.pass]));
	assert.deepEqual(await scan(), { guide: null, areas: false, templates: true, size: false, ci: true, secrets: true });
	files.set("src/AGENTS.md", ""); files.set("src/long.ts", "x\n".repeat(1500));
	files.set(".gitignore", ".env*\n!.env.local"); files.delete("CLAUDE.md");
	files.set(".github/workflows/tests.yml", "on: push\n# pull_request\njobs: {}");
	files.delete(".github/ISSUE_TEMPLATE/bug.yml"); files.set(".github/ISSUE_TEMPLATE/config.yml", "");
	assert.deepEqual(await scan(), { guide: false, areas: true, templates: false, size: true, ci: false, secrets: false });
	truncated = true;
	assert.equal((await scan()).size, null);
	const empty = await scanRepoSetup({ scanFiles: async () => { throw new GithubError(409, "Git Repository is empty.", "read"); } } as unknown as GithubApp, "read", { defaultBranch: "trunk" } as Repository);
	assert.equal(empty.commit, null);
	assert.equal(empty.findings.find(f => f.id === "guide")?.pass, false);
});

test("only the three judgments may be filed, with short redacted reasons", () => {
	const rows = answers().slice(0, 3);
	const redact = { text: (s: string) => s.replaceAll("my-token", "[redacted]") };
	const args = (findings: unknown) => ({ title: "Repo setup", description: JSON.stringify({ findings }) });
	for (const invalid of [answers(), rows.slice(1), [...rows.slice(1), rows[1]], [{ ...rows[0], reason: "two\nlines" }, ...rows.slice(1)]])
		assert.match(fileReadiness(args(invalid), redact, () => assert.fail("accepted invalid report")), /three requested|one-line reason/);
	let result: Judgment | undefined;
	rows[0]!.reason = "my-token";
	fileReadiness(args(rows), redact, report => { result = report; });
	assert.equal(result?.findings[0]?.reason, "[redacted]");
});

test("measured evidence requires every saved check and includes exactly five minutes", () => {
	const checks = [{ name: "test", command: "test" }];
	const build = { commit: "abc", failure: null, checks: [{ name: "test", status: "passed", durationMs: 300_000 }] } as EnvironmentBuild;
	assert.equal(buildProof(build, checks).checksPassed, true);
	build.checks[0]!.durationMs++;
	assert.equal(buildProof(build, checks).checksPassed, false);
	assert.equal(buildProof(build, [...checks, { name: "types", command: "types" }]).checksPassed, false);
	assert.equal(buildProof(undefined, checks).setupPassed, false);
});

test("weekly runs require opting in and share the manual claim", async () => {
	const jobs = new Set<string>();
	const cron = { set: async (job: { name: string }) => { jobs.add(job.name); }, delete: async (key: string) => jobs.delete(key) };
	assert.equal(jobs.size, 0);
	await scheduleSetup(cron, 7, true); assert.equal(jobs.size, 1);
	await scheduleSetup(cron, 7, false); assert.equal(jobs.size, 0);
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(READINESS_TABLE);
	const db = { execute: async (q: string, ...args: SQLInputValue[]) => sqlite.prepare(q).all(...args) } as Parameters<typeof claimAssessment>[0];
	assert.equal(await claimAssessment(db, "repo", "scheduled", now), true);
	assert.equal(await claimAssessment(db, "repo", "manual", now), false);
	const inputs = { key: "base", at: now, evidence: { hasSavedSetup: true, savedChecks: ["test"], buildCommit: null, ...buildProof(undefined, []) },
		findings: answers("areas").map(f => ({ ...f, pass: ["setup", "checks", "guide"].includes(f.id) ? null : f.pass })) };
	await db.execute("UPDATE readiness SET inputs='base'");
	const view = () => repositoryReadiness(db, "repo", inputs, false);
	assert.equal((await view()).run, "running");
	await finishAssessment(db, "scheduled", { findings: answers().slice(0, 3) });
	const result = (await view()).latest!;
	assert.equal(result.passed, 5);
	assert.equal(result.findings.find(f => f.id === "checks")?.pass, false);
	inputs.key = "new settings";
	assert.equal((await view()).latest?.findings[0]?.pass, null);
	assert.equal(await claimAssessment(db, "repo", "scheduled", now), false);
	assert.equal(await claimAssessment(db, "repo", "manual", now + 1), true);
	await finishAssessment(db, "manual", "Could not read repository.");
	assert.equal((await view()).error, "Could not read repository.");
	sqlite.close();
});
