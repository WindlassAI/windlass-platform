import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, advance, canRetry, currentKey } from "../server/src/factory/blueprint.js";
import * as intake from "../server/src/factory/intake.js";
import { edge } from "../server/src/github/events.js";
import { MAX_ITEM_BODY_CHARS, type FeaturePlanEdit } from "../server/src/contract.js";

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
test("issues plan first unless the bug label, quick label or leading quick command opts out", () => {
	const label = edge("issues", { action: "labeled", installation: { id: 1 }, repository: { id: 2 }, issue: { number: 3 }, sender: { login: "sam", id: 4 }, label: { name: "windlass:orchestrate" } }, { slug: "windlass" });
	assert.ok(label);
	assert.equal(intake.issueMode("orchestrate please", []).mode, "orchestrate");
	assert.equal(intake.issueMode("", []).mode, "orchestrate");
	assert.equal(intake.issueMode("please be quick", []).mode, "orchestrate");
	assert.equal(intake.issueMode("quickly", []).mode, "orchestrate");
	assert.equal(intake.issueMode("QUICK please", ["windlass:orchestrate"]).mode, "single");
	assert.equal(intake.issueMode("orchestrate", ["windlass:quick"]).mode, "single");
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

function started(budget = single) {
	const item = createItem({ id: "i_feature", task, mode: "orchestrate", place: { kind: "hosted" }, budget, reviewer: { on: true } });
	return advance(item, { kind: "start", at: 1, by: "person" }).item;
}
function proposed(p: FeaturePlanEdit, budget = single) {
	const item = started(budget), key = currentKey(item)!;
	const filed = advance(item, { kind: "file_plan", key, plan: p, at: 2 });
	assert.equal(filed.item.featurePlan?.version, 1);
	return advance(filed.item, { kind: "turn_ended", key, at: 3, outcome: "succeeded", changes: false, report: null, verified: null, flags: [], spend: { tokens: 10, hostedSeconds: 1 } }).item;
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
	assert.deepEqual(item.question!.choices, [{ id: "run_single", label: "Approve for one implementer" }, { id: "orchestrate_anyway", label: "Ask for subtasks" }]);
	for (const choice of ["run_single", "orchestrate_anyway"] as const) {
		const next = advance(item, { kind: "answer", choice, question: item.question!.id, by: "person", at: 4 }).item;
		assert.equal(next.run!.step.kind, choice === "run_single" ? "implement" : "refine");
		assert.equal(next.spent.tokens, 10);
		if (choice === "run_single") assert.equal(next.budget.tokens - next.spent.tokens, single.tokens);
	}
});
test("run_single gives the builder the current approved scope, including the owner’s edits", () => {
	const item = proposed({ ...proposal(), subtasks: [], singleSuggested: "One implementer is enough." });
	const spec = { goal: "Look up a record", requirements: ["Match the exact identifier"], acceptance: ["A missing identifier returns 404"], outOfScope: ["Prefix matching"] };
	const edited = advance(item, { kind: "edit_plan", version: 1, plan: { ...item.featurePlan!, spec }, at: 4, by: "owner" }).item;
	for (const fact of [{ kind: "run_single" }, { kind: "answer", choice: "run_single", question: edited.question!.id }] as const) {
		const result = advance(edited, { ...fact, at: 5, by: "owner" });
		const delivery = result.effects.find(e => e.kind === "deliver");
		assert.equal(result.item.featurePlan?.status, "approved");
		assert.equal(result.item.featurePlan?.approvedBy, "owner");
		assert.ok(delivery);
		assert.equal(delivery.agent, null);
		for (const text of [task.body, spec.goal, ...spec.requirements, ...spec.acceptance, ...spec.outOfScope]) assert.ok(delivery.text.includes(text), text);
		assert.ok(!delivery.text.includes("Index documents"));
	}
});

test("one implementer requires saved answers through both approval actions", () => {
	const p = { ...proposal(), subtasks: [], singleSuggested: "Small change.", questions: [{ id: "storage", text: "Which database?" }] };
	const pending = proposed(p);
	for (const action of [{ kind: "run_single" }, { kind: "answer", choice: "run_single", question: pending.question!.id }] as const) {
		assert.throws(() => advance(pending, { ...action, at: 4, by: "owner" }), /answer.*questions/i);
	}
	const plan = { ...p, questions: [{ ...p.questions[0]!, answer: "SQLite" }] };
	const edited = advance(pending, { kind: "edit_plan", plan, version: 1, at: 5, by: "owner" }).item;
	const handoff = advance(edited, { kind: "answer", question: edited.question!.id, choice: "run_single", at: 6, by: "owner" });
	assert.match(handoff.effects.find(e => e.kind === "deliver")!.text, /Which database\?[\s\S]*SQLite/);
});

test("the owner-approved plan is bounded quoted data in the implementing prompt", () => {
	const p = proposal();
	p.spec.requirements = Array.from({ length: 20 }, () => "x".repeat(2000));
	const result = advance(proposed(p), { kind: "run_single", at: 5, by: "owner" });
	const prompt = result.effects.find(e => e.kind === "deliver")!.text;
	const payload = /owner-approved plan \(quoted data\):\n([\s\S]*)/i.exec(prompt)?.[1];
	assert.equal(payload?.length, MAX_ITEM_BODY_CHARS);
});

test("planning stops before a second turn after a quarter of a Quick allowance", () => {
	const feature = started();
	const pending = advance(feature, { kind: "turn_ended", key: currentKey(feature)!, at: 2, outcome: "succeeded", changes: false, verified: null, flags: [], report: null, spend: { tokens: single.tokens / 4, hostedSeconds: 1 } }).item;
	const denied = advance(pending, { kind: "answer", choice: "revise", question: pending.question!.id, by: "owner", at: 3 });
	assert.equal(denied.item.question?.kind, "budget");
	assert.match(denied.item.question!.text, /planning/i);
	assert.ok(!denied.effects.some(e => e.kind === "deliver"));
	const build = advance(denied.item, { kind: "answer", choice: "run_single", question: denied.item.question!.id, by: "owner", at: 4 });
	assert.equal(build.item.budget.tokens - build.item.spent.tokens, single.tokens);
	assert.ok(build.effects.some(e => e.kind === "deliver" && e.agent === null));
});

test("a large final planner receipt stays charged and leaves room for a Quick implementation", () => {
	const p = { ...proposal(), subtasks: [], singleSuggested: "One change.", questions: [{ id: "db", text: "Which database?" }] };
	const start = started(), key = currentKey(start)!;
	const filed = advance(start, { kind: "file_plan", key, at: 2, plan: p }).item;
	const spent = 15_000;
	const pending = advance(filed, { kind: "turn_ended", key, at: 3, outcome: "succeeded", changes: false, report: null, verified: null, flags: [], spend: { tokens: spent, hostedSeconds: 1 } }).item;
	assert.ok(!pending.question!.choices.some(c => c.id === "orchestrate_anyway"));
	const plan = { ...p, questions: [{ ...p.questions[0]!, answer: "SQLite" }] };
	const edited = advance(pending, { kind: "edit_plan", version: 1, plan, by: "owner", at: 4 }).item;
	const build = advance(edited, { kind: "run_single", at: 5, by: "owner" });
	assert.equal(build.item.spent.tokens, spent);
	assert.equal(build.item.budget.tokens, spent + single.tokens);
	assert.match(build.effects.find(e => e.kind === "deliver")!.text, /SQLite/);
});

test("the page retry flag matches the blueprint before and after dispatch, including a placement wait", () => {
	const failed = { ...started(), state: "failed" as const };
	const fact = { kind: "retry" as const, at: 99, by: "owner" };
	for (const item of [failed, { ...failed, machineRemoved: true }, { ...failed, parent: { itemId: "parent", key: "first", title: "Feature" } },
		{ ...failed, jobs: [{ id: "i_child", task: proposal().subtasks[0]!, state: "draft" as const, spent: zero, head: null, report: "" }] }]) {
		assert.equal(canRetry(item), item === failed);
		assert.equal(advance(item, fact).item !== item, canRetry(item));
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
	const [entry] = plannerMachines([{ ...details, name: "f892b469d6c5", os: "linux", arch: "arm64", egress: "restricted", sandboxes: [{ state: "running", sessionId: "private" }], turns: { running: 1, queued: 2, max: 1 }, sendSecrets: true }] as never);
	assert.equal(entry.name, "Linux arm64 machine (f892b4)");
	assert.equal(entry.egress, "restricted");
	assert.equal(entry.turns!.queued, 2); assert.equal(entry.whenToUse, "Big builds");
	assert.doesNotMatch(JSON.stringify(entry), /private|sendSecrets/);
});

function approved(budget = single) {
	const item = proposed(proposal(), budget);
	return advance(item, { kind: "approve_plan", version: 1, at: 4, by: "person" }).item;
}
const head = "a".repeat(40);
const pr = { number: 12, url: "https://example.invalid/pull/12" };
test("one child is reserved at a time, replay is harmless, cancellation includes the pending creation", () => {
	const item = approved();
	const ready = { kind: "feature_ready" as const, at: 5, key: currentKey(item)!, head, pr };
	const next = advance(item, ready);
	assert.equal(next.item.jobs?.length, 1);
	assert.equal(next.item.jobs![0].task.key, "index");
	assert.equal(advance(next.item, ready).item, next.item);
	assert.ok(advance(next.item, { kind: "cancel", at: 6, by: "person" }).effects.some(e => e.kind === "cancel_children"));
});
test("stopped child spend is charged once and re-planning requires fresh approval", () => {
	const item = approved();
	const running = advance(item, { kind: "feature_ready", at: 5, key: currentKey(item)!, head, pr }).item;
	const job = running.jobs![0];
	const stopped = { kind: "child_update" as const, key: currentKey(running)!, child: job.id, at: 6, state: "failed" as const, spent: { ...zero, turns: 2 }, head: null, report: "Tests failed" };
	const replan = advance(running, stopped);
	assert.equal(replan.item.replans, 1);
	assert.equal(replan.item.spent.turns, 3);
	assert.equal(advance(replan.item, stopped).item, replan.item);
	assert.equal(replan.item.run!.step.kind, "refine");
	assert.equal(replan.item.featurePlan?.status, "superseded");
});
test("finished children unlock their dependents, and the final summary uses a read-only turn", () => {
	let item = approved();
	item = advance(item, { kind: "feature_ready", at: 5, key: currentKey(item)!, head, pr }).item;
	for (const key of ["index", "page"]) {
		const job = item.jobs!.at(-1)!; assert.equal(job.task.key, key);
		item = advance(item, { kind: "child_update", child: job.id, key: currentKey(item)!, at: 9, state: "done", spent: { ...zero, turns: 1 }, head, report: key + " passed" }).item;
	}
	assert.equal(item.run!.step.kind, "summary"); assert.equal(item.pr!.number, 12);
});
test("feature ref updates are fast-forward only and confined to the platform feature branch", async () => {
	const { advanceFeatureRef } = await import("../server/src/github/feature.js");
	const calls: any[] = []; const app = { call: async (req: any) => { calls.push(req); return { body: { object: { sha: head } } }; } };
	await advanceFeatureRef(app as never, "token", "owner", "repo", "i_feature", "main", head);
	assert.equal(calls[0].method, "PATCH"); assert.equal(calls[0].body.force, false);
	assert.match(calls[0].path, /git\/refs\/heads\/windlass\/feature-i_feature$/);
	assert.doesNotMatch(calls[0].path, /\/main$/);
	await assert.rejects(advanceFeatureRef(app as never, "token", "owner", "repo", "i_feature", "windlass/feature-i_feature", head));
});

test("a planner cannot answer its own questions or introduce a scope change without a question", () => {
	const p = proposal(); p.questions.push({ id: "scope", text: "Include reports?", answer: "Yes" });
	const initial = proposed(p);
	assert.equal(initial.featurePlan!.questions[0].answer, undefined);
	let old = approved();
	old = advance(old, { kind: "feature_ready", key: currentKey(old)!, at: 5, head, pr }).item;
	const stopped = advance(old, { kind: "child_update", child: old.jobs![0].id, key: currentKey(old)!, at: 6, state: "failed", spent: zero, report: "Stopped", head: null }).item;
	const changed = proposal(); changed.spec.goal = "Different feature";
	const filed = advance(stopped, { kind: "file_plan", key: currentKey(stopped)!, at: 7, plan: changed }).item;
	assert.ok(filed.featurePlan!.questions.some(q => !q.answer));
});
test("independent subtasks cannot claim overlapping paths; each names a check or screenshot", async () => {
	const {validatePlan, featureCap} = await plans();
	const plan = proposal(), cap = featureCap(single);
	plan.subtasks[1].dependsOn = []; plan.subtasks[1].owns = ["index/data.ts"];
	assert.throws(() => validatePlan(plan, single, cap), /own|overlap/i);
	plan.subtasks[1].dependsOn = ["index"]; assert.doesNotThrow(() => validatePlan(plan, single, cap));
	plan.subtasks[1].acceptance = ["Looks good."]; assert.throws(() => validatePlan(plan, single, cap));
});
test("child integration needs both gates, ignores duplicate receipts, and rebases in the child on refusal", () => {
	const child = createItem({ id: "i_child", task: {...task, base: "windlass/feature-i_feature"}, budget: single, place: {kind:"hosted"}, reviewer: {off:"deployment"} });
	child.parent = {itemId:"i_feature",key:"index",title:task.title};
	const start = advance(child, {kind:"start",at:1,by:"platform"}).item;
	for (const checks of [false,true]) {
		const gate = advance(start, { kind:"turn_ended", key:currentKey(start)!, at:2, outcome:"succeeded", verified: checks ? { state:"passed",turn:1,run:null,unrun:[],changedAfter:false } : null, flags:[], changes:true, report:null, spend:{tokens:1,hostedSeconds:0} }).item;
		const pushed = advance(gate, {kind:"published", at:3,key:currentKey(gate)!,head,pr:null,openItems:1,webhooks:false}).item;
		assert.equal(pushed.pr,null);
		const ci = { kind:"ci_read" as const, key:currentKey(pushed)!,at:4,head,reading:{kind:"read" as const,head,runs:[{name:"build",app:"status",state:"passed",conclusion:"success",url:null,summary:null}],logs:[],truncated:false},prHead:null,mergeable:null,openItems:1,webhooks:false };
		const absent = advance(pushed, {...ci, at:3_600_000, reading:{...ci.reading, runs:[]}} as never).item;
		assert.ok(absent.question!.choices.some(c => c.id === "wait"));
		assert.equal(absent.run!.lastFailure, "integration/no-ci");
		const waiting = advance(absent, { kind:"answer", question:absent.question!.id, choice:"wait", by:"person", at:3_600_001 });
		assert.ok(waiting.effects.some(e => e.kind === "poll_ci"));
		const result = advance(pushed,ci as never);
		if (!checks) assert.equal(result.item.run!.lastFailure, "integration/no-gate");
		assert.equal(result.effects.some(e=>e.kind === "integrate"),checks);
		assert.equal(advance(result.item,ci as never).item,result.item);
		if (checks) {
			const cancelling = advance(result.item, {kind:"cancel", at:5, by:"person"}).item;
			const receipt = advance(cancelling, {kind:"integrated", key:currentKey(cancelling)!, at:6});
			assert.ok(receipt.effects.some(e => e.kind === "notify_integrated"), "the confirmed fast-forward needs a durable parent receipt");
			const confirmed = receipt.item;
			assert.equal(confirmed.state, "done", "record the verified commit even when cancellation raced the fast-forward");
			const declined = advance(cancelling, {kind:"feature_problem", key:currentKey(cancelling)!, at:6, reason:"diverged", rebase:true}).item;
			assert.equal(declined.state, "cancelled");
			const rejected = advance(result.item,{kind:"feature_problem",key:currentKey(result.item)!,at:5,reason:"not a fast-forward",rebase:true});
			assert.equal(rejected.item.run!.step.kind,"conflict");
			assert.match(rejected.effects.find(e=>e.kind==="deliver")!.text,/rebase/i);
		}
	}
});

test("a stopped feature cannot turn its cap into a builder retry or lose child spend", () => {
	const item = proposed(proposal());
	const old = item.featurePlan!;
	const next = advance(item,{kind:"approve_plan",version:old.version,at:5,by:"person"}).item;
	next.spent.tokens = next.budget.tokens;
	const paused = advance(next,{kind:"feature_ready",key:currentKey(next)!,pr,head,at:6}).item;
	assert.equal(paused.question?.kind,"budget"); assert.equal(paused.jobs?.length,0);
	assert.ok(paused.question!.choices.some(c => c.id === "revise"));
	const revised = advance(paused,{kind:"answer",question:paused.question!.id,choice:"revise",by:"person",at:7});
	assert.equal(revised.item.question?.kind, "budget");
	assert.equal(revised.item.question!.choices.some(c => c.id === "retry"), false);
	assert.equal(revised.effects.some(e => e.kind === "deliver"), false);
	assert.deepEqual(revised.item.spent, next.spent);
});
test("a second re-plan can move only unused allocation and a third stop cannot dispatch a planner", () => {
	let item = approved({ ...single, turns: 12 }); // Three planning turns fit in this allowance.
	item = advance(item, {kind:"feature_ready",key:currentKey(item)!,pr,head,at:5}).item;
	for (let i=0;i<3;i++) {
		const last = item.jobs!.at(-1)!;
		item = advance(item,{kind:"child_update",child:last.id,key:currentKey(item)!,state:"failed",spent:{...zero,turns:1},report:"Stopped",head:null,at:6+i}).item;
		if(i===2) break;
		const p = proposal();
		assert.throws(()=>advance(item,{kind:"file_plan",plan:p,key:currentKey(item)!,at:10}),/unspent/);
		p.subtasks[0].budget.turns -= i+1;
		const key = currentKey(item)!;
		item = advance(item,{kind:"file_plan",plan:p,key,at:10}).item;
		item = advance(item,{kind:"turn_ended",key,at:11,outcome:"succeeded",spend:{tokens:1,hostedSeconds:0},verified:null,flags:[],changes:false,report:null}).item;
		assert.equal(item.question!.kind,"replan_approval");
		item = advance(item,{kind:"approve_plan",version:item.featurePlan!.version,by:"person",at:12}).item;
	}
	assert.equal(item.replans,2); assert.equal(item.question?.kind,"rounds");
});

test("a child notice wakes a waiting feature and settles spend after cancellation without restarting it", () => {
	const initial = approved();
	const running = advance(initial, {kind:"feature_ready", key:currentKey(initial)!, head, pr, at:5}).item;
	const notice = {kind:"child_notice" as const, child:running.jobs![0].id, state:"done" as const, integratedHead:"b".repeat(40), spent:{...zero, tokens:120}, at:6};
	const woke = advance(running, notice);
	assert.ok(woke.effects.some(e => e.kind === "dispatch"));
	const cancelledAfterNotice = advance(woke.item, {kind:"cancel", at:7, by:"person"}).item;
	assert.equal(cancelledAfterNotice.head, notice.integratedHead);
	const cancelled = advance(running, {kind:"cancel", at:7, by:"person"}).item;
	const settled = advance(cancelled, notice);
	assert.equal(settled.item.spent.tokens, 130);
	assert.equal(settled.item.head, notice.integratedHead);
	assert.equal(settled.item.jobs![0].state, "done");
	assert.equal(settled.item.state, "cancelled");
	assert.deepEqual(settled.effects, []);
	assert.equal(advance(settled.item,notice).item, settled.item);
});

test("a re-plan respects the historical tree limit and repeated failures in different children stop the feature", () => {
	const initial = approved();
	const running = advance(initial, {kind:"feature_ready", key:currentKey(initial)!, head, pr, at:5}).item;
	const job = running.jobs![0];
	const fail = {kind:"child_update" as const, key:currentKey(running)!, child:job.id, at:6, state:"failed" as const, spent:zero, head:null, report:"Failed", failure:"gate/build"};
	const first = advance(running, fail).item;
	for (let n=0; n<5; n++) first.jobs!.push({...job, id:"i_old"+n, task:{...job.task,key:"old"+n}});
	assert.throws(() => advance(first, {kind:"file_plan", key:currentKey(first)!, at:8, plan:proposal()}), /six|limit/i);
	running.jobs!.unshift({...job, task:{...job.task,key:"another"}, state:"failed", failure:fail.failure});
	const stopped = advance(running, fail);
	assert.equal(stopped.item.question?.kind, "rounds");
	assert.match(stopped.item.question!.text, /same failure/i);
});

test("an explicit orchestration choice cannot lead to another single suggestion", () => {
	const p = { ...proposal(), subtasks: [], singleSuggested: "One part." };
	const item = proposed(p);
	const forced = advance(item, {kind:"answer", question:item.question!.id, choice:"orchestrate_anyway", by:"person", at:7}).item;
	assert.throws(() => advance(forced, {kind:"file_plan", key:currentKey(forced)!, at:8, plan:p}), /subtasks/);
});

test("the planner uses high effort when its model offers it, never ultra or max", async () => {
	const {plannerEffort} = await import("../server/src/account-models.js");
	assert.equal(plannerEffort([{id:"requested",name:null,efforts:["medium","max","high"]}], "requested"),"high");
	assert.equal(plannerEffort([{id:"requested",name:null,efforts:["low","medium","high","xhigh","max","ultra"]}], "requested"),"high");
	assert.equal(plannerEffort([{id:"requested",name:null,efforts:["ultra","max"]}], "requested"),null);
	assert.equal(plannerEffort([{id:"other",name:null,efforts:["high"]}], "requested"),null);
});


test("the whole-feature review uses child evidence and needs the pinned head and an available reviewer", () => {
	let item = approved();
	item = advance(item, {kind:"feature_ready", key:currentKey(item)!, head, pr, at:5}).item;
	for (const jobKey of ["index","page"]) {
		item = advance(item, {kind:"child_update", key:currentKey(item)!, child:item.jobs!.at(-1)!.id, state:"done", head, report:jobKey+" evidence", spent:zero, at:6}).item;
	}
	item = advance(item, {kind:"turn_ended",key:currentKey(item)!,at:7,outcome:"succeeded",spend:{tokens:1,hostedSeconds:0},report:"Summary",changes:false,verified:null,flags:[]}).item;
	item = advance(item, {kind:"published",key:currentKey(item)!,at:8,head,pr,openItems:1,webhooks:false}).item;
	const ci = {kind:"ci_read" as const,key:currentKey(item)!, at:9, head, reading:{kind:"read" as const,head,runs:[{name:"build",app:"status",state:"passed" as const,conclusion:"success",url:null,summary:null}],logs:[],truncated:false},prHead:head,mergeable:true,openItems:1,webhooks:false};
	const missing = advance(item, { ...ci, at:3_600_000, reading:{...ci.reading, runs:[]} }).item;
	assert.deepEqual(missing.question?.choices.map(c => c.id), ["wait", "hand_over", "give_up"]);
	const review = advance(item, ci as never).effects.find(e=>e.kind === "deliver");
	assert.ok(review?.to === "review" && review.reviewerInput?.task.body.includes("page evidence") && review.reviewerInput.task.body.includes("index evidence"));
	for (const reading of [
		{...ci, prHead:"b".repeat(40)}, {...ci, mergeable:false},
		{...ci, reading:{...ci.reading, runs:[{...ci.reading.runs[0], state:"failed", conclusion:"failure"}]}},
	]) {
		const blocked = advance(item, reading as never).item;
		assert.ok(blocked.question!.choices.some(c => c.id === "hand_over"));
		const handoff = advance(blocked, {kind:"answer", choice:"hand_over", question:blocked.question!.id, by:"person", at:10});
		assert.equal(handoff.item.run!.step.kind, "handoff");
		if (reading.prHead === head) {
			const retry = advance(blocked, {kind:"answer", choice:"wait", question:blocked.question!.id, by:"person", at:10});
			assert.ok(retry.effects.some(e => e.kind === "poll_ci"));
		}
	}
	for (const blocked of [advance({...item,reviewer:{off:"deployment"}},ci as never)]) {
		assert.ok(blocked.item.question);
		assert.equal(blocked.effects.some(e => e.kind === "handoff"),false);
	}
});

test("the child verdict flags both sides of a rename outside its declared ownership", async () => {
	const {workFlags} = await import("../server/src/verified.js");
	const {ownsPath} = await plans();
	const diff = {files:[{status:"R",path:"src/a.ts",to:"test/a.ts"},{status:"M",path:"src/deep/x.ts"},{status:"M",path:".env"}], patch:"", config:{before:null,after:null},packageJson:{before:null,after:null}};
	const flags = workFlags(diff, [], path => ownsPath(["src/**/*.ts"], path));
	assert.deepEqual(flags.find(f=>f.kind==="outside_scope")?.where, ["test/a.ts",".env"]);
	assert.equal(workFlags(diff, []).some(f=>f.kind==="outside_scope"),false);
});

test("the existing approval question shows each subtask cap and the single-item comparison", () => {
	const {question} = proposed(proposal());
	assert.match(question!.text,/index.*10,000 tokens/);
	assert.match(question!.text,/page.*10 turns/);
	assert.match(question!.text,/30,000 tokens/);
	assert.match(question!.text,/Single item.*10,000 tokens/);
});

test("a person can cancel the current subtask by its approved key", () => {
	const initial = approved();
	const item = advance(initial,{kind:"feature_ready",key:currentKey(initial)!,at:1,head,pr}).item;
	const cancel = {kind:"cancel_subtask" as const,key:"index",at:2,by:"person"};
	assert.equal(advance(item,{...cancel,key:"page"}).item,item);
	const outcome = advance(item,cancel);
	assert.deepEqual(outcome.effects.find(e=>e.kind==="cancel_children")?.ids,[item.jobs![0].id]);
	assert.equal(advance(outcome.item,cancel).item,outcome.item);
});

test("a withdrawn feature turn settles its late usage receipt exactly once", () => {
	const feature = started(), key = currentKey(feature)!;
	const running = advance(feature,{kind:"turn_started",key,at:2}).item;
	const cancelled = advance(running,{kind:"cancel",by:"person",at:3}).item;
	const ended = {kind:"turn_ended" as const,key,at:4,outcome:"stopped" as const,changes:false,report:null,flags:[],verified:null,spend:{tokens:1234,hostedSeconds:3}};
	const settled = advance(cancelled,ended);
	assert.equal(settled.item.spent.tokens,1234);
	assert.equal(settled.item.state,"cancelled");
	assert.deepEqual(settled.effects,[]);
	assert.equal(advance(settled.item,ended).item,settled.item);
});

test("a disabled GitHub orchestration request is refused before claiming the issue", () => {
	const ordinary = intake.issueMode("", [], false);
	assert.equal(ordinary.mode, "single");
	assert.equal(ordinary.refusal, null);
	const asked = intake.issueMode("orchestrate", [], false);
	assert.match(asked.refusal!,/disabled/i);
	assert.match(intake.issueMode("", ["windlass:orchestrate"], false).refusal!, /disabled/i);
	assert.equal(intake.issueMode("orchestrate",["bug"],false).refusal,null);
});

const identity = { name: "ada", email: "42+ada@users.noreply.github.com" };
async function opening(refusal?: Error) {
	const { openFeature } = await import("../server/src/github/feature.js");
	const requests: any[] = [], pulls: any[] = [];
	const app = {
		call: async (request: any) => {
			requests.push(request);
			return { body: request.method === "POST" ? { sha: head } : { tree: { sha: head } } };
		},
		openPull: async () => null,
		createPull: async (_token: string, _owner: string, _repo: string, input: any) => {
			pulls.push(input);
			if (input.draft && refusal) throw refusal;
			return { ...pr, headSha: head, base: "main" };
		},
	};
	await openFeature(app as never, "token", "ada", "repo", { id: "i_feature", title: "Search", base: "main", seed: head, created: 0, body: "Original goal", author: identity });
	return { requests, pulls };
}
test("the feature marker credits the connected user as author and committer", async () => {
	const { requests } = await opening();
	const marker = requests.find(r => r.body?.parents).body;
	const expected = { ...identity, date: new Date(0).toISOString() };
	assert.deepEqual(marker.author, expected);
	assert.deepEqual(marker.committer, expected);
});

test("only an unsupported draft retries as an in-progress ordinary PR", async () => {
	const { GithubError } = await import("../server/src/github/app.js");
	const refused = (status: number, message: string) => new GithubError(status, message, "open PR");
	const message = "Draft pull requests are not supported in this repository.";
	const { pulls } = await opening(refused(422, "Validation Failed: " + message));
	assert.equal(pulls.length, 2);
	assert.deepEqual(pulls[1], { ...pulls[0], draft: false, body: "Original goal\n\nFeature in progress." });
	for (const error of [refused(403, message), refused(422, "Invalid head")]) await assert.rejects(opening(error), error);
});

test("each subtask must fund a useful build and verification turn", async () => {
	const { validatePlan, featureCap, dimensions } = await plans();
	const minimum = { tokens: 1000, turns: 2, activeSeconds: 100, hostedSeconds: 60 };
	for (const d of dimensions) {
		const p = proposal();
		p.subtasks[0].budget[d] = minimum[d];
		validatePlan(p, single, featureCap(single));
		p.subtasks[0].budget[d]--;
		assert.throws(() => validatePlan(p, single, featureCap(single)), new RegExp(d));
	}
});

test("filing, editing and dispatch preserve the closing budget", () => {
	const full = proposal();
	full.subtasks.push({ ...full.subtasks[1], key: "docs", owns: ["docs/**"] });
	assert.throws(() => proposed(full), /reserve/i);
	const pending = proposed(proposal());
	assert.match(pending.question!.text, /summary and review.*1,667 tokens.*4 turns/i);
	assert.throws(() => advance(pending, { kind: "edit_plan", at: 4, by: "person", version: 1, plan: full }), /reserve/i);
	const feature = approved();
	feature.spent.tokens = feature.budget.tokens - single.tokens - 100;
	const next = advance(feature, { kind: "feature_ready", key: currentKey(feature)!, at: 5, head, pr });
	assert.equal(next.item.question?.kind, "budget");
	assert.equal(next.item.jobs?.length, 0);
});
test("feature budget raises require an explicit increase bounded in every dimension", () => {
	const feature = started();
	feature.spent.tokens = feature.budget.tokens;
	const pending = advance(feature, {kind:"turn_ended", key:currentKey(feature)!, at:2, outcome:"succeeded", changes:false, verified:null, flags:[], report:null, spend:{tokens:0,hostedSeconds:0}}).item;
	const stopped = advance(pending, {kind:"answer", choice:"revise", question:pending.question!.id, by:"person", at:3}).item;
	assert.equal(stopped.question!.kind, "budget");
	const raise = {kind:"answer" as const, choice:"raise" as const, question:stopped.question!.id, by:"person", at:4};
	const cap = stopped.budget.tokens;
	for (const budget of [undefined, {}, {turns:31}, {tokens:cap}, {tokens:cap+0.5}, {tokens:cap+single.tokens+1}, {tokens:cap+100,turns:1000}]) {
		assert.throws(() => advance(stopped, {...raise, budget}), /raise|increase/i);
	}
	assert.equal(advance(stopped, {...raise, budget:{tokens:cap+single.tokens}}).item.budget.tokens, cap+single.tokens);
});

test("a quiet child needs 15 polls and one parent revision in the first hour", async () => {
	const feature = approved();
	let item = advance(feature, {kind:"feature_ready", key:currentKey(feature)!, head, pr, at:0}).item;
	let polls = 0, revisions = 0, at = 0;
	const { rescheduleChildPoll } = await import("../server/src/actors/work-item.js");
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE effects(id TEXT, effect TEXT, due_at INTEGER, attempts INTEGER); INSERT INTO effects VALUES ('poll','dispatch',0,0)");
	const execute = (sql: string, ...args: (string | number)[]) => db.prepare(sql).run(...args);
	while (at < 3_600_000) {
		const next = advance(item, {kind:"child_update", key:currentKey(item)!, child:item.jobs![0].id, state:"waiting", spent:zero, head:null, report:"Waiting for owner", at});
		if (next.item !== item) revisions++;
		item = next.item;
		const dispatch = next.effects.find(e => e.kind === "dispatch");
		if (dispatch) at = dispatch.at!;
		else {
			const row = db.prepare("SELECT * FROM effects").get() as {id:string; effect:string; due_at:number; attempts:number};
			await rescheduleChildPoll({execute} as never, row, at);
			at = Number(db.prepare("SELECT due_at FROM effects").get()!.due_at);
		}
		polls++;
	}
	assert.equal(polls, 15, polls + " polls per hour");
	assert.equal(db.prepare("SELECT attempts FROM effects").get()!.attempts, 14);
	db.close();
	assert.equal(revisions, 1);
	const notice = advance(item, {kind:"child_notice", child:item.jobs![0].id, state:"done", spent:zero, at});
	assert.equal(notice.effects.find(e => e.kind === "dispatch")?.at, at);
});

test("an exhausted child cannot raise even through an old stored question", () => {
	const child = createItem({id:"i_child", task, budget:single, reviewer:{off:"deployment"}, place:{kind:"hosted"}});
	child.parent = {itemId:"i_feature",key:"index",title:task.title};
	child.spent = {...single};
	const stopped = advance(child, {kind:"start", at:1, by:"person"}).item;
	assert.equal(stopped.question!.kind, "budget");
	assert.equal(stopped.question!.choices.some(c => c.id === "raise"), false);
	stopped.question!.choices.push({id:"raise",label:"Raise"});
	const forced = advance(stopped, {kind:"answer", question:stopped.question!.id, choice:"raise", budget:{tokens:single.tokens*2}, at:2, by:"person"});
	assert.equal(forced.item, stopped);
	assert.deepEqual(forced.item.budget, single);
});
test("a re-plan cannot edit completed work", () => {
	let item = approved();
	item = advance(item, {kind:"feature_ready", key:currentKey(item)!, head, pr, at:5}).item;
	for (const state of ["done","failed"] as const) {
		item = advance(item, {kind:"child_update", key:currentKey(item)!, child:item.jobs!.at(-1)!.id, state, spent:zero, head, report:"Result", at:6}).item;
	}
	const plan = proposal();
	plan.subtasks[0].brief += " and change another file";
	assert.throws(() => advance(item, {kind:"file_plan", key:currentKey(item)!, plan, at:8}), /Completed subtasks/);
});
test("a redelivered planner must file in its own attempt before approval", () => {
	let item = started();
	const filed = currentKey(item)!;
	item = advance(item, {kind:"file_plan", key:filed, at:2, plan:proposal()}).item;
	item = advance(item, {kind:"turn_ended", key:filed, at:3, outcome:"interrupted", spend:{tokens:1,hostedSeconds:0}, report:null, changes:false, flags:[], verified:null}).item;
	assert.notEqual(currentKey(item), filed);
	assert.equal(item.run!.step.attempt, 2);
	item = advance(item, {kind:"turn_ended", key:currentKey(item)!, at:5, outcome:"succeeded", spend:{tokens:1,hostedSeconds:0}, report:null, changes:false, flags:[], verified:null}).item;
	assert.match(item.question!.text, /without filing/);
	assert.equal(advance(item, {kind:"approve_plan", version:item.featurePlan!.version, at:6, by:"person"}).item, item);
});

test("a missing integration prerequisite stops the feature at its last integrated head", () => {
	const feature = approved();
	const item = advance(feature, {kind:"feature_ready", key:currentKey(feature)!, head, pr, at:5}).item;
	for (const failure of ["integration/no-ci", "integration/no-gate"]) {
		const stopped = advance(item, {kind:"child_update", key:currentKey(item)!, child:item.jobs![0].id, state:"failed", failure, head:"b".repeat(40), report:"Stopped", spent:zero, at:6});
		assert.equal(stopped.item.replans ?? 0, 0);
		assert.deepEqual(stopped.item.question!.choices.map(c => c.id), ["hand_over","give_up"]);
		const handoff = advance(stopped.item, {kind:"answer", question:stopped.item.question!.id, choice:"hand_over", by:"person", at:7});
		assert.ok(handoff.effects.some(e => e.kind === "poll_ci" && e.head === head));
	}
});

test("push CI must target the feature and child branches", async () => {
	const { workflowReportsPush } = await import("../server/src/github/feature-ci.js");
	const branch = "windlass/feature-i_feature";
	for (const source of ["on: pull_request", "on: [pull_request, workflow_dispatch]", "on: {push: {branches: [main]}}",
		"on: {push: {tags: ['v*']}}", "on: {push: {branches-ignore: ['windlass/**']}}", "on: {push: {branches: ['**','!windlass/**']}}"])
		assert.equal(workflowReportsPush(source, branch), false, source);
	for (const source of ["on: push", "on: [push, pull_request]", "on: {push: null}", "on: {push: {branches: ['windlass/*']}}",
		"on: {push: {branches: ['**','!windlass/**','windlass/feature-*']}}"])
		assert.equal(workflowReportsPush(source, branch), true, source);
});

test("re-planning cannot start a turn with only the closing reserve left", () => {
	const feature = approved();
	const running = advance(feature, {kind:"feature_ready", key:currentKey(feature)!, at:5, head, pr}).item;
	running.spent.turns = running.budget.turns - 4;
	const stopped = advance(running, {kind:"child_update", key:currentKey(running)!, child:running.jobs![0].id, state:"failed", spent:zero, report:"Stopped", head:null, at:6});
	assert.equal(stopped.item.question?.kind, "budget");
	assert.equal(stopped.effects.some(e => e.kind === "deliver"), false);
});

const GiB = 2 ** 30;
const macId = "m_0000000000000001", linuxId = "m_0000000000000002";
function machineReport(name = "Mac", machineId = macId, overrides: Partial<import("../server/src/contract.js").MachineSummary> = {}): import("../server/src/contract.js").MachineSummary {
	return { name, machineId, os: "darwin", arch: "arm64", status: "online", since: 0, runnerVersion: "1.0.0", agents: 0,
		warnings: [], sandboxes: [], profiles: [{ id: "docker-hardened", available: true } as never], commandSandbox: { ok: true },
		allowedProfiles: ["docker-hardened"], screenshots: true, egress: "restricted", tags: ["build"], sendSecrets: false, freeDiskBytes: 5 * GiB,
		turns: { running: 0, queued: 0, max: 4 }, host: { cpus: 64, sandboxCpus: 1, memoryBytes: 128 * GiB, memoryFreeBytes: 80 * GiB, load1: 0 }, ...overrides };
}
import { plannerMachines, machineDetails } from "../server/src/machines/details.js";
import { choosePlacement } from "../server/src/factory/placement.js";
import type { MachineSummary, PlacementNeeds } from "../server/src/contract.js";
function placementFeature(machines: MachineSummary[], needs: PlacementNeeds = {}, allow: string[] = [], overflow = false, prefer = "Mac") {
	const plan = proposal();
	plan.overflow = overflow;
	for (const sub of plan.subtasks) Object.assign(sub, { place: { prefer, reason: "Build on the owner's machine", allow }, needs });
	const item = proposed(plan);
	const inventory = { machines: plannerMachines(machines), hostedProfiles: ["docker-hardened" as const] };
	const approved = advance(item, { kind: "approve_plan", at: 4, by: "person", version: 1, inventory }).item;
	return advance(approved, { kind: "feature_ready", key: currentKey(approved)!, at: 5, head, pr }).item;
}
function dispatch(item: ReturnType<typeof placementFeature>, machines: MachineSummary[]) {
	return advance(item, { kind: "place_child", at: 6, key: currentKey(item)!, inventory: { machines: plannerMachines(machines), hostedProfiles: ["docker-hardened"] } }).item;
}
test("placement preserves the editable proposal and bounds its reason, needs and overflow", () => {
	const p = proposal();
	const proposalPlace = { prefer: "Mac", reason: "Build here", allow: ["Linux box"] };
	Object.assign(p.subtasks[0], { place: proposalPlace, needs: { cpus: 2 } });
	const filed = proposed(p);
	assert.deepEqual(filed.featurePlan?.subtasks[0].place, proposalPlace);
	assert.equal(filed.featurePlan?.overflow, false);
	for (const invalid of [{ place: { ...proposalPlace, reason: "x".repeat(201) } }, { needs: { cpus: 0 } },
		{ needs: { memoryGiB: Infinity } }, { needs: { screenshots: "yes" } }, { needs: { egress: "invalid" } }])
		assert.throws(() => proposed({ ...p, subtasks: [{ ...p.subtasks[0], ...invalid }, p.subtasks[1]] } as FeaturePlanEdit));
	assert.throws(() => proposed({ ...p, overflow: "yes" } as never));
});
test("a daily token cap waits on hosted and machine routes, including approved overflow", () => {
	const machines = [machineReport()];
	for (const [prefer, allow] of [["hosted", ["Mac"]], ["Mac", ["hosted"]]] as const) {
		const item = placementFeature(machines, {}, [...allow], true, prefer);
		const wait = "Your daily model token cap has been reached until 00:00 UTC.";
		const waiting = advance(item, { kind: "place_child", at: 6, key: currentKey(item)!,
			inventory: { machines: plannerMachines(machines), hostedProfiles: ["docker-hardened"], dailyTokenWait: wait } }).item;
		assert.equal(waiting.wait?.reason, "capacity");
		assert.equal(waiting.wait?.sentence, wait);
		assert.equal(waiting.question, null);
		assert.equal(waiting.jobs!.at(-1)!.placement, undefined);
		assert.ok(dispatch(waiting, machines).jobs!.at(-1)!.placement);
	}
});
test("placement 1 binds the approved Mac by id and keeps the reason after a rename", () => {
	const mac = machineReport();
	const item = placementFeature([mac]);
	const placed = dispatch(item, [{ ...mac, name: "Renamed" }]).jobs![0].placement;
	assert.deepEqual(placed?.place, { kind: "machine", machineId: macId });
	assert.equal(placed?.reason, "Build on the owner's machine");
	assert.equal(placed?.sendSecrets, false);
	assert.throws(() => placementFeature([]), /Mac/);
	assert.throws(() => placementFeature([mac, machineReport("Mac", linuxId)]), /ambiguous|more than one/i);
});
test("placement 2 refuses approval for missing screenshots, tags, profile, egress or sign-in", () => {
	const mac = machineReport();
	assert.throws(() => placementFeature([{ ...mac, screenshots: false }], { screenshots: true }), /screenshot/i);
	for (const [needs, reason] of [[{ tags: ["gpu"] }, /gpu/], [{ profile: "docker-windlass-sandbox" }, /profile/],
		[{ egress: "open" }, /egress/], [{ harness: "claude" }, /only with Windlass/]] as const)
		assert.throws(() => placementFeature([mac], needs as PlacementNeeds), reason);
	assert.doesNotThrow(() => placementFeature([mac], { tags: ["build", "os:darwin", "arch:arm64", "screenshots", "harness:windlass"] }));
});
test("placement 3 measures requested CPU and memory in sandbox units", () => {
	const mac = machineReport();
	assert.throws(() => placementFeature([mac], { cpus: 8 }), /slots|units/i);
	const sized = { ...mac, slots: { max: 3, busy: 1, queued: 0, unit: { cpus: 4, memoryBytes: 4 * GiB, pids: 1024 } } };
	const item = placementFeature([sized], { cpus: 8, memoryGiB: 8 });
	assert.equal(dispatch(item, [sized]).jobs![0].placement?.units, 2);
	// Three units use the four-slot size class, clamped to the configured capacity.
	for (const max of [3, 4]) {
		const roomy = { ...sized, slots: { ...sized.slots, busy: 0, max } };
		assert.equal(dispatch(placementFeature([roomy], { cpus: 12 }), [roomy]).jobs![0].placement?.units, max);
	}
	const legacy = machineReport("Mac", macId, { host: { ...mac.host!, sandboxCpus: 4 } });
	for (const needs of [{ cpus: 8 }, { memoryGiB: 2 }]) {
		assert.throws(() => placementFeature([legacy], needs), /Mac.*sizing beyond one slot/i);
	}
	assert.match(proposed(proposal()).question!.text, /sizing beyond one slot/i);
});
test("placement 4 waits for slots unless both overflow and that alternative are approved", () => {
	const full = machineReport("Mac", macId, { turns: { running: 4, max: 4, queued: 1 } });
	const linux = machineReport("Linux box", linuxId);
	const machines = [full, linux];
	for (const [allow, overflow] of [[["Linux box"], false], [[], true]] as const) {
		// A busy machine is a wait: approval allows it and the feature waits for a slot.
		const approved = placementFeature(machines, {}, [...allow], overflow);
		assert.equal(approved.featurePlan?.status, "approved");
		const item = dispatch(approved, machines);
		assert.match(item.wait!.sentence, /Waiting for 1 free slot on ‘Mac’/);
		assert.equal(item.question, null);
	}
	const alternative = dispatch(placementFeature(machines, {}, ["Linux box"], true), machines);
	assert.deepEqual(alternative.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
});
test("approval refuses only a permanent placement problem: busy, offline or short of disk waits or asks after approval", () => {
	const mac = machineReport(), linux = machineReport("Linux box", linuxId);
	const offline = { ...mac, status: "offline" as const, turns: { max: null, running: 0, queued: 0 }, profiles: [], freeDiskBytes: null };
	const busy = { ...mac, turns: { running: 4, max: 4, queued: 0 } };
	for (const machines of [[offline], [busy], [offline, { ...linux, orchestrator: "never" as const }]]) {
		const approved = placementFeature(machines, {}, machines.length > 1 ? ["Linux box"] : [], true);
		assert.equal(approved.featurePlan?.status, "approved");
		const item = dispatch(approved, machines);
		assert.equal(item.wait?.reason, "machine");
		assert.equal(item.question, null);
	}
	// An offline machine keeps its last report: a capability it lacks still refuses, as does an owner policy.
	assert.throws(() => placementFeature([{ ...offline, screenshots: false }], { screenshots: true }), /Mac.*screenshots/);
	assert.throws(() => placementFeature([{ ...offline, orchestrator: "never" }]), /Mac.*never/);
	assert.throws(() => placementFeature([offline, { ...linux, orchestrator: "never" }], { tags: ["gpu"] }, ["Linux box"], true), /Mac.*gpu.*Linux box.*never/);
	// A machine that never reported is judged when it connects.
	const unreported = { ...offline, status: "waiting" as const, egress: undefined, screenshots: undefined };
	assert.equal(placementFeature([unreported], { screenshots: true }).featurePlan?.status, "approved");
	// Low disk is not permanent: approval allows it, and dispatch asks the owner, who can retry.
	const full = { ...mac, freeDiskBytes: 5 * GiB - 1 };
	const asked = dispatch(placementFeature([full]), [full]);
	assert.equal(asked.question?.kind, "placement_refused");
	assert.match(asked.question!.text, /disk/);
	const retried = advance(asked, { kind: "answer", choice: "again", question: asked.question!.id, at: 8, by: "owner" }).item;
	assert.deepEqual(dispatch(retried, [mac]).jobs![0].placement?.place, { kind: "machine", machineId: macId });
});
test("a removed machine or changed policy asks the owner at dispatch and at launch", () => {
	const mac = machineReport();
	const ready = placementFeature([mac]);
	const placed = dispatch(ready, [mac]);
	for (const machines of [[], [{ ...mac, orchestrator: "never" as const }]]) {
		const pending = dispatch(ready, machines);
		const late = advance(placed, { kind: "placement_wait", child: placed.jobs![0].id, key: currentKey(placed)!, at: 8, sentence: pending.wait!.sentence, refused: true }).item;
		for (const item of [pending, late]) {
			assert.equal(item.wait?.reason, "person");
			assert.equal(item.wait?.retryAt, null);
			assert.match(item.question!.text, /Mac/);
			assert.ok(!item.question!.text.includes(macId));
			const answer = (choice: "revise" | "again" | "give_up") => advance(item, { kind: "answer", choice, question: item.question!.id, at: 9, by: "owner" });
			assert.equal(answer("revise").item.run?.step.kind, "refine");
			assert.ok(answer("again").effects.some(e => e.kind === "dispatch"));
			const cancelled = answer("give_up");
			assert.ok(cancelled.item.jobs!.at(-1)?.cancelRequested);
			assert.ok(cancelled.effects.some(e => e.kind === "cancel_children"));
		}
	}
});

test("retrying a refused placement can launch on a newly available approved alternative", () => {
	const mac = machineReport(), linux = machineReport("Linux box", linuxId);
	const ready = placementFeature([mac, linux], {}, ["Linux box"], true);
	const denied = dispatch(ready, [{ ...linux, orchestrator: "never" }]);
	assert.equal(denied.question?.kind, "placement_refused");
	const retry = advance(denied, { kind: "answer", choice: "again", question: denied.question!.id, at: 8, by: "owner" }).item;
	const placed = dispatch(retry, [linux]);
	assert.deepEqual(placed.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
});

test("placement 5 enforces owner participation and explicit naming", () => {
	const named = machineReport("Mac", macId, { orchestrator: "named" });
	assert.equal(machineDetails({ whenToUse: "", tags: [] }).orchestrator, "yes");
	assert.throws(() => machineDetails({ whenToUse: "", tags: [], orchestrator: "sometimes" } as never));
	assert.throws(() => placementFeature([{ ...named, orchestrator: "never" }]), /never/i);
	assert.deepEqual(dispatch(placementFeature([named]), [named]).jobs![0].placement?.place, { kind: "machine", machineId: macId });
	const p = proposal(), pending = proposed(p);
	pending.place = { kind: "machine", machineId: macId };
	assert.throws(() => advance(pending, { kind: "approve_plan", at: 4, by: "owner", version: 1, inventory: { machines: plannerMachines([named]), hostedProfiles: [] } }), /named/i);
});
test("placement 6 keeps the running child pinned and waits for an offline machine at the next boundary", () => {
	const mac = machineReport(), offline = { ...mac, status: "offline" as const, turns: { max: null, running: 0, queued: 0 } };
	const first = dispatch(placementFeature([mac]), [mac]);
	const working = advance(first, { kind: "child_update", key: currentKey(first)!, child: first.jobs![0].id, state: "working", head: null, report: "", spent: zero, at: 7 }).item;
	assert.equal(dispatch(working, [offline]), working);
	const second = advance(working, { kind: "child_update", key: currentKey(working)!, child: working.jobs![0].id, state: "done", head, report: "", spent: zero, at: 8 }).item;
	const waiting = dispatch(second, [{ ...offline, profiles: [], freeDiskBytes: null }]);
	assert.match(waiting.wait!.sentence, /Mac.*online/);
	assert.deepEqual(waiting.jobs![0].placement?.place, { kind: "machine", machineId: macId });
});
test("placement 7 scores available slots, queue, personal turns and direct dependencies", () => {
	const mac = machineReport("Mac", macId, { turns: { max: 4, running: 4, queued: 0 } });
	const linux = machineReport("Linux box", linuxId, { host: { ...mac.host!, cpus: 2 } });
	const machines = [mac, linux];
	const chosen = dispatch(placementFeature(machines, {}, ["Linux box"], true), machines);
	assert.deepEqual(chosen.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
	const next = advance(chosen, { kind: "child_update", key: currentKey(chosen)!, child: chosen.jobs![0].id, state: "done", head, report: "", spent: zero, at: 7 }).item;
	const busy = { ...mac, turns: { max: 4, running: 3, queued: 1 } }; // 3 preferred + 1 free - 1 queued = 3
	assert.deepEqual(dispatch(next, [busy, linux]).jobs![1].placement?.place, { kind: "machine", machineId: linuxId }); // 3 free + 1 warm
	assert.deepEqual(dispatch(next, [busy, { ...linux, personalRunning: 2 }]).jobs![1].placement?.place, { kind: "machine", machineId: macId });
});

async function childCreation(t: import("node:test").TestContext, overflow = false) {
	const { itemActions, ITEM_TABLES } = await import("../server/src/actors/user-items.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { DatabaseSync } = await import("node:sqlite");
	const mac = machineReport("Mac", macId, {
		allowedProfiles: ["docker-windlass-sandbox", "docker-hardened"],
		profiles: ["docker-windlass-sandbox", "docker-hardened"].map(id => ({ id, available: true } as never)), slots: { max: 3, busy: 0, queued: 0, unit: { cpus: 4, memoryBytes: 4 * GiB, pids: 1024 } } });
	const linux = { ...mac, machineId: linuxId, name: "Linux box" };
	const feature = placementFeature([mac, linux], { cpus: 8 }, ["Linux box"], overflow);
	const selected = dispatch(feature, [mac]), job = selected.jobs![0];
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	for (const sql of ITEM_TABLES) raw.exec(sql);
	const owner = "u_fixture", sessionId = "s_feature", repository = { id: 42, branch: "main" };
	const request = { job: { ...job, dispatchKey: currentKey(selected)! }, sessionId, feature: { ...feature, title: "Feature", repository, source: "web" }, context: "{}", previous: { place: { kind: "machine", machineId: macId }, head, report: "Prior subtask report" } };
	const machines = new Map([[macId, mac], ...(overflow ? [[linuxId, linux] as const] : [])]);
	const itemIndex = new Map();
	let child: typeof feature | undefined;
	const facts: import("../server/src/factory/types.js").Fact[] = [];
	const parent = { internalChildRequest: async () => request, internalFact: async (fact: typeof facts[number]) => facts.push(fact) };
	const childActor = { internalSummary: async () => ({ ...child, title: "Child", createdAt: 1, sessionId: "s_child" }), internalView: async () => child, internalAct: async () => child };
	const ctx = { key: [owner], conn: { params: serviceParams() }, broadcast() {}, log: { error() {}, warn() {} },
		vars: { usage: { modelTokens: () => 0 }, items: { items: itemIndex, limits: { id: 0, overrides: {} } }, profile: { uid: owner }, sessions: new Map([[sessionId, { profile: "docker-hardened", place: { kind: "hosted" } }]]), machines },
		db: { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args) },
		client: () => ({ workItem: { get: ([, id]: string[]) => id === job.id ? childActor : parent,
			create: async (_key: string[], { input }: { input: { item: typeof feature } }) => { child = input.item; } } }) };
	const delivered: { place: unknown; size?: number; profile?: string }[] = [];
	const create = (cancel = false) => itemActions.internalFeatureChild(ctx as never, { parent: feature.id, child: job.id, cancel }, async (_c, _owner, input, _submission, origin) => {
		delivered.push({ place: input.place, size: origin.size, profile: input.profile });
		return { ...input, repository, id: origin.sessionId } as never;
	});
	return { create, delivered, facts, machines, mac, raw, child: () => child };
}

test("session sandbox creation retains a reported multi-slot size for replacement", async () => {
	const { sessionSandboxInput } = await import("../server/src/actors/internal.js");
	const origin = { kind: "item" as const, role: "builder" as const, itemId: "i_child", size: 2 };
	assert.equal(sessionSandboxInput({ uid: "owner", sessionId: "child", profile: "docker-hardened", origin }).size, 2);
});

test("child creation sends the chosen machine and size to its session and preserves them on replay", async t => {
	const { create, delivered, machines, mac, child } = await childCreation(t);
	await create();
	assert.deepEqual(delivered, [{ place: { kind: "machine", machineId: macId }, size: 2, profile: "docker-hardened" }]);
	assert.deepEqual(child()?.place, delivered[0].place);
	assert.equal(child()?.placement?.reason, "Build on the owner's machine");
	machines.set(macId, { ...mac, status: "offline" });
	await create();
	assert.equal(delivered.length, 1);
});

test("child creation rechecks the owner's policy after dispatch", async t => {
	const { create, delivered, facts, machines, mac } = await childCreation(t);
	machines.set(macId, { ...mac, orchestrator: "never" });
	await create();
	assert.deepEqual(delivered, []);
	assert.equal(facts[0]?.kind, "placement_wait");
	assert.ok(facts[0]?.kind === "placement_wait" && facts[0].refused && facts[0].sentence.includes("Mac"));
});

test("cancelling a placement wait creates no child session", async t => {
	const { create, delivered } = await childCreation(t);
	await create(true);
	assert.deepEqual(delivered, []);
});

test("budget-only edits from older forms retain the approved overflow choice", () => {
	const plan = proposal();
	plan.overflow = true;
	const pending = proposed(plan);
	const { overflow, ...edit } = plan;
	const edited = advance(pending, { kind: "edit_plan", version: 1, plan: edit, at: 4, by: "owner" }).item;
	assert.equal(edited.featurePlan?.overflow, true);
});

test("unknown hard requirements cannot disappear during plan validation", () => {
	const p = proposal();
	Object.assign(p.subtasks[0], { needs: { memoryGB: 16 } });
	assert.throws(() => proposed(p), /memoryGB/);
});

test("a limited account waits or uses an approved alternative at the child boundary", () => {
	const machines = [machineReport(), machineReport("Linux box", linuxId)];
	for (const overflow of [false, true]) {
		const item = placementFeature(machines, {}, ["Linux box"], overflow);
		const selected = advance(item, { kind: "place_child", key: currentKey(item)!, at: 6, inventory: {
			machines: plannerMachines(machines), hostedProfiles: [], limited: [{ machineId: macId, harness: "windlass" }],
		} }).item;
		if (overflow) assert.deepEqual(selected.jobs![0].placement?.place, { kind: "machine", machineId: linuxId });
		else assert.match(selected.wait!.sentence, /usage limit.*Mac/);
	}
});

test("fresh placement retries the soonest approved wait and caps a long provider reset", () => {
	const at = 1000, hour = 3600_000;
	const machines = [machineReport(), machineReport("Linux box", linuxId, { turns: { running: 1, max: 1, queued: 0 } })];
	const place = (overflow: boolean, reset: number) => {
		const item = placementFeature(machines, {}, ["Linux box"], overflow);
		return advance(item, { kind: "place_child", at, key: currentKey(item)!, inventory: {
			machines: plannerMachines(machines), hostedProfiles: [], limited: [{ machineId: macId, harness: "windlass", limitedUntil: at + reset }],
		} });
	};
	for (const [overflow, reset, delay] of [[true, 4 * hour, 30_000], [true, 10_000, 10_000], [false, 168 * hour, 6 * hour]] as const) {
		const result = place(overflow, reset);
		assert.equal(result.item.wait?.retryAt, at + delay);
		assert.equal(result.effects.find(e => e.kind === "dispatch")?.at, at + delay);
	}
});

test("provider placement rechecks at UTC rollover when the daily cap also holds", () => {
	const machines = [machineReport()];
	const item = placementFeature(machines);
	const midnight = Date.UTC(2026, 10, 23), at = midnight - 1000, providerUntil = midnight + 3600_000;
	const key = currentKey(item)!;
	const inventory = { machines: plannerMachines(machines), hostedProfiles: [], dailyTokenWait: "Daily tokens used.",
		limited: [{ machineId: "*", harness: "windlass", limitedUntil: providerUntil }] };
	for (const result of [advance(item, { kind: "place_child", key, at, inventory }),
		advance(item, { kind: "placement_wait", key, child: item.jobs![0].id, at, dailyCap: true, providerUntil, sentence: "Waiting." })]) {
		assert.equal(result.item.wait?.retryAt, midnight);
		assert.equal(result.effects.find(e => e.kind === "dispatch")?.at, midnight);
	}
});

test("shared Windlass cooldown covers hosted and every approved machine, in either order", () => {
	const machines = [machineReport(), machineReport("Linux box", linuxId)];
	for (const prefer of ["Mac", "hosted"]) {
		const item = placementFeature(machines, {}, prefer === "Mac" ? ["Linux box", "hosted"] : ["Mac"], true, prefer);
		const result = advance(item, { kind: "place_child", at: 6, key: currentKey(item)!, inventory: {
			machines: plannerMachines(machines), hostedProfiles: ["docker-hardened"], limited: [{ machineId: "*", harness: "windlass", limitedUntil: 1000 }],
		} });
		assert.equal(result.item.wait?.reason, "provider");
		assert.equal(result.item.jobs![0].placement, undefined);
	}
});

test("hosted requires an approved route and a deployment profile", () => {
	const mac = machineReport();
	const item = placementFeature([mac]);
	assert.match(dispatch(item, []).wait!.sentence, /no longer one of your machines/);
	const p = proposal();
	p.subtasks[0].place = { prefer: "hosted", reason: "Use the hosted sandbox" };
	assert.throws(() => advance(proposed(p), { kind: "approve_plan", version: 1, by: "person", at: 5,
		inventory: { machines: plannerMachines([mac]), hostedProfiles: [] } }), /hosted.*profile/);
});

test("a Plan-first subtask that asks for Claude Code or OpenCode is refused, in the plan and in placement", () => {
	const both = [{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token" }, { id: "opencode", adapter: "fixture", image: "fixture", signIn: "token" }] as const;
	const mac = machineReport("Mac", macId, { harnesses: [...both], profiles: [{ id: "docker-windlass-sandbox", available: true }, { id: "docker-hardened", available: true }] as never, allowedProfiles: ["docker-windlass-sandbox", "docker-hardened"] });
	for (const [harness, name] of [["claude", "Claude Code"], ["opencode", "OpenCode"]] as const) {
		// Plan validation: a planner (which item text can steer) cannot pick an agent that works without asking.
		const p = proposal();
		p.subtasks[0].needs = { harness };
		assert.throws(() => proposed(p), new RegExp(`runs only with Windlass, not ${name}`));
		assert.throws(() => placementFeature([mac], { harness }), new RegExp(`runs only with Windlass, not ${name}`));
		// Placement, for a plan that did not come through validation: refused even on a machine signed into it, online or never reported.
		const task = { ...proposal().subtasks[0], place: { prefer: "Mac", reason: "here" }, needs: { harness } };
		const route = { preferred: { kind: "machine" as const, machineId: macId }, alternatives: [] };
		for (const machine of [mac, machineReport("Mac", macId, { status: "offline", egress: undefined, harnesses: [...both] })]) {
			const fit = choosePlacement(task, route, { machines: plannerMachines([machine]), hostedProfiles: ["docker-hardened"] });
			assert.equal(fit.decision, undefined);
			assert.match(String(fit.refused), new RegExp(`runs only with Windlass, not ${name}`));
			assert.equal(fit.permanent, true);
		}
	}
	// Windlass children keep the machine's first allowed profile and name no harness.
	const windlass = dispatch(placementFeature([mac], { harness: "windlass" }), [mac]).jobs![0].placement;
	assert.equal(windlass?.harness, undefined);
	assert.equal(windlass?.profile, "docker-windlass-sandbox");
	const p = proposal();
	p.subtasks[0].needs = { harness: "nonesuch" as never };
	assert.throws(() => proposed(p), /supported harness/);
});

test("5c.5 a Windlass limit still gates every approved machine at child creation", async t => {
	for (const overflow of [false, true]) {
		const { raw, create, delivered, facts } = await childCreation(t, overflow);
		const until = Date.now() + 3600_000;
		raw.exec("CREATE TABLE machines(id TEXT PRIMARY KEY, facts TEXT, expires INTEGER); CREATE TABLE signin(id INTEGER, generation INTEGER)");
		raw.prepare("INSERT INTO machines VALUES(?, '{}', NULL)").run(macId);
		raw.exec("CREATE TABLE IF NOT EXISTS provider_usage(place TEXT,harness TEXT,generation TEXT,data TEXT,PRIMARY KEY(place,harness))");
		const { recordProviderUsage } = await import("../server/src/actors/provider-accounts.js");
		type Db = Parameters<typeof recordProviderUsage>[0];
		const db = { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args),
			transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db) } as Db;
		await recordProviderUsage(db, { place: macId, harness: "windlass" }, "0", { kind: "refusal", at: Date.now(), resetsAt: until - 60_000 });
		await create();
		assert.equal(delivered.length, 0);
		assert.ok(facts[0]?.kind === "placement_wait" && !facts[0].refused && facts[0].providerUntil === until);
	}
});

test("5c.2 unknown resets back off per login, and only a successful real probe clears the streak", async t => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables } = await import("../server/src/actors/user-machines.js");
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	type Db = Parameters<typeof machineTables>[0];
	const db = { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args),
		transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db) } as Db;
	await machineTables(db);
	raw.exec("CREATE TABLE signin(id INTEGER, generation INTEGER); INSERT INTO signin VALUES(1,1)");
	assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='provider_usage'").get(), "the user has no account cooldown ledger");
	const { recordProviderUsage, providerAccounts } = await import("../server/src/actors/provider-accounts.js");
	const location = { place: "hosted", harness: "windlass" as const };
	let now = Date.now();
	for (const minutes of [15, 30, 60, 120, 240, 300, 300]) {
		const refusal = { kind: "refusal" as const, at: now, resetsAt: null };
		await recordProviderUsage(db, location, "1", refusal);
		await recordProviderUsage(db, location, "1", refusal);
		assert.deepEqual(raw.prepare("SELECT place FROM provider_usage WHERE harness='windlass'").all().map(r => r.place), ["*"]);
		const account = (await providerAccounts(db, now)).get("*")?.[0];
		assert.equal(account?.state, "limited");
		assert.equal(account.limitedUntil, now + minutes * 60_000);
		now = account.limitedUntil!;
		assert.equal((await providerAccounts(db, now)).get("*")?.[0].state, "ok");
	}
	await recordProviderUsage(db, location, "1", { kind: "success", startedAt: now, at: now + 1 });
	await recordProviderUsage(db, location, "1", { kind: "refusal", at: now + 2, resetsAt: null });
	assert.equal((await providerAccounts(db, now + 2)).get("*")?.[0].limitedUntil, now + 2 + 15 * 60_000);
});

test("legacy Windlass rows retain the longest cooldown for the latest sign-in on upgrade", async t => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables } = await import("../server/src/actors/user-machines.js");
	const { PROVIDER_TABLE, providerAccounts } = await import("../server/src/actors/provider-accounts.js");
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	const db = { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args) } as Parameters<typeof machineTables>[0];
	raw.exec(PROVIDER_TABLE);
	raw.exec("CREATE TABLE signin(id INTEGER, generation INTEGER); INSERT INTO signin VALUES(1,2)");
	for (const [place, generation, until] of [[macId, "1", 900], ["hosted", "2", 200], [linuxId, "2", 400]] as const) {
		const account = { key: `${place}/windlass/${generation}`, harness: "windlass", state: "limited", limitedUntil: until, windows: [] };
		raw.prepare("INSERT INTO provider_usage VALUES(?,?,?,?)").run(place, "windlass", generation, JSON.stringify({ account, backoff: 1, lastRefusal: 1, lastSuccess: -1 }));
	}
	await machineTables(db);
	await machineTables(db);
	const accounts = await providerAccounts(db, 100);
	assert.equal(accounts.get("*")?.[0]?.key, "*/windlass/2");
	assert.equal(accounts.get("*")?.[0]?.limitedUntil, 400);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM provider_usage").get()?.n, 1);
});

