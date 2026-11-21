/**
 * Orchestrated work items ("features"), as the web client says them and checks them before sending:
 * how an item runs, and the budget rules of a plan (server/src/factory/feature-plan.ts, `validatePlan`),
 * so that a figure the server would refuse is said at its field.
 */
import type { FeaturePlan, ItemBudget } from "@contract";

/** How a work item runs, in the words of the composer's pill and the filing dialog. */
export const ITEM_MODE_WORDS = {
	single: { name: "Single", description: "One agent builds it and hands over one pull request." },
	orchestrate: { name: "Orchestrate", description: "For a new feature with several parts. A planner splits it into subtasks you approve." },
} as const;

/** Why an orchestrated plan could not be approved on this repository, as far as the page can tell before filing: null when nothing is known against it. */
export function orchestrateProblem(checks: number | null): string | null {
	return checks === 0 ? "No checks are saved for this repository, so a plan cannot be approved. File it as single, or save checks first." : null;
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

/** What the subtasks may share: the feature's budget less the closing reserve. */
export function subtaskPool(plan: Pick<FeaturePlan, "budget" | "compare">): ItemBudget {
	const reserve = closingReserve(plan.compare.singleBudget);
	return { tokens: plan.budget.tokens - reserve.tokens, turns: plan.budget.turns - reserve.turns, activeSeconds: plan.budget.activeSeconds - reserve.activeSeconds, hostedSeconds: plan.budget.hostedSeconds - reserve.hostedSeconds };
}

export function sumBudgets(budgets: ItemBudget[]): ItemBudget {
	const total: ItemBudget = { tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 };
	for (const budget of budgets) for (const key of PLAN_DIMENSIONS) total[key] += budget[key];
	return total;
}

/**
 * What is wrong with a plan's subtask budgets, as the server would say it: per subtask and figure, and
 * per figure for the total. Empty when the server would take them.
 */
export function budgetProblems(plan: Pick<FeaturePlan, "budget" | "compare">, budgets: Record<string, ItemBudget>): { fields: Record<string, Partial<Record<keyof ItemBudget, string>>>; total: Partial<Record<keyof ItemBudget, string>> } {
	const single = plan.compare.singleBudget;
	const floor = subtaskFloor(single);
	const pool = subtaskPool(plan);
	const fields: Record<string, Partial<Record<keyof ItemBudget, string>>> = {};
	for (const [key, budget] of Object.entries(budgets)) {
		for (const dimension of PLAN_DIMENSIONS) {
			const value = budget[dimension];
			if (!Number.isSafeInteger(value) || value < floor[dimension] || value > single[dimension]) (fields[key] ??= {})[dimension] = `between ${floor[dimension]} and ${single[dimension]}`;
		}
	}
	const sum = sumBudgets(Object.values(budgets));
	const total: Partial<Record<keyof ItemBudget, string>> = {};
	for (const dimension of PLAN_DIMENSIONS) if (sum[dimension] > pool[dimension]) total[dimension] = `over the ${pool[dimension]} the subtasks may share`;
	return { fields, total };
}
