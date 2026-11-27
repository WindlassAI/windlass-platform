// The wizard persists setup choices as defaults and converts them to runner flags.
import { DEFAULT_STORE_LIMITS, parseStoreSize } from "../../server/src/sandbox/store-limits.js";
import { MACHINE_HARNESS_IDS } from "../../server/src/contract.js";
import { machineHarnesses } from "../../server/src/sandbox/harnesses.js";
import type { MachineHarness } from "./policy.js";

export const HARNESSES = MACHINE_HARNESS_IDS satisfies readonly MachineHarness[];
export function isMachineHarness(id: unknown): id is MachineHarness {
	return HARNESSES.some(harness => harness === id);
}

export const HARNESS_LABELS: Record<MachineHarness, string> = { claude: machineHarnesses.claude.name, opencode: machineHarnesses.opencode.name, codex: machineHarnesses.codex.name };
export const PRESET_DOMAINS = "@npm,@pypi,@github";

export interface NetworkChoice {
	mode: "restricted" | "open" | "none";
	/** Private-network names (`--egress-allow`), kept from an earlier `run` command. */
	allow?: string[];
	/** Only these public hosts (`--egress-domains`), as typed: presets are not expanded. */
	domains?: string[];
}
export interface LimitsChoice { slots?: number; snapshotDisk?: string; keepFree?: string }
export interface SetupChoices {
	agents?: MachineHarness[];
	windlassSandbox?: boolean;
	network?: NetworkChoice;
	limits?: LimitsChoice;
	screenshots?: boolean;
	/** Other `run` options given to setup (`--slot-cpus 2`), passed on as they were. */
	extra?: string[];
}

export const PASSED_ON = ["spares", "slot-cpus", "slot-memory", "sandbox-memory", "max-running", "max-sandboxes", "snapshot-user"] as const;

const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => typeof s === "string" && s.length > 0 && s.length <= 255);
const size = (v: unknown) => v === undefined || (typeof v === "string" && parseStoreSize(v) !== null);

export function validChoices(value: unknown): SetupChoices | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const c = value as Record<string, unknown>;
	if (c.agents !== undefined && !(strings(c.agents, 3) && c.agents.every(isMachineHarness))) return null;
	if (c.windlassSandbox !== undefined && typeof c.windlassSandbox !== "boolean") return null;
	if (c.screenshots !== undefined && typeof c.screenshots !== "boolean") return null;
	if (c.extra !== undefined && !strings(c.extra, 24)) return null;
	const n = c.network as NetworkChoice | undefined;
	if (n !== undefined && (typeof n !== "object" || n === null || !["restricted", "open", "none"].includes(n.mode)
		|| (n.allow !== undefined && !strings(n.allow, 64)) || (n.domains !== undefined && !strings(n.domains, 64)))) return null;
	const l = c.limits as LimitsChoice | undefined;
	if (l !== undefined && (typeof l !== "object" || l === null || !size(l.snapshotDisk) || !size(l.keepFree)
		|| (l.slots !== undefined && !(Number.isInteger(l.slots) && l.slots >= 1 && l.slots <= 64)))) return null;
	return c as SetupChoices;
}

export const storeDefaults = { snapshotDisk: `${DEFAULT_STORE_LIMITS.machine / 1e9}GB`, keepFree: `${DEFAULT_STORE_LIMITS.free / 1e9}GB` };

export function startFlags(platform: string, c: SetupChoices): string[] {
	const flags = ["--platform", platform];
	for (const id of c.agents ?? []) flags.push("--harness", id);
	if (c.screenshots) flags.push("--screenshots");
	flags.push("--allow-profile", "docker-hardened");
	if (c.windlassSandbox) flags.push("--allow-profile", "docker-windlass-sandbox");
	const net = c.network ?? { mode: "restricted" };
	flags.push("--egress", net.mode);
	if (net.mode === "restricted" && net.allow?.length) flags.push("--egress-allow", net.allow.join(","));
	if (net.mode === "restricted" && net.domains?.length) flags.push("--egress-domains", net.domains.join(","));
	const l = c.limits ?? {};
	if (l.slots !== undefined) flags.push("--slots", String(l.slots));
	if (l.snapshotDisk !== undefined && parseStoreSize(l.snapshotDisk) !== DEFAULT_STORE_LIMITS.machine) flags.push("--snapshot-disk", l.snapshotDisk);
	if (l.keepFree !== undefined && parseStoreSize(l.keepFree) !== DEFAULT_STORE_LIMITS.free) flags.push("--keep-free", l.keepFree);
	flags.push(...c.extra ?? []);
	return flags;
}

export function networkLine(n: NetworkChoice | undefined): string {
	if (!n || n.mode === "restricted") return n?.domains?.length ? "Only these public hosts: " + n.domains.join(", ") : "Restricted: public sites through the runner's proxy";
	return n.mode === "open" ? "Open: the internet and your local network" : "None: no network";
}

export function fromFlags(values: Record<string, string | boolean | string[] | undefined>, base: SetupChoices): SetupChoices {
	const c = structuredClone(base);
	const profiles = values["allow-profile"] as string[] | undefined;
	if (profiles) c.windlassSandbox = profiles.includes("docker-windlass-sandbox");
	const mode = values.egress as string | undefined, allow = values["egress-allow"] as string | undefined, domains = values["egress-domains"] as string | undefined;
	if (mode !== undefined || allow !== undefined || domains !== undefined) {
		c.network = { mode: (mode ?? "restricted") as "restricted" | "open" | "none",
			...(allow && { allow: allow.split(",").map(s => s.trim().toLowerCase()) }), ...(domains && { domains: domains.split(",").map(s => s.trim()).filter(Boolean) }) };
	}
	const slots = (values.slots ?? values["max-turns"]) as string | undefined;
	if (slots !== undefined || values["snapshot-disk"] !== undefined || values["keep-free"] !== undefined)
		c.limits = { ...c.limits, ...(slots !== undefined && { slots: Number(slots) }),
			...(values["snapshot-disk"] !== undefined && { snapshotDisk: values["snapshot-disk"] as string }),
			...(values["keep-free"] !== undefined && { keepFree: values["keep-free"] as string }) };
	if (values.screenshots) c.screenshots = true;
	const extra = PASSED_ON.flatMap(flag => values[flag] === undefined ? [] : ["--" + flag, values[flag] as string]);
	if (process.env.WLP_RUNNER_CPUS !== undefined && values["slot-cpus"] === undefined) extra.push("--slot-cpus", process.env.WLP_RUNNER_CPUS);
	if (extra.length) c.extra = extra;
	return c;
}
