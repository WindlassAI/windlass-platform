/**
 * An item's budget (Plans "software factory" §4.3) and whether a factory turn may start now (§4.2).
 *
 * Nothing here refuses. A turn that may not start yet is given a `Wait`: the one reason, the sentence a
 * person reads (§4.5), and when it is next tried. The one who holds the request (the user actor's turn
 * queue) tries it again then, or sooner when something is freed.
 *
 * Only what costs the operator is capped, and only where it does:
 *
 *   hosted     the platform pays, so the limits are the owner's settings: the hosted sandboxes a user runs at
 *              once (`FactoryLimits.hostedRunning`), the day's allowance and kept sandboxes of usage.ts, which
 *              the owner can raise per user
 *   machine    the user's own computer: bounded only by what its runner reports it can run (its slots), which
 *              nothing here can raise; the runner queues turns past them
 *
 * An item's own budget is one cost-weighted token figure (and, hosted, its sandbox time). When it is used
 * up the item asks its person for more; it never throws away work.
 *
 * The numbers are `FACTORY_DEFAULTS`, the defaults of the WLP_FACTORY_* settings config.ts reads. The day's
 * allowance and the kept sandboxes are usage.ts's own settings.
 */

import { MINUTE, providerWait } from "../provider-usage.js";
import type { HarnessId, ItemAgent, ProviderAccount, SandboxPlace, TurnUsage, UsageNumbers } from "../contract.js";
import { itemTokensOf, machineHarness, type SignInMethod } from "../sandbox/harnesses.js";
import { nextUtcDay, spellSeconds, type UsageEntry } from "../usage.js";
import type { AgentTurn, FactoryItem, FactoryLimits, ItemBudget, ItemSpend, StopCause, TurnSpend, Wait } from "./types.js";

export const FACTORY_DEFAULTS: FactoryLimits = {
	dailyTokens: null,
	githubItemsPerDay: 20,
	attachments: { bytes: 2 * 1024 * 1024, perItem: 40, accountBytes: 1_073_741_824, days: 180 },
	hostedRunning: 3,
	item: { tokens: 2_000_000, hostedSeconds: 2 * 3600 },
};

/**
 * What a cached input token counts for against an item's budget, against 1 for every other token. A
 * prompt-cache read is billed at a tenth of the base input price by Anthropic (Claude: "cache hits … 0.1x
 * base input price") and by OpenAI for its current models (GPT-5: cached input $0.125 against $1.25 per
 * million). The platform keeps no price table of its own, so the budget uses that published ratio for
 * every agent: a long turn that mostly rereads its context is not counted as if it read it all afresh.
 */
export const CACHED_INPUT_WEIGHT = 0.1;

/** A turn that waits at a place is tried again after 30 s, then twice as long each time, up to 5 min. */
export const RETRY_FIRST_MS = 30_000;
export const RETRY_MOST_MS = 5 * 60_000;

