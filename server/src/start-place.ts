import { machineLabel, type MachineSummary, type SandboxPlace, type SandboxProfileId, type StartPlace } from "./contract.js";

/** Paired machines can accept a personal launch while offline. */
export function startProfiles(machine: MachineSummary) {
	if (machine.warnings.some(w => w.kind === "outdated" || w.kind === "signing-disabled")) return [];
	return machine.profiles.filter(p => p.available && (!machine.allowedProfiles || machine.allowedProfiles.some(id => id === p.id)));
}

/** Also checks the shape at the action boundary before anything is stored. */
export function startPlaceProblem(place: StartPlace, machines: readonly MachineSummary[]): string | null {
	if (place?.kind === "hosted") return null;
	if (place?.kind !== "machine") return "Choose Hosted or one of your paired machines.";
	const machine = machines.find(m => m.machineId === place.machineId);
	if (!machine) return "The selected machine is no longer in your account.";
	return startProfiles(machine).some(p => p.id === place.profile) ? null : `“${machineLabel(machine)}” does not offer the selected profile.`;
}

type Source = "launch" | "last launch" | "repository default" | "account default" | "deployment default";

interface StartDestination {
	source: Source;
	machine: MachineSummary | null;
	profile?: SandboxProfileId;
	notes: string[];
	pending?: boolean;
}

/** A missing inventory is still loading. An empty inventory has no paired machines. */
export function resolveStartPlace(input: {
	launch?: SandboxPlace;
	last?: SandboxPlace | null;
	repository?: StartPlace | null;
	account?: StartPlace | null;
	machines: readonly MachineSummary[] | null;
}): StartDestination {
	const notes: string[] = [];
	const candidates: [Source, SandboxPlace | StartPlace | null | undefined][] = [
		["launch", input.launch], ["last launch", input.last], ["repository default", input.repository], ["account default", input.account],
	];
	for (const [source, place] of candidates) {
		if (!place) continue;
		if (place.kind === "hosted") return { source, machine: null, notes };
		if (!input.machines) return { source, machine: null, notes, pending: true };
		const machine = input.machines.find(m => m.machineId === place.machineId);
		const profiles = machine && startProfiles(machine);
		if (machine && profiles?.length) {
			if (!("profile" in place)) {
				if (source === "last launch") return { source, machine, notes };
				const saved = [input.repository, input.account].find(p => p?.kind === "machine" && p.machineId === machine.machineId && profiles.some(offered => offered.id === p.profile));
				return { source, machine, profile: saved?.kind === "machine" ? saved.profile : undefined, notes };
			}
			if (profiles.some(p => p.id === place.profile)) return { source, machine, profile: place.profile, notes };
		}
		notes.push(machine ? `The machine or profile from your ${source} is unavailable on “${machineLabel(machine)}”.` : `The machine from your ${source} is no longer paired.`);
	}
	return { source: "deployment default", machine: null, notes };
}
