import type { HarnessId, LastStart, SandboxPlace } from "./contract.js";
import type { DefaultsDb } from "./repository-defaults.js";

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
