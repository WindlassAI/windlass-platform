/**
 * An item's budget as the screens say it (server/src/factory/budget.ts holds the rules): dollars where an API key
 * pays, a share of the plan's 5-hour window where a plan pays, tokens only where neither can be measured. Before a
 * turn has said what pays, both the dollar and the plan figure are shown: whichever pays holds it.
 */
import type { ItemBudget, ItemSpend } from "@contract";
import { budgetUnits, partShare, spellPct, spellTokens, spellUsd } from "../../../server/src/factory/budget.js";

export type MoneyFigure = "usd" | "planPct" | "tokens";

/** The figures that hold an item now, in the order a stop names them. */
export function heldFigures(budget: ItemBudget, spent: ItemSpend): MoneyFigure[] {
	const units = budgetUnits(budget, spent);
	const known = spent.usd !== undefined || spent.planPct !== undefined;
	const figures: MoneyFigure[] = [];
	if (budget.usd !== undefined && (units.usd || !known)) figures.push("usd");
	if (budget.planPct !== undefined && (units.planPct || !known)) figures.push("planPct");
	if (figures.length === 0 || spent.usdUnknown) figures.push("tokens");
	return figures;
}

/** One figure's amount: "$1.25", "5% of your 5-hour window", "400k tokens"; with `unit` false, "5%", "400k". */
export function figureWords(figure: MoneyFigure, value: number, unit = true): string {
	if (figure === "usd") return spellUsd(value);
	if (figure === "planPct") return unit ? `${spellPct(value)} of your 5-hour window` : spellPct(value);
	return unit ? `${spellTokens(value)} tokens` : spellTokens(value);
}

/**
 * What an item spent of its budget, in its units: "$0.40 of $1.25", "2% of 5% of your 5-hour window". Before it
 * spent anything it says what it may: "$1.25 or 5% of your 5-hour window".
 */
export function spendWords(budget: ItemBudget, spent: ItemSpend | null): string {
	if (!spent || spent.turns === 0) {
		const figures = heldFigures(budget, spent ?? { tokens: 0, hostedSeconds: 0, turns: 0, activeSeconds: 0 });
		return figures.map(figure => figureWords(figure, budget[figure] ?? 0)).join(" or ");
	}
	return heldFigures(budget, spent)
		.map(figure => `${figureWords(figure, spent[figure] ?? 0, false)} of ${figureWords(figure, budget[figure] ?? 0)}`)
		.join(" · ");
}

/** A part's budget from its planned tokens: an item's dollars and plan share in proportion (budget.ts `partShare`). */
export function partBudget(single: ItemBudget, tokens: number): ItemBudget {
	return { tokens, hostedSeconds: single.hostedSeconds, ...partShare(single, tokens) };
}

/** A tokens line for "How this is counted": the cost-weighted figure, and its budget where tokens hold. */
export function tokenDetail(budget: ItemBudget, spent: ItemSpend): string {
	const raw = spent.rawTokens ?? spent.tokens;
	const held = heldFigures(budget, spent).includes("tokens");
	return `${spellTokens(spent.tokens)} cost-weighted tokens (${spellTokens(raw)} as reported)${held ? ` of a ${spellTokens(budget.tokens)}-token budget` : ""}.`;
}

/** "$1.25", "5%": a budget figure without its unit's words. */
export const usdWords = spellUsd;
export const pctWords = spellPct;

const FIELD_LABELS: Record<MoneyFigure, string> = { usd: "Dollars", planPct: "Plan's 5-hour window", tokens: "Tokens" };

/** The rows of `ItemSpend` for the figures that hold an item now. */
export function moneyFields(
	budget: ItemBudget,
	spent: ItemSpend,
): Array<{ key: MoneyFigure; label: string; spelled(value: number): string }> {
	return heldFigures(budget, spent).map(key => ({
		key,
		label: FIELD_LABELS[key],
		spelled: value => figureWords(key, value, false),
	}));
}
