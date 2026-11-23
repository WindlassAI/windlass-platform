// Names are a proposal. Only the owner's inventory may turn them into durable destinations.
import { MAX_PROVIDER_WAIT, WINDLASS_ACCOUNT, providerWait } from "../provider-usage.js";
import { nextUtcDay, usesPlatformModel } from "../usage.js";
import { HOSTED_SIZE_SPECS, hostedSizeFor, sandboxSlots } from "../contract.js";
import type { ChildPlacement, EgressMode, HostedSize, FeaturePlanEdit, HarnessId, MachineSummary, ModelList, PlanSubtask, SandboxPlace, SandboxProfileId } from "../contract.js";
import type { plannerMachines } from "../machines/details.js";
import { PlanError } from "./feature-plan.js";
import { retryAt, slotWait } from "./budget.js";
import { harnessName, machineHarness, subtaskHarnessProblem } from "../sandbox/harnesses.js";
import { checkItemEffort, chosenModel, ModelProblem } from "../account-models.js";

/** A machine harness (Claude Code, OpenCode) runs only in the hardened container. */
const HARNESS_PROFILE = "docker-hardened" as const;

/** The agent a subtask's item runs: Windlass unless it names another. */
export const subtaskHarness = (task: Pick<PlanSubtask, "agent">): HarnessId => task.agent?.harness ?? "windlass";

/**
 * The models each agent offers, as a session would be checked against them (user.ts, `makeSession`):
 * Windlass's are the account's wherever it runs; a machine harness's are its runner's catalog, or only its
 * default where it reported none. A list left out is not judged here: the child's creation checks it.
 */
export interface AgentModels {
	windlass?: ModelList | null;
	machines?: Record<string, Partial<Record<HarnessId, ModelList>>>;
}

type Machine = ReturnType<typeof plannerMachines>[number];
export interface PlacementInventory {
	dailyTokenWait?: string | null;
	machines: Machine[];
	hostedProfiles: SandboxProfileId[];
	/** The hosted sizes the deployment offers (`Sandboxes.sizes`), smallest first. Absent: one size, which takes no `cpus` or `memoryGiB`. */
	hostedSizes?: HostedSize[];
	/** What hosted sandboxes may reach (`Sandboxes.egress`); `none` takes no repository work. */
	hostedEgress?: EgressMode;
	defaultProfile?: SandboxProfileId;
	/** Account state from provider routing, when available. */
	limited?: { machineId: string; harness: string; limitedUntil?: number; accountKey?: string }[];
	models?: AgentModels;
	/** The feature's Windlass model, which a Windlass subtask choosing only an effort runs. */
	featureModel?: string;
	/**
	 * The places (`placeKey`: "hosted", machine ids) that hold a fresh post-setup snapshot of the subtask's
	 * repository for this user (user.ts `snapshotPlaces`): a sandbox there may skip setup. A bonus only.
	 */
	snapshotPlaces?: string[];
}

/**
 * What a fresh snapshot adds to a ready place's score: as much as two free slots. It ranks places the
 * person allowed and that can run the subtask now; it never makes a refused or waiting place ready, and
 * never puts an alternative before the preferred place unless that alternative outranks it without it
 * (`choosePlacement`).
 */
export const SNAPSHOT_BONUS = 2;
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
type Candidate = { refused: string; permanent: boolean } | { wait: string; dailyCap?: boolean; providerUntil?: number; accountKey?: string } | { decision: ChildPlacement; score: number; snapshot?: boolean };
export function placementRetryAt(at: number, providerUntil?: number, dailyCap?: boolean) {
	return Math.min(providerUntil ?? retryAt(at, 0), dailyCap ? nextUtcDay(at) : Infinity, at + MAX_PROVIDER_WAIT);
}

export function machineSlots(machine: Pick<MachineSummary, "slots" | "turns" | "host">) {
	if (machine.slots) return machine.slots;
	// A disconnected runner loses its hello max. Its busy count is still reported.
	return { max: machine.turns?.max ?? null, busy: machine.turns?.running ?? 0, queued: machine.turns?.queued ?? 0,
		unit: { cpus: machine.host?.sandboxCpus ?? 0, memoryBytes: 1.5 * GiB } };
}

