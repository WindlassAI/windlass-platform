/**
 * An item's bindings to its work sources, read one way for every source. Items store them as `meta.bindings`, or
 * (every item so far) as one field per source, which `legacyBindings` reads as the same list. Nothing here writes.
 */

import type { GithubId, ItemOrigin } from "../contract.js";
import {
	filedFrom,
	type GitlabBinding,
	type IssueBinding,
	type JiraBinding,
	type LinearBinding,
	type SlackBinding,
} from "../factory/intake.js";
import { untrustedWords } from "../factory/untrusted.js";
import { CONNECTORS } from "./registry.js";
import type { SourceBinding, SourceId } from "./types.js";

/** Where an item's (or a filing's) bindings are stored: the list, or a field per source. */
export interface StoredBindings {
	bindings?: SourceBinding[];
	github?: IssueBinding;
	gitlab?: GitlabBinding;
	linear?: LinearBinding;
	jira?: JiraBinding;
	slack?: SlackBinding;
}

export const bindingsOf = (meta: StoredBindings): SourceBinding[] => meta.bindings ?? legacyBindings(meta);

/** The bindings a field per source stands for, losing nothing a reader needs. */
export function legacyBindings(meta: StoredBindings): SourceBinding[] {
	const list: SourceBinding[] = [];
	const { github, gitlab, linear, jira, slack } = meta;
	if (github) {
		const { issue, sender } = github.origin;
		list.push({
			ref: {
				source: "github",
				tenant: String(github.installationId),
				scope: null,
				id: github.issueId,
				display: `#${issue.number}`,
				url: issue.url,
			},
			role: "origin",
			generation: github.generation,
			mappingGeneration: null,
			origin: { author: issue.author, sender, trusted: issue.trusted },
			trigger: { via: null, at: github.triggeredAt, senderId: String(github.senderId) },
			...("modeReason" in github && { modeReason: github.modeReason }),
			extra: {
				installationId: github.installationId,
				senderId: github.senderId,
				number: issue.number,
				contentDigest: github.contentDigest,
				...(github.triggerLabel !== undefined && { triggerLabel: github.triggerLabel }),
				...(github.reactionTarget !== undefined && { reactionTarget: github.reactionTarget }),
			},
		});
	}
	if (gitlab)
		list.push({
			ref: {
				source: "gitlab",
				tenant: String(gitlab.project.id),
				scope: null,
				id: gitlab.iid,
				display: `#${gitlab.iid}`,
				url: null,
			},
			role: "origin",
			generation: gitlab.generation,
			mappingGeneration: null,
			origin: { author: "", sender: "", trusted: false },
			trigger: null,
			extra: { projectId: gitlab.project.id },
		});
	for (const [source, tracker] of [
		["linear", linear && { ...linear, tenant: linear.workspaceId, scope: linear.teamId, issue: linear.origin.linear }],
		["jira", jira && { ...jira, tenant: jira.siteId, scope: jira.projectId, issue: jira.origin.jira }],
	] as const)
		if (tracker)
			list.push({
				ref: {
					source,
					tenant: tracker.tenant,
					scope: tracker.scope,
					id: tracker.issue.id,
					display: tracker.issue.identifier,
					url: tracker.issue.url,
				},
				role: "origin",
				generation: tracker.generation,
				mappingGeneration: null,
				origin: { author: tracker.issue.author, sender: tracker.origin.sender, trusted: tracker.issue.trusted },
				trigger: { via: tracker.via, at: tracker.triggeredAt, senderId: tracker.senderId },
				...("modeReason" in tracker && { modeReason: tracker.modeReason }),
			});
	if (slack)
		list.push({
			ref: {
				source: "slack",
				tenant: slack.teamId,
				scope: slack.channelId,
				id: slack.threadTs ?? "",
				display: "",
				url: null,
			},
			role: "origin",
			generation: "message",
			mappingGeneration: slack.generation,
			origin: { author: "", sender: "", trusted: false },
			trigger: null,
		});
	return list;
}

/** The binding an item was filed from, if any. */
export const originBinding = (meta: StoredBindings) => bindingsOf(meta).find(binding => binding.role === "origin");

