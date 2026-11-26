// Run from server: npx tsx ../scripts/jira-protocol-check.ts. All provider traffic stays on loopback.
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { JiraStandin } from "./jira-standin.js";
import type { JiraConnectStore } from "../server/src/jira/connect.js";

process.env.WLP_SECRET = randomUUID();
const { jiraConfig, jiraClientSecret } = await import("../server/src/config.js");
const { JiraApp } = await import("../server/src/jira/app.js");
const { jiraCallbackResponse } = await import("../server/src/jira/connect.js");

let route: (request: Request) => Promise<Response>;
const receiver = createServer(async (req, res) => {
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
		const response = await route(new Request(`${origin}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(await response.text());
	} catch {
		res.writeHead(500).end();
	}
});
await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
const jira = await JiraStandin.start({ redirectUri: `${origin}/jira/callback`, pageSize: 1 });
try {
	assert.deepEqual(jiraConfig({}), { app: null, missing: [] });
	assert.deepEqual(jiraConfig({ WLP_JIRA_CLIENT_ID: "partial" }).missing, ["WLP_JIRA_CLIENT_SECRET"]);
	const env = { WLP_JIRA_CLIENT_ID: jira.clientId, WLP_JIRA_CLIENT_SECRET: jira.clientSecret, WLP_JIRA_AUTH_URL: jira.url, WLP_JIRA_API_URL: jira.url, WLP_JIRA_REDIRECT_URL: jira.redirectUri };
	const settings = jiraConfig(env);
	assert.ok(!JSON.stringify(settings).includes(jira.clientSecret));
	assert.throws(() => jiraConfig({ ...env, WLP_JIRA_API_URL: "http://jira.example" }));
	const app = new JiraApp(settings.app!, { clientSecret: () => jiraClientSecret(env) });
	jira.sites.push({ ...jira.site, id: randomUUID(), name: "Second site", url: "https://second.atlassian.net" });
	jira.sites.push({ ...jira.site, id: randomUUID(), scopes: ["read:jira-work"] });
	const states = new Set<string>();
	const grants: Parameters<JiraConnectStore["complete"]>[] = [];
	const store: JiraConnectStore = {
		async claim(state) { return states.delete(state) ? { uid: "owner", origin, nonce: state } : null; },
		async complete(...grant) { grants.push(grant); },
	};
	route = req => jiraCallbackResponse(req, { app, store, origins: [origin] });
	const state = randomUUID();
	states.add(state);
	const consent = await fetch(app.authorizeUrl(state), { redirect: "manual" });
	assert.equal(consent.status, 302);
	const callback = consent.headers.get("location")!;
	assert.equal(new URL(callback).origin, origin);
	const back = (url: string) => fetch(url, { redirect: "manual" });
	assert.equal((await back(callback)).headers.get("location"), `${origin}/settings#jira=select-site`);
	assert.equal((await back(callback)).status, 400);
	assert.equal((await back(`${jira.redirectUri}?state=forged&code=bogus`)).status, 400);
	states.add("denied");
	assert.equal((await back(`${jira.redirectUri}?state=denied&error=access_denied`)).headers.get("location"), `${origin}/settings#jira-error=denied`);
	states.add("wrong-code");
	assert.equal((await back(`${jira.redirectUri}?state=wrong-code&code=invalid`)).headers.get("location"), `${origin}/settings#jira-error=failed`);
	assert.equal(grants.length, 1);
	const [claim, grant, sites] = grants[0];
	assert.equal(claim.uid, "owner");
	assert.deepEqual(sites.map(site => site.id), jira.sites.slice(0, 2).map(site => site.id));
	console.log("ok  OAuth callback consumes state once; tokens and authorized sites stay server-side");

	jira.expireTokens();
	await assert.rejects(app.identity(grant.accessToken, jira.site.id), { status: 401 });
	const refreshed = await app.refresh(grant.refreshToken!);
	assert.ok(refreshed.refreshToken && refreshed.refreshToken !== grant.refreshToken);
	await assert.rejects(app.refresh(grant.refreshToken!), { code: "invalid_grant" });
	const token = refreshed.accessToken, cloud = jira.site.id;
	const me = await app.identity(token, cloud);
	assert.equal(me.accountId, jira.myself.accountId);
	const project = jira.addProject("WORK");
	const other = jira.addProject("OPS");
	assert.deepEqual((await app.projects(token, cloud)).map(p => p.id), [project.id, other.id]);
	assert.deepEqual(await app.projects(token, sites[1].id), []);
	const issue = jira.createIssue(project, "Untrusted title", "line one\nline two");
	issue.fields.assignee = jira.myself;
	issue.fields.issuetype.name = "Bug";
	const read = await app.issue(token, cloud, issue.id);
	assert.equal(read?.description, "line one\nline two");
	assert.equal(read?.assignee?.accountId, me.accountId);
	assert.equal(read?.projectId, project.id);
	assert.equal(read?.issueType, "Bug");
	assert.equal(await app.issue(token, sites[1].id, issue.id), null);
	const message = "Filed a draft.";
	const link = { text: "Open work item", href: "https://windlass.example/items/1" };
	const commentId = await app.comment(token, cloud, issue.id, message, link);
	const [comment] = await app.comments(token, cloud, issue.id);
	assert.deepEqual([comment.id, comment.body], [commentId, `${message}\n${link.text}`]);
	assert.ok(JSON.stringify(jira.comments.get(commentId)?.body).includes(link.href));
	console.log("ok  rotating refresh, site-scoped identity, paged projects, issue and ADF comment");

	const { jiraWebhookRoute, JIRA_WEBHOOK_PATH, newJiraWebhookKey } = await import("../server/src/jira/webhook.js");
	const key = newJiraWebhookKey();
	const hookUrl = `${origin}${JIRA_WEBHOOK_PATH}/${key}`;
	const hookId = await app.registerWebhook(token, cloud, hookUrl, `project = ${project.id}`);
	const hooks = await app.webhooks(token, cloud);
	assert.deepEqual(hooks.map(h => [h.id, h.events.sort()]), [[hookId, ["jira:issue_created", "jira:issue_updated"]]]);
	assert.ok(await app.refreshWebhooks(token, cloud, [hookId]) > Date.now());
	const delivered: import("../server/src/jira/webhook.js").JiraDelivery[] = [];
	let unavailable = false;
	const seen = new Set<string>();
	const receive = jiraWebhookRoute({
		settings: () => ({ clientId: jira.clientId, clientSecret: jira.clientSecret }),
		resolve: async k => k === key ? { cloudId: cloud, siteUrl: jira.site.url, webhookIds: jira.hooks.has(hookId) ? [hookId] : [] } : null,
		dispatch: async delivery => {
			if (unavailable) throw new Error(jira.clientSecret); // An injected store error must not escape.
			delivered.push(delivery);
			assert.equal(delivery.cloudId, cloud);
			if (!delivery.label && delivery.assignedTo !== me.accountId) return "ignored";
			const id = `${delivery.cloudId}/${delivery.deliveryId}`;
			if (seen.has(id)) return "duplicate";
			seen.add(id);
			return "taken";
		},
	});
	route = async req => await receive(req) ?? new Response(null, { status: 404 });
	const jwt = (secret: string, expires: number) => {
		const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const signed = `${part({ alg: "HS256", typ: "JWT" })}.${part({ aud: jira.clientId, exp: expires })}`;
		return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
	};
	const exp = Math.floor(Date.now() / 1000) + 120;
	const auth = `Bearer ${jwt(jira.clientSecret, exp)}`;
	const created = { timestamp: Date.now(), webhookEvent: "jira:issue_created", matchedWebhookIds: [hookId],
		issue: { id: issue.id, self: `${jira.site.url}/rest/api/2/issue/${issue.id}`, fields: { project: { id: project.id }, labels: ["windlass"], assignee: null } } };
	const post = (event: object, opts: { auth?: string; id?: string; url?: string; retry?: boolean } = {}) => fetch(opts.url ?? jira.hooks.get(hookId)?.url ?? hookUrl, {
		method: "POST", headers: { "content-type": "application/json", authorization: opts.auth ?? auth,
			"x-atlassian-webhook-identifier": opts.id ?? randomUUID(), ...(opts.retry && { "x-atlassian-webhook-retry": "1" }) }, body: JSON.stringify(event),
	});
	for (const bad of ["", `Bearer ${jwt("wrong", exp)}`, `Bearer ${jwt(jira.clientSecret, exp - 300)}`]) {
		const response = await post(created, { auth: bad });
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { code: "bad_token" });
	}
	await post(created, { url: `${origin}${JIRA_WEBHOOK_PATH}/${newJiraWebhookKey()}` });
	await post({ ...created, matchedWebhookIds: [hookId + 1] });
	await post({ ...created, issue: { ...created.issue, self: `${sites[1].url}/rest/api/2/issue/${issue.id}` } });
	assert.equal((await post(created, { id: "" })).status, 400);
	assert.equal(delivered.length, 0);
	const id = randomUUID();
	assert.deepEqual(await (await post(created, { id })).json(), { taken: true });
	assert.deepEqual(await (await post(created, { id, retry: true })).json(), { taken: "duplicate" });
	assert.deepEqual(delivered.map(d => d.deliveryId), [id, id]);
	const updated = (item: object) => ({ ...created, webhookEvent: "jira:issue_updated", changelog: { items: [item] },
		issue: { id: issue.id, fields: { project: { id: project.id }, labels: ["windlass", "windlass-quick"], assignee: me } } });
	await post(updated({ field: "summary", fromString: "a", toString: "b" }));
	await post(updated({ field: "labels", fromString: "windlass triage", toString: "windlass" }));
	await post(updated({ field: "assignee", from: me.accountId, to: me.accountId }));
	assert.equal(delivered.length, 2);
	assert.deepEqual(await (await post(updated({ field: "labels", fromString: "windlass", toString: "windlass windlass-quick" }))).json(), { taken: true });
	assert.deepEqual(await (await post(updated({ field: "assignee", from: null, to: me.accountId }))).json(), { taken: true });
	assert.deepEqual(delivered.slice(2).map(d => [d.issueId, d.projectId, d.label, d.assignedTo]), [
		[issue.id, project.id, true, null], [issue.id, project.id, false, me.accountId],
	]);
	unavailable = true;
	const retry = await post(created);
	assert.equal(retry.status, 503);
	assert.deepEqual(await retry.json(), { code: "unavailable" });
	unavailable = false;
	await app.deleteWebhooks(token, cloud, [hookId]);
	assert.deepEqual(await app.webhooks(token, cloud), []);
	await post(created);
	assert.equal(delivered.length, 4);
	console.log("ok  dynamic hook registration, renewal and removal; authenticated tenant-bound transitions and retry IDs");
} finally {
	await jira.close();
	await new Promise<void>(resolve => receiver.close(() => resolve()));
}
