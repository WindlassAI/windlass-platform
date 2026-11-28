// @vitest-environment jsdom
/** The Usage summary: the size and type tables, the retries and unfinished callouts, plan items, the empty period. */
import type { CostRates, FinishedItem, FinishedItems, SpendUsage } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { addTurn, noUsage, turnMeter } from "../../../server/src/factory/cost.js";
import { createMockClient } from "../api/mock";
import { SummaryBody } from "./CostSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RATES: CostRates = {
	models: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15 } },
	source: null,
	sandbox: { standard: 0.36 },
};

/** Turns of a million input tokens each: $3 on a key, nothing in dollars on the Claude plan. */
function used(turns: number, plan = false): SpendUsage {
	const usage = noUsage();
	for (let n = 0; n < turns; n++)
		addTurn(
			usage,
			turnMeter({
				harness: "windlass",
				model: "anthropic/claude-sonnet-4-5",
				key: { provider: "anthropic", generation: "g", ...(plan && { plan: true }) },
				usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
				size: "standard",
			}),
		);
	return usage;
}

function item(more: Partial<FinishedItem>): FinishedItem {
	return {
		id: "i_x",
		title: "An item",
		state: "done",
		size: "small",
		parts: 0,
		type: "feature",
		endedAt: 0,
		seconds: 600,
		usage: used(1),
		retryUsage: noUsage(),
		...more,
	};
}

function render(items: FinishedItem[]): HTMLElement {
	const host = document.createElement("div");
	const read: FinishedItems = { days: 30, since: 0, items };
	act(() => createRoot(host).render(createElement(SummaryBody, { read, rates: RATES })));
	return host;
}

/** A table's rows as text cells, by its caption. */
function rows(host: HTMLElement, caption: string): string[][] {
	const table = [...host.querySelectorAll("table")].find(one => one.caption?.textContent === caption);
	return [...(table?.querySelectorAll("tbody tr") ?? [])].map(row =>
		[...row.children].map(cell => cell.textContent ?? ""),
	);
}

const facts = (host: HTMLElement) =>
	Object.fromEntries(
		[...host.querySelectorAll(".cost-summary-facts > div")].map(row => [
			row.querySelector("dt")?.textContent,
			row.querySelector("dd")?.textContent,
		]),
	);

describe("the Usage summary", () => {
	it("groups done items by size and by type with median and p90 cost and time", () => {
		const host = render([
			item({ usage: used(1), seconds: 600 }),
			item({ usage: used(3), seconds: 1800 }),
			item({ size: "medium", parts: 2, type: "docs", usage: used(2), seconds: 3600 }),
		]);
		expect(rows(host, "By size")).toEqual([
			["Smallone item", "2", "$6.00", "$8.40", "20 min", "28 min", "$12.00 + $0.00"],
			["Mediuma feature of up to 3 parts", "1", "$6.00", "$6.00", "1 h", "1 h", "$6.00 + $0.00"],
		]);
		expect(rows(host, "By type").map(row => row[0])).toEqual([
			"Docsonly documentation",
			"Features and fixessource code changed",
		]);
	});

	it("says what was spent retrying and on items that did not finish", () => {
		const host = render([
			item({ usage: used(3), retryUsage: used(1) }),
			item({ state: "cancelled", usage: used(2) }),
			item({ state: "failed", usage: used(1, true) }),
		]);
		expect(facts(host)).toMatchObject({
			Ended: "3",
			Retries: "$3.00",
			"Not finished": "$6.00 + 1 turn on your plan",
		});
		expect(host.textContent).toContain("1 cancelled, 1 given up or failed");
	});

	it("never gives a plan's items dollars: on your plan, left out of the percentiles", () => {
		const host = render([item({ usage: used(2, true) }), item({ usage: used(1) })]);
		const [small] = rows(host, "By size");
		expect(small?.[0]).toBe("Smallone item1 priced · 1 on your plan");
		expect(small?.[1]).toBe("2");
		expect(small?.[2]).toBe("$3.00");
		const onlyPlan = render([item({ usage: used(2, true) })]);
		expect(rows(onlyPlan, "By size")[0]?.slice(2, 4)).toEqual(["On your plan", "On your plan"]);
		expect(facts(onlyPlan)["On your plan"]).toBe("2 turns");
	});

	it("says so when nothing ended in the period, and when nothing was done", () => {
		expect(render([]).textContent).toBe("No work items ended in the last 30 days.");
		const none = render([item({ state: "cancelled" })]);
		expect(none.querySelector("table")).toBeNull();
		expect(none.textContent).toContain("None of them was done");
	});
});

describe("the mock's ended items", () => {
	it("has ninety days of them, fewer in a shorter period, and refuses another period", async () => {
		vi.useFakeTimers();
		try {
			const client = createMockClient({ origin: "http://localhost:5173" });
			const begun = client.login.start();
			await vi.advanceTimersByTimeAsync(1000);
			const { redirectPrefix, url } = await begun;
			const signed = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
			await vi.advanceTimersByTimeAsync(1000);
			const user = client.user(await signed);
			const read = Promise.all([user.finishedItems(90), user.finishedItems(7)]);
			const refused = user.finishedItems(14 as never).catch((error: Error) => error.message);
			await vi.advanceTimersByTimeAsync(1000);
			const [quarter, week] = await read;
			expect(quarter.items.length).toBeGreaterThan(50);
			expect(week.items.length).toBeLessThan(quarter.items.length);
			expect(week.items.every(item => item.endedAt >= week.since)).toBe(true);
			expect(new Set(quarter.items.map(item => item.size))).toEqual(new Set(["small", "medium", "large"]));
			expect(await refused).toBe("Choose 7, 30 or 90 days.");
		} finally {
			vi.useRealTimers();
		}
	});
});
