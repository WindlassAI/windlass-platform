/**
 * The verdict (Plans "software factory" §8, without the reviewer's `review`): what the work at a pushed
 * head rests on, for a machine to act on and a person to read. It is made from three things only, none
 * of them the agent's words: what the session's gate recorded of its last turn (`Verified`, from
 * Windlass's events: verified.ts), the observations on the changes (`workFlags`), and what GitHub says
 * of CI at the head (github/ci.ts).
 *
 * `result`, in this order:
 *
 *   fail         a check of the gate's run failed (started, and did not pass), or CI failed
 *   incomplete   the turn was stopped, failed, or was cut off
 *   unverified   no check verified the state the work is in: none set, verification off or emptied,
 *                no sandbox for checks, not handed or not in force; "not needed" that does not rest on a
 *                run that passed; a check that could not start and none that failed; files changed after
 *                the checks ran; or CI did not pass (none, unfinished, or not readable) and none of the
 *                checks that ran is the user's
 *   pass         otherwise
 *
 * Flags never change `result`: a pass with flags is shown as "needs a look", never "ready". A verdict
 * never merges anything.
 *
 * Also here: the fingerprint of a failure (§2.1 step 5), by which a fix that brings back the same
 * failure stops the run at once (§2.4).
 */

import { createHash } from "node:crypto";
import type { SandboxPlace, TurnOutcome, Verified } from "../contract.js";
import type { CiReading } from "../github/ci.js";
import { flagWords, verifiedHeadline } from "../verified.js";
import type { CiProgress, GateEvidence, Verdict } from "./types.js";

const CUT_SHORT: ReadonlySet<TurnOutcome> = new Set(["stopped", "failed", "interrupted", "error"]);

/** The checks of the gate's run that failed: started, and did not pass. */
function failingChecks(verified: Verified): Array<{ name: string; output?: string }> {
	return (verified.run?.checks ?? []).filter((check) => check.status !== "passed" && check.startError === undefined);
}

/** What the gate makes of a turn by itself, before anything is pushed (§2.1 step 2): "fail" sends the agent back, "pass" and "unverified" publish. */
export function gateResult(outcome: TurnOutcome, verified: Verified | null): Verdict["result"] {
	if (CUT_SHORT.has(outcome)) return "incomplete";
	if (verified === null) return "unverified";
	switch (verified.state) {
		case "passed":
			return verified.changedAfter ? "unverified" : "pass";
		case "unresolved":
			return failingChecks(verified).length > 0 ? "fail" : "unverified";
		case "not_needed":
			return verified.unneeded?.on === "run" && !verified.changedAfter ? "pass" : "unverified";
		case "stopped":
		case "failed":
			return "incomplete";
		default:
			return "unverified";
	}
}

/** What the verdict says of CI, from the item's last reading. CI still running when the person had the work handed over is "timed_out". */
export function verdictCi(progress: CiProgress | null): Verdict["ci"] {
	const last = progress?.last ?? null;
	if (last === null) return { state: "none", runs: [], said: null };
	return { state: last.state === "pending" ? "timed_out" : last.state, runs: last.runs, said: last.said };
}

export interface VerdictInput {
	id: string;
	item: string;
	run: number;
	head: string;
	at: number;
	place: SandboxPlace;
	gate: GateEvidence | null;
	ci: Verdict["ci"];
	acceptance: string[];
	mergeable: boolean | null;
}

export function verdictOf(input: VerdictInput): Verdict {
	const verified = input.gate?.verified ?? null;
	const checks = verified?.run?.checks ?? [];
	const gate = input.gate === null ? "unverified" : gateResult(input.gate.outcome, verified);
	const usersRan = checks.some((check) => check.whose === "user");
	const result: Verdict["result"] =
		gate === "fail" || input.ci.state === "failed" ? "fail" : gate === "incomplete" ? "incomplete" : gate === "unverified" || (input.ci.state !== "passed" && !usersRan) ? "unverified" : "pass";
	return {
		id: input.id,
		item: input.item,
		run: input.run,
		head: input.head,
		at: input.at,
		place: input.place.kind,
		attestedBy: input.place.kind === "hosted" ? "platform" : `machine:${input.place.machineId}`,
		result,
		gate: {
			state: verified?.state ?? null,
			required: checks.filter((check) => check.whose === "user").map((check) => ({ name: check.name, status: check.status, sentBack: check.sentBack })),
			...(verified?.unneeded ? { unneeded: verified.unneeded } : {}),
		},
		ci: input.ci,
		flags: input.gate?.flags ?? [],
		acceptance: input.acceptance,
		mergeable: input.mergeable,
		said: { ci: ciSentence(input.ci), flags: (input.gate?.flags ?? []).map((flag) => flagWords(flag.kind)) },
	};
}

