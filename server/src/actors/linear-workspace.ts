/**
 * linearWorkspace[workspaceId]: which user a team of the workspace files for. Service actions only.
 *
 * It exists because a webhook has no owner session and no other actor is keyed by anything a delivery carries. It is no second
 * store of connections or mappings: the owner's `user` actor keeps those and decides every filing, and checks its own mapping again
 * then, so a claim that is stale files nothing. This actor keeps claims exclusive while checking a previous holder.
 */

import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { internalConnection, requireServiceFor } from "../auth.js";
import { isActorGone, userActor } from "./internal.js";
import { isLinearId } from "../linear/app.js";

export const linearWorkspace = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => {
		if (c.key.length !== 1 || !isLinearId(c.key[0]) || c.key[0] !== c.key[0]!.toLowerCase()) c.destroy();
	},
	db: db({
		onMigrate: async db => {
			await db.execute("CREATE TABLE IF NOT EXISTS team_owner (team_id TEXT PRIMARY KEY, uid TEXT NOT NULL)");
		},
	}),
	createVars: () => ({ claiming: Promise.resolve() }),
	actions: {
		/** True when the team is this user's now, or already was; false when another user has it. */
		internalClaim: async (c, input: { teamId: string; uid: string }): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (!isLinearId(input.teamId) || typeof input.uid !== "string" || input.uid === "") return false;
			const teamId = input.teamId.toLowerCase();
			const claim = c.vars.claiming.then(async () => {
				const [row] = await c.db.execute<{ uid: string }>("SELECT uid FROM team_owner WHERE team_id = ?", teamId);
				if (row && row.uid !== input.uid) {
					const live = await userActor(c, row.uid)
						.internalLinearHoldsTeam(c.key[0]!, teamId)
						.catch(error => {
							if (isActorGone(error)) return false;
							throw error;
						});
					if (live) return false;
				}
				await c.db.execute("INSERT OR REPLACE INTO team_owner VALUES (?, ?)", teamId, input.uid);
				return true;
			});
			c.vars.claiming = claim.then(
				() => {},
				() => {},
			);
			return claim;
		},
		/** Gives the team up. Only its holder can. */
		internalRelease: async (c, input: { teamId: string; uid: string }): Promise<void> => {
			requireServiceFor(c, "call");
			await c.db.execute(
				"DELETE FROM team_owner WHERE team_id = ? AND uid = ?",
				String(input.teamId).toLowerCase(),
				input.uid,
			);
		},
		internalOwner: async (c, teamId: string): Promise<string | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string }>(
				"SELECT uid FROM team_owner WHERE team_id = ?",
				String(teamId).toLowerCase(),
			);
			return row?.uid ?? null;
		},
	},
});