/**
 * Why the model or effort a subtask chose is not one its agent offers, by `list`; null where it is, or nothing
 * was chosen. Windlass without a model of its own runs the feature's (`featureModel`): an effort alone is held
 * to that model, and is not judged where the feature's model is not known.
 */
export function agentModelProblem(task: Pick<PlanSubtask, "agent">, list: ModelList | null | undefined, featureModel?: string): string | null {
	const agent = task.agent;
	if (!agent || !list || (agent.model === undefined && agent.effort === undefined)) return null;
	const machine = machineHarness(agent.harness) !== null;
	if (agent.model === undefined && !machine && featureModel === undefined) return null;
	try {
		const model = chosenModel(list, agent.model ?? (machine ? undefined : featureModel));
		if (agent.effort !== undefined) checkItemEffort(list, model, agent.effort, machine);
		return null;
	} catch (error) {
		if (error instanceof ModelProblem) return `${harnessName(agent.harness)}: ${error.message.replace(/[.:]?\s*$/, "")}`;
		throw error;
	}
}

/**
 * Whether a place can run the subtask's agent, from its last report: a machine harness needs the machine
 * to offer it, be signed into it ("token": an item is not watched, so one that needs a sign-in would fail at
 * its first turn) and allow its hardened profile. Every refusal is permanent: the owner changes the machine,
 * then approves or retries.
 */
function agentFit(machine: Machine, task: PlanSubtask, inventory: PlacementInventory): string | null {
	const harness = subtaskHarness(task);
	const profile = machineHarness(harness);
	if (profile) {
		const offered = machine.harnesses?.find(h => h.id === harness);
		if (!offered) return `it does not offer ${profile.name}`;
		if (offered.signIn === "none") return `${profile.name} is not signed in there (run windlass-runner login ${profile.id} on it)`;
		if (offered.signIn !== "token") return `it could not say whether ${profile.name} is signed in there, and a subtask runs only where it is`;
		if (machine.allowedProfiles && !machine.allowedProfiles.includes(HARNESS_PROFILE)) return `the owner does not allow the ${HARNESS_PROFILE} profile, which ${profile.name} needs`;
	}
	const list = harness === "windlass" ? inventory.models?.windlass : inventory.models?.machines?.[machine.machineId]?.[harness];
	return agentModelProblem(task, list, inventory.featureModel);
}

/** What the machine cannot do at all, from its last report. Kept while it is offline. */
function capabilityFit(machine: Machine, task: PlanSubtask, inventory: PlacementInventory): string | null {
	const needs = task.needs ?? {};
	const tags = new Set([...machine.tags, machine.os, machine.arch, "os:" + machine.os, "arch:" + machine.arch, "harness:windlass",
		...(machine.screenshots ? ["screenshots"] : []), ...(machine.harnesses?.map(h => "harness:" + h.id) ?? [])]);
	const missing = needs.tags?.find(t => !tags.has(t));
	if (missing) return `missing tag ‘${missing}’`;
	if (needs.screenshots && !machine.screenshots) return "screenshots are unavailable";
	if (machine.egress === "none" || (needs.egress && needs.egress !== machine.egress)) return "the egress policy does not support this repository task";
	const agent = agentFit(machine, task, inventory);
	if (agent) return agent;
	if (needs.profile && machine.allowedProfiles && !machine.allowedProfiles.includes(needs.profile)) return `the owner does not allow the ${needs.profile} profile`;
	return null;
}

