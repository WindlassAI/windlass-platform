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
