import type { HarnessId } from "../contract.js";
import type { ModelProvider } from "./account.js";
import type { HostedSize } from "./hosted-sizes.js";

/**
 * Who paid for a turn's model requests (factory/cost.ts `turnPayer`):
 *
 *   key           a Settings API key: billed by token, so priced
 *   machine-key   the machine's own API key: billed by token too, so priced
 *   plan          a connected subscription plan (Claude or ChatGPT): no dollars, its share of the plan's windows
 *   machine-plan  the machine's own subscription sign-in: no dollars either
 */
export type CostPayer = "key" | "machine-key" | "plan" | "machine-plan";

/** The tokens of some turns, as their agent reported them. Reasoning is part of the output. */
export interface UsageTokens {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
}

/**
 * The turns an item ran on one model with one payer, summed: enough to price them again when prices change.
 * A turn whose agent reported its own dollar cost (`AcpProfile.reportedCost`) adds that cost to `agentUsd`;
 * the tokens of every other turn go to `priced`, to be priced from the catalog.
 */
export interface ModelUse extends UsageTokens {
	harness: HarnessId;
	/** The model id the turn ran with: "anthropic/claude-sonnet-4-5" (Windlass, OpenCode), "gpt-5.3-codex", "default". */
	model: string;
	provider: ModelProvider | null;
	payer: CostPayer;
	turns: number;
	/** Turns that reported neither tokens nor a cost: what they cost is unknown. */
	unreported: number;
	/** Dollars the agent reported for its turns that reported one. */
	agentUsd: number;
	/** The tokens of the turns without a reported cost. */
	priced: UsageTokens;
}

/** Hosted sandbox time by size. A machine's sandboxes are never here: they cost nothing hosted. */
export interface SandboxUse {
	size: HostedSize;
	seconds: number;
}

/** What an item's own turns used (`ItemSpend.usage`). A feature's parts keep theirs (`ItemSummary.partsUsage`). */
export interface SpendUsage {
	models: ModelUse[];
	sandbox: SandboxUse[];
	/** The size of the sandbox the latest turn ran in: hosted time counted between turns is taken at it. */
	size?: HostedSize;
}

/** USD per million tokens. */
export interface ModelPrice {
	input: number;
	output: number;
	/** A cached input token; absent where the catalog gives none, and cached input is then priced as input. */
	cacheRead?: number;
}

/** What prices an item's usage (`UserActions.costRates`). */
export interface CostRates {
	/** By "provider/model id" (server/src/model-prices.ts); null when the catalog could not be read yet. */
	models: Record<string, ModelPrice> | null;
	/** Where the model prices come from, and when they were read. */
	source: { name: string; url: string; fetchedAt: number } | null;
	/** US dollars per hour of a hosted sandbox by size (null: not known). Null when hosted time is not billed by the second here. */
	sandbox: Partial<Record<HostedSize, number | null>> | null;
}
