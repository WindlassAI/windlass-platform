/**
 * Work sources: the places requests come from and progress is posted back to (GitHub and GitLab issues, Linear,
 * Jira, Slack). Each has one capability record (registry.ts), and shared flows decide by its flags, never by the
 * source's id, so a source added later is one record more (the `sandbox/harnesses.ts` rule).
 *
 * Browser-safe: the web generates its source words from the same records.
 */

import { HOST_IDS } from "../contract/github.js";

/** Every work source, in the order lists and filters show them: the code hosts' issues first. */
export const SOURCE_IDS = [...HOST_IDS, "linear", "jira", "slack"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** What a source can do. A field is only added once something reads it. */
export interface SourceCaps {
	/** The source's name in every UI string, refusal and log line. */
	displayName: string;
	/** What one filing is: an issue, or a message (which has no issue to re-read). */
	noun: "issue" | "message";
	/** Labels that ask for Quick mode. */
	quickLabels: readonly string[];
	/** Someone else's filing as the agent's turn names it (`untrustedWords.source`), and the pattern that recognizes it as third-party text. */
	untrusted: { words(display: string, author: string): string; pattern: RegExp };
}
