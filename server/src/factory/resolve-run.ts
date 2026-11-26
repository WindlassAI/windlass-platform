import type { CredentialSource, DefaultPlace, HarnessId, HostedSize, ItemPlaceDefaults, PlanSubtask, SandboxPlace, SandboxProfileId } from "../contract.js";
import { windlassProvider } from "../sandbox/harnesses.js";
import { ITEM_HOSTED_SIZE } from "../contract/hosted-sizes.js";

export type RunRole = "builder" | "planner" | "part" | "repair" | "reviewer" | "critic" | "summary" | "setup" | "environment";
type Source = "deployment" | "account" | "repository" | "item";
export interface RunSettings extends ItemPlaceDefaults {
	model?: string | null;
	effort?: string | null;
	profile?: SandboxProfileId | null;
	hostedSize?: HostedSize | null;
	payer?: CredentialSource | null;
}
export interface RunContext {
	deployment?: RunSettings;
	machinePayers?: Record<string, Partial<Record<HarnessId, CredentialSource>>>;
	account?: RunSettings;
	repository?: RunSettings;
	repositories?: Record<string, RunSettings>;
	item?: RunSettings;
}
interface RunValues {
	place: DefaultPlace;
	fallback: "wait" | "hosted";
	agent: HarnessId;
	model: string | null;
	effort: string | null;
	profile: SandboxProfileId | null;
	size: HostedSize;
	payer: CredentialSource | "windlass";
}
export type ActualRun = Omit<ResolvedRun, "size"> & { size: HostedSize | number | null };

export interface ResolvedRun extends RunValues {
	sources: Record<keyof RunValues, Source>;
}
export function partRun(context: RunContext, task: Pick<PlanSubtask, "agent" | "needs" | "repo" | "place">, role: RunRole = "part", machines?: readonly { name: string; machineId: string }[]) {
	const repository = task.repo ? context.repositories?.[task.repo] ?? context.repository : context.repository;
	const place = task.place?.prefer;
	const item = place ? { ...context.item, place: place === "hosted" ? "hosted" as const : { machine: machines?.find(m => m.name === place)?.machineId ?? place } } : context.item;
	return resolveRun({ ...context, repository, item }, role, task);
}

export function deploymentSize(offered: readonly HostedSize[], preferred = ITEM_HOSTED_SIZE) {
	return offered.includes(preferred) ? preferred : offered[0];
}

export const runPlace = (place: SandboxPlace): DefaultPlace => place.kind === "machine" ? { machine: place.machineId } : "hosted";

/** Model ids belong to their agent. The Windlass model also serves the planning and review roles. */
export function resolveRun(context: RunContext, role: RunRole, part?: Pick<PlanSubtask, "agent" | "needs">): ResolvedRun {
	const layers: [Source, RunSettings][] = [["deployment", context.deployment ?? {}], ["account", context.account ?? {}], ["repository", context.repository ?? {}], ["item", context.item ?? {}]];
	if (part) layers.push(["item", { harness: part.agent?.harness, model: part.agent?.harness === "windlass" ? part.agent.model : undefined,
		machineModel: part.agent?.model, machineEffort: part.agent?.effort, effort: part.agent?.effort, hostedSize: part.needs?.hostedSize, profile: part.needs?.profile, machineProfile: part.needs?.profile }]);
	const run: ResolvedRun = { place: "hosted", fallback: "wait", agent: "windlass", model: null, effort: null, profile: null,
		size: ITEM_HOSTED_SIZE, payer: "windlass", sources: { place: "deployment", fallback: "deployment", agent: "deployment", model: "deployment",
			effort: "deployment", profile: "deployment", size: "deployment", payer: "deployment" } };
	function set<K extends keyof RunValues>(key: K, value: RunValues[K] | undefined | null, source: Source) {
		if (value == null) return;
		(run as RunValues)[key] = value;
		run.sources[key] = source;
	}
	const implementation = role === "builder" || role === "part" || role === "repair";
	for (const [source, layer] of layers) {
		set("place", layer.place, source);
		set("fallback", layer.placeFallback, source);
		if (implementation) set("agent", layer.harness, source);
		set("size", layer.hostedSize, source);
	}
	let agent: HarnessId = "windlass";
	for (const [source, layer] of layers) {
		agent = layer.harness ?? agent;
		if (run.agent === "windlass") {
			set("model", layer.model, source);
			set("effort", layer.effort, source);
		} else if (agent === run.agent) {
			set("model", layer.machineModel, source);
			set("effort", layer.machineEffort, source);
		}
		set("profile", run.place === "hosted" ? layer.profile : layer.machineProfile, source);
	}
	if (run.agent !== "windlass") {
		run.payer = run.place === "hosted" ? "key" : "machine";
		if (typeof run.place === "object") set("payer", context.machinePayers?.[run.place.machine]?.[run.agent], "account");
		for (const [source, layer] of layers) set("payer", layer.payer, source);
	} else if (windlassProvider(run.model ?? undefined)) {
		set("payer", "key", run.sources.model);
	}
	return run;
}
