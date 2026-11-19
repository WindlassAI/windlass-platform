/**
 * Getting a session's work out and in: the clone of a connected repository when its sandbox is made,
 * and the push with its pull request. Each is the platform's doing, step by step, with a token GitHub
 * issued for that step and that repository alone (app.ts, git.ts). The `agentSession` actor calls these
 * and keeps what they return; nothing here knows of actors, so the checks run them against a stand-in.
 *
 *   clone    contents: read                  the token goes into the sandbox, for `git clone`
 *   push     contents: write                 the token goes into the sandbox, for `git push`
 *   pull     pull requests: write            the token stays on the server, for GitHub's API
 *
 * Before each, GitHub is asked what the connected user may do in the repository (repos.ts): the
 * platform pushes as the app, and must not push where its user could not.
 *
 * A pull request's description ends with a section that says what the work was verified with
 * (verified.ts). The platform writes it when it opens the pull request and again with every push,
 * from what the session holds of its checks and from what git says of the work's changes once they
 * are committed; what else the description says is kept. `describePull` writes it without a push,
 * for a turn that ended after its work was pushed.
 *
 * Every failure a user can do something about is a `GithubProblem` with a sentence that says what:
 * no write access, a protected branch, a repository or an installation that is gone, a connection that
 * was removed.
 */

import type { PublishMessage, PullRequestInfo, SessionRepository, Verified } from "../contract.js";
import type { SandboxHandle } from "../sandbox/api.js";
import { type WorkDiff, verifiedSection, verifiedWords, withVerifiedSection, workFlags } from "../verified.js";
import { type GithubApp, GithubError, type Pull } from "./app.js";
import { CLONE_MINUTES, type GitOutcome, cloneWithToken, commitWork, discardHandover, fetchWithToken, probeWork, pushWithToken, readWork } from "./git.js";
import { redact } from "./redact.js";
import { GithubProblem, NOT_CONNECTED, type StoredConnection, problemOf, resolveRepository } from "./repos.js";

/** What a session keeps of the repository it was launched on. */
export interface StoredRepository extends SessionRepository {
	/** The installation that covered it when the session was made. A hint: the connection is asked again each time. */
	installationId: number;
}

const fullName = (repository: { owner: string; name: string }) => `${repository.owner}/${repository.name}`;

/** `windlass/<the title in a few words>-<the end of the session's id>`: named for the session, and unlike any other session's. */
export function branchFor(title: string, sessionId: string): string {
	const words = title
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	const end = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-6);
	return `windlass/${words === "" ? "agent" : words}-${end}`;
}

/** The address GitHub credits a user's commits by, when the user keeps their own private. */
function authorOf(connection: StoredConnection): { name: string; email: string } {
	return { name: connection.user.login, email: `${connection.user.id}+${connection.user.login}@users.noreply.github.com` };
}

// ---------------------------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------------------------

/** What a clone or a push that failed means for the user. */
function gitProblem(outcome: GitOutcome, what: "clone" | "push", repository: string, account: string, branch: string): GithubProblem {
	const said = outcome.said ? ` Git said: ${outcome.said}` : "";
	switch (outcome.failure) {
		case "gone":
			return new GithubProblem("github_gone", `${repository} is no longer on GitHub, or the GitHub App can no longer see it. Check that the repository exists and that the app's installation on ${account} still includes it.`);
		case "denied":
			return new GithubProblem(
				"github_denied",
				what === "push"
					? `GitHub did not let the GitHub App push to ${repository}. Its installation on ${account} needs the permission "Contents: read and write"; if it has it, the repository's own rules keep the app out.`
					: `GitHub did not let the GitHub App read ${repository}. Check that its installation on ${account} still includes the repository.`,
			);
		case "protected":
			return new GithubProblem("github_denied", `GitHub refused the push: a rule of ${repository} protects branches named like ${branch}. Let the GitHub App create such branches in the repository's branch rules, then push again.`);
		case "workflow":
			return new GithubProblem("github_denied", `GitHub refused the push because it changes a workflow file under .github/workflows, which the GitHub App is not allowed to do. Take that change out, or make it yourself.`);
		case "diverged":
			return new GithubProblem("github_failed", `The branch ${branch} at GitHub has commits this workspace does not have, so the push was refused rather than overwrite them. Ask the agent to bring them in (they cannot be fetched from inside the sandbox), or delete the branch at GitHub and push again.`);
		case "no_branch":
			return new GithubProblem("github_gone", `${repository} has no branch ${branch} any more.`);
		case "unreachable":
			return new GithubProblem("github_unreachable", `GitHub could not be reached from the sandbox.${said} Try again in a moment.`);
		case "timeout":
			return new GithubProblem("github_failed", what === "clone" ? `Cloning ${repository} took longer than ${CLONE_MINUTES} minutes and was stopped.` : `Pushing to ${repository} took too long and was stopped. Try again.`);
		default:
			return new GithubProblem("github_failed", `${what === "clone" ? `Cloning ${repository}` : `Pushing to ${repository}`} failed.${said}`);
	}
}

