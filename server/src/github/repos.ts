/**
 * Which repositories a connected user may work on, and what GitHub lets them do there.
 *
 * A connection is a GitHub user and the installations of the app that user could reach when they
 * connected (state.ts). An installation covers the repositories its account chose, and that is more
 * than every user of it may see: GitHub lists an installation for anyone with access to one of its
 * repositories, so a member of an organization, or a collaborator on one repository of somebody's
 * account, reaches an installation that also covers repositories they cannot open. The platform acts
 * as the installation, which could read all of them. So before anything is done for a user in a
 * repository, GitHub is asked what that user may do there (`GithubApp.permission`), with the
 * installation's own token; the platform keeps no credential of the user's to ask as them. An account's
 * owner is not asked about: the installation on a user's own account covers that user's repositories.
 *
 *   to list a repository, to launch an agent on it      read
 *   to push to it and open a pull request               write
 *
 * Launching and pushing ask GitHub then and there. The list in the launch form asks too, and keeps what
 * it learnt for a few minutes, in this server's memory only: another server asks for itself, and a
 * restart forgets it. Nothing here is the record of anything.
 */

import type { GithubRepository } from "../contract.js";
import { type GithubApp, GithubError, type Repository } from "./app.js";
import type { ConfirmedConnection } from "./state.js";

/** A user's connection as their `user` actor stores it. */
export interface StoredConnection extends ConfirmedConnection {
	connectedAt: number;
}

export type StoredInstallation = StoredConnection["installations"][number];

/** A failure with a sentence for the user; `code` is the UserError's code (contract.ts, `publish`). */
export class GithubProblem extends Error {
	constructor(
		readonly code: "github_gone" | "github_denied" | "github_unreachable" | "github_failed",
		message: string,
	) {
		super(message);
		this.name = "GithubProblem";
	}
}

export const NOT_CONNECTED = "GitHub is not connected any more. Connect GitHub again from the account menu, then try once more.";

const LIST_FRESH_MS = 60_000;
const PERMISSION_FRESH_MS = 5 * 60_000;
/** How many repositories one list shows, and how many it asks GitHub about at most to find them. */
const LIST_SIZE = 30;
const LIST_CHECKS = 90;
const CHECKS_AT_ONCE = 8;

type Level = "admin" | "write" | "read" | "none";

interface Listed {
	at: number;
	repositories: Repository[];
	truncated: boolean;
}

const lists = new Map<number, Listed>();
const listing = new Map<number, Promise<Listed>>();
const permissions = new Map<string, { at: number; level: Level }>();

/** Forgets what this server remembers of GitHub: for the checks, and for a connection that changed. */
export function forgetGithubCaches(): void {
	lists.clear();
	listing.clear();
	permissions.clear();
}

/** What a failed call to GitHub means for the user, for an installation's account. */
export function problemOf(error: unknown, account: string, repository?: string): GithubProblem {
	if (error instanceof GithubProblem) return error;
	if (error instanceof GithubError) {
		if (error.unreachable) return new GithubProblem("github_unreachable", "GitHub could not be reached. Try again in a moment.");
		if (error.status === 404 && repository === undefined) {
			return new GithubProblem("github_gone", `The GitHub App is no longer installed on ${account}. Connect GitHub again and install it there, then try once more.`);
		}
		if (error.status === 404) return new GithubProblem("github_gone", `${repository} is no longer on GitHub, or the GitHub App can no longer see it. Check that the repository exists and that the app's installation on ${account} still includes it.`);
		if (error.status === 422 && repository !== undefined) {
			return new GithubProblem("github_gone", `The GitHub App's installation on ${account} no longer includes ${repository}, or was not given the permission this needs. Add the repository to the installation at GitHub, then try once more.`);
		}
		if (error.status === 401 || error.status === 403) {
			return new GithubProblem("github_denied", `GitHub refused the GitHub App${repository ? ` in ${repository}` : ` on ${account}`}${error.said ? `: ${error.said}` : ""}. Check what the app's installation on ${account} is allowed to do.`);
		}
		return new GithubProblem("github_failed", `GitHub did not accept the request${error.said ? `: ${error.said}` : ` (it answered ${error.status})`}.`);
	}
	return new GithubProblem("github_failed", "Something went wrong while asking GitHub. Try again in a moment.");
}

