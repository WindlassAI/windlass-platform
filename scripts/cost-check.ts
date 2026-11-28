// What an item cost (server/src/factory/cost.ts) and where its token prices come from (server/src/model-prices.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CostRates, SpendUsage, TurnUsage } from "../server/src/contract.js";
import { FACTORY_DEFAULTS } from "../server/src/factory/budget.js";
import { createItem } from "../server/src/factory/blueprint.js";
import { chargeTurn, noteHostedTime } from "../server/src/factory/change.js";
import { itemCost, mergeUsage, turnMeter, type TurnMeter } from "../server/src/factory/cost.js";
import type { FactoryItem, FeatureJob } from "../server/src/factory/types.js";
import {
	MAX_CATALOG_BYTES,
	ModelPriceCache,
	REFRESH_MS,
	RETRY_MS,
	parseModelPrices,
} from "../server/src/model-prices.js";

const RATES: CostRates = {
	models: {
		"anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
		"openai/gpt-5.3-codex": { input: 1.75, output: 14 },
	},
	source: { name: "models.dev", url: "https://models.dev/api.json", fetchedAt: 0 },
	sandbox: { small: 0.0306, standard: 0.1656, large: null },
};

const tokens = (input: number, cached: number, output: number): TurnUsage => ({
	inputTokens: input,
	cachedInputTokens: cached,
	outputTokens: output,
	reasoningTokens: 0,
});

const close = (actual: number, expected: number) =>
	assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

function item(place: FactoryItem["place"] = { kind: "hosted" }): FactoryItem {
	return createItem({
		id: "i_00000000000000cc",
		task: { title: "Fix add()", body: "", acceptance: [], base: "main" },
		reviewer: { off: "deployment" },
		place,
		budget: { ...FACTORY_DEFAULTS.item },
	});
}

const charge = (into: FactoryItem, meter: TurnMeter, hostedSeconds = 0) =>
	chargeTurn(into, { tokens: 0, hostedSeconds, meter });

test("a Settings key's tokens are priced from the catalog, cached input at its own price", () => {
	const meter = turnMeter({
		harness: "windlass",
		model: "anthropic/claude-sonnet-4-5",
		key: { provider: "anthropic", generation: "g1" },
		usage: tokens(1_000_000, 800_000, 100_000),
		size: "standard",
	});
	assert.equal(meter.payer, "key");
	const into = item();
	charge(into, meter);
	const cost = itemCost(into.spent.usage, RATES);
	// 200k fresh input at $3, 800k cached at $0.30, 100k output at $15 per million.
	close(cost.models.usd, 0.6 + 0.24 + 1.5);
	assert.equal(cost.unknown, false);
	assert.deepEqual(cost.plans, []);
});

test("a catalog without a cached price prices cached input as input", () => {
	const usage: SpendUsage = { models: [], sandbox: [] };
	const into = item({ kind: "machine", machineId: "m1" });
	into.spent.usage = usage;
	charge(
		into,
		turnMeter({
			harness: "codex",
			model: "gpt-5.3-codex",
			signIn: "api-key",
			usage: tokens(1_000_000, 500_000, 0),
			size: null,
		}),
	);
	assert.equal(into.spent.usage.models[0]?.payer, "machine-key");
	close(itemCost(into.spent.usage, RATES).usd, 1.75);
});

test("the agent's own cost is preferred where its record says it is the turn's", () => {
	const into = item();
	charge(
		into,
		turnMeter({
			harness: "claude",
			model: "sonnet",
			key: { provider: "anthropic", generation: "g1" },
			usage: tokens(1_000_000, 0, 0),
			cost: { amount: 0.42, currency: "USD" },
			size: "standard",
		}),
	);
	const cost = itemCost(into.spent.usage, RATES);
	close(cost.models.usd, 0.42);
	assert.equal(cost.models.unknown, false);
	// OpenCode's reported cost covers its whole conversation, so its tokens are priced instead.
	const opencode = turnMeter({
		harness: "opencode",
		model: "anthropic/claude-sonnet-4-5",
		key: { provider: "anthropic", generation: "g1" },
		usage: tokens(1_000_000, 0, 0),
		cost: { amount: 9, currency: "USD" },
		size: "standard",
	});
	assert.equal(opencode.agentUsd, null);
	// A cost in another currency is not taken either.
	assert.equal(
		turnMeter({ harness: "claude", model: "sonnet", usage: null, cost: { amount: 1, currency: "EUR" }, size: null })
			.agentUsd,
		null,
	);
});

