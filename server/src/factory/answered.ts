import type { ChoiceId } from "../contract.js";
import { harnessName } from "../sandbox/harnesses.js";

export const CHOICES: Record<ChoiceId, string> = {
	use_machine_payer: "Use the offered machine and payer", use_hosted: "Run on Hosted", use_windlass: harnessName("windlass"), use_claude: harnessName("claude"), use_opencode: harnessName("opencode"),
	send_back: "Hand it back", dismiss: "Dismiss",
	send: "Send it to the agent", leave: "Leave it",
	run_single: "Approve the current Windlass session as one implementer", orchestrate_anyway: "Ask for subtasks",
	approve: "Approve the plan",
	revise: "Revise the plan",
	raise: "Go on",
	retry: "Start over (discards the sandbox's work)",
	again: "Try again",
	wait: "Keep waiting",
	hand_over: "Hand it over as it is",
	run_checks: "Run the checks again",
	ci_alone: "Integrate on CI alone",
	update_feature: "Update the feature",
	update_from_base: "Update from the base branch and run CI again",
	give_up: "Give up",
	add_secret: "Add it and continue",
	without_secret: "Continue without it",
	fix: "Have the agent change it",
	reply: "Answer the agent",
	run_anyway: "Run it anyway",
	fresh_sandbox: "Start on a fresh sandbox",
	larger_sandbox: "Go on in a larger sandbox",
};
export const choice = (id: ChoiceId) => ({ id, label: CHOICES[id] });

// A reply logs the owner's answer directly, without its button label.
export function answeredWords(picked: { id: ChoiceId; label: string }, note: string | null): string {
	const end = (text: string) => (/[.!?…]["”’)]?$/.test(text) ? "" : ".");
	if (picked.id === "reply" && note !== null) return `Answered: ${note}${end(note)}`;
	return note === null ? `Answered “${picked.label}”.` : `Answered “${picked.label}”: ${note}${end(note)}`;
}
