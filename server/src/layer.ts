/**
 * The hosted sandbox layer, chosen by WLP_SANDBOX: `fake` (in memory), `docker` (containers on this
 * machine) or `e2b` (E2B microVMs, for a deployment of several servers). The real layers are imported
 * only when they are asked for, so the server starts in fake mode whatever state server/src/sandbox/
 * is in, and a server on Docker never loads E2B's SDK.
 */

import { config } from "./config.js";
import type { SandboxPlace } from "./contract.js";
import type { SandboxLayer } from "./sandbox/api.js";
import type { RunnerLink } from "./sandbox/runner-layer.js";

let loading: Promise<SandboxLayer> | null = null;

async function load(): Promise<SandboxLayer> {
	if (config.sandbox === "fake") {
		const { createFakeSandboxLayer } = await import("./sandbox-fake.js");
		return createFakeSandboxLayer();
	}
	// Not a literal, so this file type-checks and loads without the real layers being present.
	const specifier = "./sandbox/index.js";
	const module = (await import(specifier)) as { createSandboxLayer?: () => SandboxLayer; createE2bLayer?: () => Promise<SandboxLayer> };
	if (config.sandbox === "e2b") {
		if (typeof module.createE2bLayer !== "function") throw new Error("server/src/sandbox/index.ts does not export createE2bLayer()");
		return module.createE2bLayer();
	}
	if (typeof module.createSandboxLayer !== "function") {
		throw new Error("server/src/sandbox/index.ts does not export createSandboxLayer()");
	}
	return module.createSandboxLayer();
}

export function getLayer(): Promise<SandboxLayer> {
	if (!loading) {
		loading = load().catch((error) => {
			loading = null;
			throw error;
		});
	}
	return loading;
}

/**
 * The layer of a session's place. A machine is addressed by its owner and its id, and its layer is
 * made from those, in the session's link to the machine's runner, on whichever server asks, so no
 * server has to have been told of the machine. Making it calls nothing, and whether the machine is
 * offline or removed does not matter to it: such a session stays readable, and its operations say why
 * they fail (sandbox/runner-layer.ts). It throws only for a link that is not the session's own, which
 * is the caller's mistake.
 */
export async function layerFor(place: SandboxPlace, uid: string, link: RunnerLink | null): Promise<SandboxLayer> {
	if (place.kind === "hosted") return getLayer();
	if (link === null || link.who.uid !== uid || link.who.machineId !== place.machineId) throw new Error("A machine's layer is its session's: pass the session's link.");
	const { machineLayer } = await import("./sandbox/runner-layer.js");
	return machineLayer(link, await getLayer());
}
