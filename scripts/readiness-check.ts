import "./check-secret.js";
import { privateLine, validateDraft } from "../server/src/repo-setup/filing.js";
import { checkGuide, guideTree } from "../server/src/repo-setup/guide-check.js";
import { setupBodies } from "../server/src/repo-setup/publish.js";
import { setupGuide } from "./setup-guide-fixture.js";
import { emptyRow, environmentInputs, ENVIRONMENT_TABLE, writeEnvironment } from "../server/src/environments.js";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { applyOffers, BARS, offered, taskKind, trackRecord, type ItemRecord } from "../server/src/factory/readiness-track.js";
import { buildProof, cachedScan, saveSetupScan, claimAssessment, finishAssessment, READINESS_TABLE, repositoryReadiness, scheduleSetup, setupInputs } from "../server/src/actors/user-readiness.js";
import type { EnvironmentBuild } from "../server/src/contract.js";
import { fileReadiness } from "../server/src/factory/readiness-filing.js";
import { plannerReadiness, readinessCriteria, readinessItem, setupReport, type CiHistory, type CriterionId, type Judgment } from "../server/src/factory/readiness.js";
import { GithubError, GithubApp, type Repository } from "../server/src/github/app.js";
import { scanCiHistory } from "../server/src/github/ci-history.js";
import { scanRepoSetup } from "../server/src/github/setup-checks.js";

const now = Date.now();
const answers = (...fail: CriterionId[]) => readinessCriteria.map(({ id }) => ({ id, pass: !fail.includes(id), reason: "Evidence for " + id }));

const history: CiHistory = { at: now, branch: "trunk", green: 4, checked: 5, flaky: [{ name: "test", count: 3 }], hasCi: true, reverts: 1, redMerges: 1 };

test("working setup and passing CI earn Ask first at both boundaries", () => {
	const report = setupReport(answers("guide", "areas", "templates"), now, history);
	assert.equal(report.level, "Ask first");
	assert.equal(report.passed, 5);
	for (const ci of [null, { ...history, green: 0, checked: 0 }, { ...history, green: 159, checked: 200 }, { ...history, flaky: [{ name: "test", count: 4 }] }])
		assert.equal(setupReport(answers(), now, ci).level, "Not ready");
	for (const id of ["setup", "checks"] as const) assert.equal(setupReport(answers(id), now, history).level, "Not ready");
	const partial = setupReport([{ id: "guide", pass: null, reason: "Pending" }, { id: "areas", pass: false, reason: "Missing guide" }], now, history);
	assert.throws(() => readinessItem(7, partial, "guide"));
	assert.deepEqual(readinessItem(7, partial, "areas"), readinessItem(7, partial, "areas"));
	assert.match(plannerReadiness("Not ready"), /smaller/);
	assert.match(plannerReadiness("Ask first"), /smaller/);
	assert.equal(plannerReadiness(null), "");
});

