/**
 * The repository as the place a user's agents are gathered under: how the list of agents is grouped,
 * how much of a long group is shown, which pull requests a repository's page lists, and what a new
 * agent starts with: its user's choice, then its repository's default, then the account's.
 *
 * Everything here is worked out from what the web app already holds: the summaries of the user's
 * sessions, as their actor broadcasts them, and the deployment's own information. Nothing is asked of
 * GitHub or of a sandbox to draw a list.
 */
import type { PlatformInfo, PullRequestInfo, RepositoryDefaults, SandboxProfileId, SessionRepository, SessionSummary } from "@contract";

// ---- the list of agents, grouped -------------------------------------------------------------------

/** The agents on one repository of the user's GitHub connection, or those on none. */
export interface SessionGroup {
	/** "github:<GitHub's id>", or "none" for the agents that are not on a repository of the connection. */
	key: string;
	/** The repository as the group's newest agent has it: a rename shows once an agent is launched after it. Null for the group "none". */
	repository: SessionRepository | null;
	/** The most recently used first: by the last prompt or turn end. */
	sessions: SessionSummary[];
	/** When the group was last used: its first session's time. */
	usedAt: number;
	/** How many of them are at work, and how many of those wait on their user. */
	working: number;
	waiting: number;
}

export const NO_REPOSITORY = "none";

const byUse = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/**
 * The agents under their repositories: the repository that was used last comes first, and the agents
 * that are on no repository of the GitHub connection (none at all, or a pasted address) come last, as
 * a group of their own. Within a group the agent that was used last comes first.
 */
export function groupSessions(sessions: readonly SessionSummary[]): SessionGroup[] {
	const groups = new Map<string, SessionGroup>();
	/** When the agent a group's repository is named after was launched. */
	const namedAt = new Map<string, number>();
	for (const session of [...sessions].sort(byUse)) {
		const repository = session.repository ?? null;
		const key = repository ? `github:${repository.id}` : NO_REPOSITORY;
		let group = groups.get(key);
		if (!group) {
			group = { key, repository, sessions: [], usedAt: session.updatedAt, working: 0, waiting: 0 };
			groups.set(key, group);
			namedAt.set(key, session.createdAt);
		} else if (repository && session.createdAt > (namedAt.get(key) ?? 0)) {
			// The name a repository goes by is the one its newest agent was launched under.
			group.repository = repository;
			namedAt.set(key, session.createdAt);
		}
		group.sessions.push(session);
		if (session.status !== "idle") group.working += 1;
		if (session.status === "waiting") group.waiting += 1;
	}
	return [...groups.values()].sort((a, b) => Number(a.key === NO_REPOSITORY) - Number(b.key === NO_REPOSITORY) || b.usedAt - a.usedAt || (a.key < b.key ? -1 : 1));
}

/** How many agents of a group are shown before the rest is folded away, where there are several groups, and where there is one. */
export const GROUP_SHOWN = 6;
export const LONE_GROUP_SHOWN = 20;
/** A fold that would hide this few is not worth its line. */
const FOLD_AT_LEAST = 3;

/**
 * What of a group is shown while it is folded: its first `limit` agents, and beyond them every agent
 * that is at work or waits on its user, which is never hidden. `hidden` is how many are left out, and
 * is 0 when the group is short enough to be shown whole.
 */
export function foldGroup(sessions: readonly SessionSummary[], limit: number): { shown: SessionSummary[]; hidden: number } {
	const shown = sessions.filter((session, index) => index < limit || session.status !== "idle");
	const hidden = sessions.length - shown.length;
	return hidden < FOLD_AT_LEAST ? { shown: [...sessions], hidden: 0 } : { shown, hidden };
}

/** How many agents a folded group shows, given how many groups the list has. */
export const shownLimit = (groups: number) => (groups <= 1 ? LONE_GROUP_SHOWN : GROUP_SHOWN);

// ---- a repository's page ---------------------------------------------------------------------------

/** "owner/name". */
export const repositoryName = (repository: Pick<SessionRepository, "owner" | "name">) => `${repository.owner}/${repository.name}`;

/** The user's agents on one repository, the most recently used first. */
export function sessionsOn(sessions: readonly SessionSummary[], repositoryId: number): SessionSummary[] {
	return sessions.filter((session) => session.repository?.id === repositoryId).sort(byUse);
}

export interface OpenPull {
	pull: PullRequestInfo;
	/** The agent whose work it is. */
	session: SessionSummary;
}

