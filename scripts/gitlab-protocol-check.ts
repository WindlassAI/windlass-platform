/** Exercise the GitLab code-host boundary over loopback HTTP, with no live GitLab credentials.
 * Run: cd server && npx tsx ../scripts/gitlab-protocol-check.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ciState } from "../server/src/codehost/ci.js";
import { GITLAB_WEBHOOK_PATH, MAX_WEBHOOK_BYTES, type GitlabDelivery } from "../server/src/gitlab/webhook.js";

import { GitlabStandin } from "./gitlab-standin.js";
import { GitlabApp, GitlabError, challengeOf, newVerifier } from "../server/src/gitlab/app.js";
import { gitlabCodeHost } from "../server/src/gitlab/host.js";

const run = promisify(execFile);

/** Exercise upload-pack and receive-pack without putting credentials in argv or the remote URL. */
async function pushBranch(cloneUrl: string, pushUrl: string, token: string, branch: string) {
	const home = await mkdtemp(join(tmpdir(), "gitlab-protocol-"));
	try {
		const askpass = join(home, "askpass");
		await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) echo oauth2;; *) printf "%s\\n" "$TEST_GIT_TOKEN";; esac\n', { mode: 0o700 });
		const env = { PATH: process.env.PATH, LC_ALL: "C", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, TEST_GIT_TOKEN: token };
		const work = join(home, "work");
		const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env, timeout: 30_000 })).stdout.trim();
		for (const url of [cloneUrl, pushUrl]) {
			assert.equal(new URL(url).hostname, "127.0.0.1");
			assert.ok(!new URL(url).username && !new URL(url).password && !url.includes(token));
		}
		await git(home, "clone", cloneUrl, work);
		await git(work, "checkout", "-b", branch);
		await git(work, "-c", "user.name=Protocol Check", "-c", "user.email=check@example.invalid", "commit", "--allow-empty", "-m", "Protocol check");
		const head = await git(work, "rev-parse", "HEAD");
		await git(work, "push", pushUrl, `HEAD:refs/heads/${branch}`);
		assert.equal(await git(work, "ls-remote", cloneUrl, `refs/heads/${branch}`), `${head}\trefs/heads/${branch}`);
		return head;
	} finally { await rm(home, { recursive: true, force: true }); }
}

