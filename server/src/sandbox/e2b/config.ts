/**
 * The E2B provider's settings, read from the environment (the header of server/src/config.ts lists them
 * with the server's others). Every default is the careful one: a deployment on E2B's free Hobby plan
 * runs on a one-time credit, so nothing here is sized for comfort.
 *
 * What the Hobby plan allows (https://docs.e2b.dev/billing.md, read 2026-11-15): 10 sandboxes running
 * at once, 1 hour of running without a pause, 1 new sandbox a second, up to 8 vCPUs and 8 GiB each,
 * 10 GiB of disk, paused sandboxes kept without limit and without charge.
 */

/** The template sandbox/e2b/build.ts builds. */
export const DEFAULT_TEMPLATE = "windlass-platform-sandbox";
/**
 * The smallest size this layer asks for, and it is the template's: E2B takes neither CPUs nor memory
 * when a sandbox is created. One vCPU is E2B's least. Windlass is one process of a few hundred MiB
 * with its engine at work, and the commands an agent runs (git, python, node) need room beside it, so
 * 1024 MiB and not the 512 MiB of E2B's own default: scripts/e2b-check.ts prints the memory a turn
 * really used, which is what a lower number has to be measured against.
 */
export const DEFAULT_CPU_COUNT = 1;
export const DEFAULT_MEMORY_MB = 1024;

export interface E2bConfig {
	/** E2B_API_KEY. Never logged. */
	apiKey: string;
	/** WLP_E2B_TEMPLATE: the template's name or id. */
	template: string;
	/** WLP_E2B_SHOTS_TEMPLATE: template for items that take screenshots. */
	shotsTemplate: string;
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
}

/** Everything but the API key: what the provider's logic needs. The key is the client's (sdk.ts). */
export type E2bSettings = Omit<E2bConfig, "apiKey">;

/** E2B's own limit on Hobby: ten sandboxes running at once. The default cap stays well under it. */
export const HOBBY_MAX_RUNNING = 10;
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
	return {
		template,
		shotsTemplate,
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
	};
}

/** The settings of a server or a script that talks to E2B. Throws, with what to set, when there is no API key. */
export function readE2bConfig(env: NodeJS.ProcessEnv = process.env): E2bConfig {
	const apiKey = (env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") throw new Error('E2B_API_KEY is not set. The E2B provider needs an API key of the E2B account that holds the template (https://e2b.dev/dashboard, "API Keys"); see docs/operating.md, "E2B"');
	return { apiKey, ...readE2bSettings(env) };
}
