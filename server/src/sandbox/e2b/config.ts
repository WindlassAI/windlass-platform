/**
 * The E2B provider's settings, read from the environment (the header of server/src/config.ts lists them
 * with the server's others). Every default is the careful one: a deployment on E2B's free Hobby plan
 * runs on a one-time credit, so nothing here is sized for comfort.
 *
 * What the Hobby plan allows (https://docs.e2b.dev/billing.md, read 2026-11-15): 10 sandboxes running
 * at once, 1 hour of running without a pause, 1 new sandbox a second, up to 8 vCPUs and 8 GiB each,
 * 10 GiB of disk, paused sandboxes kept without limit and without charge.
 */

import { HOSTED_SIZES, HOSTED_SIZE_SPECS, type HostedSize, isHostedSize } from "../../contract.js";
import { type E2bNetwork, e2bModelRelay, readE2bNetwork } from "./network.js";

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

export interface E2bConfig {
	/** E2B_API_KEY. Never logged. */
	apiKey: string;
	/** WLP_E2B_TEMPLATE: the small size's template, by name or id. */
	template: string;
	/** WLP_E2B_SHOTS_TEMPLATE: the small size's template for items that take screenshots. */
	shotsTemplate: string;
	/**
	 * WLP_E2B_SIZES: the sizes whose templates are built at E2B, smallest first; always small. Default
	 * small only, so that a deployment offers no size it has no template of. A request for a size not
	 * offered gets the largest offered below it.
	 */
	sizes?: HostedSize[];
	/** Each size's templates (`templateVariables`). Absent: `defaultTemplateNames`, with small's from `template` and `shotsTemplate`. */
	templates?: Partial<Record<HostedSize, { template: string; shotsTemplate: string }>>;
	/** WLP_E2B_DEPLOYMENT: marks every sandbox of this deployment (`wlp_deployment`), so they are listed, counted and removed together. Servers of one deployment share it. */
	deployment: string;
	/** WLP_E2B_MAX_RUNNING: how many of the deployment's sandboxes may run at once. */
	maxRunning: number;
	/** WLP_E2B_IDLE_TIMEOUT_MS: the sandbox's own timeout while no turn runs in it. */
	idleTimeoutMs: number;
	/** WLP_E2B_TURN_LEASE_MS: the sandbox's own timeout while a turn runs, set again every third of it. */
	turnLeaseMs: number;
	/** WLP_E2B_MAX_RUNTIME_MS: how long the plan lets a sandbox run without a pause. */
	maxRuntimeMs: number;
	/** WLP_TURN_TIMEOUT_MS, the server's limit on one turn: a turn has to fit into what is left of `maxRuntimeMs`. */
	turnLimitMs: number;
	/** WLP_E2B_PAUSE: false when sandboxes are killed where they would be paused. */
	pause: boolean;
	/** WLP_E2B_WINDLASS_SANDBOX: promise Windlass's own sandbox, and hold every new sandbox to it. */
	windlassSandbox: boolean;
	/** WLP_E2B_OPEN_PROFILE: offer the profile in which the microVM is the only isolation (`e2b-open`). */
	openProfile: boolean;
	/** WLP_E2B_WINDLASS_VERSION: the Windlass in the template, when the owner wants it shown before the first sandbox was made. */
	windlassVersion: string | null;
	/** WLP_E2B_NETWORK and WLP_E2B_NETWORK_ALLOW (network.ts). Absent: `open`, as before network modes. */
	network?: E2bNetwork;
	/** WLP_E2B_SNAPSHOTS=on and its limits (snapshots.ts). Absent: off, no snapshot is looked up, saved or swept. */
	snapshots?: E2bSnapshotLimits;
	/** Where Windlass's model requests go instead of api.openai.com (network.ts `e2bModelRelay`). Absent or null: the turn's token goes into the sandbox. */
	modelRelayOrigin?: string | null;
	/** Why the relay is off, when `modelRelayOrigin` is null: said once at startup. */
	modelRelayOff?: string;
}

