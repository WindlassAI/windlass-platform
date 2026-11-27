import type { PlanSubtask } from "@contract";
import { describe, expect, it } from "vitest";
import { partRun } from "../../../server/src/factory/resolve-run";
import { withAgent } from "./subtask-agents";

describe("agent edits", () => {
	it("drops the saved Codex feasibility when drafting Windlass", () => {
		const task: PlanSubtask = {
			key: "index",
			title: "Index",
			brief: "Index",
			owns: [],
			acceptance: [],
			dependsOn: [],
			budget: { tokens: 245001 },
			resolved: partRun({ account: { harness: "codex" } }, {}),
			placementProblem: "Codex cannot build parts.",
		};
		const edited = withAgent(task, { harness: "windlass" });
		expect(edited.agent?.harness).toBe("windlass");
		expect(edited.resolved).toBeUndefined();
		expect(edited.placementProblem).toBeUndefined();
		expect(task.resolved?.agent).toBe("codex");
	});
});
