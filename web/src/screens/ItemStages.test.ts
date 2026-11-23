// @vitest-environment jsdom
/**
 * The item page's stepper: a stage is drawn done only once the item has gone past it. An item that waits in
 * the step it is at (a question while it builds, its plan waiting for approval) stands at that stage, not done.
 */
import type { ItemSummary, StepKind } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ItemStages } from "./Items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stages(item: Pick<ItemSummary, "state" | "wait" | "pullRequest" | "review">, step: StepKind): Array<[string, string]> {
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
		expect(drawn[0]).toEqual(["built", "item-stage-at"]);
		expect(drawn.slice(1).every(([, state]) => state === "")).toBe(true);
	}
});

it("fills built once the item is past it", () => {
	const drawn = stages({ ...waiting, wait: { ...waiting.wait!, reason: "ci" } }, "ci");
	expect(drawn.map(([, state]) => state)).toEqual(["item-stage-done", "item-stage-done", "item-stage-now", "", ""]);
});
