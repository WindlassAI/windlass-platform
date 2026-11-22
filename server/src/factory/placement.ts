// Names are a proposal. Only the owner's inventory may turn them into durable destinations.
import { MAX_PROVIDER_WAIT, WINDLASS_ACCOUNT, providerWait } from "../provider-usage.js";
import { sandboxSlots } from "../contract.js";
import type { ChildPlacement, FeaturePlanEdit, MachineSummary, PlacementNeeds, PlanSubtask, SandboxPlace, SandboxProfileId } from "../contract.js";
import type { plannerMachines } from "../machines/details.js";
import { PlanError } from "./feature-plan.js";
import { retryAt, slotWait } from "./budget.js";

type Machine = ReturnType<typeof plannerMachines>[number];
export interface PlacementInventory {
	machines: Machine[];
	hostedProfiles: SandboxProfileId[];
	defaultProfile?: SandboxProfileId;
	/** Account state from provider routing, when available. */
	limited?: { machineId: string; harness: string; limitedUntil?: number; accountKey?: string }[];
}
export interface PlacementRoute {
	preferred: SandboxPlace;
	alternatives: SandboxPlace[];
	/** Display names at approval, for a destination later removed from inventory. */
	names?: Record<string, string>;
}
export function limitApplies(limit: NonNullable<PlacementInventory["limited"]>[number], place: string) {
	return limit.machineId === place || (limit.machineId === WINDLASS_ACCOUNT && limit.harness === "windlass");
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
	const alternatives = overflow ? allowed.filter(p => placeKey(p) !== placeKey(preferred)) : [];
	const names: Record<string, string> = {};
	for (const place of [preferred, ...alternatives]) {
		if (place.kind !== "machine") continue;
		const machine = machines.find(m => m.machineId === place.machineId);
		if (machine) names[place.machineId] = machine.name;
	}
	return { preferred, alternatives, names };
}

/**
 * A place that cannot take a subtask now either never can (`permanent`: the owner's policy, a removed
 * machine, a missing capability, a size its runner cannot report) or might later (low disk, no available
 * profile). Approval refuses only a subtask whose every allowed place is permanently refused. A busy or
 * offline machine is a wait, never a refusal.
 */
type Candidate = { refused: string; permanent: boolean } | { wait: string; retryAt?: number; accountKey?: string } | { decision: ChildPlacement; score: number };
export function machineSlots(machine: Pick<MachineSummary, "slots" | "turns" | "host">) {
	if (machine.slots) return machine.slots;
	// A disconnected runner loses its hello max. Its busy count is still reported.
	return { max: machine.turns?.max ?? null, busy: machine.turns?.running ?? 0, queued: machine.turns?.queued ?? 0,
		unit: { cpus: machine.host?.sandboxCpus ?? 0, memoryBytes: 1.5 * GiB } };
}

/** What the machine cannot do at all, from its last report. Kept while it is offline. */
function capabilityFit(machine: Machine, needs: PlacementNeeds): string | null {
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
	if (needs.profile && machine.allowedProfiles && !machine.allowedProfiles.includes(needs.profile)) return `the owner does not allow the ${needs.profile} profile`;
	return null;
}

