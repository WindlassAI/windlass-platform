/**
 * A repository's defaults for new sessions: the sandbox profile and the model a session on it starts
 * with, where its user said so (docs/github-and-repositories.md, "A repository's page").
 *
 * Whose they are. The user's, kept in their `user` actor, one row per repository of their GitHub
 * connection, under the key the setup command and secrets use. Factory screenshots need an explicit
 * opt-in. Agents read that setting when a turn starts. Clearing the last override removes the row.
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
import { type ItemPlaceDefaults, type MachineSummary, type StartPlace, type HostedSize, MAX_REPOSITORY_DEFAULTS, type ModelList, type RepositoryAutonomy, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, HOSTED_SIZE_NAMES, isHostedSize } from "./contract.js";
import { startPlaceProblem } from "./start-place.js";

const AUTONOMY_FIELDS = ["autoApprovePlans", "autoMergeSingles", "waitForCiOnEachPart"] as const;

/** Thrown for defaults that cannot be saved; `message` is fit to show, `code` is the UserError's. */
/** This module is bundled by the web app too, so it throws a plain error that the server's clientError turns into a `limit` refusal. */
export class RepositoryLimit extends Error {
	name = "RepositoryLimit";
}

/** At the cap, a new repository's settings are refused: older repositories' saved settings are never dropped to make room. */
export async function refuseAtRepositoryCap(db: { execute(sql: string, ...args: never[]): Promise<unknown[]> }, table: string, project: string, max: number, what: string): Promise<void> {
	const [row] = await db.execute(`SELECT (SELECT COUNT(*) FROM ${table} WHERE project = ?) AS known, (SELECT COUNT(*) FROM ${table}) AS total`, project as never) as Array<{ known: number; total: number }>;
	if (row && !Number(row.known) && Number(row.total) >= max)
		throw new RepositoryLimit(`You have saved ${what} for ${max} repositories, the most this account keeps. Clear them for a repository you no longer use, then save again.`);
}

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
export interface DefaultsChange extends RepositoryAutonomy {
	start_place?: StartPlace | null;
	item_place?: ItemPlaceDefaults | null;
	screenshots?: boolean;
	profile?: SandboxProfileId | null;
	model?: string | null;
	hostedSize?: HostedSize | null;
}

export function repositoryDefaultsLog(uid: string, project: string, change: DefaultsChange): string {
	const fields = [`[wlp] defaults.saved uid=${uid} project=${project}`];
	if (change.profile !== undefined) fields.push(`profile=${change.profile ?? "none"}`);
	if (change.model !== undefined) fields.push(`model=${change.model ?? "none"}`);
	if (change.hostedSize !== undefined) fields.push(`hosted_size=${change.hostedSize ?? "none"}`);
	for (const field of AUTONOMY_FIELDS) {
		if (change[field] !== undefined) fields.push(`${field.replace(/[A-Z]/g, c => "_" + c.toLowerCase())}=${change[field]}`);
	}
	return fields.join(" ");
}

/**
 * What a client sent, as a change: `screenshots` is an optional boolean; `profile` and `model` may be omitted,
 * null, or a sandbox this deployment can run and one of the user's models (account-models.ts). Throws
 * DefaultsProblem otherwise.
 */
