import type { GithubId, SessionRepository } from "../contract.js";
import { githubId, isGithubId } from "../github/ids.js";

// Browser-safe: the web app keys its repository filters with these.

/** The code hosts a repository can be on. */
export type HostId = "github" | "gitlab";

/** One identity for a repository on any code host. Built from what is stored (`repoRef`); nothing stores it yet. */
export interface RepoRef {
	host: HostId;
	/**
	 * The host's base URL for a repository on another instance than the deployment's own for its host. Null for
	 * the deployment's own (`WLP_GITHUB_URL`, `WLP_GITLAB_BASE_URL`), which every repository is on today.
	 */
	instance: string | null;
	/** The host's id for it, as a decimal string, never a JS number. */
	id: string;
	/** "owner/name", or "group/sub/name". */
	path: string;
	branch: string;
}

/** A repository as rows store it. Rows written before GitLab have no provider: they are GitHub's. */
type Stored = { provider?: HostId; id: GithubId; instance?: string };

const hostOf = (repository: Pick<Stored, "provider">): HostId =>
	repository.provider === "gitlab" ? "gitlab" : "github";

export function repoRef(repository: SessionRepository): RepoRef {
	return {
		host: hostOf(repository),
		instance: repository.instance ?? null,
		id: String(repository.id),
		path: `${repository.owner}/${repository.name}`,
		branch: repository.branch,
	};
}

/** "https://GitLab.example.com/gitlab/" → "gitlab.example.com/gitlab". */
export function instanceKey(instance: string): string {
	const url = new URL(instance);
	return `${url.host}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
}

/**
 * The key everything saved for a repository is filed under: `github:<id>` or `gitlab:<id>` on the deployment's
 * own instance (the form existing rows have), `<host>:<instance>:<id>` on another.
 */
export function repoKey(ref: Pick<RepoRef, "host" | "instance" | "id">): string {
	return ref.instance === null ? `${ref.host}:${ref.id}` : `${ref.host}:${instanceKey(ref.instance)}:${ref.id}`;
}

/** `repoKey` of a stored repository. */
export const keyOf = (repository: Stored): string =>
	repoKey({ host: hostOf(repository), instance: repository.instance ?? null, id: String(repository.id) });

const KEY = /^(github|gitlab):(?:(.+):)?([1-9][0-9]{0,18})$/;

/**
 * A key in the form `repoKey` writes, read from a row, a caller or an address. GitHub's bare id, the form used
 * before there was another host, reads as `github:<id>`. Null for anything else.
 */
export function readRepoKey(raw: unknown): string | null {
	if (isGithubId(raw)) return `github:${raw}`;
	const key = typeof raw === "string" ? KEY.exec(raw) : null;
	return key && BigInt(key[3]!) <= 9223372036854775807n ? key[0] : null;
}

/**
 * What a link, a filter or a count names a repository by: GitHub's id for one on the deployment's own GitHub, as
 * links always have, and its key for any other (`gitlab:<id>`), so ids of two hosts never meet.
 */
export function repoAddress(repository: Stored): GithubId {
	return hostOf(repository) === "github" && !repository.instance ? repository.id : keyOf(repository);
}

/** An address as `repoAddress` writes it, from a link or a caller; `github:<id>` reads as the bare id. Null for anything else. */
export function readRepoAddress(raw: unknown): GithubId | null {
	const id = githubId(raw);
	if (id !== null) return id;
	const key = readRepoKey(raw);
	return key?.startsWith("github:") && KEY.exec(key)?.[2] === undefined ? githubId(key.slice(7)) : key;
}
