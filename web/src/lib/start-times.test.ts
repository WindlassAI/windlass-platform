import type { StartTimes } from "@contract";
import { describe, expect, it } from "vitest";
import { startHeadline, startLine, startRows } from "./start-times";

const base: StartTimes = { turn: 1, at: 0, harness: "windlass", place: "machine", newSandbox: true };

describe("start times in words", () => {
	it("lists only the parts that happened, in order, with the runner's share and the relay", () => {
		const rows = startRows({ ...base, image: 94_000, pulled: true, sandbox: 2_400, runnerCreate: 1_100, setup: 3_000, prepare: 1_600, relay: 1_200, agent: 700, session: 20, firstOutput: 1_900, total: 104_000 });
		expect(rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
			"image: 1m 34s, pulled",
			"new sandbox: 2.4s (1.1s on the runner)",
			"setup: 3s",
			"platform: 1.6s (model relay 1.2s)",
			"agent start: 700ms",
			"session: 20ms",
			"first output: 1.9s",
		]);
	});

	it("says a resumed sandbox and a turn that ended early plainly", () => {
		const times = { ...base, turn: 3, newSandbox: false, sandbox: 300, agent: 1_000 };
		expect(startRows(times).map((row) => row.label)).toEqual(["sandbox", "agent start"]);
		expect(startHeadline(times)).toBe("ended before the first output");
		expect(startLine(times)).toBe("Turn 3: no output");
		expect(startLine({ ...base, total: 4_100, pulled: true })).toBe("Turn 1: 4.1s, new sandbox, image pulled");
	});
});
