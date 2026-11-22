import type { RawAccess } from "rivetkit/db";

// The user actor's record of where post-setup snapshots were saved (user.ts `internalSnapshotSaved`), read for placement.

/** How long a saved snapshot counts for placement: the age at which Docker and E2B remove one. */
const SNAPSHOT_PLACE_TTL_MS = 14 * 86_400_000;

/**
 * Where a post-setup snapshot of the project was saved that a new session of this user could start from:
 * saved under the setup command and GitHub connection there are now, within 14 days, and the repository
 * holds no secrets (a repository with secrets never reuses one). A placement hint only (factory/placement.ts).
 */
export async function snapshotPlaces(db: RawAccess, project: string, connectedAt: number | undefined): Promise<string[]> {
	if (connectedAt === undefined) return [];
	const rows = await db.execute<{ place: string }>(
		"SELECT p.place AS place FROM snapshot_place p JOIN setup_command s ON s.project = p.project AND s.updated_at = p.updated_at WHERE p.project = ? AND p.connected_at = ? AND p.saved_at > ? AND s.command != '' AND NOT EXISTS (SELECT 1 FROM repo_secret r WHERE r.project = p.project) ORDER BY p.place",
		project, connectedAt, Date.now() - SNAPSHOT_PLACE_TTL_MS);
	return rows.map((row) => row.place);
}
