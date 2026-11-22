// @vitest-environment jsdom
/** The item page's run facts: the second review's fixes are counted only where the item's reviewer can send its builder back. */
import type { ItemView } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { RunFacts } from "./Item";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = Date.UTC(2026, 10, 22, 12);
const run = (review?: number): NonNullable<ItemView["run"]> => ({
	n: 1, startedAt: at, endedAt: null, stopReason: null, rounds: { plan: 0, gate: 0, ci: 0, conflict: 0, review: 0 },
	step: { n: 1, kind: "implement", attempt: 1, startedAt: at, turn: "started", checks: 0, interruptions: 0 },
	caps: { plan: 3, gate: 2, ci: 2, conflict: 1, ...(review !== undefined && { review }) },
});

function facts(of: NonNullable<ItemView["run"]>): string {
	const host = document.createElement("div");
	const root = createRoot(host);
	act(() => root.render(createElement(RunFacts, { run: of, events: [], asks: false, now: at })));
	const text = host.textContent ?? "";
	act(() => root.unmount());
	return text;
}

describe("the item page's run facts", () => {
	it("counts the second review's fixes when the item's reviewer is on", () => {
		expect(facts(run(2))).toContain("after the second review 0 of 2");
	});
	it("says nothing of the second review on an item without one", () => {
		const text = facts(run());
		expect(text).toContain("after CI 0 of 2");
		expect(text).not.toContain("second review");
	});
});