export function cleanDefaults(raw: unknown, profiles: readonly SandboxProfile[], models: ModelList, sizes: readonly HostedSize[] = [], machines: readonly MachineSummary[] = []): DefaultsChange {
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as { startPlace?: StartPlace | null; profile?: unknown; model?: unknown; screenshots?: unknown; hostedSize?: unknown };
	const change: DefaultsChange = {};
	if (input.startPlace !== undefined) {
		const place = input.startPlace;
		const problem = place === null ? null : startPlaceProblem(place, machines);
		if (problem) throw new DefaultsProblem("bad_input", problem);
		change.start_place = place?.kind === "machine" ? { kind: "machine", machineId: place.machineId, profile: place.profile } : place ? { kind: "hosted" } : null;
	}
	for (const field of AUTONOMY_FIELDS) {
		const value = (input as Record<string, unknown>)[field];
		if (value === undefined) continue;
		if (typeof value !== "boolean") throw new DefaultsProblem("bad_input", "A repository autonomy setting must be true or false.");
		change[field] = value;
	}
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
	if (input.hostedSize !== undefined) {
		// `sizes`: what the deployment offers now. A size saved earlier that it no longer offers is read as the largest below it.
		if (input.hostedSize !== null && (!isHostedSize(input.hostedSize) || !sizes.includes(input.hostedSize))) throw new DefaultsProblem("bad_input", sizes.length > 1 ? `Choose one of the hosted sizes: ${sizes.map(size => HOSTED_SIZE_NAMES[size]).join(", ")}.` : "This deployment has one hosted size.");
		change.hostedSize = input.hostedSize;
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
		screenshots INTEGER NOT NULL DEFAULT 0,
		profile TEXT,
		model TEXT,
		updated_at INTEGER NOT NULL,
		hosted_size TEXT,
		${AUTONOMY_FIELDS.map(field => `${field} INTEGER NOT NULL DEFAULT 0`).join(",\n\t\t")},
		item_place TEXT,
		start_place TEXT
	)
`;

/** Existing repositories inherit off for autonomy settings. */
export async function migrateDefaults(db: DefaultsDb): Promise<void> {
	const columns = await db.execute<{ name: string }>("PRAGMA table_info(repository_defaults)");
	for (const field of AUTONOMY_FIELDS)
		if (!columns.some(column => column.name === field)) await db.execute(`ALTER TABLE repository_defaults ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`);
	if (!columns.some(column => column.name === "start_place")) await db.execute("ALTER TABLE repository_defaults ADD COLUMN start_place TEXT");
	if (!columns.some(column => column.name === "item_place")) await db.execute("ALTER TABLE repository_defaults ADD COLUMN item_place TEXT");
	if (!columns.some((column) => column.name === "hosted_size")) await db.execute("ALTER TABLE repository_defaults ADD COLUMN hosted_size TEXT");
}

/** The defaults saved for a project; none when there is no row. */
export async function readDefaults(db: DefaultsDb, project: string): Promise<RepositoryDefaults> {
	const [row] = await db.execute<{ start_place: string | null; item_place: string | null; profile: string | null; model: string | null; screenshots: number; updated_at: number; hosted_size: string | null } & Record<typeof AUTONOMY_FIELDS[number], number>>(`SELECT start_place, item_place, ${AUTONOMY_FIELDS.join(", ")}, profile, model, screenshots, updated_at, hosted_size FROM repository_defaults WHERE project = ?`, project);
	return {
		place: null, harness: null, machineProfile: null, placeFallback: null,
		...(row?.start_place && { startPlace: JSON.parse(row.start_place) as StartPlace }),
		...(row?.item_place && JSON.parse(row.item_place) as ItemPlaceDefaults),
		...Object.fromEntries(AUTONOMY_FIELDS.filter(field => row?.[field] === 1).map(field => [field, true])),
		screenshots: row?.screenshots === 1, profile: (row?.profile ?? null) as SandboxProfileId | null, model: row?.model ?? null,
		hostedSize: isHostedSize(row?.hosted_size) ? row.hosted_size : null, updatedAt: row?.updated_at ?? null,
	};
}

/**
 * Makes a change that was cleaned already and answers with what is saved then. The fields the change
 * names are written in one statement, which touches no other column; a row with nothing left in it
 * is removed, and so are the rows beyond what one user may keep.
 */
export async function saveDefaults(db: DefaultsDb, project: string, label: string, change: DefaultsChange, now: number): Promise<RepositoryDefaults> {
	const columns = (["start_place", "item_place", "profile", "model", "screenshots", "hostedSize", ...AUTONOMY_FIELDS] as const).filter((column) => change[column] !== undefined).map((field) => (field === "hostedSize" ? "hosted_size" : field));
	if (columns.length > 0) {
		await refuseAtRepositoryCap(db, "repository_defaults", project, MAX_REPOSITORY_DEFAULTS, "defaults");
		await db.execute(
			`INSERT INTO repository_defaults (project, label, profile, model, screenshots, hosted_size, ${AUTONOMY_FIELDS.join(", ")}, start_place, item_place, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${AUTONOMY_FIELDS.map(() => "?").join(", ")}, ?, ?, ?)
			ON CONFLICT (project) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}, label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, updated_at = excluded.updated_at`,
			project,
			label,
			change.profile ?? null,
			change.model ?? null,
			change.screenshots === true ? 1 : 0,
			change.hostedSize ?? null,
			...AUTONOMY_FIELDS.map(field => Number(change[field] === true)),
			change.start_place ? JSON.stringify(change.start_place) : null,
			change.item_place ? JSON.stringify(change.item_place) : null,
			now,
		);
		await db.execute(`DELETE FROM repository_defaults WHERE project = ? AND profile IS NULL AND model IS NULL AND screenshots = 0 AND hosted_size IS NULL AND ${AUTONOMY_FIELDS.map(field => `${field} = 0`).join(" AND ")} AND start_place IS NULL AND item_place IS NULL`, project);
	}
	return readDefaults(db, project);
}
