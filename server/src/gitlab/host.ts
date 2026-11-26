import type { GithubId, GithubRepository } from "../contract.js";
import { JOB_READS_PER_READING, LOG_MAX_BYTES, LOGS_PER_READING, logTail, type CiLog, type CiReading, type CiRun, type CiTarget } from "../codehost/ci.js";
import type { CodeHost, Pull } from "../codehost/types.js";
import { redact } from "../github/redact.js";
import { verifiedWords } from "../verified.js";
import { GitlabApp, GitlabError, record as obj, text } from "./app.js";
import { decimalId, gitlabId } from "./ids.js";
import { gitlabWebhookRoute, parseGitlabWebhook, type GitlabDelivery, type GitlabWebhookBinding } from "./webhook.js";

/** The owner supplies a current OAuth token, refreshing and persisting it outside the adapter. */
export interface GitlabConnection { id: GithubId; project?: Pick<GithubRepository, "id" | "owner" | "name">; accessToken(): Promise<string> }
export interface GitlabRepository { id: GithubId; branch: string; closesIssue?: number }
export interface GitlabHook extends GitlabWebhookBinding { dispatch?(delivery: GitlabDelivery): Promise<void> }
type Host = CodeHost<GitlabConnection, GitlabRepository, GitlabDelivery>;

function id(v: unknown): string {
	const value = decimalId(v);
	if (!value) throw new Error("Invalid GitLab identifier.");
	return value;
}
function parsePull(body: unknown): Pull {
	const mr = obj(body), refs = obj(mr.diff_refs), number = Number(id(mr.iid));
	if (!Number.isSafeInteger(number) || !["opened", "closed", "merged", "locked"].includes(text(mr.state))) throw new Error("Invalid GitLab merge request.");
	return {
		number, url: text(mr.web_url), title: text(mr.title), body: text(mr.description),
		state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : mr.draft ? "draft" : "open",
		mergeable: mr.detailed_merge_status === "mergeable" ? true : mr.has_conflicts === true || mr.detailed_merge_status === "conflict" ? false : null,
		head: text(mr.source_branch), headSha: text(mr.sha) || text(refs.head_sha), base: text(mr.target_branch), baseSha: text(refs.start_sha), mergeBaseSha: text(refs.base_sha),
		requestedReviewers: Array.isArray(mr.reviewers) ? mr.reviewers.map(r => text(obj(r).username)).filter(Boolean) : [],
	};
}
function repository(body: unknown): GithubRepository {
	const p = obj(body), path = text(p.path_with_namespace).split("/"), name = path.pop(), projectId = gitlabId(p.id);
	if (!projectId || !path.length || !name) throw new Error("Invalid GitLab project.");
	const perms = obj(p.permissions), last = Date.parse(text(p.last_activity_at));
	return { id: projectId, owner: path.join("/"), name, defaultBranch: text(p.default_branch) || "main", private: p.visibility !== "public",
		canPush: !p.archived && Math.max(Number(obj(perms.project_access).access_level ?? 0), Number(obj(perms.group_access).access_level ?? 0)) >= 30, pushedAt: Number.isFinite(last) ? last : null };
}

function state(status: unknown): CiRun["state"] {
	switch (status) {
		case "success": return "passed";
		case "failed": return "failed";
		case "canceled": return "cancelled";
		case "skipped": return "neutral";
		default: return "pending";
	}
}

async function failureLog(app: GitlabApp, token: string, target: CiTarget, run: CiRun): Promise<CiLog> {
	const base = { name: run.name, untrusted: true as const };
	try {
		const reader = (await app.jobTrace(token, target.repositoryId, run.jobId!)).body?.getReader();
		if (reader) {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return { ...base, ...logTail(redact(Buffer.concat(chunks, size).toString("utf8"), [token]), false) };
				size += value.byteLength;
				if (size > LOG_MAX_BYTES) { await reader.cancel(); break; }
				chunks.push(value);
			}
		}
	} catch { /* Never return an upstream diagnostic or a credential. */ }
	return { ...base, text: null, why: "The GitLab job trace could not be read." };
}

