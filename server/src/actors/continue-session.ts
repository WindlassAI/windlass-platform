/**
 * The `user` actor's side of continuing a session in a new one (`continueSession` in user.ts): the
 * settings the new session is made with, and the copy of the earlier agent's session in the backup
 * store. The session's side is agent-session/continuation.ts.
 */

import type { CreateSessionInput } from "../contract.js";
import type { SandboxLayer } from "../sandbox/api.js";
import { capabilitiesOf } from "../sandbox/harnesses.js";
import { privateSessionData } from "../sandbox/session-data.js";
import { errorText } from "../util.js";
import type { Continuation, ForkSource } from "./internal.js";

/** What `makeSession` is asked for: the earlier session's settings, on its repository's default branch or, stacked, on its pushed branch. */
export function continuedInput(source: ForkSource, stacked: boolean): CreateSessionInput {
	return {
		harness: source.harness,
		place: source.place,
		profile: source.profile,
		model: source.model,
		mode: source.mode,
		...((source.size === 2 || source.size === 4) && { size: source.size }),
		...(source.hostedSize && { hostedSize: source.hostedSize }),
		repository: { id: source.repo.id, ...(stacked && source.pushedBranch && { branch: source.pushedBranch }) },
	};
}

/**
 * Copies the earlier session's agent session to the new session's name in the backup store, for the
 * new session's first sandbox to restore. Only hosted, on a layer with a store, for an agent whose
 * sessions are copied, and where sandboxes keep the agent's data on their own disks: on a machine, or on
 * shared agent data, the new session would resume the very session the earlier one goes on writing.
 * Null when there is no copy to make or it could not be made: the new session then gets an account of
 * the earlier one instead.
 */
export async function copyAgentSession(
	layer: Pick<SandboxLayer, "backups" | "sandboxes">,
	uid: string,
	from: string,
	to: string,
	source: ForkSource,
): Promise<Continuation["copy"]> {
	if (!source.copy || source.place.kind !== "hosted" || !capabilitiesOf(source.harness).backups) return null;
	const facts = { harness: source.harness, profile: source.profile };
	if (!layer.backups || !(await privateSessionData(facts, layer.sandboxes, null))) return null;
	try {
		if (await layer.backups.copy({ uid, sessionId: from }, { uid, sessionId: to })) {
			console.log(`[wlp] backup.copied session=${from} to=${to}`);
			return source.copy;
		}
		console.warn(`[wlp] backup.copy_missing session=${from} to=${to}: the store has no copy`);
	} catch (error) {
		console.warn(`[wlp] backup.copy_failed session=${from} to=${to}: ${errorText(error)}`);
	}
	return null;
}