const FAILING_CONCLUSIONS = ["failure", "timed_out", "startup_failure", "action_required", "error"];

/** What the verdict says of CI, in a sentence: for the log, the pull request and the item's page alike. */
export function ciSentence(ci: Verdict["ci"]): string {
	switch (ci.state) {
		case "passed":
			return `CI passed (${ci.runs.length} ${ci.runs.length === 1 ? "check" : "checks"}).`;
		case "failed":
			return `CI failed: ${names(ci.runs.filter((run) => FAILING_CONCLUSIONS.includes(run.conclusion)))}.`;
		case "none":
			return "No CI ran on this commit.";
		case "timed_out":
			return "CI had not finished when this was handed over.";
		case "not_permitted":
			return `CI was not read: GitHub does not let the platform see this repository's checks${ci.said ? ` (“${ci.said}”)` : ""}. The GitHub App needs read access to Checks, Commit statuses and Actions, accepted on the installation. The pull request's own page shows them.`;
	}
}

const names = (runs: Array<{ name: string }>) => runs.map((run) => run.name).join(", ");

/** The verdict in plain sentences, for the item page and the line on the pull request. */
export function verdictWords(verdict: Verdict, gate: GateEvidence | null): string {
	const head =
		verdict.result === "pass"
			? verdict.flags.length > 0
				? "Needs a look."
				: "Ready for review."
			: verdict.result === "fail"
				? "Failing."
				: verdict.result === "incomplete"
					? "Incomplete: the last turn did not finish."
					: "Not verified.";
	const gateSaid = gate?.verified ? verifiedHeadline(gate.verified, "your") : "Nothing the agent did was verified by checks.";
	const ci = verdict.said.ci;
	const flags = verdict.flags.map((flag, index) => `${verdict.said.flags[index] ?? flagWords(flag.kind)}: ${flag.where.join(", ")}.`);
	const merge = verdict.mergeable === false ? ["GitHub says the pull request conflicts with its base."] : [];
	return [head, gateSaid, ci, ...flags, ...merge].join(" ");
}

// ---------------------------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------------------------

const ERROR_LINE = /\b(error|errors|fail|failed|failure|failing|assert\w*|exception|panic\w*|expected|cannot|undefined)\b/i;

/**
 * The lines of a failure's output that say what failed, with what changes from one run to the next
 * (numbers, durations, hashes, temporary paths) taken out, so the same failure gives the same lines.
 */
function normalisedLines(texts: string[]): string[] {
	const lines = new Set<string>();
	for (const text of texts) {
		for (const raw of text.split("\n")) {
			if (!ERROR_LINE.test(raw)) continue;
			const line = raw
				.replace(/\/tmp\/[^\s:'"]+/g, "/tmp/…")
				.replace(/\b[0-9a-f]{7,}\b/gi, "#")
				.replace(/\d+(?:\.\d+)?/g, "0")
				.replace(/\s+/g, " ")
				.trim();
			if (line !== "") lines.add(line);
		}
	}
	return [...lines].sort();
}

export function failureFingerprint(failing: string[], texts: string[]): string {
	return createHash("sha256")
		.update([...new Set(failing)].sort().join("\n"))
		.update("\n\n")
		.update(normalisedLines(texts).join("\n"))
		.digest("hex");
}

/** Of a gate that failed: the failing checks and what they printed. */
export function gateFingerprint(verified: Verified): string {
	const failing = failingChecks(verified);
	return failureFingerprint(
		failing.map((check) => `gate:${check.name}`),
		failing.map((check) => check.output ?? ""),
	);
}

/** Of CI that failed: the failing runs, their summaries and the ends of their logs. */
export function ciFingerprint(reading: Extract<CiReading, { kind: "read" }>): string {
	const failing = reading.runs.filter((run) => run.state === "failed");
	return failureFingerprint(
		failing.map((run) => `ci:${run.app}/${run.name}`),
		[...failing.map((run) => run.summary), ...reading.logs.map((log) => log.text ?? "")],
	);
}