/** The latest pipeline for this commit/ref. The pipeline verdict matters too (e.g. downstream jobs). */
async function readPipeline(app: GitlabApp, token: string, target: CiTarget, branch?: string, skipLogs = false): Promise<CiReading> {
	const list = await app.pipelines(token, target.repositoryId, target.head, branch);
	if (!Array.isArray(list)) throw new Error("Invalid GitLab pipeline list.");
	const runs: CiRun[] = [], logs: CiLog[] = [];
	const reading = { kind: "read" as const, head: target.head, runs, logs, truncated: false };
	if (!list.length) return reading;
	const pipe = obj(list[0]), pipelineId = id(pipe.id);
	if (pipe.sha !== target.head) throw new Error("GitLab pipeline head changed.");
	const jobs = await app.pipelineJobs(token, target.repositoryId, pipelineId, JOB_READS_PER_READING + 1);
	if (!Array.isArray(jobs.body)) throw new Error("Invalid GitLab jobs list.");
	reading.truncated = jobs.body.length > JOB_READS_PER_READING || !!jobs.headers.get("x-next-page");
	for (const value of jobs.body.slice(0, JOB_READS_PER_READING)) {
		const job = obj(value), status = text(job.status), jobState = state(status);
		const optional = job.allow_failure === true && ["failed", "manual", "canceled"].includes(status);
		const run: CiRun = { app: "gitlab-ci", name: text(job.name), state: optional ? "neutral" : jobState, conclusion: status === "failed" ? "failure" : status,
			url: text(job.web_url), summary: "", jobId: id(job.id), workflowId: pipelineId, retryRunId: pipelineId };
		if (job.failure_reason === "runner_system_failure") run.environment = true;
		runs.push(run);
		if (!skipLogs && run.state === "failed" && logs.length < LOGS_PER_READING) logs.push(await failureLog(app, token, target, run));
	}
	const pipelineState = state(pipe.status);
	if (!runs.length || (pipelineState !== "passed" && !runs.some(r => r.state === pipelineState))) {
		runs.push({ name: "Pipeline", app: "gitlab-ci", state: pipelineState, conclusion: text(pipe.status), url: text(pipe.web_url), summary: "", jobId: null });
	}
	const since = Date.parse(text(pipe.created_at));
	return { ...reading, ...(pipelineState === "pending" && Number.isFinite(since) && { inProgressSince: since }) };
}

/** GitLab's notes are addressed by their parent IID *and* note ID, unlike GitHub's. */
function noteIds(key: string): [string, string] {
	const parts = key.split(":");
	if (parts.length !== 2) throw new Error("Invalid GitLab note reference.");
	return [id(parts[0]), id(parts[1])];
}

