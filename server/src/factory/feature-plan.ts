import type { FeaturePlanEdit, ItemBudget, PlanSubtask } from "../contract.js";
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "../contract.js";

export const dimensions = ["tokens", "turns", "activeSeconds", "hostedSeconds"] as const;
export const emptyBudget = (): ItemBudget => ({ tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 });
export function featureCap(single: ItemBudget): ItemBudget {
	const cap = emptyBudget();
	for (const key of dimensions) cap[key] = 3 * single[key];
	return cap;
}

function requirePlan(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> {
	requirePlan(value && typeof value === "object" && !Array.isArray(value), "Expected a plan object.");
	return value as Record<string, unknown>;
}

function text(value: unknown, max = MAX_NOTE_CHARS): string {
	requirePlan(typeof value === "string" && value.trim() && value.length <= max, `Expected nonempty text of at most ${max} characters.`);
	return value.trim();
}

function lines(value: unknown, min = 0, max = MAX_ACCEPTANCE_CRITERIA): string[] {
	requirePlan(Array.isArray(value) && value.length >= min && value.length <= max, `Expected ${min} to ${max} entries.`);
	return value.map(line => text(line));
}

function keyOf(value: unknown): string {
	requirePlan(typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value), "Use a short stable key starting with a letter.");
	return value;
}

function unique(keys: string[]) {
	requirePlan(new Set(keys).size === keys.length, "Keys must be unique.");
}

export function validatePlan(value: unknown, single: ItemBudget, available: ItemBudget): FeaturePlanEdit {
	const p = record(value), spec = record(p.spec);
	const singleSuggested = p.singleSuggested == null ? null : text(p.singleSuggested);
	requirePlan(Array.isArray(p.questions) && p.questions.length <= 16, "Use at most 16 plan questions.");
	const questions = p.questions.map(raw => {
		const q = record(raw);
		return { id: keyOf(q.id), text: text(q.text), ...(q.options !== undefined && { options: lines(q.options, 1, 12) }), ...(q.answer && { answer: text(q.answer) } || {}) };
	});
	unique(questions.map(q => q.id));
	requirePlan(Array.isArray(p.subtasks) && (singleSuggested && p.subtasks.length === 0 || p.subtasks.length >= 2 && p.subtasks.length <= 6), "Propose two to six subtasks or suggest one single item.");
	const total = emptyBudget();
	const subtasks: PlanSubtask[] = p.subtasks.map(raw => {
		const s = record(raw), asked = record(s.budget), budget = emptyBudget();
		for (const key of dimensions) {
			const n = asked[key];
			requirePlan(typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= single[key], `Subtask ${key} must be a whole number between 1 and ${single[key]}.`);
			budget[key] = n;
			total[key] += n;
			requirePlan(total[key] <= available[key], `Subtasks exceed the remaining ${key} budget.`);
		}
		const owns = lines(s.owns, 1, 32);
		for (const path of owns) requirePlan(/^[\w.*@/-]+$/.test(path) && path.split("/").every(part => part && ![".", "..", ".git"].includes(part)), "Use repository-relative owned path globs.");
		const dependsOn = lines(s.dependsOn, 0, 5).map(keyOf);
		unique(dependsOn);
		return { key: keyOf(s.key), title: text(s.title, MAX_TITLE_CHARS), brief: text(s.brief, MAX_ITEM_BODY_CHARS), acceptance: lines(s.acceptance, 1), owns, dependsOn, budget };
	});
	unique(subtasks.map(s => s.key));
	const done = new Set<string>();
	while (done.size < subtasks.length) {
		const next = subtasks.find(s => !done.has(s.key) && s.dependsOn.every(k => done.has(k)));
		requirePlan(next, "Dependencies must name existing subtasks and form an acyclic graph.");
		done.add(next.key);
	}
	return { questions, singleSuggested, subtasks, spec: { goal: text(spec.goal, 2000), acceptance: lines(spec.acceptance, 1), requirements: lines(spec.requirements), outOfScope: lines(spec.outOfScope) } };
}
