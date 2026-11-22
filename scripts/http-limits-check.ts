/** cd server && npx tsx ../scripts/http-limits-check.ts */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import { localListeners } from "./check-listeners.js";
import { GithubStandin } from "./github-standin.js";
import { FakeRunner, post } from "./runner-fake.js";

const { engine, http: [primaryPort, peerPort] } = await localListeners(2);
const endpoint = `http://127.0.0.1:${engine}`;
const primary = `http://127.0.0.1:${primaryPort}`;
const peer = `http://127.0.0.1:${peerPort}`;
const origin = "http://localhost:5173";

async function limited(response: Response, code = "rate_limited") {
	assert.equal(response.status, 429);
	assert.match(response.headers.get("retry-after") ?? "", /^[1-9]\d*$/);
	const body = await response.json();
	assert.equal(body.code, code);
	assert.match(body.message, /\S+ .*\.$/);
}

await test("public HTTP limits on two listeners sharing one engine", async t => {
	const dir = await mkdtemp(join(tmpdir(), "wlp-http-limits-"));
	const secret = randomBytes(32).toString("hex");
	const github = new GithubStandin({ callbackUrl: primary + "/github/callback" });
	await github.start();
	t.after(async () => { await github.stop(); await rm(dir, { recursive: true, force: true }); });
	const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WLP_|RIVET|PORT$)/.test(key)));
	const logs: string[] = [];
	const nodes: ReturnType<typeof spawn>[] = [];
	async function start(second: boolean) {
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
			cwd: fileURLToPath(new URL("../server/", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
			env: { ...clean, ...github.env(), WLP_GITHUB_WEBHOOK_SECRET: secret, WLP_DEMO: "1", WLP_SANDBOX: "fake",
				WLP_SECRET: secret, WLP_ITEMS: "1", WLP_MACHINES: "1", WLP_PUBLIC_URL: primary,
				WLP_HTTP_PORT: String(second ? peerPort : primaryPort), RIVET_RUN_ENGINE_PORT: String(engine),
				RIVETKIT_STORAGE_PATH: second ? join(dir, "peer") : dir, RIVET_LOG_LEVEL: "silent",
				WLP_API_ADDRESS_PER_MINUTE: "5", WLP_API_FAILURES_PER_MINUTE: "2", WLP_API_TOKEN_PER_MINUTE: "3",
				WLP_WEBHOOK_REFUSALS_PER_MINUTE: "2", WLP_RUNNER_POLLS_PER_MINUTE: "2", WLP_RUNNER_CONNECTIONS_PER_MINUTE: "2",
				...(second ? { RIVET_ENDPOINT: endpoint, RIVET_TOKEN: "default", NODE_ENV: "production" } : { WLP_CLIENT_IP_HEADER: "x-ingress-ip" }) },
		});
		nodes.push(child);
		child.stdout.on("data", b => logs.push(b.toString()));
		child.stderr.on("data", b => logs.push(b.toString()));
		const until = Date.now() + 90_000;
		while (!(await fetch((second ? peer : primary) + "/health").catch(() => null))?.ok) {
			assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < until, "listener failed to start");
			await wait(150);
		}
	}
	try {
		await start(false);
		await start(true);
		const client = createClient<Registry>({ endpoint, headers: { Origin: origin } });
		const auth = await client.login.getOrCreate([randomUUID()]).demo();
		const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
		github.addUser("ada");
		const installation = github.addInstallation("ada", "User");
		const repo = github.addRepository({ owner: "ada", name: "limits", installation });
		const { url } = await user.githubConnect({ origin });
		const back = await fetch(github.authorize("ada", url), { redirect: "manual" });
		await user.githubComplete(back.headers.get("location")!.split("#github=")[1]!);
		const task = { repository: { id: repo.id }, title: "Rate limit check", body: "File a work item.", start: false };
		const item = await user.createItem(task);
		const token = async () => (await user.createApiToken({ name: "check", scopes: ["items:create", "items:read"] })).secret;
		const api = (bearer: string, ip: string, host = primary, create = false) => fetch(host + (create ? "/api/items" : "/api/items/" + item.id), {
			method: create ? "POST" : "GET", body: create ? JSON.stringify(task) : undefined,
			headers: { authorization: "Bearer " + bearer, "x-ingress-ip": ip, "x-forwarded-for": ip },
		});
		const hook = async (ip: string, valid: boolean, host = primary) => fetch(host + "/github/webhook", {
			method: "POST", body: "{}", headers: { "x-ingress-ip": ip, "x-github-delivery": randomUUID(), "x-github-event": "ping",
				"x-github-hook-installation-target-id": github.appId,
				"x-hub-signature-256": "sha256=" + createHmac("sha256", valid ? secret : "fixture").update("{}").digest("hex") },
		});
		await t.test("webhook refuses the third bad signature, another address and a valid delivery still pass", async () => {
			const statuses = [];
			for (let i = 0; i < 4; i++) statuses.push(await hook("192.0.2.1", false));
			assert.equal((await hook("192.0.2.2", false)).status, 401);
			assert.equal((await hook("192.0.2.1", true)).status, 202);
			assert.deepEqual(statuses.map(r => r.status), [401, 401, 429, 429]);
			await limited(statuses[2]!);
		});
		await t.test("one token shares GET and POST across nodes; another token of the same user still works", async () => {
			// Keep the concurrent reads in one UTC minute.
			if (Date.now() % 60_000 > 50_000) await wait(60_000 - Date.now() % 60_000);
			const key = await token();
			assert.equal((await api(key, "192.0.2.3", primary, true)).status, 201);
			const responses = await Promise.all([primary, peer, primary].map((host, i) => api(key, "192.0.2." + (4 + i), host)));
			assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 429]);
			await limited(responses.find(r => r.status === 429)!, "token_rate_limited");
			assert.equal((await api(await token(), "192.0.2.3")).status, 200);
		});
		await t.test("an address shares the API budget across tokens, canonical IPv6 spellings and methods", async () => {
			const keys = [await token(), await token()];
			for (let i = 0; i < 5; i++) assert.equal((await api(keys[i % 2]!, "2001:db8::1")).status, 200);
			const fresh = await token();
			await limited(await api(fresh, "2001:0db8:0:0:0:0:0:1", primary, true));
			assert.equal((await api(fresh, "2001:db8::2", primary, true)).status, 201);
		});
		await t.test("concurrent misses reserve lookup slots; other addresses and successful lookups keep working", async () => {
			const fake = (uid: string) => "wlp_" + uid + "." + "x".repeat(43);
			const ip = "192.0.2.8";
			const results = await Promise.all([auth.profile.uid, "missing", "unused"].map(uid => api(fake(uid), ip)));
			assert.deepEqual(results.map(r => r.status).sort(), [401, 401, 429]);
			await limited(await api(fake("another"), ip));
			const valid = await token();
			const reads = await Promise.all(Array.from({ length: 3 }, () => api(valid, "192.0.2.9")));
			assert.deepEqual(reads.map(r => r.status), [200, 200, 200]);
		});
		await t.test("without a trusted header, the failure limit only refuses invalid tokens", async () => {
			assert.equal((await api("malformed", "192.0.2.10", peer)).status, 401);
			const wrongSecret = "wlp_" + auth.profile.uid + "." + "x".repeat(43);
			assert.equal((await api(wrongSecret, "192.0.2.11", peer)).status, 401);
			await limited(await api("malformed", "192.0.2.12", peer));
			await limited(await api(wrongSecret, "192.0.2.10", peer));
			assert.equal((await api(await token(), "192.0.2.10", peer)).status, 200);
		});
		await t.test("malformed configured address headers share the unknown address allowance", async () => {
			// Even the configured header must contain one address, never a forwarding chain.
			assert.equal((await api("malformed", "192.0.2.13, 192.0.2.14")).status, 401);
			assert.equal((await api("malformed", "invalid")).status, 401);
			await limited(await api("malformed", ""));
		});
		const runner = new FakeRunner();
		const pair = await runner.pair(primary);
		await t.test("pair starts retain their cross-node key limit and report the retry interval", async () => {
			await runner.pair(peer);
			await runner.pair(primary);
			await limited(await post(peer, "/runner/pair", runner.details), "too_many_pairings");
			await new FakeRunner().pair(peer);
		});
		await t.test("only the listener with a configured header limits polls by address", async () => {
			for (let i = 0; i < 2; i++) assert.deepEqual(await runner.poll(primary, pair), { state: "waiting" });
			await limited(await post(primary, "/runner/pair/poll", { pairing: pair.pairing, pollSecret: pair.pollSecret }));
			for (let i = 0; i < 3; i++) assert.deepEqual(await runner.poll(peer, pair), { state: "waiting" });
			const other = await fetch(primary + "/runner/pair/poll", { method: "POST", headers: { "x-ingress-ip": "192.0.2.15" },
				body: JSON.stringify({ pairing: pair.pairing, pollSecret: pair.pollSecret }) });
			assert.equal(other.status, 200);
			assert.deepEqual(await other.json(), { state: "waiting" });
		});
		await user.claimMachine({ code: pair.code });
		const { machineId } = await user.confirmMachine({ code: pair.code, keyConfirmed: true });
		const id = { uid: auth.profile.uid, machineId };
		await t.test("a paired runner connects until the configured address limit", async () => {
			for (let i = 0; i < 2; i++) assert.equal((await runner.connection(primary, id)).status, 200);
			await limited(await runner.connection(primary, id));
		});
		await t.test("without a trusted header, only a verified signature spends the machine allowance", async () => {
			// The two signed connections must land in the same machine UTC minute.
			if (Date.now() % 60_000 > 50_000) await wait(60_000 - Date.now() % 60_000);
			const other = new FakeRunner();
			assert.equal((await other.connection(peer, id)).status, 403);
			assert.equal((await post(peer, "/runner/connection", {})).status, 400);
			await limited(await other.connection(peer, id));
			for (let i = 0; i < 2; i++) assert.equal((await runner.connection(peer, id)).status, 200);
			await limited(await runner.connection(peer, id));
			const otherPair = await other.pair(peer);
			await user.claimMachine({ code: otherPair.code });
			const otherId = await user.confirmMachine({ code: otherPair.code, keyConfirmed: true });
			assert.equal((await other.connection(peer, { uid: id.uid, machineId: otherId.machineId })).status, 200);
		});
		await t.test("one trailing webhook summary for five refusals, then the address budget recovers", async () => {
			const deadline = Date.now() + 65_000;
			while (!logs.join("").includes("github.webhook.refused") && Date.now() < deadline) await wait(250);
			const lines = logs.join("").split("\n");
			assert.equal(lines.filter(line => line.includes("github.webhook.bad_signature")).length, 0);
			assert.equal(lines.filter(line => line.includes("github.webhook.refused")).length, 1);
			assert.ok(lines.some(line => line.includes("github.webhook.refused count=5 bad_signature=5 rate_limited=2")));
			assert.equal((await hook("192.0.2.1", false)).status, 401);
		});
		await t.test("without a trusted header, webhook refusals leave signed deliveries available", async () => {
			assert.equal((await hook("192.0.2.1", false, peer)).status, 401);
			assert.equal((await hook("192.0.2.2", false, peer)).status, 401);
			await limited(await hook("192.0.2.3", false, peer));
			assert.equal((await hook("192.0.2.1", true, peer)).status, 202);
		});
	} finally {
		for (const child of nodes.reverse()) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
			child.kill("SIGTERM");
			const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
			try { await exited; } finally { clearTimeout(guard); }
		}
		try {
			const { pid } = JSON.parse(await readFile(join(dir, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch { /* The engine already exited. */ }
	}
});
