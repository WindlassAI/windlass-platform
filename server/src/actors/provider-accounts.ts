import type { RawAccess } from "rivetkit/db";
import { isModelProvider, type HarnessId, type ModelProvider, type ProviderAccount } from "../contract.js";
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
export interface AccountLocation {
	place: string;
	harness: HarnessId;
	provider?: ModelProvider;
}

function accountPlace({ provider, place, harness }: AccountLocation) {
	return provider ? "settings/" + provider : harness === "windlass" ? WINDLASS_ACCOUNT : place;
}

export function accountKey(location: AccountLocation, generation: string) {
	return [accountPlace(location), ...(location.provider ? [] : [location.harness]), generation].join("/");
}

export async function loginGeneration(db: Db, { place, harness, provider }: AccountLocation): Promise<string | null> {
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
	const [row] = await db.execute<{ generation: number }>("SELECT generation FROM signin WHERE id=1");
	return String(row?.generation ?? 0);
}

export async function recordProviderUsage(
	db: RawAccess,
	location: AccountLocation,
	generation: string,
	observation: UsageObservation,
) {
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
