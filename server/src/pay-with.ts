/**
 * Pay with (the Connections page): for each agent that can pay with a plan, whether its hosted turns pay with the
 * plan, then the key; only the plan; or only the key, and what a turn does when the plan is limited. Kept in the
 * user's actor (`pay_with`). Browser-safe: the web reads the same rule (`payWithFor`) to say what will happen.
 */

import {
	type HarnessId,
	MACHINE_HARNESS_IDS,
	PAY_WITH,
	type PayWith,
	type PayWithChoice,
	type PayWithPatch,
	type TurnOrigin,
	WHEN_LIMITED,
	WHEN_LIMITED_DEFAULTS,
	type WhenLimited,
} from "./contract.js";
import type { DefaultsDb } from "./repository-defaults.js";
import { machineHarness } from "./sandbox/harnesses.js";

export const PAY_WITH_TABLE =
	"CREATE TABLE IF NOT EXISTS pay_with (harness TEXT PRIMARY KEY, pay_with TEXT NOT NULL, when_limited TEXT, updated_at INTEGER NOT NULL)";

/** The agents a plan can pay for, by their harness records (today Claude Code and Codex). */
export const PAY_WITH_HARNESSES: readonly HarnessId[] = MACHINE_HARNESS_IDS.filter(
	id => (machineHarness(id)?.planProviders?.length ?? 0) > 0,
);

export class PayWithProblem extends Error {}

const isPayWith = (value: unknown): value is PayWith => (PAY_WITH as readonly unknown[]).includes(value);
const isWhenLimited = (value: unknown): value is WhenLimited => (WHEN_LIMITED as readonly unknown[]).includes(value);

const defaultChoice = (harness: HarnessId): PayWithChoice => ({
	harness,
	payWith: "plan-then-key",
	whenLimited: null,
	updatedAt: null,
});

export function payWithPatchOf(raw: unknown): PayWithPatch {
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof PayWithPatch, unknown>>;
	const harness = PAY_WITH_HARNESSES.find(id => id === input.harness);
	if (!harness) throw new PayWithProblem("Choose an agent that can pay with a plan.");
	if (!isPayWith(input.payWith))
		throw new PayWithProblem("Choose what pays: the plan, the key, or the plan then the key.");
	const whenLimited = input.whenLimited ?? null;
	if (whenLimited !== null && !isWhenLimited(whenLimited))
		throw new PayWithProblem("Choose what happens when the plan is limited: wait, use the key, or ask.");
	return { harness, payWith: input.payWith, whenLimited };
}

type Row = { harness: string; pay_with: string; when_limited: string | null; updated_at: number };

/** One choice per plan agent, in `PAY_WITH_HARNESSES` order: the saved one, or the defaults (also for a row no longer valid). */
export async function readPayWith(db: DefaultsDb): Promise<PayWithChoice[]> {
	const rows = await db.execute<Row>("SELECT harness, pay_with, when_limited, updated_at FROM pay_with");
	return PAY_WITH_HARNESSES.map(harness => {
		const row = rows.find(one => one.harness === harness);
		if (!row || !isPayWith(row.pay_with) || (row.when_limited !== null && !isWhenLimited(row.when_limited)))
			return defaultChoice(harness);
		return { harness, payWith: row.pay_with, whenLimited: row.when_limited, updatedAt: row.updated_at };
	});
}

export async function savePayWith(db: DefaultsDb, patch: PayWithPatch, now = Date.now()): Promise<PayWithChoice[]> {
	await db.execute(
		"INSERT OR REPLACE INTO pay_with (harness, pay_with, when_limited, updated_at) VALUES (?, ?, ?, ?)",
		patch.harness,
		patch.payWith,
		patch.whenLimited,
		now,
	);
	return readPayWith(db);
}

/**
 * The rule a hosted turn of `harness` follows (applied at turn start in Phase 6): what pays, and what a limited plan
 * does. `hasKey`: whether the user has a saved key this agent can use.
 */
export function payWithFor(
	choices: readonly PayWithChoice[],
	harness: HarnessId,
	origin: TurnOrigin,
	hasKey: boolean,
): { payWith: PayWith; whenLimited: WhenLimited } {
	// No plan can pay for it, so only a key does; a key is never "limited" in this sense.
	if (!PAY_WITH_HARNESSES.includes(harness)) return { payWith: "key", whenLimited: "wait" };
	const choice = choices.find(one => one.harness === harness) ?? defaultChoice(harness);
	// Key only: the plan never pays, so its limit never matters. Plan only: the key is never used, nor offered.
	// Without a saved key there is nothing to switch to or ask about.
	if (choice.payWith !== "plan-then-key" || !hasKey) return { payWith: choice.payWith, whenLimited: "wait" };
	return { payWith: choice.payWith, whenLimited: choice.whenLimited ?? WHEN_LIMITED_DEFAULTS[origin] };
}
