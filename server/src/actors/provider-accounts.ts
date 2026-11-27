import type { RawAccess } from "rivetkit/db";
import {
	isModelProvider,
	isPlanProvider,
	MACHINE_HARNESS_IDS,
	type HarnessId,
	type ModelPlanStatus,
	type ModelProvider,
	type PlanProvider,
	type ProviderAccount,
} from "../contract.js";
import { observationReading } from "../credentials/plan-health.js";
import { observePlan, planStatuses } from "../credentials/plans.js";
import { machineHarness } from "../sandbox/harnesses.js";
import {
	WINDLASS_ACCOUNT,
	accountState,
	observeUsage,
	type StoredUsage,
	type UsageObservation,
} from "../provider-usage.js";

export const PROVIDER_TABLE = `CREATE TABLE IF NOT EXISTS provider_usage (
	place TEXT NOT NULL, harness TEXT NOT NULL, generation TEXT NOT NULL, data TEXT NOT NULL,
	PRIMARY KEY(place,harness))`;

type Db = Pick<RawAccess, "execute">;
/**
 * Whose usage limit a turn counts against: a sign-in at a place, a Settings key (`provider`), or with `plan` the
 * user's connected plan of `provider`, which has its own limits apart from the key's (credentials/plan-health.ts).
 */
export interface AccountLocation {
	place: string;
	harness: HarnessId;
	provider?: ModelProvider;
	plan?: true;
}

function accountPlace({ provider, place, harness, plan }: AccountLocation) {
	if (provider && plan) return "plan/" + provider;
	return provider ? "settings/" + provider : harness === "windlass" ? WINDLASS_ACCOUNT : place;
}

export function accountKey(location: AccountLocation, generation: string) {
	return [accountPlace(location), ...(location.provider ? [] : [location.harness]), generation].join("/");
}

/** The agent a plan pays for (its harness record's `planProviders`): the one its limits are told against. */
function planHarness(provider: PlanProvider): HarnessId {
	return MACHINE_HARNESS_IDS.find(id => machineHarness(id)?.planProviders.includes(provider)) ?? "windlass";
}

/** A plan's health as an account the turn queue waits on, keyed apart from the key of the same provider. */
function planAccount(plan: ModelPlanStatus & { generation: string }): ProviderAccount {
	const warning = plan.windows.some(w => (w.usedPct ?? 0) >= 90 && (w.resetsAt === null || w.resetsAt > Date.now()));
	return {
		key: accountKey(
			{ place: "hosted", harness: planHarness(plan.provider), provider: plan.provider, plan: true },
			plan.generation,
		),
		provider: plan.provider,
		harness: planHarness(plan.provider),
		state: plan.health === "limited" ? "limited" : warning ? "warning" : "ok",
		limitedUntil: plan.health === "limited" ? plan.limitedUntil : null,
		windows: plan.windows,
	};
}

export async function loginGeneration(
	db: Db,
	{ place, harness, provider, plan }: AccountLocation,
): Promise<string | null> {
	if (provider && plan) {
		const [row] = await db.execute<{ generation: string }>(
			"SELECT generation FROM model_plan WHERE provider=?",
			provider,
		);
		return row?.generation ?? null;
	}
	if (provider) {
		const [row] = await db.execute<{ generation: string }>(
			"SELECT generation FROM model_provider WHERE provider=?",
			provider,
		);
		return row?.generation ?? null;
	}
	if (harness !== "windlass") {
		if (place === "hosted") return null;
		const [machine] = await db.execute<{ harnesses: string | null }>(
			"SELECT json_extract(facts, '$.report.harnesses') AS harnesses FROM machines WHERE id=? AND expires IS NULL",
			place,
		);
		if (!machine) return null;
		const entries: import("../contract.js").MachineSummary["harnesses"] = JSON.parse(machine.harnesses ?? "[]");
		const entry = entries?.find(h => h.id === harness);
		return entry && entry.signIn !== "none" ? (entry.loginGeneration ?? "legacy") : null;
	}
	// Windlass's ChatGPT sign-in is the ChatGPT plan's row.
	const [row] = await db.execute<{ generation: string }>("SELECT generation FROM model_plan WHERE provider='openai'");
	return row?.generation ?? "0";
}