test("a plan's turns have no dollars, whatever the agent reported", () => {
	const into = item();
	charge(
		into,
		turnMeter({
			harness: "claude",
			model: "opus",
			key: { provider: "anthropic", generation: "g1", plan: true },
			usage: tokens(2_000_000, 1_000_000, 50_000),
			cost: { amount: 3.1, currency: "USD" },
			size: "standard",
		}),
	);
	// Windlass without a key runs on the user's ChatGPT sign-in; Claude Code on a machine's subscription.
	charge(into, turnMeter({ harness: "windlass", model: "default", usage: tokens(10, 0, 1), size: "standard" }));
	charge(
		into,
		turnMeter({ harness: "claude", model: "default", signIn: "subscription", usage: tokens(10, 0, 1), size: null }),
	);
	const cost = itemCost(into.spent.usage, RATES);
	assert.equal(cost.models.usd, 0);
	assert.equal(cost.unknown, false);
	assert.deepEqual(cost.plans, [
		{ payer: "plan", provider: "anthropic", turns: 1 },
		{ payer: "plan", provider: "openai", turns: 1 },
		{ payer: "machine-plan", provider: "anthropic", turns: 1 },
	]);
	assert.ok(cost.lines.every(line => line.usd === null));
	assert.equal(cost.lines[0]?.tokens.inputTokens, 2_000_000, "tokens stay as details");
});

test("hosted time is priced at its size; a machine's sandbox costs nothing", () => {
	const hosted = item();
	charge(hosted, turnMeter({ harness: "windlass", model: "default", usage: tokens(1, 0, 1), size: "standard" }), 1800);
	// Time settled after the turn is taken at the size the turn ran at.
	hosted.spent.hostedSeconds = 3600;
	noteHostedTime(hosted);
	assert.deepEqual(hosted.spent.usage?.sandbox, [{ size: "standard", seconds: 3600 }]);
	close(itemCost(hosted.spent.usage, RATES).sandbox.usd, 0.1656);

	const machine = item({ kind: "machine", machineId: "m1" });
	machine.spent.hostedSeconds = 900;
	charge(machine, turnMeter({ harness: "claude", model: "default", signIn: "api-key", usage: null, size: null }));
	assert.deepEqual(machine.spent.usage?.sandbox, []);
	assert.equal(itemCost(machine.spent.usage, RATES).sandbox.usd, 0);

	// A size without a known rate is unknown; a deployment that does not bill by time charges nothing.
	const large: SpendUsage = { models: [], sandbox: [{ size: "large", seconds: 60 }] };
	assert.equal(itemCost(large, RATES).sandbox.unknown, true);
	assert.equal(itemCost(large, { ...RATES, sandbox: null }).unknown, false);
});

test("an unknown model, or a key turn that reported nothing, is unknown, never guessed", () => {
	const into = item();
	charge(
		into,
		turnMeter({
			harness: "windlass",
			model: "anthropic/claude-made-up-9",
			key: { provider: "anthropic", generation: "g1" },
			usage: tokens(1000, 0, 10),
			size: "standard",
		}),
	);
	let cost = itemCost(into.spent.usage, RATES);
	assert.equal(cost.unknown, true);
	assert.equal(cost.lines[0]?.usd, null);
	assert.equal(cost.models.usd, 0);
	// Prices not read yet: the same.
	assert.equal(itemCost(into.spent.usage, { ...RATES, models: null }).unknown, true);

	const silent = item();
	charge(
		silent,
		turnMeter({
			harness: "claude",
			model: "sonnet",
			key: { provider: "anthropic", generation: "g1" },
			usage: null,
			size: "standard",
		}),
	);
	cost = itemCost(silent.spent.usage, RATES);
	assert.equal(cost.unknown, true);
	assert.equal(silent.spent.usage?.models[0]?.unreported, 1);
});

test("a feature sums its parts, retries among them, apart from its own turns", () => {
	const meter = (input: number) =>
		turnMeter({
			harness: "windlass",
			model: "anthropic/claude-sonnet-4-5",
			key: { provider: "anthropic", generation: "g1" },
			usage: tokens(input, 0, 0),
			size: "standard",
		});
	const part = (id: string, key: string, input: number, seconds: number, state: FeatureJob["state"]) => {
		const child = item();
		child.spent.hostedSeconds = seconds;
		charge(child, meter(input), seconds);
		return { id, task: { key }, state, spent: child.spent } as unknown as FeatureJob;
	};
	const feature = item();
	feature.mode = "orchestrate";
	// The first attempt at "parser" failed and was dispatched again.
	feature.jobs = [
		part("i_p1", "parser", 1_000_000, 600, "failed"),
		part("i_p2", "parser", 1_000_000, 600, "done"),
		part("i_w1", "writer", 2_000_000, 1200, "done"),
	];
	// The feature's hosted seconds include its parts' (work-item.ts `childSeconds`): only its own are its sandbox.
	charge(feature, meter(500_000), 300 + 2400);
	assert.deepEqual(feature.spent.usage?.sandbox, [{ size: "standard", seconds: 300 }]);
	const parts = mergeUsage(feature.jobs.map(job => job.spent.usage));
	assert.equal(parts.models[0]?.turns, 3);
	const total = itemCost(mergeUsage([feature.spent.usage, parts]), RATES);
	close(total.models.usd, (4_000_000 + 500_000) * 3e-6);
	close(total.sandbox.usd, (2700 / 3600) * 0.1656);
});

