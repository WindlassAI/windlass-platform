/** Run from server: npx tsx ../scripts/jira-owner-check.ts. Real owner actions and HTTP routes, loopback providers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localListeners } from "./check-listeners.js";
import { GithubStandin } from "./github-standin.js";
import { pollUntil } from "./issue-intake-fixture.js";
import { JiraStandin } from "./jira-standin.js";
import { loginHttp } from "./login-http.js";

const origin = "http://127.0.0.1:5173";
const until = pollUntil(30_000);

/** No fixture RPC is available to the browser. Shorten clocks and lose a provider reply, not the writes. */
async function testNode() {
	const { requireServiceFor } = await import("../server/src/auth.js");
	const { user } = await import("../server/src/actors/user.js");
	const { JiraApp, JiraError } = await import("../server/src/jira/app.js");
	const exchange = JiraApp.prototype.exchangeCode, comment = JiraApp.prototype.comment, issue = JiraApp.prototype.issue;
	let failRead = false;
	JiraApp.prototype.issue = async function(...args) {
		if (failRead) { failRead = false; throw new JiraError(503, "read the issue"); }
		return issue.apply(this, args);
	};
	JiraApp.prototype.exchangeCode = async function(code) {
		return { ...await exchange.call(this, code), expiresAt: Date.now() + 30_000 };
	};
	let loseReply = true;
	JiraApp.prototype.comment = async function(...args) {
		const posted = await comment.apply(this, args);
		if (loseReply) { loseReply = false; throw new JiraError(0, "receive the comment reply"); }
		return posted;
	};
	type Ctx = Parameters<NonNullable<typeof user.config.actions>["internalJiraRenew"]>[0];
	const { jiraSite } = await import("../server/src/actors/jira-site.js");
	type SiteCtx = Parameters<NonNullable<typeof jiraSite.config.actions>["internalDispatch"]>[0];
	const generations = new WeakMap<object, string>();
	Object.assign(jiraSite.config.actions!, {
		checkReceipt: async (c: SiteCtx, id: string, sleep: boolean) => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ done: number }>("SELECT done FROM delivery WHERE id=?", id);
			if (!generations.has(c.vars)) generations.set(c.vars, randomUUID());
			const snapshot = { done: row?.done, generation: generations.get(c.vars) };
			if (sleep) c.sleep();
			return snapshot;
		},
	});
	Object.assign(user.config.actions!, {
		checkFailRead: async (c: Ctx) => { requireServiceFor(c, "call"); failRead = true; },
		checkRenewSoon: async (c: Ctx) => {
			requireServiceFor(c, "call");
			await c.db.execute("UPDATE jira_mapping SET expires=?", Date.now() + 60_000);
			await c.schedule.at(Date.now() + 100, "internalJiraRenew");
		},
	});
	await import("../server/src/index.js");
}

