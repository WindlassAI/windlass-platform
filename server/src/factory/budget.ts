/**
 * An item's budget (Plans "software factory" §4.3) and whether a factory turn may start now (§4.2).
 *
 * Nothing here refuses. A turn that may not start yet is given a `Wait`: the one reason, the sentence a
 * person reads (§4.5), and when it is next tried. The one who holds the request (the user actor's turn
 * queue) tries it again then, or sooner when something is freed.
 *
 * Limits are a policy per place:
 *
 *   hosted     the platform pays, so the limits are the owner's settings (`FactoryLimits`, the day's
 *              allowance and kept sandboxes of usage.ts), which the owner can raise per user
 *   machine    the user's own computer: bounded by what its runner reports it can run, which nothing
 *              here can raise
 *
 * and some hold in both places: running turns per user (each holds a session actor and its stream on
 * a server), the factory's share of them, the cap on items waiting for review, and every item's budget
 * of tokens, turns and active time. Hosted sandbox seconds count only where the sandbox is hosted.
 *
 * The numbers of decisions 6–8 are `FACTORY_DEFAULTS`, the defaults of the WLP_FACTORY_* settings
 * config.ts reads. The day's allowance and the kept sandboxes are usage.ts's own settings.
 */

import type { SandboxPlace, TurnUsage, UsageNumbers } from "../contract.js";
import { spellSeconds, type UsageEntry } from "../usage.js";
import type { FactoryLimits, ItemBudget, StopCause, Wait } from "./types.js";

export const FACTORY_DEFAULTS: FactoryLimits = {
	runningTurns: 6,
	factoryTurns: 5,
	hostedRunning: 3,
	reviewCap: 6,
	item: { tokens: 4_000_000, turns: 10, activeSeconds: 4 * 3600, hostedSeconds: 1.5 * 3600 },
};

/** A turn that waits at a place is tried again after 30 s, then twice as long each time, up to 5 min. */
export const RETRY_FIRST_MS = 30_000;
export const RETRY_MOST_MS = 5 * 60_000;

/** When a request that has waited `attempt` times before (0: never) is tried again. */
export function retryAt(at: number, attempt: number): number {
	return at + Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** What a turn counts against an item's tokens: what went in and what came out (cached input and reasoning are parts of those). */
export function turnTokens(usage: TurnUsage | null): number {
	return usage === null ? 0 : usage.inputTokens + usage.outputTokens;
}

/** The hosted sandbox seconds the ledger has counted for one session: an item's, which runs nothing else. */
export function ledgerSeconds(entries: readonly UsageEntry[], session: string): number {
	return entries.reduce((sum, entry) => (entry.session === session ? sum + entry.seconds : sum), 0);
}

/** "4M", "3.9M", "850k", "120". */
export function spellTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	return String(Math.round(tokens));
}

const BUDGET_WORDS: Record<keyof ItemBudget, (spent: number, budget: number) => string> = {
	tokens: (spent, budget) => `This item has used ${spellTokens(spent)} of its ${spellTokens(budget)} tokens.`,
	turns: (spent, budget) => `This item has used ${spent} of its ${budget} turns.`,
	activeSeconds: (spent, budget) => `This item has worked for ${spellSeconds(spent)} of its ${spellSeconds(budget)}.`,
	hostedSeconds: (spent, budget) => `This item's hosted sandbox has run for ${spellSeconds(spent)} of its ${spellSeconds(budget)}.`,
};

/**
 * The first of an item's budgets it has used up, with the sentence a person reads; null while every
 * one has something left. Hosted seconds are no limit on a machine.
 */