/** How a clone ended, for a session that had pushed work before: where the workspace is now. */
export interface Cloned {
	/** The commit of the session's branch the workspace was put on; null when it is on the base branch. */
	work: string | null;
	/** The session's branch was asked for and GitHub no longer has it. */
	workGone: boolean;
	/** Where the clone is, relative to the workspace: "." unless the workspace already held something. */
	directory: string;
}

/**
 * Clones the session's repository into its new sandbox. Resolves with `false` when it was aborted,
 * and throws GithubProblem when it could not be done. The token is good for reading this one
 * repository, and is revoked when the clone has ended. `work` names the branch the session's work was
 * pushed to, for a sandbox made in place of a lost one: the workspace is put on it (github/git.ts).
 */
export async function cloneRepository(app: GithubApp, connection: StoredConnection | null, repository: StoredRepository, sandbox: SandboxHandle, signal?: AbortSignal, work?: string): Promise<Cloned | false> {
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	const resolved = await resolveRepository(app, connection, repository.id, "read");
	const name = fullName(resolved.repository);
	const account = resolved.installation.account.login;
	let outcome: GitOutcome;
	try {
		outcome = await app.withToken(
			resolved.installation.id,
			{ repositoryId: repository.id, permissions: { metadata: "read", contents: "read" } },
			(token) => cloneWithToken(sandbox, token, { url: app.cloneUrl(resolved.repository.owner, resolved.repository.name), branch: repository.branch, directory: resolved.repository.name, work, signal }),
			{ revokeAfter: true },
		);
	} catch (error) {
		throw problemOf(error, account, name);
	}
	if (outcome.failure === "aborted") return false;
	if (!outcome.ok) throw gitProblem(outcome, "clone", name, account, repository.branch);
	return { work: outcome.marks.get("work") || null, workGone: outcome.marks.has("nowork"), directory: outcome.marks.get("dir") || "." };
}

// ---------------------------------------------------------------------------------------------
// Pushing, and the pull request
// ---------------------------------------------------------------------------------------------

/** What a pull request's description is to say was verified, as the session holds it (verified.ts). */
export interface PublishEvidence {
	/** What the session's work rests on; null when no turn of the session has ended. */
	verified: Verified | null;
	/** The turn that is running while this is published, whose checks have not run; null between turns. */
	during: number | null;
	/** The user's checks as they are saved now: what their commands run is looked at among the changes. */
	checks: ReadonlyArray<{ name: string; command: string }>;
	/** Takes the saved secrets of the session's repository and account out of the section. */
	redact: (text: string) => string;
}

/**
 * The section for a pull request and the few words kept with it. `work` is what git says of the
 * changes that are pushed, null when it did not say: then nothing was looked for in them, and the
 * section says so. The section leaves through both redactions: the saved secrets, by value, and
 * whatever looks like a credential.
 */
export function evidenceSection(evidence: PublishEvidence, work: WorkDiff | null, login: string): { section: string; words: string } {
	const flags = work === null ? null : workFlags(work, [...evidence.checks, ...(evidence.verified?.run?.checks ?? [])]);
	return {
		section: redact(evidence.redact(verifiedSection({ verified: evidence.verified, flags, during: evidence.during, login }))),
		words: verifiedWords(evidence.verified, flags ?? [], evidence.during),
	};
}

