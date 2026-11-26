/** cd server && WLP_CHECK_SECTIONS=connect npx tsx ../scripts/gitlab-check.ts */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Registry } from "../server/src/client.js";
import { matchesSection } from "./check-sections.js";
import { localListeners } from "./check-listeners.js";
import { GitlabStandin } from "./gitlab-standin.js";
import { pollUntil } from "./issue-intake-fixture.js";
import { loginHttp } from "./login-http.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Test-only inspection: open the persisted grant with the user/instance binding; return no credentials. */
async function startCheckNode() {
	const { userGitlab } = await import("../server/src/actors/user-gitlab.js");
	const { openSecret, sealSecret } = await import("../server/src/repo-secrets.js");
	const { serverSealer } = await import("../server/src/signin/seal.js");
	const actions = userGitlab.config.actions!;
	Object.assign(actions, {
		checkGrant: async (c: Parameters<typeof actions.gitlab>[0], expire = false) => {
			await actions.gitlab(c); // Same owner check as a settings read.
			const [row] = await c.db.execute<{ sealed: string; issuer: string; viewer: string }>("SELECT sealed, issuer, viewer FROM grant_record");
			assert.ok(row);
			const scope = JSON.stringify(["gitlab", row.issuer, row.viewer]);
			const grant = JSON.parse(openSecret(serverSealer(), c.key[0]!, scope, "oauth-token", row.sealed));
			if (expire) {
				grant.expiresAt = Date.now() - 1;
				const sealed = sealSecret(serverSealer(), c.key[0]!, scope, "oauth-token", JSON.stringify(grant));
				await c.db.execute("UPDATE grant_record SET sealed=? WHERE id=1", sealed);
			}
			return [digest(grant.accessToken), digest(grant.refreshToken)];
		},
	});
	await import("../server/src/index.js");
}

