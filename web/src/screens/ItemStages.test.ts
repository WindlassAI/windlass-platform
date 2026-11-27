// @vitest-environment jsdom
/**
 * The item page's stepper: a stage is drawn done only once the item has gone past it. An item that waits in
 * the step it is at (a question while it builds, its plan waiting for approval) stands at that stage, not done.
 */
import type { ItemSummary, StepKind } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ItemStages } from "../components/ItemRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stages(item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review" | "question">, step: StepKind): Array<[string, string]> {
	const host = document.createElement("div");
	const root = createRoot(host);
	act(() => root.render(createElement(ItemStages, { item, step })));
	const out = [...host.querySelectorAll(".item-stage")].map((li) => [li.textContent ?? "", li.className.replace("item-stage", "").trim()] as [string, string]);
	act(() => root.unmount());
	return out;
}

const waiting = { state: "waiting", wait: { reason: "person", sentence: "", since: 0, retryAt: null }, pullRequest: null, review: null } as unknown as ItemSummary;

it("does not fill built while the item waits in its building or planning step", () => {
	for (const step of ["implement", "refine"] as const) {
		const drawn = stages(waiting, step);
		expect(drawn[0]).toEqual(["waiting for you", "item-stage-at"]);
		expect(drawn.slice(1).every(([, state]) => state === "")).toBe(true);
	}
});

const working = { state: "working", wait: null, pullRequest: null, review: null } as unknown as ItemSummary;
const question = { id: "q", kind: "plan_approval", text: "", choices: [], askedAt: 0 } as unknown as ItemSummary["question"];

it("never names the stage it is in by its done name", () => {
	const names = (item: ItemSummary, step: StepKind) => stages(item, step).map(([name]) => name);
	// Planning, the plan waiting for approval, and a feature's parts running: none of them is built.
	expect(names(working, "refine")[0]).toBe("planning");
	expect(names({ ...waiting, question }, "refine")[0]).toBe("asks you");
	expect(names({ ...waiting, wait: { ...waiting.wait!, reason: "children" } }, "subtasks")[0]).toBe("parts running");
	// A feature waiting for its whole-feature CI stands at CI.
	expect(names({ ...waiting, wait: { ...waiting.wait!, reason: "ci" } }, "subtasks").slice(0, 3)).toEqual(["built", "pushed", "waiting for CI"]);
	// A repair running after CI failed, and a person asked while it fixes.
	expect(names({ ...working, pullRequest: {} } as ItemSummary, "ci_fix").slice(0, 3)).toEqual(["built", "pushed", "fixing CI"]);
	expect(names({ ...waiting, question, pullRequest: {} } as ItemSummary, "ci_fix")[2]).toBe("asks you");
	expect(names({ ...working, pullRequest: {} } as ItemSummary, "conflict").slice(0, 2)).toEqual(["built", "resolving conflicts"]);
});

it("says yours only once it is handed over", () => {
	const handed = stages({ ...working, state: "review", pullRequest: {} } as ItemSummary, "handoff");
	expect(handed.at(-1)).toEqual(["yours", "item-stage-done"]);
	expect(handed.every(([name]) => ["built", "pushed", "CI", "review", "yours"].includes(name))).toBe(true);
});

it("fills built once the item is past it", () => {
	const drawn = stages({ ...waiting, wait: { ...waiting.wait!, reason: "ci" } }, "ci");
	expect(drawn.map(([, state]) => state)).toEqual(["item-stage-done", "item-stage-done", "item-stage-now", "", ""]);
});

describe("partTrack", () => {
	it("gives a part its own way into the feature, without CI, review or hand-over", async () => {
		const { partTrack } = await import("../components/ItemRow");
		expect(partTrack({ state: "working", wait: null }, "implement")).toMatchObject({ stages: ["built", "checked", "in the feature"], at: 1, now: true, word: "building" });
		expect(partTrack({ state: "working", wait: null }, "run_checks")).toMatchObject({ at: 2, word: "checking" });
		expect(partTrack({ state: "done", wait: null }, null)).toMatchObject({ at: 3, now: false });
		expect(partTrack({ state: "failed", wait: null }, null)).toBeNull();
	});
});