export function budgetStop(budget: ItemBudget, spent: ItemBudget, place: SandboxPlace): { cause: StopCause & keyof ItemBudget; sentence: string } | null {
	for (const cause of ["tokens", "turns", "activeSeconds", "hostedSeconds"] as const) {
		if (cause === "hostedSeconds" && place.kind !== "hosted") continue;
		if (spent[cause] >= budget[cause]) return { cause, sentence: BUDGET_WORDS[cause](spent[cause], budget[cause]) };
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
			/** Set when the sandbox layer refused at the last try because the deployment runs as many as it may (WLP_E2B_MAX_RUNNING): that number. */
			deploymentFull: number | null;
	  }
	| {
			kind: "machine";
			/** What the machine is called on the Machines page. */
			name: string;
			online: boolean;
			/** For an offline machine: when it was last heard from. */
			since: number;
			/** Its sandboxes running, and how many its runner said it runs at most. */
			running: number;
			max: number;
	  };

export interface AdmissionInput {
	at: number;
	limits: FactoryLimits;
	/** The user's turns running now, the factory's among them by their items' titles. */
	turns: { running: number; factory: string[] };
	/** True for the first turn of a run: the review cap holds new work back, never work in progress. */
	startsRun: boolean;
	/** The user's items in review now. */
	inReview: number;
	place: PlaceNow;
	/** How many times this request has waited before: spaces the tries. */
	attempt: number;
}

export type Admission = { ok: true } | { ok: false; wait: Wait };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const listed = (titles: string[]) => (titles.length === 0 ? "" : ` (${titles.slice(0, 3).map((title) => `“${title}”`).join(", ")}${titles.length > 3 ? ", …" : ""})`);
const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** In the order a person can act on them: the first that holds is the one reason named. */
export function admit(input: AdmissionInput): Admission {
	const { at, limits, turns, place } = input;
	const later = retryAt(at, input.attempt);
	const wait = (reason: Wait["reason"], sentence: string, when = later): Admission => ({ ok: false, wait: { reason, sentence, retryAt: when } });

	if (input.startsRun && input.inReview >= limits.reviewCap) {
		return wait("review_cap", `Waiting until fewer than ${limits.reviewCap} of your items are in review (${input.inReview} now).`);
	}
	// The factory never has the person's last turn: with one running turn allowed in all, it has none.
	const factoryTurns = Math.min(limits.factoryTurns, Math.max(0, limits.runningTurns - 1));
	if (factoryTurns === 0) {
		return wait("capacity", `This deployment allows you ${plural(limits.runningTurns, "running turn", "running turns")}, which is kept for your own prompts: work items need at least two.`);
	}
	if (turns.factory.length >= factoryTurns) {
		return wait("capacity", `Waiting for one of your ${factoryTurns} factory turns; ${turns.factory.length} are running${listed(turns.factory)}.`);
	}
	if (turns.running >= limits.runningTurns) {
		return wait("capacity", `Waiting for one of your ${limits.runningTurns} running turns; ${turns.running} are running, ${turns.running - turns.factory.length} of them your own.`);
	}

	if (place.kind === "machine") {
		if (!place.online) return wait("machine", `‘${place.name}’ is offline since ${utcTime(place.since)} UTC.`);
		if (place.running >= place.max) return wait("machine", `Waiting for ‘${place.name}’: ${place.running} of ${place.max} sandboxes running there.`);
		return { ok: true };
	}

	const { usage } = place;
	if (usage.leftSeconds !== null && usage.leftSeconds < usage.startSeconds) {
		const allowance = spellSeconds(usage.allowanceSeconds ?? 0);
		const until = spellSeconds(Math.max(60, Math.ceil((usage.resetsAt - at) / 60_000) * 60));
		return wait("capacity", `Your ${allowance} of hosted sandbox time for today are used; it starts again at 00:00 UTC (in ${until}). The allowance is this deployment's setting, which its owner can raise.`, usage.resetsAt);
	}
	if (place.needsSandbox && usage.sandboxes.limit !== null && usage.sandboxes.kept >= usage.sandboxes.limit) {
		return wait("capacity", `Waiting for a place among the ${plural(usage.sandboxes.limit, "sandbox", "sandboxes")} you may keep: all are in use. Free one on the Usage page, or it frees itself 3 days after its item is done.`);
	}
	if (place.running >= limits.hostedRunning) {
		return wait("capacity", `Waiting for one of your ${plural(limits.hostedRunning, "hosted sandbox", "hosted sandboxes")}: ${place.running} running now.`);
	}
	if (place.deploymentFull !== null) {
		return wait("capacity", `Waiting for a hosted sandbox: this deployment runs ${place.deploymentFull} at once and all are in use. Trying again at ${utcTime(later)} UTC.`);
	}
	return { ok: true };
}
