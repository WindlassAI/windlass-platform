import { createHash } from "node:crypto";
import type { GithubId } from "../contract.js";
import { recentSubject } from "../factory/intake.js";
import { githubApp, GithubError } from "./app.js";

export const contentDigest = (issue: { title: string; body: string }) => createHash("sha256").update(JSON.stringify([issue.title, issue.body])).digest("hex");

/** A missing or inaccessible subject proves nothing. Operational failures go back to the inbox. */
export async function subjectRead<T>(read: () => Promise<T>) {
	try { return await read(); }
	catch (error) {
		if (!(error instanceof GithubError && [404, 410, 422].includes(error.status))) throw error;
	}
}

/** Resolve the numeric repository and the issue under the matched installation before using either. */
export async function readIssue(installationId: GithubId, repositoryId: GithubId, number: number) {
	const app = githubApp();
	if (!app) return;
	return subjectRead(() => app.withToken(installationId, { repositoryId, permissions: { metadata: "read", issues: "read" } }, async token => {
		const repo = await app.repositoryById(token, repositoryId);
		const issue = await app.issue(token, repo, number);
		if (issue && recentSubject(issue.created)) return { app, token, repo, issue };
	}));
}