export function gitlabCodeHost(app: GitlabApp, connection: GitlabConnection, hook?: GitlabHook): Host {
	function projectKey(owner: string, name: string) {
		const project = connection.project;
		if (!project) return `${owner}/${name}`;
		if (project.owner !== owner || project.name !== name) throw new Error("GitLab project does not match.");
		return id(project.id);
	}
	function checkConnection(key: GithubId) {
		if (id(key) !== id(connection.id)) throw new Error("GitLab connection does not match.");
	}
	const withToken: Host["withToken"] = async (target, _access, step) => {
		checkConnection(target.installationId);
		if (connection.project && id(target.repositoryId) !== id(connection.project.id)) throw new Error("GitLab project does not match.");
		if (hook && id(target.repositoryId) !== id(hook.projectId)) throw new Error("GitLab project does not match.");
		return step(await connection.accessToken());
	};
	const open = async (token: string, project: string, input: Parameters<Host["openPull"]>[3]) => parsePull(await app.openMr(token, project, {
		title: input.draft ? `Draft: ${input.title}` : input.title, description: input.body, source_branch: input.head, target_branch: input.base,
	}));
	return {
		cloneUrl: app.cloneUrl.bind(app), pushUrl: app.cloneUrl.bind(app), withToken,
		openPull: (token, owner, name, input) => open(token, projectKey(owner, name), input),
		async openFromPushed(input) {
			if (!input.connection) throw new Error("GitLab is not connected.");
			const repo = input.repository, footer = repo.closesIssue ? `\n\nCloses #${id(repo.closesIssue)}` : "";
			const pull = await withToken({ installationId: input.connection.id, repositoryId: repo.id }, "pull:write", async token => {
				// Recover both a previous run's MR and a POST whose reply was lost. Forks may reuse branch names.
				const query = new URLSearchParams({ state: "opened", source_branch: input.branch, target_branch: repo.branch });
				const response = await app.call({ token, path: `/projects/${id(repo.id)}/merge_requests?${query}` });
				if (!Array.isArray(response.body)) throw new Error("Invalid GitLab merge request list.");
				const prior = response.body.map(obj).find(mr => decimalId(mr.source_project_id) === id(repo.id) && decimalId(mr.target_project_id) === id(repo.id) && mr.source_branch === input.branch && mr.target_branch === repo.branch);
				return prior ? parsePull(prior) : open(token, id(repo.id), { title: input.message.title, body: input.message.body + footer, head: input.branch, base: repo.branch });
			});
			return { number: pull.number, url: pull.url, state: pull.state, title: pull.title, branch: pull.head, base: pull.base, pushedAt: Date.now(), verified: verifiedWords(input.evidence.verified, [], input.evidence.during) };
		},
		async readPull(token, owner, name, n) { return parsePull(await app.readMr(token, projectKey(owner, name), n)); },
		async updatePull(token, owner, name, n, input) {
			return parsePull(await app.updateMr(token, projectKey(owner, name), n, { title: input.title, description: input.body }));
		},
		async mergePull(token, owner, name, n, head, title) {
			if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("Invalid GitLab merge head.");
			await app.mergeMr(token, projectKey(owner, name), n, head, title);
		},
		async closePull(token, owner, name, n) { await app.updateMr(token, projectKey(owner, name), n, { state_event: "close" }); },
		async readCi(target, options) {
			try { return await withToken(target, "log:read", token => readPipeline(app, token, target, options?.branch, options?.baseResultsOnly)); }
			catch (error) {
				if (error instanceof GitlabError && [401, 403].includes(error.status)) return { kind: "not_permitted", said: "GitLab did not allow reading CI." };
				if (error instanceof GitlabError && error.status === 429) return { kind: "rate_limited", retryAt: error.retryAt || Date.now() + 60_000, said: "GitLab CI reads are rate limited." };
				return { kind: "failed", said: "GitLab CI could not be read." };
			}
		},
		jobLog: (token, owner, name, jobId) => app.jobTrace(token, projectKey(owner, name), jobId),
		async rerunJobs(target, jobs) {
			const accepted: string[] = [];
			try {
				await withToken(target, "pull:write", async token => {
					const reading = await readPipeline(app, token, target, undefined, true);
					if (reading.kind !== "read") return;
					for (const run of reading.runs) {
						if (!run.jobId || !["failed", "cancelled"].includes(run.state) || !jobs.some(j => j.jobId === run.jobId && j.retryRunId === run.workflowId)) continue;
						await app.retryJob(token, target.repositoryId, run.jobId);
						accepted.push(run.jobId);
					}
				});
			} catch { /* Return only the jobs GitLab accepted. */ }
			return { accepted, said: accepted.length === jobs.length ? "Requested the GitLab job retries." : "Some GitLab jobs could not be retried." };
		},
		async listRepositories(c, query) {
			checkConnection(c.id);
			const list = await app.projects(await connection.accessToken(), query);
			return { repositories: list.items.map(repository), more: list.truncated, incomplete: false };
		},
		async listComments(token, owner, name, n, requireComplete, since) {
			const list = await app.notes(token, projectKey(owner, name), "merge_requests", n);
			if (requireComplete && list.truncated) throw new Error("Incomplete GitLab note listing.");
			return list.items.map(obj).filter(note => !note.system && (!since || Date.parse(text(note.updated_at)) >= since)).map(note => {
				const author = obj(note.author), personId = gitlabId(author.id), login = text(author.username);
				return { id: `${n}:${id(note.id)}`, body: text(note.body), author: login, person: personId && login ? { id: personId, login } : null, association: "NONE" };
			});
		},
		async createComment(token, owner, name, n, body) {
			const note = await app.createNote(token, projectKey(owner, name), "merge_requests", n, body);
			return `${n}:${id(obj(note).id)}`;
		},
		async updateComment(token, owner, name, key, body) {
			await app.updateNote(token, projectKey(owner, name), "merge_requests", ...noteIds(key), body);
		},
		async react(token, repo, target) {
			const project = projectKey(repo.owner, repo.name);
			if (target.kind === "issue") await app.eyes(token, project, "issues", id(target.id));
			else await app.eyes(token, project, target.kind === "review_comment" ? "merge_requests" : "issues", ...noteIds(target.id));
		},
		parseWebhook(headers, bytes) {
			if (!hook) throw new Error("GitLab webhook is not configured.");
			return parseGitlabWebhook(headers, bytes, hook);
		},
		webhookRoute: hook?.dispatch ? gitlabWebhookRoute(hook, hook.dispatch) : async () => null,
	};
}
