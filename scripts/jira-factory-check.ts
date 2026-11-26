/** Exercise Jira filing through the user and work-item actions: real SQLite, a loopback GitHub and fixture sessions. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ItemSummary, SessionSummary } from "../server/src/contract.js";
import type { JiraFiling } from "../server/src/factory/intake.js";
import type { ItemsCtx, MakeSession } from "../server/src/actors/user-items.js";
import type { ItemCreateInput } from "../server/src/actors/work-item.js";
import type { JiraItemWrite } from "../server/src/actors/internal.js";
import { GithubStandin } from "./github-standin.js";

const github = new GithubStandin({ callbackUrl: "http://platform.invalid/github/callback" });
const databases: DatabaseSync[] = [];
function database(): ItemsCtx["db"] {
	const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
	const db: ItemsCtx["db"] = {
		async execute<Row>(query: string, ...args: unknown[]) { return sqlite.prepare(query).all(...args as SQLInputValue[]) as Row[]; },
		async transaction(run) {
			sqlite.exec("BEGIN");
			try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
			catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		},
		async close() { sqlite.close(); },
	};
	return db;
}
try {
	await github.start();
	Object.assign(process.env, github.env(), { WLP_SECRET: randomBytes(32).toString("hex"), WLP_SANDBOX: "fake", WLP_WEB_ORIGINS: "http://localhost:5173", WLP_DEMO: "1", WLP_FACTORY_REVIEWER: "off", WLP_ITEMS: "1", WLP_FACTORY_ORCHESTRATE: "1" });
	const { serviceParams } = await import("../server/src/auth.js");
	const { workItem, jiraEffects } = await import("../server/src/actors/work-item.js");
	const { ITEM_TABLES, loadItems, itemActions } = await import("../server/src/actors/user-items.js");
	const { ACCOUNT_DEFAULTS_TABLE, saveAccountDefaults } = await import("../server/src/account-defaults.js");
	const { DEFAULTS_TABLE } = await import("../server/src/repository-defaults.js");
	const { untrustedTurn } = await import("../server/src/factory/untrusted.js");
	const db = database();
	for (const ddl of [...ITEM_TABLES, ACCOUNT_DEFAULTS_TABLE, DEFAULTS_TABLE]) await db.execute(ddl);
	await saveAccountDefaults(db, { profile: "docker-hardened" }, Date.now());
	const user = github.addUser("jira-filer"), install = github.addInstallation("acme", "Organization");
	const repo = github.addRepository({ installation: install, owner: "acme", name: "factory" });
	repo.access.set(user.login, "write");
	const vars = {
		profile: { uid: "jira-filer", demo: true, email: null },
		github: { connectedAt: Date.now(), user, installations: [{ id: install.id, account: install.account, htmlUrl: github.url }] },
		items: await loadItems(db),
	};
	const conn = { params: serviceParams() };
	const comments: JiraItemWrite[] = [];
	const attempts: JiraItemWrite[] = [];
	let loseReply = true;
	// The writer deduplicates by item and milestone. Lose a successful reply before the item's receipt commits.
	const writer = async (write: JiraItemWrite) => {
		attempts.push(write);
		if (!comments.some(row => row.itemId === write.itemId && row.action.key === write.action.key)) comments.push(write);
		if (loseReply) { loseReply = false; throw new Error("fixture lost reply"); }
		return true;
	};
	const jobs: Promise<unknown>[] = [];
	type Actor = Parameters<NonNullable<typeof workItem.config.actions>["internalSummary"]>[0];
	const lifecycle = workItem.config as unknown as {
		db: { onMigrate(db: ItemsCtx["db"]): Promise<void> };
		createVars(c: Actor, input?: ItemCreateInput): Promise<Actor["vars"]>;
	};
	const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
	const actors = new Map<string, Actor>();
	const sessions = new Map<string, SessionSummary>();
	let interrupt = false;
	const client = () => ({
		githubRepository: { getOrCreate: () => ({ internalForget: async () => {} }) },
		agentSession: { get: () => ({}) },
		user: { get: () => ({ internalItemChanged: async (item: ItemSummary) => {
			vars.items.items.set(item.id, item);
			await db.execute("UPDATE items SET summary=? WHERE id=?", JSON.stringify(item), item.id);
		}, internalJiraWrite: writer }) },
		workItem: {
			async create(key: string[], { input }: { input: ItemCreateInput }) {
				if (interrupt) throw new Error("fixture interruption after reservation");
				const c = { key, conn, db: database(), log: console, client, broadcast: () => {}, schedule: { at: async () => "due", cancel: async () => true },
					keepAwake: (p: Promise<unknown>) => { jobs.push(p); return p; } } as unknown as Actor;
				await lifecycle.db.onMigrate(c.db);
				await workItem.config.onCreate!(c, input);
				Object.assign(c, { vars: await lifecycle.createVars(c, input) });
				actors.set(key[1], c);
			},
			get: ([, id]: string[]) => ({ async internalSummary() {
				const actor = actors.get(id);
				if (!actor) throw Object.assign(new Error("not created"), { code: "item_not_found" });
				return workItem.config.actions!.internalSummary(actor);
			} }),
		},
	});
	const ctx = { db, vars: Object.assign(vars, { sessions, machines: new Map() }), key: [vars.profile.uid], conn, client,
		log: { error: (entry: unknown) => { if (!interrupt) console.error(entry); } }, broadcast: () => {} } as unknown as ItemsCtx;
	const makeSession: MakeSession = async (_, __, input, ___, { sessionId, issue }) => {
		assert.equal(issue, undefined, "the session must not close a GitHub issue");
		const session = { id: sessionId, place: input.place, repository: { provider: "github", id: repo.id, owner: repo.owner, name: repo.name,
			branch: repo.defaultBranch, private: true, url: `${github.url}/${repo.owner}/${repo.name}` } } as SessionSummary;
		sessions.set(sessionId, session); return session;
	};
	const author = { id: "712020:abc123", name: "Ada;\nExample" };
	const event = (n: number): JiraFiling => ({
		issue: { id: String(10000 + n), identifier: `ENG-${n}`, url: `https://acme.atlassian.net/browse/ENG-${n}`, issueType: "Story", creator: author,
			title: "Add the greeting", description: "Print hello.\n- [ ] It prints hello\n<!-- hidden words -->", labels: ["windlass"] },
		project: { siteId: "acme-cloud", id: "10000" }, repository: { id: repo.id }, trigger: { via: "label", sender: author, at: Date.now() },
	});
	const file = (f: JiraFiling) => itemActions.internalJiraIntake(ctx, f, makeSession);
	const first = event(1);
	// Race two different qualifying deliveries for the same issue and site, with no previous filing.
	const assigned: JiraFiling = { ...first, trigger: { ...first.trigger, via: "assignment" } };
	const [filed, duplicate] = await Promise.all([file(first), file(assigned)]);
	assert.ok(filed.kind === "filed" && filed.state === "draft", JSON.stringify(filed));
	assert.deepEqual(duplicate, { kind: "exists", itemId: filed.itemId });
	const actor = actors.get(filed.itemId)!;
	const { item, meta } = actor.vars.stored!;
	const binding = meta.jira!;
	assert.equal(item.mode, "orchestrate"); assert.equal(item.run, null);
	assert.equal(meta.repository.id, repo.id); assert.equal(meta.repository.branch, repo.defaultBranch);
	assert.equal(meta.source, "jira"); assert.equal(meta.github, undefined); assert.equal(meta.linear, undefined);
	assert.deepEqual(await actor.db.execute("SELECT * FROM github_binding"), []);
	assert.equal(binding.siteId, first.project.siteId); assert.equal(binding.projectId, first.project.id);
	assert.deepEqual(binding.origin, { jira: { id: first.issue.id, identifier: "ENG-1", url: first.issue.url, author: "Ada Example", trusted: false }, sender: "Ada Example" });
	assert.match(String((await actor.db.execute("SELECT data FROM events ORDER BY seq"))[0].data), /Filed from Jira issue ENG-1/);
	assert.match(item.task.body, /> Print hello\./); assert.doesNotMatch(item.task.body, /hidden words/);
	assert.deepEqual(item.task.acceptance, ["Ada Example wrote: It prints hello"]);
	assert.deepEqual(item.untrusted, ["Jira issue ENG-1 by Ada Example"]);
	const { advance } = await import("../server/src/factory/blueprint.js");
	const started = advance(item, { kind: "start", at: Date.now(), by: "person:jira-filer" });
	const delivery = started.effects.find(e => e.kind === "deliver");
	assert.ok(delivery); assert.match(delivery.text, /> Print hello\./);
	assert.deepEqual(delivery.untrusted, item.untrusted);
	assert.equal(untrustedTurn({ profile: "docker-hardened", agent: "windlass", untrusted: delivery.untrusted, unsandboxed: false }).kind, "stop");
	await workItem.config.onWake!(actor);
	await drain();
	const itemUrl = `http://localhost:5173/items/${filed.itemId}`;
	const expected = { siteId: first.project.siteId, projectId: first.project.id, issueId: first.issue.id, itemId: filed.itemId, action: { key: "filed", itemUrl } };
	assert.deepEqual(attempts, [expected]);
	const [retry] = await actor.db.execute("SELECT attempts, due_at FROM effects WHERE id='jira_comment:filed'");
	assert.equal(retry.attempts, 1); assert.ok(Number(retry.due_at) > Date.now());
	await actor.db.execute("UPDATE effects SET due_at=0 WHERE id='jira_comment:filed'");
	Object.assign(actor, { vars: await lifecycle.createVars(actor) });
	await workItem.config.onWake!(actor); await drain();
	assert.deepEqual(attempts, [expected, expected]); assert.deepEqual(comments, [expected]);
	assert.equal((await actor.db.execute("SELECT 1 FROM effects WHERE id='jira_comment:filed'")).length, 0);
	assert.equal((await actor.db.execute("SELECT 1 FROM issue_actions WHERE subject='jira_comment:filed'")).length, 1);

	// The remaining writeback decisions use the real transition function; no CI or sandbox is needed.
	const pr = { number: 17, url: `https://github.com/acme/factory/pull/17` };
	const review = { ...item, state: "review" as const, pr };
	const actions = (before: typeof item, after: typeof item) => jiraEffects(before, after).map(e => e.action);
	assert.deepEqual(actions(item, review), [{ key: "opened", itemUrl, pr: pr.url }]);
	assert.deepEqual(actions(review, review), []);
	for (const state of ["done", "failed", "cancelled"] as const) {
		const ended = { ...review, state };
		assert.deepEqual(actions(review, ended), [{ key: state, itemUrl, pr: pr.url }]);
		assert.deepEqual(actions(ended, ended), []);
	}
	const waiting: typeof item = { ...item, state: "waiting", question: { id: "q1", kind: "turn_refused", askedAt: Date.now(), text: "Private owner question", choices: [], resume: null, cause: null } };
	assert.deepEqual(actions(item, waiting), []);
	assert.deepEqual(actions(waiting, { ...waiting, state: "failed" }), [{ key: "failed", itemUrl, pr: null }]);
	vars.items = await loadItems(db);
	assert.deepEqual(await file(assigned), { kind: "exists", itemId: filed.itemId });
	assert.equal(actors.size, 1);
	const otherSite = await file({ ...first, project: { ...first.project, siteId: "other-cloud" } });
	assert.ok(otherSite.kind === "filed" && otherSite.itemId !== filed.itemId);
	const cancelled = await workItem.config.actions!.internalAct(actor, { action: { kind: "cancel" }, by: "person:jira-filer" });
	await drain();
	assert.deepEqual(comments.map(c => c.action.key), ["filed", "cancelled"]);
	assert.deepEqual(comments[1].action, { key: "cancelled", itemUrl: comments[0].action.itemUrl, pr: null });
	const endedAt = cancelled.endedAt!;
	assert.ok(endedAt >= first.trigger.at);
	assert.deepEqual(await file(first), { kind: "exists", itemId: filed.itemId });
	const next = await file({ ...first, trigger: { ...first.trigger, at: endedAt + 1 } });
	assert.ok(next.kind === "filed" && next.itemId !== filed.itemId);
	assert.equal(actors.get(next.itemId)!.vars.stored!.meta.jira?.generation, 2);

	await saveAccountDefaults(db, { item_place: { place: "any-machine", harness: "claude" } }, Date.now());
	for (const [index, [issueType, label]] of [["Bug", "windlass"], ["Story", "bug"], ["Task", "Windlass-Quick"], ["Story", "windlass:quick"]].entries()) {
		const e = event(2 + index); Object.assign(e.issue, { issueType, labels: ["windlass", label] }); e.trigger.via = "assignment";
		const result = await file(e); assert.ok(result.kind === "filed");
		const made = actors.get(result.itemId)!.vars.stored!;
		assert.equal(made.item.mode, "single"); assert.equal(made.item.run, null);
		assert.equal(made.meta.jira?.via, "assignment"); assert.equal(made.meta.defaultPlace?.place, "any-machine");
	}
	const fresh = event(10), before = actors.size;
	assert.equal((await file({ ...fresh, issue: { ...fresh.issue, closed: true } })).kind, "ignored");
	assert.equal((await file({ ...fresh, trigger: { ...fresh.trigger, lapsed: true } })).kind, "ignored");
	assert.equal((await file({ ...fresh, issue: { ...fresh.issue, url: "javascript:invalid" } })).kind, "refused");
	repo.access.set(user.login, "read"); assert.equal((await file(fresh)).kind, "refused"); repo.access.set(user.login, "write");
	assert.equal(actors.size, before);

	// Existing GitHub/Linear drafts and an interrupted Jira reservation share the same last place.
	const now = Date.now(), pending = event(11), key = `jira:${pending.project.siteId}:${pending.issue.id}:1`;
	for (const source of ["github", "linear"]) {
		const fixture = { ...vars.items.items.get(filed.itemId), id: source, createdAt: now, state: "draft", source };
		await db.execute("INSERT INTO items VALUES (?, ?, ?, NULL, NULL)", source, now, JSON.stringify(fixture));
	}
	interrupt = true;
	await assert.rejects(file(pending), /could not be filed/i);
	interrupt = false;
	const [reservation] = await db.execute<{ id: string }>("SELECT id FROM github_item_keys WHERE key=?", key);
	assert.ok(reservation);
	vars.items = await loadItems(db);
	vars.items.limits.overrides.githubItemsPerDay = before + 3;
	const refused = await file(fresh);
	assert.ok(refused.kind === "refused" && refused.dailyCap, JSON.stringify(refused));
	assert.deepEqual(await file({ ...pending, trigger: { ...pending.trigger, lapsed: true } }), { kind: "filed", state: "draft", itemId: reservation.id });
	assert.equal((await file(pending)).kind, "exists");
	vars.items.limits.overrides.githubItemsPerDay++;
	const linear = { issue: { ...fresh.issue, creator: null, url: "https://linear.app/acme/issue/ENG-10" }, team: { workspaceId: "workspace", id: "team" },
		owner: { linearUserId: "owner" }, repository: fresh.repository, trigger: { ...fresh.trigger, sender: { id: "owner", name: "Owner" } } };
	const race = await Promise.all([file(fresh), itemActions.internalLinearIntake(ctx, linear, makeSession)]);
	assert.equal(race.filter(r => r.kind === "filed").length, 1, JSON.stringify(race));
	assert.equal(race.filter(r => r.kind === "refused" && r.dailyCap).length, 1, JSON.stringify(race));
	assert.equal(vars.items.items.size, before + 4);
	assert.ok(!github.requests.some(r => r.path.includes("/issues")), "Jira filing must not touch GitHub issues");
	console.log("PASS Jira factory: trust, modes, placement, permissions, concurrent intake, quota, recovery and lifecycle writeback");
} finally { for (const sqlite of databases) sqlite.close(); await github.stop(); }
