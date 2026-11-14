/** The facts of this deployment, cached: asking the sandbox layer can mean starting a container. */

import { config } from "./config.js";
import type { PlatformInfo } from "./contract.js";
import { getLayer } from "./layer.js";

/** The reasoning efforts `windlass --effort` accepts (Windlass's user guide, "Models and effort"). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const FRESH_MS = 5 * 60 * 1000;
/** A missing image or a failed lookup is asked about again sooner. */
const RETRY_MS = 15 * 1000;

interface Slow {
	windlassVersion: string | null;
	models: string[];
	at: number;
	complete: boolean;
}

let cached: Slow | null = null;
let loading: Promise<Slow> | null = null;

async function loadSlow(): Promise<Slow> {
	const layer = await getLayer();
	const [version, models] = await Promise.allSettled([layer.windlass.version(), layer.windlass.models()]);
	const windlassVersion = version.status === "fulfilled" ? version.value : null;
	const list = models.status === "fulfilled" ? models.value.filter((model) => typeof model === "string" && model !== "") : [];
	return { windlassVersion, models: list, at: Date.now(), complete: windlassVersion !== null && list.length > 0 };
}

async function slow(): Promise<Slow> {
	if (cached && Date.now() - cached.at < (cached.complete ? FRESH_MS : RETRY_MS)) return cached;
	if (!loading) {
		loading = loadSlow()
			.then((value) => {
				cached = value;
				return value;
			})
			.finally(() => {
				loading = null;
			});
	}
	return loading;
}

/** The models a session may use, the default first. */
export async function platformModels(): Promise<string[]> {
	return (await slow()).models;
}

export async function platformInfo(): Promise<PlatformInfo> {
	const layer = await getLayer();
	const { windlassVersion, models } = await slow();
	return {
		demoEnabled: config.demo,
		windlassVersion,
		profiles: layer.sandboxes.profiles(),
		models,
		efforts: EFFORTS,
	};
}