/**
 * Tokens for reading what an installation covers, one per installation for the length of one request:
 * metadata only, asked for when first needed and dropped when the request is done.
 */
class ReadTokens {
	private readonly issued = new Map<number, Promise<string>>();

	constructor(private readonly app: GithubApp) {}

	of(installation: StoredInstallation): Promise<string> {
		let token = this.issued.get(installation.id);
		if (!token) {
			token = this.app.installationToken(installation.id, { permissions: { metadata: "read" } }).then((issued) => issued.token);
			this.issued.set(installation.id, token);
		}
		return token;
	}
}

async function installationList(app: GithubApp, tokens: ReadTokens, installation: StoredInstallation): Promise<Listed> {
	const cached = lists.get(installation.id);
	if (cached && Date.now() - cached.at < LIST_FRESH_MS) return cached;
	let pending = listing.get(installation.id);
	if (!pending) {
		pending = tokens
			.of(installation)
			.then((token) => app.installationRepositories(token))
			.then((found) => {
				const listed: Listed = { at: Date.now(), ...found };
				lists.set(installation.id, listed);
				return listed;
			})
			.finally(() => listing.delete(installation.id));
		listing.set(installation.id, pending);
	}
	return pending;
}

/** Whether the installation is on the connected user's own account: nothing there is not theirs. */
const ownAccount = (connection: StoredConnection, installation: StoredInstallation) => installation.account.type === "User" && installation.account.id === connection.user.id;

const allows = (level: Level, need: "read" | "write") => (need === "read" ? level !== "none" : level === "admin" || level === "write");

/** What the connected user may do in a repository, asked of GitHub now. */
async function levelOf(app: GithubApp, tokens: ReadTokens, connection: StoredConnection, installation: StoredInstallation, repository: Repository): Promise<Level> {
	if (ownAccount(connection, installation)) return "admin";
	const level = await app.permission(await tokens.of(installation), repository.owner, repository.name, connection.user.login);
	permissions.set(`${connection.user.id}:${repository.id}`, { at: Date.now(), level });
	return level;
}

function described(repository: Repository, level: Level): GithubRepository {
	return {
		id: repository.id,
		owner: repository.owner,
		name: repository.name,
		private: repository.private,
		defaultBranch: repository.defaultBranch,
		canPush: allows(level, "write") && !repository.archived,
		pushedAt: repository.pushedAt,
	};
}

/**
 * The repositories of the connection whose `owner/name` contains `query`, the most recently pushed
 * first, and only those the connected user may read. Throws GithubProblem when nothing can be listed.
 */
export async function listRepositories(app: GithubApp, connection: StoredConnection, query: string): Promise<{ repositories: GithubRepository[]; more: boolean }> {
	const wanted = query.trim().toLowerCase();
	const tokens = new ReadTokens(app);
	const found: Array<{ installation: StoredInstallation; repository: Repository }> = [];
	let truncated = false;
	let firstProblem: GithubProblem | null = null;
	await Promise.all(
		connection.installations.map(async (installation) => {
			try {
				const listed = await installationList(app, tokens, installation);
				truncated ||= listed.truncated;
				for (const repository of listed.repositories) found.push({ installation, repository });
			} catch (error) {
				// One account whose installation is gone does not hide the others.
				firstProblem ??= problemOf(error, installation.account.login);
				console.error(`[wlp] github.list.failed installation=${installation.id}: ${error instanceof Error ? error.message : "unknown error"}`);
			}
		}),
	);
	if (found.length === 0 && firstProblem) throw firstProblem;

	// A name that begins with what was typed comes before one that merely contains it; then the most recently pushed.
	const rank = (repository: Repository) => (wanted === "" ? 0 : repository.name.toLowerCase().startsWith(wanted) || `${repository.owner}/${repository.name}`.toLowerCase().startsWith(wanted) ? 0 : 1);
	const matching = found
		.filter(({ repository }) => wanted === "" || `${repository.owner}/${repository.name}`.toLowerCase().includes(wanted))
		.sort((a, b) => rank(a.repository) - rank(b.repository) || (b.repository.pushedAt ?? 0) - (a.repository.pushedAt ?? 0) || a.repository.name.localeCompare(b.repository.name));

	const shown: GithubRepository[] = [];
	let checked = 0;
	let index = 0;
	while (index < matching.length && shown.length < LIST_SIZE && checked < LIST_CHECKS) {
		const batch = matching.slice(index, index + CHECKS_AT_ONCE);
		index += batch.length;
		const levels = await Promise.all(
			batch.map(async ({ installation, repository }): Promise<Level> => {
				if (ownAccount(connection, installation)) return "admin";
				const known = permissions.get(`${connection.user.id}:${repository.id}`);
				if (known && Date.now() - known.at < PERMISSION_FRESH_MS) return known.level;
				checked += 1;
				try {
					return await levelOf(app, tokens, connection, installation, repository);
				} catch (error) {
					console.error(`[wlp] github.permission.failed repository=${repository.id}: ${error instanceof Error ? error.message : "unknown error"}`);
					return "none";
				}
			}),
		);
		batch.forEach(({ repository }, at) => {
			const level = levels[at] as Level;
			if (allows(level, "read") && shown.length < LIST_SIZE) shown.push(described(repository, level));
		});
	}
	return { repositories: shown, more: truncated || index < matching.length };
}

