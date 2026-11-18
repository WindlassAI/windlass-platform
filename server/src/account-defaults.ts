/**
 * The account's defaults for new sessions: the sandbox profile and the model a session starts with
 * where neither the launch form nor the chosen repository says so (README, "Account settings").
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
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/account-check.ts runs them against a database of its own.
 */

import type { AccountDefaults, SandboxProfileId } from "./contract.js";
import type { DefaultsChange, DefaultsDb } from "./repository-defaults.js";

/** One row at most: the account's. */
export const ACCOUNT_DEFAULTS_TABLE = `
	CREATE TABLE IF NOT EXISTS account_defaults (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		profile TEXT,
		model TEXT,
		updated_at INTEGER NOT NULL
	)
`;

/** The account's defaults; none when there is no row. */
export async function readAccountDefaults(db: DefaultsDb): Promise<AccountDefaults> {
	const [row] = await db.execute<{ profile: string | null; model: string | null; updated_at: number }>("SELECT profile, model, updated_at FROM account_defaults WHERE id = 1");
	return { profile: (row?.profile ?? null) as SandboxProfileId | null, model: row?.model ?? null, updatedAt: row?.updated_at ?? null };
}

/**
 * Makes a change that was cleaned already (`cleanDefaults`) and answers with what is saved then. The
 * fields the change names are written in one statement, which touches no other column; a row with
 * nothing left in it is removed.
 */
export async function saveAccountDefaults(db: DefaultsDb, change: DefaultsChange, now: number): Promise<AccountDefaults> {
	const columns = (["profile", "model"] as const).filter((column) => change[column] !== undefined);
	if (columns.length > 0) {
		await db.execute(
			`INSERT INTO account_defaults (id, profile, model, updated_at) VALUES (1, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}, updated_at = excluded.updated_at`,
			change.profile ?? null,
			change.model ?? null,
			now,
		);
		await db.execute("DELETE FROM account_defaults WHERE id = 1 AND profile IS NULL AND model IS NULL");
	}
	return readAccountDefaults(db);
}