async function connect() {
	const { engine, http: [port] } = await localListeners();
	const api = `http://127.0.0.1:${port}`, origin = "http://localhost:5173";
	const fixture = await GitlabStandin.start({ callbackUrl: api + "/gitlab/callback", pageSize: 1 });
	const storage = await mkdtemp(join(tmpdir(), "gitlab-connect-"));
	const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WLP_|RIVET|PORT$)/.test(key)));
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server/", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
		env: { ...clean, WLP_SECRET: randomBytes(32).toString("hex"), WLP_DEMO: "1", WLP_SANDBOX: "fake", WLP_WEB_ORIGINS: origin,
			WLP_HTTP_PORT: String(port), WLP_PUBLIC_URL: api, RIVET_RUN_ENGINE_PORT: String(engine), RIVETKIT_STORAGE_PATH: storage, RIVET_LOG_LEVEL: "silent",
			WLP_GITLAB_CLIENT_ID: fixture.clientId, WLP_GITLAB_CLIENT_SECRET: fixture.clientSecret, WLP_GITLAB_BASE_URL: fixture.url, WLP_GITLAB_REDIRECT_URL: fixture.redirectUrl },
	});
	let logs = "";
	child.stdout.on("data", chunk => { logs += chunk; });
	child.stderr.on("data", chunk => { logs += chunk; });
	const exited = new Promise(resolve => child.once("close", resolve));
	try {
		await pollUntil(90_000)("the platform HTTP port", async () => {
			assert.ok(child.exitCode === null && child.signalCode === null, "platform exited during startup");
			return (await fetch(api + "/health").catch(() => null))?.ok;
		});
		const client = createClient<Registry>({ endpoint: `http://127.0.0.1:${engine}`, headers: { Origin: origin } });
		const login = async () => {
			const auth = await loginHttp(api, origin).demo();
			return client.userGitlab.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
		};
		const owner = await login(), neighbour = await login();
		const disconnected = { state: "disconnected" };
		assert.deepEqual(await owner.gitlab(), disconnected);
		await assert.rejects(owner.gitlabConnect({ origin: "https://other.invalid" }));
		const begin = async () => fixture.authorize((await owner.gitlabConnect({ origin })).url);
		const callback = (url: URL | string) => fetch(url, { redirect: "manual" });
		const consent = await begin();
		const invalid = new URL(consent); invalid.searchParams.set("state", "invalid");
		const refused = async (url: URL | string) => {
			const response = await callback(url);
			assert.ok(response.status === 302 && (response.headers.get("location") ?? "").startsWith(origin + "/settings#gitlab-error="), "expected callback refusal");
		};
		await refused(invalid);
		const back = await callback(consent);
		assert.equal(back.status, 302);
		assert.equal(back.headers.get("cache-control"), "no-store");
		const landing = new URL(back.headers.get("location")!);
		assert.ok(landing.origin === origin && landing.pathname === "/settings" && !landing.search && /^#gitlab=.+$/.test(landing.hash), "expected a settings ticket");
		const ticket = landing.hash.slice("#gitlab=".length);
		await refused(consent);
		await assert.rejects(neighbour.gitlabComplete(ticket));
		assert.deepEqual(await owner.gitlab(), disconnected);
		assert.deepEqual(await neighbour.gitlab(), disconnected);
		const status = await owner.gitlabComplete(ticket);
		assert.ok(status.state === "connected" && status.baseUrl === fixture.url && status.project === null);
		await assert.rejects(owner.gitlabComplete(ticket));
		console.log("PASS connect: PKCE callback issues a single-use ticket for the initiating owner");

		fixture.addProject({ owner: "group", name: "other" });
		const project = fixture.addProject({ id: 9007199254740993n, owner: "group/subgroup", name: "service", defaultBranch: "trunk" });
		const hidden = fixture.addProject({ owner: "group", name: "hidden", accessible: false });
		const list = await owner.gitlabProjects("");
		const picked = list.projects.find(p => p.id === String(project.id));
		assert.ok(picked && picked.provider === "gitlab" && picked.owner === project.owner && picked.name === project.name && picked.branch === project.defaultBranch && picked.private);
		assert.equal(picked.url, `${fixture.url}/${project.owner}/${project.name}`);
		assert.equal(list.projects.length, 2);
		assert.equal(list.more, false);
		assert.deepEqual((await owner.gitlabProjects("service")).projects, [picked]);
		const saved = await owner.gitlabPickProject(String(project.id));
		assert.deepEqual(saved, { ...status, project: picked });
		await assert.rejects(owner.gitlabPickProject(String(hidden.id)));
		assert.deepEqual(await owner.gitlab(), saved);
		await assert.rejects(neighbour.gitlabProjects(""));
		console.log("PASS connect: discovers paged projects and saves the owner's accessible selection by exact ID");

		const secrets = [fixture.clientSecret, ...[...fixture.sessions.values()].flatMap(s => [s.access, s.refresh])];
		assert.equal(fixture.sessions.size, 1);
		const [session] = fixture.sessions.values();
		const probe = owner as unknown as { checkGrant(expire?: boolean): Promise<string[]> };
		assert.deepEqual(await probe.checkGrant(true), [digest(session.access), digest(session.refresh)]);
		console.log("PASS connect: actor storage holds the OAuth grant sealed for this owner and provider");
		const beforeRefresh = fixture.requests.length;
		const pages = await Promise.all([owner.gitlabProjects(""), owner.gitlabProjects("")]);
		assert.deepEqual(pages, [list, list]);
		assert.deepEqual(fixture.requests.slice(beforeRefresh).filter(r => r.method === "POST"), [{ method: "POST", status: 200 }], "concurrent reads should perform one refresh");
		assert.equal(fixture.sessions.size, 1);
		const [renewed] = fixture.sessions.values();
		assert.ok(renewed.access !== session.access && renewed.refresh !== session.refresh, "both grant tokens must rotate");
		assert.deepEqual(await probe.checkGrant(), [digest(renewed.access), digest(renewed.refresh)]);
		secrets.push(renewed.access, renewed.refresh);
		console.log("PASS connect: concurrent project lists refresh once and persist the rotated grant sealed");
		assert.equal(fixture.hooks.length, 1, "project pick must register one hook at GitLab");
		const [hook] = fixture.hooks;
		assert.equal(String(hook.projectId), String(project.id));
		assert.ok(hook.url === api + "/gitlab/webhook", "hook must point at the public callback without embedded credentials");
		assert.ok(hook.token.length >= 32 && !secrets.includes(hook.token), "expected a separate project hook secret");
		secrets.push(hook.token);
		assert.deepEqual(await owner.gitlabPickProject(String(project.id)), saved);
		assert.deepEqual(fixture.hooks.map(h => h.id), [hook.id], "repeated pick must keep the original hook without registering another");
		console.log("PASS connect: picking the same project twice keeps its original hook");
		const pending = await begin();
		assert.deepEqual(await owner.gitlabDisconnect(), disconnected);
		assert.equal(fixture.sessions.size, 0, "disconnect should revoke the provider grant");
		await refused(pending);
		assert.deepEqual(await owner.gitlab(), disconnected);
		await assert.rejects(owner.gitlabProjects(""));
		for (const secret of secrets) assert.ok(![logs, landing.href, JSON.stringify([status, list, saved])].some(text => text.includes(secret)), "credential in log, redirect or public response");
		console.log("PASS connect: disconnect clears selection and cancels unfinished authorization");
	} finally {
		child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await exited; clearTimeout(guard);
		try {
			const { pid } = JSON.parse(await readFile(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
		} catch { /* Engine exited with its server. */ }
		await fixture.stop();
		await rm(storage, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--node") await startCheckNode();
else {
	assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "connect"), "usage: gitlab-check.ts [connect]");
	if (matchesSection("connect")) await connect().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
