import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, advance, currentKey } from "../server/src/factory/blueprint.js";
import * as intake from "../server/src/factory/intake.js";
import { edge } from "../server/src/github/events.js";
import type { ItemBudget, FeaturePlanEdit } from "../server/src/contract.js";

const single = { tokens: 10000, turns: 10, activeSeconds: 1000, hostedSeconds: 500 };
const zero = { tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 };
const task = { title: "Build search", body: "Index and display results", acceptance: ["Search works"], base: "main" };
const proposal = (): FeaturePlanEdit => ({
	spec: { goal: task.body, requirements: ["Index documents"], outOfScope: [], acceptance: task.acceptance },
	questions: [], singleSuggested: null,
	subtasks: ["index", "page"].map((key, i) => ({ key, title: key, brief: "Implement " + key, acceptance: ["Run pnpm test"], owns: [key + "/**"], dependsOn: i ? ["index"] : [], budget: { ...single } })),
});
const plans = () => import("../server/src/factory/feature-plan.js");
test("an orchestrated filing starts with a planner and three single budgets", () => {
	const item = createItem({ id: "i_feature", task, mode: "orchestrate", place: { kind: "hosted" }, budget: single, reviewer: { on: true } });
	assert.equal(item.budget.turns, 30);
	const start = advance(item, { kind: "start", at: 1, by: "person" });
	assert.equal(start.item.run!.step.kind, "refine");
	assert.match(start.effects.find(e => e.kind === "deliver")!.text, /file_plan/);
});
test("the bound label or first command word requests orchestration, bug wins with a reply", () => {
	const label = edge("issues", { action: "labeled", installation: { id: 1 }, repository: { id: 2 }, issue: { number: 3 }, sender: { login: "sam", id: 4 }, label: { name: "windlass:orchestrate" } }, { slug: "windlass" });
	assert.ok(label);
	assert.equal(intake.issueMode("orchestrate please", []).mode, "orchestrate");
	assert.equal(intake.issueMode("please orchestrate", []).mode, "single");
	assert.equal(intake.issueMode("", ["windlass:orchestrate"]).mode, "orchestrate");
	assert.deepEqual(intake.issueMode("orchestrate", ["BUG"]).mode, "single");
	assert.match(intake.issueMode("orchestrate", ["bug"]).reason!, /bug/i);
});
test("validate the entire plan, including dependencies, paths and every budget dimension", async () => {
	const { validatePlan, featureCap } = await plans();
	const good = proposal();
	assert.deepEqual(validatePlan(good, single, featureCap(single)).subtasks, good.subtasks);
	for (const mutate of [
		(p: FeaturePlanEdit) => p.subtasks.pop(),
		(p: FeaturePlanEdit) => p.subtasks.push(...Array(5).fill(p.subtasks[0])),
		(p: FeaturePlanEdit) => p.subtasks[0].dependsOn.push("page"),
		(p: FeaturePlanEdit) => p.subtasks[0].dependsOn.push("missing"),
		(p: FeaturePlanEdit) => p.subtasks[0].owns = ["../other"],
		(p: FeaturePlanEdit) => p.subtasks[0].owns = [],
		(p: FeaturePlanEdit) => p.subtasks[0].acceptance = [],
		(p: FeaturePlanEdit) => p.subtasks[0].budget.turns = 0,
		(p: FeaturePlanEdit) => p.subtasks[0].budget.hostedSeconds++,
		(p: FeaturePlanEdit) => p.subtasks[0].budget.tokens = Infinity,
		(p: FeaturePlanEdit) => p.subtasks[0].budget.activeSeconds = 0.1,
		(p: FeaturePlanEdit) => p.subtasks.push(...["more", "again"].map(key => ({ ...p.subtasks[0], key }))),
	]) {
		const p = proposal(); mutate(p); assert.throws(() => validatePlan(p, single, featureCap(single)));
	}
});

