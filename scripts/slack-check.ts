/** Run: cd server && npx tsx ../scripts/slack-check.ts. No Slack or GitHub account required. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { localListeners, portFree } from "./check-listeners.js";
import { GithubStandin } from "./github-standin.js";
import { pollUntil } from "./issue-intake-fixture.js";
import { loginHttp } from "./login-http.js";
import { SlackStandin } from "./slack-standin.js";

const heldText = "Test a slow filing";
const heldMarker = "acceptance: filing is blocked";
const origin = "http://127.0.0.1:5173";
const until = pollUntil(60_000);

async function run() {
	const { engine, http: [http] } = await localListeners();
	const api = `http://127.0.0.1:${http}`;
	const slack = await SlackStandin.start();
	const github = new GithubStandin({ callbackUrl: api + "/github/callback", slug: "windlass-fk4w", strictBranches: false });
	await github.start();
	const storage = mkdtempSync(join(tmpdir(), "wlp-slack-e2e-"));
	Object.assign(process.env, slack.env, github.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"), WLP_SANDBOX: "fake", WLP_FAKE_DELAY_MS: "10", WLP_ITEMS: "1", WLP_DEMO: "1",
		WLP_WEB_ORIGINS: origin, WLP_HTTP_PORT: String(http), RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(engine), RIVET_LOG_LEVEL: "silent",
		WLP_MAX_KEPT_SANDBOXES: "unlimited", WLP_FACTORY_GITHUB_ITEMS_PER_DAY: "3",
	});
	for (const key of ["RIVET_ADMIN_TOKEN", "RIVET_ENDPOINT", "RIVET_ENGINE", "PORT", "WLP_FACTORY_ORCHESTRATE"]) delete process.env[key];
	let logs = "";
	function start(hold: boolean) {
		const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node", ...(hold ? ["--hold"] : [])], {
			cwd: fileURLToPath(new URL("../server", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", chunk => { logs += chunk; });
		child.stderr.on("data", chunk => { logs += chunk; });
		const exited = new Promise(resolve => child.once("exit", resolve));
		return {
			ready: () => until("platform HTTP", async () => {
				assert.equal(child.exitCode, null, "platform exited before serving HTTP");
				return (await fetch(api + "/platform/info").catch(() => null))?.ok;
			}, 90_000),
			async stop(signal: "SIGKILL" | "SIGTERM") {
				if (child.exitCode === null && child.signalCode === null) child.kill(signal);
				const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
				await exited; clearTimeout(guard);
				try {
					const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
					if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, signal);
				} catch { /* Engine already exited with the node. */ }
				await until("local engine shutdown", async () => (await Promise.all([engine, engine + 1, engine + 10, http].map(portFree))).every(Boolean));
			},
		};
	}
	let node = start(true);
	try {
		await node.ready();
		const { createClient } = await import("../server/src/client.js");
		const client = createClient<import("../server/src/registry.js").Registry>({ endpoint: `http://127.0.0.1:${engine}` });
		const account = async (login: string) => {
			const auth = await loginHttp(api).demo();
			const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
			github.addUser(login);
			const connect = await user.githubConnect({ origin });
			const back = await fetch(github.authorize(login, connect.url), { redirect: "manual" });
			await user.githubComplete(back.headers.get("location")!.split("#github=")[1]);
			return user;
		};
		Object.assign(github.appPermissions, { checks: "read", statuses: "read", actions: "read" });
		const installation = github.addInstallation("slack-org", "Organization");
		const repo = github.addRepository({ installation, owner: "slack-org", name: "mapped" });
		repo.access.set("installer", "write"); repo.access.set("member", "write");
		const owner = await account("installer"), member = await account("member");
		const events = api + "/slack/events", commands = api + "/slack/commands";
		const event = (envelope: unknown) => fetch(slack.request(events, JSON.stringify(envelope)));
		const command = (form: URLSearchParams) => fetch(slack.request(commands, form.toString(), "application/x-www-form-urlencoded"));
		const ack = async (pending: Promise<Response>) => {
			const response = await pending;
			assert.equal(response.status, 200);
			await response.arrayBuffer();
		};
		const challenge = { type: "url_verification", challenge: "acceptance-check" };
		assert.deepEqual(await (await event(challenge)).json(), { challenge: challenge.challenge });
		assert.equal((await fetch(slack.request(events, JSON.stringify(challenge), undefined, { sentBody: JSON.stringify(challenge) + " " }))).status, 401);
		assert.equal((await fetch(slack.request(events, JSON.stringify(challenge), undefined, { timestamp: "1000" }))).status, 401);
		assert.deepEqual(await owner.slack(), { state: "disconnected", links: [] });
		await assert.rejects(owner.slackConnect({ origin: "https://untrusted.example" }), { code: "origin_not_allowed" });
		const consent = new URL(await slack.authorize((await owner.slackConnect({ origin })).url));
		// The stand-in binds OAuth to its registered redirect URI; deliver the browser's callback to the platform.
		const callback = () => fetch(api + consent.pathname + consent.search, { redirect: "manual" });
		const response = await callback();
		assert.equal(response.status, 302);
		const landing = new URL(response.headers.get("location")!);
		assert.equal(landing.origin + landing.pathname, origin + "/settings");
		const ticket = new URLSearchParams(landing.hash.slice(1)).get("slack");
		assert.ok(ticket, "missing connection ticket");
		assert.ok((await callback()).headers.get("location") === origin + "/settings#slack-error=used", "replayed callback did not fail closed");
		await assert.rejects(member.slackComplete(ticket), { code: "slack_ticket" });
		assert.equal((await owner.slackComplete(ticket)).state, "connected");
		await assert.rejects(owner.slackComplete(ticket), { code: "slack_ticket" });
		const mapping = { channelId: slack.channelId, repositoryId: repo.id };
		await assert.rejects(member.saveSlackMapping(mapping), { code: "slack_not_connected" });
		const mapped = await owner.saveSlackMapping(mapping);
		assert.ok(mapped.state === "connected");
		assert.deepEqual(mapped.connection.workspace, slack.team);
		assert.deepEqual(mapped.mappings.map(m => [m.channel.id, m.repository.id]), [[slack.channelId, repo.id]]);
		console.log("PASS signed routes, account-bound OAuth and owner-only mapping");

		const memberId = "U55667788";
		const mention = () => { const e = slack.mention(); e.event.user = memberId; return e; };
		const commandId = (f: URLSearchParams) => "command:" + createHash("sha256").update(f.get("trigger_id")!).digest("hex");
		const slash = (text: string) => { const f = slack.command(); f.set("user_id", memberId); f.set("text", text); return f; };
		const items = () => member.listItems({ source: "slack" });
		// HTTP acknowledges durable receipt, not a completed filing decision. Wait for the
		// worker before asserting a negative or changing the permissions it must check.
		const { serviceParams } = await import("../server/src/auth.js");
		const probe = () => client.slackWorkspace.get([slack.team.id], { params: serviceParams() }) as unknown as {
			checkReceipt(deliveryId: string): Promise<"missing" | "pending" | "settled">;
		};
		const settled = (id: string) => until("delivery decision", async () => await probe().checkReceipt(id) === "settled");
		for (const opts of [{ secret: "invalid-check-signature" }, { timestamp: "1000" }]) {
			const refused = mention();
			const r = await fetch(slack.request(events, JSON.stringify(refused), undefined, opts));
			assert.equal(r.status, 401);
			assert.equal(await probe().checkReceipt(refused.event_id), "missing", "unsigned or stale event reached the inbox");
			const form = slash("refused command");
			const reply = await fetch(slack.request(commands, form.toString(), "application/x-www-form-urlencoded", opts));
			assert.equal(reply.status, 401);
			assert.equal(await probe().checkReceipt(commandId(form)), "missing", "unsigned or stale command reached the inbox");
		}
		const otherChannel = mention(); otherChannel.event.channel = "C77777777";
		await ack(event(otherChannel)); await settled(otherChannel.event_id);
		const bot = mention(); bot.event.user = slack.botUserId;
		await ack(event(bot));
		assert.equal(slack.ephemeral.length, 0); assert.equal(slack.messages.length, 0);
		await ack(event(mention()));
		const prompt = await until("private Slack link", async () => slack.ephemeral[0]);
		assert.equal(prompt.channel, slack.channelId); assert.equal(prompt.user, memberId);
		const proof = /#slack-link=([\w.-]+)/.exec(prompt.text)?.[1];
		assert.ok(proof, "missing Settings proof in the private reply");
		assert.equal(slack.messages.length, 0);
		const linked = await member.linkSlack(proof);
		assert.ok(linked.state === "disconnected", "membership does not transfer workspace ownership");
		assert.deepEqual(linked.links, [{ teamId: slack.team.id, userId: memberId }]);
		await assert.rejects(owner.linkSlack(proof), { code: "slack_proof" });
		repo.access.set("member", "read");
		const readOnly = mention();
		await ack(event(readOnly)); await settled(readOnly.event_id);
		assert.deepEqual(await items(), []); assert.deepEqual(await owner.listItems(), []);
		assert.equal(slack.messages.length, 0, "repository access refusal must not be public");
		assert.equal(slack.ephemeral.length, 2, "expected one link and one private refusal");
		const denial = slack.ephemeral[1];
		assert.equal(denial.channel, slack.channelId); assert.equal(denial.user, memberId);
		assert.ok(/write (access|permission)/i.test(denial.text) && !denial.text.includes("#slack-link="), "missing distinct private write-access refusal");
		repo.access.set("member", "write");
		console.log("PASS private link and requester-specific repository access");

		const receipt = (id: string, label: string) => until(label, async () => slack.messages.find(m => m.text === `${label}: ${origin}/items/${id}`));
		const request = mention();
		request.event.text = `<@${slack.botUserId}> ${heldText}`;
		const startMs = performance.now();
		await ack(event(request));
		const ackMs = performance.now() - startMs;
		assert.ok(ackMs < 3_000, "Slack acknowledgement exceeded three seconds");
		await until("the worker to enter the blocked filing", async () => logs.includes(heldMarker));
		await sleep(3_100); // The filing stays blocked for longer than Slack's entire acknowledgement window.
		assert.equal(await probe().checkReceipt(request.event_id), "pending");
		await node.stop("SIGKILL");
		node = start(false);
		await node.ready();
		// No redelivery yet: the durable wake alone must finish the interrupted filing.
		await settled(request.event_id);
		assert.equal((await items()).length, 1, "the pending filing did not survive the crash");
		await ack(event(request));
		console.log(`PASS ${Math.ceil(ackMs)}ms acknowledgement during blocked filing; recovered after SIGKILL before redelivery`);
		const [plan] = await until("mention filing", async () => { const rows = await items(); return rows.length > 0 && rows; });
		assert.equal(plan.mode, "orchestrate"); assert.equal(plan.repository.id, repo.id);
		assert.equal((await receipt(plan.id, "Work item filed")).thread_ts, request.event.thread_ts);
		assert.equal((await receipt(plan.id, "Plan ready for approval")).thread_ts, request.event.thread_ts);
		await member.actOnItem({ id: plan.id, action: { kind: "cancel" } });
		assert.equal((await items()).length, 1);
		await member.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
		const form = slash("quick fix A+B & café");
		await ack(command(form)); await ack(command(form));
		const quick = await until("slash filing", async () => (await items()).find(i => i.id !== plan.id));
		assert.equal(quick.mode, "single");
		const view = await member.item(quick.id);
		assert.equal(view.task.title, "> fix A+B & café"); assert.notEqual(view.state, "draft");
		const root = await receipt(quick.id, "Work item filed");
		assert.equal(root.thread_ts, undefined);
		assert.equal((await receipt(quick.id, "Question ready")).thread_ts, root.ts);
		const question = (await member.item(quick.id)).question;
		assert.equal(question?.kind, "turn_refused");
		await member.actOnItem({ id: quick.id, action: { kind: "answer", question: question!.id, choice: "give_up" } });
		assert.equal((await receipt(quick.id, "Work item failed")).thread_ts, root.ts);
		await member.saveRepositoryDefaults({ repositoryId: repo.id, profile: null });
		console.log("PASS mention plan, quick command, untrusted turn gate, thread roots and failure");

		const implement = mention(); implement.event.text = `<@${slack.botUserId}> quick Print hello`;
		implement.event.thread_ts = implement.event.ts;
		await ack(event(implement));
		const third = await until("quick mention filing", async () => (await items()).find(i => i.id !== quick.id && i.id !== plan.id));
		const pr = await until("pull request", async () => (await member.item(third.id)).pullRequest);
		assert.equal((await receipt(third.id, "Pull request opened")).thread_ts, implement.event.ts);
		const pull = github.pulls.find(p => p.repository === repo.id && p.number === pr.number)!;
		pull.state = "closed"; pull.merged = true;
		assert.equal((await receipt(third.id, "Work item finished")).thread_ts, implement.event.ts);
		const over = slash("over daily limit");
		await ack(command(over));
		await settled(commandId(over));
		assert.equal((await items()).length, 3);
		assert.deepEqual(await owner.listItems(), []);
		assert.equal(slack.messages.filter(m => m.text.startsWith("Work item filed:")).length, 3);
		for (const m of slack.messages) {
			assert.equal(m.channel, slack.channelId);
			assert.ok(!m.text.includes(proof) && !m.text.includes("café"), "private data appeared in a channel reply");
		}
		await owner.removeSlackMapping(slack.channelId);
		const before = slack.ephemeral.length;
		await member.unlinkSlack(slack.team.id);
		const removed = mention();
		await ack(event(removed)); await settled(removed.event_id);
		assert.equal(slack.ephemeral.length, before, "removed mapping still issued a link");
		// Restore the mapping so removing it above cannot explain the disconnect result.
		await owner.saveSlackMapping(mapping);
		assert.equal((await owner.disconnectSlack()).state, "disconnected");
		assert.equal(slack.tokens.size, 0, "disconnect must revoke the workspace bot");
		const disconnected = mention();
		const callsAtDisconnect = slack.calls.length;
		await ack(event(disconnected)); await settled(disconnected.event_id);
		assert.equal(slack.calls.length, callsAtDisconnect, "disconnected delivery contacted Slack");
		assert.equal((await items()).length, 3);
		for (const secret of [proof, ticket, slack.clientSecret, slack.signingSecret, "xoxb-", form.get("response_url")!, form.get("trigger_id")!]) {
			assert.ok(!logs.includes(secret), "private Slack data appeared in server output");
		}
		console.log("PASS PR and final thread updates, quota, disconnect and credential privacy");
	} finally {
		await node.stop("SIGTERM");
		await slack.close(); await github.stop(); rmSync(storage, { recursive: true, force: true });
	}
}

