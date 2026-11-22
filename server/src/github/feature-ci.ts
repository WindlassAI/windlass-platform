import { minimatch } from "minimatch";
import { parse } from "yaml";
import { GithubError, type GithubApp } from "./app.js";
import { ownApp } from "./ids.js";
import { refHead } from "./feature.js";

const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;

/** GitHub evaluates branch include/exclude globs in order. A tag-only push cannot run on a branch. */
export function workflowReportsPush(source: string, branch: string): boolean {
	let trigger: unknown;
	try { trigger = record(parse(source, { maxAliasCount: 50 })).on; } catch { return false; }
	if (typeof trigger === "string") return trigger === "push";
	if (Array.isArray(trigger)) return trigger.includes("push");
	if (!trigger || typeof trigger !== "object" || !("push" in trigger)) return false;
	const push = record(trigger.push);
	const patterns = push.branches ?? push["branches-ignore"];
	if (patterns === undefined) return !("tags" in push || "tags-ignore" in push);
	if (!Array.isArray(patterns)) return false;
	const ignored = "branches-ignore" in push;
	let match = ignored;
	for (const pattern of patterns) {
		if (typeof pattern !== "string") return false;
		const negative = pattern.startsWith("!");
		if (minimatch(branch, negative ? pattern.slice(1) : pattern, { nonegate: true, dot: true })) match = !ignored && !negative;
	}
	return match;
}

export async function hasPushCi(app: GithubApp, token: string, owner: string, repo: string, base: string, branches: string[]): Promise<boolean> {
	const sha = await refHead(app, token, owner, repo, base);
	const root = "/repos/" + owner + "/" + repo;
	const auth = { bearer: token };
	const missing = new Set(branches);
	for (let page = 1; ; page++) {
		const list = await app.call({ path: root + "/actions/workflows", auth, query: { per_page: 100, page }, what: "list enabled CI workflows" });
		for (const workflow of (record(list.body).workflows as {path: string; state: string}[])) {
			if (workflow.state !== "active" || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflow.path)) continue;
			let source: string;
			try { source = await app.fileAt(token, owner, repo, workflow.path, sha); }
			catch (error) { if (error instanceof GithubError && error.status === 404) continue; throw error; }
			for (const branch of missing) if (workflowReportsPush(source, branch)) missing.delete(branch);
			if (!missing.size) return true;
		}
		if (!list.next) break;
	}
	// External CI has no GitHub Actions workflow. Look for a report on a standalone Windlass
	// push. A default-branch status or a run associated with a PR cannot establish that.
	const refs = await app.call({ path: root + "/git/matching-refs/heads/windlass/", auth, what: "look for previous Windlass pushes" });
	for (const ref of (refs.body as {ref: string; object: {sha: string}}[]).slice(-8)) {
		const head = ref.object.sha;
		if (!/^[0-9a-f]{40}$/.test(head) || head === sha) continue;
		const path = root + "/commits/" + head;
		const pulls = await app.call({ path: path + "/pulls", auth, what: "check for pull-request-only CI" });
		if (!Array.isArray(pulls.body) || pulls.body.length) continue;
		const checks = await app.call({ path: path + "/check-runs", auth, what: "look for external push checks" });
		const runs = record(checks.body).check_runs as {app?: {id?: unknown; slug?: string}; conclusion?: string}[];
		if (runs.some(r => r.app?.slug && r.app.slug !== "github-actions" && !ownApp(r.app, app.settings) && r.conclusion === "success")) return true;
		const status = await app.call({ path: path + "/status", auth, what: "look for external push statuses" });
		if ((record(status.body).statuses as {state: string}[]).some(s => s.state === "success")) return true;
	}
	return false;
}