export interface PublishInput {
	app: GithubApp;
	/** The user's connection as their actor has it now; null when there is none. */
	connection: StoredConnection | null;
	repository: StoredRepository;
	sandbox: SandboxHandle;
	sessionId: string;
	/** The branch the work goes to. */
	branch: string;
	/** The pull request the session has, if any. */
	pull: PullRequestInfo | null;
	/** The commit the platform last pushed to the branch, if it pushed before. */
	pushed: string | null;
	message: PublishMessage;
	/** What the pull request's description says was verified. */
	evidence: PublishEvidence;
	/**
	 * The request is the agent's (agent-publish.ts), which writes the pull request's title and description:
	 * a pull request that is open already is given them too, where they differ from what it has, and
	 * a request with nothing to push may still do that.
	 */
	retitle?: boolean;
}

export interface Published {
	pull: PullRequestInfo;
	/** True when this run opened the pull request. */
	opened: boolean;
	/** True when this run pushed something to the branch. */
	pushed: boolean;
	/** True when this run gave a pull request that was open already another title or description. */
	retitled: boolean;
	/** The branch's commit at GitHub now, when git said which. */
	head: string | null;
	/** How many files the platform's commit holds; 0 when the agent had committed everything itself; null when git did not say. */
	committedFiles: number | null;
}

/** Thrown when the push went through and the pull request did not: the commit is at GitHub, so the caller keeps it. */
export class PullProblem extends GithubProblem {
	constructor(
		problem: GithubProblem,
		readonly head: string | null,
	) {
		super(problem.code, problem.message);
	}
}

function infoOf(pull: Pull, pushedAt: number, verified?: string): PullRequestInfo {
	return { number: pull.number, url: pull.url, state: pull.state, title: pull.title, branch: pull.head, base: pull.base, pushedAt, ...(verified === undefined ? {} : { verified }) };
}

const isOpen = (pull: PullRequestInfo | null): pull is PullRequestInfo => pull !== null && (pull.state === "open" || pull.state === "draft");

function commitMessage(message: PublishMessage): string {
	const own = message.commit?.trim() ?? "";
	if (own !== "") return own;
	const body = message.body.trim();
	return body === "" ? message.title.trim() : `${message.title.trim()}\n\n${body}`;
}

/**
 * Commits what is uncommitted, pushes the session's branch, and opens a pull request when none is
 * open. Throws GithubProblem; a `PullProblem` when the push itself went through.
 */