// ---------------------------------------------------------------------------------------------
// The price catalog
// ---------------------------------------------------------------------------------------------

const CATALOG = {
	anthropic: {
		id: "anthropic",
		models: {
			"claude-sonnet-4-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
			"claude-free": { cost: { input: 0, output: 0 } },
			"claude-unpriced": { name: "no cost" },
			"claude-bad": { cost: { input: -1, output: 2 } },
		},
	},
	openai: { models: { "gpt-5.3-codex": { cost: { input: 1.75, output: 14, cache_read: 0.175 } } } },
	openrouter: { models: { "anthropic/claude-sonnet-4.5": { cost: { input: 3, output: 15 } } } },
	mistral: { models: { "mistral-large": { cost: { input: 2, output: 6 } } } },
};

test("the catalog parser keeps the platform's providers' priced models", () => {
	assert.deepEqual(parseModelPrices(CATALOG), {
		"anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
		"anthropic/claude-free": { input: 0, output: 0 },
		"openai/gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175 },
		"openrouter/anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
	});
	assert.throws(() => parseModelPrices([]), /not a JSON object/);
	assert.throws(() => parseModelPrices({ mistral: CATALOG.mistral }), /none of the platform's providers/);
});

function stubFetch(answers: Array<() => Response>) {
	const calls: string[] = [];
	const stub = (async (url: string | URL | Request) => {
		calls.push(String(url));
		const next = answers.shift();
		if (!next) throw new Error("no answer");
		return next();
	}) as typeof fetch;
	return { stub, calls };
}

test("the cache reads once, keeps stale prices when a refresh fails, and tries again later", async () => {
	let now = 1_000;
	const logs: string[] = [];
	const { stub, calls } = stubFetch([
		() => Response.json(CATALOG),
		() => new Response("upstream down", { status: 503 }),
		() => new Response("{not json"),
	]);
	const cache = new ModelPriceCache({
		url: "https://prices.test/api.json",
		fetch: stub,
		now: () => now,
		log: line => logs.push(line),
	});
	const first = await cache.prices();
	assert.equal(first.models?.["anthropic/claude-sonnet-4-5"]?.input, 3);
	assert.deepEqual(first.source, { name: "models.dev", url: "https://prices.test/api.json", fetchedAt: 1_000 });
	await cache.prices();
	assert.equal(calls.length, 1, "read once a day");

	now += REFRESH_MS;
	await cache.prices();
	// The refresh runs in the background: the held prices answer meanwhile, and after it fails.
	await new Promise(resolve => setTimeout(resolve, 10));
	const stale = await cache.prices();
	assert.equal(stale.source?.fetchedAt, 1_000);
	assert.match(logs[0] ?? "", /answered 503/);
	assert.match(logs[0] ?? "", /the prices read before are kept/);
	assert.equal(calls.length, 2, "a failed read waits before the next");

	now += RETRY_MS;
	await cache.prices();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal((await cache.prices()).models?.["openai/gpt-5.3-codex"]?.output, 14);
	assert.match(logs[1] ?? "", /not JSON/);
});

test("an oversized or malformed catalog is refused", async () => {
	const logs: string[] = [];
	const big = "x".repeat(64);
	const { stub } = stubFetch([
		() => new Response(big, { headers: { "content-length": String(MAX_CATALOG_BYTES + 1) } }),
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(big));
						controller.enqueue(new TextEncoder().encode(big));
						controller.close();
					},
				}),
			),
		() => Response.json({ mistral: {} }),
	]);
	let now = 0;
	const cache = new ModelPriceCache({
		url: "https://prices.test/",
		fetch: stub,
		now: () => now,
		maxBytes: 100,
		log: line => logs.push(line),
	});
	assert.deepEqual(await cache.prices(), { models: null, source: null });
	now += RETRY_MS;
	assert.deepEqual(await cache.prices(), { models: null, source: null });
	now += RETRY_MS;
	assert.deepEqual(await cache.prices(), { models: null, source: null });
	assert.equal(logs.length, 3);
	assert.match(logs[0]!, /larger than 100 bytes/);
	assert.match(logs[1]!, /larger than 100 bytes/);
	assert.match(logs[2]!, /none of the platform's providers/);
});

test("prices off: nothing is read", async () => {
	const { stub, calls } = stubFetch([]);
	assert.deepEqual(await new ModelPriceCache({ url: null, fetch: stub }).prices(), { models: null, source: null });
	assert.equal(calls.length, 0);
});
