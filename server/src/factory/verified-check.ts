import type { CheckConclusion, ItemAgent, ItemBudget, ItemSpend, Verdict } from "../contract.js";
import { tokenWords } from "./budget.js";
import { spellSeconds } from "../usage.js";
import { flagWords } from "../verified.js";
import { harnessName } from "../sandbox/harnesses.js";
import { commentText } from "./review.js";
import type { CheckReview } from "./types.js";
import { ciSentence, verdictHeadline } from "./verdict.js";

export const CHECK_DENIED = "windlass/verified was not posted: the GitHub App's installation has not accepted Checks: write.";

/**
 * `unfinished`: the run's last second review did not approve, and none was filed for this commit (the next round was refused,
 * filed nothing readable, or the person handed the commit over before it ran). Such a commit is never a success.
 */
export function checkConclusion(v: Verdict, review: CheckReview | null = null, unfinished = false): CheckConclusion {
	if (v.moved) return "action_required";
	if (v.result === "fail" || v.result === "incomplete") return "failure";
	if (v.result !== "pass" || v.flags.length || ["unread", "not_permitted", "timed_out", "not_run"].includes(v.ci.state)) return "action_required";
	if (!review && unfinished) return "action_required";
	return review && review.recommendation !== "approve" ? "action_required" : "success";
}

export function checkTitle(v: Verdict, review: CheckReview | null = null, unfinished = false): string {
	if (v.moved) return `New changes have not been verified since ${v.head.slice(0, 7)}`;
	const title = verdictHeadline(v, review?.recommendation, unfinished).replace(/\.$/, "");
	if (title === "Ready for review" && review?.recommendation === "needs_person") return "Code review needs your input";
	return title;
}

export function evidenceLine(itemUrl: string): string {
	return itemUrl.length <= 2000 ? `[View evidence](${itemUrl}) (opens for the item's owner only).` : "Evidence: open Details (opens for the item's owner only).";
}

/** The public output accepts only platform observations. Never interpolate a filing, diagnostic or acceptance criterion. */
export function checkSummary(v: Verdict, review: CheckReview | null, spent: ItemSpend, budget: ItemBudget, itemUrl: string, agent?: ItemAgent, unfinished = false): string {
	const sha = commentText(v.head.slice(0, 7), 7);
	// Name the agent that built the commit: "Claude Code at abc1234", not the platform's own name.
	const head = `${harnessName(agent?.harness ?? "windlass")} at ${v.moved ? commentText(v.moved.slice(0, 7), 7) : sha}: ${checkTitle(v, review, unfinished)}.`;
	// ci.said can include raw API or job output. Render the CI sentence without that diagnostic.
	const ci = v.ci.state === "unread" && v.ci.said ? "GitHub returned only part of the CI listing." : ciSentence({ ...v.ci, said: null });
	const header = [head, ...(v.moved ? [`The evidence below is for the agent's commit ${sha}.`] : []), commentText(ci, 600)].join("\n\n");
	let gate = "Your checks:";
	if (!v.gate.required.length) {
		if (v.gate.state === null) gate = "The turn left no record of its checks; CI decides.";
		else if (v.gate.state === "none_set") gate = "No checks are set for this repository; CI decides.";
		else gate = "None of your checks ran on this commit.";
	}
	function details(width: number) {
		return [
			...v.ci.runs.map(r => `- ${commentText(r.name, width)}: ${commentText(r.conclusion, 40)}`),
			gate,
			...v.gate.required.map(c => `- ${commentText(c.name, width)}: ${commentText(c.status, 40)}`),
			...v.flags.map(f => `- ${flagWords(f.kind)}: ${f.where.map(p => commentText(p, width)).join(", ")}`),
		].join("\n");
	}
	const words = { approve: "approved", changes_requested: "requested changes", needs_person: "needs a person" };
	const n = v.acceptance.length;
	const footer = [
		review ? `Second review: ${words[review.recommendation]}, ${review.blocking} blocking finding${review.blocking === 1 ? "" : "s"}.`
			: unfinished ? "No second review finished for this commit; the last one filed did not approve." : "No second review was filed for this commit.",
		`${n} acceptance ${n === 1 ? "criterion is" : "criteria are"} left to you.`,
		`Spent: ${tokenWords(spent, budget, agent)}, ${spent.turns} ${spent.turns === 1 ? "turn" : "turns"}, ${spellSeconds(spent.activeSeconds)} working time.`,
		evidenceLine(itemUrl),
	].join("\n\n");
	// Shorten names and paths before dropping a row. Reserve the headline, totals and evidence link.
	const room = 4000 - header.length - footer.length - 4;
	let rows = details(160);
	if (rows.length > room) rows = details(48);
	if (rows.length > room) rows = rows.slice(0, room - 1) + "…";
	return [header, rows, footer].join("\n\n");
}