export interface ResolvedRepository {
	installation: StoredInstallation;
	repository: Repository;
	described: GithubRepository;
}

/**
 * The repository with this id, if the connection covers it and the connected user may do `need` there,
 * asked of GitHub now. Throws GithubProblem with a sentence that says what is in the way.
 */
export async function resolveRepository(app: GithubApp, connection: StoredConnection, repositoryId: number, need: "read" | "write"): Promise<ResolvedRepository> {
	const tokens = new ReadTokens(app);
	let found: { installation: StoredInstallation; repository: Repository } | null = null;
	let firstProblem: GithubProblem | null = null;
	for (const installation of connection.installations) {
		try {
			const listed = await installationList(app, tokens, installation);
			const repository = listed.repositories.find((candidate) => candidate.id === repositoryId);
			if (repository) {
				found = { installation, repository };
				break;
			}
		} catch (error) {
			firstProblem ??= problemOf(error, installation.account.login);
		}
	}
	if (!found) throw firstProblem ?? new GithubProblem("github_gone", "That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.");
	const { installation, repository } = found;
	const name = `${repository.owner}/${repository.name}`;
	let level: Level;
	try {
		level = await levelOf(app, tokens, connection, installation, repository);
	} catch (error) {
		throw problemOf(error, installation.account.login, name);
	}
	if (!allows(level, "read")) throw new GithubProblem("github_denied", `GitHub says ${connection.user.login} has no access to ${name} any more.`);
	if (need === "write" && !allows(level, "write")) {
		throw new GithubProblem("github_denied", `${connection.user.login} can read ${name} on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of ${repository.owner} for write access, then push again.`);
	}
	if (need === "write" && repository.archived) throw new GithubProblem("github_denied", `${name} is archived on GitHub, so nothing can be pushed to it.`);
	return { installation, repository, described: described(repository, level) };
}

/** A repository's branch names, the default first. The connected user must be able to read it. */
export async function listBranches(app: GithubApp, connection: StoredConnection, repositoryId: number): Promise<{ branches: string[]; defaultBranch: string; more: boolean }> {
	const { installation, repository } = await resolveRepository(app, connection, repositoryId, "read");
	try {
		const { branches, truncated } = await app.withToken(installation.id, { repositoryId, permissions: { metadata: "read", contents: "read" } }, (token) => app.branches(token, repository.owner, repository.name));
		const rest = branches.filter((branch) => branch !== repository.defaultBranch).sort((a, b) => a.localeCompare(b));
		// An empty repository has no branch at all; the default is named all the same, so the form has one to show.
		return { branches: [repository.defaultBranch, ...rest], defaultBranch: repository.defaultBranch, more: truncated };
	} catch (error) {
		throw problemOf(error, installation.account.login, `${repository.owner}/${repository.name}`);
	}
}
