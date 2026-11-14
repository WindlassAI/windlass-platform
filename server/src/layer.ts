/**
 * The sandbox layer in use, chosen by WLP_SANDBOX. The real (Docker) layer is imported only when it
 * is asked for, so the server starts in fake mode whatever state server/src/sandbox/ is in.
 */

import { config } from "./config.js";
import type { SandboxLayer } from "./sandbox/api.js";

let loading: Promise<SandboxLayer> | null = null;

async function load(): Promise<SandboxLayer> {
	if (config.sandbox === "fake") {
		const { createFakeSandboxLayer } = await import("./sandbox-fake.js");
		return createFakeSandboxLayer();
	}
	// Not a literal, so this file type-checks and loads without the Docker layer being present.
	const specifier = "./sandbox/index.js";
	const module = (await import(specifier)) as { createSandboxLayer?: () => SandboxLayer };
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
