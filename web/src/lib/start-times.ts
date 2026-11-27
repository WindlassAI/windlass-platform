/**
 * A turn's start times (contract.ts `StartTimes`) in plain words, for the session's side panel: what
 * each part of the start took, in the order it happened, and a one-line summary of earlier starts.
 */
import type { StartTimes } from "@contract";
import { duration } from "./format";

export interface StartRow {
	label: string;
	value: string;
	/** What the figure covers, for its title. */
	hint?: string;
}

/** The parts of one start that happened, in order. */
export function startRows(times: StartTimes): StartRow[] {
	const rows: StartRow[] = [];
	const add = (ms: number | undefined, label: string, hint?: string, extra = "") => {
		if (typeof ms === "number") rows.push({ label, value: duration(ms) + extra, ...(hint && { hint }) });
	};
	add(times.waited, "slot wait", "Waiting for a free slot on the machine, before the start.");
	add(
		times.image,
		"image",
		"The runner checking its images, and pulling one when it says so.",
		times.pulled ? ", pulled" : "",
	);
	add(
		times.sandbox,
		times.spare ? "started from a ready sandbox" : times.newSandbox ? "new sandbox" : "sandbox",
		times.newSandbox ? "Making and starting the container." : "Connecting to the sandbox, or resuming it.",
		typeof times.runnerCreate === "number" ? ` (${duration(times.runnerCreate)} on the runner)` : "",
	);
	add(times.setup, "setup", "Cloning, the repository's setup command, or a restored memory.");
	add(
		times.prepare,
		"platform",
		"Clearing leftovers and handing over the sign-in, before the agent starts.",
		typeof times.relay === "number" ? ` (model relay ${duration(times.relay)})` : "",
	);
	add(times.agent, "agent start", "Starting the agent's process until it answered.");
	add(times.session, "session", "Opening the agent's session and choosing its mode and model.");
	add(times.firstOutput, "first output", "From the prompt to the agent's first output.");
	return rows;
}

/** "6.2s to first output", or "did not reach first output" for a turn that ended before it. */
export function startHeadline(times: StartTimes): string {
	return typeof times.total === "number" ? `${duration(times.total)} to first output` : "ended before the first output";
}

/** "Turn 3: 4.1s, new sandbox" */
export function startLine(times: StartTimes): string {
	return `Turn ${times.turn}: ${typeof times.total === "number" ? duration(times.total) : "no output"}${times.newSandbox ? ", new sandbox" : ""}${times.pulled ? ", image pulled" : ""}`;
}
