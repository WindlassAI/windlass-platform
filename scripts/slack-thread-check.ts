/** Run: cd server && npx tsx ../scripts/slack-thread-check.ts */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { FactoryItem } from "../server/src/factory/types.js";
import { slackBinding } from "../server/src/factory/intake.js";
import { SlackStandin } from "./slack-standin.js";

function store(path: string) {
	const sql = new DatabaseSync(path);
	const execute = async (query: string, ...args: SQLInputValue[]) => sql.prepare(query).all(...args);
	const db = { execute, async transaction<T>(job: (tx: { execute: typeof execute }) => Promise<T>) {
		sql.exec("BEGIN");
		try { const result = await job({ execute }); sql.exec("COMMIT"); return result; }
		catch (error) { sql.exec("ROLLBACK"); throw error; }
	} };
	return { sql, db };
}

const slack = await SlackStandin.start();
const tmp = mkdtempSync(join(tmpdir(), "wlp-slack-threads-"));
const workspace = store(":memory:");
const origin = "http://127.0.0.1:5173";
try {
	Object.assign(process.env, slack.env, { WLP_SECRET: randomBytes(32).toString("hex"), WLP_WEB_ORIGINS: origin });
	const { slackEffects, performSlackWrite } = await import("../server/src/slack/thread.js");
	const { workspaceOps, WORKSPACE_TABLES } = await import("../server/src/actors/slack-workspace.js");
	const { issueSlackState, slackCallbackResponse } = await import("../server/src/slack/connect.js");
	const { slackApp } = await import("../server/src/slack/app.js");
	const { advance, createItem, currentKey } = await import("../server/src/factory/blueprint.js");
	const { createGrant } = await import("../server/src/actors/internal.js");
	const { workItem, DUE_ACTION } = await import("../server/src/actors/work-item.js");
	const { FACTORY_DEFAULTS } = await import("../server/src/factory/budget.js");
	const { id: teamId } = slack.team, { channelId } = slack;
	const owner = "u_threads", repo = { id: 45, owner: "example", name: "mapped" };
	for (const ddl of WORKSPACE_TABLES) workspace.sql.exec(ddl);
	const ops = workspaceOps({ key: [teamId], db: workspace.db as never, vars: { queue: Promise.resolve() } });
	const back = await slack.authorize(slackApp()!.authorizeUrl(issueSlackState(owner, "nonce", origin)));
	const redirect = await slackCallbackResponse(new Request(back), { store: { claim: async (uid, nonce) => uid === owner && nonce === "nonce" } });
	const ticket = new URLSearchParams(new URL(redirect.headers.get("location")!).hash.slice(1)).get("slack");
	assert.ok(ticket);
	await ops.internalInstall(owner, ticket);

	for (const kind of ["app_mention", "command"] as const) {
		await ops.internalSaveMapping(owner, channelId, repo);
		const route = await ops.internalLookup(teamId, channelId, slack.installerId);
		assert.ok(route);
		const threadTs = kind === "app_mention" ? slack.mention().event.thread_ts : null;
		const destination = { teamId, channelId, repositoryId: repo.id, generation: route.generation, threadTs };
		const binding = slackBinding({ requesterUid: owner, repository: repo, generation: route.generation,
			delivery: { kind, teamId, channelId, threadTs, deliveryId: `delivery-${kind}`, userId: slack.installerId, text: "Private request", messageTs: threadTs, sentAt: 1 } });
		const meta = { source: "slack" as const, slack: binding };
		const id = `i_${kind}`, dbPath = join(tmp, id);
		const base = createItem({ id, task: { title: "Private title", body: "Private body", acceptance: [], base: "main" },
			mode: "orchestrate", place: { kind: "hosted" }, budget: FACTORY_DEFAULTS.item, reviewer: { off: "deployment" } });
		const filed = advance(base, { kind: "start", by: "person", at: 1 }).item;
		const filedTurn = currentKey(filed);
		assert.ok(filedTurn);
		const question = (key: string, kind: NonNullable<FactoryItem["question"]>["kind"]) => ({ id: key, kind, text: "Private question", choices: [], cause: null, askedAt: 100, resume: null });
		const plan: FactoryItem = { ...filed, revision: 1, state: "waiting", question: question("q_plan", "plan_approval"), filedTurn,
			featurePlan: { status: "proposed", version: 1, spec: { goal: "Private plan", requirements: [], outOfScope: [], acceptance: [] }, questions: [], subtasks: [], singleSuggested: null, budget: base.budget, compare: { singleBudget: base.budget } } };
		const asked: FactoryItem = { ...plan, revision: 2, question: question("q_secret", "secret_needed") };
		const pr: FactoryItem = { ...asked, revision: 3, question: null, state: "review", pr: { number: 9, url: "https://github.com/example/mapped/pull/9" } };
		const final: FactoryItem = { ...pr, revision: 4, state: kind === "command" ? "failed" : "done", run: { ...filed.run!, stopReason: "Private failure" } };
		const states = [filed, plan, asked, pr, final];
		assert.deepEqual(slackEffects({ ...meta, slack: { ...binding, generation: undefined } }, null, filed), [], "must not look up a replacement route");
		assert.equal(slackEffects(meta, null, asked).length, 2, "an already-waiting filing needs both receipt and question");
		const events = ["Work item filed", "Plan ready for approval", "Question ready", "Pull request opened", kind === "command" ? "Work item failed" : "Work item finished"];
		const effects = states.map((next, i) => {
			const before = states[i - 1] ?? null;
			for (const source of ["github", "web", "api", "linear"] as const) assert.deepEqual(slackEffects({ source }, before, next), []);
			assert.deepEqual(slackEffects(meta, next, { ...next, revision: next.revision + 1 }), [], "an unrelated edit is not a milestone");
			const milestone = slackEffects(meta, before, next);
			assert.equal(milestone.length, 1, events[i]);
			assert.deepEqual(slackEffects(meta, before, next), milestone, "redelivery regenerated a different effect key");
			return milestone[0];
		});
		let item = store(dbPath);
		try {
			assert.ok("db" in workItem.config);
			await workItem.config.db.onMigrate(item.db as never);
			const key = [owner, id];
			await workItem.config.onCreate!({ key, db: item.db, log: console } as never, { item: base, grant: createGrant("workItem", key), startedBy: "person", meta: {
				...meta, repository: { ...repo, provider: "github", url: "https://github.com/example/mapped", private: true, branch: "main" }, uid: owner,
				sessionId: "s_threads", createdAt: 1, activityAt: 1, verdict: null, reviewerSessionId: null, reviewBase: null, handoffReview: null, ledger: { seconds: 0, holds: [] },
			} });
			const start = slack.messages.length;
			const write = (i: number) => performSlackWrite(item.db as never, destination, id, effects[i], ops.internalPost);
			if (!threadTs) await assert.rejects(write(1), "must not post a slash follow-up before a parent exists");
			// Wake the real outbox against the stored item, first under a rate limit and then cold.
			item.sql.exec("DELETE FROM effects WHERE id NOT GLOB 'slack_write:*'"); // No agent sessions in this check.
			assert.deepEqual(JSON.parse(String(item.sql.prepare("SELECT effect FROM effects").get()?.effect)), effects[0]);
			for (const e of effects.slice(1)) item.sql.prepare("INSERT INTO effects VALUES(?,?,0,0)").run(`slack_write:${e.key}`, JSON.stringify(e));
			async function wake() {
				const ctx = { db: item.db, key: [owner, id], scheduledFire: { id: "timer", firedAt: 1, scheduledAt: 1 },
					log: { warn() {}, error(error: unknown) { throw error; } }, schedule: { at: async () => "timer", cancel: async () => true },
					client: () => ({ slackWorkspace: { get: ([team]: string[]) => { assert.equal(team, teamId); return ops; } } }) };
				assert.ok("createVars" in workItem.config);
				const vars = await workItem.config.createVars(ctx as never, undefined);
				await workItem.config.actions![DUE_ACTION]({ ...ctx, vars } as never);
			}
			slack.rateLimited = true;
			try { await wake(); } finally { slack.rateLimited = false; }
			assert.equal(item.sql.prepare("SELECT count(*) AS n FROM effects WHERE attempts=1 AND due_at>0").get()?.n, 1);
			item.sql.close(); item = store(dbPath); // Update pending, no slash root yet.
			item.sql.exec("UPDATE effects SET due_at=0");
			assert.equal(slack.messages.length, start);
			await wake();
			assert.equal(slack.messages[start].thread_ts, threadTs ?? undefined);
			const parent = threadTs ?? slack.messages[start].ts;
			item.sql.close(); item = store(dbPath); // Cold item: neither parent ts nor sent keys are in actor variables.
			for (let i = 1; i < effects.length; i++) await wake();
			assert.equal(item.sql.prepare("SELECT count(*) AS n FROM effects").get()?.n, 0);
			for (let i = 0; i < effects.length; i++) await write(i);
			const messages = slack.messages.slice(start);
			assert.deepEqual(messages.map(m => m.text), events.map(label => `${label}: ${origin}/items/${id}`));
			assert.ok(messages.every(m => m.channel === channelId));
			assert.ok(messages.slice(1).every(m => m.thread_ts === parent));
			if (kind === "command") await ops.internalDisconnect(owner);
			else await ops.internalSaveMapping(owner, channelId, repo); // Same repo, new authorization generation.
			const [stale] = slackEffects(meta, pr, { ...asked, revision: 5, question: question("q_later", "secret_needed") });
			assert.ok(stale);
			await performSlackWrite(item.db as never, destination, id, stale, ops.internalPost);
			assert.equal(slack.messages.length, start + events.length, "superseded mapping posted a new reply");
			console.log(`PASS ${kind}: acknowledgement, milestones, durable replay, retry and stale mapping`);
		} finally { item.sql.close(); }
	}
} finally {
	workspace.sql.close(); await slack.close(); rmSync(tmp, { recursive: true, force: true });
}
