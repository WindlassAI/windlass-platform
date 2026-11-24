import { machineLabel, type HarnessId, type ItemPlaceDefaults, type MachineSummary, type SandboxPlace, type SandboxProfileId } from "../contract.js";
import { harnessName, itemModeOf, itemProfiles, itemSignInMessage, itemSignInMethodProblem, knownHarness, machineHarness } from "../sandbox/harnesses.js";
import { machineSlots } from "./placement.js";

export function savedPlace(repo?: ItemPlaceDefaults | null, account?: ItemPlaceDefaults | null): ItemPlaceDefaults | undefined {
	const source = repo?.place ? repo : account;
	if (!source?.place) return;
	const { place, harness, machineProfile, placeFallback } = source;
	return { place, harness, machineProfile, placeFallback };
}

export function placeMachines(place: ItemPlaceDefaults["place"], machines: readonly MachineSummary[]) {
	if (place === "any-machine") return machines;
	return typeof place === "object" && place ? machines.filter(m => m.machineId === place.machine) : [];
}

export function profilesForItems(machine: MachineSummary, harness: HarnessId) {
	const available = machine.profiles.filter(p => p.available && (!machine.allowedProfiles || machine.allowedProfiles.some(id => id === p.id)));
	if (machine.egress === "none" || machine.warnings.some(w => w.kind === "outdated" || w.kind === "signing-disabled")) return [];
	const agent = machineHarness(harness);
	if (!agent) return available;
	const offered = machine.harnesses?.find(h => h.id === harness);
	if (!offered || itemSignInMessage(agent, machineLabel(machine), offered.signIn) || itemSignInMethodProblem(agent, machineLabel(machine), offered.method)) return [];
	return itemProfiles(harness).flatMap(id => available.filter(p => p.id === id &&
		(!agent.sandboxedOn.includes(id) || offered.modes?.includes(itemModeOf(harness, id) ?? ""))));
}

function compatible(defaults: ItemPlaceDefaults, machines: readonly MachineSummary[]) {
	return placeMachines(defaults.place, machines).flatMap(machine => {
		const profiles = profilesForItems(machine, defaults.harness ?? "windlass");
		const profile = defaults.machineProfile != null ? profiles.find(p => p.id === defaults.machineProfile) : profiles[0];
		return profile ? [{ machine, profile: profile.id }] : [];
	});
}

export function placeProblem(policy: ItemPlaceDefaults, machines: readonly MachineSummary[]): string | null {
	const { place, harness, machineProfile, placeFallback } = policy;
	if (placeFallback != null && placeFallback !== "wait" && placeFallback !== "hosted") return "Choose whether to wait or run hosted.";
	if (machineProfile != null && machineProfile !== "docker-windlass-sandbox" && machineProfile !== "docker-hardened") return "Choose a reported machine profile.";
	if (harness != null && !knownHarness(harness)) return "Choose an agent from the list.";
	if (place == null || place === "hosted") return harness || machineProfile || placeFallback ? "Choose a machine place for these settings." : null;
	if (place !== "any-machine" && (typeof place !== "object" || typeof place.machine !== "string")) return "Choose where items run.";
	if (!placeMachines(place, machines).length) return place === "any-machine" ? "There are no paired machines." : "The selected machine is no longer in your account.";
	if (!compatible(policy, machines).length) return `No selected machine currently supports ${harnessName(harness ?? "windlass")}${machineProfile ? " with " + machineProfile : ""} for work items. Check its profiles and agent sign-in.`;
	return null;
}

function hasRoom(machine: MachineSummary) {
	const slots = machineSlots(machine);
	return machine.status === "online" && (slots.max === null || slots.busy < slots.max)
		&& machine.sandboxes.filter(b => b.state === "running").length < (machine.maxRunning ?? Infinity)
		&& machine.sandboxes.length < (machine.maxSandboxes ?? Infinity);
}

export interface DefaultDestination {
	place: SandboxPlace;
	harness: HarnessId;
	profile?: SandboxProfileId;
	wait?: string;
	note?: string;
}

export function resolveDefaultPlace(policy: ItemPlaceDefaults, machines: readonly MachineSummary[]): DefaultDestination {
	const hosted: DefaultDestination = { place: { kind: "hosted" }, harness: "windlass" };
	if (!policy.place || policy.place === "hosted") return hosted;
	const candidates = compatible(policy, machines);
	const ready = candidates.find(c => hasRoom(c.machine));
	const harness = policy.harness ?? "windlass";
	if (ready) return { place: { kind: "machine", machineId: ready.machine.machineId }, harness, profile: ready.profile };
	const first = candidates[0]?.machine;
	const reason = first ? policy.place === "any-machine" ? "No compatible machine is online with a free slot." :
		`“${machineLabel(first)}” is ${first.status === "online" ? "full" : "offline"}.` : placeProblem(policy, machines)!;
	if (policy.placeFallback === "hosted") return { ...hosted, note: reason + " Using the hosted fallback with Windlass." };
	const wait = reason + " Waiting for a compatible machine with a free slot.";
	const machineId = typeof policy.place === "object" ? policy.place.machine : candidates[0]?.machine.machineId;
	return { place: machineId ? { kind: "machine", machineId } : hosted.place, harness, profile: policy.machineProfile ?? candidates[0]?.profile, wait, note: wait };
}

export const changesPlace = (change: ItemPlaceDefaults) =>
	[change.place, change.harness, change.machineProfile, change.placeFallback].some(v => v !== undefined);

/** A new place starts with its own agent/profile; a patch to the current place keeps the other choices. */
export function changedPlace(before: ItemPlaceDefaults, change: ItemPlaceDefaults): ItemPlaceDefaults {
	const place = change.place === undefined ? before.place : change.place;
	const same = place === before.place || (typeof place === "object" && place && typeof before.place === "object" && before.place?.machine === place.machine);
	const previous = same ? before : {};
	return { place: typeof place === "object" && place ? { machine: place.machine } : place ?? null,
		harness: change.harness === undefined ? previous.harness ?? null : change.harness,
		machineProfile: change.machineProfile === undefined ? previous.machineProfile ?? null : change.machineProfile,
		placeFallback: change.placeFallback === undefined ? previous.placeFallback ?? null : change.placeFallback };
}
