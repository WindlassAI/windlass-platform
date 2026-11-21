// Names are a proposal. Only the owner's inventory may turn them into durable destinations.
import type { ChildPlacement, FeaturePlanEdit, MachineSummary, PlacementNeeds, PlanSubtask, SandboxPlace, SandboxProfileId } from "../contract.js";
import type { plannerMachines } from "../machines/details.js";
import { PlanError } from "./feature-plan.js";
import { slotWait } from "./budget.js";

type Machine = ReturnType<typeof plannerMachines>[number];
export interface PlacementInventory {
	machines: Machine[];
	hostedProfiles: SandboxProfileId[];
	defaultProfile?: SandboxProfileId;
	/** Account state from provider routing, when available. */
	limited?: { machineId: string; harness: string }[];
}
export interface PlacementRoute {
	preferred: SandboxPlace;
	alternatives: SandboxPlace[];
}
const GiB = 2 ** 30;
export function placeKey(place: SandboxPlace) { return place.kind === "hosted" ? "hosted" : place.machineId; }

function resolve(name: string, machines: Machine[]): SandboxPlace {
	if (name === "hosted") return { kind: "hosted" };
	const matches = machines.filter(m => m.name === name);
	if (matches.length !== 1) throw new PlanError(matches.length ? `More than one machine is named ‘${name}’. Rename one before approval.` : `‘${name}’ is not one of your machines.`);
	return { kind: "machine", machineId: matches[0]!.machineId };
}

export function bindRoute(task: PlanSubtask, parent: SandboxPlace, overflow: boolean, machines: Machine[]): PlacementRoute {
	const preferred = task.place ? resolve(task.place.prefer, machines) : parent;
	const allowed = task.place?.allow?.map(name => resolve(name, machines)) ?? [];
	return { preferred, alternatives: overflow ? allowed.filter(p => placeKey(p) !== placeKey(preferred)) : [] };
}

type Candidate = { refused: string } | { wait: string } | { decision: ChildPlacement; score: number };
export function machineSlots(machine: Pick<MachineSummary, "slots" | "turns" | "host">) {
	if (machine.slots) return machine.slots;
	// A disconnected runner loses its hello max. Its busy count is still reported.
	return { max: machine.turns?.max ?? null, busy: machine.turns?.running ?? 0, queued: machine.turns?.queued ?? 0,
		unit: { cpus: machine.host?.sandboxCpus ?? 0, memoryBytes: 1.5 * GiB } };
}

function machineFit(machine: Machine, needs: PlacementNeeds, named: boolean): string | null {
	if (machine.orchestrator === "never" || (machine.orchestrator === "named" && !named)) return `owner placement policy is ${machine.orchestrator}`;
	const tags = new Set([...machine.tags, machine.os, machine.arch, "os:" + machine.os, "arch:" + machine.arch, "harness:windlass",
		...(machine.screenshots ? ["screenshots"] : []), ...(machine.harnesses?.map(h => "harness:" + h.id) ?? [])]);
	const missing = needs.tags?.find(t => !tags.has(t));
	if (missing) return `missing tag ‘${missing}’`;
	if (needs.screenshots && !machine.screenshots) return "screenshots are unavailable";
	if (machine.egress === "none" || (needs.egress && needs.egress !== machine.egress)) return "the egress policy does not support this repository task";
	if (needs.harness && needs.harness !== "windlass") {
		if (!machine.harnesses?.some(h => h.id === needs.harness && h.signIn === "token")) return `${needs.harness} is not signed in`;
		return "work items currently require Windlass";
	}
	if ((machine.freeDiskBytes ?? 0) < 5 * GiB) return "at least 5 GiB of reported free disk is required";
	return null;
}

