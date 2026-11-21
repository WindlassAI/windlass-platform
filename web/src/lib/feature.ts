/**
 * Orchestrated work items ("features"), as the web client says them and checks them before sending:
 * how an item runs, and the budget rules of a plan (server/src/factory/feature-plan.ts, `validatePlan`),
 * so that a figure the server would refuse is said at its field.
 */
import type { FeaturePlan, ItemBudget } from "@contract";
import { compact, sandboxTime } from "./format";

/** How a work item runs, in the words of the composer's pill and the filing dialog. */
export const ITEM_MODE_WORDS = {
	single: { name: "Quick", description: "One implementer starts directly, without a planning turn." },
	orchestrate: { name: "Plan first", description: "Approve a plan, then one implementer follows it or the planned subtasks run." },
} as const;

/** Why an orchestrated plan could not be approved on this repository, as far as the page can tell before filing: null when nothing is known against it. */
export function orchestrateProblem(checks: number | null): string | null {
	return checks === 0 ? "No checks are saved for this repository. Save checks before approving subtasks, or run the plan with one implementer." : null;
}

export const PLAN_DIMENSIONS = ["tokens", "turns", "activeSeconds", "hostedSeconds"] as const;

/** The least a subtask may be given in each figure: two turns, and a tenth of a single item's tokens and times (at least 1,000 tokens and a minute). */
export function subtaskFloor(single: ItemBudget): ItemBudget {
	return {
		tokens: Math.max(1000, Math.ceil(single.tokens / 10)),
		turns: 2,
		activeSeconds: Math.max(60, Math.ceil(single.activeSeconds / 10)),
		hostedSeconds: Math.max(60, Math.ceil(single.hostedSeconds / 10)),
	};
}

/** What the feature keeps back for its summary, its review and a retry of each. */
export function closingReserve(single: ItemBudget): ItemBudget {
	return { tokens: Math.ceil(single.tokens / 6), turns: 4, activeSeconds: Math.ceil(single.activeSeconds / 6), hostedSeconds: Math.ceil(single.hostedSeconds / 6) };
}

/**
 * What the subtasks may share (server/src/factory/blueprint.ts, `edit_plan`): the feature's budget less
 * what it spent and the closing reserve, with back what subtasks that are done were given (a re-plan
 * keeps them as they were).
 */
export function subtaskPool(plan: Pick<FeaturePlan, "budget" | "compare">, spent: ItemBudget, done: ItemBudget[] = []): ItemBudget {
	const reserve = closingReserve(plan.compare.singleBudget);
	const back = sumBudgets(done);
	const pool = { ...plan.budget };
	for (const key of PLAN_DIMENSIONS) pool[key] = plan.budget[key] - spent[key] - reserve[key] + back[key];
	return pool;
}

export function sumBudgets(budgets: ItemBudget[]): ItemBudget {
	const total: ItemBudget = { tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 };
	for (const budget of budgets) for (const key of PLAN_DIMENSIONS) total[key] += budget[key];
	return total;
}

export type BudgetProblem = "low" | "high" | "bad";

/**
 * What is wrong with a plan's subtask budgets, as the server checks them: per subtask and figure (not
 * a whole number, under the floor, over a single item's cap), and the figures whose total is over the
 * pool. Empty when the server would take them.
 */
export function budgetProblems(single: ItemBudget, pool: ItemBudget, budgets: Record<string, ItemBudget>): { fields: Record<string, Partial<Record<keyof ItemBudget, BudgetProblem>>>; total: Array<keyof ItemBudget>; any: boolean } {
	const floor = subtaskFloor(single);
	const fields: Record<string, Partial<Record<keyof ItemBudget, BudgetProblem>>> = {};
	let any = false;
	for (const [key, budget] of Object.entries(budgets)) {
		for (const dimension of PLAN_DIMENSIONS) {
			const value = budget[dimension];
			const problem: BudgetProblem | null = !Number.isSafeInteger(value) ? "bad" : value < floor[dimension] ? "low" : value > single[dimension] ? "high" : null;
			if (problem) {
				(fields[key] ??= {})[dimension] = problem;
				any = true;
			}
		}
	}
	const sum = sumBudgets(Object.values(budgets));
	const total = PLAN_DIMENSIONS.filter((dimension) => sum[dimension] > pool[dimension]);
	return { fields, total, any: any || total.length > 0 };
}

/** A plan's budget figure as a field: tokens in millions, times in minutes. `spelled` says a figure in the page's words. */
export interface PlanField {
	key: keyof ItemBudget;
	label: string;
	short: string;
	unit: string;
	toInput(value: number): string;
	fromInput(text: string): number;
	spelled(value: number): string;
}

const trimmed = (value: number) => String(Number(value.toFixed(2)));
const parse = (text: string, scale: number) => {
	const value = text.trim() === "" ? Number.NaN : Number(text);
	return Number.isFinite(value) ? Math.round(value * scale) : Number.NaN;
};

export const PLAN_FIELDS: PlanField[] = [
	{ key: "tokens", label: "Tokens", short: "tokens", unit: "M", toInput: (value) => trimmed(value / 1e6), fromInput: (text) => parse(text, 1e6), spelled: compact },
	{ key: "turns", label: "Turns", short: "turns", unit: "", toInput: String, fromInput: (text) => parse(text, 1), spelled: String },
	{ key: "activeSeconds", label: "Working time", short: "working", unit: "min", toInput: (value) => trimmed(value / 60), fromInput: (text) => parse(text, 60), spelled: sandboxTime },
	{ key: "hostedSeconds", label: "Hosted time", short: "hosted", unit: "min", toInput: (value) => trimmed(value / 60), fromInput: (text) => parse(text, 60), spelled: sandboxTime },
];
