/** An item in words: its state, its verdict and CI, what it asks, and whether it is in its second review. */
import type { ItemState, ItemSummary } from "@contract";

/** The groups of a repository's page, in the plan's words, in the order they stand. */
export const STATE_WORD: Record<ItemState, string> = { draft: "Draft", queued: "Queued", working: "Working", waiting: "Waiting", review: "In review", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/**
 * A verdict in a few words (server/src/factory/verdict.ts, `verdictWords`): a pass with flags needs a look, and a pass whose CI
 * was not read or had not finished says so; neither is "ready".
 */
export function verdictWord(verdict: NonNullable<ItemSummary["verdict"]>): { word: string; tone: "good" | "warn" | "bad" | "dim" } {
	switch (verdict.result) {
		case "pass":
			if (verdict.flags.length > 0) return { word: "Needs a look", tone: "warn" };
			if (CI_WORD[verdict.ci].word === "CI unknown") return { word: "Your checks passed · CI unknown", tone: "dim" };
			return { word: "Ready for review", tone: "good" };
		case "fail":
			return { word: "Failing", tone: "bad" };
		case "incomplete":
			return { word: "Incomplete", tone: "dim" };
		case "unverified":
			return { word: "Not verified", tone: "dim" };
	}
}

/** CI on the pushed commit, in two or three words: what a row of the Factory page says beside its verdict. */
export const CI_WORD: Record<NonNullable<ItemSummary["verdict"]>["ci"], { word: string; tone: "good" | "warn" | "bad" | "dim" }> = {
	passed: { word: "CI passed", tone: "dim" },
	failed: { word: "CI failed", tone: "warn" },
	none: { word: "no CI", tone: "dim" },
	skipped: { word: "CI skipped", tone: "dim" },
	cancelled: { word: "CI unknown", tone: "dim" },
	not_run: { word: "CI unknown", tone: "dim" },
	timed_out: { word: "CI unknown", tone: "dim" },
	not_permitted: { word: "CI unknown", tone: "dim" },
	unread: { word: "CI unknown", tone: "dim" },
};

/**
 * Whether the item is in its review step: the second reviewer runs, or waits to. The platform makes the
 * verdict before the reviewer runs, so one is there already; it is not handed over until the review is
 * filed, and its word is not shown until then.
 */
export function inSecondReview(item: Pick<ItemSummary, "review">): boolean {
	return item.review?.state === "running" || item.review?.state === "waiting";
}

/** What an item asks, in a line for a list: a feature's plan question is its whole plan, so the list says only that it waits. */
export function questionLine(item: ItemSummary): string | null {
	if (!item.question) return null;
	if (item.question.kind === "plan_approval") return "Its plan waits for your approval.";
	if (item.question.kind === "replan_approval") return "Its revised plan waits for your approval.";
	// The agent's own question says more than "The agent stopped to ask you…": its first line.
	const asked = item.question.kind === "agent_ask" ? item.question.asked?.text.trim().split("\n")[0] : undefined;
	return asked || item.question.text;
}

/** The items that ask their person something, across repositories, the longest waiting first. */
export function asking(list: readonly ItemSummary[]): ItemSummary[] {
	return list.filter((item) => item.question !== null).sort((a, b) => (a.question?.askedAt ?? 0) - (b.question?.askedAt ?? 0));
}
