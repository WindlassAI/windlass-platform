/**
 * Work sources: the places requests come from and progress is posted back to (GitHub and GitLab issues, Linear,
 * Jira, Slack). Each has one capability record (registry.ts), and shared flows decide by its flags, never by the
 * source's id, so a source added later is one record more (the `sandbox/harnesses.ts` rule).
 *
 * Browser-safe: the web generates its source words from the same records.
 */

/** Every work source, in the order lists and filters show them. */
export const SOURCE_IDS = ["github", "gitlab", "linear", "jira", "slack"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** What a source can do. `false` and `"none"` often mean "not built yet" rather than "cannot". */
export interface ConnectorCaps {
	/** The source's name in every UI string, refusal and log line. */
	displayName: string;
	/** What one filing is: an issue, or a message (which has no issue to re-read). */
	noun: "issue" | "message";
	/** What an owner maps to a repository. Null: the source lives inside the repository (code-host issues). */
	scope: { noun: "team" | "project" | "channel"; plural: string } | null;

	connect: "oauth-pkce" | "oauth" | "via-code-host";
	/** The source's own tokens rotate. */
	refresh: boolean;
	hooks: "app" | "registered-expiring" | "per-scope" | "via-code-host";
	/** How soon a delivery must be answered. */
	ackDeadlineMs: number;

	triggers: readonly ("label" | "assignment" | "mention" | "command")[];
	/** Re-read from the source's API (issues), or carried in the signed delivery (a Slack message). */
	text: "reread" | "inline";
	oneItemPer: "issue-generation" | "message";
	modeFrom: readonly ("label" | "issue-type" | "leading-word")[];
	/** Labels that ask for Quick mode. */
	quickLabels: readonly string[];
	/** Who may file. */
	identity: "anyone-in-scope" | "owner-only" | "linked-member" | "host-permission";
	/** When the text counts as the filer's own: not quoted, and it may start without a draft. */
	trust: "author-is-owner" | "author-is-sender" | "never";
	refusals: "comment" | "private-reply" | "none";

	comments: "upsert-one" | "one-per-update" | "thread" | "none";
	statusSync: boolean;
	attachment: boolean;
	questionContent: "link-only" | "opt-in" | "none";

	closeCancels: boolean;
	threadReplies: boolean;
	interactiveApproval: boolean;
	/** "Closes #n" in the pull request (same-host issues only). */
	closesOnMerge: boolean;

	/** Someone else's filing as the agent's turn names it (`untrustedWords.source`), and the pattern that recognizes it as third-party text. */
	untrusted: { words(display: string, author: string): string; pattern: RegExp };
}

/** One work source. Later steps add its adapter: parse, read, render and perform. */
export interface Connector {
	id: SourceId;
	caps: ConnectorCaps;
}
