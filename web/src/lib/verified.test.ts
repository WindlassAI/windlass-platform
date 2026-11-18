/** What a turn's closing line says of its checks: each line reads a field of the platform's record and nothing else. */
import type { Verified, VerifiedCheck } from "@contract";
import { describe, expect, it } from "vitest";
import { applyItem, emptyView } from "./timeline";
import { checkLine, gateWord, ranEarlier, runCount, unresolvedLine, unrunLine } from "./verified";

const check = (fields: Partial<VerifiedCheck> = {}): VerifiedCheck => ({ name: "test", command: "npm test", whose: "user", status: "passed", exitCode: 0, durationMs: 4200, sentBack: 0, ...fields });
const verified = (fields: Partial<Verified> = {}): Verified => ({ turn: 3, state: "passed", run: { turn: 3, at: 0, checks: [check()] }, unrun: [], replaced: false, changedAfter: false, ...fields });

describe("a turn's checks, in words", () => {
	it("says how each check ended, whose it is, and how often the agent was sent back over it", () => {
		expect(checkLine(check())).toBe("passed in 4.2s (yours)");
		expect(checkLine(check({ sentBack: 1 }))).toBe("passed in 4.2s (yours, sent back once)");
		expect(checkLine(check({ status: "failed", exitCode: 1, sentBack: 3, whose: "repository" }))).toBe("failed, exit 1 after 4.2s (the repository's file, sent back 3 times)");
		expect(checkLine(check({ status: "timed_out", exitCode: null, durationMs: 120_000 }))).toBe("timed out after 2m (yours)");
		expect(checkLine(check({ carried: true, durationMs: 0 }))).toBe("passed earlier, not run again (yours)");
	});

	it("never calls a check yours that the repository's file put in its place", () => {
		const replaced = verified({ replaced: true, run: { turn: 3, at: 0, checks: [check({ name: "smoke", command: "true", whose: "repository" })] }, unrun: [{ name: "test", command: "npm test" }] });
		expect(checkLine(replaced.run?.checks[0] as VerifiedCheck)).toContain("the repository's file");
		expect(unrunLine(replaced)).toBe("test: the repository's .windlass/config.json names checks of its own, which Windlass follows in place of yours");
	});

	it("has a word for every way the gate ends without a check, and none where the turn's own outcome says it", () => {
		expect(gateWord(verified())).toBe("checks passed");
		expect(gateWord(verified({ state: "none_set", run: null }))).toBe("no checks set");
		expect(gateWord(verified({ state: "off" }))).toBe("verification turned off by the repository's file");
		expect(gateWord(verified({ state: "not_handed" }))).toBe("your checks could not be handed over");
		for (const state of ["unresolved", "stopped", "failed"] as const) expect(gateWord(verified({ state }))).toBeNull();
		expect(unresolvedLine(verified({ state: "unresolved", unresolved: { reason: "acknowledged", said: "the registry is down" } }))).toBe("the agent reported that it could not make them pass: the registry is down");
		expect(unresolvedLine(verified({ state: "unresolved", unresolved: { reason: "max_rounds", said: null } }))).toBe("the agent had been sent back as often as a turn allows");
		expect(unresolvedLine(verified())).toBeNull();
	});

	it("says why a check of yours did not run, and when the checks that are listed ran in an earlier turn", () => {
		expect(unrunLine(verified())).toBeNull();
		expect(unrunLine(verified({ unrun: [{ name: "types", command: "tsc" }] }))).toBe("types: no changed file matches its patterns");
		expect(unrunLine(verified({ state: "not_needed", unrun: [{ name: "a", command: "x" }, { name: "b", command: "y" }] }))).toBe("a, b: the turn changed nothing they cover");
		expect(unrunLine(verified({ state: "stopped", unrun: [{ name: "a", command: "x" }] }))).toBe("a: the turn ended before it ran");
		expect(ranEarlier(verified())).toBeNull();
		expect(ranEarlier(verified({ turn: 5 }))).toBe("last ran in turn 3");
		expect(runCount(verified({ run: { turn: 3, at: 0, checks: [check(), check({ name: "lint", status: "failed" })] } }))).toBe("1 of 2 checks failing");
		expect(runCount(verified({ run: null }))).toBeNull();
	});

	it("is carried by the turn's end in the timeline, and is absent on a turn from before the platform kept it", () => {
		const ended = { seq: 2, at: 10, turn: 3, kind: "turn.ended" as const, outcome: "succeeded" as const, exitCode: 0, steps: 2, durationMs: 900, usage: null, cachedShare: null, message: null };
		const kept = verified({ changedAfter: true });
		expect(applyItem(emptyView(), { ...ended, verified: kept }).turns.at(-1)?.end?.verified).toEqual(kept);
		expect(applyItem(emptyView(), ended).turns.at(-1)?.end?.verified).toBeNull();
	});
});
