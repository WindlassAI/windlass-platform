// @vitest-environment jsdom
/** The item page's dollars: the total, models and sandbox, each part of a feature, and by model who paid. */
import type { CostRates, ItemSummary, ItemView, SpendUsage } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { addSandbox, addTurn, noUsage, turnMeter } from "../../../server/src/factory/cost.js";
import { CostByModel, ItemCost } from "./ItemCost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RATES: CostRates = {
	models: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 } },
	source: { name: "models.dev", url: "https://models.dev/api.json", fetchedAt: Date.UTC(2026, 10, 27) },
	sandbox: { standard: 0.18 },
};

function used(turn: Partial<Parameters<typeof turnMeter>[0]>, seconds = 0): SpendUsage {
	const usage = noUsage();
	addTurn(
		usage,
		turnMeter({
			harness: "windlass",
			model: "anthropic/claude-sonnet-4-5",
			key: { provider: "anthropic", generation: "g" },
			usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
			size: "standard",
			...turn,
		}),
	);
	addSandbox(usage, "standard", seconds);
	return usage;
}

const spent = (usage: SpendUsage) => ({ tokens: 0, turns: 1, activeSeconds: 0, hostedSeconds: 0, usage });

function view(more: Partial<ItemView>): ItemView {
	return { place: { kind: "hosted" }, spent: spent(used({}, 3600)), ...more } as ItemView;
}

function render(of: ItemView, rates: CostRates | null = RATES): HTMLElement {
	const host = document.createElement("div");
	const root = createRoot(host);
	act(() =>
		root.render(
			createElement(
				"div",
				null,
				createElement(ItemCost, { view: of, rates }),
				createElement(CostByModel, { view: of, rates }),
			),
		),
	);
	return host;
}

const facts = (host: HTMLElement) =>
	Object.fromEntries(
		[...host.querySelectorAll(".item-cost > div")].map(row => [
			row.querySelector("dt")?.textContent,
			row.querySelector("dd")?.textContent,
		]),
	);

describe("the item page's dollars", () => {
	it("splits a key's tokens from the hosted sandbox's time", () => {
		expect(facts(render(view({})))).toEqual({ Total: "$3.18", Models: "$3.00", Sandbox: "$0.18 for 1 h" });
	});
	it("says a plan's turns are on the plan, and a machine's sandbox costs nothing", () => {
		const host = render(
			view({
				place: { kind: "machine", machineId: "m1" },
				spent: spent(used({ harness: "claude", model: "opus", key: undefined, signIn: "subscription", size: null })),
			}),
		);
		expect(facts(host)).toEqual({
			Total: "On your machine's plan",
			Models: "On your machine's plan",
			Sandbox: "$0.00: your machine",
		});
		expect(host.querySelector(".item-dollars-models td")?.textContent).toBe("your machine's plan");
	});
	it("gives each part of a feature its cost, retries in its sum, and the feature's own turns apart", () => {
		const part = (id: string, title: string, usage: SpendUsage) => ({ id, title, spent: spent(usage) }) as ItemSummary;
		const parser = part("i_1", "Parse the manifest", used({}));
		const writer = part("i_2", "Write the CSV", used({ key: { provider: "anthropic", generation: "g", plan: true } }));
		const host = render(
			view({
				spent: spent(used({}, 0)),
				partsUsage: used({}),
				children: [parser, writer],
			}),
		);
		const rows = [...host.querySelectorAll(".item-dollars > .item-dollars-table tbody tr")].map(row =>
			[...row.children].map(cell => cell.textContent),
		);
		expect(rows).toEqual([
			["Planning, review and summary", "$3.00"],
			["Parse the manifest", "$3.00"],
			["Write the CSV", "On your Claude plan"],
		]);
		expect(facts(host).Total).toBe("$6.00");
	});
	it("says an unpriced model is unknown, and waits for prices before saying anything", () => {
		const host = render(view({ spent: spent(used({ model: "anthropic/claude-new" }, 3600)) }));
		expect(facts(host)).toMatchObject({ Total: "$0.18 + some cost unknown", Models: "Cost unknown" });
		expect(render(view({}), null).textContent).toBe("Reading prices…");
	});
});