/**
 * The pull requests the agents on a repository opened that are still open, as each agent's summary
 * last had them, the most recently pushed first. GitHub is not asked: a pull request that was merged
 * or closed at GitHub since is listed until its agent's panel next reads it.
 */
export function openPulls(sessions: readonly SessionSummary[], repositoryId: number): OpenPull[] {
	const open: OpenPull[] = [];
	for (const session of sessions) {
		const pull = session.repository?.id === repositoryId ? (session.pullRequest ?? null) : null;
		if (pull && (pull.state === "open" || pull.state === "draft")) open.push({ pull, session });
	}
	return open.sort((a, b) => b.pull.pushedAt - a.pull.pushedAt || b.pull.number - a.pull.number);
}

// ---- what a new agent starts with --------------------------------------------------------------------

export interface StartingChoices {
	/** The default sandbox, when one is saved and this deployment can run it. */
	profile: SandboxProfileId | null;
	/** The default model, when one is saved and this deployment offers it. */
	model: string | null;
	/** What is saved and is not used, each with a sentence that says why; null where nothing is left out. */
	ignored: { profile: string | null; model: string | null };
}

/**
 * Saved defaults held against what the deployment offers now: a repository's, or with `whose`
 * "account" the account's. A default that names a sandbox the deployment no longer lists, or cannot
 * run, or a model it no longer offers, is left out, and `ignored` says so in words.
 */
export function startingChoices(defaults: RepositoryDefaults | null, info: Pick<PlatformInfo, "profiles" | "models"> | null, whose: "repository" | "account" = "repository"): StartingChoices {
	const none: StartingChoices = { profile: null, model: null, ignored: { profile: null, model: null } };
	if (defaults === null || info === null) return none;
	const choices: StartingChoices = { profile: null, model: null, ignored: { profile: null, model: null } };
	const the = whose === "account" ? "Your account's default" : "The default";
	if (defaults.profile !== null) {
		const saved = info.profiles.find((profile) => profile.id === defaults.profile);
		if (saved?.available) choices.profile = saved.id;
		else choices.ignored.profile = saved ? `${the} sandbox, ${saved.name}, cannot be used on this deployment now, so it is ignored.` : `${the} sandbox, "${defaults.profile}", is not one this deployment has any more, so it is ignored.`;
	}
	if (defaults.model !== null) {
		if (info.models.includes(defaults.model)) choices.model = defaults.model;
		else choices.ignored.model = `${the} model, ${defaults.model}, is not offered here any more, so it is ignored.`;
	}
	return choices;
}

/** Whose default a field of the launch form stands on. */
export type DefaultSource = "repository" | "account";

/** The defaults a launch starts from, each field by itself, and whose each is; null where neither the repository nor the account has one that can be used. */
export interface LayeredChoices {
	profile: SandboxProfileId | null;
	model: string | null;
	from: { profile: DefaultSource | null; model: DefaultSource | null };
}

/**
 * The chosen repository's defaults over the account's, field by field: a repository that saves only
 * a model leaves the sandbox to the account. Both were held against the deployment already
 * (`startingChoices`), so a default that cannot be used gives way to the next.
 */
export function layerChoices(repository: Pick<StartingChoices, "profile" | "model">, account: Pick<StartingChoices, "profile" | "model">): LayeredChoices {
	return {
		profile: repository.profile ?? account.profile,
		model: repository.model ?? account.model,
		from: { profile: repository.profile !== null ? "repository" : account.profile !== null ? "account" : null, model: repository.model !== null ? "repository" : account.model !== null ? "account" : null },
	};
}

/** What a launch starts on: the user's own choice in the form when they made one, then the chosen repository's default, then the account's (`layerChoices`), then the deployment's first. */
export function startingProfile(chosen: SandboxProfileId | null, choices: Pick<StartingChoices, "profile">, info: Pick<PlatformInfo, "profiles"> | null): SandboxProfileId | null {
	const available = (id: SandboxProfileId | null) => id !== null && info !== null && info.profiles.some((profile) => profile.id === id && profile.available);
	if (available(chosen)) return chosen;
	if (available(choices.profile)) return choices.profile;
	return info?.profiles.find((profile) => profile.available)?.id ?? null;
}

export function startingModel(chosen: string, choices: Pick<StartingChoices, "model">, info: Pick<PlatformInfo, "models"> | null): string {
	if (chosen !== "" && (info === null || info.models.includes(chosen))) return chosen;
	return choices.model ?? info?.models[0] ?? "";
}