async function run() {
	const { engine, http: [port] } = await localListeners();
	const api = `http://127.0.0.1:${port}`;
	const jira = await JiraStandin.start({ redirectUri: `${api}/jira/callback`, pageSize: 1 });
	const github = new GithubStandin({ callbackUrl: `${api}/github/callback` });
	await github.start();
	const storage = mkdtempSync(join(tmpdir(), "jira-owner-check-"));
	Object.assign(process.env, github.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"), WLP_SANDBOX: "fake", WLP_DEMO: "1", WLP_ITEMS: "1",
		WLP_HTTP_PORT: String(port), WLP_WEB_ORIGINS: origin, WLP_PUBLIC_URL: api,
		WLP_JIRA_CLIENT_ID: jira.clientId, WLP_JIRA_CLIENT_SECRET: jira.clientSecret,
		WLP_JIRA_AUTH_URL: jira.url, WLP_JIRA_API_URL: jira.url, WLP_JIRA_REDIRECT_URL: jira.redirectUri,
		RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(engine), RIVET_LOG_LEVEL: "silent",
	});
	for (const key of ["RIVET_ENDPOINT", "RIVET_ADMIN_TOKEN", "RIVET_ENGINE", "PORT"]) delete process.env[key];
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "";
	child.stdout.on("data", b => { logs += b.toString(); }); child.stderr.on("data", b => { logs += b.toString(); });
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	try {
		await until("the platform", async () => {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`platform exited during startup: ${child.exitCode ?? child.signalCode}`);
			return (await fetch(api + "/platform/info").catch(() => null))?.ok;
		}, 90_000);
		const { createClient } = await import("../server/src/client.js");
		const { serviceParams } = await import("../server/src/auth.js");
		const client = createClient<import("../server/src/registry.js").Registry>({ endpoint: `http://127.0.0.1:${engine}` });
		const auth = await loginHttp(api).demo(), otherAuth = await loginHttp(api).demo();
		const owner = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
		const other = client.user.getOrCreate([otherAuth.profile.uid], { params: { token: otherAuth.token } });
		const service = client.user.get([auth.profile.uid], { params: serviceParams() });
		const fixture = service as unknown as { checkRenewSoon(): Promise<void>; checkFailRead(): Promise<void> };
		const directory = client.jiraSite.get([jira.site.id], { params: serviceParams() }) as unknown as {
			checkReceipt(id: string, sleep: boolean): Promise<{ done?: number; generation: string }>;
		};
		const login = "jira-owner"; github.addUser(login);
		const installation = github.addInstallation(login, "User");
		const repo = github.addRepository({ owner: login, name: "factory", installation });
		const alternative = github.addRepository({ owner: login, name: "alternate", installation });
		const shared = github.addRepository({ owner: "jira-team", name: "shared", installation: github.addInstallation("jira-team", "Organization") });
		shared.access.set(login, "read");
		const connectGh = await owner.githubConnect({ origin });
		const ghBack = await fetch(github.authorize(login, connectGh.url), { redirect: "manual" });
		await owner.githubComplete(ghBack.headers.get("location")!.split("#github=")[1]);

		const eng = jira.addProject("ENG"), ops = jira.addProject("OPS"), cloud = jira.site.id;
		const second = { ...jira.site, id: randomUUID(), name: "Second", url: "https://second.atlassian.net" };
		jira.sites.push(second);
		jira.addProject("OTHER", "Other", second);
		assert.deepEqual(await owner.jira(), { state: "disconnected" });
		await assert.rejects(owner.jiraConnect({ origin: "https://unlisted.invalid" }));
		const begin = async () => jira.authorize((await owner.jiraConnect({ origin })).url);
		const callback = await begin();
		const response = await fetch(callback, { redirect: "manual" });
		assert.equal(response.status, 302);
		const landing = new URL(response.headers.get("location")!);
		assert.equal(landing.origin + landing.pathname, origin + "/settings");
		assert.ok(landing.hash.startsWith("#jira="));
		const ticket = landing.hash.slice("#jira=".length);
		await assert.rejects(other.jiraComplete(ticket));
		const connected = await owner.jiraComplete(ticket);
		assert.ok(connected.state === "connected");
		assert.deepEqual(connected.connection.sites.map(s => s.id), [cloud, second.id]);
		assert.equal(connected.connection.site, null);
		await assert.rejects(owner.jiraComplete(ticket));
		const replay = await fetch(callback, { redirect: "manual" });
		assert.ok(replay.status === 400 || replay.headers.get("location")?.includes("jira-error"));
		const tokenCalls = jira.calls.filter(c => c === "POST /oauth/token").length;
		jira.expireTokens();
		const selected = await owner.jiraSelectSite(cloud);
		assert.equal(jira.calls.filter(c => c === "POST /oauth/token").length, tokenCalls + 1, "renew the expiring grant");
		await assert.rejects(owner.jiraSelectSite(randomUUID()));
		assert.ok(selected.state === "connected"); assert.equal(selected.connection.site?.id, cloud);
		assert.equal(selected.connection.user.id, jira.myself.accountId);
		assert.deepEqual((await owner.jiraProjects()).projects.map(p => [p.id, p.mapping]), [[eng.id, null], [ops.id, null]]);
		const mapping = { siteId: cloud, projectId: eng.id, repositoryId: repo.id };
		await assert.rejects(owner.saveJiraMapping({ ...mapping, siteId: second.id }));
		await assert.rejects(owner.saveJiraMapping({ ...mapping, projectId: "999999" }));
		await assert.rejects(owner.saveJiraMapping({ ...mapping, repositoryId: 999999 }));
		await assert.rejects(owner.saveJiraMapping({ ...mapping, repositoryId: shared.id }), { code: "bad_input" });
		const saved = await owner.saveJiraMapping(mapping);
		assert.equal(saved.projects.find(p => p.id === eng.id)?.mapping?.repository.id, repo.id);
		const hook = [...jira.hooks.values()].find(h => h.siteId === cloud)!;
		assert.ok(hook); assert.equal(new URL(hook.url).origin, api);
		assert.equal(hook.jqlFilter, `project = ${eng.id}`);
		const renewals = () => jira.calls.filter(c => c.endsWith("/webhook/refresh")).length;
		const beforeRenewal = renewals();
		await fixture.checkRenewSoon();
		await until("scheduled Jira hook renewal", async () => renewals() > beforeRenewal);
		const hookKey = new URL(hook.url).pathname.split("/").at(-1)!;
		const publicData = JSON.stringify([connected, selected, saved]);
		for (const secret of [jira.clientSecret, hookKey, ticket]) assert.ok(!publicData.includes(secret));
		console.log("PASS owner-bound callback, single-use completion, site selection, paged projects and mapping checks");

		const issue = jira.createIssue(eng, "Title read from Jira", "Private issue description.");
		issue.fields.labels = ["windlass"];
		const makeEvent = (i: typeof issue) => ({ webhookEvent: "jira:issue_created", timestamp: Date.now(), matchedWebhookIds: [hook.id],
			issue: { id: i.id, fields: { ...i.fields, summary: "Not the stored title" } }, user: jira.myself });
		const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
		const signed = `${part({ typ: "JWT", alg: "HS256" })}.${part({ aud: jira.clientId, exp: Math.floor(Date.now() / 1000) + 600 })}`;
		const signature = createHmac("sha256", jira.clientSecret).update(signed).digest("base64url");
		const post = async (body: object, id = randomUUID(), status = 202) => {
			const res = await fetch(hook.url, { method: "POST", headers: { authorization: `Bearer ${signed}.${signature}`,
				"content-type": "application/json", "x-atlassian-webhook-identifier": id }, body: JSON.stringify(body) });
			assert.equal(res.status, status); return (await res.json()).taken;
		};
		const event = makeEvent(issue), delivery = randomUUID();
		assert.equal(await post({ ...event, matchedWebhookIds: [hook.id + 42] }), false);
		const outside = jira.createIssue(ops, "Unmapped"); outside.fields.labels = ["windlass"];
		assert.equal(await post(makeEvent(outside)), false);
		const stale = jira.createIssue(eng, "Label since removed"); stale.fields.labels = ["windlass"];
		const staleEvent = makeEvent(stale); stale.fields.labels = [];
		await post(staleEvent);
		assert.equal((await owner.listItems()).length, 0);
		await fixture.checkFailRead();
		await post(event, delivery, 503);
		assert.equal((await directory.checkReceipt(delivery, false)).done, 0, "failed fetch stays pending");
		assert.equal(await post(event, delivery), true);
		const committed = await directory.checkReceipt(delivery, true);
		assert.equal(committed.done, 1);
		await until("site actor waking with its durable decision", async () => {
			const fresh = await directory.checkReceipt(delivery, false);
			return fresh.generation !== committed.generation && fresh.done === 1;
		});
		assert.equal(await post(event, delivery), "duplicate");
		await post(event); // A distinct delivery for the same live draft.
		const items = await owner.listItems(); assert.equal(items.length, 1);
		const [item] = items; assert.equal(item.state, "draft"); assert.equal(item.origin?.jira?.trusted, false);
		assert.equal(item.origin?.jira?.id, issue.id); assert.match(item.title, /Title read from Jira/);
		assert.deepEqual(await other.listItems(), []);
		console.log("PASS mapped, authenticated deliveries refetch Jira, deduplicate and charge only the owning account");

		const comments = () => [...jira.comments.values()].filter(c => c.issueId === issue.id);
		await until("one filed comment", async () => comments().length === 1);
		const itemUrl = `${origin}/items/${item.id}`;
		assert.ok(JSON.stringify(comments()[0].body).includes(itemUrl));
		const write = { siteId: cloud, projectId: eng.id, issueId: issue.id, itemId: item.id, action: { key: "filed" as const, itemUrl } };
		await assert.rejects(owner.internalJiraWrite(write));
		assert.equal(await service.internalJiraWrite(write), true); // The provider accepted the POST but its reply was lost.
		assert.equal(comments().length, 1);
		await owner.actOnItem({ id: item.id, action: { kind: "cancel" } });
		await until("terminal comment", async () => comments().length === 2);
		assert.match(JSON.stringify(comments()[1].body), /cancel/i);
		assert.ok(!JSON.stringify(comments()).includes("Private issue description"));
		assert.equal(issue.fields.status.name, "Open");
		console.log("PASS service-only, comment-only Jira writeback and idempotent milestone replay");

		// Only assignment to the selected account qualifies. A cap is retryable, not a receipt.
		const assigned = jira.createIssue(eng, "Owner assignment");
		assigned.fields.assignee = { ...jira.myself, accountId: "not-the-owner" };
		assert.equal(await post(makeEvent(assigned)), false);
		assigned.fields.assignee = jira.myself;
		const assignment = makeEvent(assigned), assignmentId = randomUUID();
		const { limitsSubject } = await import("../server/src/user-limits.js");
		const { issueServiceToken } = await import("../server/src/tokens.js");
		const operator = "jira-check";
		const limits = client.user.get([auth.profile.uid], { params: { token: issueServiceToken(limitsSubject(auth.profile.uid, operator)) } });
		await limits.internalSetLimit({ operator, key: "githubItemsPerDay", value: 1 });
		await post(assignment, assignmentId, 503);
		await limits.internalSetLimit({ operator, key: "githubItemsPerDay", value: 2 });
		assert.equal(await post(assignment, assignmentId), true);
		assert.equal(await post(assignment, assignmentId), "duplicate");
		assert.equal((await owner.listItems()).find(i => i.origin?.jira?.id === assigned.id)?.state, "draft");

		// Connect a second owner to the same Jira site and GitHub installation; only one may hold ENG.
		const secondGh = await other.githubConnect({ origin });
		await other.githubComplete((await fetch(github.authorize(login, secondGh.url), { redirect: "manual" })).headers.get("location")!.split("#github=")[1]);
		const secondCallback = await jira.authorize((await other.jiraConnect({ origin })).url);
		const secondLanding = (await fetch(secondCallback, { redirect: "manual" })).headers.get("location")!;
		await other.jiraComplete(new URL(secondLanding).hash.slice("#jira=".length));
		await other.jiraSelectSite(cloud);
		await assert.rejects(other.saveJiraMapping(mapping), { code: "jira_project_taken" });
		const remapped = await owner.saveJiraMapping({ ...mapping, repositoryId: alternative.id });
		assert.equal(remapped.projects.find(p => p.id === eng.id)?.mapping?.repository.id, alternative.id);
		assert.equal(await service.internalJiraWrite({ ...write, action: { key: "done", itemUrl, pr: null } }), false,
			"an old item's outbox cannot post after its project changes repository");
		assert.equal(comments().length, 2);
		await owner.removeJiraMapping({ siteId: cloud, projectId: eng.id });
		const after = jira.createIssue(eng, "Mapping gone"); after.fields.labels = ["windlass"];
		assert.equal(await post(makeEvent(after)), false);
		assert.equal(await service.internalJiraWrite(write), false, "unmapping disables existing item writes");
		await other.saveJiraMapping(mapping);
		await assert.rejects(owner.saveJiraMapping(mapping), { code: "jira_project_taken" });
		assert.equal(await post(makeEvent(after)), false, "the previous callback is retired even after reassignment");
		// A new grant must not inherit a previous grant's site, hooks or project claims.
		const reconnect = await jira.authorize((await other.jiraConnect({ origin })).url);
		const reconnectBack = await fetch(reconnect, { redirect: "manual" });
		const reconnected = await other.jiraComplete(new URL(reconnectBack.headers.get("location")!).hash.slice("#jira=".length));
		assert.ok(reconnected.state === "connected");
		assert.equal(reconnected.connection.site, null);
		assert.equal(jira.hooks.size, 0);
		await other.jiraSelectSite(second.id);
		await assert.rejects(other.saveJiraMapping(mapping));
		await owner.saveJiraMapping(mapping);
		await other.disconnectJira();
		const pending = await begin();
		const unfinished = await fetch(await begin(), { redirect: "manual" });
		const unfinishedTicket = new URL(unfinished.headers.get("location")!).hash.slice("#jira=".length);
		assert.deepEqual(await owner.disconnectJira(), { state: "disconnected" });
		await assert.rejects(owner.jiraComplete(unfinishedTicket));
		assert.equal(jira.hooks.size, 0);
		assert.equal(await post(makeEvent(after)), false);
		const invalidated = await fetch(pending, { redirect: "manual" });
		assert.ok(invalidated.status === 400 || invalidated.headers.get("location")?.includes("jira-error"));
		assert.equal((await owner.listItems()).length, 2);
		for (const value of [jira.clientSecret, hookKey, signature, ticket]) assert.ok(!logs.includes(value), "a credential was logged");
		console.log("PASS assignment, retry after quota refusal, exclusive mapping handoff, disconnect and stale callbacks");
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 10_000); await exited; clearTimeout(guard);
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch { /* The engine already exited. */ }
		await jira.close(); await github.stop(); rmSync(storage, { recursive: true, force: true });
	}
}
if (process.argv.includes("--node")) await testNode();
else await run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
