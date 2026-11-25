import { hostedName, readHostedRates, readHostedSettings, wholeNumber } from "../hosted-settings.js";
import { DEFAULT_RATES } from "./pricing.js";
import { HOSTED_SIZE_NAMES, HOSTED_SIZE_SPECS, type HostedSize } from "../../contract.js";
import { e2bModelRelay, readE2bNetwork } from "./network.js";

export const DEFAULT_TEMPLATE = "windlass-platform-sandbox";
// E2B fixes CPU and memory at build time, so each size has its own template.
export const DEFAULT_CPU_COUNT = HOSTED_SIZE_SPECS.small.cpus;
export const DEFAULT_MEMORY_MB = HOSTED_SIZE_SPECS.small.memoryMiB;

export function templateVariables(size: HostedSize): { template: string; shotsTemplate: string } {
	const suffix = size === "small" ? "" : `_${size.toUpperCase()}`;
	return { template: `WLP_E2B_TEMPLATE${suffix}`, shotsTemplate: `WLP_E2B_SHOTS_TEMPLATE${suffix}` };
}

export type E2bSettings = ReturnType<typeof readE2bSettings>;

/** Validate the selected build, including a size's defaults, against this deployment's build limits. */
export function buildShape(env: NodeJS.ProcessEnv, size: HostedSize) {
	const spec = HOSTED_SIZE_SPECS[size];
	const maxCpu = wholeNumber(env, "WLP_HOSTED_MAX_VCPUS", 8, 1);
	const maxMemory = wholeNumber(env, "WLP_HOSTED_MAX_MEMORY_MIB", 8192, 512);
	return {
		cpuCount: wholeNumber(env, "WLP_E2B_CPU", spec.cpus, 1, maxCpu),
		memoryMB: wholeNumber(env, "WLP_E2B_MEMORY_MB", spec.memoryMiB, 512, maxMemory),
	};
}

/** What a user and the log read when E2B refused a size for the account's plan. */
export function planRefusal(size: HostedSize, said: string): string {
	const spec = HOSTED_SIZE_SPECS[size];
	return `E2B refused a ${HOSTED_SIZE_NAMES[size]} sandbox (${spec.cpus} vCPU, ${spec.memoryMiB / 1024} GiB) for the account's plan. E2B said: ${said}`;
}

/** Whether E2B's words refuse a size for the plan, rather than the account's count of running sandboxes. */
export function refusesSize(said: string): boolean {
	return /\b(cpu|vcpu|memory|ram|mib|mb|gib|gb)\b/i.test(said) && /\b(limit|exceed|maximum|max|plan|tier|quota|allowed|upgrade)\b/i.test(said);
}

export function readE2bSettings(env: NodeJS.ProcessEnv = process.env) {
	function templates(size: HostedSize) {
		const names = templateVariables(size);
		const base = size === "small" ? DEFAULT_TEMPLATE : `${DEFAULT_TEMPLATE}-${size}`;
		const template = (env[names.template] ?? base).trim();
		const shotsTemplate = (env[names.shotsTemplate] ?? base + "-shots").trim();
		if (!template) throw new Error(`${names.template} must not be empty`);
		if (!shotsTemplate) throw new Error(`${names.shotsTemplate} must not be empty`);
		return { template, shotsTemplate };
	}
	const relay = e2bModelRelay(env);
	return {
		provider: "e2b" as const, ...readHostedSettings(env),
		turnLeaseMs: wholeNumber(env, hostedName(env, "TURN_LEASE_MS"), 180_000, 60_000, 30 * 60_000),
		maxRuntimeMs: wholeNumber(env, hostedName(env, "MAX_CONTINUOUS_MS", "MAX_RUNTIME_MS"), 3_600_000, 10 * 60_000),
		templates: { small: templates("small"), standard: templates("standard"), large: templates("large") },
		rateCard: readHostedRates(env, "e2b", "microvm", DEFAULT_RATES),
		network: readE2bNetwork(env, relay),
		modelRelayOrigin: "origin" in relay ? relay.origin : null,
		modelRelayOff: "off" in relay ? relay.off : undefined,
	};
}

/** A size's template: for screenshots, its shots variant. */
export function templateFor(settings: E2bSettings, size: HostedSize, screenshots: boolean, harness?: string): string {
	const names = settings.templates[size];
	return harness ? names.template + "-" + harness : screenshots ? names.shotsTemplate : names.template;
}

/** The settings of a server or a script that talks to E2B. Throws, with what to set, when there is no API key. */
export function readE2bKey(env: NodeJS.ProcessEnv = process.env): string {
	const apiKey = (env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") throw new Error('E2B_API_KEY is not set. The E2B provider needs an API key of the E2B account that holds the template (https://e2b.dev/dashboard, "API Keys"); see docs/operating.md, "E2B"');
	return apiKey;
}