/** When a request that has waited `attempt` times before (0: never) is tried again. */
export function retryAt(at: number, attempt: number): number {
	return at + Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** A turn's tokens as reported: what went in and what came out (cached input and reasoning are parts of those). */
export function turnTokens(usage: TurnUsage | null): number {
	return usage === null ? 0 : usage.inputTokens + usage.outputTokens;
}

/** What a turn counts against an item's budget: its tokens, cached input at `CACHED_INPUT_WEIGHT`. */
export function weightedTokens(usage: TurnUsage | null): number {
	if (usage === null) return 0;
	const cached = Math.min(Math.max(0, usage.cachedInputTokens || 0), usage.inputTokens);
	return Math.round(usage.inputTokens - cached + cached * CACHED_INPUT_WEIGHT + usage.outputTokens);
}

/** An item's agent before its first turn: Windlass's tokens are counted as they come, a machine harness has reported none. */
export function newAgent(harness: HarnessId, model: string, effort?: string | null, signIn?: ItemAgent["signIn"]): ItemAgent {
	return { harness, model, ...(effort && { effort }), ...(signIn && { signIn }), tokens: harness === "windlass" ? "counted" : "not_reported", reportedTokens: 0, cost: null, fiveHour: null };
}

/** The agent of an item, also of one filed before agents could be chosen. */
export function itemAgent(item: Pick<FactoryItem, "agent" | "spent">): ItemAgent {
	return item.agent ?? { ...newAgent("windlass", "default"), reportedTokens: rawTokens(item.spent) };
}

/** An item's tokens as reported, cached input at full count; an item stored before they were kept has only `tokens`. */
export const rawTokens = (spent: Pick<ItemSpend, "tokens" | "rawTokens">): number => spent.rawTokens ?? spent.tokens;

export const noSpend = (): ItemSpend => ({ tokens: 0, rawTokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 });

/**
 * What a machine harness reported of a turn, read from the turn's usage (the `session/prompt` answer) and
 * its last ACP usage update. Its tokens count against the item's budget only where the harness bills by
 * token (`itemTokensOf`: "budget", or an API key where the sign-in decides): a subscription's are shown,
 * not counted. `signIn`: the method used for this turn. Undefined for Windlass.
 */
export function agentTurn(harness: HarnessId | undefined, usage: TurnUsage | null, context?: { cost: { amount: number; currency: string } | null; fiveHourUsedPct?: number } | null, fiveHourAtStart?: number, signIn?: SignInMethod): AgentTurn | undefined {
	const machine = machineHarness(harness);
	if (!machine) return undefined;
	const end = context?.fiveHourUsedPct;
	return {
		reported: usage === null ? null : turnTokens(usage),
		counted: itemTokensOf(machine, signIn) === "budget",
		cost: context?.cost ?? null,
		fiveHour: end === undefined ? null : { start: fiveHourAtStart ?? end, end },
	};
}

/** A turn's spend: its tokens count only where its agent's are counted, cost-weighted. */
export function turnSpend(usage: TurnUsage | null, agent?: AgentTurn): TurnSpend {
	const counted = !agent || agent.counted;
	return { tokens: counted ? weightedTokens(usage) : 0, rawTokens: counted ? turnTokens(usage) : 0, hostedSeconds: 0, ...(agent && { agent }) };
}

/**
 * The sentence that stops an item whose agent's tokens count against its budget (`itemTokens: "budget"`)
 * when a turn reported none: the budget cannot be enforced, and the turn is never taken as 0 tokens.
 * Null where the turn reported its tokens, or its agent's are not counted.
 */
export function unmeasuredTurn(spend: TurnSpend, agent: Pick<ItemAgent, "harness">): string | null {
	if (!spend.agent?.counted || spend.agent.reported !== null) return null;
	return `${machineHarness(agent.harness)?.name ?? "The agent"} did not report token use, so the item's budget can't be enforced.`;
}

/** Adds a turn's report to the item's agent. The cost is the conversation's so far, so the latest replaces it. */
export function noteAgentTurn(item: FactoryItem, turn: AgentTurn): void {
	const agent = item.agent ?? itemAgent(item);
	if (turn.reported !== null) {
		const subscribed = agent.tokens === "subscription" ? agent.reportedTokens : agent.subscriptionTokens ?? 0;
		agent.reportedTokens += turn.reported;
		agent.tokens = turn.counted || agent.tokens === "counted" ? "counted" : "subscription";
		if (agent.tokens === "counted") {
			const total = subscribed + (turn.counted ? 0 : turn.reported);
			if (total) agent.subscriptionTokens = total;
		}
	}
	if (turn.cost) agent.cost = turn.cost;
	if (turn.fiveHour) agent.fiveHour = { first: agent.fiveHour?.first ?? turn.fiveHour.start, latest: turn.fiveHour.end };
	item.agent = agent;
}

/**
 * An item's tokens in words: "1,200 of 2,000,000 tokens (cost-weighted; 9,800 as reported)" where they are
 * counted, otherwise what its agent reported, never a 0 that was not measured.
 */
export function tokenWords(spent: Pick<ItemSpend, "tokens" | "rawTokens">, budget: Pick<ItemBudget, "tokens">, agent?: ItemAgent): string {
	const name = agent ? machineHarness(agent.harness)?.name ?? "Windlass" : "Windlass";
	if (!agent || agent.tokens === "counted") {
		const subscription = agent?.subscriptionTokens ? `, plus ${agent.subscriptionTokens.toLocaleString("en-US")} subscription tokens` : "";
		return `${spent.tokens.toLocaleString("en-US")} of ${budget.tokens.toLocaleString("en-US")} tokens (cost-weighted; ${rawTokens(spent).toLocaleString("en-US")} as reported)${subscription}`;
	}
	if (agent.tokens === "subscription") return `${agent.reportedTokens.toLocaleString("en-US")} tokens reported by ${name}, not counted (subscription)`;
	return `tokens not reported by ${name}`;
}

/** Settled hosted seconds for all sessions belonging to the item. */
export function ledgerSeconds(entries: readonly Pick<UsageEntry, "session" | "seconds">[], sessions: readonly string[]): number {
	return entries.reduce((sum, entry) => (sessions.includes(entry.session) ? sum + entry.seconds : sum), 0);
}

/** "4M", "3.9M", "850k", "120". */
export function spellTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	return String(Math.round(tokens));
}

