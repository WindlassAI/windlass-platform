/** Run from server with npx tsx ../scripts/slack-check.ts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { localListeners } from "./check-listeners.js";
import { GithubStandin } from "./github-standin.js";
import { pollUntil } from "./issue-intake-fixture.js";
import { loginHttp } from "./login-http.js";
import { SlackStandin } from "./slack-standin.js";

const until = pollUntil(60_000);
const origin = "http://127.0.0.1:5173";
async function run() {
	const { engine, http: [port] } = await localListeners(), api = `http://127.0.0.1:${port}`;
	const slack = new SlackStandin(api + "/slack/callback");
	const github = new GithubStandin({ callbackUrl: api + "/github/callback", slug: "windlass-fk4w", strictBranches: false });
	await slack.start(); await github.start();
	const storage = mkdtempSync(join(tmpdir(), "wlp-slack-"));
	Object.assign(process.env, github.env(), { WLP_SECRET: randomBytes(32).toString("hex"), WLP_SANDBOX: "fake", WLP_DEMO: "1", WLP_ITEMS: "1",
		WLP_WEB_ORIGINS: origin, WLP_HTTP_PORT: String(port), WLP_PUBLIC_URL: api, WLP_FAKE_DELAY_MS: "10", WLP_MAX_KEPT_SANDBOXES: "unlimited",
		RIVETKIT_STORAGE_PATH: storage, RIVET_RUN_ENGINE_PORT: String(engine), RIVET_LOG_LEVEL: "silent",
		WLP_SLACK_URL: slack.url, WLP_SLACK_CLIENT_ID: "test", WLP_SLACK_CLIENT_SECRET: slack.secret, WLP_SLACK_SIGNING_SECRET: slack.signing });
	for (const key of ["RIVET_ADMIN_TOKEN", "RIVET_ENDPOINT", "RIVET_ENGINE", "PORT", "WLP_FACTORY_ORCHESTRATE"]) delete process.env[key];
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server", import.meta.url)), stdio: "ignore",
	});
	const stopped = new Promise(resolve => child.once("exit", resolve));
	try {
		await until("platform HTTP", async () => {
			assert.equal(child.exitCode, null, "server exited");
			return (await fetch(api + "/platform/info").catch(() => null))?.ok;
		}, 90_000);
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
		const repo = github.addRepository({ installation: github.addInstallation("acme", "Organization"), owner: "acme", name: "factory" });
		repo.access.set("installer", "write"); repo.access.set("member", "read");
		const owner = await account("installer"), member = await account("member");
		const connect = async () => {
			const consent = await owner.slackConnect({ origin });
			const back = await fetch(slack.authorize(consent.url), { redirect: "manual" });
			const ticket = new URL(back.headers.get("location")!).hash.slice("#slack=".length);
			await assert.rejects(member.slackComplete(ticket), { code: "slack_ticket" });
			const status = await owner.slackComplete(ticket);
			await assert.rejects(owner.slackComplete(ticket), { code: "slack_ticket" });
			return status;
		};
		assert.equal((await connect()).state, "connected");
		assert.deepEqual(await owner.slackChannels(), [slack.channel]);
		await owner.saveSlackMapping({ channelId: slack.channel.id, repositoryId: repo.id });
		const events = api + "/slack/events", commands = api + "/slack/commands";
		const send = (event: unknown, retry?: number) => slack.send(events, JSON.stringify(event), { retry });
		const ack = async (result: Promise<Response>) => assert.equal((await result).status, 200);
		const challenge = { type: "url_verification", challenge: "hello" };
		assert.deepEqual(await (await send(challenge)).json(), { challenge: "hello" });
		for (const opts of [{ tamper: true }, { stamp: "1000" }])
			assert.equal((await slack.send(events, JSON.stringify(slack.mention()), opts)).status, 401);
		await ack(send(slack.mention("Ignore me", slack.bot)));
		await ack(send(slack.mention()));
		const prompt = await until("link prompt", async () => slack.privateReplies[0]);
		assert.equal(prompt.user, slack.member);
		const proof = prompt.text.split("#slack-link=")[1];
		assert.ok(proof);
		await member.linkSlack(proof);
		await ack(send(slack.mention()));
		await until("member write check", async () => slack.privateReplies.some(r => r.text.includes("write access")));
		assert.equal((await member.listItems()).length, 0);
		assert.equal(slack.privateReplies.length, 2);
		repo.access.set("member", "write");
		const request = slack.mention("Slow filing");
		const start = performance.now();
		await ack(send(request, 1)); // A retry can be the first copy we see.
		assert.ok(performance.now() - start < 3000, "admission waited for filing");
		await Promise.all([ack(send(request)), ack(send(request, 2))]);
		const items = () => member.listItems({ source: "slack" });
		const receipt = (id: string, label: string) => until(label, async () => slack.messages.find(m => m.text === `${label}: ${origin}/items/${id}`));
		const plan = await until("mention item", async () => (await items())[0]);
		assert.equal(plan.mode, "orchestrate"); assert.equal(plan.repository.id, repo.id);
		assert.equal((await receipt(plan.id, "Work item filed")).thread, request.event.thread_ts);
		assert.equal((await receipt(plan.id, "Plan ready for approval")).thread, request.event.thread_ts);
		await member.actOnItem({ id: plan.id, action: { kind: "cancel" } });
		await receipt(plan.id, "Work item cancelled");
		const form = new URLSearchParams({ team_id: slack.team.id, channel_id: slack.channel.id, user_id: slack.member, command: "/windlass", trigger_id: randomUUID(), text: "quick Fix café" });
		const listsBeforeCommands = slack.channelListCalls;
		for (const state of [{ isMember: false, archived: false }, { isMember: true, archived: true }]) {
			Object.assign(slack, state);
			const rejected = new URLSearchParams(form);
			rejected.set("trigger_id", randomUUID());
			rejected.set("text", "quick This should not file");
			const prior = slack.channelInfoCalls;
			await ack(slack.send(commands, rejected.toString(), { command: true }));
			await until("command channel lookup", async () => slack.channelInfoCalls > prior);
		}
		slack.archived = false;
		await ack(slack.send(commands, form.toString(), { command: true }));
		await ack(slack.send(commands, form.toString(), { command: true, retry: 1 }));
		const quick = await until("command item", async () => (await items()).find(item => item.id !== plan.id));
		assert.equal(quick.mode, "single");
		assert.equal(quick.title, "Fix café");
		assert.equal(slack.channelInfoCalls, 3);
		assert.equal(slack.channelListCalls, listsBeforeCommands);
		const root = await receipt(quick.id, "Work item filed");
		assert.equal(root.thread, null);
		assert.equal((await receipt(quick.id, "Pull request opened")).thread, root.ts);
		const pull = github.pulls.find(pr => pr.repository === repo.id)!;
		pull.state = "closed"; pull.merged = true;
		assert.equal((await receipt(quick.id, "Work item finished")).thread, root.ts);
		await member.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
		const question = slack.mention("quick Check a change");
		await ack(send(question));
		const blocked = await until("untrusted input gate", async () => (await items()).find(item => item.id !== plan.id && item.id !== quick.id));
		assert.equal((await receipt(blocked.id, "Question ready")).thread, question.event.thread_ts);
		const gate = (await member.item(blocked.id)).question!;
		assert.equal(gate.kind, "turn_refused");
		await member.actOnItem({ id: blocked.id, action: { kind: "answer", question: gate.id, choice: "give_up" } });
		assert.equal((await receipt(blocked.id, "Work item failed")).thread, question.event.thread_ts);
		assert.equal((await items()).length, 3);
		assert.equal((await owner.listItems()).length, 0);
		assert.equal(slack.messages.filter(m => m.text.startsWith("Work item filed")).length, 3);
		assert.equal((await owner.disconnectSlack()).state, "disconnected");
		assert.equal(slack.tokens.size, 0);
		assert.deepEqual(await member.slack(), { state: "disconnected", links: [] });
		await ack(send(slack.mention()));
		assert.deepEqual(await connect(), { state: "connected", workspaceName: slack.team.name, mappings: [], links: [] });
		console.log("PASS signed requests, named channel discovery, member access, asynchronous filing, retries, thread replies and disconnect");
	} finally {
		child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await stopped; clearTimeout(guard);
		try { const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8")); process.kill(pid, "SIGTERM"); } catch { /* engine already stopped */ }
		await slack.stop(); await github.stop(); rmSync(storage, { recursive: true, force: true });
	}
}

if (process.argv.includes("--node")) {
	const { user } = await import("../server/src/actors/user.js");
	const file = user.config.actions!.internalSlackIntake;
	user.config.actions!.internalSlackIntake = async (c, input) => {
		if (input.delivery.text === "Slow filing") await sleep(3500);
		return file(c, input);
	};
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	Object.assign(CI_POLLING, { everyMs: 250, crowdedEveryMs: 250, prEveryMs: 250, webhookEveryMs: 250, webhookCrowdedEveryMs: 250, webhookPrEveryMs: 250, noneAfterMs: 0 });
	await import("../server/src/index.js");
} else await run().then(() => process.exit(0), error => {
	// Assertion diffs and actor errors can contain one-time tickets.
	const line = error?.stack?.match(/slack-check\.ts:(\d+:\d+)/)?.[1];
	console.error("FAIL Slack check at " + line);
	process.exit(1);
});
