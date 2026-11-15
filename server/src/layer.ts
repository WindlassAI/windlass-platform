/**
 * The sandbox layer in use, chosen by WLP_SANDBOX: `fake` (in memory), `docker` (containers on this
 * machine) or `e2b` (E2B microVMs, for a deployment of several servers). The real layers are imported
 * only when they are asked for, so the server starts in fake mode whatever state server/src/sandbox/
 * is in, and a server on Docker never loads E2B's SDK.
 */

import { config } from "./config.js";
import type { SandboxLayer } from "./sandbox/api.js";

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