const BUDGET_WORDS: Record<keyof ItemBudget, (spent: ItemSpend, budget: number) => string> = {
	tokens: (_spent, budget) => `Used its ${spellTokens(budget)}-token budget.`,
	hostedSeconds: (spent, budget) => `This item's hosted sandbox has run for ${spellSeconds(spent.hostedSeconds)} of its ${spellSeconds(budget)}.`,
};

/** The figures of a budget: tokens everywhere, hosted sandbox time only where the sandbox is hosted. */
export const BUDGET_FIGURES = ["tokens", "hostedSeconds"] as const satisfies ReadonlyArray<keyof ItemBudget>;

/**
 * The first of an item's budgets it has used up, with the sentence a person reads; null while every
 * one has something left. Hosted seconds are no limit on a machine.
 */
export function budgetStop(budget: ItemBudget, spent: ItemSpend, place: SandboxPlace): { cause: StopCause & keyof ItemBudget; sentence: string } | null {
	for (const cause of BUDGET_FIGURES) {
		if (cause === "hostedSeconds" && place.kind !== "hosted") continue;
		if (spent[cause] >= budget[cause]) return { cause, sentence: BUDGET_WORDS[cause](spent, budget[cause]) };
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Whether a turn may start
// ---------------------------------------------------------------------------------------------

/** What is known of the place when a turn would start there. */
export type PlaceNow =
	| {
			kind: "hosted";
			/** The user's day (usage.ts): allowance used and held, kept sandboxes and their cap. */
			usage: UsageNumbers;
			/** The user's hosted sandboxes running now. */
			running: number;
			/** True when the session has no sandbox and one must be made: it needs a place among the kept ones. */
			needsSandbox: boolean;
			/** Who holds the kept places now, in words (usage.ts `keptHolder`), for the question the item asks at the cap. */
			holders?: string[];
			/** Set when the sandbox layer refused at the last try because the deployment runs as many as it may (WLP_E2B_MAX_RUNNING): that number. */
			deploymentFull: number | null;
	  }
	| {
			kind: "machine";
			/** What the machine is called on the Machines page. */
			name: string;
			online: boolean;
			/** Its control socket is online, but the runner did not open the session link. */
			attachRetryAt: number | null;
			keptFull: boolean;
			slots?: { units: number; free: number };
			/** Its sandboxes running, and how many its runner said it runs at most. */
			running: number;
			max: number;
	  };

/** An item's turn needs a hosted sandbox and every place the account may keep is taken: by what, and what the person can do. */
export function keptCapSentence(limit: number, holders: string[]): string {
	const named = holders.length === 0 ? "" : `: ${holders.slice(0, 5).join(", ")}${holders.length > 5 ? `, and ${holders.length - 5} more` : ""}`;
	return `This item's next turn needs a hosted sandbox, and all ${plural(limit, "hosted sandbox", "hosted sandboxes")} you may keep are in use${named}. Free one on the Usage page and the turn starts, wait for one to be freed, or give up. Sandboxes on your own machines are not counted.`;
}

export function slotWait(name: string, units: number, free: number): string {
	return `Waiting for ${units} free slot${units === 1 ? "" : "s"} on ‘${name}’. ${free} free now.`;
}

export interface AdmissionInput {
	provider?: ProviderAccount;
	/** All Factory turns currently use the platform model source. */
	dailyTokenWait?: string | null;
	at: number;
	limits: FactoryLimits;
	place: PlaceNow;
	/** How many times this request has waited before: spaces the tries. */
	attempt: number;
}

export type Admission = { ok: true } | { ok: false; wait: Wait };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** In the order a person can act on them: the first that holds is the one reason named. */

export function admit(input: AdmissionInput): Admission {
	const { at, limits, place } = input;
	const account = input.provider;
	if (account?.state === "limited" && account.limitedUntil !== null && account.limitedUntil > at) {
		const reset = account.windows.find(w => w.source === "refusal" && w.resetsAt !== null && w.resetsAt + MINUTE === account.limitedUntil)?.resetsAt;
		return { ok: false, wait: providerWait(account.harness, place.kind === "hosted" ? "hosted" : place.name, account.limitedUntil, reset) };
	}
	const later = retryAt(at, input.attempt);
	const wait = (reason: Wait["reason"], sentence: string, when = later): Admission => ({ ok: false, wait: { reason, sentence, retryAt: when } });

	if (input.dailyTokenWait) return wait("capacity", input.dailyTokenWait, nextUtcDay(at));

	if (place.kind === "machine" && (!place.online || (place.attachRetryAt ?? 0) > at)) {
		return wait("machine", `Waiting for your machine "${place.name}" to come back online.`, place.online ? place.attachRetryAt! : later);
	}
	if (place.kind === "machine") {
		if (place.slots && place.slots.free < place.slots.units) return wait("machine", slotWait(place.name, place.slots.units, place.slots.free));
		if (place.keptFull) return wait("machine", `Waiting for room on your machine "${place.name}". Its runner has reached its limit on kept sandboxes.`);
		if (place.running >= place.max) return wait("machine", `Waiting for ‘${place.name}’: ${place.running} of ${place.max} sandboxes running there, its runner's limit.`);
		return { ok: true };
	}

	const { usage } = place;
	if (usage.leftSeconds !== null && usage.leftSeconds < usage.startSeconds) {
		const allowance = spellSeconds(usage.allowanceSeconds ?? 0);
		const until = spellSeconds(Math.max(60, Math.ceil((usage.resetsAt - at) / 60_000) * 60));
		return wait("capacity", `Your ${allowance} of hosted sandbox time for today are used; it starts again at 00:00 UTC (in ${until}). The allowance is this deployment's setting, which its owner can raise.`, usage.resetsAt);
	}
	if (place.needsSandbox && usage.sandboxes.limit !== null && usage.sandboxes.kept >= usage.sandboxes.limit) {
		return wait("sandboxes", keptCapSentence(usage.sandboxes.limit, place.holders ?? []));
	}
	if (place.running >= limits.hostedRunning) {
		return wait("capacity", `Waiting for one of your ${plural(limits.hostedRunning, "hosted sandbox", "hosted sandboxes")} that run at once: ${place.running} running now. Your machines don't count toward this.`);
	}
	if (place.deploymentFull !== null) {
		return wait("capacity", `Waiting for a hosted sandbox: this deployment runs ${place.deploymentFull} at once and all are in use. Trying again at ${utcTime(later)} UTC.`);
	}
	return { ok: true };
}
