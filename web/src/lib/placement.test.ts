/**
 * The placement words and checks of the plan view and the Machines page: what a subtask needs in
 * short words, an owner's choice of place applied to a subtask, the server's reason for a place it
 * would refuse, the part of an approval refusal about one subtask, and which subtask a wait is about.
 */
import type { FeaturePlan, ItemSummary, MachineSummary, PlanSubtask } from "@contract";
import { describe, expect, it } from "vitest";
import { needsWords, nextSubtask, OWNER_REASON, orchestratorNote, placeChanged, placedWords, placeDraftOf, placementProblem, refusalFor, withPlace } from "./placement";

const budget = { tokens: 1_000_000, turns: 3, activeSeconds: 1800, hostedSeconds: 900 };
const task = (key: string, patch: Partial<PlanSubtask> = {}): PlanSubtask => ({ key, title: `Do ${key}`, brief: "b", acceptance: ["Run `pnpm test`."], dependsOn: [], owns: [`src/${key}/**`], budget, ...patch });

function machine(name: string, patch: Partial<MachineSummary> = {}): MachineSummary {
	return {
		machineId: `m_${name}`, name, os: "Linux", arch: "x64", runnerVersion: "0.2.1", status: "online", since: 0, agents: 0, sandboxes: [], commandSandbox: { ok: true }, freeDiskBytes: 100e9, egress: "open", sendSecrets: true, warnings: [],
		profiles: [{ id: "docker-hardened", name: "", summary: "", layers: [], approval: "full", commandNetwork: true, commandsCanReadAccessToken: true, available: true }],
		allowedProfiles: ["docker-hardened"], orchestrator: "yes", tags: [], whenToUse: "",
		slots: { max: 2, busy: 0, queued: 0, unit: { cpus: 2, memoryBytes: 4 * 2 ** 30, pids: 512 } },
		...patch,
	} as MachineSummary;
}

const nas = machine("nas");
const studio = machine("studio", { orchestrator: "named", screenshots: true, slots: { max: 2, busy: 2, queued: 0, unit: { cpus: 2, memoryBytes: 4 * 2 ** 30, pids: 512 } } });
const ci = machine("ci-box", { orchestrator: "never" });
const machines = [nas, studio, ci];
const onNas = { kind: "machine" as const, machineId: "m_nas" };

describe("placement words", () => {
	it("says what a subtask needs in short words", () => {
		expect(needsWords(undefined)).toEqual([]);
		expect(needsWords({ cpus: 4, memoryGiB: 6, screenshots: true, egress: "open", tags: ["gpu"] })).toEqual(["4 CPUs", "6 GiB memory", "screenshots", "open egress", "tag gpu"]);
		expect(needsWords({ cpus: 1 })).toEqual(["1 CPU"]);
	});

	it("names a machine's policy only when it is not the default", () => {
		expect(orchestratorNote({})).toBeNull();
		expect(orchestratorNote({ orchestrator: "yes" })).toBeNull();
		expect(orchestratorNote({ orchestrator: "named" })).toBe("features: when named");
		expect(orchestratorNote({ orchestrator: "never" })).toBe("features: never");
	});

	it("says where an item was placed, with its slots when more than one", () => {
		expect(placedWords({ place: onNas, name: "nas", reason: "r", units: 1, sendSecrets: true })).toBe("nas");
		expect(placedWords({ place: onNas, name: "nas", reason: "r", units: 2, sendSecrets: true })).toBe("nas · 2 slots");
		expect(placedWords({ place: { kind: "hosted" }, name: "hosted", reason: "r", units: 1, sendSecrets: true })).toBe("Hosted");
	});
});