export async function recordProviderUsage(
	db: RawAccess,
	location: AccountLocation,
	generation: string,
	observation: UsageObservation,
) {
	// A plan keeps its limits on its own row (credentials/plans.ts), where Pay with reads them.
	if (location.plan && location.provider && isPlanProvider(location.provider))
		return (await observePlan(db, location.provider, generation, observationReading(observation))) !== null;
	return db.transaction(
		async tx => {
			if ((await loginGeneration(tx, location)) !== generation) return false;
			const { harness } = location;
			const place = location.provider ? "settings" : accountPlace(location);
			const connection = location.provider ?? harness;
			const [row] = await tx.execute<{ data: string }>(
				"SELECT data FROM provider_usage WHERE place=? AND harness=? AND generation=?",
				place,
				connection,
				generation,
			);
			if (!row && observation.kind === "success") return false;
			const previous: StoredUsage = row
				? JSON.parse(row.data)
				: {
						backoff: 0,
						lastRefusal: -1,
						lastSuccess: -1,
						account: {
							key: accountKey(location, generation),
							provider: location.provider,
							harness,
							state: "ok",
							limitedUntil: null,
							windows: [],
						},
					};
			const updated = observeUsage(previous, observation);
			if (updated === previous) return false;
			await tx.execute(
				"INSERT OR REPLACE INTO provider_usage VALUES (?,?,?,?)",
				place,
				connection,
				generation,
				JSON.stringify(updated),
			);
			return true;
		},
		{ name: "provider.observe" },
	);
}

export async function providerAccounts(db: Db, now: number) {
	const byPlace = new Map<string, ProviderAccount[]>();
	const generations = await db.execute<{ provider: PlanProvider; generation: string }>(
		"SELECT provider, generation FROM model_plan WHERE check_ok = 1",
	);
	for (const plan of await planStatuses(db)) {
		const generation = generations.find(row => row.provider === plan.provider)?.generation;
		if (plan.ok && generation) byPlace.set("plan/" + plan.provider, [planAccount({ ...plan, generation })]);
	}
	const rows = await db.execute<{
		place: string;
		harness: HarnessId | ModelProvider;
		generation: string;
		data: string;
	}>("SELECT * FROM provider_usage");
	for (const row of rows) {
		const stored: StoredUsage = JSON.parse(row.data);
		const { account } = stored;
		const location = {
			place: row.place,
			harness: account.harness,
			provider: isModelProvider(row.harness) ? row.harness : undefined,
		};
		if ((await loginGeneration(db, location)) !== row.generation) continue;
		const place = accountPlace(location);
		account.state = accountState(stored, now);
		if (account.state !== "limited") account.limitedUntil = null;
		const list = byPlace.get(place) ?? [];
		list.push(account);
		byPlace.set(place, list);
	}
	return byPlace;
}

export function accountFor(accounts: Map<string, ProviderAccount[]>, location: AccountLocation) {
	const list = accounts.get(accountPlace(location));
	const account = location.provider ? list?.[0] : list?.find(a => a.harness === location.harness);
	return account && { ...account, harness: location.harness };
}

export function accountsAt(
	accounts: Map<string, ProviderAccount[]>,
	place: string,
	keys: readonly ModelProvider[] = [],
) {
	return [
		...(accounts.get(WINDLASS_ACCOUNT) ?? []),
		...(accounts.get(place) ?? []),
		...keys.flatMap(p => accounts.get("settings/" + p) ?? []),
	];
}

export function limitedAccounts(accounts: Map<string, ProviderAccount[]>) {
	return [...accounts].flatMap(([machineId, list]) =>
		list.flatMap(a =>
			a.state === "limited" && a.limitedUntil !== null
				? [{ machineId, harness: a.harness, limitedUntil: a.limitedUntil, accountKey: a.key }]
				: [],
		),
	);
}