/** The binding to `source`, which an effect of that source posts through. */
export const bindingTo = (meta: StoredBindings, source: SourceId) =>
	bindingsOf(meta).find(binding => binding.ref.source === source);

const extra = (binding: SourceBinding, name: string) => binding.extra?.[name];

/** A GitHub issue's binding as the issue code takes it. */
export function issueBindingOf(binding: SourceBinding): IssueBinding {
	return {
		...(binding.modeReason !== undefined && { modeReason: binding.modeReason }),
		...(extra(binding, "triggerLabel") !== undefined && { triggerLabel: String(extra(binding, "triggerLabel")) }),
		...(extra(binding, "reactionTarget") !== undefined && { reactionTarget: String(extra(binding, "reactionTarget")) }),
		origin: githubOrigin(binding),
		installationId: extra(binding, "installationId") as GithubId,
		issueId: binding.ref.id,
		senderId: extra(binding, "senderId") as GithubId,
		generation: binding.generation as number,
		triggeredAt: binding.trigger?.at ?? 0,
		contentDigest: String(extra(binding, "contentDigest")),
	};
}

const githubOrigin = (binding: SourceBinding) => ({
	issue: {
		number: extra(binding, "number") as number,
		url: binding.ref.url ?? "",
		author: binding.origin.author,
		trusted: binding.origin.trusted,
	},
	sender: binding.origin.sender,
});

const tracker = (binding: SourceBinding) => ({
	id: binding.ref.id,
	identifier: binding.ref.display,
	url: binding.ref.url ?? "",
	author: binding.origin.author,
});

/** What each source keeps of its wire forms until items carry `bindings`: the page's origin and a filing's submission identity. */
const LEGACY: Record<
	SourceId,
	{
		origin(binding: SourceBinding): ItemOrigin | null;
		identity(binding: SourceBinding, asked: unknown, key: unknown): unknown;
	}
> = {
	github: {
		origin: githubOrigin,
		identity: (binding, asked) => ({ asked, github: issueBindingOf(binding) }),
	},
	gitlab: {
		origin: () => null,
		identity: binding => ({ gitlab: extra(binding, "projectId"), iid: binding.ref.id, generation: binding.generation }),
	},
	linear: {
		origin: binding => ({
			linear: { ...tracker(binding), trusted: binding.origin.trusted },
			sender: binding.origin.sender,
		}),
		identity: binding => ({ linear: binding.ref.id, generation: binding.generation }),
	},
	jira: {
		origin: binding => ({ jira: { ...tracker(binding), trusted: false }, sender: binding.origin.sender }),
		identity: binding => ({ jira: binding.ref.id, siteId: binding.ref.tenant, generation: binding.generation }),
	},
	slack: {
		origin: () => null,
		identity: (_binding, _asked, key) => ({ slack: key }),
	},
};

/** The issue an item was filed from, as `ItemSummary.origin` has always carried it. */
export function originOf(meta: StoredBindings): ItemOrigin | null {
	const binding = originBinding(meta);
	return binding ? LEGACY[binding.ref.source].origin(binding) : null;
}

/** What a repeated filing must match to be the same filing (`submissionOf`): the source's own key, never the issue text. */
export function submissionIdentity(binding: SourceBinding, asked: unknown, key: unknown): unknown {
	return LEGACY[binding.ref.source].identity(binding, asked, key);
}

/** The item's first log line about where it came from, or null when it came from no source. */
export function filingNote(binding: SourceBinding): string {
	const { caps } = CONNECTORS[binding.ref.source];
	if (caps.noun === "message") return `Filed from ${caps.displayName}.`;
	const person = (name: string) => caps.handle + name;
	return filedFrom(
		`${caps.displayName} ${caps.noun} ${binding.ref.display}`,
		person(binding.origin.author),
		person(binding.origin.sender),
	);
}

/** The binding's filing as an untrusted source of the item's text, when it is someone else's. */
export const untrustedOf = (binding: SourceBinding): string[] =>
	binding.origin.trusted ? [] : [untrustedWords.source(binding.ref.source, binding.ref.display, binding.origin.author)];