function candidate(task: PlanSubtask, place: SandboxPlace, inventory: PlacementInventory, preferred: boolean, warm: string[], at: number, name?: string): Candidate {
	const needs = task.needs ?? {};
	const harness = subtaskHarness(task);
	const tokenWait = usesPlatformModel(place, harness) ? inventory.dailyTokenWait : null;
	const bonus = (preferred ? 3 : 0) + Number(warm.includes(placeKey(place)));
	// Usage limits are an account's: only those of the subtask's own agent there hold it back.
	const limited = inventory.limited?.find(a => limitApplies(a, placeKey(place)) && a.harness === harness);
	const waiting = (limit: NonNullable<typeof limited>, name: string) => {
		const dailyCap = !!tokenWait;
		const wait = limit.limitedUntil === undefined ? `Waiting for the ${limit.harness} usage limit on ‘${name}’ to reset.`
			: providerWait(limit.harness, name, placementRetryAt(at, limit.limitedUntil, dailyCap)).sentence;
		return { wait, providerUntil: limit.limitedUntil, accountKey: limit.accountKey, dailyCap };
	};
	const reason = preferred ? task.place?.reason ?? "Same place as the feature" : `Approved overflow from ‘${task.place!.prefer}’`;
	const notForSubtasks = subtaskHarnessProblem(harness);
	if (notForSubtasks) return { refused: notForSubtasks, permanent: true };
	if (place.kind === "hosted") {
		if (harness !== "windlass") return { refused: `this platform runs only Windlass; ${harnessName(harness)} runs on a machine of yours.`, permanent: true };
		const modelProblem = agentModelProblem(task, inventory.models?.windlass, inventory.featureModel);
		if (modelProblem) return { refused: `hosted: ${modelProblem}.`, permanent: true };
		if (!inventory.hostedProfiles.length || (needs.profile && !inventory.hostedProfiles.includes(needs.profile))) return { refused: "hosted has no available matching profile", permanent: true };
		if (inventory.hostedEgress === "none") return { refused: "hosted sandboxes have no network for repositories", permanent: true };
		if (needs.tags?.length || needs.egress)
			return { refused: "hosted does not report the required machine capabilities", permanent: true };
		// `cpus` and `memoryGiB` choose a hosted size: the least that has them. Absent: the item's own size (standard by default).
		const sized = hostedSizeFor(needs);
		if ((needs.cpus || needs.memoryGiB) && !sized) return { refused: `hosted sandboxes have at most ${HOSTED_SIZE_SPECS.large.cpus} vCPU and ${HOSTED_SIZE_SPECS.large.memoryMiB / 1024} GiB`, permanent: true };
		if (sized && !(inventory.hostedSizes ?? ["small"]).includes(sized)) return { refused: `hosted has no ${sized} sandbox (${HOSTED_SIZE_SPECS[sized].cpus} vCPU, ${HOSTED_SIZE_SPECS[sized].memoryMiB / 1024} GiB) on this deployment`, permanent: true };
		if (limited) return waiting(limited, "hosted");
		if (tokenWait) return { wait: tokenWait, dailyCap: true };
		const profile = needs.profile ?? inventory.hostedProfiles.find(p => p === inventory.defaultProfile);
		return { decision: { name: "hosted", place, units: 1, reason, sendSecrets: true, profile, ...(sized && inventory.hostedSizes && { hostedSize: sized }) }, score: bonus };
	}
	const m = inventory.machines.find(m => m.machineId === place.machineId);
	if (!m) return { refused: (name ? "‘" + name + "’" : "The selected machine") + " is no longer one of your machines.", permanent: true };
	const never = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.`, permanent: true });
	const notNow = (message: string): Candidate => ({ refused: `‘${m.name}’: ${message}.`, permanent: false });
	if (m.orchestrator === "never" || m.orchestrator === "named" && !task.place) return never("owner placement policy is " + m.orchestrator);
	const onMachine = harness !== "windlass" ? harness : null;
	// A machine harness runs only in the hardened container, whatever profile the subtask asks for.
	if (onMachine && needs.profile && needs.profile !== HARNESS_PROFILE) return never(`${harnessName(onMachine)} runs only in the ${HARNESS_PROFILE} profile, and the subtask asks for ${needs.profile}`);
	const slots = machineSlots(m);
	const needed = Math.max(1, needs.cpus && slots.unit.cpus > 0 ? Math.ceil(needs.cpus / slots.unit.cpus) : 1,
		needs.memoryGiB ? Math.ceil(needs.memoryGiB * GiB / slots.unit.memoryBytes) : 1);
	if (needed > 1 && !m.slots) return never("sizing beyond one slot is not supported by this runner (" + needed + " slots required)");
	if (needed > 4 || (slots.max !== null && needed > slots.max)) return never(`the task needs ${needed} slots and exceeds the machine or four-slot limit`);
	const units = sandboxSlots(needed, slots.max ?? 1);
	// A machine that has never reported is judged when it connects. One that has keeps its last report.
	const reported = m.online || m.egress !== undefined;
	const incapable = reported ? capabilityFit(m, task, inventory) : null;
	if (incapable) return never(incapable);
	if (limited) return waiting(limited, m.name);
	if (tokenWait) return { wait: tokenWait, dailyCap: true };
	if (!m.online) return { wait: `Waiting for ‘${m.name}’ to come back online.` };
	if (needs.cpus && slots.unit.cpus <= 0) return notNow("per-slot CPU capacity is unknown");
	if ((m.freeDiskBytes ?? 0) < 5 * GiB) return notNow("at least 5 GiB of reported free disk is required");
	const allowed = m.availableProfiles.filter(p => m.allowedProfiles?.some(id => id === p));
	const wanted: SandboxProfileId | undefined = needs.profile ?? (onMachine ? HARNESS_PROFILE : undefined);
	const profile = wanted ? allowed.find(p => p === wanted) : allowed.find(p => p === inventory.defaultProfile) ?? allowed[0];
	if (!profile) return notNow("no available owner-allowed profile matches");
	// An older online runner may have no concurrency cap. Award only one known slot in that case.
	const free = slots.max === null ? 1 : Math.max(0, slots.max - slots.busy);
	if (free < units) return { wait: slotWait(m.name, units, free) };
	return { decision: { name: m.name, place, reason, units, sendSecrets: m.repositorySecrets, profile, ...(onMachine && { harness: onMachine }) },
		score: bonus + Math.min(free, 3) - slots.queued - m.personalRunning };
}

/**
 * A ready place, else the earliest wait, else every refusal. `permanent` is true only when each allowed
 * place is refused for good: approval refuses then, and nothing the owner waits for would help.
 */
export function choosePlacement(task: PlanSubtask, route: PlacementRoute, inventory: PlacementInventory, warm: string[] = [], at = Date.now()) {
	const candidates = [route.preferred, ...route.alternatives].map((p, i) => candidate(task, p, inventory, i === 0, warm, at, route.names?.[placeKey(p)] ?? (i === 0 ? task.place?.prefer : undefined)));
	const decided = candidates.flatMap(c => "decision" in c ? [{ ...c, snapshot: !!inventory.snapshotPlaces?.includes(placeKey(c.decision.place)) }] : []);
	// The preferred place keeps every alternative that does not outrank it on its own behind it; the bonus then orders what is left.
	const preferred = "decision" in candidates[0]! ? decided[0] : undefined;
	const ranked = decided.filter(c => !preferred || c === preferred || c.score > preferred.score);
	const ready = ranked.sort((a, b) => (b.score + (b.snapshot ? SNAPSHOT_BONUS : 0)) - (a.score + (a.snapshot ? SNAPSHOT_BONUS : 0)))[0];
	if (ready) return { decision: ready.decision } as const;
	const waits = candidates.filter(c => "wait" in c);
	const deadline = (wait: typeof waits[number]) => placementRetryAt(at, wait.providerUntil, wait.dailyCap);
	const waiting = waits.sort((a, b) => deadline(a) - deadline(b))[0];
	if (waiting) return { wait: waiting.wait, retryAt: deadline(waiting), providerUntil: waiting.providerUntil,
		dailyCap: waiting.dailyCap, accountKey: waiting.accountKey } as const;
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
