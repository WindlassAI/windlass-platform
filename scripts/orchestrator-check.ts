import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, advance, currentKey } from "../server/src/factory/blueprint.js";
import * as intake from "../server/src/factory/intake.js";
import { edge } from "../server/src/github/events.js";
import type { FeaturePlanEdit } from "../server/src/contract.js";

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
	assert.equal(entry.turns!.queued, 2); assert.equal(entry.whenToUse, "Big builds");
	assert.doesNotMatch(JSON.stringify(entry), /private|sendSecrets/);
});

function approved() {
	const item = proposed(proposal());
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
		const result = advance(pushed,ci as never);
		assert.equal(result.effects.some(e=>e.kind === "integrate"),checks);
		assert.equal(advance(result.item,ci as never).item,result.item);
		if (checks) {
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
	assert.ok(revised.item.question?.kind === "budget" || revised.item.run?.step.kind === "refine");
});
test("a second re-plan can move only unused allocation and a third stop cannot dispatch a planner", () => {
	let item = approved();
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
	const notice = {kind:"child_notice" as const, child:running.jobs![0].id, state:"done" as const, spent:{...zero, tokens:120}, at:6};
	const woke = advance(running, notice);
	assert.ok(woke.effects.some(e => e.kind === "dispatch"));
	const cancelled = advance(running, {kind:"cancel", at:7, by:"person"}).item;
	const settled = advance(cancelled, notice);
	assert.equal(settled.item.spent.tokens, 130);
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

test("the planner uses the highest advertised reasoning effort of its model", async () => {
	const {plannerEffort} = await import("../server/src/account-models.js");
	assert.equal(plannerEffort([{id:"requested",name:null,efforts:["medium","max","high"]}], "requested"),"max");
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
	const review = advance(item, ci as never).effects.find(e=>e.kind === "deliver");
	assert.ok(review?.to === "review" && review.reviewerInput?.task.body.includes("page evidence") && review.reviewerInput.task.body.includes("index evidence"));
	for (const blocked of [advance({...item,reviewer:{off:"deployment"}},ci as never), advance(item,{...ci,prHead:"b".repeat(40)} as never)]) {
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
	const asked = intake.issueMode("orchestrate", [], false);
	assert.match(asked.refusal!,/disabled/i);
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
