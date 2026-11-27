import type { ItemBudget, ItemSpend } from "@contract";
import { describe, expect, it } from "vitest";
import { heldFigures, moneyFields, partBudget, spendWords, tokenDetail } from "./budget";

const budget: ItemBudget = { tokens: 2_000_000, hostedSeconds: 7200, usd: 4, planPct: 20 };
const spent = (more: Partial<ItemSpend> = {}): ItemSpend => ({
	tokens: 900_000,
	rawTokens: 5_000_000,
	turns: 2,
	activeSeconds: 60,
	hostedSeconds: 30,
	...more,
});

describe("budget words", () => {
	it("says dollars where a key paid, and no tokens", () => {
		expect(heldFigures(budget, spent({ usd: 3 }))).toEqual(["usd"]);
		expect(spendWords(budget, spent({ usd: 3 }))).toBe("$3 of $4");
	});

	it("says the plan's 5-hour share where a plan paid", () => {
		expect(spendWords(budget, spent({ planPct: 2.5 }))).toBe("2.5% of 20% of your 5-hour window");
	});

	it("says what a part may use before it ran, in both units", () => {
		const part = partBudget(budget, 500_000);
		expect(part).toMatchObject({ usd: 1, planPct: 5, tokens: 500_000 });
		expect(spendWords(part, null)).toBe("$1 or 5% of your 5-hour window");
	});

	it("falls back to tokens where a key turn could not be priced, or the item has only tokens", () => {
		expect(heldFigures(budget, spent({ usd: 1, usdUnknown: true }))).toEqual(["usd", "tokens"]);
		expect(spendWords({ tokens: 2_000_000, hostedSeconds: 1 }, spent())).toBe("900k of 2M tokens");
	});

	it("keeps tokens as a detail", () => {
		expect(tokenDetail(budget, spent({ usd: 1 }))).toBe("900k cost-weighted tokens (5M as reported).");
		expect(moneyFields(budget, spent({ usd: 1 })).map(field => field.label)).toEqual(["Dollars"]);
	});
});
