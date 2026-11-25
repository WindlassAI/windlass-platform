// @vitest-environment jsdom
/** The item page's run facts: the rounds of fixing, never capped, and the second review's only once there were some. */
import type { ItemView } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { RunFacts } from "./Item";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = Date.UTC(2026, 10, 22, 12);
const run = (review?: number): NonNullable<ItemView["run"]> => ({
	n: 1, startedAt: at, endedAt: null, stopReason: null, rounds: { plan: 0, gate: 0, ci: 3, conflict: 0, review: review ?? 0 },
	step: { n: 1, kind: "implement", attempt: 1, startedAt: at, turn: "started", checks: 0, interruptions: 0 },
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
	it("hides Fixes until a fix has run", () => {
		const fresh = run();
		fresh.rounds.ci = 0;
		expect(facts(fresh)).not.toContain("Fixes");
	});
	it("counts the second review's fixes once there were some", () => {
		expect(facts(run(2))).toContain("after the second review 2");
	});
	it("says the rounds with no cap, and nothing of a second review that sent nothing back", () => {
		const text = facts(run());
		expect(text).toContain("after CI 3");
		expect(text).not.toContain(" of ");
		expect(text).not.toContain("second review");
	});
});
