/** A session chooses its harness once. Its capabilities govern turn inputs, sign-in and storage (harnesses.ts, one record per agent). */
import type { RunTurnInput, RunTurnResult, SandboxHandle, SandboxLayer, Windlass } from "./api.js";
import type { HarnessId } from "../contract.js";
import { AcpHarness } from "./acp-harness.js";
import { capabilitiesOf, machineHarnesses, WINDLASS_CAPABILITIES, type HarnessCapabilities } from "./harnesses.js";

export type { HarnessId } from "../contract.js";

export type { PlatformTool } from "../platform-tools.js";

export { capabilitiesOf, type HarnessCapabilities };

export interface Harness {
	readonly id: HarnessId;
	/** What this sandbox's harness can do. Asked before each turn; it starts no session. */
	capabilities(sandbox: SandboxHandle): Promise<HarnessCapabilities>;
	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult>;
}

/** The layer's Windlass, unchanged. */
export class WindlassHarness implements Harness {
	readonly id = "windlass" as const;

	constructor(private readonly windlass: Windlass) {}

	async capabilities(_sandbox: SandboxHandle): Promise<HarnessCapabilities> {
		return WINDLASS_CAPABILITIES;
	}

	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		return this.windlass.runTurn(sandbox, input);
	}
}

/** Select a harness only where the platform can start its sandbox. */
export function harnessOf(layer: SandboxLayer, id: HarnessId): Harness {
	if (id === "windlass") return new WindlassHarness(layer.windlass);
	const profile = machineHarnesses[id];
	if (!profile) throw new Error(`Unknown harness: ${id}`);
	if (!layer.machine) throw new Error(`${profile.name} runs only on a machine of yours.`);
	return new AcpHarness(profile, layer.machine.name);
}