if (process.argv.includes("--node")) {
	const { slackDispatchWorkspace } = await import("../server/src/slack/dispatch.js");
	const { requireServiceFor } = await import("../server/src/auth.js");
	type WorkspaceCtx = Parameters<NonNullable<typeof slackDispatchWorkspace.config.actions>["internalReceive"]>[0];
	Object.assign(slackDispatchWorkspace.config.actions!, { async checkReceipt(c: WorkspaceCtx, id: string) {
		requireServiceFor(c, "call");
		const [row] = await c.db.execute<{ pending: number }>("SELECT payload IS NOT NULL AS pending FROM slack_inbox WHERE id=?", id);
		return row ? row.pending ? "pending" : "settled" : "missing";
	} });
	if (process.argv.includes("--hold")) {
		const { user } = await import("../server/src/actors/user.js");
		const file = user.config.actions!.internalSlackIntake;
		user.config.actions!.internalSlackIntake = async (c, filing) => {
			if (filing.delivery.text === heldText) {
				console.log(heldMarker);
				await new Promise<never>(() => {}); // Only a process restart releases this gate.
			}
			return file(c, filing);
		};
	}
	// Keep the PR merge check independent of production poll intervals.
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	Object.assign(CI_POLLING, { everyMs: 250, crowdedEveryMs: 250, prEveryMs: 250, webhookEveryMs: 250, webhookCrowdedEveryMs: 250, webhookPrEveryMs: 250, noneAfterMs: 0 });
	await import("../server/src/index.js");
} else await run().then(() => process.exit(0), error => {
	// Assertion diffs and client exceptions may contain credentials, proofs or callback URLs.
	const frame = error instanceof Error && error.stack?.match(/at [^\n]*?slack-check\.ts:(\d+):(\d+)/);
	console.error(`FAIL Slack acceptance${frame ? ` at scripts/slack-check.ts:${frame[1]}:${frame[2]}` : ""}`);
	process.exit(1);
});
