import type { ChildPlacement, FeaturePlan, ItemSummary, MachineDetails, MachineSummary, PlacementNeeds, PlanSubtask, SandboxPlace } from "@contract";
import { machineLabel } from "./machines";

export type Orchestrator = NonNullable<MachineDetails["orchestrator"]>;

/** The three policies, in the words of the Machines page. "yes" is the default. */
export const ORCHESTRATOR_CHOICES: { id: Orchestrator; label: string; means: string }[] = [
	{ id: "yes", label: "Any feature", means: "Features may place subtasks here." },
	{ id: "named", label: "When named", means: "Only when a plan names this machine." },
	{ id: "never", label: "Never", means: "Features never place subtasks here." },
];

export const orchestratorOf = (machine: Pick<MachineSummary, "orchestrator">): Orchestrator => machine.orchestrator ?? "yes";

/** The few words a machine's card shows for its policy; null for the default, which it does not show. */
export function orchestratorNote(machine: Pick<MachineSummary, "orchestrator">): string | null {
	const policy = orchestratorOf(machine);
	return policy === "named" ? "features: when named" : policy === "never" ? "features: never" : null;
}

/** The name a plan uses for the platform's own sandboxes. */
export const HOSTED = "hosted";

/** A place's name as the page shows it. */
export const placeWord = (name: string) => (name === HOSTED ? "Hosted" : name);

/** The name of the feature's own place, which a subtask without one inherits. */
export function parentPlaceName(place: SandboxPlace, machines: MachineSummary[] | null): string {
	if (place.kind === "hosted") return HOSTED;
	const machine = machines?.find((one) => one.machineId === place.machineId);
	return machine ? machineLabel(machine) : "its machine";
}

/** What a subtask needs of its place, in short words: "2 CPUs", "screenshots", "tag gpu". */
export function needsWords(needs: PlacementNeeds | undefined): string[] {
	if (!needs) return [];
	const words: string[] = [];
	if (needs.hostedSize) words.push(`hosted size ${needs.hostedSize}`);
	if (needs.cpus) words.push(`${needs.cpus} CPU${needs.cpus === 1 ? "" : "s"}`);
	if (needs.memoryGiB) words.push(`${needs.memoryGiB} GiB memory`);
	if (needs.screenshots) words.push("screenshots");
	if (needs.egress) words.push(`${needs.egress} egress`);
	if (needs.profile) words.push(needs.profile);
	for (const tag of needs.tags ?? []) words.push(`tag ${tag}`);
	return words;
}

/** The place a subtask asks for as the owner edits it: `prefer` null inherits the feature's place. */
export interface PlaceDraft {
	prefer: string | null;
	allow: string[];
}

export const placeDraftOf = (task: PlanSubtask): PlaceDraft => ({ prefer: task.place?.prefer ?? null, allow: task.place?.allow ?? [] });

/** The reason a place gets when the owner picks it: the planner's no longer says why. */
export const OWNER_REASON = "Chosen in plan review.";

/** A subtask with the owner's choice of place applied. */
export function withPlace(task: PlanSubtask, draft: PlaceDraft): PlanSubtask {
	const { place: _place, resolved, review, placementProblem, placementWait, requestedLargerSize, ...rest } = task;
	if (draft.prefer === null) return rest;
	const same = task.place?.prefer === draft.prefer;
	const allow = draft.allow.filter((name) => name !== draft.prefer);
	return { ...rest, place: { prefer: draft.prefer, reason: same ? task.place!.reason : OWNER_REASON, ...(allow.length > 0 && { allow }) } };
}

export const placeChanged = (task: PlanSubtask, draft: PlaceDraft) => JSON.stringify(placeDraftOf(task)) !== JSON.stringify({ prefer: draft.prefer, allow: draft.allow.filter((name) => name !== draft.prefer) });

/**
 * The subtask a "placement_refused" question is about: the server prefixes its words with the subtask's
 * title (blueprint.ts, `askPlacement`). The longest title that matches, as one title may begin another.
 */
export function refusedSubtask(plan: FeaturePlan | null, text: string): { task: PlanSubtask; reason: string } | null {
	const task = [...(plan?.subtasks ?? [])].sort((a, b) => b.title.length - a.title.length).find((one) => text.startsWith(`${one.title}: `));
	return task ? { task, reason: text.slice(task.title.length + 2) } : null;
}

/** The part of an approval refusal that is about this subtask: the server prefixes it with the subtask's title. */
export function refusalFor(task: PlanSubtask, refusal: string | null): string | null {
	if (!refusal || !refusal.startsWith(`${task.title}: `)) return null;
	return refusal.slice(task.title.length + 2);
}

/**
 * The subtask the feature takes up next, which a wait for a machine is about: the first, in order, with
 * no item yet whose dependencies are all done (blueprint.ts, `nextChild`).
 */
export function nextSubtask(plan: FeaturePlan, children: ItemSummary[]): PlanSubtask | null {
	const byKey = new Map(children.filter((child) => child.parent).map((child) => [child.parent!.key, child]));
	const done = new Set([...byKey].filter(([, child]) => child.state === "done").map(([key]) => key));
	return plan.subtasks.find((task) => !byKey.has(task.key) && task.dependsOn.every((key) => done.has(key))) ?? null;
}

/** Where a subtask's item was placed, in short words: "nas · 2 slots". */
export function placedWords(placement: ChildPlacement): string {
	return [placeWord(placement.name), ...(placement.units > 1 ? [`${placement.units} slots`] : [])].join(" · ");
}

/** Secrets policy for a place being picked in the editor. */
export function secretsFor(name: string, machines: MachineSummary[] | null): boolean | null {
	if (name === HOSTED) return true;
	const machine = machines?.find((one) => machineLabel(one) === name);
	return machine ? machine.sendSecrets : null;
}

/** Where a subtask may run, as approval binds it (placement.ts, `bindRoute`): its place, or the feature's, and the alternatives overflow allows. */
export interface RouteWords {
	prefer: string;
	/** It names no place: it runs where the feature does. */
	inherited: boolean;
	reason: string | null;
	alternatives: string[];
	/** False while the feature does not allow overflow: the alternatives are never used. */
	overflowing: boolean;
}

export function routeWords(task: PlanSubtask, parent: string, overflow: boolean): RouteWords {
	const bound = task.review?.places;
	if (bound?.length) return { prefer: bound[0]!.name, inherited: !task.place, reason: task.place?.reason ?? null, alternatives: bound.slice(1).map(p => p.name), overflowing: true };
	const prefer = task.place?.prefer ?? parent;
	return { prefer, inherited: !task.place, reason: task.place?.reason ?? null, alternatives: (task.place?.allow ?? []).filter((name) => name !== prefer), overflowing: overflow };
}