function started() {
	const item = createItem({ id: "i_feature", task, mode: "orchestrate", place: { kind: "hosted" }, budget: single, reviewer: { on: true } });
	return advance(item, { kind: "start", at: 1, by: "person" }).item;
}
function proposed(p: FeaturePlanEdit) {
	const item = started(), key = currentKey(item)!;
	const filed = advance(item, { kind: "file_plan", key, plan: p, at: 2 });
	assert.equal(filed.item.featurePlan?.version, 1);
	return advance(filed.item, { kind: "turn_ended", key, at: 3, outcome: "completed", changes: false, report: null, verified: null, flags: [], spend: { tokens: 10, hostedSeconds: 1 } }).item;
}
test("only the current answered plan can be approved and it dispatches children, never a builder turn", () => {
	const p = proposal();
	p.questions.push({ id: "target", text: "Which target?" });
	const item = proposed(p);
	const approve = { kind: "approve_plan" as const, version: 1, at: 4, by: "person:owner" };
	assert.equal(advance(item, approve).item, item);
	p.questions[0].answer = "Linux";
	const edit = { kind: "edit_plan" as const, plan: p, version: 1, at: 5, by: "person:owner" };
	const edited = advance(item, edit).item;
	assert.equal(advance(edited, edit).item, edited);
	assert.equal(advance(edited, approve).item, edited);
	const next = advance(edited, { ...approve, version: 2 });
	assert.equal(next.item.featurePlan?.approvedBy, approve.by);
	assert.equal(next.item.run!.step.kind, "subtasks");
	assert.ok(next.effects.some(e => e.kind === "dispatch"));
	assert.equal(advance(next.item, { ...approve, version: 2 }).item, next.item);
});
test("single suggestion waits for either explicit choice, and planning spend carries into single mode", () => {
	const p = { ...proposal(), subtasks: [], singleSuggested: "Only one file." };
	const item = proposed(p);
	assert.equal(item.question!.kind, "single_suggested");
	assert.deepEqual(item.question!.choices.map(c => c.id), ["run_single", "orchestrate_anyway"]);
	for (const choice of ["run_single", "orchestrate_anyway"] as const) {
		const next = advance(item, { kind: "answer", choice, question: item.question!.id, by: "person", at: 4 }).item;
		assert.equal(next.run!.step.kind, choice === "run_single" ? "implement" : "refine");
		assert.equal(next.spent.tokens, 10);
		if (choice === "run_single") assert.deepEqual(next.budget, single);
	}
});
test("a planner can file a plan without any builder publication tools", async () => {
	const { turnHostTools, hostToolsMeta } = await import("../server/src/sandbox/turn.js");
	const call = async () => "";
	const tools = turnHostTools({ onPlan: call, onReport: call, onPush: call, onFetchBase: call } as never);
	assert.deepEqual([...tools.keys()], ["file_plan"]);
	assert.deepEqual(hostToolsMeta(tools).hostTools.map(t => t.name), ["file_plan"]);
});

test("machine reports accept old runners and validate new compute figures", async () => {
	const { parseRunnerFrame } = await import("../server/src/runner/control.js");
	const frame = { kind: "report", commandSandbox: { ok: true }, docker: { ok: true }, freeDiskBytes: null, sandboxes: [] };
	const host = { cpus: 8, sandboxCpus: 0.5, memoryBytes: 1024, memoryFreeBytes: 100, load1: 1.5 };
	assert.ok(parseRunnerFrame(JSON.stringify(frame)));
	assert.ok(parseRunnerFrame(JSON.stringify({ ...frame, host })));
	assert.equal(parseRunnerFrame(JSON.stringify({ ...frame, host: { ...host, cpus: -1 } })), null);
});
test("planner inventory exposes capacity and validated owner text without session ids or secrets", async () => {
	const { machineDetails, plannerMachines } = await import("../server/src/machines/details.js");
	const details = machineDetails({ whenToUse: "Big builds", tags: ["big-build"] });
	assert.deepEqual(details.tags, ["big-build"]);
	for (const tags of [["harness:claude"], ["arch"], ["screenshots"], ["x".repeat(25)], Array(13).fill("a")]) assert.throws(() => machineDetails({ ...details, tags }));
	assert.throws(() => machineDetails({ ...details, whenToUse: "x".repeat(501) }));
	const [entry] = plannerMachines([{ ...details, name: "Box", sandboxes: [{ state: "running", sessionId: "private" }], turns: { running: 1, queued: 2, max: 1 }, sendSecrets: true }] as never);
	assert.equal(entry.turns.queued, 2); assert.equal(entry.whenToUse, "Big builds");
	assert.doesNotMatch(JSON.stringify(entry), /private|sendSecrets/);
});
