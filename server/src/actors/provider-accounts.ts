import type { RawAccess } from "rivetkit/db";
import type { HarnessId, ProviderAccount } from "../contract.js";
import { WINDLASS_ACCOUNT, accountState, observeUsage, type StoredUsage, type UsageObservation } from "../provider-usage.js";

export const PROVIDER_TABLE = `CREATE TABLE IF NOT EXISTS provider_usage (
	place TEXT NOT NULL, harness TEXT NOT NULL, generation TEXT NOT NULL, data TEXT NOT NULL,
	PRIMARY KEY(place,harness))`;

type Db = Pick<RawAccess, "execute">;
export interface AccountLocation { place: string; harness: HarnessId }

export async function loginGeneration(db: Db, { place, harness }: AccountLocation): Promise<string | null> {
	if (harness !== "windlass") {
		if (place === "hosted") return null;
		const [machine] = await db.execute<{ harnesses: string | null }>("SELECT json_extract(facts, '$.report.harnesses') AS harnesses FROM machines WHERE id=? AND expires IS NULL", place);
		if (!machine) return null;
		const entries: import("../contract.js").MachineSummary["harnesses"] = JSON.parse(machine.harnesses ?? "[]");
		const entry = entries?.find(h => h.id === harness);
		return entry && entry.signIn !== "none" ? entry.loginGeneration ?? "legacy" : null;
	}
	const [row] = await db.execute<{ generation: number }>("SELECT generation FROM signin WHERE id=1");
	return String(row?.generation ?? 0);
}

export async function recordProviderUsage(db: RawAccess, location: AccountLocation, generation: string, observation: UsageObservation) {
	return db.transaction(async tx => {
		if (await loginGeneration(tx, location) !== generation) return false;
		const { harness } = location;
		const place = harness === "windlass" ? WINDLASS_ACCOUNT : location.place;
		const [row] = await tx.execute<{ data: string }>("SELECT data FROM provider_usage WHERE place=? AND harness=? AND generation=?", place, harness, generation);
		if (!row && observation.kind === "success") return false;
		const previous: StoredUsage = row ? JSON.parse(row.data) : { backoff: 0, lastRefusal: -1, lastSuccess: -1,
			account: { key: [place, harness, generation].join("/"), harness, state: "ok", limitedUntil: null, windows: [] } };
		const updated = observeUsage(previous, observation);
		if (updated === previous) return false;
		await tx.execute("INSERT OR REPLACE INTO provider_usage VALUES (?,?,?,?)", place, harness, generation, JSON.stringify(updated));
		return true;
	}, { name: "provider.observe" });
}

export async function providerAccounts(db: Db, now: number) {
	const byPlace = new Map<string, ProviderAccount[]>();
	const rows = await db.execute<{ place: string; harness: HarnessId; generation: string; data: string }>("SELECT * FROM provider_usage");
	for (const row of rows) {
		if (await loginGeneration(db, row) !== row.generation) continue;
		const stored: StoredUsage = JSON.parse(row.data);
		const { account } = stored;
		account.state = accountState(stored, now);
		if (account.state !== "limited") account.limitedUntil = null;
		const list = byPlace.get(row.place) ?? [];
		list.push(account);
		byPlace.set(row.place, list);
	}
	return byPlace;
}

export function accountsAt(accounts: Map<string, ProviderAccount[]>, place: string) {
	return [...(accounts.get(WINDLASS_ACCOUNT) ?? []), ...(accounts.get(place) ?? [])];
}

export function limitedAccounts(accounts: Map<string, ProviderAccount[]>) {
	return [...accounts].flatMap(([machineId, list]) => list.flatMap(a => a.state === "limited" && a.limitedUntil !== null
		? [{ machineId, harness: a.harness, limitedUntil: a.limitedUntil, accountKey: a.key }] : []));
}
