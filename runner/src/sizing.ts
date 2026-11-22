import { availableParallelism, totalmem } from "node:os";
import type { MachineSlotCapacity } from "../../server/src/contract.js";
import { RunnerError } from "./state.js";

const GiB = 2 ** 30;
type Overrides = { slots?: number; cpus?: number; slotMemory?: number; sandboxMemory?: number };
type Flags = Partial<Record<"slots" | "max-turns" | "slot-cpus" | "slot-memory" | "sandbox-memory", string>>;

function bytes(value: string | undefined, flag: string, units: RegExp) {
	if (value === undefined) return undefined;
	const match = units.exec(value);
	const parsed = match && Number(match[1]) * (match[2] === "m" ? 2 ** 20 : GiB);
	if (!parsed || !Number.isSafeInteger(parsed)) throw new RunnerError(`Give --${flag} a positive memory size in ${flag === "sandbox-memory" ? "g" : "m or g"}.`);
	return parsed;
}

export function sizingFlags(flags: Flags, envCpus?: string): Overrides {
	if (flags.slots !== undefined && flags["max-turns"] !== undefined && flags.slots !== flags["max-turns"])
		throw new RunnerError("Give --slots and its alias --max-turns the same count.");
	const slots = flags.slots ?? flags["max-turns"];
	if (slots !== undefined && !/^\d+$/.test(slots)) throw new RunnerError("Give --slots (or --max-turns) a whole number from 1 to 64.");
	const cpus = flags["slot-cpus"] ?? envCpus;
	if (cpus !== undefined && !/^\d+(?:\.\d{1,9})?$/.test(cpus)) throw new RunnerError("Give --slot-cpus or WLP_RUNNER_CPUS a CPU count of at least 0.01.");
	return { slots: slots === undefined ? undefined : Number(slots), cpus: cpus === undefined ? undefined : Number(cpus),
		slotMemory: bytes(flags["slot-memory"], "slot-memory", /^(\d+(?:\.\d+)?)([mg])$/),
		sandboxMemory: bytes(flags["sandbox-memory"], "sandbox-memory", /^(\d+(?:\.\d+)?)(g)$/) };
}

export function sizeMachine({ cores, memoryBytes }: { cores: number; memoryBytes: number }, overrides: Overrides = {}): MachineSlotCapacity {
	const small = cores <= 2;
	const reserve = {
		cpus: small ? 0 : Math.max(1, Math.ceil(cores / 8)),
		memoryBytes: small ? 0 : Math.ceil(Math.max(GiB, memoryBytes / 10) + GiB / 2),
	};
	const usableMem = overrides.sandboxMemory ?? memoryBytes - reserve.memoryBytes;
	const cpus = overrides.cpus ?? (small ? Math.max(0.5, cores / 2) : 2);
	if (!Number.isFinite(cpus) || cpus < 0.01 || cpus > cores) throw new RunnerError(`Give --slot-cpus or WLP_RUNNER_CPUS a CPU count from 0.01 to ${cores}.`);
	const max = overrides.slots ?? (small ? 2 : Math.min(16, Math.max(2, Math.floor((cores - reserve.cpus) / cpus))));
	if (!Number.isInteger(max) || max < 1 || max > 64) throw new RunnerError("Give --slots (or --max-turns) a whole number from 1 to 64.");
	if (overrides.sandboxMemory !== undefined && (!Number.isSafeInteger(usableMem) || usableMem <= 0)) throw new RunnerError("Give --sandbox-memory a positive memory budget.");
	const quantum = GiB / 4;
	const share = Math.floor(usableMem / max / quantum) * quantum;
	const defaultMemory = small ? 1.5 * GiB : Math.max(1.5 * GiB, Math.min(Math.floor(4 * GiB * cpus), share));
	const perSlot = overrides.slotMemory ?? defaultMemory;
	if (!Number.isSafeInteger(perSlot) || perSlot < GiB) throw new RunnerError("Give --slot-memory at least 1 GiB.");
	if (max * perSlot > usableMem) throw new RunnerError(`The requested --slots × --slot-memory (${max * perSlot / GiB} GiB) exceeds the available --sandbox-memory budget (${Number((usableMem / GiB).toFixed(2))} GiB).`);
	return { max, unit: { cpus, memoryBytes: perSlot, pids: small ? 512 : Math.min(4096, 512 * Math.ceil(cpus)) }, reserve };
}

export function localSizing(flags: Flags = {}) {
	return sizeMachine({ cores: availableParallelism(), memoryBytes: totalmem() }, sizingFlags(flags, process.env.WLP_RUNNER_CPUS));
}
