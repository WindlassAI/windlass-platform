/** Personal-session feedback only. Item batching and lifecycle stay in work-item. */
import type { FeedbackEntry, GithubId } from "../contract.js";
import { batchText } from "../factory/feedback.js";
import { untrustedWords } from "../factory/untrusted.js";

export type SessionFeedback = { entries: FeedbackEntry[]; target: string; consent?: boolean };

export function sessionFeedbackText(entries: FeedbackEntry[], pr: number) {
	return batchText(entries, { pr, run: 0, ownerLabel: "the session's owner" });
}

export function sessionFeedbackSources(entries: FeedbackEntry[]): string[] {
	const writers = [...new Set(entries.filter(e => e.access !== "owner").map(e => "@" + e.author))];
	return writers.length ? [untrustedWords.feedback(writers.join(", "))] : [];
}

export const SESSION_FEEDBACK_RETRY = "internalSessionFeedbackRetry";

export const sessionFeedbackTarget = (installation: GithubId, pr: number) => `${String(installation)}:${pr}`;
