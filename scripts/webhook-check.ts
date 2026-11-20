/** cd server && npx tsx ../scripts/webhook-check.ts. The engine node is the normal server
 * with test-only fixture actions attached before registry setup. No production action exposes SQL,
 * sets a test clock or installs a handler. All HTTP listeners use OS-assigned ports.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { GithubStandin } from "./github-standin.js";
import { localListeners } from "./check-listeners.js";
import { edge, isAddressed } from "../server/src/github/events.js";

const DAY = 86_400_000;
const RETRY_INSTALLATION = 91919;
const HEAD = "a".repeat(40);
const origin = "http://127.0.0.1:5173";
const base = (port: number) => "http://127.0.0.1:" + port;

async function testNode() {
	const { githubInbox, HANDLERS, githubHooks } = await import("../server/src/actors/github-inbox.js");
	const { requireServiceFor } = await import("../server/src/auth.js");
	const { githubAccount } = await import("../server/src/actors/github-account.js");
	const { githubRepository } = await import("../server/src/actors/github-repository.js");
	// This probe deliberately has no action-level guard, so it observes the connection hook alone.
	for (const definition of [githubAccount, githubRepository, githubInbox, githubHooks])
		Object.assign(definition.config.actions!, { checkConnection: () => true });
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	const { workItem } = await import("../server/src/actors/work-item.js");
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	const session = agentSession.config.actions!;
	const publish = session.internalPublish;
	// The fake sandbox pushes a branch without a git SHA. Give each published test PR a stable full head.
	session.internalPublish = async (c, input) => {
		const answer = await publish(c, input);
		return answer.kind === "published" ? { ...answer, head: answer.pr.number.toString(16).padStart(40, "0") } : answer;
	};
	type ItemCtx = Parameters<NonNullable<typeof workItem.config.actions>["internalView"]>[0];
	Object.assign(workItem.config.actions!, {
		checkPoll: async (c: ItemCtx) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT id, due_at, effect FROM effects WHERE id LIKE 'poll_%'"))[0] ?? null;
		},
	});
	const actions = githubInbox.config.actions!;
	type Ctx = Parameters<typeof actions.internalReceive>[0];
	const original = HANDLERS.installation!;
	const failures = new Map<string, number>();
	HANDLERS.installation = (d, c) => {
		if (d.installationId !== RETRY_INSTALLATION) return original(d, c);
		const tried = failures.get(d.guid) ?? 0;
		failures.set(d.guid, tried + 1);
		if (d.action === "suspended" || tried < 3) throw new Error("injected failure");
	};
	Object.assign(actions, {
		checkRow: async (c: Ctx, guid: string) => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute("SELECT state, said, attempts, next_at, received_at, data, CAST(repository AS TEXT) AS repository FROM deliveries WHERE guid = ?", guid);
			return r ?? null;
		},
		checkFixture: async (c: Ctx, kind: string, guid: string) => {
			requireServiceFor(c, "call");
			if (kind === "retry") await c.db.execute("UPDATE deliveries SET next_at = 0 WHERE guid = ?", guid);
			if (kind === "expire") await c.db.execute("UPDATE deliveries SET received_at = ? WHERE guid = ?", Date.now() - 8 * DAY, guid);
			if (kind === "capacity") {
				const now = Date.now();
				await c.db.execute(`WITH RECURSIVE ns(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ns WHERE i < 20000)
					INSERT INTO deliveries SELECT 'fixture-' || i, 'status', '', 1, '{}', ? + i,
					CASE WHEN i = 1 THEN 'failed' WHEN i = 2 THEN 'ignored' ELSE 'done' END, 1, 0, '' FROM ns`, now - DAY);
			}
			if (kind === "full") await c.db.execute(`WITH RECURSIVE ns(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ns WHERE i < 2000)
				INSERT INTO deliveries SELECT 'fixture-' || i, 'status', '', 1, '{}', ?, 'received', 0, ?, '' FROM ns`, Date.now(), Date.now() + DAY);
		},
	});
	Object.assign(githubHooks.config.actions!, {
		checkFallback: (c: Ctx, ms: number | null) => {
			requireServiceFor(c, "call");
			if (ms === null) delete process.env.WLP_GITHUB_POLL_FALLBACK;
			else process.env.WLP_GITHUB_POLL_FALLBACK = "1";
			Object.assign(CI_POLLING, { webhookEveryMs: ms ?? 300_000 });
		},
		checkStarted: async (c: Ctx) => {
			requireServiceFor(c, "call");
			const [r] = await c.db.execute<{ at: number }>("SELECT at FROM timer");
			return r?.at ?? null;
		},
	});
	await import("../server/src/index.js");
}

async function until<T>(label: string, probe: () => Promise<T>, timeout = 12_000) {
	const end = Date.now() + timeout;
	do {
		const answer = await probe();
		if (answer) return answer;
		await sleep(60);
	} while (Date.now() < end);
	throw new Error("timed out waiting for " + label);
}

async function run() {
	const { engine, http: [http] } = await localListeners();
	const api = base(http);
	let second: string;
	const storage = mkdtempSync(join(tmpdir(), "wlp-webhook-check-"));
	const standin = new GithubStandin({ callbackUrl: api + "/github/callback", slug: "windlass-fk4w", strictBranches: false });
	await standin.start();
	const secret = randomBytes(32).toString("hex"), previous = randomBytes(32).toString("hex");
	const bodyMarker = "private-issue-" + randomUUID();
	Object.assign(process.env, standin.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"), WLP_GITHUB_WEBHOOK_SECRET: secret,
		WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS: previous, WLP_SANDBOX: "fake", WLP_DEMO: "1", WLP_HTTP_PORT: String(http),
		RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(engine), WLP_WEB_ORIGINS: origin, RIVET_LOG_LEVEL: "silent",
	});
	for (const key of ["RIVET_ADMIN_TOKEN", "RIVET_ENDPOINT", "RIVET_ENGINE", "PORT", "WLP_GITHUB_POLL_FALLBACK"]) delete process.env[key];
	const { updateGithubAccount } = await import("../server/src/actors/github-account.js");
	const { webhookRoute } = await import("../server/src/github/webhook.js");
	const { createClient } = await import("../server/src/client.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { githubConfig } = await import("../server/src/config.js");
	const client = createClient<import("../server/src/registry.js").Registry>({ endpoint: base(engine) });
	const service = () => ({ params: serviceParams() });
	const inbox = (id: number | string) => client.githubInbox.getOrCreate([String(id)], service());
	type Row = { data: string; repository: string | null; state: string; said: string; attempts: number; next_at: number; received_at: number };
	const fixture = (id: number | string) => inbox(id) as unknown as { checkRow(guid: string): Promise<Row | null>; checkFixture(op: string, guid: string): Promise<void> };
	const shaPayload = { installation: { id: 91234 }, repository: { id: 123 }, sha: HEAD, state: "success", description: bodyMarker };
	const web = api + "/github/webhook";
	const send = (payload = shaPayload, guid = randomUUID(), url = web) => standin.deliver(url, "status", payload, { secret, guid });
	const local = async (options: { event?: string; body?: string; signBytes?: string; secret?: string; guid?: string; omit?: string; target?: string; method?: string; url?: string } = {}) => {
		const body = options.body ?? JSON.stringify(shaPayload);
		const headers = new Headers({ "x-github-event": options.event ?? "status", "x-github-delivery": options.guid ?? randomUUID(),
			"x-github-hook-installation-target-id": options.target ?? standin.appId,
			"x-hub-signature-256": "sha256=" + createHmac("sha256", options.secret ?? secret).update(options.signBytes ?? body).digest("hex") });
		if (options.omit) headers.delete(options.omit);
		const method = options.method ?? "POST";
		return (await webhookRoute(new Request(options.url ?? web, { method, headers, body: method === "POST" ? body : undefined })))!;
	};
	const failed: string[] = [];
	const check = async (name: string, fn: () => Promise<void> | void) => {
		try { await fn(); console.log("PASS " + name); }
		catch (error) {
			failed.push(name);
			// Assertion messages can include the actual body or headers. Print only the check location.
			const location = error instanceof Error ? /webhook-check\.ts:(\d+:\d+)/.exec(error.stack ?? "")?.[1] : undefined;
			console.error("FAIL " + name + (location ? " at webhook-check.ts:" + location : ""));
		}
	};
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server", import.meta.url)), env: { ...process.env, WLP_ITEMS: "1", WLP_FAKE_DELAY_MS: "10" }, stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "";
	child.stdout.on("data", b => { logs += b.toString(); });
	child.stderr.on("data", b => { logs += b.toString(); });
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	let offline = false;
	// A second route process on another port shares only the engine with the platform node.
	const other = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const b of req) chunks.push(b);
		const response = offline ? new Response(null, { status: 503 }) : await webhookRoute(new Request(second, {
			method: "POST", headers: req.headers as Record<string, string>, body: Buffer.concat(chunks),
		}));
		res.writeHead(response?.status ?? 404);
		res.end(await response?.text());
	});
	try {
		await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
		second = base((other.address() as AddressInfo).port) + "/github/webhook";
		await until("the platform HTTP port", async () => {
			if (child.exitCode !== null) throw new Error("test node exited " + child.exitCode);
			return (await fetch(api + "/platform/info").catch(() => null))?.ok;
		}, 90_000);
		const known = (guid: string, id: number | string = shaPayload.installation.id) => inbox(id).internalKnows(guid);
		const connection = (ids: (number | string)[]) => ({
			webhookLinked: true, connectedAt: Date.now(), user: { id: 7, login: "fixture" },
			installations: ids.map(id => ({ id, account: { id, login: "fixture", type: "Organization" as const }, htmlUrl: "" })),
		});
		const accountContext = { client: () => client };
		await updateGithubAccount(accountContext, "fixture", null, connection([91234, 92222, 92123, 92678]));
		const absent = (e: unknown) => (e as { group?: string; code?: string })?.group === "actor" && (e as { code: string }).code === "not_found";
		const owner = "g2-owner";
		standin.addUser(owner);
		const installation = standin.addInstallation(owner, "User");
		const projectG2 = standin.addRepository({ owner, name: "factory", installation });
		Object.assign(standin.appPermissions, { checks: "read", statuses: "read", actions: "read" });
		const connectUser = async (login: string) => {
			const auth = await client.login.getOrCreate([randomUUID()]).demo();
			const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
			const connect = await user.githubConnect({ origin });
			const back = await fetch(standin.authorize(login, connect.url), { redirect: "manual" });
			await user.githubComplete(back.headers.get("location")!.split("#github=")[1]);
			return { uid: auth.profile.uid, user };
		};
		const { uid, user: g2User } = await connectUser(owner);
		standin.addUser("g2-neighbour");
		const neighbour = standin.addInstallation("g2-neighbour", "User");
		standin.addRepository({ owner: "g2-neighbour", name: "other", installation: neighbour });
		await connectUser("g2-neighbour");
		const directory = () => client.githubRepository.getOrCreate([String(projectG2.id)], service());
		const push = async () => {
			const item = await g2User.createItem({ repository: { id: projectG2.id }, title: "A webhook check", body: "Add a short program.", start: true });
			const handle = () => client.workItem.get([uid, item.id], service());
			const poll = () => (handle() as unknown as { checkPoll(): Promise<{ id: string; due_at: number; effect: string } | null> }).checkPoll();
			const published = await until("registered push", async () => {
				const view = await g2User.item(item.id);
				if (view.head && view.pullRequest && (await directory().internalFind({ head: view.head, installationId: installation.id })).some(r => r.itemId === item.id)) return { head: view.head, pr: view.pullRequest.number };
			}, 45_000);
			return { ...published, id: item.id, handle, poll, view: () => g2User.item(item.id) };
		};
		const delivered = async (event: string, fields: object, id: number | string = installation.id) => {
			const guid = randomUUID();
			const res = await standin.deliver(web, event, { installation: { id }, repository: { id: projectG2.id, name: "decoy", owner: { login: "decoy" } }, ...fields }, { secret, guid });
			assert.deepEqual(await res.json(), { taken: true });
			return until("handled " + event, async () => {
				const row = await fixture(id).checkRow(guid);
				return row && ["done", "ignored"].includes(row.state) ? row : null;
			});
		};
		const countReads = (head: string) => standin.requests.filter(r => r.path.includes("/commits/" + head + "/check-runs")).length;
		const ci = (head: string, state: string) => projectG2.ci.set(head, { runs: [], statuses: [{ context: "required", state }] });
		await check("G2 signed CI and PR nudges, coalescing, installation isolation and live readings", async () => {
			const item = await push();
			const first = await item.poll(); assert.ok(first);
			const initial = await item.view();
			assert.equal(first.due_at - initial.events.find(e => e.said.startsWith("Pushed "))!.at, 60_000);
			const suite = (head: string) => ({ action: "completed", check_suite: { head_sha: head, conclusion: "success" } });
			const foreign = neighbour.id;
			await directory().internalRegister({ uid, itemId: "i_missing", head: "f".repeat(40), installationId: installation.id });
			const calls = standin.requests.length;
			assert.equal((await delivered("check_suite", suite("f".repeat(40)))).said, "no item");
			assert.deepEqual(await directory().internalFind({ head: "f".repeat(40) }), []);
			assert.equal((await delivered("check_suite", suite(item.head), foreign)).said, "no item");
			assert.deepEqual(await directory().internalFind({ head: item.head, installationId: foreign }), []);
			const target = { kind: "ci" as const, repositoryId: projectG2.id, installationId: installation.id, head: item.head };
			assert.equal(await item.handle().internalGithubNudge({ ...target, installationId: foreign }), false);
			assert.equal(await item.handle().internalGithubNudge({ ...target, head: "f".repeat(40) }), false);
			assert.deepEqual(await item.poll(), first);
			assert.equal((await item.view()).revision, initial.revision);
			assert.equal(standin.requests.length, calls);
			console.log("PASS G2 other SHA and linked foreign installation leave the waiting row intact and make zero GitHub calls");

			projectG2.name = "renamed-factory";
			ci(item.head, "pending");
			const sent = Date.now();
			const handled = await delivered("check_suite", suite(item.head));
			assert.equal(handled.state, "done");
			const early = await item.poll(); assert.ok(early);
			assert.deepEqual({ ...early, due_at: first.due_at }, first);
			assert.ok(early.due_at <= Date.now() + 15_000 && early.due_at < first.due_at);
			assert.equal((await item.view()).revision, initial.revision);
			await until("one pending live CI read", async () => (await item.view()).wait?.sentence.includes("0 of 1"), 20_000);
			assert.equal(countReads(item.head), 1);
			assert.ok(Date.now() - sent < 20_000);
			assert.ok(standin.requests.some(r => r.path.endsWith("/repositories/" + projectG2.id) && r.status === 200));
			assert.ok(standin.requests.some(r => r.path.includes("/renamed-factory/commits/" + item.head) && r.status === 200));
			console.log(`PASS G2 signed suite caused one CI read in ${Date.now() - sent} ms; claimed success, GitHub pending`);

			const began = Date.now();
			const guids = Array.from({ length: 30 }, () => randomUUID());
			const burst = guids.map(guid => standin.deliver(web, "check_run", { installation: { id: installation.id }, repository: { id: projectG2.id },
				action: "completed", check_run: { head_sha: item.head, conclusion: "failure" } }, { secret, guid }));
			for (const res of await Promise.all(burst)) assert.deepEqual(await res.json(), { taken: true });
			const receipts = await Promise.all(guids.map(guid => fixture(installation.id).checkRow(guid)));
			const times = receipts.map(row => { assert.ok(row); return row.received_at; });
			assert.ok(Math.max(...times) - Math.min(...times) <= 2000);
			const coalesced = await item.poll(); assert.ok(coalesced);
			assert.ok(coalesced.due_at >= began + 15_000 && coalesced.due_at <= Date.now() + 15_000);
			await until("burst CI read", async () => countReads(item.head) >= 2, 20_000);
			await until("next CI poll stored", async () => { const row = await item.poll(); return row && row.id !== coalesced.id; });
			assert.equal(countReads(item.head), 2);
			assert.ok((await item.poll())!.due_at > Date.now() + 20_000);
			assert.equal(logs.split("factory.ci.nudge_found item=" + item.id).length - 1, 1);
			console.log("PASS G2 thirty signed check runs coalesced into one more read");

			ci(item.head, "success");
			assert.equal((await delivered("status", { sha: item.head, state: "failure" })).state, "done");
			const review = await until("live CI passed", async () => { const v = await item.view(); return v.state === "review" ? v : null; }, 20_000);
			assert.equal(review.verdict?.ci, "passed");
			const closed = { action: "closed", pull_request: { number: item.pr, merged: true, head: { sha: item.head } } };
			const prPoll = await item.poll(); assert.ok(prPoll);
			await delivered("pull_request", closed);
			await until("live PR still open", async () => (await item.poll())?.id !== prPoll.id, 20_000);
			assert.equal((await item.view()).state, "review");
			const pull = standin.pulls.find(p => p.repository === projectG2.id && p.number === item.pr)!;
			pull.state = "closed"; pull.merged = true;
			const mergedAt = Date.now();
			await delivered("pull_request", closed);
			await until("fetched merge", async () => (await item.view()).state === "done", 20_000);
			assert.ok(Date.now() - mergedAt < 20_000);
			await until("directory removal", async () => !(await directory().internalFind({ pr: item.pr })).length);
			const rev = (await item.view()).revision;
			assert.equal(await item.handle().internalGithubNudge(target), false);
			assert.equal((await delivered("pull_request", closed)).said, "no item");
			assert.equal((await item.view()).revision, rev);
			console.log("PASS G2 open PR stayed in review; fetched merge ended item and removed its binding");
		});
		await check("G2 webhook fallback reaches review with zero deliveries", async () => {
			const clock = client.githubHooks.getOrCreate(["app"], service()) as unknown as { checkFallback(ms: number | null): Promise<void> };
			await clock.checkFallback(3500);
			try {
				const sent = standin.deliveries.length;
				projectG2.name = "factory";
				const item = await push();
				const first = await item.poll(); assert.ok(first);
				const view = await item.view();
				assert.equal(first.due_at - view.events.find(e => e.said.startsWith("Pushed "))!.at, 3500);
				ci(item.head, "success");
				await until("fallback read hands off", async () => (await item.view()).verdict?.ci === "passed", 12_000);
				assert.equal(countReads(item.head), 1);
				assert.equal(standin.deliveries.length, sent);
			} finally { await clock.checkFallback(null); }
		});
		await check("unlinked status creates no inbox, installation lifecycle events are admitted", async () => {
			const id = 93333, guid = randomUUID();
			const res = await send({ ...shaPayload, installation: { id } }, guid);
			assert.equal(res.status, 202); assert.deepEqual(await res.json(), { taken: false });
			await assert.rejects(client.githubInbox.get([String(id)]).resolve(), absent);
			for (const event of ["installation", "installation_repositories"]) {
				const lifecycle = await standin.deliver(web, event, { action: "created", installation: { id } }, { secret });
				assert.deepEqual(await lifecycle.json(), { taken: true });
			}
			assert.equal(await known(guid, id), false);
		});
		await check("changing a user's installation list removes its old memberships", async () => {
			const before = connection([94444, 95555]), after = connection([95555]);
			const payload = { ...shaPayload, installation: { id: 94444 } };
			await updateGithubAccount(accountContext, "changing", null, before);
			assert.deepEqual(await (await send(payload)).json(), { taken: true });
			await updateGithubAccount(accountContext, "changing", before, after);
			const guid = randomUUID();
			assert.deepEqual(await (await send(payload, guid)).json(), { taken: false });
			assert.equal(await known(guid, 94444), false);
			await updateGithubAccount(accountContext, "changing", after, null);
		});
		await check("edge table and its excluded neighbours", () => {
			const user = { id: 5, login: "ada", type: "User" };
			const subject = { id: 7, user, author_association: "OWNER", body: "@windlass-fk4w fix", commit_id: HEAD, path: "src/a", line: 9 };
			const p = { ...shaPayload, action: "created", sender: user, issue: { number: 3, user, author_association: "OWNER" },
				pull_request: { number: 4, head: { sha: HEAD }, merged: false }, review: { ...subject, state: "changes_requested" }, comment: subject };
			const meta = { guid: randomUUID(), at: 42, slug: standin.slug };
			const take = (event: string, changes: object) => edge(event, { ...p, ...changes }, meta);
			for (const action of ["labeled", "unlabeled", "closed", "reopened", "edited", "deleted", "transferred"]) {
				assert.equal(take("issues", { action, label: { name: "windlass" } })?.event, "issues", action);
			}
			assert.equal(take("issues", { action: "labeled", label: { name: "else" } }), null);
			assert.equal(take("issues", { action: "opened" }), null);
			const comment = take("issue_comment", { comment: { ...subject, body: "/windlass " + "x".repeat(20_000) }, issue: { ...p.issue, pull_request: {} } });
			assert.ok(comment?.event === "issue_comment" && comment.data.isPullRequest && comment.data.body.length === 16_000 && comment.data.body.endsWith("…"));
			for (const changes of [{ comment: { ...subject, body: "hello @windlass-fk4w" } }, { sender: { ...user, type: "Bot" } }, { action: "edited" }])
				assert.equal(take("issue_comment", changes), null);
			for (const action of ["closed", "reopened", "synchronize"]) assert.deepEqual(take("pull_request", { action })?.data, { pr: 4, head: HEAD, merged: false });
			assert.equal(take("pull_request", { action: "opened" }), null);
			assert.ok(take("pull_request_review", { action: "submitted", review: { ...p.review, body: "" } }));
			assert.ok(take("pull_request_review", { action: "submitted", review: { ...p.review, state: "commented" } }));
			assert.equal(take("pull_request_review", { action: "submitted", review: { ...subject, state: "approved", body: "ok" } }), null);
			assert.ok(take("pull_request_review_comment", {}));
			assert.equal(take("pull_request_review_comment", { comment: { ...subject, body: "fix" } }), null);
			for (const event of ["check_suite", "check_run"]) {
				assert.deepEqual(take(event, { action: "completed", [event]: { head_sha: HEAD } })?.data, { head: HEAD });
				assert.equal(take(event, { action: "created", [event]: { head_sha: HEAD } }), null);
			}
			for (const state of ["success", "failure", "error"]) assert.deepEqual(take("status", { state })?.data, { head: HEAD });
			assert.equal(take("status", { state: "pending" }), null);
			for (const event of ["installation", "installation_repositories"])
				assert.deepEqual(take(event, { repositories_added: [{ id: 9 }], repositories_removed: [{ id: 8 }] })?.data, { repositoryIds: [9, 8] });
			assert.equal(take("push", {}), null);
			assert.equal(take("status", { installation: {} }), null);
			assert.equal(isAddressed(" \n@WINDLASS-FK4W fix it", standin.slug), "fix it");
			assert.equal(isAddressed("/WINDLASS", standin.slug), "");
			assert.equal(isAddressed("@windlass-fk4w-more hi", standin.slug), null);
		});
		const wideInstallation = 9007199254740993n;
		await updateGithubAccount(accountContext, "wide", null, connection([String(wideInstallation)]));
		await check("signed comments and reviews keep adjacent 64-bit repository, sender and subject ids", async () => {
			for (const event of ["issue_comment", "pull_request_review_comment", "pull_request_review"]) {
				const review = event === "pull_request_review", guid = randomUUID();
				const subject = { id: 9007199254740995n, body: "/windlass fix", state: "changes_requested", commit_id: HEAD, path: "a" };
				const payload = { action: review ? "submitted" : "created", installation: { id: wideInstallation },
					repository: { id: 9007199254740996n }, sender: { id: 9007199254740997n, login: "ada", type: "User" },
					issue: { number: 4 }, pull_request: { number: 4 }, [review ? "review" : "comment"]: subject };
				assert.deepEqual(await (await standin.deliver(web, event, payload, { secret, guid })).json(), { taken: true });
				const row = await fixture(String(wideInstallation)).checkRow(guid);
				assert.equal(row?.repository, "9007199254740996");
				const data = JSON.parse(row.data);
				assert.equal(data.sender.id, "9007199254740997");
				assert.equal(review ? data.reviewId : data.commentId, "9007199254740995");
			}
		});
		await check("signed status without a waiting item is ignored", async () => {
			const guid = randomUUID(), r = await send(shaPayload, guid);
			assert.equal(r.status, 202); assert.deepEqual(await r.json(), { taken: true }); assert.equal(await known(guid), true);
			const row = await until("ignored", async () => { const r = await fixture(91234).checkRow(guid); return r?.state === "ignored" ? r : null; });
			assert.equal(row.said, "no item"); assert.equal(row.attempts, 1);
		});
		await check("installation events finish with one metadata log", async () => {
			for (const event of ["installation", "installation_repositories"]) {
				const guid = randomUUID(), id = 91234;
				const payload = { installation: { id }, action: "created", repositories: [{ id: 13 }], description: bodyMarker };
				assert.equal((await standin.deliver(web, event, payload, { secret, guid })).status, 202);
				await until("installation handled", async () => (await fixture(id).checkRow(guid))?.state === "done");
				assert.equal(logs.split(`github.installation event=${event}.created installation=${id} delivery=${guid}`).length - 1, 1);
			}
		});
		await check("bad signature stores nothing", async () => {
			const guid = randomUUID();
			const r = await standin.deliver(web, "status", shaPayload, { secret: randomBytes(32).toString("hex"), guid });
			assert.equal(r.status, 401); assert.equal(await known(guid), false);
		});
		await check("missing headers store nothing", async () => {
			for (const omit of ["x-hub-signature-256", "x-github-event", "x-github-delivery"]) {
				const guid = randomUUID(); assert.equal((await local({ omit, guid })).status, 400); assert.equal(await known(guid), false);
			}
		});
		await check("raw bytes before JSON", async () => {
			const body = JSON.stringify(shaPayload, null, 2);
			assert.equal((await local({ body, signBytes: JSON.stringify(shaPayload) })).status, 401);
			assert.equal((await local({ body })).status, 202);
			assert.equal((await local({ body: "{", signBytes: "different" })).status, 401);
		});
		await check("previous secret rotation", async () => {
			try {
				assert.equal((await local({ secret: previous })).status, 202);
				delete process.env.WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS;
				assert.equal((await local({ secret: previous })).status, 401);
			} finally { process.env.WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS = previous; }
		});
		await check("target App before JSON", async () => {
			assert.equal((await local({ target: "7777", body: "{" })).status, 403);
		});
		await check("off without current secret or App", async () => {
			try {
				delete process.env.WLP_GITHUB_WEBHOOK_SECRET;
				const r = await local({ method: "GET" }); assert.equal(r.status, 404); assert.equal(r.headers.get("cache-control"), "no-store");
				assert.equal((await send(shaPayload, randomUUID(), second)).status, 404);
				process.env.WLP_GITHUB_WEBHOOK_SECRET = secret;
				delete process.env.WLP_GITHUB_APP_ID;
				assert.equal((await local()).status, 404);
			} finally { process.env.WLP_GITHUB_WEBHOOK_SECRET = secret; process.env.WLP_GITHUB_APP_ID = standin.appId; }
		});
		await check("fallback accepts only 1 with a current webhook secret", () => {
			assert.equal(githubConfig().pollFallback, false);
			assert.equal(githubConfig({ ...process.env, WLP_GITHUB_POLL_FALLBACK: "1" }).pollFallback, true);
			assert.throws(() => githubConfig({ WLP_GITHUB_POLL_FALLBACK: "1" }), /requires WLP_GITHUB_WEBHOOK_SECRET/);
			assert.throws(() => githubConfig({ WLP_GITHUB_POLL_FALLBACK: "0" }), /1 or unset/);
		});
		await check("invalid short secrets name only the setting", () => {
			for (const name of ["WLP_GITHUB_WEBHOOK_SECRET", "WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS"]) {
				for (const value of ["", "short"]) assert.throws(() => githubConfig({ [name]: value }), (e: Error) => e.message === name + " must be at least 32 characters long");
			}
		});
		await check("POST method required", async () => {
			assert.equal((await local({ method: "GET" })).status, 405);
		});
		await check("two MiB body limit", async () => {
			const guid = randomUUID(), large = JSON.stringify(shaPayload).padEnd(2 * 1024 * 1024 + 1);
			assert.equal((await local({ body: large, guid })).status, 413); assert.equal(await known(guid), false);
		});
		await check("listener rejects a chunked body over three MiB before webhook header validation", async () => {
			const cap = 3 * 1024 * 1024;
			assert.equal((await fetch(web, { method: "POST", body: new Uint8Array(cap) })).status, 400);
			const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(cap)); c.enqueue(Uint8Array.of(1)); c.close(); } });
			const request: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
			const res = await fetch(web, request);
			assert.equal(res.status, 413); assert.equal(await res.text(), "Payload Too Large");
		});
		await check("invalid JSON", async () => {
			assert.equal((await local({ body: "{" })).status, 400);
		});
		await check("ping acknowledged without storage", async () => {
			const guid = randomUUID();
			const r = await local({ event: "ping", guid }); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { taken: false });
			assert.equal(await known(guid), false);
		});
		await check("duplicate and two installations", async () => {
			const guid = randomUUID();
			const one = await send(shaPayload, guid); assert.deepEqual(await one.json(), { taken: true });
			const two = await send(shaPayload, guid); assert.deepEqual(await two.json(), { taken: "duplicate" });
			assert.equal(await known(guid, 92222), false);
			assert.deepEqual(await (await send({ ...shaPayload, installation: { id: 92222 } }, guid)).json(), { taken: true });
			assert.equal(await known(guid, 92222), true);
			assert.equal(logs.split("github.delivery.stored event=status installation=91234 delivery=" + guid).length - 1, 1);
		});
		await check("two HTTP servers one concurrent GUID", async () => {
			const guid = randomUUID();
			const replies = await Promise.all([web, second].map(async url => (await (await send(shaPayload, guid, url)).json()).taken));
			assert.deepEqual(replies.map(String).sort(), ["duplicate", "true"]);
			assert.equal(await known(guid), true);
		});
		for (const [action, total, terminal] of [["created", 4, "done"], ["suspended", 8, "failed"]] as const) {
			await check("retry to " + terminal + " in " + total + " attempts", async () => {
				const guid = randomUUID(), id = RETRY_INSTALLATION;
				const res = await standin.deliver(web, "installation", { action, installation: { id } }, { secret, guid });
				assert.equal(res.status, 202);
				for (let attempt = 1; attempt <= total; attempt++) {
					const row = await until("handler attempt " + attempt, async () => {
						const r = await fixture(id).checkRow(guid); return r && r.attempts >= attempt ? r : null;
					}, 20_000);
					assert.equal(row.attempts, attempt);
					if (attempt === total) { assert.equal(row.state, terminal); break; }
					assert.equal(row.state, "received");
					const delay = row.next_at - Date.now(), expected = Math.min(1_800_000, 15_000 * 2 ** (attempt - 1));
					assert.ok(delay <= expected && delay >= expected - 5_000, "retry delay");
					if (attempt === 1 && terminal === "done") continue; // Let the real 15 s schedule fire once.
					await fixture(id).checkFixture("retry", guid);
					await inbox(id).internalDue();
				}
			});
		}
		await check("waiting limit maps to HTTP 503", async () => {
			const id = 92123, guid = randomUUID();
			await fixture(id).checkFixture("full", "");
			const res = await send({ ...shaPayload, installation: { id } }, guid);
			assert.equal(res.status, 503); assert.equal(await known(guid, id), false);
		});
		await check("twenty thousand rows evict oldest finished first", async () => {
			const id = 92678;
			await fixture(id).checkFixture("capacity", "");
			assert.equal((await send({ ...shaPayload, installation: { id } })).status, 202);
			assert.equal(await known("fixture-1", id), true); // failed
			assert.equal(await known("fixture-2", id), false); // oldest ignored
			assert.equal(await known("fixture-3", id), true);
		});
		await check("seven day retention", async () => {
			const guid = randomUUID();
			await send(shaPayload, guid);
			await fixture(91234).checkFixture("expire", guid);
			await until("expired row removed", async () => {
				await inbox(91234).internalDue();
				return (await fixture(91234).checkRow(guid)) === null;
			});
		});
		const ada = standin.addUser("ada");
		const install = standin.addInstallation("ada", "User");
		const project = standin.addRepository({ owner: "ada", name: "project", installation: install });
		const repo = client.githubRepository.getOrCreate([String(project.id)], service());
		await check("permission gate, scoped token, cache and 404", async () => {
			const args = { installationId: install.id, owner: "ada", name: "project", userId: ada.id, login: "ada", associations: "NONE" };
			const before = standin.requests.length;
			assert.equal(await repo.internalPermission(args), "none"); assert.equal(standin.requests.length, before);
			const writer = { ...args, associations: "COLLABORATOR" };
			assert.equal(await repo.internalPermission(writer), "admin");
			assert.deepEqual(standin.minted.at(-1)?.repositoryIds, [project.id]); assert.deepEqual(standin.minted.at(-1)?.permissions, { metadata: "read" });
			const after = standin.requests.length; assert.ok(after > before);
			assert.equal(await repo.internalPermission(writer), "admin"); assert.equal(standin.requests.length, after);
			assert.equal(await repo.internalPermission(args), "none"); assert.equal(standin.requests.length, after);
			assert.equal(await repo.internalPermission({ ...writer, login: "gone", userId: 999999 }), "none");
			assert.ok(standin.requests.some(r => r.status === 404 && r.path.endsWith("/gone/permission")));
		});
		await check("repository registration, lookup and removal", async () => {
			const row = { uid: "one", itemId: "item", issue: 12, generation: 1 };
			await repo.internalRegister(row);
			await repo.internalRegister({ uid: "one", itemId: "item", pr: 13, head: HEAD });
			for (const key of [{ issue: 12 }, { pr: 13 }, { head: HEAD }]) assert.equal((await repo.internalFind(key))[0]?.itemId, "item");
			await assert.rejects(repo.internalRegister({ ...row, uid: "two", itemId: "another" }));
			await repo.internalForget("item"); assert.equal((await repo.internalFind({ issue: 12 })).length, 0);
		});
		await check("64-bit installation bindings distinguish adjacent IDs and a new head replaces the old one", async () => {
			const a = "9007199254740995", b = "9007199254740996", row = { itemId: "wide-item", uid: "one", pr: 14, installationId: a };
			await repo.internalRegister({ ...row, head: HEAD });
			await repo.internalRegister({ ...row, head: "b".repeat(40) });
			assert.equal((await repo.internalFind({ pr: 14, installationId: a })).length, 1);
			assert.deepEqual(await repo.internalFind({ pr: 14, installationId: b }), []);
			assert.deepEqual(await repo.internalFind({ head: HEAD }), []);
			await repo.internalForget(row.itemId);
		});
		await check("connect, replace, old disconnect, current disconnect", async () => {
			const connect = async () => {
				const auth = await client.login.getOrCreate([randomUUID()]).demo();
				const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
				const { url } = await user.githubConnect({ origin });
				const back = await fetch(standin.authorize("ada", url), { redirect: "manual" });
				const ticket = back.headers.get("location")?.split("#github=")[1]; assert.ok(ticket, "ticket issued");
				await user.githubComplete(ticket);
				return { user, uid: auth.profile.uid };
			};
			const account = client.githubAccount.getOrCreate([String(ada.id)], service());
			const payload = { ...shaPayload, installation: { id: install.id } };
			const taken = async () => (await (await send(payload)).json()).taken;
			const a = await connect(); assert.equal(await taken(), true); assert.deepEqual(await account.internalWho(), { uid: a.uid, installations: [install.id] });
			const b = await connect(); assert.deepEqual(await account.internalWho(), { uid: b.uid, installations: [install.id] });
			await a.user.githubDisconnect(); assert.equal((await account.internalWho())?.uid, b.uid); assert.equal(await taken(), true);
			await b.user.githubDisconnect(); assert.equal(await account.internalWho(), null); assert.equal(await taken(), false);
		});
		await check("service-only actors", async () => {
			await assert.rejects(client.githubAccount.getOrCreate(["1"]).internalWho());
			await assert.rejects(client.githubInbox.getOrCreate(["1"]).internalKnows(randomUUID()));
			await assert.rejects(client.githubRepository.getOrCreate(["1"]).internalFind({ pr: 1 }));
			await assert.rejects(client.githubHooks.getOrCreate(["app"]).internalSweep());
		});
		for (const [name, valid, invalid] of [
			["githubInbox", ["1"], ["1", "2"]], ["githubAccount", ["1"], ["01"]],
			["githubRepository", ["9007199254740993"], ["9223372036854775808"]], ["githubHooks", ["app"], ["other"]],
		] as const) {
			const actors = client[name];
			const probe = (handle: unknown) => (handle as { checkConnection(): Promise<boolean> }).checkConnection();
			await check(name + " refuses external connections before dispatch", async () => {
				assert.equal(await probe(actors.getOrCreate([...valid], service())), true);
				await assert.rejects(probe(actors.get([...valid])), (e: { code: string }) => e.code === "unauthorized");
			});
			await check(name + " destroys a bad getOrCreate key", async () => {
				const handle = actors.getOrCreate([...invalid], service());
				await handle.resolve();
				await until("bad key to disappear", () => actors.get([...invalid]).resolve().then(() => false, e => {
					if (!absent(e)) throw e;
					return true;
				}), 2500);
			});
		}
		await check("sweep posts the exact 19-digit delivery id once and skips known GUIDs", async () => {
			// Only these two failures belong to this scenario. Both are real signed HTTP attempts.
			standin.deliveries.length = 0;
			const existing = randomUUID(), missing = randomUUID(), unlinked = 96666;
			assert.equal((await send(shaPayload, existing)).status, 202);
			try {
				offline = true;
				await send({ ...shaPayload, installation: { id: unlinked } }, randomUUID(), second);
				for (const id of [existing, missing]) assert.equal((await send(shaPayload, id, second)).status, 503);
			} finally { offline = false; }
			const hooks = client.githubHooks.getOrCreate(["app"], service());
			const started = await until("the first delivery to arm the sweep", () => (hooks as unknown as { checkStarted(): Promise<number | null> }).checkStarted(), 35_000);
			assert.ok(started > Date.now() && started <= Date.now() + 600_000, "first delivery armed ten-minute sweep");
			const failedId = standin.deliveries.find(d => d.guid === missing)!.id;
			assert.notEqual(String(Number(failedId)), failedId);
			await hooks.internalSweep();
			assert.deepEqual(standin.requests.filter(r => r.method === "POST" && r.path.endsWith("/attempts")).map(r => r.path),
				[`/api/v3/app/hook/deliveries/${failedId}/attempts`]);
			assert.deepEqual(standin.deliveries.filter(d => d.redelivery).map(d => [d.guid, d.status_code]), [[missing, 202]]);
			assert.equal(await known(missing), true);
			await assert.rejects(client.githubInbox.get([String(unlinked)]).resolve(), absent);
			// The four-day receipt itself must suppress a repeat, even after a missing inbox row.
			await fixture(91234).checkFixture("expire", missing);
			await inbox(91234).internalDue();
			await hooks.internalSweep();
			assert.equal(standin.requests.filter(r => r.path.endsWith("/attempts")).length, 1);
			assert.ok(standin.requests.some(r => r.auth === "jwt" && r.path.includes("status=failure") && r.path.includes("per_page=100")));
		});
		await check("sweep shares 50 attempts across installations and resumes its three-page scan", async () => {
			const hooks = client.githubHooks.getOrCreate(["app"], service());
			await hooks.internalStart();
			standin.deliveries.length = 0;
			try {
				offline = true;
				// Newest first at GitHub: the quiet installation is behind a full page of failures.
				await standin.deliver(second, "push", { installation: { id: wideInstallation } }, { secret });
				for (let i = 0; i < 101; i++) await standin.deliver(second, "push", { installation: { id: 91234 } }, { secret });
			} finally { offline = false; }
			const attempts = () => standin.deliveries.filter(d => d.redelivery).length;
			await hooks.internalSweep(); assert.equal(attempts(), 50);
			assert.ok(standin.deliveries.some(d => d.redelivery && d.installation_id === wideInstallation), "quiet installation redelivered on first sweep");
			await hooks.internalSweep(); assert.equal(attempts(), 100);
			await hooks.internalSweep(); assert.equal(attempts(), 102);
			const remembered = standin.deliveries.find(d => d.redelivery)!;
			standin.deliveries.length = 0;
			for (let i = 0; i < 301; i++)
				standin.deliveries.push({ ...remembered, id: String(3855090938003090001n + BigInt(i)), delivered_at: new Date().toISOString(), status_code: 503 });
			const pages = () => standin.requests.filter(r => r.path.startsWith("/api/v3/app/hook/deliveries?")).length;
			const start = pages();
			await hooks.internalSweep(); assert.equal(pages() - start, 3);
			await hooks.internalSweep(); assert.equal(pages() - start, 4);
			assert.ok(standin.requests.at(-1)?.path.includes("cursor=3855090938003090301"), "resumed at the fourth page");
		});
		await check("inbox unreachable or timed out", async () => {
			const transport = globalThis.fetch;
			for (const fail of ["unreachable", "silent"]) {
				try {
					globalThis.fetch = async (_url, init) => {
						if (fail === "unreachable") throw new Error("engine unreachable");
						return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
					};
					const now = Date.now(); assert.equal((await local()).status, 503);
					assert.ok(Date.now() - now < 9500, "hard inbox deadline");
				} finally { globalThis.fetch = transport; }
			}
		});
		await check("logs contain metadata only", () => {
			const dumped = JSON.stringify(githubConfig());
			assert.ok(![secret, previous].some(value => dumped.includes(value)), "configuration serialized webhook credentials");
			assert.ok(logs.includes("[wlp] github: webhook on /github/webhook"));
			assert.ok(logs.includes("github.delivery.stored event=status"));
			assert.ok(![secret, previous, bodyMarker, "sha256="].some(value => logs.includes(value)), "private delivery material appeared in node output");
		});
	} finally {
		other.closeAllConnections();
		await new Promise<void>(resolve => other.close(() => resolve()));
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await exited; clearTimeout(guard);
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch { /* Engine exited with its node. */ }
		await standin.stop();
		rmSync(storage, { recursive: true, force: true });
	}
	if (failed.length) throw new Error(failed.length + " webhook check(s) failed");
}

if (process.argv.includes("--node")) await testNode();
else await run();
