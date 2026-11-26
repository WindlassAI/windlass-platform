import type { FeaturePlan, ItemSummary, PlanSubtask } from "@contract";
import { describe, expect, it } from "vitest";
import { needsWords, nextSubtask, OWNER_REASON, orchestratorNote, placeChanged, placedWords, placeDraftOf, refusalFor, withPlace } from "./placement";

const budget = { tokens: 1_000_000, turns: 3, activeSeconds: 1800, hostedSeconds: 900 };
const task = (key: string, patch: Partial<PlanSubtask> = {}): PlanSubtask => ({ key, title: `Do ${key}`, brief: "b", acceptance: ["Run `pnpm test`."], dependsOn: [], owns: [`src/${key}/**`], budget, ...patch });

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