export async function publishWork(input: PublishInput): Promise<Published> {
	const { app, connection, repository, sandbox, branch } = input;
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	// Asked before anything is committed: a user who may not push gets no commit made in their name.
	const resolved = await resolveRepository(app, connection, repository.id, "write");
	const { installation } = resolved;
	const name = fullName(resolved.repository);
	const account = installation.account.login;

	const committed = await commitWork(sandbox, { sessionId: input.sessionId, branch, base: repository.branch, pushed: input.pushed, author: authorOf(connection) }, commitMessage(input.message));
	if (!committed.ok) {
		if (committed.failure === "timeout") throw new GithubProblem("github_failed", "Committing the workspace's changes took too long and was stopped. Try again.");
		throw new GithubProblem("github_failed", `The workspace's changes could not be committed.${committed.said ? ` Git said: ${committed.said}` : ""}`);
	}
	if (committed.marks.has("norepo")) throw new GithubProblem("github_failed", "The workspace is not a git repository any more, so there is nothing to push.");
	const nothingNew = committed.marks.has("nothing");
	const open = isOpen(input.pull) ? input.pull : null;
	const nothingToPush = () => new GithubProblem("github_failed", `There is nothing to push: ${branch} at GitHub already has everything in the workspace.`);
	if (nothingNew && open && !input.retitle) throw nothingToPush();
	// Nothing new, and nothing of this session at GitHub to ask a pull request for.
	if (nothingNew && input.pushed === null) throw new GithubProblem("github_failed", `There is nothing to open a pull request with: the workspace has no changes and no commit that ${repository.branch} does not have.`);

	let head = committed.marks.get("head") || null;
	const count = Number(committed.marks.get("committed"));
	const committedFiles = committed.marks.has("committed") && Number.isInteger(count) ? count : null;
	// Read once everything is committed: what git says of the work now is what the pull request will show.
	const said = evidenceSection(input.evidence, await readWork(sandbox, repository.branch), connection.user.login);

	if (!nothingNew) {
		let pushed: GitOutcome;
		try {
			pushed = await app.withToken(
				installation.id,
				{ repositoryId: repository.id, permissions: { metadata: "read", contents: "write" } },
				(token) => pushWithToken(sandbox, token, { sessionId: input.sessionId, url: app.cloneUrl(resolved.repository.owner, resolved.repository.name), branch }),
				{ revokeAfter: true },
			);
		} catch (error) {
			// No token was to be had, so the push never ran: what the commit step left for it goes.
			await discardHandover(sandbox, input.sessionId);
			throw problemOf(error, account, name);
		}
		if (!pushed.ok) {
			if (pushed.marks.has("nohandover")) throw new GithubProblem("github_failed", "The commit to push could not be found in the sandbox. Try again.");
			throw gitProblem(pushed, "push", name, account, branch);
		}
		head = pushed.marks.get("pushed") || head;
	}

	const now = Date.now();
	const pushed = !nothingNew;
	const title = input.message.title.trim();
	const body = withVerifiedSection(input.message.body, said.section);
	try {
		// Contents too, to read: GitHub opens no pull request for a token that cannot see the two branches
		// ("not all refs are readable"), whatever it may do with pull requests.
		return await app.withToken(installation.id, { repositoryId: repository.id, permissions: { metadata: "read", contents: "read", pull_requests: "write" } }, async (token): Promise<Published> => {
			const { owner, name: repo } = resolved.repository;
			if (open) {
				// It may have been merged or closed at GitHub since: then the push went to a branch with no pull request.
				const current = await app.pull(token, owner, repo, open.number).catch(() => null);
				if (current && (current.state === "open" || current.state === "draft")) {
					// When nothing was pushed, the pull request keeps the time of its last push.
					const at = pushed ? now : open.pushedAt;
					if (input.retitle && (current.title !== title || current.body.trim() !== body)) {
						const updated = await app.updatePull(token, owner, repo, current.number, { title, body });
						return { pull: infoOf(updated, at, said.words), opened: false, pushed, retitled: true, head, committedFiles };
					}
					if (!pushed) throw nothingToPush();
					// A push from the panel leaves the description as it is at GitHub, where its user may have edited it, but for the section.
					const described = withVerifiedSection(current.body, said.section);
					const kept = input.retitle || current.body.trim() === described ? current : await app.updatePull(token, owner, repo, current.number, { title: current.title, body: described });
					return { pull: infoOf(kept, at, said.words), opened: false, pushed, retitled: false, head, committedFiles };
				}
				// Nothing was pushed, and the pull request it was for is no longer open: refused, as without the agent.
				if (!pushed) throw nothingToPush();
			}
			try {
				const created = await app.createPull(token, owner, repo, { title, body, head: branch, base: repository.branch });
				return { pull: infoOf(created, now, said.words), opened: true, pushed, retitled: false, head, committedFiles };
			} catch (error) {
				// One pull request per pair of branches: one that is open already is the session's.
				if (error instanceof GithubError && error.status === 422 && /already exists/i.test(error.said)) {
					const existing = await app.openPull(token, owner, repo, branch, repository.branch);
					if (existing) {
						const described = withVerifiedSection(existing.body, said.section);
						const kept = existing.body.trim() === described ? existing : await app.updatePull(token, owner, repo, existing.number, { title: existing.title, body: described });
						return { pull: infoOf(kept, now, said.words), opened: false, pushed, retitled: false, head, committedFiles };
					}
				}
				if (error instanceof GithubError && error.status === 422 && /no commits between/i.test(error.said)) {
					throw new GithubProblem("github_failed", `GitHub opened no pull request: ${branch} has no commit that ${repository.branch} does not have.`);
				}
				// Any other refusal of the pull request itself is GitHub's to explain: the token and the repository were fine.
				if (error instanceof GithubError && error.status === 422) {
					throw new GithubProblem("github_failed", `The work is on ${branch} at GitHub, but GitHub opened no pull request${error.said ? `: ${error.said}` : ""}.`);
				}
				if (error instanceof GithubError && error.status === 403) {
					throw new GithubProblem("github_denied", `The work is on ${branch} at GitHub, but the GitHub App may not open pull requests in ${name}. Its installation on ${account} needs the permission "Pull requests: read and write"; then choose "Open pull request" again.`);
				}
				throw error;
			}
		});
	} catch (error) {
		throw new PullProblem(problemOf(error, account, name), head);
	}
}