async function hookReceiver(route: (request: Request) => Promise<Response | null>) {
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
			const response = await route(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }));
			res.writeHead(response?.status ?? 404).end(await response?.text());
		} catch { res.writeHead(500).end(); }
	});
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${GITLAB_WEBHOOK_PATH}`,
		close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
	};
}

const fixture = await GitlabStandin.start({ pageSize: 1 });
try {
	const app = new GitlabApp({ clientId: fixture.clientId, baseUrl: fixture.url, redirectUrl: fixture.redirectUrl }, { clientSecret: () => fixture.clientSecret });
	const verifier = newVerifier(), state = randomUUID();
	async function authorize() {
		const redirect = await fetch(app.authorizeUrl(state, challengeOf(verifier)), { redirect: "manual" });
		assert.equal(redirect.status, 302);
		const callback = new URL(redirect.headers.get("location")!);
		assert.equal(callback.searchParams.get("state"), state);
		return callback.searchParams.get("code")!;
	}
	const denied = (e: unknown) => e instanceof GitlabError && [400, 401, 403].includes(e.status);
	await assert.rejects(app.exchangeCode(await authorize(), newVerifier()), denied);
	const code = await authorize(), grant = await app.exchangeCode(code, verifier);
	assert.ok(grant.refreshToken && grant.expiresAt && grant.expiresAt > Date.now() && grant.scopes.includes("api"));
	await assert.rejects(app.exchangeCode(code, verifier), denied);
	const fresh = await app.refresh(grant.refreshToken);
	assert.ok(fresh.accessToken !== grant.accessToken && fresh.refreshToken && fresh.refreshToken !== grant.refreshToken);
	await assert.rejects(app.refresh(grant.refreshToken), denied);
	await assert.rejects(app.call({ path: "/user", token: grant.accessToken }), denied);
	const token = fresh.accessToken;
	assert.deepEqual(await app.viewer(token), { id: fixture.user.id, login: fixture.user.username, name: fixture.user.name });
	console.log("ok  OAuth PKCE, one-use code and refresh-token rotation");

	const projectId = "9007199254740993";
	const owner = "windlass/subgroup", name = "harbor", branch = "docs/guide";
	const other = fixture.addProject({ owner: "other", name });
	other.archived = true;
	const hidden = fixture.addProject({ owner, name: "restricted", accessible: false });
	const project = fixture.addProject({ owner, name, defaultBranch: "trunk", id: BigInt(projectId) });
	const connection = { id: 71, accessToken: async () => token };
	const received: GitlabDelivery[] = [];
	const host = gitlabCodeHost(app, connection, { projectId, secret: fixture.webhookSecret, dispatch: async delivery => { received.push(delivery); } });
	const list = await host.listRepositories(connection, "");
	const repo = list.repositories.find(r => r.id === projectId);
	assert.ok(repo && repo.owner === owner && repo.name === name && repo.private && repo.canPush && repo.defaultBranch === "trunk");
	assert.ok(list.repositories.some(r => String(r.id) === String(other.id) && !r.canPush));
	assert.ok(!list.repositories.some(r => String(r.id) === String(hidden.id)));
	await assert.rejects(app.call({ path: `/projects/${hidden.id}`, token }), (e: unknown) => e instanceof GitlabError && e.status === 404);
	const hiddenGit = await fetch(host.cloneUrl(owner, hidden.name) + "/info/refs?service=git-upload-pack", { headers: { authorization: "Basic " + Buffer.from("oauth2:" + token).toString("base64") } });
	assert.equal(hiddenGit.status, 404);
	const target = { owner, name, installationId: connection.id, repositoryId: projectId };
	let entered = false;
	await assert.rejects(host.withToken({ ...target, repositoryId: String(other.id) }, "push", async () => { entered = true; }));
	await assert.rejects(host.withToken({ ...target, installationId: "999" }, "clone", async () => { entered = true; }));
	assert.equal(entered, false);
	const head = await host.withToken(target, "push", t => pushBranch(host.cloneUrl(owner, name), host.pushUrl(owner, name), t, branch));
	assert.equal(fixture.branchHead(project, branch), head);
	console.log("ok  paged project discovery, large project ID, project access and authenticated smart HTTP clone/push");

	const input = { title: "Add guide", body: "A new guide", head: branch, base: project.defaultBranch };
	const mr = await host.openPull(token, owner, name, input);
	assert.equal(mr.state, "open");
	assert.equal(mr.headSha, head);
	assert.equal(mr.baseSha, fixture.branchHead(project, project.defaultBranch));
	assert.equal(mr.number, project.mergeRequests[0].iid);
	assert.equal((await host.readPull(token, owner, name, mr.number)).head, branch);
	const edited = await host.updatePull(token, owner, name, mr.number, { title: "Guide", body: "Updated guide" });
	assert.equal(edited.title, "Guide");
	assert.equal(edited.body, "Updated guide");
	const note = await host.createComment(token, owner, name, mr.number, "Original note");
	assert.ok(note);
	assert.equal(note, `${mr.number}:${project.mergeRequests[0].notes[0].id}`);
	await host.updateComment(token, owner, name, note, "Edited note");
	assert.ok((await host.listComments(token, owner, name, mr.number, true)).some(n => n.id === note && n.body === "Edited note"));
	await host.react(token, { owner, name }, { kind: "issue", id: "1" }, "eyes");
	await host.react(token, { owner, name }, { kind: "issue_comment", id: "1:42" }, "eyes");
	assert.ok([...fixture.reactions].some(path => path.endsWith("/issues/1/award_emoji:eyes")));
	assert.ok([...fixture.reactions].some(path => path.endsWith("/issues/1/notes/42/award_emoji:eyes")));
	console.log("ok  merge request create/read/update, scoped notes and issue reactions");

	const pipe = fixture.addPipeline(project, head, branch, "failed");
	const job = fixture.addJob(project, pipe, "guide/test", "failed", `The guide check failed\n${token}\n`);
	const ciTarget = { ...target, head };
	const restrictedUrl = new URL(app.authorizeUrl(state, challengeOf(verifier)));
	restrictedUrl.searchParams.set("scope", "read_user");
	const restrictedCode = new URL(fixture.authorize(restrictedUrl.href)).searchParams.get("code")!;
	const restricted = await app.exchangeCode(restrictedCode, verifier);
	const restrictedHost = gitlabCodeHost(app, { ...connection, accessToken: async () => restricted.accessToken });
	assert.equal((await restrictedHost.readCi(ciTarget)).kind, "not_permitted");
	await assert.rejects(host.createComment(restricted.accessToken, owner, name, mr.number, "Forbidden"), (e: unknown) => e instanceof GitlabError && e.status === 403);
	const ci = await host.readCi(ciTarget);
	assert.equal(ci.kind, "read");
	assert.equal(ci.head, head);
	const failed = ci.runs.find(r => r.jobId === String(job.id));
	assert.ok(failed && failed.state === "failed" && failed.name === job.name);
	assert.ok((await (await host.jobLog(token, owner, name, String(job.id))).text()).includes("guide check failed"));
	const log = ci.logs.find(l => l.name === job.name);
	assert.ok(log?.text?.includes("guide check failed") && log.untrusted && !log.text.includes(token));
	const stale = await host.rerunJobs({ ...ciTarget, head: mr.baseSha }, [{ name: job.name, jobId: String(job.id), retryRunId: String(pipe.id), failed: true }]);
	assert.deepEqual(stale.accepted, []);
	const retry = await host.rerunJobs(ciTarget, [{ name: job.name, jobId: String(job.id), retryRunId: String(pipe.id), failed: true }]);
	assert.ok(retry.accepted.length && fixture.retries.includes(String(job.id)));
	const replacement = project.jobs.find(j => j.pipeline === pipe && !j.retried);
	assert.ok(replacement && replacement.id !== job.id);
	pipe.status = "running";
	assert.equal(ciState(await host.readCi(ciTarget)), "pending");
	pipe.status = replacement.status = "success";
	assert.equal(ciState(await host.readCi(ciTarget)), "passed");
	console.log("ok  CI results for the pushed SHA, job trace and retry to a green pipeline");

	await assert.rejects(host.mergePull(token, owner, name, mr.number, "1".repeat(40), mr.title));
	await host.mergePull(token, owner, name, mr.number, head, mr.title);
	assert.equal((await host.readPull(token, owner, name, mr.number)).state, "merged");
	const nextBranch = "docs/follow-up";
	fixture.commit(project, nextBranch, { "follow-up": "x" }, "Follow up", project.defaultBranch);
	const next = await host.openFromPushed({ connection, repository: { id: projectId, branch: project.defaultBranch, closesIssue: 5 },
		branch: nextBranch, message: input, evidence: { verified: null, during: null, checks: [], redact: s => s } });
	assert.match((await host.readPull(token, owner, name, next.number)).body, /Closes #5/);
	await host.closePull(token, owner, name, next.number);
	assert.equal((await host.readPull(token, owner, name, next.number)).state, "closed");
	console.log("ok  merge guarded by head SHA and close without merging");

	const receiver = await hookReceiver(req => host.webhookRoute(req));
	try {
		const hookId = await app.projectHook(token, projectId, receiver.url, fixture.webhookSecret);
		const hook = fixture.hooks.find(h => String(h.id) === hookId);
		assert.ok(hook && String(hook.projectId) === projectId && hook.url === receiver.url && hook.token === fixture.webhookSecret);
		const base = { project: { id: project.id }, user: { id: 9007199254740995n } };
		const issue = { iid: 4, title: "Guide request", description: "Untrusted issue description" };
		const attr = { id: 9007199254740997n, noteable_type: "Issue", action: "create", note: "/windlass fix the guide" };
		const payload = { ...base, object_kind: "note", issue, object_attributes: attr };
		const guid = randomUUID();
		assert.equal((await fixture.deliver(receiver.url, "Note Hook", payload, { secret: "wrong" })).status, 401);
		assert.equal((await fixture.deliver(receiver.url, "Note Hook", { ...payload, project: { id: other.id } })).status, 403);
		assert.equal((await fixture.deliverHook(hookId, "Note Hook", payload, { omitToken: true })).status, 401);
		assert.equal((await fetch(receiver.url, { method: "POST", body: "garbage" })).status, 401);
		assert.equal((await fetch(receiver.url, { method: "POST", headers: { "x-gitlab-token": fixture.webhookSecret, "x-gitlab-event-uuid": guid }, body: "garbage" })).status, 400);
		assert.equal((await fetch(receiver.url, { method: "POST", body: "x".repeat(MAX_WEBHOOK_BYTES + 1) })).status, 413);
		for (const change of [{ action: "update" }, { system: true }, { note: "unrelated discussion" }, { note: "/windlass feature build it" }, { noteable_type: "MergeRequest" }]) {
			assert.ok((await fixture.deliver(receiver.url, "Note Hook", { ...payload, merge_request: issue, object_attributes: { ...attr, ...change } })).ok);
		}
		const labelled = [{ title: "windlass" }];
		const issueEdit = { ...base, object_kind: "issue", object_attributes: { ...issue, action: "update" }, labels: labelled };
		for (const changes of [{}, { labels: { previous: labelled, current: [] } }, { labels: { previous: labelled, current: labelled } }]) {
			assert.ok((await fixture.deliver(receiver.url, "Issue Hook", { ...issueEdit, changes })).ok);
		}
		assert.equal(received.length, 0);
		assert.ok((await fixture.deliverHook(hookId, "Note Hook", payload, { guid })).ok);
		const note = received.at(-1);
		assert.deepEqual(note, { guid, projectId, event: "note", target: "issue", iid: issue.iid, senderId: "9007199254740995", noteId: "9007199254740997", body: attr.note, title: issue.title, description: issue.description });
		assert.ok((await fixture.deliver(receiver.url, "Issue Hook", { ...issueEdit, changes: { labels: { previous: [], current: labelled } } })).ok);
		const gained = received.at(-1);
		assert.ok(gained?.event === "issue" && gained.action === "update" && gained.description === issue.description && gained.title === issue.title);
		assert.deepEqual(gained.addedLabels, ["windlass"]);
		assert.ok((await fixture.deliver(receiver.url, "Issue Hook", { ...issueEdit, object_attributes: { ...issue, action: "open" } })).ok);
		assert.ok((await fixture.deliver(receiver.url, "Merge Request Hook", { ...base, object_kind: "merge_request", object_attributes: { iid: mr.number, action: "merge", last_commit: { id: head } } })).ok);
		assert.ok((await fixture.deliver(receiver.url, "Pipeline Hook", { ...base, object_kind: "pipeline", object_attributes: { id: pipe.id, status: "failed", sha: head } })).ok);
		assert.deepEqual(received.map(d => d.event), ["note", "issue", "issue", "merge_request", "pipeline"]);
	} finally { await receiver.close(); }
	console.log("ok  real HTTP hook delivery authenticates, filters projects and retains exact database IDs");
	// Providers and reverse proxies can echo credentials in errors, or send non-JSON with a 200.
	// Neither the HTTP diagnostic, JSON.parse's snippet nor the request path may escape.
	const sensitive = [token, fresh.refreshToken, fixture.clientSecret, fixture.webhookSecret, code, verifier, "private-repository-content"];
	let status = 403;
	const echo = await hookReceiver(async () => new Response(sensitive.join("\n"), { status }));
	try {
		const hostile = new GitlabApp({ ...app.settings, baseUrl: new URL(echo.url).origin }, { clientSecret: () => fixture.clientSecret });
		async function sanitizedFailure(step: () => Promise<unknown>) {
			let thrown: unknown;
			try { await step(); } catch (error) { thrown = error; }
			assert.ok(thrown instanceof Error, "expected a GitLab error");
			assert.ok(sensitive.every(s => !thrown.message.includes(s)), "a credential or private diagnostic escaped in an error");
		}
		await sanitizedFailure(() => hostile.exchangeCode(code, verifier));
		await sanitizedFailure(() => hostile.refresh(fresh.refreshToken!));
		await sanitizedFailure(() => hostile.projectHook(token, projectId, echo.url, fixture.webhookSecret));
		status = 200;
		await sanitizedFailure(() => hostile.call({ method: "POST", path: `/projects/${token}/notes`, token }));
	} finally { await echo.close(); }
	console.log("ok  upstream errors and malformed JSON never expose credentials or private diagnostics");
	await app.revoke(token);
	await assert.rejects(app.viewer(token), denied);
} finally { await fixture.stop(); }
