/**
 * What a turn's closing item says its work rests on (`Verified`, on the item the platform ends a
 * turn with), in the words of a session's own screen: the same facts a pull request's description
 * is given, said to the user they are about. Nothing here is worked out: every line reads a field.
 */
import type { Verified, VerifiedCheck } from "@contract";
import { duration, plural } from "./format";

/** How the gate ended, as the word on the turn's closing line; null where the turn's own outcome says it. */
export function gateWord(verified: Verified): string | null {
	switch (verified.state) {
		case "passed":
			return "checks passed";
		case "not_needed":
			return "checks not needed";
		case "none_set":
			return "no checks set";
		case "off":
			return "verification turned off by the repository's file";
		case "emptied":
			return "the repository's file names an empty list of checks";
		case "no_sandbox":
			return "checks could not run in this sandbox";
		case "not_handed":
			return "your checks could not be handed over";
		case "not_in_force":
			return "no checks in force";
		case "unresolved":
		case "stopped":
		case "failed":
			return null;
	}
}

const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

/** One check of the last run: how it ended, whose it is, and how often the agent was sent back over it. */
export function checkLine(check: VerifiedCheck): string {
	const how =
		check.status === "passed"
			? "passed"
			: check.status === "timed_out"
				? "timed out"
				: check.status === "could_not_start"
					? "could not be started"
					: check.status === "interrupted"
						? "was interrupted"
						: check.exitCode === null
							? "failed"
							: `failed, exit ${check.exitCode}`;
	const whose = check.whose === "user" ? "yours" : "the repository's file";
	if (check.carried) return `${how} earlier, not run again (${whose})`;
	return `${how} ${check.status === "passed" ? "in" : "after"} ${duration(check.durationMs)} (${whose}${check.sentBack > 0 ? `, sent back ${times(check.sentBack)}` : ""})`;
}

/** Why the turn ended with checks still failing; null for any other ending. */
export function unresolvedLine(verified: Verified): string | null {
	if (verified.state !== "unresolved" || !verified.unresolved) return null;
	if (verified.unresolved.reason === "acknowledged") return `the agent reported that it could not make them pass${verified.unresolved.said ? `: ${verified.unresolved.said}` : ""}`;
	if (verified.unresolved.reason === "report_mode") return "the repository's file sets verification to report only, so the agent was not sent back";
	return "the agent had been sent back as often as a turn allows";
}

/** Your checks that are not among the ones that ran, and why, in one line; null when there are none. */
export function unrunLine(verified: Verified): string | null {
	if (verified.unrun.length === 0) return null;
	const names = verified.unrun.map((check) => check.name).join(", ");
	const many = verified.unrun.length > 1;
	if (verified.replaced) return `${names}: the repository's .windlass/config.json names checks of its own, which Windlass follows in place of yours`;
	if (verified.state === "passed" || verified.state === "unresolved") return `${names}: no changed file matches ${many ? "their" : "its"} patterns`;
	if (verified.state === "not_needed") return `${names}: the turn changed nothing ${many ? "they cover" : "it covers"}`;
	if (verified.state === "stopped" || verified.state === "failed") return `${names}: the turn ended before ${many ? "they" : "it"} ran`;
	return names;
}

/** Where the checks that are listed ran in an earlier turn than the one that ended: which. */
export function ranEarlier(verified: Verified): string | null {
	return verified.run !== null && verified.run.turn !== verified.turn ? `last ran in turn ${verified.run.turn}` : null;
}

/** How many of the last run's checks passed, for a line that has no room for each. */
export function runCount(verified: Verified): string | null {
	const checks = verified.run?.checks ?? [];
	if (checks.length === 0) return null;
	const failing = checks.filter((check) => check.status !== "passed").length;
	return failing === 0 ? `${plural(checks.length, "check")} passed` : `${failing} of ${plural(checks.length, "check")} failing`;
}
