/** What a turn's closing line says of its checks: each line reads a field of the platform's record and nothing else. */
import type { Verified, VerifiedCheck } from "@contract";
import { describe, expect, it } from "vitest";
import { applyItem, emptyView } from "./timeline";
import { checkLine, gateWord, overruledLine, ranEarlier, runCount, unneededLine, unresolvedLine, unrunLine } from "./verified";

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

	it("says of a check of yours that it is required where Windlass ran it as one, and whom the repository's own settings held for", () => {
		const both = verified({ overruled: true, run: { turn: 3, at: 0, checks: [check({ required: true }), check({ name: "smoke", command: "true", whose: "repository" })] } });
		expect(both.run?.checks.map(checkLine)).toEqual(["passed in 4.2s (yours, required)", "passed in 4.2s (the repository's file)"]);
		expect(checkLine(check({ required: true, status: "failed", exitCode: 1, sentBack: 2 }))).toBe("failed, exit 1 after 4.2s (yours, required, sent back twice)");
		expect(unrunLine(both)).toBeNull();
		expect(overruledLine(both)).toBe("the repository's .windlass/config.json says something about checks too: that holds for its own checks, and can neither replace your required checks nor switch them off");
		expect(overruledLine(verified())).toBeNull();
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

	it("says why no check was needed where Windlass says it, and which state the files are back on", () => {
		const earlier = { turn: 1, at: 0, seq: 36, checks: [check({ required: true })] };
		const answered = verified({ state: "not_needed", unneeded: { reason: "turn_unchanged", on: null }, run: earlier });
		expect([gateWord(answered), unneededLine(answered)]).toEqual(["checks not needed", null]);
		const uncovered = verified({ state: "not_needed", unneeded: { reason: "not_covered", on: "run" }, run: earlier, changedAfter: true });
		expect([gateWord(uncovered), unneededLine(uncovered), ranEarlier(uncovered)]).toEqual(["no check covers the changes", "no check covers the files that differ from the state the checks last passed on, in turn 1", "last ran in turn 1"]);
		expect(unneededLine(verified({ state: "not_needed", unneeded: { reason: "not_covered", on: "start" }, run: null }))).toBe("no check covers the files that differ from the state the session started from, which no check has verified");
		const back = verified({ state: "not_needed", unneeded: { reason: "state_unchanged", on: "run" }, run: earlier, putBack: [check({ required: true, status: "failed", exitCode: 1, durationMs: 80, sentBack: 1 })] });
		expect([gateWord(back), unneededLine(back), ranEarlier(back)]).toEqual(["checks not needed", "the files the checks cover are again as they were when the checks last passed, in turn 1", "as they passed in turn 1"]);
		expect(back.putBack?.map(checkLine)).toEqual(["failed, exit 1 after 80ms (yours, required, sent back once)"]);
		expect(unneededLine(verified({ state: "not_needed", unneeded: { reason: "state_unchanged", on: "start" }, run: null }))).toBe("the files the checks cover are again as they were when the session started, a state no check has verified");
		expect(unneededLine(verified({ state: "not_needed", unneeded: { reason: "state_unchanged", on: null }, run: null }))).toBe("the turn changed files and left them as they were before");
		// A Windlass that says neither: as it was.
		expect([gateWord(verified({ state: "not_needed" })), unneededLine(verified({ state: "not_needed" }))]).toEqual(["checks not needed", null]);
	});

	it("keeps a check that was not started apart from one that failed", () => {
		const unstarted = check({ name: "lint", required: true, status: "could_not_start", exitCode: null, durationMs: 0, startError: "the sandbox is unavailable" });
		expect(checkLine(unstarted)).toBe("was not started (yours, required): the sandbox is unavailable");
		expect(checkLine({ ...unstarted, startError: "" })).toBe("was not started (yours, required)");
		// From a Windlass that sends the agent back over it: as it was.
		expect(checkLine(check({ status: "could_not_start", exitCode: null, durationMs: 0, sentBack: 3, required: true }))).toBe("could not be started after 0ms (yours, required, sent back 3 times)");
		const alone = verified({ state: "unresolved", unresolved: { reason: "not_started", said: null }, run: { turn: 3, at: 0, checks: [unstarted] } });
		expect(unresolvedLine(alone)).toBe("nothing was verified: a check that was not started says nothing about the code: the agent was not sent back over it, and what there is to fix is the reason given with it");
		const beside = verified({ state: "unresolved", unresolved: { reason: "max_rounds", said: null }, run: { turn: 3, at: 0, checks: [check({ status: "failed", exitCode: 1, sentBack: 3 }), unstarted] } });
		expect(unresolvedLine(beside)).toBe("the agent had been sent back as often as a turn allows; a check that was not started says nothing about the code: the agent was not sent back over it, and what there is to fix is the reason given with it");
		expect(unresolvedLine(verified({ state: "unresolved", unresolved: { reason: "not_started", said: null }, run: { turn: 3, at: 0, checks: [check(), unstarted] } }))).not.toContain("nothing was verified");
	});

	it("is carried by the turn's end in the timeline, and is absent on a turn from before the platform kept it", () => {
		const ended = { seq: 2, at: 10, turn: 3, kind: "turn.ended" as const, outcome: "succeeded" as const, exitCode: 0, steps: 2, durationMs: 900, usage: null, cachedShare: null, message: null };
		const kept = verified({ changedAfter: true });
		expect(applyItem(emptyView(), { ...ended, verified: kept }).turns.at(-1)?.end?.verified).toEqual(kept);
		expect(applyItem(emptyView(), ended).turns.at(-1)?.end?.verified).toBeNull();
	});
});
