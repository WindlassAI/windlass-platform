/**
 * A repository's defaults for new sessions: the sandbox profile and the model a session on it starts
 * with, where its user said so (README, "A repository's page").
 *
 * Whose they are. The user's, kept in their `user` actor, one row per repository of their GitHub
 * connection, under the key the setup command and secrets use. A repository permits factory
 * screenshots by default. Its agents read that setting when a turn starts. Clearing every
 * override, including restoring screenshots, removes the row.
 *
 * The launch form reads the profile and model. A save checks the sandbox against what this
 * deployment offers then, the model against the user's own models then (account-models.ts). Both can
 * change afterwards, so a saved default may come to name a sandbox or a model that is gone: it is
 * handed out as it was saved, and whoever reads it leaves it out.
 *
 * Saving. A save names the fields it changes, and each save is one statement that writes those
 * columns and no others. The actor's actions interleave wherever one of them waits, so a save that
 * read a row and wrote it back whole could undo what another wrote in between: two saves that change
 * different fields would leave one of them. Here neither reads before it writes, and both stay.
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/repository-check.ts runs them against a database of its own.
 */

import { modelRefusal } from "./account-models.js";
import { MAX_REPOSITORY_DEFAULTS, type ModelList, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId } from "./contract.js";

/** Thrown for defaults that cannot be saved; `message` is fit to show, `code` is the UserError's. */
export class DefaultsProblem extends Error {
	constructor(
		readonly code: "bad_input" | "bad_model",
		message: string,
	) {
		super(message);
		this.name = "DefaultsProblem";
	}
}

/** What a save changes: a field that is absent stays as it is, and null saves none for it. */
export interface DefaultsChange {
	screenshots?: boolean;
	profile?: SandboxProfileId | null;
	model?: string | null;
}

/**
 * What a client sent, as a change: `screenshots` is an optional boolean; `profile` and `model` may be omitted,
 * null, or a sandbox this deployment can run and one of the user's models (account-models.ts). Throws
 * DefaultsProblem otherwise.
 */
export function cleanDefaults(raw: unknown, profiles: readonly SandboxProfile[], models: ModelList): DefaultsChange {
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as { profile?: unknown; model?: unknown; screenshots?: unknown };
	const change: DefaultsChange = {};
	if (input.screenshots !== undefined) {
		if (typeof input.screenshots !== "boolean") throw new DefaultsProblem("bad_input", "Screenshots must be true or false.");
		change.screenshots = input.screenshots;
	}
	if (input.profile !== undefined) {
		if (input.profile === null) change.profile = null;
		else {
			const chosen = profiles.find((profile) => profile.id === input.profile);
			if (!chosen) throw new DefaultsProblem("bad_input", "Choose one of the listed sandboxes.");
			if (!chosen.available) throw new DefaultsProblem("bad_input", `${chosen.name} cannot be chosen yet. ${chosen.unavailableReason ?? ""}`.trim());
			change.profile = chosen.id;
		}
	}
	if (input.model !== undefined) {
		const refusal = input.model === null ? null : modelRefusal(models, input.model);
		if (refusal !== null) throw new DefaultsProblem("bad_model", refusal);
		change.model = input.model as string | null;
	}
	return change;
}

/** The part of the actor's database these functions use. */
export interface DefaultsDb {
	execute<Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]>;
}

/** One row per repository: `project` is "github:<GitHub's id>", `label` the repository in words, for a reader of the table. */
export const DEFAULTS_TABLE = `
	CREATE TABLE IF NOT EXISTS repository_defaults (
		project TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		screenshots INTEGER NOT NULL DEFAULT 1,
		profile TEXT,
		model TEXT,
		updated_at INTEGER NOT NULL
	)
`;

/** The defaults saved for a project; none when there is no row. */
export async function readDefaults(db: DefaultsDb, project: string): Promise<RepositoryDefaults> {
	const [row] = await db.execute<{ profile: string | null; model: string | null; screenshots: number; updated_at: number }>("SELECT profile, model, screenshots, updated_at FROM repository_defaults WHERE project = ?", project);
	return { screenshots: row?.screenshots !== 0, profile: (row?.profile ?? null) as SandboxProfileId | null, model: row?.model ?? null, updatedAt: row?.updated_at ?? null };
}

/**
 * Makes a change that was cleaned already and answers with what is saved then. The fields the change
 * names are written in one statement, which touches no other column; a row with nothing left in it
 * is removed, and so are the rows beyond what one user may keep.
 */
export async function saveDefaults(db: DefaultsDb, project: string, label: string, change: DefaultsChange, now: number): Promise<RepositoryDefaults> {
	const columns = (["profile", "model", "screenshots"] as const).filter((column) => change[column] !== undefined);
	if (columns.length > 0) {
		await db.execute(
			`INSERT INTO repository_defaults (project, label, profile, model, screenshots, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (project) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}, label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, updated_at = excluded.updated_at`,
			project,
			label,
			change.profile ?? null,
			change.model ?? null,
			change.screenshots === false ? 0 : 1,
			now,
		);
		await db.execute("DELETE FROM repository_defaults WHERE project = ? AND profile IS NULL AND model IS NULL AND screenshots = 1", project);
		// Somebody who saves for one repository after another leaves no more than this many rows.
		await db.execute("DELETE FROM repository_defaults WHERE project NOT IN (SELECT project FROM repository_defaults ORDER BY updated_at DESC, project LIMIT ?)", MAX_REPOSITORY_DEFAULTS);
	}
	return readDefaults(db, project);
}
