/** Run from server: npx tsx ../scripts/jira-check.ts. All provider traffic stays on loopback. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localListeners, portFree } from "./check-listeners.js";
import { GithubStandin } from "./github-standin.js";
import { pollUntil, readProvenance } from "./issue-intake-fixture.js";
import { JiraStandin } from "./jira-standin.js";
import { loginHttp } from "./login-http.js";

const origin = "http://127.0.0.1:5173";
const until = pollUntil(45_000);

type ItemContext = Parameters<typeof readProvenance>[0];
interface ItemProbe {
	checkProvenance(): ReturnType<typeof readProvenance>;
	checkFiledReceipt(): Promise<boolean>;
}

async function testNode() {
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	Object.assign(CI_POLLING, { everyMs: 250, crowdedEveryMs: 250, prEveryMs: 250, webhookEveryMs: 250, webhookCrowdedEveryMs: 250, webhookPrEveryMs: 250, noneAfterMs: 0 });
	const { JiraApp, JiraError } = await import("../server/src/jira/app.js");
	const comment = JiraApp.prototype.comment;
	let loseReply = process.env.JIRA_CHECK_LOSE_REPLY === "1";
	JiraApp.prototype.comment = async function(...args) {
		const answer = await comment.apply(this, args);
		if (loseReply) { loseReply = false; throw new JiraError(0, "receive comment reply"); }
		return answer;
	};
	const { workItem } = await import("../server/src/actors/work-item.js");
	const { requireServiceFor } = await import("../server/src/auth.js");
	Object.assign(workItem.config.actions!, {
		checkFiledReceipt: async (c: ItemContext) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM issue_actions WHERE subject='jira_comment:filed'")).length === 1;
		},
		checkProvenance: async (c: ItemContext) => {
			requireServiceFor(c, "call");
			return readProvenance(c);
		},
	});
	await import("../server/src/index.js");
}

async function run() {
	const { engine, http: [port] } = await localListeners();
	const api = `http://127.0.0.1:${port}`;
	const jira = await JiraStandin.start({ redirectUri: `${api}/jira/callback` });
	const github = new GithubStandin({ callbackUrl: `${api}/github/callback`, strictBranches: false });
	await github.start();
	const storage = mkdtempSync(join(tmpdir(), "jira-check-"));
	Object.assign(process.env, github.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"), WLP_SANDBOX: "fake", WLP_DEMO: "1", WLP_ITEMS: "1",
		WLP_FAKE_DELAY_MS: "10", WLP_MAX_KEPT_SANDBOXES: "unlimited", WLP_FACTORY_GITHUB_ITEMS_PER_DAY: "20",
		WLP_HTTP_PORT: String(port), WLP_WEB_ORIGINS: origin, WLP_PUBLIC_URL: api,
		WLP_JIRA_CLIENT_ID: jira.clientId, WLP_JIRA_CLIENT_SECRET: jira.clientSecret,
		WLP_JIRA_AUTH_URL: jira.url, WLP_JIRA_API_URL: jira.url, WLP_JIRA_REDIRECT_URL: jira.redirectUri,
		RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(engine), RIVET_LOG_LEVEL: "silent",
	});
	for (const key of ["RIVET_ENDPOINT", "RIVET_ADMIN_TOKEN", "RIVET_ENGINE", "PORT", "WLP_FACTORY_ORCHESTRATE"]) delete process.env[key];
	let child: ChildProcess | undefined;
	async function start(loseReply: boolean) {
		const node = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
			cwd: fileURLToPath(new URL("../server", import.meta.url)), stdio: "ignore", env: { ...process.env, JIRA_CHECK_LOSE_REPLY: loseReply ? "1" : "0" },
		});
		child = node;
		await until("platform startup", async () => {
			if (node.exitCode !== null || node.signalCode !== null) throw new Error(`platform exited: ${node.exitCode ?? node.signalCode}`);
			return (await fetch(`${api}/platform/info`).catch(() => null))?.ok;
		}, 90_000);
	}
	async function stop() {
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
			child.kill("SIGTERM"); const guard = setTimeout(() => child?.kill("SIGKILL"), 10_000);
			await exited; clearTimeout(guard);
		}
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch { /* Engine already exited. */ }
		await until("released platform ports", async () => await portFree(engine) && await portFree(port));
	}
	try {
		await start(true);
		const { createClient } = await import("../server/src/client.js");
		const { serviceParams } = await import("../server/src/auth.js");
		const client = createClient<import("../server/src/registry.js").Registry>({ endpoint: `http://127.0.0.1:${engine}` });
		const auth = await loginHttp(api).demo();
		const owner = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
		const login = "jira-check"; github.addUser(login);
		const installation = github.addInstallation(login, "User");
		const repo = github.addRepository({ owner: login, name: "factory", installation });
		Object.assign(github.appPermissions, { checks: "read", statuses: "read", actions: "read", issues: "write" });
		const gh = await fetch(github.authorize(login, (await owner.githubConnect({ origin })).url), { redirect: "manual" });
		await owner.githubComplete(new URL(gh.headers.get("location")!).hash.slice("#github=".length));
		const callback = await jira.authorize((await owner.jiraConnect({ origin })).url);
		const landing = await fetch(callback, { redirect: "manual" });
		await owner.jiraComplete(new URL(landing.headers.get("location")!).hash.slice("#jira=".length));
		const eng = jira.addProject("ENG"), ops = jira.addProject("OPS");
		await owner.jiraSelectSite(jira.site.id);
		await owner.saveJiraMapping({ siteId: jira.site.id, projectId: eng.id, repositoryId: repo.id });
		const [hook] = jira.hooks.values(); assert.ok(hook);
		type Issue = ReturnType<typeof jira.createIssue>;
		const created = (issue: Issue) => ({ webhookEvent: "jira:issue_created", timestamp: Date.now(), matchedWebhookIds: [hook.id], issue: structuredClone(issue), user: jira.myself });
		const updated = (issue: Issue, change: object) => ({ ...created(issue), webhookEvent: "jira:issue_updated", changelog: { items: [change] } });
		const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
		const post = async (payload: object, id = randomUUID(), valid = true) => {
			const jwt = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ aud: jira.clientId, exp: Math.floor(Date.now() / 1000) + 60 })}`;
			const sig = createHmac("sha256", valid ? jira.clientSecret : "wrong-key").update(jwt).digest("base64url");
			const response = await fetch(hook.url, { method: "POST", headers: { authorization: `Bearer ${jwt}.${sig}`, "x-atlassian-webhook-identifier": id, "content-type": "application/json" }, body: JSON.stringify(payload) });
			assert.equal(response.status, valid ? 202 : 401);
			return (await response.json()).taken;
		};
		const make = (title: string, labels: string[], project = eng) => {
			const issue = jira.createIssue(project, title, "Print a short greeting."); issue.fields.labels = labels; return issue;
		};
		const labelled = make("Title from Jira", ["windlass"]);
		const labelChange = { field: "labels", fromString: "", toString: "windlass" };
		const event = updated(labelled, labelChange); event.issue.fields.summary = "Unverified event title";
		const delivery = randomUUID();
		await post(event, delivery, false);
		assert.equal(await post({ ...event, issue: { ...event.issue, self: "https://other.atlassian.net/rest/api/3/issue/1" } }), false);
		assert.equal(await post(created(make("Unmapped", ["windlass"], ops))), false);
		assert.equal(await post(updated(labelled, { field: "summary", fromString: "old", toString: "new" })), false);
		const stale = make("Removed label", ["windlass"]), lapsed = updated(stale, labelChange);
		stale.fields.labels = []; assert.equal(await post(lapsed), false);
		assert.equal((await owner.listItems()).length, 0); assert.equal(jira.comments.size, 0);
		console.log("PASS invalid verification, wrong site, unmapped project, unrelated edit and lapsed label");

		const probe = (id: string) => client.workItem.get([auth.profile.uid, id], { params: serviceParams() }) as unknown as ItemProbe;
		const draft = async (issue: Issue, mode: "single" | "orchestrate", via: "assignment" | "label") => {
			const rows = (await owner.listItems()).filter(i => i.origin?.jira?.id === issue.id);
			assert.equal(rows.length, 1, issue.key); const [item] = rows;
			assert.equal(item.source, "jira"); assert.equal(item.repository.id, repo.id);
			assert.equal(item.mode, mode); assert.equal(item.state, "draft");
			assert.equal(item.origin?.jira?.trusted, false); assert.equal(item.origin?.jira?.url, `${jira.site.url}/browse/${issue.key}`);
			const view = await owner.item(item.id); assert.equal(view.run, null);
			assert.match(view.task.body, /> Print a short greeting\./);
			const meta = await probe(item.id).checkProvenance();
			assert.deepEqual([meta.jira?.siteId, meta.jira?.projectId, meta.jira?.via], [jira.site.id, eng.id, via]);
			assert.deepEqual(meta.untrusted, [`Jira issue ${issue.key} by ${jira.myself.displayName}`]);
			return item;
		};
		// Race both a redelivery and a distinct delivery for the same as-yet-unfiled issue.
		const race = await Promise.all([post(event, delivery), post(event, delivery), post(event)]);
		assert.equal(race.filter(r => r === "duplicate").length, 1); assert.equal(race.filter(r => r === true).length, 2);
		const first = await draft(labelled, "orchestrate", "label"); assert.match(first.title, /Title from Jira/);
		const commentPath = `/issue/${labelled.id}/comment`;
		const calls = (method: string) => jira.calls.filter(c => c.startsWith(method + " ") && c.endsWith(commentPath)).length;
		await until("outbox reconciles the filed comment after losing its reply", () => probe(first.id).checkFiledReceipt());
		assert.ok(calls("GET") >= 2, "the writer reread Jira comments before acknowledging the milestone");
		assert.equal(calls("POST"), 1); assert.equal(jira.comments.size, 1);
		await stop(); await start(false);
		assert.equal(await post(event, delivery), "duplicate"); assert.equal(await post(event), true);
		assert.equal((await draft(labelled, "orchestrate", "label")).id, first.id);
		console.log("PASS concurrent filings, lost comment reply and delivery replay across server restart");

		const assigned = make("Assigned without labels", []); assigned.fields.assignee = jira.myself;
		const assignment = { field: "assignee", from: null, to: jira.myself.accountId };
		assert.equal(await post(updated(assigned, assignment)), true); await draft(assigned, "orchestrate", "assignment");
		const quickIssue = make("Quick label", ["windlass-quick"]);
		assert.equal(await post(created(quickIssue)), true); const quickItem = await draft(quickIssue, "single", "label");
		await owner.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
		const bugIssue = make("Qualifying Bug", ["windlass"]); bugIssue.fields.issuetype.name = "Bug";
		assert.equal(await post(created(bugIssue)), true); const bugItem = await draft(bugIssue, "single", "label");
		await owner.saveRepositoryDefaults({ repositoryId: repo.id, profile: null });
		const bugLabel = make("Assigned with bug label", ["bug"]); bugLabel.fields.assignee = jira.myself;
		assert.equal(await post(updated(bugLabel, assignment)), true); await draft(bugLabel, "single", "assignment");
		assert.equal((await owner.listItems()).length, 5);
		console.log("PASS assignment, Quick label, Bug type and bug label select the expected drafts");

		const posted = (issue: Issue) => [...jira.comments.values()].filter(c => c.issueId === issue.id);
		const milestone = async (issue: Issue, id: string, key: string, wording: string, pr?: string) => {
			const marker = `[windlass:${id}:${key}]`;
			const comment = await until(`Jira ${key} comment for ${id}`, async () => posted(issue).find(c => JSON.stringify(c.body).includes(marker)));
			const lines = [wording, ...(pr ? [`Pull request: ${pr}`] : []), marker];
			assert.deepEqual(comment.body, { type: "doc", version: 1, content: [
				...lines.map(text => ({ type: "paragraph", content: [{ type: "text", text }] })),
				{ type: "paragraph", content: [{ type: "text", text: "Work item", marks: [{ type: "link", attrs: { href: `${origin}/items/${id}` } }] }] },
			] });
		};
		const id = quickItem.id;
		const initialStatus = structuredClone(quickIssue.fields.status);
		// Capture a qualifying delivery while the original generation is live. Its late arrival must not refile it.
		const trigger = { field: "labels", fromString: "", toString: "windlass-quick" };
		const old = updated(quickIssue, trigger);
		await milestone(quickIssue, id, "filed", "Filed as a Windlass draft.");
		await owner.actOnItem({ id, action: { kind: "start" } });
		const pr = await until("Jira item's pull request", async () => (await owner.item(id)).pullRequest, 45_000);
		await milestone(quickIssue, id, "opened", "Windlass opened a pull request.", pr.url);
		const pull = github.pulls.find(p => p.repository === repo.id && p.number === pr.number);
		assert.ok(pull); pull.state = "closed"; pull.merged = true;
		await until("merged Jira item is done", async () => (await owner.item(id)).state === "done", 45_000);
		await milestone(quickIssue, id, "done", "The Windlass work item is done.", pr.url);
		assert.equal(posted(quickIssue).length, 3); assert.deepEqual(quickIssue.fields.status, initialStatus);
		const generations = async () => (await owner.listItems()).filter(i => i.origin?.jira?.id === quickIssue.id);
		assert.equal(await post(old), true); assert.equal((await generations()).length, 1);
		quickIssue.fields.labels = [];
		assert.equal(await post(updated(quickIssue, { field: "labels", fromString: "windlass-quick", toString: "" })), false);
		quickIssue.fields.labels = ["windlass-quick"];
		assert.equal(await post(updated(quickIssue, trigger)), true);
		const next = await until("fresh Jira transition filed a distinct draft", async () => (await generations()).find(i => i.id !== id));
		assert.equal(next.state, "draft"); assert.equal((await generations()).length, 2);
		await milestone(quickIssue, next.id, "filed", "Filed as a Windlass draft.");
		assert.equal(posted(quickIssue).length, 4);

		// bugItem's builder must have been filed on docker-hardened: untrusted Jira text needs owner input there.
		const bugStatus = structuredClone(bugIssue.fields.status);
		await milestone(bugIssue, bugItem.id, "filed", "Filed as a Windlass draft.");
		await owner.actOnItem({ id: bugItem.id, action: { kind: "start" } });
		const q = await until("untrusted Jira turn asks owner", async () => (await owner.item(bugItem.id)).question);
		await owner.actOnItem({ id: bugItem.id, action: { kind: "answer", question: q.id, choice: "give_up" } });
		await milestone(bugIssue, bugItem.id, "failed", "The Windlass work item failed.");
		const failed = await owner.item(bugItem.id);
		assert.equal(failed.state, "failed"); assert.equal(failed.pullRequest, null);
		assert.equal(posted(bugIssue).length, 2); assert.deepEqual(bugIssue.fields.status, bugStatus);
		console.log("PASS Jira PR, merge, fresh generation, and failure before a PR");
	} finally {
		await stop(); await jira.close(); await github.stop(); rmSync(storage, { recursive: true, force: true });
	}
}
if (process.argv.includes("--node")) await testNode();
else await run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