test("levels, offers and recovery follow finished work in order", () => {
	const clean = (at: number, change: Partial<ItemRecord> = {}): ItemRecord => ({ at, pr: at, kind: "docs-only", clean: true, verified: true,
		feature: false, merged: true, closed: false, failed: false, fixed: false, sentBack: false, flaky: false, ciFix: false, ciPassed: true, ...change });
	const singles = Array.from({ length: BARS.singles }, (_, i) => clean(i + 1));
	const small = trackRecord(singles);
	assert.equal(trackRecord(singles.slice(1)).level, "Ask first");
	assert.deepEqual(offered(small, {}), ["Small plans"]);
	assert.deepEqual(offered(small, { autoApprovePlans: true }), []);
	const features = [6,7,8].map(at => clean(at, { feature: true }));
	assert.equal(trackRecord([...singles.map((r, i) => ({ ...r, kind: i % 2 ? "other" as const : r.kind })), ...features]).level, "Full plans");
	assert.equal(trackRecord([...singles, ...features.slice(1), clean(6, { feature: true, ciFix: true, fixed: true, clean: false })]).level, "Small plans");
	const top = trackRecord([...singles, ...features]);
	assert.equal(top.level, "Earned merge");
	assert.deepEqual(offered(top, { autoApprovePlans: true }), ["docs-only"]);
	const grant = { offer: "docs-only" as const, earned: top.earned["docs-only"]!, off: 0 };
	assert.deepEqual(applyOffers({}, top, [grant]).defaults, { autoMergeSingles: true, mergeKinds: ["docs-only"] });
	const down = trackRecord([...features, ...singles], { 2: 9, 77: 10 });
	assert.equal(down.level, "Full plans");
	assert.equal(down.reverts, 1);
	assert.match(down.note, /#2 was reverted/);
	assert.deepEqual(applyOffers({}, down, [grant]).expired, ["docs-only"]);
	assert.deepEqual(applyOffers({}, down, [grant]).defaults, {});
	assert.deepEqual(applyOffers({ autoMergeSingles: true }, down, []).defaults, { autoMergeSingles: true });
	const misses = [10,11,12].map(at => clean(at, { verified: false, clean: false, failed: true }));
	const lost = trackRecord([...singles, ...misses]);
	assert.equal(lost.level, "Ask first");
	const plan = { offer: "Small plans" as const, earned: small.earned["Small plans"]!, off: 0 };
	const recovered = trackRecord([...singles, ...misses, ...singles.map(r => ({ ...r, at: r.at + 20 }))]);
	assert.deepEqual(applyOffers({}, recovered, [plan]).expired, ["Small plans"]);
	assert.deepEqual(applyOffers({ autoApprovePlans: true }, lost, []).defaults, { autoApprovePlans: true });
	assert.doesNotMatch(plannerReadiness("Full plans"), /smaller/);
});

test("each changed path must belong to the same kind", () => {
	for (const [paths, expected] of [[["docs/setup.md", "README.rst"], "docs-only"], [["tests/a.ts", "src/a.test.ts"], "tests-only"],
		[["pkg/package.json", "yarn.lock"], "dependency bumps"], [["README.md", "app.ts"], "other"], [[], "other"]] as const)
		assert.equal(taskKind([...paths]), expected);
});

test("CI history reads default-branch checks and statuses, merge results and rerun attempts", async () => {
	const app = new GithubApp({ appId: "1", slug: "ci", clientId: "", apiUrl: "https://api.example", webUrl: "" }, { clientSecret: () => null, privateKey: () => null });
	const repo = { owner: "team", name: "repo", defaultBranch: "trunk" } as Repository;
	const since = new Date(now - 30 * 86_400_000).toISOString();
	const revert = { number: 7, title: "Revert the change", baseRefName: "trunk", mergedAt: new Date(now).toISOString(), mergeCommit: { oid: "merge" } };
	const commit = (oid: string, parent: string, state: string | null, message = "", pulls: typeof revert[] = [], parents = 1) => ({
		oid, message, committedDate: new Date(now).toISOString(), parents: { totalCount: parents, nodes: [{ oid: parent }] }, statusCheckRollup: state && { state }, associatedPullRequests: { nodes: pulls },
	});
	const job = (name: string, run_attempt: number, conclusion: string, head_sha = "head") => ({ name, run_attempt, conclusion, head_sha });
	const run = { id: "12", run_attempt: 2, head_sha: "head", head_branch: "work", event: "pull_request" };
	let limited = false;
	app.call = async call => {
		assert.deepEqual(call.auth, { bearer: "install" });
		let body: unknown;
		if (call.path === "/graphql") {
			const { variables, query } = call.body as { variables: { after: string | null; since: string; head: string }; query: string };
			assert.match(query, /statusCheckRollup/);
			assert.deepEqual([variables.head, variables.since], ["head", since]);
			const nodes = variables.after ? [commit("old", "none", "ERROR", "", [{ ...revert, number: 2, title: "bad change", mergeCommit: { oid: "old" } }]), commit("side", "old", "FAILURE", 'Revert "bad change"', [revert])]
				: [commit("head", "merge", "SUCCESS", "Tidy up\n\nThis reverts commit abc."), commit("merge", "pending", "FAILURE", "", [revert], 2), commit("pending", "old", "PENDING")];
			body = { data: { repository: { object: { history: { nodes, pageInfo: { endCursor: "next", hasNextPage: !variables.after } } } } } };
		} else if (call.path.endsWith("/actions/runs")) {
			assert.deepEqual(call.query, { per_page: 100, created: ">=" + since });
			if (limited) throw new GithubError(429, "rate limit", "read runs");
			body = { workflow_runs: [run, { ...run, id: "13", head_branch: "trunk", event: "push" }, { ...run, id: "14", event: "push" }] };
		} else {
			assert.match(call.path, /runs\/(12|13)\/jobs$/);
			assert.equal(call.query?.filter, "all");
			body = { jobs: [job("e2e", 2, "success"), job("e2e", 1, "failure"), job("lint", 1, "failure"), job("lint", 2, "success", "other"), job("build", 1, "success"), job("build", 2, "failure")] };
		}
		return { status: 200, next: false, link: "", body };
	};
	const actual = await scanCiHistory(app, "install", repo, "head", now);
	assert.deepEqual(actual, { ...history, revertedPulls: { 2: now }, green: 1, checked: 3, reverts: 2, redMerges: 2, flaky: [{ name: "e2e", count: 2 }] });
	assert.equal((await scanCiHistory(app, "install", repo, null, now)).hasCi, false);
	limited = true;
	await assert.rejects(scanCiHistory(app, "install", repo, "head", now), GithubError);
});

test("an unreadable CI scan keeps the previous history and its read time", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE setup_scan (project TEXT PRIMARY KEY, at INTEGER, scan TEXT)");
	const db = { execute: async (q: string, ...args: SQLInputValue[]) => sqlite.prepare(q).all(...args) } as Parameters<typeof cachedScan>[0];
	const files = { commit: "head", findings: [], areas: [], later: 0 };
	await saveSetupScan(db, "repo", now, files, history);
	await saveSetupScan(db, "repo", now + 1, files, null);
	assert.deepEqual(await cachedScan(db, "repo"), { ...files, at: now + 1, ciReadFailed: true, ci: history });
	sqlite.close();
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
	const inputs = { builds: { passed: 0, total: 0, setupPassed: 0 }, key: "base", ci: history, ciReadFailed: true, at: now, evidence: { hasSavedSetup: true, savedChecks: ["test"], buildCommit: null, ...buildProof(undefined, []) },
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
	const failed = await view();
	assert.equal(failed.error, "Could not read repository.");
	assert.equal(failed.ciReadFailed, true);
	sqlite.close();
});

test("only verified guide lines get citations, and filenames and reasons stay out of public descriptions", async () => {
	const request = { areas: [], later: 0, noteIds: ["team"], previous: null };
	const ctx = { request, owner: "team", host: "github.com", notes: [{ id: "team", text: "Use the lint script.", label: "local-note.md" }],
		paths: ["README.md", "package.json"], read: new Map([["README.md", "Working here"], ["package.json", '{"scripts":{"lint":"eslint ."}}']]), redact: (s: string) => s.replaceAll("saved-value", "[redacted]") };
	for (const line of ["/home/alice/tmp", "/Users/ada/work", "C:\\Users\\somebody", "a@test.invalid", "10.0.0.2", "(@personal)", "worker.office.example", "https://internal.example", "db.corp", "password=sample-value", "saved-value"])
		assert.equal(privateLine(line, ctx), true);
	const base = { score: answers().slice(0, 3), notes: [{ noteId: "team", verdict: "team", reason: "Found the saved script." }] };
	const file = setupGuide("", "# Guide", "Use `npm run lint`.", "Use `npm run nope`.\nUse `sh unsupported.sh`.\nMissing proof.");
	file.lines[0].evidence.file = "package.json";
	file.lines.push(...[4, 5].map(line => ({ line, noteId: "team", evidence: { file: "package.json", line: 1 } })));
	const validate = (f = file) => validateDraft({ ...base, files: [f] }, ctx);
	const draft = validate();
	assert.doesNotMatch(draft.files.get("AGENTS.md")!, /nope|unsupported|Missing proof/);
	assert.deepEqual(draft.decisions[0]?.uses, [{ path: "AGENTS.md", line: 3, evidence: "package.json:1" }]);
	assert.throws(() => validate({ ...file, path: "../AGENTS.md" }));
	assert.throws(() => validate({ ...file, content: "x".repeat(13 * 1024) }));
	assert.throws(() => validate({ ...file, content: file.content + "saved-value" }));
	assert.throws(() => validateDraft({ ...base, files: [file], notes: [] }, ctx));
	const { body, privateBody } = setupBodies(draft, { ...ctx, repository: { owner: "team", url: "https://github.com/team/project" } as import("../server/src/github/publish.js").StoredRepository });
	assert.match(body, /1 line from 1 imported note/);
	assert.doesNotMatch(body, /local-note|package.json|AGENTS.md:3/);
	assert.match(privateBody!, /AGENTS.md:3 \| local-note.md \| package.json:1/);
});

test("skills and folder guides resolve root paths and explicit file-relative references", () => {
	const scenarios = "packages/core/test/scenarios";
	for (const folder of [".agents/skills/update-step-loop-scenarios", "docs/area"]) {
		const guide = folder + (folder.startsWith(".agents") ? "/SKILL.md" : "/AGENTS.md");
		const paths = [scenarios + "/step.ts", folder + "/x", folder + "/local.ts", "root.ts", folder.slice(0, folder.lastIndexOf("/")) + "/sibling.ts"];
		const tree = guideTree(paths, () => undefined);
		const good = [`Edit \`${scenarios}\`.`, `Look in ${scenarios}.`, "Read `./x` and [steps](packages/core/test/scenarios).",
			"Read [the sibling](../sibling.ts) and `root.ts`."];
		assert.deepEqual(checkGuide(guide, good.join("\n"), tree), []);
		assert.deepEqual(checkGuide(guide, "Read `local.ts` and `./root.ts`.", tree).map(e => e.message),
			["missing path local.ts", "missing path " + folder + "/root.ts"]);
	}
});

test("team note uses Bun script definitions, tracked globs and flags at the cited lines", () => {
	const note = "`bun run test:unit` skips every *.e2e.test.ts file and preloads test/unit-preload.ts; `bun run test:e2e` runs only the e2e files";
	const manifest = JSON.stringify({ scripts: { "test:unit": "bun test --preload ./test/unit-preload.ts --path-ignore-patterns='**/*.e2e.test.ts'",
		"test:e2e": "bun test .e2e.test.ts" } }, null, 2);
	const paths = ["package.json", "README.md", "test/nested/step.e2e.test.ts", "test/unit-preload.ts"];
	const ctx = { request: { areas: [], later: 0, noteIds: ["team"], previous: null }, owner: "team", host: "github.com",
		notes: [{ id: "team", text: note, label: "team.md" }], paths,
		read: new Map([["package.json", manifest], ["README.md", "Use the flag --preload"]]), redact: (s: string) => s };
	const validate = (line: string, citations: number[], file = "package.json") => {
		const guide = setupGuide("", "# Guide", "A fixture is a test input.", line);
		guide.lines[0].noteId = undefined;
		guide.lines.push(...citations.map(n => ({ line: 4, noteId: "team", evidence: { file, line: n } })));
		return validateDraft({ score: answers().slice(0, 3), notes: [{ noteId: "team", verdict: "team", reason: "Checked the scripts." }], files: [guide] }, ctx);
	};
	const accepted = validate(note, [3, 4]);
	assert.ok(accepted.files.get("AGENTS.md")!.includes(note));
	assert.equal(accepted.decisions[0].verdict, "team");
	assert.deepEqual(accepted.decisions[0].uses, [3, 4].map(n => ({ path: "AGENTS.md", line: 4, evidence: "package.json:" + n })));
	for (const snippet of ["--preload", "--path-ignore-patterns='**/*.e2e.test.ts'", "bun test --preload ./test/unit-preload.ts", "*.e2e.test.ts"])
		assert.equal(validate("Use `" + snippet + "`.", [3]).decisions[0].verdict, "team", snippet);
	assert.equal(validate("Use `--preload`.", [1], "README.md").decisions[0].verdict, "team");
	assert.equal(validate("Use `test:unit`.", [3]).decisions[0].verdict, "team");
	for (const [line, citations] of [[note, [3]], [note.replace("test:e2e", "test:nope"), [3, 4]],
		["Use `--preload`.", [4]], ["Use `--pre`.", [3]], ["Use `*.missing.test.ts`.", [3]], ["Use `*.missing`.", [3]],
		[note.replace("test/unit-preload.ts", "test/missing.ts"), [3, 4]]] as const) {
		const rejected = validate(line, [...citations]);
		assert.deepEqual(rejected.decisions[0].uses, []);
		assert.equal(rejected.decisions[0].verdict, "stale", line);
	}
});

test("reconcile each reviewed guide with the filing its published lines came from", async () => {
	const { reconcileReview } = await import("../server/src/repo-setup/review.js");
	const ctx = {
		request: { areas: ["fixed", "unchanged", "omitted", "approved", "dropped"], later: 0, noteIds: ["team"], previous: null },
		notes: [{ id: "team", text: "Read the instructions.", label: "source-note.md" }], owner: "team", host: "github.com",
		paths: ["README.md", ...["fixed", "unchanged", "omitted", "approved", "dropped"].flatMap(d => [0,1,2].map(i => d + "/f" + i + ".ts"))],
		read: new Map([["README.md", "Read the instructions."]]), redact: (s: string) => s,
	};
	const file = (area: string, title: string) => setupGuide(area, title, "Read the instructions.");
	const args = { score: answers().slice(0, 3), notes: [{ noteId: "team", verdict: "team", reason: "Verified in readme." }] };
	const original = validateDraft({ ...args, files: ["", ...ctx.request.areas].map(area => file(area, "# Original")) }, ctx);
	const files = [file("", "# Unexpected\n"), file("fixed", "# Fixed\n"), file("unchanged", "# Original"), file("dropped", "# Revised")];
	assert.equal(validateDraft({ ...args, files }, ctx).files.size, files.length);
	assert.throws(() => validateDraft({ ...args, files: files.slice(1) }, ctx), /Include the root AGENTS.md/);
	const revision = validateDraft({ ...args, files }, { ...ctx, revision: true });
	const verdict = (path: string, verdict: "ok" | "fix" | "drop") => ({ path, verdict, findings: [] });
	const accepted = reconcileReview(original, revision, [
		verdict("AGENTS.md", "ok"), verdict("approved/AGENTS.md", "ok"), verdict("fixed/AGENTS.md", "fix"),
		verdict("unchanged/AGENTS.md", "fix"), verdict("omitted/AGENTS.md", "fix"), verdict("dropped/AGENTS.md", "drop"),
	]);
	assert.deepEqual(accepted.files, new Map([
		["AGENTS.md", original.files.get("AGENTS.md")], ["approved/AGENTS.md", original.files.get("approved/AGENTS.md")],
		["fixed/AGENTS.md", revision.files.get("fixed/AGENTS.md")],
	]));
	assert.deepEqual(accepted.leftOut, ["unchanged", "omitted"].map(area => area + "/AGENTS.md: the reviewer asked for a fix that wasn't made, so it was left out"));
	assert.deepEqual(accepted.decisions[0].uses.map(u => [u.path, u.line]), [["AGENTS.md", 3], ["approved/AGENTS.md", 3], ["fixed/AGENTS.md", 4]]);
	const empty = validateDraft({ ...args, files: [] }, { ...ctx, revision: true });
	const allOmitted = reconcileReview(original, empty, [...original.files.keys()].map(path => verdict(path, "fix")));
	assert.equal(allOmitted.files.size, 0);
	assert.equal(allOmitted.leftOut.length, original.files.size);
});

test("guide minimums and sections are checked after filtering unsupported lines", () => {
	const ctx = { request: { areas: ["src", "test"], later: 1, noteIds: [], previous: null }, notes: [], owner: "team", host: "github.com",
		paths: ["README.md", "src/f0.ts", "src/f1.ts", "src/f2.ts"], read: new Map([["README.md", "Working here."]]), redact: (s: string) => s };
	const args = { score: answers().slice(0, 3), notes: [] };
	const root = setupGuide("", "# Guide", "A fixture is a test input.");
	const area = setupGuide("src", "# Source", "Run the targeted check.");
	for (const f of [root, area]) for (const r of f.lines) r.noteId = undefined;
	const file = (files: typeof root[]) => validateDraft({ ...args, files }, ctx);
	assert.equal(file([root, area]).files.size, 2);
	assert.throws(() => file([{ ...root, lines: root.lines.filter((_, i) => i % 2 === 0) }]), /AGENTS.md: only .*at least 30/);
	assert.throws(() => file([root, { ...area, lines: area.lines.filter(r => ![4,11].includes(r.line)) }]), /src\/AGENTS.md: only .*at least 12/);
	assert.throws(() => file([root, { ...area, content: area.content.replace("## See also", "## Other") }]), /include ## See also/);
	assert.throws(() => file([root, { ...area, lines: area.lines.filter(r => r.line !== 8) }]), /three to five key files/);
	const turn = { ...ctx, repository: { owner: "team", url: "https://github.com/team/project" } as import("../server/src/github/publish.js").StoredRepository };
	assert.match(setupBodies(file([root, area]), turn).body, /1 folder covered. 2 more/);
});

test("older passing build proves setup and checks only for matching inputs", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(READINESS_TABLE); sqlite.exec(ENVIRONMENT_TABLE);
	const db = { execute: async (q: string, ...args: SQLInputValue[]) => sqlite.prepare(q).all(...args) } as Parameters<typeof setupInputs>[0];
	const command = "install", checks = [{ name: "tests", command: "test" }];
	const build = { ...environmentInputs(command, checks), commit: "abcdef0123456789", finishedAt: now, failure: null,
		checks: [{ name: "tests", status: "passed", durationMs: 300_000 }] } as EnvironmentBuild;
	await writeEnvironment(db, { ...emptyRow("repo", "hosted"), ready: build });
	const scan = { ci: history, ciReadFailed: false, commit: "1234567", areas: [], later: 0, at: now, findings: [] };
	for (const [setup, saved, pass] of [[command, checks, true], ["other", checks, false], [command, [{ name: "tests", command: "changed" }], false]] as const) {
		const inputs = await setupInputs(db, "repo", scan, setup, [...saved]);
		await db.execute("INSERT INTO readiness(project, session, at, inputs, judgment) VALUES (?,?,?,?,?)", "repo", inputs.key, now, inputs.key,
			JSON.stringify({ findings: answers("setup", "checks") }));
		const view = await repositoryReadiness(db, "repo", inputs, false);
		for (const f of view.latest!.findings) {
			assert.equal(f.pass, pass);
			if (pass) assert.match(f.reason, /passed on abcdef0, setup unchanged since/);
		}
	}
	sqlite.close();
});

test("split, seal and expire notes within the owner's repository", async () => {
	const { addNotes, setupKnowledge, splitNotes, NOTE_LIFETIME, NOTES_TABLE, PUBLICATION_TABLE } = await import("../server/src/repo-setup/notes.js");
	const db = new DatabaseSync(":memory:");
	db.exec(NOTES_TABLE); db.exec(PUBLICATION_TABLE);
	const store = { execute: async (q: string, ...args: SQLInputValue[]) => db.prepare(q).all(...args) } as Parameters<typeof addNotes>[0];
	const input = [{ label: "team.mdc", text: "# Build\nfirst fact\n## Check\nsecond fact" }];
	assert.equal(splitNotes(input).length, 2);
	assert.throws(() => splitNotes([{ label: "notes.md", text: "a".repeat(262145) }]));
	await addNotes(store, "owner", "repo", input, Date.now());
	assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM setup_notes").all()), /first fact|team.mdc/);
	assert.equal((await setupKnowledge(store, "owner", "repo")).notes.length, 2);
	assert.equal((await setupKnowledge(store, "owner", "other")).notes.length, 0);
	await assert.rejects(setupKnowledge(store, "other", "repo"));
	await addNotes(store, "owner", "repo", input, Date.now() - NOTE_LIFETIME);
	assert.equal((await setupKnowledge(store, "owner", "repo")).notes.length, 2);
	db.close();
});

test("the server chooses at most eight source folders and includes folders with 5,000 verified lines", async () => {
	const files = new Map<string, string>();
	for (let i = 0; i < 8; i++) for (let j = 0; j < 50; j++) files.set(`part${i}/x${j}.ts`, "x");
	for (let i = 0; i < 10; i++) files.set(`many-lines/f${i}.py`, "x\n".repeat(500));
	files.set("vendor/long.js", "x\n".repeat(7000));
	const scanFiles: GithubApp["scanFiles"] = async (_t, _o, _n, _r, pick) => {
		const { paths } = pick([...files].map(([path, text]) => ({ path, size: text.length, type: "blob" })), false);
		return { commit: "a".repeat(40), files: paths.map(path => ({ path, text: files.get(path)! })), incomplete: false };
	};
	const scan = await scanRepoSetup({ scanFiles } as GithubApp, "read", { defaultBranch: "main" } as Repository);
	assert.equal(scan.areas.length, 8);
	assert.equal(scan.later, 1);
	assert.ok(scan.areas.every(a => a.startsWith("part")));
});
