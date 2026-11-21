import type { GithubId } from "../contract.js";
import { decimalId, githubId } from "./ids.js";

/** The edge keeps just the inputs to a later lookup. GUID and receipt time come from the route. */
type Sender = { id: GithubId; login: string; association: string };
type Fields = {
	issues: { issue: number; sender: Sender; label?: string };
	issue_comment: { issue: number; sender: Sender; commentId: string; body: string; isPullRequest: boolean };
	pull_request: { pr: number; head: string; merged: boolean };
	pull_request_review: { pr: number; reviewId: string; state: string; body: string; commitId: string; sender: Sender };
	pull_request_review_comment: { pr: number; commentId: string; body: string; path: string; line: number | null; commitId: string; sender: Sender };
	check_run: { head: string };
	check_suite: { head: string };
	status: { head: string };
	installation: { repositoryIds: GithubId[] };
	installation_repositories: { repositoryIds: GithubId[] };
};

type Trimmed = { action: string; installationId: GithubId; repositoryId: GithubId | null } &
	{ [E in keyof Fields]: { event: E; data: Fields[E] } }[keyof Fields];

type Receipt = { guid: string; at: number };
export type Delivery = Trimmed & Receipt;

const obj = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === "string" ? v : "";
const id = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
const sha = (v: unknown) => typeof v === "string" && /^[a-f\d]{40}$/i.test(v) ? v : "";
const cut = (s: string) => s.length > 16_000 ? s.slice(0, 15_999) + "…" : s;

/** Actor keys use the canonical decimal spelling of a positive GitHub id. */
export function githubIdKey(key: string[]): boolean {
	return key.length === 1 && githubId(key[0]) !== null;
}

/** null means unaddressed; an address by itself has an empty note. */
export function isAddressed(body: string, slug: string): string | null {
	const words = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body.trimStart());
	const address = words?.[1].toLowerCase();
	return address === "@" + slug.toLowerCase() || address === "/windlass" ? words?.[2] ?? "" : null;
}

export function edge(event: string, payload: unknown, meta: { slug: string } & Receipt): Delivery | null;
export function edge(event: string, payload: unknown, meta: { slug: string }): Trimmed | null;
export function edge(event: string, payload: unknown, meta: { slug: string } & Partial<Receipt>): Trimmed | null {
	const p = obj(payload);
	const installationId = githubId(obj(p.installation).id);
	if (!installationId) return null;
	const repositoryId = githubId(obj(p.repository).id);
	const action = str(p.action);
	// Action names are also log fields. Never let arbitrary JSON text into them.
	if (event !== "status" && !/^[a-z_]{1,64}$/.test(action)) return null;
	const base = { ...("guid" in meta ? { guid: meta.guid, at: meta.at } : {}), installationId, repositoryId, action: event === "status" ? "" : action };
	if (event === "installation" || event === "installation_repositories") {
		const repositoryIds = new Set<GithubId>();
		for (const list of [p.repositories, p.repositories_added, p.repositories_removed]) {
			if (Array.isArray(list)) for (const repo of list) {
				const n = githubId(obj(repo).id);
				if (n) repositoryIds.add(n);
			}
		}
		return { ...base, event, data: { repositoryIds: [...repositoryIds] } };
	}
	if (!repositoryId) return null;
	if (event === "check_run" || event === "check_suite") {
		const head = sha(obj(p[event]).head_sha);
		return action === "completed" && head ? { ...base, event, data: { head } } : null;
	}
	if (event === "status") {
		const head = sha(p.sha);
		return head && ["error", "failure", "success"].includes(str(p.state)) ? { ...base, event, data: { head } } : null;
	}
	const pull = obj(p.pull_request);
	const pr = id(pull.number) ?? id(p.number);
	if (event === "pull_request") {
		const head = sha(obj(pull.head).sha);
		return pr && head && typeof pull.merged === "boolean" && ["closed", "reopened", "synchronize"].includes(action)
			? { ...base, event, data: { pr, head, merged: pull.merged } } : null;
	}
	const author = obj(p.sender);
	const userId = githubId(author.id);
	const login = str(author.login);
	if (!userId || !login || author.type === "Bot") return null;
	const issue = obj(p.issue);
	const subject = event === "issues" ? issue : obj(event === "pull_request_review" ? p.review : p.comment);
	// An issue author's association does not attest to a different person who applied a label.
	const sameAuthor = event !== "issues" || githubId(obj(issue.user).id) === userId;
	const sender = { id: userId, login, association: sameAuthor ? str(subject.author_association) || "NONE" : "NONE" };
	const n = id(issue.number);
	if (event === "issues" && n) {
		const label = str(obj(p.label).name);
		if ((["labeled", "unlabeled"].includes(action) && ["windlass", "windlass:orchestrate", "windlass:quick"].includes(label)) || ["closed", "reopened", "edited", "deleted", "transferred"].includes(action))
			return { ...base, event, data: { issue: n, sender, ...((label === "windlass:orchestrate" || label === "windlass:quick") && { label }) } };
	}
	const commentId = decimalId(subject.id);
	if (!commentId || commentId === "0") return null;
	const body = str(subject.body);
	const addressed = isAddressed(body, meta.slug) !== null;
	if (event === "issue_comment" && action === "created" && addressed && n)
		return { ...base, event, data: { issue: n, commentId, body: cut(body), sender, isPullRequest: !!issue.pull_request } };
	const commitId = sha(subject.commit_id);
	if (!pr || !commitId) return null;
	const state = str(subject.state).toLowerCase();
	if (event === "pull_request_review" && action === "submitted" && (state === "changes_requested" || addressed))
		return { ...base, event, data: { pr, reviewId: commentId, state, body: cut(body), commitId, sender } };
	if (event === "pull_request_review_comment" && action === "created" && addressed && typeof subject.path === "string")
		return { ...base, event, data: { pr, commentId, body: cut(body), path: subject.path, line: id(subject.line), commitId, sender } };
	return null;
}
