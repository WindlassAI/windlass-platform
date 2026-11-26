/** Run: cd server && npx tsx ../scripts/slack-workspace-check.ts
 * Real workspace operations and Settings helpers over SQLite. All HTTP goes to loopback stand-ins.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SlackStandin } from "./slack-standin.js";
import { GithubStandin } from "./github-standin.js";

function store() {
	const sql = new DatabaseSync(":memory:");
	const execute = async (query: string, ...args: SQLInputValue[]) => sql.prepare(query).all(...args);
	const db = { execute, transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) => {
		sql.exec("BEGIN");
		try { const result = await fn({ execute }); sql.exec("COMMIT"); return result; }
		catch (error) { sql.exec("ROLLBACK"); throw error; }
	} };
	return { sql, db };
}

const origin = "http://127.0.0.1:5173";
const slack = await SlackStandin.start();
const github = new GithubStandin({ callbackUrl: origin + "/github/callback" });
const workspace = store(), settings = store(), memberSettings = store();
try {
	await github.start();
	Object.assign(process.env, slack.env, github.env(), { WLP_WEB_ORIGINS: origin, WLP_SECRET: randomBytes(32).toString("hex") });
	const { WORKSPACE_TABLES, workspaceOps } = await import("../server/src/actors/slack-workspace.js");
	const { slackCallbackResponse, openSlackTicket } = await import("../server/src/slack/connect.js");
	const team = slack.team.id, channel = slack.channelId, owner = "u_owner", member = "u_member", userId = "U99999999";
	for (const ddl of WORKSPACE_TABLES) workspace.sql.exec(ddl);
	const reload = (key = team) => workspaceOps({ key: [key], db: workspace.db as never, vars: { queue: Promise.resolve() } });
	let ops = reload();
	const login = github.addUser("maintainer"), org = github.addInstallation("example", "Organization");
	const source = github.addRepository({ owner: org.account.login, name: "app", installation: org });
	source.access.set(login.login, "write");
	const replacement = github.addRepository({ owner: org.account.login, name: "next", installation: org });
	replacement.access.set(login.login, "write");
	const readOnly = github.addRepository({ owner: org.account.login, name: "readonly", installation: org });
	readOnly.access.set(login.login, "read");
	const repo = { id: source.id, owner: source.owner, name: source.name };
	const connection = { connectedAt: Date.now(), user: login, installations: [{ id: org.id, account: org.account, htmlUrl: github.url }] };
	const helpers = await import("../server/src/actors/user-slack.js");
	for (const ddl of helpers.SLACK_TABLES) { settings.sql.exec(ddl); memberSettings.sql.exec(ddl); }
	const get = (key: string[]) => { assert.deepEqual(key, [team]); return ops; };
	const client = () => ({ slackWorkspace: { get, getOrCreate: get } });
	const ownerCtx = { key: [owner], db: settings.db as never, vars: { github: connection }, client };
	const memberCtx = { key: [member], db: memberSettings.db as never, vars: { github: null }, client };
	assert.deepEqual(await helpers.slackStatus(ownerCtx), { state: "disconnected", links: [] });
	await assert.rejects(helpers.beginSlackConnect(ownerCtx, { origin: "https://invalid.example" }), { code: "origin_not_allowed" });
	async function grant(ctx: typeof ownerCtx | typeof memberCtx) {
		const { url } = await helpers.beginSlackConnect(ctx, { origin });
		const back = await slack.authorize(url);
		const callback = () => slackCallbackResponse(new Request(back), { store: { claim: async (uid, nonce) => {
			assert.equal(uid, ctx.key[0]);
			return helpers.claimSlackState(ctx, nonce);
		} } });
		const landing = new URL((await callback()).headers.get("location")!);
		assert.equal(landing.origin + landing.pathname, origin + "/settings");
		assert.ok(landing.hash.startsWith("#slack="));
		assert.equal(new URL((await callback()).headers.get("location")!).hash, "#slack-error=used");
		return landing.hash.slice(7);
	}
	const ticket = await grant(ownerCtx);
	await assert.rejects(helpers.completeSlackConnection(memberCtx, ticket), { code: "slack_ticket" });
	await assert.rejects(reload("TOTHER").internalInstall(owner, ticket));
	assert.equal((await helpers.completeSlackConnection(ownerCtx, ticket)).state, "connected");
	await assert.rejects(helpers.completeSlackConnection(ownerCtx, ticket), { code: "slack_ticket" });
	await assert.rejects(helpers.completeSlackConnection(memberCtx, await grant(memberCtx)), { code: "slack_unavailable" });
	assert.equal((await helpers.slackStatus(memberCtx)).state, "disconnected");
	await assert.rejects(helpers.saveSlackMapping(ownerCtx, { channelId: channel, repositoryId: readOnly.id }), { code: "github_denied" });
	await assert.rejects(helpers.saveSlackMapping(ownerCtx, { channelId: channel, repositoryId: 999999 }), { code: "github_gone" });
	assert.deepEqual((await ops.internalView(owner))?.mappings, []);
	await helpers.saveSlackMapping(ownerCtx, { channelId: channel, repositoryId: repo.id });
	console.log("ok  owner-bound single-use OAuth ticket, workspace ownership and GitHub write validation");

	ops = reload(); // No actor variables (or bearer in memory) survive this point.
	const view = await ops.internalView(owner);
	assert.deepEqual(view?.connection.workspace, slack.team);
	assert.deepEqual(view?.mappings, [{ channel: { id: channel, name: "engineering" }, repository: repo }]);
	assert.equal(await ops.internalView(member), null);
	const token = openSlackTicket(owner, ticket).install.accessToken;
	assert.ok(!JSON.stringify(view).includes(token), "workspace view exposed a bearer");
	assert.ok(!JSON.stringify(await workspace.db.execute("SELECT * FROM slack_install")).includes(token), "plaintext bearer persisted");
	await assert.rejects(ops.internalSaveMapping(member, channel, repo));
	await assert.rejects(ops.internalRemoveMapping(member, channel));
	await assert.rejects(ops.internalDisconnect(member));
	for (const ch of slack.channels.slice(2)) await assert.rejects(ops.internalSaveMapping(owner, ch.id, repo));
	const lookup = (id = userId) => ops.internalLookup(team, channel, id);
	assert.equal(await ops.internalLookup(team, "COTHER", userId), null);
	await assert.rejects(ops.internalLookup("TOTHER", channel, userId));
	const route = await lookup();
	assert.ok(route?.generation);
	assert.equal(route.uid, null);
	assert.deepEqual(route.repository, repo);
	console.log("ok  owner-only administration, durable sealed install and validated mapping");

	const { slackWebhookRoute, SLACK_EVENTS_PATH } = await import("../server/src/slack/webhook.js");
	const promptRoute = slackWebhookRoute({ async dispatch({ teamId, channelId, userId }) {
		await ops.internalPromptLink(teamId, channelId, userId);
		return "taken";
	} });
	function mention(id: string, unsigned = false) {
		const payload = slack.mention();
		payload.event.user = id;
		return slack.request(origin + SLACK_EVENTS_PATH, JSON.stringify(payload), "application/json", unsigned ? { omit: "x-slack-signature" } : {});
	}
	const callsBefore = slack.calls.length;
	assert.equal((await promptRoute(mention(userId, true)))?.status, 401);
	assert.equal(slack.calls.length, callsBefore, "unsigned request reached Slack");
	assert.equal(slack.ephemeral.length, 0);
	assert.deepEqual(await workspace.db.execute("SELECT 1 FROM slack_proof"), []);
	async function proof(id = userId) {
		const n = slack.ephemeral.length;
		const ack = await promptRoute(mention(id));
		assert.equal(ack?.status, 200);
		assert.equal(await ack.text(), "", "link proof must only be sent privately");
		assert.equal(slack.ephemeral.length, n + 1);
		const message = slack.ephemeral[n];
		assert.equal(message.channel, channel);
		assert.equal(message.user, id);
		const match = /https?:\/\/[^\s<>|]+/.exec(message.text);
		assert.ok(match);
		const url = new URL(match[0]);
		assert.equal(url.origin + url.pathname + url.search, origin + "/settings");
		const ticket = new URLSearchParams(url.hash.slice(1)).get("slack-link");
		assert.ok(ticket, "ephemeral message has no link proof");
		assert.ok(!JSON.stringify(await workspace.db.execute("SELECT * FROM slack_proof")).includes(ticket), "plaintext proof persisted");
		return ticket;
	}
	const superseded = await proof(), expired = await proof();
	await assert.rejects(ops.internalRedeem(member, superseded));
	workspace.sql.exec("UPDATE slack_proof SET expires_at=0");
	await assert.rejects(ops.internalRedeem(member, expired));
	const fresh = await proof();
	await assert.rejects(reload("TOTHER").internalRedeem(member, fresh));
	const linked = { teamId: team, userId };
	assert.deepEqual(await ops.internalRedeem(member, fresh), linked);
	assert.deepEqual(await ops.internalLink(member), linked);
	await assert.rejects(ops.internalRedeem("u_intruder", fresh));
	assert.equal((await lookup())?.uid, member);
	await assert.rejects(ops.internalPromptLink(team, channel, userId));
	const conflict = await proof("UOTHER");
	await assert.rejects(ops.internalRedeem(member, conflict));
	await ops.internalUnlink(member);
	assert.equal(await ops.internalLink(member), null);
	assert.equal((await lookup())?.uid, null);
	await assert.rejects(ops.internalRedeem(member, conflict));
	assert.deepEqual(await helpers.linkSlack(memberCtx, await proof()), { state: "disconnected", links: [linked] });
	assert.equal(slack.messages.length, 0, "private link prompt appeared in channel history");
	console.log("ok  private member link, expiry, replay, conflicting identity and unlink");

	const post = { teamId: team, channelId: channel, generation: route.generation, repositoryId: repo.id,
		itemId: "i_slacktest", event: "started" as const, threadTs: null };
	const ts = await ops.internalPost(post);
	assert.equal(ts, slack.messages[0]?.ts);
	assert.deepEqual(slack.messages[0], { ts, text: `Work item filed: ${origin}/items/${post.itemId}`, channel });
	await ops.internalPost({ ...post, event: "done", threadTs: ts });
	assert.equal(slack.messages[1]?.thread_ts, ts);
	await assert.rejects(ops.internalPost({ ...post, repositoryId: readOnly.id }));
	slack.channels[0].is_member = false;
	assert.equal(await lookup(), null);
	await assert.rejects(ops.internalPost(post));
	slack.channels[0].is_member = true;
	await helpers.saveSlackMapping(ownerCtx, { channelId: channel, repositoryId: replacement.id });
	const replaced = await lookup();
	assert.ok(replaced);
	assert.deepEqual(replaced.repository, { id: replacement.id, owner: replacement.owner, name: replacement.name });
	assert.notEqual(replaced.generation, route.generation);
	await assert.rejects(ops.internalPost(post));
	await assert.rejects(ops.internalPost({ ...post, generation: replaced.generation })); // Old repo, current generation.
	await ops.internalRemoveMapping(owner, channel);
	assert.equal(await lookup(), null);
	await assert.rejects(ops.internalPromptLink(team, channel, userId));
	await ops.internalSaveMapping(owner, channel, repo);
	assert.notEqual((await lookup())?.generation, route.generation);
	await assert.rejects(ops.internalPost(post)); // Even a remap to the same repository fences the old thread.
	const remapped = await lookup();
	assert.ok(remapped);
	const renewed = await grant(ownerCtx);
	await helpers.completeSlackConnection(ownerCtx, renewed);
	assert.deepEqual((await lookup())?.repository, repo, "reauthorization lost the channel mapping");
	assert.equal((await lookup())?.uid, member);
	await assert.rejects(ops.internalPost({ ...post, generation: remapped.generation }));
	const activeToken = openSlackTicket(owner, renewed).install.accessToken;
	const unused = await proof("UOTHER");
	assert.deepEqual(await helpers.disconnectSlack(ownerCtx), { state: "disconnected", links: [] });
	assert.deepEqual(await helpers.slackStatus(memberCtx), { state: "disconnected", links: [] });
	assert.equal(await ops.internalView(owner), null);
	assert.equal(await lookup(), null);
	assert.equal(await ops.internalLink(member), null);
	await assert.rejects(ops.internalRedeem(member, unused));
	await assert.rejects(ops.internalPost(post));
	assert.ok(!slack.tokens.has(activeToken), "disconnect did not revoke the current bot token");
	assert.equal(slack.messages.length, 2, "stale or unauthorized post reached Slack");
	console.log("ok  scoped posts, thread replies, membership loss, stale generation and disconnect");
} finally {
	workspace.sql.close(); settings.sql.close(); memberSettings.sql.close();
	await Promise.all([slack.close(), github.stop()]);
}
