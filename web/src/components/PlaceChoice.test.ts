/** The harnesses the composer offers on a machine, for an agent and for a work item. */
import type { MachineSummary } from "@contract";
import { describe, expect, it } from "vitest";
import { itemHarnesses, offeredHarnesses } from "./PlaceChoice";

const machine = (harnesses: { id: string; signIn: string }[]) => ({ machineId: "m_1", name: "Bench", harnesses }) as unknown as MachineSummary;

describe("itemHarnesses", () => {
	it("offers a work item the signed-in agents work items run, never Codex", () => {
		const bench = machine([
			{ id: "claude", signIn: "token" },
			{ id: "opencode", signIn: "token" },
			{ id: "codex", signIn: "token" },
		]);
		expect(offeredHarnesses(bench).map((h) => h.id)).toEqual(["claude", "opencode", "codex"]);
		expect(itemHarnesses(bench).map((h) => h.id)).toEqual(["claude", "opencode"]);
	});

	it("leaves out an agent the machine does not report signed in", () => {
		expect(itemHarnesses(machine([{ id: "claude", signIn: "none" }, { id: "opencode", signIn: "token" }])).map((h) => h.id)).toEqual(["opencode"]);
	});
});
