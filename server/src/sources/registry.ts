/** The capability record of each work source (types.ts). Browser-safe. */

import { SOURCE_IDS, type Connector, type ConnectorCaps, type SourceId } from "./types.js";

const codeHostIssue = {
	noun: "issue",
	handle: "@",
	scope: null,
	connect: "via-code-host",
	refresh: false,
	hooks: "via-code-host",
	ackDeadlineMs: 10_000,
	text: "reread",
	oneItemPer: "issue-generation",
	statusSync: false,
	attachment: false,
	questionContent: "none",
	threadReplies: false,
	interactiveApproval: false,
} as const;

export const CONNECTORS: Record<SourceId, Connector> = {
	github: {
		id: "github",
		caps: {
			...codeHostIssue,
			displayName: "GitHub",
			triggers: ["label", "mention"],
			modeFrom: ["label", "leading-word"],
			quickLabels: ["windlass:quick"],
			identity: "host-permission",
			trust: "author-is-sender",
			refusals: "comment",
			comments: "upsert-one",
			closeCancels: true,
			closesOnMerge: true,
			untrusted: { words: (display, author) => `issue ${display} by @${author}`, pattern: /^issue #\d+ by @/ },
		},
	},
	gitlab: {
		id: "gitlab",
		caps: {
			...codeHostIssue,
			displayName: "GitLab",
			triggers: ["label", "command"],
			modeFrom: [],
			quickLabels: [],
			identity: "owner-only",
			trust: "never",
			refusals: "none",
			comments: "none",
			closeCancels: false,
			closesOnMerge: false,
			untrusted: { words: display => `GitLab issue ${display}`, pattern: /^GitLab issue #\d+$/ },
		},
	},
	linear: {
		id: "linear",
		caps: {
			displayName: "Linear",
			noun: "issue",
			handle: "",
			scope: { noun: "team", plural: "teams" },
			connect: "oauth-pkce",
			refresh: true,
			hooks: "app",
			ackDeadlineMs: 10_000,
			triggers: ["label", "assignment"],
			text: "reread",
			oneItemPer: "issue-generation",
			modeFrom: ["label"],
			quickLabels: ["windlass:quick", "windlass-quick"],
			identity: "anyone-in-scope",
			trust: "never",
			refusals: "none",
			comments: "one-per-update",
			statusSync: true,
			attachment: true,
			questionContent: "link-only",
			closeCancels: false,
			threadReplies: false,
			interactiveApproval: false,
			closesOnMerge: false,
			untrusted: {
				words: (display, author) => `Linear issue ${display} by ${author}`,
				pattern: /^Linear issue [A-Za-z0-9]+-\d+ by /,
			},
		},
	},
	jira: {
		id: "jira",
		caps: {
			displayName: "Jira",
			noun: "issue",
			handle: "",
			scope: { noun: "project", plural: "projects" },
			connect: "oauth",
			refresh: true,
			hooks: "registered-expiring",
			ackDeadlineMs: 10_000,
			triggers: ["label", "assignment"],
			text: "reread",
			oneItemPer: "issue-generation",
			modeFrom: ["label", "issue-type"],
			quickLabels: ["windlass:quick", "windlass-quick"],
			identity: "anyone-in-scope",
			trust: "never",
			refusals: "none",
			comments: "one-per-update",
			statusSync: false,
			attachment: false,
			questionContent: "none",
			closeCancels: false,
			threadReplies: false,
			interactiveApproval: false,
			closesOnMerge: false,
			untrusted: {
				words: (display, author) => `Jira issue ${display} by ${author}`,
				pattern: /^Jira issue [A-Za-z0-9_]+-\d+ by /,
			},
		},
	},
	slack: {
		id: "slack",
		caps: {
			displayName: "Slack",
			noun: "message",
			handle: "",
			scope: { noun: "channel", plural: "channels" },
			connect: "oauth",
			refresh: false,
			hooks: "app",
			ackDeadlineMs: 3_000,
			triggers: ["mention", "command"],
			text: "inline",
			oneItemPer: "message",
			modeFrom: ["leading-word"],
			quickLabels: [],
			identity: "linked-member",
			trust: "never",
			refusals: "private-reply",
			comments: "thread",
			statusSync: false,
			attachment: false,
			questionContent: "opt-in",
			closeCancels: false,
			threadReplies: true,
			interactiveApproval: true,
			closesOnMerge: false,
			untrusted: { words: () => "a Slack request", pattern: /^a Slack request$/ },
		},
	},
};

export const connectorFor = (id: SourceId): Connector => CONNECTORS[id];

/** One value per source, from its capabilities: the source word maps the web and the platform show. */
export function bySource<T>(of: (caps: ConnectorCaps) => T): Record<SourceId, T> {
	return Object.fromEntries(SOURCE_IDS.map(id => [id, of(CONNECTORS[id].caps)])) as Record<SourceId, T>;
}

/** How the item list's filter names a source: "Linear issue", "Slack". */
export const filterWord = (caps: ConnectorCaps) =>
	caps.noun === "issue" ? `${caps.displayName} issue` : caps.displayName;

/** Every source by name, as a sentence lists them: "GitHub, GitLab, Linear, Jira and Slack". */
export function sourceNames(): string {
	const names = SOURCE_IDS.map(id => CONNECTORS[id].caps.displayName);
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