function candidate(task: PlanSubtask, place: SandboxPlace, inventory: PlacementInventory, preferred: boolean, warm: string[], at: number, name?: string): Candidate {
	const needs = task.needs ?? {};
	const bonus = (preferred ? 3 : 0) + Number(warm.includes(placeKey(place)));
	const limited = inventory.limited?.find(a => limitApplies(a, placeKey(place)) && a.harness === (needs.harness ?? "windlass"));
	const waiting = (name: string) => {
		const until = limited?.limitedUntil === undefined ? undefined : Math.min(limited.limitedUntil, at + MAX_PROVIDER_WAIT);
		return { wait: until === undefined ? `Waiting for the ${needs.harness ?? "windlass"} usage limit on ‘${name}’ to reset.`
			: providerWait(limited!.harness, name, until).sentence, retryAt: until, accountKey: limited?.accountKey };
	};
	const reason = preferred ? task.place?.reason ?? "Same place as the feature" : `Approved overflow from ‘${task.place!.prefer}’`;
	if (place.kind === "hosted") {
		if (!inventory.hostedProfiles.length || (needs.profile && !inventory.hostedProfiles.includes(needs.profile))) return { refused: "hosted has no available matching profile", permanent: true };
		if (needs.harness && needs.harness !== "windlass" || needs.tags?.length || needs.egress || needs.cpus || needs.memoryGiB)
			return { refused: "hosted does not report the required machine capabilities", permanent: true };
		if (limited) return waiting("hosted");
		const profile = needs.profile ?? inventory.hostedProfiles.find(p => p === inventory.defaultProfile);
		return { decision: { name: "hosted", place, units: 1, reason, sendSecrets: true, profile }, score: bonus };
	}
	const m = inventory.machines.find(m => m.machineId === place.machineId);
	if (!m) return { refused: (name ? "‘" + name + "’" : "The selected machine") + " is no longer one of your machines.", permanent: true };
	const never = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.`, permanent: true });
	const notNow = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.`, permanent: false });
	if (m.orchestrator === "never" || m.orchestrator === "named" && !task.place) return never("owner placement policy is " + m.orchestrator);
	const slots = machineSlots(m);
	const needed = Math.max(1, needs.cpus && slots.unit.cpus > 0 ? Math.ceil(needs.cpus / slots.unit.cpus) : 1,
		needs.memoryGiB ? Math.ceil(needs.memoryGiB * GiB / slots.unit.memoryBytes) : 1);
	if (needed > 1 && !m.slots) return never("sizing beyond one slot is not supported by this runner (" + needed + " slots required)");
	if (needed > 4 || (slots.max !== null && needed > slots.max)) return never(`the task needs ${needed} slots and exceeds the machine or four-slot limit`);
	const units = sandboxSlots(needed, slots.max ?? 1);
	// A machine that has never reported is judged when it connects. One that has keeps its last report.
	const reported = m.online || m.egress !== undefined;
	const incapable = reported ? capabilityFit(m, needs) : null;
	if (incapable) return never(incapable);
	if (limited) return waiting(m.name);
	if (!m.online) return { wait: `Waiting for ‘${m.name}’ to come back online.` };
	if (needs.cpus && slots.unit.cpus <= 0) return notNow("per-slot CPU capacity is unknown");
	if ((m.freeDiskBytes ?? 0) < 5 * GiB) return notNow("at least 5 GiB of reported free disk is required");
	const allowed = m.availableProfiles.filter(p => m.allowedProfiles?.some(id => id === p));
	const profile = needs.profile ? allowed.find(p => p === needs.profile) : allowed.find(p => p === inventory.defaultProfile) ?? allowed[0];
	if (!profile) return notNow("no available owner-allowed profile matches");
	// An older online runner may have no concurrency cap. Award only one known slot in that case.
	const free = slots.max === null ? 1 : Math.max(0, slots.max - slots.busy);
	if (free < units) return { wait: slotWait(m.name, units, free) };
	return { decision: { name: m.name, place, reason, units, sendSecrets: m.repositorySecrets, profile },
		score: bonus + Math.min(free, 3) - slots.queued - m.personalRunning };
}

/**
 * A ready place, else the earliest wait, else every refusal. `permanent` is true only when each allowed
 * place is refused for good: approval refuses then, and nothing the owner waits for would help.
 */
export function choosePlacement(task: PlanSubtask, route: PlacementRoute, inventory: PlacementInventory, warm: string[] = [], at = Date.now()) {
	const candidates = [route.preferred, ...route.alternatives].map((p, i) => candidate(task, p, inventory, i === 0, warm, at, route.names?.[placeKey(p)] ?? (i === 0 ? task.place?.prefer : undefined)));
	const ready = candidates.filter(c => "decision" in c).sort((a, b) => b.score - a.score)[0];
	if (ready) return { decision: ready.decision } as const;
	const waits = candidates.filter(c => "wait" in c);
	const deadline = (wait: typeof waits[number]) => wait.retryAt ?? retryAt(at, 0);
	const waiting = waits.sort((a, b) => deadline(a) - deadline(b))[0];
	if (waiting) return { wait: waiting.wait, retryAt: waiting.retryAt, accountKey: waiting.accountKey } as const;
	const refusals = candidates.flatMap(c => "refused" in c ? [c] : []);
	return { refused: refusals.map(c => c.refused).join(" "), permanent: refusals.every(c => c.permanent) } as const;
}

export function approveRoutes(plan: FeaturePlanEdit, parent: SandboxPlace, inventory: PlacementInventory, completed: Set<string>) {
	return Object.fromEntries(plan.subtasks.filter(task => !completed.has(task.key)).map(task => {
		const route = bindRoute(task, parent, !!plan.overflow, inventory.machines);
		const fit = choosePlacement(task, route, inventory);
		// A busy or offline machine, or one short of disk, is a wait the feature takes after approval.
		if (fit.refused !== undefined && fit.permanent) throw new PlanError(task.title + ": " + fit.refused);
		return [task.key, route];
	}));
}
