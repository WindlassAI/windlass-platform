/** Whether the agent's data in a session's sandbox goes with that sandbox (agent-session.ts). */

import type { HarnessId, SandboxProfileId } from "../contract.js";
import type { Sandboxes } from "./api.js";
import { keptInDataDir } from "./session-files.js";

/** What of a session's meta the answer depends on. */
export interface SessionDataFacts {
	harness?: HarnessId;
	origin?: { role?: string } | null;
	profile: SandboxProfileId;
	/**
	 * The sandbox whose Windlass data directory is a volume of its own, as its provider said when it was
	 * made (`SandboxHandle.ownData`).
	 */
	ownDataSandbox?: string | null;
}

/**
 * Whether the agent's data in the session's sandbox `sandbox` goes with it. Only Windlass's can be
 * elsewhere (`keptInDataDir`): every other agent keeps its sessions on the sandbox's own disk, on every
 * provider, whether or not they are copied (session-files.ts). Docker normally keeps Windlass's
 * sessions on a shared volume. A reviewer always owns its data, and so does a hardened Docker sandbox
 * that its provider said has a data volume of its own (`ownDataSandbox`): never the provider's word of
 * now, since a runner upgraded or downgraded since may make its sandboxes otherwise. Without a sandbox
 * (null), what one made now would have (`Sandboxes.privateSessionData`), for words only.
 */
export async function privateSessionData(
	meta: SessionDataFacts,
	sandboxes: Pick<Sandboxes, "sessionsLiveInSandbox" | "privateSessionData">,
	sandbox: string | null,
): Promise<boolean> {
	if (!keptInDataDir(meta.harness) || meta.origin?.role === "reviewer" || sandboxes.sessionsLiveInSandbox) return true;
	if (sandbox !== null) return meta.ownDataSandbox === sandbox;
	return (await sandboxes.privateSessionData?.(meta.profile)) === true;
}