function candidate(task: PlanSubtask, place: SandboxPlace, inventory: PlacementInventory, preferred: boolean, warm: string[]): Candidate {
	const needs = task.needs ?? {};
	const bonus = (preferred ? 3 : 0) + Number(warm.includes(placeKey(place)));
	const reason = preferred ? task.place?.reason ?? "Same place as the feature" : `Approved overflow from ‘${task.place!.prefer}’`;
	if (place.kind === "hosted") {
		if (!inventory.hostedProfiles.length || (needs.profile && !inventory.hostedProfiles.includes(needs.profile))) return { refused: "hosted has no available matching profile" };
		if (needs.harness && needs.harness !== "windlass" || needs.tags?.length || needs.egress || needs.cpus || needs.memoryGiB)
			return { refused: "hosted does not report the required machine capabilities" };
		const profile = needs.profile ?? inventory.hostedProfiles.find(p => p === inventory.defaultProfile);
		return { decision: { name: "hosted", place, units: 1, reason, sendSecrets: true, profile }, score: bonus };
	}
	const m = inventory.machines.find(m => m.machineId === place.machineId);
	if (!m) return { refused: `‘${place.machineId}’ is no longer one of your machines` };
	const refused = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.` });
	const failure = machineFit(m, needs, !!task.place);
	if (failure) return refused(failure);
	const allowed = m.availableProfiles.filter(p => m.allowedProfiles?.some(id => id === p));
	const profile = needs.profile ? allowed.find(p => p === needs.profile) : allowed.find(p => p === inventory.defaultProfile) ?? allowed[0];
	if (!profile) return refused("no available owner-allowed profile matches");
	const slots = machineSlots(m);
	if (needs.cpus && slots.unit.cpus <= 0) return refused("per-slot CPU capacity is unknown");
	const units = Math.max(1, needs.cpus ? Math.ceil(needs.cpus / slots.unit.cpus) : 1,
		needs.memoryGiB ? Math.ceil(needs.memoryGiB * GiB / slots.unit.memoryBytes) : 1);
	if (units > 4 || (slots.max !== null && units > slots.max)) return refused(`the task needs ${units} slots and exceeds the machine or four-slot limit`);
	if (!m.online) return { wait: `Waiting for ‘${m.name}’ to come back online.` };
	if (inventory.limited?.some(a => a.machineId === m.machineId && a.harness === (needs.harness ?? "windlass")))
		return { wait: `Waiting for the ${needs.harness ?? "windlass"} usage limit on ‘${m.name}’ to reset.` };
	if (!m.slots && units > 1) return { wait: `Waiting for multi-slot sizing support on ‘${m.name}’ (${units} slots required).` };
	// An older online runner may have no concurrency cap. Award only one known slot in that case.
	const free = slots.max === null ? 1 : Math.max(0, slots.max - slots.busy);
	if (free < units) return { wait: slotWait(m.name, units, free) };
	return { decision: { name: m.name, place, reason, units, sendSecrets: m.repositorySecrets, profile },
		score: bonus + Math.min(free, 3) - slots.queued - m.personalRunning };
}

export function choosePlacement(task: PlanSubtask, route: PlacementRoute, inventory: PlacementInventory, warm: string[] = []) {
	const candidates = [route.preferred, ...route.alternatives].map((p, i) => candidate(task, p, inventory, i === 0, warm));
	const ready = candidates.filter(c => "decision" in c).sort((a, b) => b.score - a.score)[0];
	if (ready) return { decision: ready.decision } as const;
	const waiting = candidates.find(c => "wait" in c);
	if (waiting) return { wait: waiting.wait } as const;
	return { refused: candidates.flatMap(c => "refused" in c ? [c.refused] : []).join(" ") } as const;
}

export function approveRoutes(plan: FeaturePlanEdit, parent: SandboxPlace, inventory: PlacementInventory, completed: Set<string>) {
	return Object.fromEntries(plan.subtasks.filter(task => !completed.has(task.key)).map(task => {
		const route = bindRoute(task, parent, !!plan.overflow, inventory.machines);
		const fit = choosePlacement(task, route, inventory);
		if (fit.refused) throw new PlanError(task.title + ": " + fit.refused);
		return [task.key, route];
	}));
}
