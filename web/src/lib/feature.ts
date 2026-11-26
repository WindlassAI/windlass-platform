/**
 * Orchestrated work items ("features"), as the web client says them and checks them before sending:
 * how an item runs, and the budget rules of a plan (server/src/factory/feature-plan.ts, `validatePlan`),
 * so that a figure the server would refuse is said at its field.
 */
import type { FeaturePlan, ItemBudget, SubtaskBudget } from "@contract";

/** How a work item runs, in the words of the composer's pill and the filing dialog. */
export const ITEM_MODE_WORDS = {
	single: { name: "Quick", description: "One implementer starts directly, without a planning turn." },
	orchestrate: { name: "Plan first", description: "A planner files the plan for your approval. Then one implementer follows it or the planned subtasks run." },
} as const;

/** Why an orchestrated plan could not be approved on this repository, as far as the page can tell before filing: null when nothing is known against it. */
export function orchestrateProblem(checks: number | null): string | null {
	return checks === 0 ? "No checks saved." : null;
}

/** The least a subtask may be given: a tenth of a single item's tokens, and at least 1,000. */
export function subtaskFloor(single: Pick<ItemBudget, "tokens">): SubtaskBudget {
	return { tokens: Math.max(1000, Math.ceil(single.tokens / 10)) };
}

/**
 * What the feature may spend with the subtasks' budgets as edited (server/src/factory/blueprint.ts, `featureTotal`):
 * the plan's own figure, which counts its subtasks as filed, with the edits' difference.
 */
export function featureTotal(plan: Pick<FeaturePlan, "budget" | "subtasks">, budgets: Record<string, SubtaskBudget>): SubtaskBudget {
	let tokens = plan.budget.tokens;
	for (const task of plan.subtasks) tokens += (budgets[task.key]?.tokens ?? task.budget.tokens) - task.budget.tokens;
	return { tokens };
}

export function sumBudgets(budgets: Array<Pick<ItemBudget, "tokens">>): SubtaskBudget {
	return { tokens: budgets.reduce((sum, budget) => sum + budget.tokens, 0) };
}

export type BudgetProblem = "low" | "high" | "bad";

/**
 * What is wrong with a plan's subtask budgets, as the server checks them: per subtask (not a whole number,
 * under the floor, over a single item's). Their total is no limit: the feature's budget is what they come to.
 */
export function budgetProblems(single: Pick<ItemBudget, "tokens">, budgets: Record<string, SubtaskBudget>): { fields: Record<string, Partial<Record<keyof SubtaskBudget, BudgetProblem>>>; total: Array<keyof SubtaskBudget>; any: boolean } {
	const floor = subtaskFloor(single);
	const fields: Record<string, Partial<Record<keyof SubtaskBudget, BudgetProblem>>> = {};
	let any = false;
	for (const [key, budget] of Object.entries(budgets)) {
		const value = budget.tokens;
		const problem: BudgetProblem | null = !Number.isSafeInteger(value) ? "bad" : value < floor.tokens ? "low" : value > single.tokens ? "high" : null;
		if (problem) {
			(fields[key] ??= {}).tokens = problem;
			any = true;
		}
	}
	return { fields, total: [], any };
}

/** Subtask budgets are entered in millions of cost-weighted tokens. */
export const tokenInput = (tokens: number) => String(tokens / 1e6);

export function parseTokenInput(text: string): number {
	const value = text.trim() === "" ? Number.NaN : Number(text);
	return Number.isFinite(value) ? Math.round(value * 1e6) : Number.NaN;
}
