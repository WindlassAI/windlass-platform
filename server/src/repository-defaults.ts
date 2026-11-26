/** Account and repository run choices share a schema. Saves patch only the settings they name. */
import { modelRefusal } from "./account-models.js";
import { type AccountDefaults, type ItemPlaceDefaults, type MachineSummary, type StartPlace, type HostedSize, MAX_REPOSITORY_DEFAULTS, type ModelList, type RepositoryAutonomy, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, HOSTED_SIZE_NAMES, isHostedSize } from "./contract.js";
import { startPlaceProblem } from "./start-place.js";

const ACCOUNT = "account";
const AUTONOMY_FIELDS = ["autoApprovePlans", "autoMergeSingles", "waitForCiOnEachPart"] as const;

/** This module is bundled by the web app too, so it throws a plain error that the server's clientError turns into a `limit` refusal. */
export class RepositoryLimit extends Error {
	name = "RepositoryLimit";
}

/** At the cap, a new repository's settings are refused: older repositories' saved settings are never dropped to make room. */
export async function refuseAtRepositoryCap(db: DefaultsDb, table: string, project: string, max: number, what: string): Promise<void> {
	const [row] = await db.execute<{ known: number; total: number }>(`SELECT (SELECT COUNT(*) FROM ${table} WHERE project = ?) AS known, (SELECT COUNT(*) FROM ${table} WHERE project != 'account') AS total`, project);
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
	reviewModel?: string | null;
	reviewEffort?: string | null;
	effort?: string | null;
	item_place?: ItemPlaceDefaults | null;
	previousStartPlace?: null;
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
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof RepositoryDefaults, unknown>> & { startPlace?: StartPlace | null };
	const change: DefaultsChange = {};
	if (input.place !== undefined || input.startPlace !== undefined) change.previousStartPlace = null;
	if (input.startPlace !== undefined) {
		const place = input.startPlace;
		const problem = place === null ? null : startPlaceProblem(place, machines);
		if (problem) throw new DefaultsProblem("bad_input", problem);
		change.item_place = place?.kind === "machine" ? { place: { machine: place.machineId }, machineProfile: place.profile } : { place: place ? "hosted" : null, machineProfile: null };
	}
	for (const field of AUTONOMY_FIELDS) {
		const value = input[field];
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
	for (const key of ["effort", "reviewEffort"] as const) {
		const effort = input[key];
		if (effort === undefined) continue;
		if (effort !== null && (typeof effort !== "string" || !models.models.some(m => m.efforts.includes(effort))))
			throw new DefaultsProblem("bad_input", "Choose an effort offered by the model.");
		change[key] = effort;
	}
	for (const key of ["model", "reviewModel"] as const) {
		const model = input[key];
		if (model === undefined) continue;
		const refusal = model === null ? null : modelRefusal(models, model);
		if (refusal !== null) throw new DefaultsProblem("bad_model", refusal);
		change[key] = model as string | null;
	}
	if (input.hostedSize !== undefined) {
		// The saved choice stays explicit if the deployment later withdraws a size.
		if (input.hostedSize !== null && (!isHostedSize(input.hostedSize) || !sizes.includes(input.hostedSize))) throw new DefaultsProblem("bad_input", sizes.length > 1 ? `Choose one of the hosted sizes: ${sizes.map(size => HOSTED_SIZE_NAMES[size]).join(", ")}.` : "This deployment has one hosted size.");
		change.hostedSize = input.hostedSize;
	}
	return change;
}

/** The part of the actor's database these functions use. */
export interface DefaultsDb {
	execute<Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]>;
}

export const DEFAULTS_TABLE = `
	CREATE TABLE IF NOT EXISTS repository_defaults (
		project TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		settings TEXT NOT NULL DEFAULT '{}',
		screenshots INTEGER NOT NULL DEFAULT 0,
		${AUTONOMY_FIELDS.map(field => `${field} INTEGER NOT NULL DEFAULT 0`).join(", ")},
		updated_at INTEGER NOT NULL
	)
`;

