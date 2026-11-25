import { readHostedSettings } from "../hosted-settings.js";
import { wholeNumber } from "../hosted-env.js";
import { readRateCard } from "./pricing.js";
import { HOSTED_SIZES, HOSTED_SIZE_SPECS, type HostedSize } from "../../contract.js";
import { hostedModelRelay, readHostedNetwork } from "../hosted-network.js";

/** The template sandbox/e2b/build.sh builds: the small size's. */
export const DEFAULT_TEMPLATE = "windlass-platform-sandbox";
/**
 * The smallest size this layer asks for, and it is the small template's: E2B takes neither CPUs nor
 * memory when a sandbox is created (https://docs.e2b.dev/billing.md: "customize allocated CPU and RAM
 * when building custom templates"; the SDK's `Sandbox.create` has no such option), so every size is a
 * template of its own, built from the same Dockerfile (`templateNames`). One vCPU is E2B's least.
 * Windlass is one process of a few hundred MiB with its engine at work, and the commands an agent runs
 * (git, python, node) need room beside it, so 1024 MiB and not the 512 MiB of E2B's own default.
 * A typecheck of a real TypeScript monorepo needs more: it ran a 1 GiB guest out of memory, which is
 * why work items start on standard (contract.ts `ITEM_HOSTED_SIZE`).
 */
export const DEFAULT_CPU_COUNT = HOSTED_SIZE_SPECS.small.cpus;
export const DEFAULT_MEMORY_MB = HOSTED_SIZE_SPECS.small.memoryMiB;

/** The default template names of a size: small keeps the names it always had. */
export function defaultTemplateNames(size: HostedSize): { template: string; shotsTemplate: string } {
	const base = size === "small" ? DEFAULT_TEMPLATE : `${DEFAULT_TEMPLATE}-${size}`;
	return { template: base, shotsTemplate: `${base}-shots` };
}

/** The environment variables that name a size's templates: WLP_E2B_TEMPLATE for small, WLP_E2B_TEMPLATE_STANDARD for standard. */
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
	return `E2B refused a ${size} sandbox (${spec.cpus} vCPU, ${spec.memoryMiB / 1024} GiB) for the account's plan. E2B said: ${said}`;
}

/** Whether E2B's words refuse a size for the plan, rather than the account's count of running sandboxes. */
export function refusesSize(said: string): boolean {
	return /\b(cpu|vcpu|memory|ram|mib|mb|gib|gb)\b/i.test(said) && /\b(limit|exceed|maximum|max|plan|tier|quota|allowed|upgrade)\b/i.test(said);
}

export function readE2bSettings(env: NodeJS.ProcessEnv = process.env) {
	const shotsTemplate = (env.WLP_E2B_SHOTS_TEMPLATE ?? DEFAULT_TEMPLATE + "-shots").trim();
	if (!shotsTemplate) throw new Error("WLP_E2B_SHOTS_TEMPLATE must not be empty");
	const template = (env.WLP_E2B_TEMPLATE ?? DEFAULT_TEMPLATE).trim();
	if (template === "") throw new Error("WLP_E2B_TEMPLATE must not be empty");
	const templates: Partial<Record<HostedSize, { template: string; shotsTemplate: string }>> = { small: { template, shotsTemplate } };
	for (const size of HOSTED_SIZES.filter((one) => one !== "small")) {
		const names = templateVariables(size), fallback = defaultTemplateNames(size);
		const one = { template: (env[names.template] ?? fallback.template).trim(), shotsTemplate: (env[names.shotsTemplate] ?? fallback.shotsTemplate).trim() };
		if (one.template === "" || one.shotsTemplate === "") throw new Error(`${names.template} and ${names.shotsTemplate} must not be empty`);
		templates[size] = one;
	}
	const { idleAction, ...policy } = readHostedSettings(env);
	if (idleAction === "stop") throw new Error("WLP_HOSTED_IDLE_ACTION must be pause or destroy for E2B");
	const relay = hostedModelRelay(env);
	return {
		...policy, provider: "e2b" as const, template, shotsTemplate, templates,
		pause: idleAction === "pause",
		rateCard: readRateCard(env.WLP_HOSTED_RATE_CARD_FILE),
		network: readHostedNetwork(env, relay),
		modelRelayOrigin: "origin" in relay ? relay.origin : null,
		modelRelayOff: "off" in relay ? relay.off : undefined,
	};
}

/** A size's template: for screenshots, its shots variant. */
export function templateFor(settings: Pick<E2bSettings, "template" | "shotsTemplate" | "templates">, size: HostedSize, screenshots: boolean, harness?: string): string {
	const names = size === "small" ? { template: settings.template, shotsTemplate: settings.shotsTemplate } : (settings.templates?.[size] ?? defaultTemplateNames(size));
	return harness ? names.template + "-" + harness : screenshots ? names.shotsTemplate : names.template;
}

/** The settings of a server or a script that talks to E2B. Throws, with what to set, when there is no API key. */
export function readE2bKey(env: NodeJS.ProcessEnv = process.env): string {
	const apiKey = (env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") throw new Error('E2B_API_KEY is not set. The E2B provider needs an API key of the E2B account that holds the template (https://e2b.dev/dashboard, "API Keys"); see docs/operating.md, "E2B"');
	return apiKey;
}
