import { config } from "../../config.js";
import { layerFor } from "../../layer.js";
import type { SandboxLayer } from "../../sandbox/api.js";
import { RUNNER_SOCKET, RunnerLink, machineActor } from "../../sandbox/runner-layer.js";
import { conversationDirty } from "./timeline.js";
import type { Ctx, SessionMeta } from "./state.js";

export function layerOf(c: Ctx, meta: SessionMeta): Promise<SandboxLayer> {
	return layerFor(meta.place, c.key[0]!, meta.place.kind === "machine" ? runnerLink(c, meta.place.machineId) : null);
}

/** The session's link to its machine's runner, made the first time the session needs the machine. */
export function runnerLink(c: Ctx, machineId: string): RunnerLink {
	if (!c.vars.runner) {
		const [uid, sessionId] = c.key as [string, string];
		const client = c.client();
		c.vars.runner = new RunnerLink(
			{ uid, sessionId, machineId, machineName: c.vars.meta?.machineName },
			machineActor(() => client, uid, machineId),
			reason => {
				console.log(`[wlp] runner.conversation_ended session=${sessionId} machine=${machineId}: ${reason}`);
			},
			// Closing a runner link also reports its status. Broadcasts are invalid during actor shutdown.
			reach => {
				if (!c.vars.stopping) c.broadcast("machine", reach);
			},
			durableTurns(c) ? { from: c.vars.restored, onDirty: () => conversationDirty(c) } : undefined,
		);
		c.vars.restored = null;
	}
	return c.vars.runner;
}

/** WLP_RUNNER_DURABLE_TURNS: a machine session keeps its runner conversation and its turn's protocol state (runner/journal.ts). */
export function durableTurns(c: Ctx): boolean {
	return config.machines?.durableTurns === true && c.vars.meta?.place.kind === "machine";
}

/** The runner's own socket to the session: it proves itself in its first frame, not with a user's token. */
export function isRunnerSocket(request: Request | undefined): boolean {
	return request !== undefined && new URL(request.url).pathname === `/websocket/${RUNNER_SOCKET}`;
}

/** For a session on one of the user's machines, that machine as a question or a pull request names it: by the name kept at launch. */
export function machineOf(meta: SessionMeta): { name: string | null } | null {
	return meta.place.kind === "machine" ? { name: meta.machineName } : null;
}