/** Fold separate defaults columns into settings. The caller runs the whole upgrade in one transaction. */
export async function migrateDefaults(db: DefaultsDb): Promise<void> {
	const columns = (await db.execute<{ name: string }>("PRAGMA table_info(repository_defaults)")).map(c => c.name);
	const accountColumns = await db.execute<{ name: string }>("PRAGMA table_info(account_defaults)");
	const hadSettings = columns.includes("settings");
	const oldColumns = ["profile", "model", "hosted_size", "item_place", "start_place"].filter(c => columns.includes(c));
	for (const field of ["screenshots", ...AUTONOMY_FIELDS]) {
		if (!columns.includes(field)) await db.execute(`ALTER TABLE repository_defaults ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`);
	}
	if (!hadSettings) await db.execute("ALTER TABLE repository_defaults ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
	if (oldColumns.length) {
		for (const row of await db.execute(`SELECT project, settings, ${oldColumns.join(", ")} FROM repository_defaults`)) {
			await db.execute("UPDATE repository_defaults SET settings=? WHERE project=?", migratedSettings(row, hadSettings), row.project);
		}
		for (const name of oldColumns) await db.execute(`ALTER TABLE repository_defaults DROP COLUMN ${name}`);
	}
	if (!accountColumns.length) return;
	const [old] = await db.execute("SELECT * FROM account_defaults WHERE id=1");
	if (old) {
		const [current] = await db.execute("SELECT settings, updated_at FROM repository_defaults WHERE project=?", ACCOUNT);
		// A later save or deletion supersedes the old account row. Without item_place the previous import failed.
		if (!current && (!hadSettings || !oldColumns.length || !accountColumns.some(c => c.name === "item_place"))) {
			await db.execute("INSERT INTO repository_defaults (project, label, updated_at, settings) VALUES (?, '', ?, ?)", ACCOUNT, old.updated_at, migratedSettings(old, false));
		} else if (current) {
			await db.execute("UPDATE repository_defaults SET settings=? WHERE project=?", migratedSettings({ ...old, ...current }, true, current.updated_at === old.updated_at), ACCOUNT);
		}
	}
	await db.execute("DROP TABLE account_defaults");
}

function migratedSettings(row: Record<string, unknown>, hadSettings: boolean, adoptStart = true): string {
	const item = JSON.parse(String(row.item_place ?? "{}")) as ItemPlaceDefaults;
	const settings: Partial<RepositoryDefaults> = hadSettings ? JSON.parse(String(row.settings)) : Object.fromEntries(Object.entries({
		...item, profile: row.profile, model: row.model, hostedSize: row.hosted_size,
	}).filter(([, value]) => value != null));
	const start: StartPlace | null = JSON.parse(String(row.start_place ?? "null"));
	if (start) {
		const place = start.kind === "hosted" ? "hosted" : { machine: start.machineId };
		const profile = start.kind === "machine" ? start.profile : null;
		const samePlace = (a: ItemPlaceDefaults["place"], b: ItemPlaceDefaults["place"]) =>
			a && b && typeof a === "object" && typeof b === "object" ? a.machine === b.machine : (a ?? null) === (b ?? null);
		const unchanged = !hadSettings || (samePlace(settings.place, item.place) && (settings.machineProfile ?? null) === (item.machineProfile ?? null));
		if (samePlace(settings.place, place) && (!profile || settings.machineProfile === profile)) return JSON.stringify(settings);
		if (adoptStart && unchanged && (!settings.place || samePlace(settings.place, place)) &&
			(!profile || !settings.machineProfile || settings.machineProfile === profile)) {
			settings.place = place;
			if (profile) settings.machineProfile = profile;
		} else settings.previousStartPlace = start;
	}
	return JSON.stringify(settings);
}

function personalPlace(settings: ItemPlaceDefaults): StartPlace | undefined {
	const place = settings.place;
	if (place === "hosted") return { kind: "hosted" };
	if (place && typeof place === "object" && settings.machineProfile)
		return { kind: "machine", machineId: place.machine, profile: settings.machineProfile };
}

export async function readDefaults(db: DefaultsDb, project: string): Promise<RepositoryDefaults> {
	const [row] = await db.execute<{ settings: string; screenshots: number; updated_at: number } & Record<typeof AUTONOMY_FIELDS[number], number>>(
		`SELECT settings, screenshots, updated_at, ${AUTONOMY_FIELDS.join(", ")} FROM repository_defaults WHERE project=?`, project);
	const settings = JSON.parse(row?.settings ?? "{}") as Partial<RepositoryDefaults>;
	return { place: null, harness: null, machineProfile: null, placeFallback: null, screenshots: row?.screenshots === 1,
		profile: null, model: null, hostedSize: null, ...settings, startPlace: personalPlace(settings), updatedAt: row?.updated_at ?? null,
		...Object.fromEntries(AUTONOMY_FIELDS.filter(field => row?.[field] === 1).map(field => [field, true])) };
}

export async function saveDefaults(db: DefaultsDb, project: string, label: string, change: DefaultsChange, now: number): Promise<RepositoryDefaults> {
	const { profile, model, effort, reviewModel, reviewEffort, hostedSize } = change;
	const patch = JSON.stringify({ profile, model, effort, reviewModel, reviewEffort, hostedSize, previousStartPlace: change.previousStartPlace, ...change.item_place });
	const columns = (["screenshots", ...AUTONOMY_FIELDS] as const).filter(key => change[key] !== undefined);
	if (patch !== "{}" || columns.length) {
		if (project !== ACCOUNT) await refuseAtRepositoryCap(db, "repository_defaults", project, MAX_REPOSITORY_DEFAULTS, "defaults");
		await db.execute(`INSERT INTO repository_defaults (project, label, updated_at, settings${columns.map(k => ", " + k).join("")})
			VALUES (?, ?, ?, json_patch('{}', ?)${columns.map(() => ", ?").join("")})
			ON CONFLICT(project) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END,
			updated_at = excluded.updated_at, settings = json_patch(settings, ?)${columns.map(k => `, ${k}=excluded.${k}`).join("")}`,
			project, label, now, patch, ...columns.map(k => Number(change[k])), patch);
		await db.execute(`DELETE FROM repository_defaults WHERE project=? AND settings='{}' AND screenshots=0 AND ${AUTONOMY_FIELDS.map(k => k + "=0").join(" AND ")}`, project);
	}
	return readDefaults(db, project);
}

function accountFields<T extends RepositoryAutonomy & { screenshots?: boolean }>({ screenshots, autoApprovePlans, autoMergeSingles, waitForCiOnEachPart, ...settings }: T) {
	return settings;
}

export async function readAccountDefaults(db: DefaultsDb): Promise<AccountDefaults> {
	return accountFields(await readDefaults(db, ACCOUNT));
}

export async function saveAccountDefaults(db: DefaultsDb, change: DefaultsChange, now: number): Promise<AccountDefaults> {
	return accountFields(await saveDefaults(db, ACCOUNT, "", accountFields(change), now));
}
