/**
 * linearWorkspace[workspaceId]: which user a team of the workspace files for. Service actions only.
 *
 * It exists because a webhook has no owner session and no other actor is keyed by anything a delivery carries. It is no second
 * store of connections or mappings: the owner's `user` actor keeps those and decides every filing, and checks its own mapping again
 * then, so a claim that is stale files nothing. This actor only makes a team's claim exclusive, which one `INSERT OR IGNORE`
 * does: of two owners who save the same team at once, one gets it.
 */

import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import { isLinearId } from "../linear/app.js";

export const linearWorkspace = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !isLinearId(c.key[0]) || c.key[0] !== c.key[0]!.toLowerCase()) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS team_owner (team_id TEXT PRIMARY KEY, uid TEXT NOT NULL)");
	} }),
	actions: {
		/** True when the team is this user's now, or already was; false when another user has it. */
		internalClaim: async (c, input: { teamId: string; uid: string }): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (!isLinearId(input.teamId) || typeof input.uid !== "string" || input.uid === "") return false;
			await c.db.execute("INSERT OR IGNORE INTO team_owner VALUES (?, ?)", input.teamId.toLowerCase(), input.uid);
			const [row] = await c.db.execute<{ uid: string }>("SELECT uid FROM team_owner WHERE team_id = ?", input.teamId.toLowerCase());
			return row?.uid === input.uid;
		},
		/** Gives the team up. Only its holder can. */
		internalRelease: async (c, input: { teamId: string; uid: string }): Promise<void> => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM team_owner WHERE team_id = ? AND uid = ?", String(input.teamId).toLowerCase(), input.uid);
		},
		internalOwner: async (c, teamId: string): Promise<string | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string }>("SELECT uid FROM team_owner WHERE team_id = ?", String(teamId).toLowerCase());
			return row?.uid ?? null;
		},
	},
});
