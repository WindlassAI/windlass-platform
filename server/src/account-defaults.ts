/**
 * The account's defaults for new sessions: the sandbox profile and the model a session starts with
 * where neither the launch form nor the chosen repository says so (docs/github-and-repositories.md, "Account settings").
 *
 * Whose they are. The user's, kept in their `user` actor in one row, beside the rows a repository's
 * defaults are kept in (repository-defaults.ts) and under the same rules: what may be saved is what
 * `cleanDefaults` takes there, a sandbox this deployment can run and a model it offers, or none.
 *
 * What they do. Nothing on the server, as a repository's: the launch form reads them and starts from
 * them. The order is the form's own choice, then the chosen repository's default, then the account's,
 * then the deployment's first; each field is decided by itself, so a repository that saves only a
 * model leaves the sandbox to the account. A default that names a sandbox or a model the deployment
 * no longer offers is handed out as it was saved, and whoever reads it leaves it out and says so.
 *
 * Saving. As a repository's: a save names the fields it changes and is one statement that writes
 * those columns and no others. It reads nothing first, so a save of the sandbox and a save of the
 * model that run together both stay, and neither touches a server or a secret saved meanwhile, which
 * are other tables.
 *
 * Where the newest agent was started. Beside the defaults, in a row of its own, the place, the agent
 * and the mode of the newest agent the user started (`LastStart`): written by the server when that
 * agent is made, never by a client, so it holds only what a launch was allowed to choose. It is not a
 * default the user saved, so it does not touch `updatedAt`; forgetting it removes the row.
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/account-check.ts runs them against a database of its own.
 */

import type { AccountDefaults, ItemPlaceDefaults, HarnessId, LastStart, SandboxPlace, SandboxProfileId } from "./contract.js";
import type { DefaultsChange, DefaultsDb } from "./repository-defaults.js";

/** One row at most: the account's. */
export const ACCOUNT_DEFAULTS_TABLE = `
	CREATE TABLE IF NOT EXISTS account_defaults (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		profile TEXT,
		model TEXT,
		item_place TEXT,
		updated_at INTEGER NOT NULL
	)
`;

/** The account's defaults; none when there is no row. */
export async function readAccountDefaults(db: DefaultsDb): Promise<AccountDefaults> {
	const [row] = await db.execute<{ item_place: string | null; profile: string | null; model: string | null; updated_at: number }>("SELECT item_place, profile, model, updated_at FROM account_defaults WHERE id = 1");
	return { ...(row?.item_place && JSON.parse(row.item_place) as ItemPlaceDefaults), profile: (row?.profile ?? null) as SandboxProfileId | null, model: row?.model ?? null, updatedAt: row?.updated_at ?? null };
}

/**
 * Makes a change that was cleaned already (`cleanDefaults`) and answers with what is saved then. The
 * fields the change names are written in one statement, which touches no other column; a row with
 * nothing left in it is removed.
 */
export async function saveAccountDefaults(db: DefaultsDb, change: DefaultsChange, now: number): Promise<AccountDefaults> {
	const columns = (["item_place", "profile", "model"] as const).filter((column) => change[column] !== undefined);
	if (columns.length > 0) {
		await db.execute(
			`INSERT INTO account_defaults (id, profile, model, item_place, updated_at) VALUES (1, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}, updated_at = excluded.updated_at`,
			change.profile ?? null,
			change.model ?? null,
			change.item_place ? JSON.stringify(change.item_place) : null,
			now,
		);
		await db.execute("DELETE FROM account_defaults WHERE id = 1 AND profile IS NULL AND model IS NULL AND item_place IS NULL");
	}
	return readAccountDefaults(db);
}

/** One row at most: where the newest agent was started. `machine_id` is set when `place` is "machine". */
export const LAST_START_TABLE = `
	CREATE TABLE IF NOT EXISTS account_last_start (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		place TEXT NOT NULL,
		machine_id TEXT,
		harness TEXT NOT NULL,
		mode TEXT NOT NULL,
		started_at INTEGER NOT NULL
	)
`;

const HARNESSES: readonly HarnessId[] = ["windlass", "claude", "opencode", "codex"];

/** Where the newest agent was started; none before the first, or once forgotten. A row the code no longer reads (another agent's id) is none. */
export async function readLastStart(db: DefaultsDb): Promise<LastStart | null> {
	const [row] = await db.execute<{ place: string; machine_id: string | null; harness: string; mode: string; started_at: number }>("SELECT place, machine_id, harness, mode, started_at FROM account_last_start WHERE id = 1");
	if (!row || !HARNESSES.includes(row.harness as HarnessId)) return null;
	const place: SandboxPlace | null = row.place === "hosted" ? { kind: "hosted" } : row.place === "machine" && row.machine_id ? { kind: "machine", machineId: row.machine_id } : null;
	if (place === null) return null;
	return { place, harness: row.harness as HarnessId, mode: row.mode, startedAt: row.started_at };
}

/**
 * Remembers an agent that was just made. One statement; an older start that lands after a newer one
 * (two launches at once) does not replace it.
 */
export async function recordLastStart(db: DefaultsDb, start: LastStart): Promise<void> {
	await db.execute(
		`INSERT INTO account_last_start (id, place, machine_id, harness, mode, started_at) VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET place = excluded.place, machine_id = excluded.machine_id, harness = excluded.harness, mode = excluded.mode, started_at = excluded.started_at
		WHERE excluded.started_at >= account_last_start.started_at`,
		start.place.kind,
		start.place.kind === "machine" ? start.place.machineId : null,
		start.harness,
		start.mode,
		start.startedAt,
	);
}

export async function forgetLastStart(db: DefaultsDb): Promise<void> {
	await db.execute("DELETE FROM account_last_start WHERE id = 1");
}