test("5c.7 new machine login ignores a stale refusal; page and stored reading contain only public window data", async t => {
	const { DatabaseSync } = await import("node:sqlite");
	const { machineTables, listMachines } = await import("../server/src/actors/user-machines.js");
	const raw = new DatabaseSync(":memory:");
	t.after(() => raw.close());
	type Db = Parameters<typeof machineTables>[0];
	const db = { execute: async (sql: string, ...args: never[]) => raw.prepare(sql).all(...args),
		transaction: async <T>(work: (tx: Db) => Promise<T>) => work(db) } as Db;
	await machineTables(db);
	const generation = "a".repeat(32), next = "b".repeat(32), at = Date.now();
	const facts = (loginGeneration: string) => JSON.stringify({ status: "online", report: { docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: null, sandboxes: [],
		harnesses: [{ id: "claude", adapter: "fixture", image: "fixture", signIn: "token", loginGeneration }] } });
	raw.prepare("INSERT INTO machines(id, name,os,arch,facts) VALUES(?, 'Mac','darwin','arm64',?)").run(macId, facts(generation));
	assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='provider_usage'").get(), "new logins have no account state to reset");
	const { recordProviderUsage, providerAccounts } = await import("../server/src/actors/provider-accounts.js");
	const { claudeLimit } = await import("../server/src/provider-usage.js");
	const location = { place: macId, harness: "claude" as const };
	const reset = Math.floor(at / 1000) + 7200;
	const event = claudeLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: reset, utilization: 1, email: "canary@example.invalid", token: "canary-token", accountId: "canary-account" }, at)!;
	await recordProviderUsage(db, location, generation, { kind: "event", event });
	assert.equal((await providerAccounts(db, at)).get(macId)?.[0].limitedUntil, reset * 1000);
	await recordProviderUsage(db, location, generation, { kind: "refusal", at: at + 1, resetsAt: reset * 1000 });
	await recordProviderUsage(db, location, generation, { kind: "event", event: { status: "allowed", window: { ...event.window, usedPct: 0, observedAt: at + 2 } } });
	const [machine] = await listMachines({ db, vars: { sessions: new Map() } });
	assert.equal(machine?.providerAccounts?.[0].limitedUntil, reset * 1000 + 60_000);
	assert.doesNotMatch(JSON.stringify([machine, raw.prepare("SELECT * FROM provider_usage").all()]), /canary/);
	raw.prepare("UPDATE machines SET facts=? WHERE id=?").run(facts(next), macId);
	assert.equal(await recordProviderUsage(db, location, generation, { kind: "refusal", at: at + 3, resetsAt: null }), false);
	assert.equal((await providerAccounts(db, at + 3)).size, 0);
});
