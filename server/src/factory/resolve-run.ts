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
export function runAgent(run: ResolvedRun) {
	return { harness: run.agent, model: run.model ?? undefined, effort: run.effort ?? undefined };
}

export function partRun(context: RunContext, task: Pick<PlanSubtask, "agent" | "needs" | "repo" | "place">, role: "part" | "repair" = "part", machines?: readonly { name: string; machineId: string }[]) {
	const repository = task.repo ? context.repositories?.[task.repo] ?? context.repository : context.repository;
	const place = task.place?.prefer;
	const item: RunSettings | undefined = place ? { ...context.item, place: place === "hosted" ? "hosted" : { machine: machines?.find(m => m.name === place)?.machineId ?? place } } : context.item;
	return resolveRun({ ...context, repository, item }, role, task);
}

export function deploymentSize(offered: readonly HostedSize[], preferred = ITEM_HOSTED_SIZE) {
	return offered.includes(preferred) ? preferred : offered[0];
}

export const runPlace = (place: SandboxPlace): DefaultPlace => place.kind === "machine" ? { machine: place.machineId } : "hosted";

/** Model ids belong to their agent. The Windlass model also serves the planning and review roles. */
export function resolveRun(context: RunContext, role: RunRole, part?: Pick<PlanSubtask, "agent" | "needs">): ResolvedRun {
	const layers: [Source, RunSettings][] = [
		["deployment", context.deployment ?? {}],
		["account", context.account ?? {}],
		["repository", context.repository ?? {}],
		["item", context.item ?? {}],
	];
	if (part) {
		const { agent, needs } = part;
		layers.push(["item", { harness: agent?.harness, model: agent?.harness === "windlass" ? agent.model : undefined,
			machineModel: agent?.model, effort: agent?.effort, machineEffort: agent?.effort,
			hostedSize: needs?.hostedSize, profile: needs?.profile, machineProfile: needs?.profile }]);
	}

	// The final place selects the profile column. A machine model belongs to the agent in scope at its layer.
	const priority = [...layers].reverse();
	const placeLayer = priority.find(([, settings]) => settings.place != null);
	const implementation = role === "builder" || role === "part" || role === "repair";
	const agentLayer = implementation ? priority.find(([, settings]) => settings.harness != null) : undefined;
	const place = placeLayer?.[1].place ?? "hosted";
	const agent = agentLayer?.[1].harness ?? "windlass";
	const values: RunValues = { place, fallback: "wait", agent, model: null, effort: null, profile: null, size: ITEM_HOSTED_SIZE,
		payer: agent === "windlass" ? "windlass" : place === "hosted" ? "key" : "machine" };
	const sources: ResolvedRun["sources"] = { place: placeLayer?.[0] ?? "deployment", fallback: "deployment", agent: agentLayer?.[0] ?? "deployment",
		model: "deployment", effort: "deployment", profile: "deployment", size: "deployment", payer: "deployment" };
	function set<K extends keyof RunValues>(key: K, value: RunValues[K] | undefined | null, source: Source) {
		if (value == null) return;
		values[key] = value;
		sources[key] = source;
	}
	if (agent !== "windlass" && typeof place === "object") set("payer", context.machinePayers?.[place.machine]?.[agent], "account");
	let layerAgent: HarnessId = "windlass";
	for (const [source, layer] of layers) {
		layerAgent = layer.harness ?? layerAgent;
		set("fallback", layer.placeFallback, source);
		set("size", layer.hostedSize, source);
		set("profile", place === "hosted" ? layer.profile : layer.machineProfile, source);
		if (agent !== "windlass") set("payer", layer.payer, source);
		if (agent === "windlass" || agent === layerAgent) {
			set("model", agent === "windlass" ? layer.model : layer.machineModel, source);
			set("effort", agent === "windlass" ? layer.effort : layer.machineEffort, source);
		}
	}
	if (agent === "windlass" && windlassProvider(values.model ?? undefined)) set("payer", "key", sources.model);
	return { ...values, sources };
}