/**
 * Fetches the base branch into the workspace as `origin/<base>`, for a work item's turn that merges it
 * (git.ts `fetchBaseScript`), with a token that may only read the repository. Throws GithubProblem.
 */
export async function fetchBase(app: GithubApp, connection: StoredConnection | null, repository: StoredRepository, sandbox: SandboxHandle): Promise<void> {
	if (!connection) throw new GithubProblem("github_gone", NOT_CONNECTED);
	const resolved = await resolveRepository(app, connection, repository.id, "read");
	const name = fullName(resolved.repository);
	const account = resolved.installation.account.login;
	let fetched: GitOutcome;
	try {
		fetched = await app.withToken(resolved.installation.id, { repositoryId: repository.id, permissions: { metadata: "read", contents: "read" } }, (token) => fetchWithToken(sandbox, token, { url: app.cloneUrl(resolved.repository.owner, resolved.repository.name), base: repository.branch }), { revokeAfter: true });
	} catch (error) {
		throw problemOf(error, account, name);
	}
	if (!fetched.ok) throw gitProblem(fetched, "clone", name, account, repository.branch);
}

/**
 * Writes the section into the description of the session's open pull request without pushing
 * anything, and resolves with the pull request as it is then: for a turn that ended after its work
 * was pushed, so that the description says what that turn's checks came to. The caller has made
 * sure the workspace holds nothing GitHub lacks: the section is about what the pull request shows.
 * Null when the pull request is no longer open or GitHub could not be asked; never throws.
 */
export async function describePull(input: { app: GithubApp; connection: StoredConnection | null; repository: StoredRepository; sandbox: SandboxHandle; pull: PullRequestInfo; evidence: PublishEvidence }): Promise<PullRequestInfo | null> {
	const { app, connection, repository, pull } = input;
	if (!connection || !isOpen(pull)) return null;
	try {
		const said = evidenceSection(input.evidence, await readWork(input.sandbox, repository.branch), connection.user.login);
		const resolved = await resolveRepository(app, connection, repository.id, "write");
		const { owner, name } = resolved.repository;
		return await app.withToken(resolved.installation.id, { repositoryId: repository.id, permissions: { metadata: "read", contents: "read", pull_requests: "write" } }, async (token) => {
			const current = await app.pull(token, owner, name, pull.number);
			if (current.state !== "open" && current.state !== "draft") return null;
			const described = withVerifiedSection(current.body, said.section);
			const kept = current.body.trim() === described ? current : await app.updatePull(token, owner, name, current.number, { title: current.title, body: described });
			return infoOf(kept, pull.pushedAt, said.words);
		});
	} catch (error) {
		console.error(`[wlp] github.pull.describe_failed repository=${repository.id} pull=${pull.number}: ${error instanceof Error ? error.message : "unknown error"}`);
		return null;
	}
}

/**
 * The pull request as GitHub describes it now, or as it was known when GitHub cannot be asked: a
 * panel that shows a state a few minutes old is better than one that shows an error.
 */
export async function refreshPull(app: GithubApp, connection: StoredConnection | null, repository: StoredRepository, pull: PullRequestInfo): Promise<PullRequestInfo> {
	if (!connection) return pull;
	try {
		const resolved = await resolveRepository(app, connection, repository.id, "read");
		const current = await app.withToken(resolved.installation.id, { repositoryId: repository.id, permissions: { metadata: "read", pull_requests: "read" } }, (token) => app.pull(token, resolved.repository.owner, resolved.repository.name, pull.number));
		return infoOf(current, pull.pushedAt, pull.verified);
	} catch (error) {
		console.error(`[wlp] github.pull.refresh_failed repository=${repository.id} pull=${pull.number}: ${error instanceof Error ? error.message : "unknown error"}`);
		return pull;
	}
}

/**
 * Whether the workspace has something GitHub does not, read from a sandbox that is running: true,
 * false, or null when git did not say (the sandbox layer's fake says nothing).
 */
export async function hasUnpushedWork(sandbox: SandboxHandle, base: string, pushed: string | null): Promise<boolean | null> {
	const probed = await probeWork(sandbox, base, pushed);
	if (!probed.ok || (!probed.marks.has("head") && !probed.marks.has("nothing"))) return null;
	return probed.marks.has("dirty") || !probed.marks.has("nothing");
}