describe("an owner's choice of place", () => {
	const planned = task("capture", { place: { prefer: "studio", reason: "Screenshots.", allow: ["nas"] } });

	it("keeps the planner's reason while the place is the same, and says the owner chose it otherwise", () => {
		expect(withPlace(planned, { prefer: "studio", allow: [] }).place).toEqual({ prefer: "studio", reason: "Screenshots." });
		expect(withPlace(planned, { prefer: "nas", allow: ["nas", "studio"] }).place).toEqual({ prefer: "nas", reason: OWNER_REASON, allow: ["studio"] });
	});

	it("inherits the feature's place when none is chosen", () => {
		expect("place" in withPlace(planned, { prefer: null, allow: [] })).toBe(false);
	});

	it("is a change only when the place or its alternatives differ", () => {
		expect(placeChanged(planned, placeDraftOf(planned))).toBe(false);
		expect(placeChanged(planned, { prefer: "studio", allow: ["nas", "studio"] })).toBe(false);
		expect(placeChanged(planned, { prefer: "studio", allow: [] })).toBe(true);
		expect(placeChanged(task("a"), { prefer: null, allow: [] })).toBe(false);
	});
});

describe("a place the server would refuse", () => {
	it("gives the server's reason for a machine whose owner said never", () => {
		expect(placementProblem(task("a", { place: { prefer: "ci-box", reason: "Idle." } }), onNas, false, machines)).toBe("‘ci-box’: owner placement policy is never.");
	});

	it("refuses a machine kept for named plans when a subtask only inherits it", () => {
		expect(placementProblem(task("a"), { kind: "machine", machineId: "m_studio" }, false, machines)).toBe("‘studio’: owner placement policy is named.");
		expect(placementProblem(task("a", { place: { prefer: "studio", reason: "Named." } }), onNas, false, machines)).toBeNull();
	});

	it("says what a machine lacks, and a name that is none of the user's machines", () => {
		expect(placementProblem(task("a", { place: { prefer: "nas", reason: "r" }, needs: { screenshots: true } }), onNas, false, machines)).toBe("‘nas’: start this runner with --screenshots and a pinned screenshot image.");
		expect(placementProblem(task("a", { place: { prefer: "attic", reason: "r" } }), onNas, false, machines)).toBe("‘attic’ is not one of your machines.");
	});

	it("does not count a busy machine as a refusal: the subtask waits for it", () => {
		expect(placementProblem(task("a", { place: { prefer: "studio", reason: "r" }, needs: { screenshots: true } }), onNas, false, machines)).toBeNull();
	});

	it("accepts a refused preference when an allowed alternative fits, with overflow on", () => {
		const planned = task("a", { place: { prefer: "ci-box", reason: "r", allow: ["nas"] } });
		expect(placementProblem(planned, onNas, false, machines)).toBe("‘ci-box’: owner placement policy is never.");
		expect(placementProblem(planned, onNas, true, machines)).toBeNull();
	});

	it("leaves a place on this platform to the server", () => {
		expect(placementProblem(task("a", { place: { prefer: "hosted", reason: "r" }, needs: { cpus: 8 } }), onNas, false, machines)).toBeNull();
	});
});

describe("an approval refusal and a wait, by subtask", () => {
	it("finds the part of the refusal that names the subtask", () => {
		const compare = task("compare", { title: "Compare captures" });
		expect(refusalFor(compare, "Compare captures: ‘ci-box’: owner placement policy is never.")).toBe("‘ci-box’: owner placement policy is never.");
		expect(refusalFor(task("other"), "Compare captures: ‘ci-box’: owner placement policy is never.")).toBeNull();
		expect(refusalFor(compare, null)).toBeNull();
	});

	it("takes the first subtask with no item whose dependencies are done as the one waiting", () => {
		const plan = { subtasks: [task("a"), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["b"] })] } as FeaturePlan;
		const child = (key: string, state: ItemSummary["state"]) => ({ parent: { itemId: "f", key, title: "f" }, state }) as ItemSummary;
		expect(nextSubtask(plan, [])?.key).toBe("a");
		expect(nextSubtask(plan, [child("a", "working")])).toBeNull();
		expect(nextSubtask(plan, [child("a", "done")])?.key).toBe("b");
		expect(nextSubtask(plan, [child("a", "done"), child("b", "done")])?.key).toBe("c");
	});
});