export interface E2bSnapshotLimits {
	/** WLP_E2B_SNAPSHOT_MAX: the deployment's snapshots at E2B, all users together. */
	maxTotal: number;
	/** WLP_E2B_SNAPSHOT_USER_MAX: one user's, over all their repositories (one each). */
	maxPerUser: number;
	/** WLP_E2B_SNAPSHOT_MAX_GB: the most a sandbox's disk may hold to be saved. */
	maxBytes: number;
	/** A snapshot older than this is removed, used or not. */
	ttlMs: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: E2bSnapshotLimits = { maxTotal: 10, maxPerUser: 3, maxBytes: 4 * 2 ** 30, ttlMs: 14 * 86_400_000 };

/** Everything but the API key: what the provider's logic needs. The key is the client's (sdk.ts). */
export type E2bSettings = Omit<E2bConfig, "apiKey">;

/** E2B's own limit on Hobby: ten sandboxes running at once. The default cap stays well under it. */
export const HOBBY_MAX_RUNNING = 10;
/** E2B's Hobby plan's most for one sandbox (the owner's dashboard, 2026-11-23): 8 vCPUs and 8 GiB of memory, 10 GB of disk. No size goes beyond it. */
export const HOBBY_MAX_CPUS = 8;
export const HOBBY_MAX_MEMORY_MB = 8192;
for (const [size, spec] of Object.entries(HOSTED_SIZE_SPECS)) {
	if (spec.cpus > HOBBY_MAX_CPUS || spec.memoryMiB > HOBBY_MAX_MEMORY_MB) throw new Error(`the ${size} size (${spec.cpus} vCPU, ${spec.memoryMiB} MiB) is beyond E2B's Hobby plan (${HOBBY_MAX_CPUS} vCPU, ${HOBBY_MAX_MEMORY_MB} MiB a sandbox)`);
}

/** What a user and the log read when E2B refused a size for the account's plan. */
export function planRefusal(size: HostedSize, said: string): string {
	const spec = HOSTED_SIZE_SPECS[size];
	return `E2B refused a ${size} sandbox (${spec.cpus} vCPU, ${spec.memoryMiB / 1024} GiB) for the account's plan: the Hobby plan allows at most ${HOBBY_MAX_CPUS} vCPU and ${HOBBY_MAX_MEMORY_MB / 1024} GiB a sandbox, ${HOBBY_MAX_RUNNING} sandboxes at once and one hour without a pause. E2B said: ${said}`;
}

/** Whether E2B's words refuse a size for the plan, rather than the account's count of running sandboxes. */
export function refusesSize(said: string): boolean {
	return /\b(cpu|vcpu|memory|ram|mib|mb|gib|gb)\b/i.test(said) && /\b(limit|exceed|maximum|max|plan|tier|quota|allowed|upgrade)\b/i.test(said);
}
export const DEFAULT_MAX_RUNNING = 3;
export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_TURN_LEASE_MS = 3 * 60_000;
/** One hour: the Hobby plan's. A Pro deployment sets 24 hours. */
export const DEFAULT_MAX_RUNTIME_MS = 60 * 60_000;
const DEFAULT_TURN_LIMIT_MS = 45 * 60_000;

/** `wlp_deployment` goes into a query string and a log line: letters, digits, `_` and `-`. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, least: number, most: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < least || value > most) throw new Error(`${name} must be a whole number from ${least} to ${most}; got "${raw}"`);
	return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = (env[name] ?? "").trim();
	if (raw === "") return fallback;
	if (raw === "1" || raw === "0") return raw === "1";
	throw new Error(`${name} must be 1 or 0; got "${raw}"`);
}

/** The settings without the API key: for the provider's logic, a script that only prints, a test on the fake client. */
export function readE2bSettings(env: NodeJS.ProcessEnv = process.env): E2bSettings {
	const deployment = (env.WLP_E2B_DEPLOYMENT ?? "default").trim();
	if (!LABEL.test(deployment)) throw new Error(`WLP_E2B_DEPLOYMENT must be 1 to 64 letters, digits, "_" or "-"; got "${deployment}"`);
	const shotsTemplate = (env.WLP_E2B_SHOTS_TEMPLATE ?? DEFAULT_TEMPLATE + "-shots").trim();
	if (!shotsTemplate) throw new Error("WLP_E2B_SHOTS_TEMPLATE must not be empty");
	const template = (env.WLP_E2B_TEMPLATE ?? DEFAULT_TEMPLATE).trim();
	if (template === "") throw new Error("WLP_E2B_TEMPLATE must not be empty");
	// Read as config.ts reads it (`readDuration`): the whole text as a number, so "1e6" is a million here
	// too and not 1. A value config.ts refuses stops the server before this matters.
	const turnLimit = Math.floor(Number((env.WLP_TURN_TIMEOUT_MS ?? "").trim() || Number.NaN));
	const version = (env.WLP_E2B_WINDLASS_VERSION ?? "").trim();
	const templates: Partial<Record<HostedSize, { template: string; shotsTemplate: string }>> = { small: { template, shotsTemplate } };
	for (const size of HOSTED_SIZES.filter((one) => one !== "small")) {
		const names = templateVariables(size), fallback = defaultTemplateNames(size);
		const one = { template: (env[names.template] ?? fallback.template).trim(), shotsTemplate: (env[names.shotsTemplate] ?? fallback.shotsTemplate).trim() };
		if (one.template === "" || one.shotsTemplate === "") throw new Error(`${names.template} and ${names.shotsTemplate} must not be empty`);
		templates[size] = one;
	}
	return {
		template,
		shotsTemplate,
		sizes: readSizes(env),
		templates,
		deployment,
		maxRunning: integer(env, "WLP_E2B_MAX_RUNNING", DEFAULT_MAX_RUNNING, 1, 1100),
		idleTimeoutMs: integer(env, "WLP_E2B_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS, 30_000, 30 * 60_000),
		turnLeaseMs: integer(env, "WLP_E2B_TURN_LEASE_MS", DEFAULT_TURN_LEASE_MS, 60_000, 30 * 60_000),
		maxRuntimeMs: integer(env, "WLP_E2B_MAX_RUNTIME_MS", DEFAULT_MAX_RUNTIME_MS, 10 * 60_000, 24 * 60 * 60_000),
		turnLimitMs: Number.isFinite(turnLimit) && turnLimit >= 1_000 ? turnLimit : DEFAULT_TURN_LIMIT_MS,
		pause: flag(env, "WLP_E2B_PAUSE", true),
		windlassSandbox: flag(env, "WLP_E2B_WINDLASS_SANDBOX", false),
		openProfile: flag(env, "WLP_E2B_OPEN_PROFILE", false),
		windlassVersion: version === "" ? null : version,
		network: readE2bNetwork(env),
		...(readSnapshotSwitch(env) ? { snapshots: {
			maxTotal: integer(env, "WLP_E2B_SNAPSHOT_MAX", DEFAULT_SNAPSHOT_LIMITS.maxTotal, 1, 1000),
			maxPerUser: integer(env, "WLP_E2B_SNAPSHOT_USER_MAX", DEFAULT_SNAPSHOT_LIMITS.maxPerUser, 1, 100),
			maxBytes: integer(env, "WLP_E2B_SNAPSHOT_MAX_GB", DEFAULT_SNAPSHOT_LIMITS.maxBytes / 2 ** 30, 1, 64) * 2 ** 30,
			ttlMs: DEFAULT_SNAPSHOT_LIMITS.ttlMs,
		} } : {}),
		...(() => {
			const relay = e2bModelRelay(env);
			return "origin" in relay ? { modelRelayOrigin: relay.origin } : { modelRelayOrigin: null, modelRelayOff: relay.off };
		})(),
	};
}

/** WLP_E2B_SIZES: "small,standard,large" or fewer; small is always among them. */
function readSizes(env: NodeJS.ProcessEnv): HostedSize[] {
	const raw = (env.WLP_E2B_SIZES ?? "").trim();
	if (raw === "") return ["small"];
	const named = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
	const wrong = named.find((part) => !isHostedSize(part));
	if (wrong !== undefined) throw new Error(`WLP_E2B_SIZES must list sizes among ${HOSTED_SIZES.join(", ")}, separated by commas; got "${wrong}"`);
	return HOSTED_SIZES.filter((size) => size === "small" || named.includes(size));
}

/** The sizes the settings offer, smallest first. */
export function offeredSizes(settings: Pick<E2bSettings, "sizes">): HostedSize[] {
	return settings.sizes && settings.sizes.length > 0 ? settings.sizes : ["small"];
}

/** The size a sandbox asked for `wanted` is made in: it, or the largest offered below it. */
export function offeredSize(settings: Pick<E2bSettings, "sizes">, wanted: HostedSize | undefined): HostedSize {
	const offered = offeredSizes(settings);
	const want = HOSTED_SIZES.indexOf(wanted ?? "small");
	return [...offered].reverse().find((size) => HOSTED_SIZES.indexOf(size) <= want) ?? "small";
}

/** A size's template: for screenshots, its shots variant. */
export function templateFor(settings: Pick<E2bSettings, "template" | "shotsTemplate" | "templates">, size: HostedSize, screenshots: boolean, harness?: string): string {
	const names = size === "small" ? { template: settings.template, shotsTemplate: settings.shotsTemplate } : (settings.templates?.[size] ?? defaultTemplateNames(size));
	return harness ? names.template + "-" + harness : screenshots ? names.shotsTemplate : names.template;
}

/** WLP_E2B_SNAPSHOTS: "on" or "off" (the default), as server/src/config.ts reads it for the session's side. */
function readSnapshotSwitch(env: NodeJS.ProcessEnv): boolean {
	const raw = (env.WLP_E2B_SNAPSHOTS ?? "").trim();
	if (raw === "" || raw === "off") return false;
	if (raw === "on") return true;
	throw new Error(`WLP_E2B_SNAPSHOTS must be on or off; got "${raw}"`);
}

/** The settings of a server or a script that talks to E2B. Throws, with what to set, when there is no API key. */
export function readE2bConfig(env: NodeJS.ProcessEnv = process.env): E2bConfig {
	const apiKey = (env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") throw new Error('E2B_API_KEY is not set. The E2B provider needs an API key of the E2B account that holds the template (https://e2b.dev/dashboard, "API Keys"); see docs/operating.md, "E2B"');
	return { apiKey, ...readE2bSettings(env) };
}
