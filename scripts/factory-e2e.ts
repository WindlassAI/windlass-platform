/**
 * End-to-end check of the software factory's spine (Plans "software factory", slice 1): work items
 * through the real actors (`user`, `workItem`, `agentSession`) on the fake sandbox layer, with GitHub
 * played by scripts/github-standin.ts. Run with:
 *
 *   cd server && npx tsx ../scripts/factory-e2e.ts
 *
 * It starts its own servers on fresh state, on OS-assigned ports, and stops each by its PID. The fake layer replays recorded turns (its words
 * choose them, sandbox-fake.ts): a user's check whose command says "fail" fails, every other passes,
 * and a turn always leaves files to push. CI is set on the stand-in per branch; the factory polls it
 * every minute (github/ci.ts `CI_POLLING`), so a check that waits for CI takes a minute or more.
 *
 *   FACTORY_ONLY=api,ci   run only the sections whose names start with one of these; FACTORY_ONLY=memory
 *                         runs only the in-memory cases, which need no server
 *
 * Prints one PASS/FAIL/SKIP line per check and exits 1 if any failed.
 */

import { branchFor } from "../server/src/github/publish.js";
import { StandInObjectStore } from "../server/src/bucket/stand-in.js";
import { verdictWords } from "../server/src/factory/verdict.js";
import { localListeners } from "./check-listeners.js";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { machineLabel, type AuthResult, type ItemSummary, type ItemView, type PlatformInfo } from "../server/src/contract.js";
import { createClient, type Registry } from "../server/src/client.js";
import { StandInRunner } from "./runner-standin.js";
import { optionsDigest } from "../server/src/runner/catalog.js";
import { GithubStandin, type StandinRepository, type StandinPull } from "./github-standin.js";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../server");
const { engine: ENGINE_PORT, http: [HTTP_PORT] } = await localListeners();
const ENDPOINT = `http://127.0.0.1:${ENGINE_PORT}`;
const API = `http://127.0.0.1:${HTTP_PORT}`;
const ORIGIN = "http://localhost:5173";
/** A CI poll is a minute after the push (github/ci.ts), and a turn of the fake layer a few seconds. */
const CI_WAIT_MS = 150_000;

const only = (process.env.FACTORY_ONLY ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let failed = 0;
const output: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function check(name: string, body: () => Promise<string | undefined>): Promise<void> {
	if (only.length > 0 && !only.some((prefix) => name.startsWith(prefix))) return void console.log(`SKIP  ${name}  (not in FACTORY_ONLY)`);
	try {
		const detail = await body();
		console.log(`PASS  ${name}${detail ? `  (${detail.replace(/\s+/g, " ").slice(0, 400)})` : ""}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs: number, everyMs = 250): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await sleep(everyMs);
	}
	throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ""}`);
}

async function refused(call: () => Promise<unknown>, code: string): Promise<string> {
	try {
		await call();
	} catch (error) {
		const got = (error as { code?: unknown }).code;
		assert(got === code, `expected ${code}, got ${String(got)}: ${(error as Error).message}`);
		return (error as Error).message;
	}
	throw new Error(`expected ${code}, but the call succeeded`);
}

function portFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

class Server {
	private child: ChildProcess | null = null;
	readonly storage = mkdtempSync(join(tmpdir(), "wlp-factory-e2e-"));
	readonly secret = randomBytes(24).toString("hex");
	text = "";

	async start(env: Record<string, string>): Promise<void> {
		const log = createWriteStream(join(this.storage, "server.log"), { flags: "a" });
		const full: Record<string, string | undefined> = {
			...process.env,
			WLP_DEMO: "1",
			WLP_SANDBOX: "fake",
			WLP_SECRET: this.secret,
			RIVETKIT_STORAGE_PATH: this.storage,
			RIVET_RUN_ENGINE_PORT: String(ENGINE_PORT),
			WLP_HTTP_PORT: String(HTTP_PORT),
			WLP_WEB_ORIGINS: ORIGIN,
			WLP_FAKE_DELAY_MS: "10",
			// Work items are off unless a deployment turns them on (config.ts): these servers do, but the last.
			WLP_ITEMS: "1",
			WLP_DAILY_SANDBOX_SECONDS: "unlimited",
			WLP_MAX_KEPT_SANDBOXES: "unlimited",
			...env,
		};
		delete full.RIVET_ADMIN_TOKEN;
		delete full.RIVET_ENDPOINT;
		const entry = env.WLP_FEATURE_TEST_GIT ? ["--import", "../scripts/feature-git-fixture.ts", "src/index.ts"] : ["src/index.ts"];
		const child = spawn(process.execPath, ["--import", "tsx", ...entry], { cwd: SERVER_DIR, env: full, stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		const keep = (chunk: Buffer) => {
			this.text += chunk.toString("utf8");
			log.write(chunk);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("exit", () => {
			if (this.child === child) this.child = null;
		});
		await waitFor("the server to answer", async () => {
			if (!this.child) throw new Error(`the server exited while starting:\n${this.text.slice(-1500)}`);
			return (await fetch(`${API}/platform/info`).catch(() => null))?.ok;
		}, 120_000, 400);
	}

	/** As a deploy stops it: SIGTERM, then the grace period. The engine it started is stopped by its PID, and its ports waited for. */
	async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill(signal);
		await waitFor("the server to exit", () => this.child === null, 45_000, 100).catch(() => child.kill("SIGKILL"));
		await sleep(500);
		try {
			const runtime = JSON.parse(readFileSync(join(this.storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8")) as { pid?: number };
			if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
		} catch {
			// No engine left, which is the point.
		}
		await waitFor("the engine's ports to be free", async () => (await Promise.all([ENGINE_PORT, ENGINE_PORT + 1, ENGINE_PORT + 10, HTTP_PORT].map(portFree))).every(Boolean), 30_000, 200);
	}

	remove(): void {
		if (failed === 0) rmSync(this.storage, { recursive: true, force: true });
		else console.log(`server state and log kept in ${this.storage}`);
	}
}

type Client = ReturnType<typeof createClient<Registry>>;

async function fixtureLogin(client: Client, code: string) {
	const login = client.login.getOrCreate([`a_${randomBytes(8).toString("hex")}`]);
	const { redirectPrefix } = await login.start();
	return login.finish(`${redirectPrefix}?${new URLSearchParams({ code })}`);
}

/** One server with a GitHub stand-in, a user connected to it as "ada", and a repository. */
async function world(server: Server, standin: GithubStandin, env: Record<string, string> = {}, loginCode?: string) {
	await server.start({ ...standin.env(), ...env });
	const client: Client = createClient<Registry>({ endpoint: ENDPOINT, headers: { Origin: ORIGIN } });
	const auth: AuthResult = loginCode ? await fixtureLogin(client, loginCode) : await client.login.getOrCreate([`a_${randomBytes(8).toString("hex")}`]).demo();
	const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
	const { url } = await user.githubConnect({ origin: ORIGIN });
	const back = await fetch(standin.authorize("ada", url), { redirect: "manual" });
	const location = back.headers.get("location") ?? "";
	const ticket = location.includes("#github=") ? location.slice(location.indexOf("#github=") + 8) : "";
	assert(ticket !== "", `GitHub's callback sent the browser to ${location.slice(0, 100)}`);
	await user.githubComplete(ticket);
	return { client, auth, user };
}

/** The item as its page shows it, once `ready` holds of it. */
function untilItem(user: { item(id: string): Promise<ItemView> }, id: string, what: string, ready: (view: ItemView) => boolean, timeoutMs = 60_000): Promise<ItemView> {
	return waitFor(what, async () => {
		const view = await user.item(id);
		return ready(view) ? view : null;
	}, timeoutMs, 400);
}

const said = (view: ItemView) => view.events.map((event) => event.said);
const stateOf = (view: ItemView) => `${view.state}${view.wait ? ` (${view.wait.reason}: ${view.wait.sentence})` : ""}${view.question ? ` asks “${view.question.text}”` : ""}`;

/** Sets what CI reports for a branch at the stand-in. */
function setCi(repository: StandinRepository, branch: string, conclusion: "success" | "failure", name = "build"): void {
	const run = { id: Math.floor(Math.random() * 1e6), name, status: "completed", conclusion, app: { slug: "github-actions" }, html_url: `https://ci.invalid/${name}`, output: { summary: conclusion === "failure" ? "2 tests failed" : "ok" } };
	repository.ci.set(branch, { runs: [run], statuses: [] });
}

async function api(path: string, init: RequestInit & { token?: string; key?: string; transport?: typeof fetch } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const { token, key, transport = fetch, ...request } = init;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers.authorization = `Bearer ${token}`;
	if (key) headers["idempotency-key"] = key;
	const response = await transport(`${API}${path}`, { ...request, headers });
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------------------------

const standin = new GithubStandin({ callbackUrl: `${API}/github/callback`, strictBranches: false });
await standin.start();
standin.addUser("ada");
const installation = standin.addInstallation("ada", "User");
const harbor = standin.addRepository({ owner: "ada", name: "harbor", private: true, installation, files: { ".github/workflows/build.yml": "on: pull_request\n", "README.md": "# harbor\n", "notes.txt": "Review notes.\n" } });
standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write", checks: "write", statuses: "read", actions: "read" };

if (!only.length || only.some(name => name.startsWith("user-limits"))) {
	const server = new Server();
	try {
		await check("user-limits: the operator changes one account; charged turns finish and further turns wait", async () => {
			const { config } = await import("../server/src/config.js");
			const { issueServiceToken } = await import("../server/src/tokens.js");
			const { limitsSubject } = await import("../server/src/user-limits.js");
			const { user, client, auth } = await world(server, standin, { WLP_SECRET: config.signingKeys[0].secret.toString(), WLP_DAILY_TOKENS: "9000000" });
			try {
				const uid = auth.profile.uid, operator = "test-operator";
				const second = await client.login.getOrCreate([`a_${randomBytes(8).toString("hex")}`]).demo();
				const other = client.user.getOrCreate([second.profile.uid], { params: { token: second.token } });
				const params = { token: issueServiceToken(limitsSubject(uid, operator)) };
				const admin = client.user.get([uid], { params });
				const change = { operator, key: "dailyTokens", value: 1 };
				await refused(() => user.internalSetLimit(change), "forbidden");
				await refused(() => user.internalLimitHistory(operator), "forbidden");
				await refused(() => client.user.get([second.profile.uid], { params }).internalSetLimit(change), "forbidden");
				await refused(() => admin.internalSetLimit({ ...change, value: 1.5 }), "bad_input");
				await admin.internalSetLimit(change);
				await admin.internalSetLimit(change); // Retry after a lost reply.
				await admin.internalSetLimit({ ...change, key: "featureMultiplier", value: 2 });
				await admin.internalSetLimit({ ...change, key: "item.tokens", value: 123456 });
				const history = await admin.internalLimitHistory(operator);
				assert(history.length === 3 && history[2].operator === operator && history[2].old_value === 9000000 && history[2].new_value === 1 && history[2].at > 0, "wrong audit trail");
				assert((await other.factoryLimits()).dailyTokens === 9000000 && (await other.usage()).usedModelTokens === 0, "one account changed another");
				const ownSession = await other.createSession({ profile: "docker-hardened" });
				const own = client.agentSession.get([second.profile.uid, ownSession.id], { params: { token: second.token } });
				await own.prompt({ text: "Run two parallel tool calls." });
				const ownEnd = await waitFor("the other user's interactive turn", async () =>
					(await own.snapshot()).timeline.find(e => e.kind === "turn.ended"), 60_000);
				assert(ownEnd.usage && ownEnd.usage.inputTokens > 0, "the fixture reported no model usage");
				await other.deleteSession(ownSession.id);
				assert((await other.usage()).usedModelTokens === ownEnd.usage.inputTokens + ownEnd.usage.outputTokens, "deleting an interactive session lost its usage");
				assert((await user.usage()).usedModelTokens === 0, "another user's turn spent this user's tokens");
				const filing = { repository: { id: harbor.id }, title: "Write notes", body: "Run two parallel tool calls." };
				const feature = await user.createItem({ ...filing, mode: "orchestrate", start: false });
				assert(feature.budget.tokens === 246912, "new feature did not receive the effective item budget and multiplier");
				const item = await user.createItem({ ...filing, mode: "single", start: true });
				const session = client.agentSession.get([uid, item.sessionId], { params: { token: auth.token } });
				const finished = await waitFor("the admitted Factory step to finish", async () =>
					(await session.snapshot()).timeline.find(e => e.kind === "turn.ended"), 60_000);
				assert(finished.outcome === "succeeded" && (finished.steps ?? 0) >= 2 && finished.usage, "the cap interrupted the granted multi-request turn");
				const usage = await user.usage();
				assert(usage.usedModelTokens === finished.usage.inputTokens + finished.usage.outputTokens && usage.factoryLimits.dailyTokens === 1, "the Usage total disagrees with the turn report");
				const personal = await user.createSession({ profile: "docker-hardened" });
				const agent = client.agentSession.get([uid, personal.id], { params: { token: auth.token } });
				assert((await refused(() => agent.prompt({ text: "Continue." }), "daily_token_cap")).includes("00:00 UTC"), "missing reset time on prompt refusal");
				const next = await user.createItem({ ...filing, title: "Second item", mode: "single", start: true });
				const waiting = await untilItem(user, next.id, "a daily token wait", v => v.wait?.sentence.includes("daily model token") === true);
				assert(waiting.wait?.reason === "capacity" && waiting.wait.retryAt === usage.resetsAt && !waiting.question, "the cap was not a transient wait until midnight");
				await admin.internalSetLimit({ ...change, value: "default" });
				await untilItem(user, next.id, "the waiting turn after restoring the deployment cap", v => v.spent.turns > 0);
				assert((await user.factoryLimits()).dailyTokens === 9000000, "removing the override did not restore the default");
				return "one account, an audited reset, accurate input/output and a resumed Factory turn";
			} finally { await client.dispose(); }
		});
	} finally { await server.stop(); server.remove(); }
	if (only.length === 1) { await standin.stop(); process.exit(failed ? 1 : 0); }
}

if (!only.length || only.some(name => name.startsWith("orchestrator"))) {
	const singleServer = new Server();
	try {
		await check("orchestrator single: Run as single item resumes with builder permissions and passes its saved check", async () => {
			const repo = standin.addRepository({ owner: "ada", name: "single-handoff", installation, files: { "README.md": "# Notes\n" } });
			const { user, client, auth } = await world(singleServer, standin, { WLP_FEATURE_TEST_GIT: join(singleServer.storage, "git") });
			await user.saveRepositoryChecks({ repositoryId: repo.id, checks: [{ name: "build", command: "true" }] });
			const item = await user.createItem({ repository: { id: repo.id }, title: "Add one note", body: "Write the requested note. (suggest-single)", start: true });
			const proposed = await untilItem(user, item.id, "a single-item suggestion", v => !!v.question);
			assert(proposed.plan?.singleSuggested && proposed.question?.kind === "single_suggested", "The planner did not suggest single.");
			const spec = { goal: "Record one note.", requirements: ["Preserve the original line endings."], acceptance: ["The note ends with a newline."], outOfScope: ["Reformatting existing notes."] };
			const edited = await user.actOnItem({ id: item.id, action: { kind: "edit_plan", version: proposed.plan.version, plan: { ...proposed.plan, spec } } });
			await user.actOnItem({ id: item.id, action: { kind: "answer", question: edited.question!.id, choice: "run_single" } });
			const result = await untilItem(user, item.id, "the implementation result", v => !!v.pullRequest || !!v.question);
			const session = client.agentSession.get([auth.profile.uid, item.sessionId], { params: { token: auth.token } });
			const { timeline } = await session.snapshot();
			const opens = timeline.flatMap(e => e.kind === "windlass" && e.event.type === "fake.session_open" ? [e.event] : []);
			const prompt = timeline.find(e => e.kind === "user" && e.turn === 2);
			assert(prompt?.kind === "user", "The implementing turn has no prompt.");
			for (const line of [...spec.requirements, ...spec.acceptance, ...spec.outOfScope]) assert(prompt.text.includes(line), "The builder prompt omitted " + line);
			const [plan, build] = opens;
			assert(plan?.data?.method === "session/new" && build?.data?.method === "session/resume" && plan.sessionId === build.sessionId, "The handoff lost the planner conversation.");
			const meta = (build.data.params as { _meta: { windlass: { agent?: string; hostTools: { name: string }[] } } })._meta.windlass;
			assert(meta.agent === "none" && meta.hostTools.some(t => t.name === "report") && !meta.hostTools.some(t => t.name === "file_plan"), `Implement selected agent ${meta.agent} and tools ${meta.hostTools.map(t => t.name).join(", ")}.`);
			assert(result.pullRequest && result.events.some(e => e.said === "The checks passed."), stateOf(result));
			const branch = branchFor(item.title, item.sessionId);
			assert(standin.fileOn(repo, branch, "notes/turn-2.md")?.includes("Write the requested note."), "The implement turn did not write the requested file.");
			assert(standin.fileOn(repo, branch, "notes/turn-1.md") === null, "The planner wrote a file.");
			return "the same conversation wrote a file on its second turn and passed build";
		});
	} finally { await singleServer.stop(); singleServer.remove(); }
	const refusalServer = new Server();
	try {
		await check("orchestrator refusal: a planner's provider 400 reaches the owner on its first attempt", async () => {
			const { user, client, auth } = await world(refusalServer, standin);
			const profile = "docker-windlass-sandbox";
			await user.saveRepositorySecret({ repositoryId: harbor.id, profile, name: "TEST_VALUE", scope: "agent", value: "fixture-secret-value" });
			const item = await user.createItem({ repository: { id: harbor.id }, profile, title: "Plan the search", body: "Search the repository. (invalid-effort)", mode: "orchestrate", start: true });
			const view = await untilItem(user, item.id, "the planner's question", v => !!v.question);
			const session = client.agentSession.get([auth.profile.uid, view.sessionId], { params: { token: auth.token } });
			const snapshot = await session.snapshot();
			const end = snapshot.timeline.find(e => e.kind === "turn.ended");
			const reason = "HTTP 400: Invalid value: 'ultra'. Supported values are: 'none','minimal','low','medium','high','xhigh','max'. [param: reasoning.effort]";
			assert(end?.kind === "turn.ended" && end.outcome === "failed" && end.message?.includes(reason), "turn ending: " + JSON.stringify(end));
			assert(view.question?.kind === "turn_refused" && view.question.text.includes(reason), stateOf(view));
			assert(view.spent.turns === 1 && snapshot.summary.turns === 1 && view.question.choices.map(c => c.id).join() === "again,give_up", stateOf(view));
			assert(!JSON.stringify([snapshot.timeline, view]).includes("fixture-secret-value"), "provider error leaked a saved secret");
			await user.actOnItem({ id: item.id, action: { kind: "answer", question: view.question.id, choice: "again" } });
			await untilItem(user, item.id, "the retried planner", v => v.spent.turns === 2);
			const prompts = (await session.snapshot()).timeline.filter(e => e.kind === "user");
			assert(prompts.length === 2, "expected two planner deliveries");
			for (const prompt of prompts) assert(prompt.text.split("Placement inventory (read-only data):").length === 2,
				`turn ${prompt.turn} has ${prompt.text.split("Placement inventory (read-only data):").length - 1} inventories`);
			return view.question.text;
		});
	} finally { await refusalServer.stop(); refusalServer.remove(); }
	const usageServer = new Server();
	try {
		await check("orchestrator usage: Windlass two-hour reset reaches the item and gates later work", async () => {
			const { user, client, auth } = await world(usageServer, standin, { WLP_ALLOWED_EMAILS: "routing@example.com" }, "routing");
			const startedAt = Date.now();
			const item = await user.createItem({ repository: { id: harbor.id }, title: "Run the checks", body: "Run (usage-limit)", start: true });
			const view = await untilItem(user, item.id, "the provider outcome", v => !!v.question || v.wait?.reason === "provider");
			assert(view.wait?.reason === "provider" && !view.question && view.wait.retryAt! >= startedAt + 121 * 60_000, stateOf(view));
			const snapshot = await client.agentSession.get([auth.profile.uid, item.sessionId], { params: { token: auth.token } }).snapshot();
			assert(!JSON.stringify([snapshot.timeline, view]).includes("canary"), "private Windlass limit fields reached the page");
			const next = await user.createItem({ repository: { id: harbor.id }, title: "Continue checks", body: "Verify the build", start: true });
			const queued = await untilItem(user, next.id, "the account cooldown", v => v.wait?.reason === "provider");
			assert(queued.spent.turns === 0 && queued.wait?.retryAt === view.wait.retryAt, stateOf(queued));
			const renewed = await fixtureLogin(client, "routing");
			assert(renewed.profile.uid === auth.profile.uid, "the second login must replace the same account");
			await untilItem(user, item.id, "the refused turn to retry on the new login", v => v.spent.turns >= 2, 15_000);
			return view.wait.sentence;
		});
	} finally { await usageServer.stop(); usageServer.remove(); }
	const unknownServer = new Server();
	try {
		await check("orchestrator usage: unknown Windlass reset asks the owner and blocks a second item for fifteen minutes", async () => {
			const { user } = await world(unknownServer, standin);
			const start = Date.now();
			const first = await user.createItem({ repository: { id: harbor.id }, title: "Run checks", body: "Run (usage-limit-unknown)", start: true });
			const view = await untilItem(user, first.id, "the unknown reset question", v => !!v.question);
			assert(view.question?.kind === "turn_refused", stateOf(view));
			const next = await user.createItem({ repository: { id: harbor.id }, title: "Review changes", body: "Review the changes", start: true });
			const queued = await untilItem(user, next.id, "the next admission", v => v.wait?.reason === "provider" || v.spent.turns > 0);
			const until = queued.wait?.retryAt;
			assert(queued.wait?.reason === "provider" && until && until >= start + 900_000 && until <= Date.now() + 900_000 && queued.spent.turns === 0, stateOf(queued));
			return queued.wait.sentence;
		});
	} finally { await unknownServer.stop(); unknownServer.remove(); }
	if (only.length === 1 && only[0] === "orchestrator usage") { await standin.stop(); process.exit(failed ? 1 : 0); }
	if (only.length === 1 && only[0] === "orchestrator refusal") { await standin.stop(); process.exit(failed ? 1 : 0); }
}

if (!only.length || only.some(name => name.startsWith("orchestrator"))) {
	const server = new Server();
	try {
		await check("orchestrator: Orchestrate anyway replans, integrates two checked children and hands over one reviewed PR", async () => {
			const { user, client, auth } = await world(server, standin, { WLP_FACTORY_REVIEWER: "on", WLP_GITHUB_WEBHOOK_SECRET: server.secret, WLP_FEATURE_TEST_GIT: join(server.storage, "git") });
			await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{name:"build",command:"true"}] });
			const single = (await user.factoryLimits()).item;
			const token = (await user.createApiToken({ name: "feature", scopes: ["items:create", "items:read"] })).secret;
			const filing = await api("/api/items", {method:"POST", token, key:"search-feature", body:JSON.stringify({repository:{id:harbor.id}, title:"Search documents", body:"Index documents and show the result. (suggest-single)", start:true})});
			assert(filing.status === 201 && typeof filing.body.id === "string", "The API refused feature filing.");
			const feature = await user.item(filing.body.id);
			const suggestion = await untilItem(user, feature.id, "the single-item suggestion", v => !!v.question);
			assert(suggestion.question?.kind === "single_suggested", "Expected a single-item suggestion.");
			await user.actOnItem({id:feature.id, action:{kind:"answer", question:suggestion.question.id, choice:"orchestrate_anyway"}});
			const page = await untilItem(user, feature.id, "split plan approval", v => v.question?.kind === "plan_approval");
			assert(page.plan?.status === "proposed", "The planner did not file a valid plan: " + page.question?.text);
			assert(!page.pullRequest && !page.children?.length, "Work started before approval.");
			const invalid = structuredClone(page.plan);
			invalid.subtasks[0].budget.tokens = 0;
			await refused(() => user.actOnItem({id:feature.id, action:{kind:"edit_plan", version:invalid.version, plan:invalid}}), "bad_input");
			const checkedPlan = structuredClone(page.plan);
			checkedPlan.subtasks[0].brief += " (change-setup-fixture)";
			checkedPlan.subtasks[1].brief += " (consume-setup-fixture)";
			const edited = await user.actOnItem({id:feature.id, action:{ kind:"edit_plan", version:page.plan.version, plan:checkedPlan }});
			await refused(() => user.actOnItem({id:feature.id,action:{kind:"approve_plan",version:page.plan!.version}}), "item_conflict");
			const version = edited.plan!.version;
			await user.saveRepositoryChecks({repositoryId:harbor.id,checks:[]});
			const approve = () => user.actOnItem({id:feature.id, action:{kind:"approve_plan", version}});
			const noChecks = await refused(approve, "bad_input");
			assert(/single.*checks/i.test(noChecks), "Missing saved-check guidance: " + noChecks);
			await user.saveRepositoryChecks({repositoryId:harbor.id,checks:[{name:"build",command:"true"}]});
			const noCi = await refused(() => user.actOnItem({id:feature.id, action:{kind:"answer",question:edited.question!.id,choice:"approve"}}), "bad_input");
			assert(/single.*push/i.test(noCi), "Missing push CI guidance: " + noCi);
			standin.commit(harbor, "main", {".github/workflows/build.yml":"on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{run: 'true'}]\n"}, "Run build on push");
			standin.commit(harbor, "main", { "index/setup.sh": 'test -n "$SETUP_FIXTURE" && echo seed-setup\n' }, "Add setup fixture");
			await user.saveRepositorySetup({ repositoryId: harbor.id, command: "sh index/setup.sh" });
			await user.saveRepositorySecret({ repositoryId: harbor.id, profile: "docker-windlass-sandbox", name: "SETUP_FIXTURE", scope: "setup", value: "fixture-only" });
			const base = standin.branchHead(harbor,"main")!;
			await user.actOnItem({id:feature.id,action:{kind:"approve_plan",version}});
			const done = await untilItem(user,feature.id,"the feature handoff",v => {
				if (v.run?.step.kind === "subtasks") assert(!standin.checks.some(r => r.external_id.includes(feature.id)), "A check appeared during feature integration");
				for (const child of v.children ?? []) {
					const pushed = standin.branchHead(harbor, branchFor(child.title, child.sessionId));
					if (pushed && !harbor.ci.has(pushed)) setCi(harbor, pushed, "success");
				}
				return v.state === "review" || !!v.question || !!v.children?.some(child => child.question);
			}, 320_000);
			assert(done.state === "review", done.question?.text ?? done.children?.find(child => child.question)?.question?.text ?? stateOf(done));
			const read = await api("/api/items/" + feature.id, {token});
			assert(read.status === 200 && Array.isArray(read.body.children) && read.body.children.length === 2, "The feature API omitted its children.");
			assert(done.children?.length === 2 && done.children.every(s => s.verdict?.ci === "passed" && s.state === "done" && !s.pullRequest && s.review?.state === "off"), "Children did not finish as branches.");
			assert(standin.fileOn(harbor, "windlass/feature-" + feature.id, "notes/turn-1.md") !== null, "Neither child built files on the feature branch");
			assert(done.spent.turns === 6 && done.budget.tokens === 3*single.tokens, "Unexpected feature spend " + JSON.stringify(done.spent));
			await waitFor("one successful feature check", () => standin.checks.find(r => r.external_id === done.verdicts.at(-1)?.id && r.conclusion === "success"), 30_000);
			assert(standin.checks.filter(r => r.external_id.includes(feature.id)).length === 1 && !standin.checks.some(r => done.children!.some(child => r.external_id.includes(child.id))), "Extra feature or child checks were posted");
			const [first, secondChild] = done.children;
			const firstHead = standin.branchHead(harbor, branchFor(first.title, first.sessionId))!;
			assert(standin.fileOn(harbor, branchFor(first.title, first.sessionId), "index/setup.sh") === "echo child-setup\n", "The first subtask did not change the setup script.");
			const snapshot = await client.agentSession.get([auth.profile.uid, secondChild.sessionId], { params: { token: auth.token } }).snapshot();
			const setup = snapshot.timeline.find(e => e.kind === "setup" && e.state === "succeeded");
			assert(setup?.kind === "setup" && setup.output.trim() === "seed-setup", "The second subtask must run the seed setup with the fixture secret. Observed " + (setup?.kind === "setup" ? setup.output : "no successful setup"));
			const parent = standin.branchHead(harbor, branchFor(secondChild.title, secondChild.sessionId))!;
			const log = (format: string, sha: string) => execFileSync("git", ["show","-s","--format="+format,sha], {cwd:harbor.path,encoding:"utf8"}).trim();
			assert(log("%P", parent) === firstHead, "The second child did not build directly on the first child's commit");
			assert(log("%s", firstHead + "^") === "Start feature " + feature.id && log("%P", firstHead + "^") === base, "The first child missed the feature marker");
			assert(done.head === parent && done.reviews.length === 1 && done.report && done.pullRequest, "Missing final head, summary, review or PR.");
			const ready = await waitFor("the single ready PR", () => standin.pulls.find(p=>p.repository===harbor.id && p.number===done.pullRequest!.number && !p.draft && p.comments.length), 30_000);
			assert(standin.branchHead(harbor, ready.head) === parent && standin.branchHead(harbor,"main") === base, "Incorrect ref after handoff.");
			assert(!(await user.listItems()).some(i => i.parent), "A child leaked into the root list.");
			const owner = standin.users.get("ada")!;
			const { review } = standin.submitReview(harbor, ready, owner, "changes_requested", "Please add a regression check.");
			const delivery = await standin.deliver(API + "/github/webhook", "pull_request_review", { installation: { id: installation.id }, repository: { id: harbor.id },
				action: "submitted", sender: review.user, pull_request: { number: ready.number }, review }, { secret: server.secret });
			assert((await delivery.json()).taken, "The feature review was dropped.");
			const replanning = await untilItem(user, feature.id, "the feedback planner", v => v.run?.n === 2 && v.run.step.kind === "refine");
			assert(replanning.feedback.batches.some(b => b.run === 2 && b.state === "taken"), "The owner’s review did not start the feature planner.");
			await waitFor("the reopened feature check", () => standin.checks.find(r => r.external_id === "pending:" + feature.id + ":2" && r.status === "in_progress"), 12_000);
			const second = await user.createItem({repository:{id:harbor.id}, title:"Cancel this feature", body:"Index and search documents.", mode:"orchestrate", start:true});
			const proposal = await untilItem(user,second.id,"a second plan",v=>v.plan?.status==="proposed" && !!v.question);
			await user.actOnItem({id:second.id,action:{kind:"approve_plan",version:proposal.plan!.version}});
			const active = await untilItem(user,second.id,"a child before cancellation",v=>v.children?.length === 1);
			await user.actOnItem({id:second.id,action:{kind:"cancel"}});
			const stopped = await untilItem(user,active.children![0].id,"the cancelled child",v=>v.state === "cancelled");
			const tree = await user.item(second.id);
			assert(tree.state === "cancelled" && tree.children?.length === 1 && !stopped.pullRequest, "Cancellation dispatched more work.");
			return "two child heads fast-forwarded, one summary, one whole-feature review; a second feature cancelled its child";
		});
	} finally { await server.stop(); server.remove(); }
	if (only.length === 1) { await standin.stop(); process.exit(failed ? 1 : 0); }
}

if (!only.length || only.some(name => name.startsWith("reviewer"))) {
	const server = new Server();
	try {
		const head = "a".repeat(40);
		setCi(harbor, head, "success");
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=";
		const { config } = await import("../server/src/config.js");
		const { client, user, auth } = await world(server, standin, { WLP_SECRET: config.signingKeys[0].secret.toString(), WLP_FACTORY_REVIEWER: "on", WLP_FAKE_REVIEW_HEAD: head, WLP_FAKE_BACKUP_DIR: join(server.storage, "shots"), WLP_FAKE_BUCKET_SIGNING_SECRET: randomBytes(32).toString("hex"), WLP_FAKE_ATTACHMENT_PNG: png, WLP_IDLE_SUSPEND_MS: "1000" });
		await check("reviewer: platform info says the second review is on", async () => {
			const info = (await (await fetch(`${API}/platform/info`)).json()) as { items?: { reviewer?: unknown } };
			assert(info.items?.reviewer === true, `platform info has items: ${JSON.stringify(info.items)}`);
			return "items: { reviewer: true }";
		});
		await check("reviewer: builder and reviewer keep their profile mode", async () => {
			const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Fixed modes", body: "Read the repository.", start: false });
			const view = await user.item(item.id);
			assert(view.reviewerSessionId, "missing reviewer session");
			for (const id of [view.sessionId, view.reviewerSessionId]) {
				const agent = client.agentSession.get([auth.profile.uid, id], { params: { token: auth.token } });
				await refused(() => agent.setMode({ mode: "ask" }), "bad_input");
				const { summary } = await agent.snapshot();
				assert(summary.mode === "auto" && summary.availableModes.length === 0, JSON.stringify(summary));
			}
			return "both sessions refused setMode and retained auto";
		});
		await check("reviewer: actual turn offer, independent filing, head, comment, ownership and both ledgers", async () => {
			const profile = "docker-windlass-sandbox";
			await user.saveRepositoryDefaults({ repositoryId: harbor.id, screenshots: true });
			await user.saveRepositorySecret({ repositoryId: harbor.id, profile, name: "BUILD_ONLY", scope: "agent", value: "fixture-builder-only-value" });
			await user.saveRepositorySecret({ repositoryId: harbor.id, profile, name: "SETUP_ONLY", scope: "setup", value: "fixture-setup-only-value" });
			await user.saveAccountSecret({ profile, name: "ACCOUNT_ONLY", scope: "agent", value: "fixture-account-only-value" });
			await user.savePersonalServer({ name: "builder-notes", definition: { command: "cat" } });
			await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "build", command: "true" }] });
			await user.saveRepositorySetup({ repositoryId: harbor.id, command: "true" });
			const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Review the homepage", body: "Change the homepage. (report) (review-files) (lookup-limit)", start: true });
			const view = await untilItem(user, item.id, "the second review handoff and its published check", v => v.state === "review" && v.verifiedCheck?.state === "completed", CI_WAIT_MS);
			assert(view.reviewerSessionId, "missing reviewer session");
			const keys = [auth.profile.uid, view.reviewerSessionId];
			const session = client.agentSession.get(keys, { params: { token: auth.token } });
			const snapshot = await session.snapshot();
			const first = snapshot.timeline.find(e => e.kind === "user");
			const inbox = snapshot.timeline.find(e => e.kind === "windlass" && e.event.type === "inbox.enqueued");
			assert(first?.kind === "user" && first.text === `Review pull request #${view.pullRequest?.number} at aaaaaaa against the task and its acceptance criteria.`, "missing short stored review prompt");
			assert(inbox?.kind === "windlass" && JSON.stringify(inbox.event.data?.content) === JSON.stringify([{ type: "text", text: first.text }]), "Windlass prompt echo differs from the stored prompt");
			const lookup = snapshot.timeline.find(e => e.kind === "windlass" && e.event.type === "fake.review_reply" && e.event.data?.lookup);
			assert(lookup?.kind === "windlass" && String(lookup.event.data?.lookup).includes("only the commands field") && snapshot.summary.turns === 1, "lookup must refuse extra fields and leave the fourth filing available");
			const fileCalls = standin.requests.map(r => r.path.split("?")[0]!.split("/").pop() ?? "").filter(p => ["access_tokens", "token", "README.md", "notes.txt"].includes(p));
			const firstRead = fileCalls.indexOf("README.md");
			assert(firstRead > 0 && fileCalls.slice(firstRead - 1, firstRead + 3).join() === "access_tokens,README.md,notes.txt,token", `expected one mint and revoke around both reads, got ${fileCalls.slice(firstRead - 1, firstRead + 4)}`);
			const event = snapshot.timeline.find(e => e.kind === "windlass" && e.event.type === "fake.session_open");
			const open = event?.kind === "windlass" ? event.event.data as { method: string; params: { _meta: { windlass: { hostTools: Array<{ name: string; timeoutSeconds?: number; effect: string; untrustedResult: boolean }> } } } } : null;
			const tools = open?.params._meta.windlass.hostTools;
			assert(open?.method === "session/new" && tools?.length === 1 && tools[0].name === "file_review" && tools[0].timeoutSeconds === 180 && tools[0].effect === "read" && !tools[0].untrustedResult, `actual reviewer session/new: ${JSON.stringify(open)}`);
			const setup = snapshot.timeline.find(e => e.kind === "platform" && e.text.includes("as environment variables"));
			assert(setup?.kind === "platform" && setup.text.includes("SETUP_ONLY") && !setup.text.includes("BUILD_ONLY") && !setup.text.includes("ACCOUNT_ONLY"), "reviewer setup secret scopes differ");
			assert(view.review?.state === "filed" && view.review.recommendation === "approve" && view.reviews.length === 1, "missing filed recommendation");
			const [r] = view.reviews;
			const check = standin.checks.find(run => run.repository === harbor.id && run.external_id === r.verdictId);
			assert(check && check.head_sha === r.head && check.conclusion === "success", "Missing check for the reviewed commit");
			const privateWords = [view.task.title, view.task.body, ...view.task.acceptance, view.report?.title, ...r.blocks.map(b => "text" in b ? b.text : "")];
			assert(!privateWords.some(words => words && check.output.summary.includes(words)), "Private task or filing text reached the public check");
			assert(check.output.summary.includes("0 blocking findings"), "The public check omitted the review counts");
			const [shot] = r.screenshots;
			assert(r.head === head && r.base === standin.branchHead(harbor, "main") && r.by.sessionId === view.reviewerSessionId && r.verdictId === view.verdicts[0]?.id && view.verdicts.length === 1, "review provenance or strip differs");
			assert(r.blocks.some(b => b.kind === "text" && b.refs[0]?.ref === "command/review_step/shell_1") && r.records.some(record => record.kind === "command" && record.command === "pwd" && record.exitCode === 0), "missing reviewer command");
			assert(shot?.by === "reviewer" && shot.sessionId === view.reviewerSessionId && shot.head === r.head && shot.width === 1 && shot.state === "kept" && r.blocks.some(b => b.kind === "screenshot" && b.attachment === shot.id) && (await user.itemAttachmentLinks(item.id)).some(link => link.id === shot.id), "missing reviewer screenshot");
			const pull = standin.pulls.find(p => p.repository === harbor.id && p.number === view.pullRequest?.number)!;
			const comment = await waitFor("review comment", () => pull.comments[0]?.body, 30000);
			assert(comment.includes("Second review at aaaaaaa: approves.") && comment.indexOf("Builder's report") > comment.indexOf("Second review at") && comment.includes("1 screenshot"), "comment order or review text incorrect");
			const own = (await user.listSessions()).filter(s => s.item?.id === item.id);
			assert(snapshot.summary.item?.id === item.id && snapshot.summary.item.role === "reviewer" && own.some(s => s.id === item.sessionId && s.item?.role === "builder"), "sessions do not belong to the item");
			assert(!own.some(s => s.id === view.reviewerSessionId), "reviewer was listed as an agent");
			await refused(() => session.prompt({ text: "another prompt" }), "item_session");
			const { serviceParams } = await import("../server/src/auth.js");
			await refused(() => client.agentSession.get(keys, { params: serviceParams() }).internalPublish({ key: "test", title: "No", body: "" }), "reviewer");
			const receipt = await client.agentSession.get(keys, { params: serviceParams() }).internalCheckTurn({ turn: r.id, check: "replay" });
			assert(receipt?.kind === "review_ended" && receipt.review?.id === r.id, "review receipt was lost");
			await client.workItem.get([auth.profile.uid, view.id], { params: serviceParams() }).internalFact(receipt);
			const replay = await user.item(view.id);
			assert(replay.reviews.length === 1 && replay.verdicts.length === 1 && replay.spent.turns === 2 && replay.revision === view.revision, "duplicate review receipt changed the item");
			const usage = await user.usage();
			assert(snapshot.summary.sandbox === "none" && !usage.kept.some(row => row.sessionId === view.reviewerSessionId) && usage.kept.some(row => row.sessionId === view.sessionId), "a filed review must release its sandbox and kept place while keeping the builder's");
			const ledger = usage.today.filter(r => r.sessionId === view.sessionId || r.sessionId === view.reviewerSessionId);
			assert(ledger.length === 2 && ledger.every(row => row.seconds > 0) && view.spent.hostedSeconds === ledger.reduce((n, row) => n + row.seconds, 0), `item ${view.spent.hostedSeconds}s; ledger ${JSON.stringify(ledger)}`);
			return `file_review alone; one verdict, one review, a verified PNG and ${view.spent.hostedSeconds}s across two sessions`;
		});
		await check("reviewer: changes requested sends the builder back once, and the next round answers it and approves", async () => {
			const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Review loop", body: "Change the homepage. (review-loop)", start: true });
			const view = await untilItem(user, item.id, "the second round's handoff", v => v.state === "review" && v.reviews.length === 2 && v.verifiedCheck?.state === "completed", 2 * CI_WAIT_MS).catch(async (error) => {
				const now = await user.item(item.id);
				const replies = now.reviewerSessionId ? (await client.agentSession.get([auth.profile.uid, now.reviewerSessionId], { params: { token: auth.token } }).snapshot()).timeline
					.flatMap(e => e.kind === "windlass" && e.event.type === "fake.review_reply" ? [JSON.stringify(e.event.data).slice(0, 300)] : e.kind === "user" ? [`prompt: ${e.text.slice(0, 120)}`] : []) : [];
				throw new Error(`${error instanceof Error ? error.message : String(error)}: ${stateOf(now)}, step ${now.run?.step.kind}, ${now.reviews.length} reviews; ${said(now).slice(-6).join(" | ")}; reviewer: ${replies.join(" | ")}`);
			});
			const [first, second] = view.reviews;
			assert(first.recommendation === "changes_requested" && first.round === 1 && first.blocks.some(b => b.kind === "finding" && b.id === "r1.f1" && b.severity === "blocking"), `round 1: ${first.recommendation} ${first.round}`);
			assert(second.recommendation === "approve" && second.round === 2 && second.blocks.some(b => b.kind === "earlier" && b.finding === "r1.f1" && b.status === "fixed"), `round 2: ${second.recommendation} ${second.round}`);
			assert(view.run?.rounds.review === 1 && view.run.caps.review === 2, `rounds ${JSON.stringify(view.run?.rounds)}`);
			const fixes = new Set(view.events.filter(e => e.step?.kind === "review_fix").map(e => e.step!.n));
			assert(fixes.size === 1, `review_fix steps ${[...fixes].join()}`);
			assert(view.review?.state === "filed" && view.review.recommendation === "approve" && view.verifiedCheck?.conclusion === "success", `handed ${JSON.stringify(view.review)} ${view.verifiedCheck?.conclusion}`);
			const timeline = JSON.stringify((await client.agentSession.get([auth.profile.uid, view.reviewerSessionId!], { params: { token: auth.token } }).snapshot()).timeline);
			assert(timeline.includes('r1.f1 is blocking and has no \\"earlier\\" block'), "round 2's reviewer was not held to its earlier finding");
			const builder = JSON.stringify((await client.agentSession.get([auth.profile.uid, view.sessionId], { params: { token: auth.token } }).snapshot()).timeline);
			assert(builder.includes("asks for changes before the work is handed over") && builder.includes("No check for the empty page"), "the builder's fix turn lacks the finding");
			return `2 reviews, 1 fix turn, round 2 answered r1.f1; check ${view.verifiedCheck?.conclusion}`;
		});
		await check("reviewer: networked commands hand over with the profile reason", async () => {
			const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, profile: "docker-hardened", title: "Networked profile", body: "Change the homepage.", start: true });
			const view = await untilItem(user, item.id, "the handoff without a reviewer", v => v.state === "review", CI_WAIT_MS);
			assert(view.reviewerSessionId === null && !view.reviews.length && view.review?.state === "off" && view.reviewNone?.includes("commands would run with the network"), "networked commands admitted a reviewer");
			return view.reviewNone ?? undefined;
		});
		await check("reviewer: repository screenshot opt-out reaches both agents", async () => {
			await user.saveRepositoryDefaults({ repositoryId: harbor.id, screenshots: false });
			const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Review without pictures", body: "Change the homepage. (report) (screenshot) (try-disabled-shot)", start: true });
			const v = await untilItem(user, item.id, "the text-only review", v => v.state === "review", CI_WAIT_MS);
			const timeline = async (id: string) => JSON.stringify((await client.agentSession.get([auth.profile.uid, id], { params: { token: auth.token } }).snapshot()).timeline);
			const builder = await timeline(item.sessionId), reviewer = await timeline(v.reviewerSessionId!);
			assert(!v.report && builder.includes("Screenshots are turned off") && !builder.includes("Screenshots: files you saved"), "builder offered or accepted screenshots");
			assert(v.reviews[0]?.screenshots.length === 0 && reviewer.includes("Screenshots are turned off") && !reviewer.includes("## Screenshots"), "reviewer offered or accepted screenshots");
			return "both filings enforced repository settings";
		});
	} finally { await server.stop(); server.remove(); }
}
await check("reviewer: a pull ref missing the expected commit hands over before Windlass starts", async () => {
	const server = new Server();
	try {
		const head = "a".repeat(40);
		setCi(harbor, head, "success");
		const { user, client, auth } = await world(server, standin, { WLP_FACTORY_REVIEWER: "on", WLP_FAKE_REVIEW_HEAD: head, WLP_FAKE_REVIEW_CLONE_503_ONCE: "1", WLP_FAKE_REVIEW_MISSING: "1" });
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Review the pushed commit", body: "Change the homepage.", start: true });
		const view = await untilItem(user, item.id, "the refused checkout", v => v.state === "review", CI_WAIT_MS);
		assert(view.reviewerSessionId && view.review?.state === "none" && !view.reviews.length && view.reviewNone?.includes("checkout of aaaaaaa failed"), "missing a reason for the unavailable head");
		const snapshot = await client.agentSession.get([auth.profile.uid, view.reviewerSessionId], { params: { token: auth.token } }).snapshot();
		assert(snapshot.summary.turns === 2 && view.spent.turns === 3 && snapshot.timeline.some(e => e.kind === "turn.ended" && e.outcome === "interrupted" && e.message?.includes("503")), "the temporary 503 during the base clone must interrupt the first review and retry once");
		assert(snapshot.summary.sandbox === "none" && !(await user.usage()).kept.some(row => row.sessionId === view.reviewerSessionId), "a refused review kept its sandbox or place");
		assert(!snapshot.timeline.some(e => e.kind === "windlass" && e.event.type === "fake.session_open"), "Windlass started on the wrong head");
		return view.reviewNone ?? undefined;
	} finally { await server.stop(); server.remove(); }
});
if (only.length && only.every(name => name.startsWith("reviewer"))) {
	await standin.stop();
	process.exit(failed ? 1 : 0);
}

// The actions the factory's schedules fire are looked up by name when they fire: each must be registered under that name.
await check("schedules: every action the factory schedules is registered under the name it is scheduled by", async () => {
	process.env.WLP_SECRET ??= randomBytes(24).toString("hex");
	process.env.WLP_SANDBOX = "fake";
	const { workItem, DUE_ACTION } = await import("../server/src/actors/work-item.js");
	const { user } = await import("../server/src/actors/user.js");
	const { ATTACHMENT_SWEEP_ACTION, QUEUE_ACTION } = await import("../server/src/actors/user-items.js");
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	const { OUTBOX_ACTION } = await import("../server/src/actors/session-inbox.js");
	const missing = [
		[workItem, DUE_ACTION, "workItem"],
		[user, QUEUE_ACTION, "user"],
		[user, ATTACHMENT_SWEEP_ACTION, "user"],
		[agentSession, OUTBOX_ACTION, "agentSession"],
	].filter(([definition, name]) => typeof ((definition as { config: { actions: Record<string, unknown> } }).config.actions[name as string]) !== "function");
	assert(missing.length === 0, `not registered: ${missing.map(([, name, actor]) => `${actor}.${name}`).join(", ")}`);
	return `${DUE_ACTION}, ${QUEUE_ACTION}, ${OUTBOX_ACTION}`;
});

// ---------------------------------------------------------------------------------------------
// In memory: the actors' own actions over SQLite in memory, with the sessions, the user, the
// scheduler and GitHub played here. For what a running server cannot be made to do on demand: two
// actions at once, a stop between two writes, a reply that is lost, a schedule that fires early.
// ---------------------------------------------------------------------------------------------

/** A database in memory with RawAccess's two calls, and a hook that can fail a statement once. */
function memoryDb() {
	const raw = new DatabaseSync(":memory:");
	let fail: ((sql: string) => boolean) | null = null;
	// While set, a transaction waits for it before it writes: a write in flight, held open.
	let held: Promise<void> | null = null;
	type Memory = { execute(sql: string, ...args: unknown[]): Promise<never[]>; transaction<T>(step: (tx: Memory) => Promise<T>): Promise<T> };
	const db: Memory = {
		async execute(sql: string, ...args: unknown[]) {
			if (fail?.(sql)) {
				fail = null;
				throw new Error("the server stopped here");
			}
			return raw.prepare(sql).all(...(args as never[])) as never[];
		},
		async transaction<T>(step: (tx: Memory) => Promise<T>) {
			if (held) await held;
			raw.exec("BEGIN");
			try {
				const result = await step(db);
				raw.exec("COMMIT");
				return result;
			} catch (error) {
				raw.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return {
		raw,
		db,
		failOnce: (when: (sql: string) => boolean) => void (fail = when),
		/** Holds every transaction until the returned function is called. */
		holdWrites: () => {
			let release = () => undefined as void;
			held = new Promise<void>((done) => (release = done));
			return () => {
				held = null;
				release();
			};
		},
	};
}

/** Runs the jobs an actor started with `keepAwake`, to the end. */
async function drained(jobs: Promise<unknown>[]): Promise<void> {
	while (jobs.length > 0) await Promise.allSettled(jobs.splice(0));
}

async function memoryChecks(): Promise<void> {
	process.env.WLP_SECRET ??= randomBytes(24).toString("hex");
	process.env.WLP_SANDBOX = "fake";
	const { workItem, REPORTS_TABLE, REVIEWS_TABLE, CHECKS_TABLE, FEEDBACK_TABLE } = await import("../server/src/actors/work-item.js");
	const { advance, createItem, currentKey } = await import("../server/src/factory/blueprint.js");
	const { FACTORY_DEFAULTS } = await import("../server/src/factory/budget.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { INBOX_TABLES, flushOutbox, inboxRow, queueMessage, receive, sendOutbox, withdrawWaiting } = await import("../server/src/actors/session-inbox.js");
	const { ITEM_TABLES, itemActions, loadItems, queueChanged } = await import("../server/src/actors/user-items.js");
	const { config } = await import("../server/src/config.js");
	const { UsageBook } = await import("../server/src/usage.js");
	type Item = import("../server/src/factory/types.js").FactoryItem;
	type Fact = import("../server/src/factory/types.js").Fact;
	const T = Date.now();
	const HEAD = "a".repeat(40);
	// biome-ignore lint/suspicious/noExplicitAny: the actors' contexts are played here, not built by RivetKit
	const actions = workItem.config.actions as unknown as Record<string, (c: any, ...args: any[]) => Promise<any>>;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	const createVars = (workItem.config as unknown as { createVars: (c: any, input: unknown) => Promise<unknown> }).createVars;

	// GitHub, played here, before any case can ask for the client (it is made once, on first use): the app of this process, with its calls answered in memory. Its settings are taken out again after.
	const settings = { WLP_GITHUB_API_URL: standin.apiUrl, WLP_GITHUB_APP_ID: "1", WLP_GITHUB_APP_SLUG: "memory", WLP_GITHUB_CLIENT_ID: "memory", WLP_GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"), WLP_GITHUB_PRIVATE_KEY: randomBytes(16).toString("hex") };
	Object.assign(process.env, settings);
	const { githubApp } = await import("../server/src/github/app.js");
	const app = githubApp();
	for (const name of Object.keys(settings)) delete process.env[name];
	assert(app, "no GitHub app was made in memory");
	const repository = { id: 1, name: "r", owner: "u", branch: "main", defaultBranch: "main", archived: false, private: true };
	const connection = { user: { id: 1, login: "u" }, installations: [{ id: 9, account: { id: 1, login: "u", type: "User" } }] };
	Object.assign(app, {
		installationToken: async () => ({ token: "", expiresAt: Date.now() + 3_600_000 }),
		installationRepositories: async () => ({ repositories: [repository], truncated: false }),
		repositoryById: async (_token: string, id: number) => { assert(id === repository.id, "wrong repository id"); return repository; },
		withToken: async (_installation: number, _scope: unknown, step: (token: string) => Promise<unknown>) => step(""),
	});
	/** An item driven through the blueprint by hand, as its actor would be. */
	const machine = () => {
		let item: Item = createItem({ id: "i_memory", reviewer: { off: "deployment" }, task: { title: "T", body: "B", acceptance: [], base: "main" }, place: { kind: "hosted" }, budget: { ...FACTORY_DEFAULTS.item } });
		let at = T;
		return {
			get item() {
				return item;
			},
			send(fact: Record<string, unknown>) {
				const outcome = advance(item, { at: (at += 1), key: currentKey(item), by: "person:u", ...fact } as unknown as Fact);
				item = outcome.item;
				return outcome;
			},
		};
	};

	/** A work item's actor over a database in memory: the session and the user answer as `answers` says. */
	const itemActor = async (item: Item, answers: { publish?: () => Promise<unknown>; checkTurn?: () => Promise<unknown>; facts?: () => Promise<unknown>; freeReviewer?: (sessionId: string, run: number) => Promise<void> } = {}) => {
		const memory = memoryDb();
		const { db } = memory;
		await db.execute("CREATE TABLE item (id INTEGER PRIMARY KEY, revision INTEGER, data TEXT, due TEXT)");
		await db.execute("CREATE TABLE events (seq INTEGER PRIMARY KEY, at INTEGER, data TEXT)");
		await db.execute("CREATE TABLE effects (id TEXT PRIMARY KEY, effect TEXT, due_at INTEGER, attempts INTEGER)");
		await db.execute("CREATE TABLE github_binding (id INTEGER PRIMARY KEY, installation TEXT NOT NULL)");
		await db.execute("CREATE TABLE verdicts (id TEXT PRIMARY KEY, run INTEGER, head TEXT, at INTEGER, data TEXT)");
		await db.execute(CHECKS_TABLE);
		await db.execute(REPORTS_TABLE);
		await db.execute(REVIEWS_TABLE);
		await db.execute(FEEDBACK_TABLE);
		await db.execute("CREATE TABLE issue_actions(subject TEXT PRIMARY KEY)");
		await db.execute("CREATE TABLE feedback_cursor(id INTEGER PRIMARY KEY,since INTEGER)");
		const meta = { uid: "u", sessionId: "s", reviewerSessionId: answers.freeReviewer ? "review-session" : null, reviewBase: null, handoffReview: null, repository: { id: 1 }, source: "web", createdAt: T, updatedAt: T, verdict: null, ledger: { seconds: 0, holds: [] } };
		await db.execute("INSERT INTO item VALUES (1, ?, ?, NULL)", item.revision, JSON.stringify({ item, meta }));
		const jobs: Promise<unknown>[] = [];
		const schedules: number[] = [];
		const publishes: string[] = [];
		const session = {
			internalDeliver: async () => undefined,
			internalWithdraw: async () => undefined,
			internalCheckTurn: answers.checkTurn ?? (async () => null),
			internalPublish: async (input: { key: string }) => {
				publishes.push(input.key);
				return answers.publish ? answers.publish() : { kind: "published", head: HEAD, pr: { number: 1, url: "local" } };
			},
		};
		const user = { internalItemChanged: async () => undefined, internalGithubConnection: async (): Promise<typeof connection | null> => connection, internalItemFacts: answers.facts ?? (async () => ({ hostedSeconds: 0, openItems: 1, entries: [] })) };
		const c = {
			key: ["u", "i_memory"],
			conn: { params: serviceParams() },
			db,
			log: { error: () => undefined, warn: () => undefined },
			client: () => ({
				agentSession: { get: (keys: string[]) => ({ ...session, internalFreeSandbox: (run: number) => answers.freeReviewer?.(keys[1], run) }) },
				user: { get: () => user },
				githubRepository: { getOrCreate: () => ({ internalRegister: async () => undefined, internalForget: async () => undefined }) },
			}),
			keepAwake<P>(promise: Promise<P>) {
				jobs.push(promise);
				return promise;
			},
			schedule: { at: async (at: number) => String(schedules.push(at)), cancel: async () => true },
			scheduledFire: undefined as { id: string; scheduledAt: number; firedAt: number } | undefined,
			vars: undefined as unknown,
		};
		c.vars = await createVars(c, undefined);
		return { c, db, raw: memory.raw, holdWrites: memory.holdWrites, failOnce: memory.failOnce, jobs, schedules, publishes, drain: () => drained(jobs) };
	};

	const publishedItem = () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		m.send({ kind: "published", webhooks: false, head: HEAD, pr: { number: 1, url: "local" }, openItems: 1 });
		return m;
	};
	const cleanCi = { kind: "ci_read", webhooks: false, head: HEAD, reading: { kind: "read", head: HEAD, runs: [{ name: "build", app: "ci", state: "passed", conclusion: "success", url: "", summary: "", jobId: null }], truncated: false, logs: [] }, mergeable: true, prHead: HEAD, openItems: 1 };

	await check("memory: loading a pre-reviewer item in review preserves its run and defaults its reviewer", async () => {
		const m = publishedItem();
		m.send(cleanCi);
		assert(m.item.state === "review", "fixture did not reach review");
		delete m.item.reviewer;
		delete m.item.run!.ci!.webhooks;
		delete m.item.run!.ci!.lastReadState;
		const actor = await itemActor(m.item);
		const view = await actions.internalView(actor.c);
		assert(view.state === "review" && view.revision === m.item.revision && view.reviewNone === "turned off for this deployment", "missing deployment default on the stored review");
		const loaded = (actor.c.vars as { stored: { item: Item } }).stored.item;
		assert(JSON.stringify(loaded) === JSON.stringify({ ...m.item, reviewer: { off: "deployment" } }), "loading changed the pre-reviewer item");
		await actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" });
		await actor.drain();
		const row = actor.raw.prepare("SELECT json_extract(data, '$.item.reviewer.off') AS reason FROM item").get();
		assert(row?.reason === "deployment", "the next store lost the default");
		return "original run, revision and deployment default survived reload";
	});

	await check("memory: a PR delivery during second review advances only its PR poll", async () => {
		const m = publishedItem();
		m.item.reviewer = { on: true };
		const review = m.send(cleanCi);
		const actor = await itemActor(m.item);
		await actor.db.execute("INSERT INTO github_binding VALUES (1, '9')");
		for (const effect of review.effects) {
			if ("key" in effect) await actor.db.execute("INSERT INTO effects VALUES (?, ?, ?, 0)", `${effect.kind}:${effect.key}`, JSON.stringify(effect), "at" in effect ? effect.at ?? 0 : 0);
		}
		const rows = () => actor.raw.prepare("SELECT id, due_at FROM effects ORDER BY id").all() as { id: string; due_at: number }[];
		const before = rows();
		const target = { repositoryId: 1, installationId: 9 };
		assert(!await actions.internalGithubNudge(actor.c, { ...target, kind: "ci", head: HEAD }), "CI nudged the review");
		assert(await actions.internalGithubNudge(actor.c, { ...target, kind: "pr", pr: 1 }), "PR delivery missed the review's poll");
		const after = rows();
		assert(after.some(row => row.id.startsWith("poll_pr:")) && after.every((row, i) => row.id === before[i].id &&
			(row.id.startsWith("poll_pr:") ? row.due_at < before[i].due_at : row.due_at === before[i].due_at)), "delivery rescheduled the reviewer");
		return "same delivery and watchdog, earlier PR read";
	});

	for (const end of ["handoff", "cancel"] as const) {
		await check(`memory: ${end} releases a reviewer's leftover sandbox even without an active turn`, async () => {
			const m = publishedItem();
			m.item.reviewer = { on: true };
			m.send(cleanCi);
			for (let attempt = 0; attempt < 3; attempt++) {
				m.send({ kind: "review_ended", outcome: "interrupted", review: null, said: null, spend: { tokens: 0, hostedSeconds: 0 } });
			}
			const question = m.item.question;
			assert(question?.cause === "interruptions", "the interrupted reviewer is not waiting for its owner");
			const freed: string[] = [];
			const actor = await itemActor(m.item, { freeReviewer: async (session, run) => { freed.push(`${session}:${run}`); } });
			if (end === "cancel") await actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" });
			else await actions.internalAct(actor.c, { action: { kind: "answer", question: question.id, choice: "hand_over" }, by: "person:u" });
			await actor.drain();
			assert(freed.join() === `review-session:${m.item.run!.n}`, `released ${JSON.stringify(freed)} on ${end}`);
			return "targeted only the reviewer's sandbox for this run";
		});
	}

	await check("memory: storing a builder report and the turn together survives rollback, redelivery and reload", async () => {
		const m = machine();
		m.send({ kind: "start" });
		const actor = await itemActor(m.item);
		const fact = { kind: "turn_ended", at: T + 10, key: currentKey(m.item), outcome: "succeeded", verified: null, flags: [], changes: true, spend: { tokens: 1, hostedSeconds: 0 }, pushedHead: HEAD,
			report: { screenshots: [], title: "Fix", description: "Made it work", lookAt: "src/a", concerns: "Boundary" } };
		actor.failOnce((sql) => sql.startsWith("INSERT OR REPLACE INTO reports"));
		const rolledBack = await actions.internalFact(actor.c, fact).then(() => false, () => true);
		const before = await actions.internalView(actor.c);
		assert(rolledBack && before.revision === m.item.revision && before.report === null, "the turn or report survived the failed transaction");
		await actions.internalFact(actor.c, fact);
		await actions.internalFact(actor.c, { ...fact, report: { ...fact.report, title: "Duplicate" } });
		await actor.drain();
		actor.c.vars = await createVars(actor.c, undefined);
		const after = await actions.internalView(actor.c);
		const rows = actor.raw.prepare("SELECT key FROM reports").all();
		assert(rows.length === 1 && rows[0].key === fact.key && actor.publishes.length === 1 && after.report?.title === "Fix" && after.report.head === HEAD && after.report.blocks.length === 3, "expected one unchanged report for the pushed head and step");
		return "one report row and one publish after redelivery";
	});

	for (const earlier of [false, true]) {
		await check(earlier ? "memory: an earlier round's screenshot keeps its own published head" : "memory: a screenshot filed before commit takes the published head", async () => {
			const m = machine();
			m.send({ kind: "start" });
			const second = "b".repeat(40);
			let pushed = HEAD;
			const actor = await itemActor(m.item, { publish: async () => ({ kind: "published", head: pushed, pr: { number: 1, url: "local" } }) });
			const shot = { id: "a_first", by: "builder", sessionId: "s", head: "c".repeat(40), width: 1, height: 1, bytes: 68, sha256: "c".repeat(64), caption: "First round", shows: null, page: null, state: "kept" };
			const first = { kind: "turn_ended", key: currentKey(m.item), at: T + 1, outcome: "succeeded", verified: null, flags: [], changes: true, spend: { tokens: 1, hostedSeconds: 0 }, pushedHead: null,
				report: { title: "First round", description: "", lookAt: "", concerns: "", screenshots: [shot] } };
			await actions.internalFact(actor.c, first);
			await actor.drain();
			if (earlier) {
				const key = () => currentKey((actor.c.vars as { stored: { item: Item } }).stored.item);
				const { pull, pages } = app;
				try {
					Object.assign(app, { pull: async () => ({ headSha: HEAD, mergeable: false, state: "open" }), pages: async () => ({ items: [], truncated: false }) });
					await actor.db.execute("UPDATE effects SET due_at = 0 WHERE id LIKE 'poll_ci:%'");
					actor.c.scheduledFire = { id: "conflict", scheduledAt: Date.now(), firedAt: Date.now() };
					await actions.internalDue(actor.c);
					await actor.drain();
				} finally {
					Object.assign(app, { pull, pages });
				}
				pushed = second;
				await actions.internalFact(actor.c, { ...first, key: key(), at: T + 60_002, report: null });
				await actor.drain();
			}
			const view = await actions.internalView(actor.c);
			assert(view.head === pushed, "the expected publication did not finish");
			assert(view.report?.head === HEAD && view.report.screenshots[0]?.head === HEAD, `report head ${view.report?.head}, screenshot head ${view.report?.screenshots[0]?.head}, expected ${HEAD}`);
			return earlier ? "second push without a new report preserved the first filing" : "the item report and screenshot name the confirmed push";
		});
	}

	await check("memory: two actions at once store the item's revision with its own data, and the item can still be acted on", async () => {
		const m = machine();
		m.send({ kind: "start" });
		const actor = await itemActor(m.item);
		// A session's report and a person's cancel, both decided before either is written.
		const results = await Promise.allSettled([actions.internalFact(actor.c, { kind: "turn_started", key: currentKey(m.item), at: T + 10 }), actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" })]);
		await actor.drain();
		const row = actor.raw.prepare("SELECT revision, json_extract(data, '$.item.revision') AS stored, json_extract(data, '$.item.state') AS state FROM item").get() as { revision: number; stored: number; state: string };
		assert(results.every((one) => one.status === "fulfilled"), `the actions ended ${results.map((one) => one.status).join(", ")}`);
		assert(row.revision === row.stored && row.state === "cancelled", `the column says ${row.revision}, the data ${row.stored} (${row.state})`);
		actor.c.vars = await createVars(actor.c, undefined);
		const again = await actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" }).then(() => "taken", (error: { code?: string }) => error.code);
		assert(again === "item_conflict", `cancelling again after a reload: ${again}`);
		return `revision ${row.revision} in both; cancelling again answers item_conflict, not a revision error`;
	});

	await check("memory: a cancel retires a publish waiting for its retry, and nothing is pushed for the cancelled item", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		const retry = m.send({ kind: "publish_failed", said: "GitHub could not be reached", transient: true }).effects[0] as { key: string; at: number };
		const actor = await itemActor(m.item);
		await actor.db.execute("INSERT INTO effects VALUES (?, ?, ?, 0)", `publish:${retry.key}`, JSON.stringify(retry), retry.at);
		await actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" });
		const left = actor.raw.prepare("SELECT COUNT(*) AS n FROM effects WHERE id LIKE 'publish:%'").get() as { n: number };
		// The retry's schedule fires anyway: a row read before the cancel is not sent after it either.
		await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `publish:${retry.key}`, JSON.stringify(retry));
		actor.c.scheduledFire = { id: "late", scheduledAt: retry.at, firedAt: retry.at };
		await actions.internalDue(actor.c);
		await actor.drain();
		assert(left.n === 0 && actor.publishes.length === 0, `publish rows after the cancel: ${left.n}; pushes: ${actor.publishes.length}`);
		return "the publish row went with the cancel, and one read before it was not sent";
	});

	await check("memory: an effect performed for longer than a moment keeps the item's one schedule off 'now'", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		let finish = () => undefined as void;
		const actor = await itemActor(m.item, { publish: () => new Promise((done) => (finish = () => done({ kind: "published", head: HEAD, pr: { number: 1, url: "local" } }))) });
		const publish = m.item.run?.step.kind === "publish" ? { kind: "publish", key: currentKey(m.item) } : null;
		assert(publish, "the item is not at its push");
		await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `publish:${publish.key}`, JSON.stringify(publish));
		const before = Date.now();
		actor.c.scheduledFire = { id: "first", scheduledAt: before, firedAt: before };
		const firing = actions.internalDue(actor.c);
		await new Promise((done) => setTimeout(done, 50));
		const armed = actor.schedules.at(-1) ?? 0;
		finish();
		await firing;
		await actor.drain();
		assert(armed >= before + 10_000, `the schedule was set ${armed - before} ms after the firing, while the push still ran`);
		return `set ${Math.round((armed - before) / 1000)} s ahead while the push ran, not at once`;
	});

	await check("memory: a lookup that fails around a push tries again before pushing, so a push that went through is not sent twice", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		let lookups = 0;
		const actor = await itemActor(m.item, { facts: async () => ((lookups += 1) === 1 ? Promise.reject(new Error("the user's actor did not answer")) : { hostedSeconds: 0, openItems: 1, entries: [] }) });
		const publish = { kind: "publish", key: currentKey(m.item) };
		await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `publish:${publish.key}`, JSON.stringify(publish));
		for (const id of ["first", "again"]) {
			// The retry is due 15 s on: its time is moved to now, as the schedule would.
			await actor.db.execute("UPDATE effects SET due_at = 0");
			actor.c.scheduledFire = { id, scheduledAt: Date.now(), firedAt: Date.now() };
			await actions.internalDue(actor.c);
			await actor.drain();
		}
		const item = (actor.c.vars as { stored: { item: Item } }).stored.item;
		assert(actor.publishes.length === 1 && item.pr?.number === 1, `pushes ${actor.publishes.length}; the item has ${item.pr ? `#${item.pr.number}` : "no pull request"}`);
		return "one push, after the lookup worked; the item has its pull request";
	});

	await check("memory: an item's page read while a question is being stored shows the question with the line that led to it", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_started" });
		const actor = await itemActor(m.item);
		// The turn changed nothing: the item asks its person. The page is asked for once that is decided and while it is being written.
		const release = actor.holdWrites();
		const asking = actions.internalFact(actor.c, { kind: "turn_ended", at: T + 50, key: currentKey(m.item), outcome: "succeeded", verified: null, flags: [], changes: false, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		for (let wait = 0; wait < 100 && (actor.c.vars as { stored: { item: Item } }).stored.item.question === null; wait += 1) await new Promise((done) => setTimeout(done, 5));
		const reading = actions.internalView(actor.c);
		release();
		const page = await reading;
		await asking;
		await actor.drain();
		const asked = page.events.some((event: { said: string }) => event.said.startsWith("Asked:"));
		assert((actor.c.vars as { stored: { item: Item } }).stored.item.question !== null, "the question was never decided");
		assert(page.question === null || asked, `the page shows the question “${page.question?.text}” and its log ends “${page.events.at(-1)?.said}”`);
		return page.question === null ? "read as it was stored before the question" : "the question and its line together";
	});

	await check("memory: a claim winning the withdrawal update stays started", async () => {
		const { raw, db } = memoryDb();
		for (const table of INBOX_TABLES) await db.execute(table);
		const key = "claim-first";
		await receive(db as never, { key, itemId: "item", title: "T", text: "Work", agent: null, maxSteps: 1, fetchBase: null, startsRun: true }, T);
		const racing = {
			async execute(sql: string, ...args: unknown[]) {
				if (sql.startsWith("UPDATE inbox SET state = 'withdrawn'")) {
					await db.execute("UPDATE inbox SET state = 'started', turn = 1, slot = 'slot' WHERE key = ? AND state = 'waiting'", key);
				}
				return db.execute(sql, ...args);
			},
		};
		const withdrew = await withdrawWaiting(racing as never, key);
		const row = await inboxRow(db as never, key);
		raw.close();
		assert(!withdrew && row?.state === "started" && row.slot === "slot", `withdrawal returned ${withdrew}, row is ${row?.state}`);
		return "the conditional update lost the claim and reported false";
	});

	await check("memory: a delivery withdrawn before it arrives is kept as withdrawn, and starts nothing when it comes", async () => {
		const { raw, db } = memoryDb();
		for (const table of INBOX_TABLES) await db.execute(table);
		const key = "i_memory:1:1:1";
		const withdrew = await withdrawWaiting(db as never, key);
		const fresh = await receive(db as never, { key, itemId: "i_memory", title: "T", text: "Do it", agent: null, maxSteps: 60, fetchBase: null, startsRun: true }, T);
		const row = await inboxRow(db as never, key);
		raw.close();
		assert(!withdrew && !fresh && row?.state === "withdrawn", `withdrew ${withdrew}, received ${fresh}, the row is ${row?.state}`);
		return "the late delivery found the withdrawal";
	});

	await check("memory: an outbox send that fails keeps a schedule until the row is sent", async () => {
		const { raw, db } = memoryDb();
		for (const table of INBOX_TABLES) await db.execute(table);
		const alarms = new Map<string, number>();
		let next = 0;
		let calls = 0, receipts = 0;
		let releasedEarly = false;
		const jobs: Promise<unknown>[] = [];
		const c = {
			key: ["u", "s"],
			db,
			log: { warn: () => undefined },
			client: () => ({ user: { get: () => ({ internalRecordTurnTokens: async () => { if (++receipts === 1) throw new Error("not now"); },
				internalTurnDone: async () => { if (receipts < 2) releasedEarly = true; if (++calls === 1) throw new Error("not now"); } }) } }),
			keepAwake<P>(promise: Promise<P>) {
				jobs.push(promise);
				return promise;
			},
			schedule: { at: async (at: number) => (alarms.set(String((next += 1)), at), String(next)), cancel: async (id: string) => alarms.delete(id) },
		};
		const real = Date.now;
		let now = T;
		Date.now = () => now;
		try {
			await queueMessage(db as never, { to: "tokens", receipt: { seq: 1, at: now, tokens: 100 } });
			await queueMessage(db as never, { to: "user", done: { slot: "t_1", key: "i_memory:1:1:1" } });
			await flushOutbox(c as never, "u");
			await drained(jobs);
			// Every alarm fires in its turn, the earliest first, until none is left or the row went.
			for (let round = 0; round < 5 && alarms.size > 0; round += 1) {
				const [id, at] = [...alarms].sort((a, b) => a[1] - b[1])[0] as [string, number];
				alarms.delete(id);
				now = at;
				await sendOutbox(c as never, "u");
			}
		} finally {
			Date.now = real;
		}
		const left = raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
		raw.close();
		assert(left.n === 0 && calls === 2 && receipts === 2 && !releasedEarly, `rows left ${left.n}, sends ${calls}`);
		return "sent on its retry after the safety alarm found nothing due";
	});

	const withGithub = (actor: Awaited<ReturnType<typeof itemActor>>, connected: boolean) => {
		const base = actor.c.client;
		actor.c.client = () => ({ ...base(), user: { get: () => ({ internalItemChanged: async () => undefined, internalItemFacts: async () => ({ hostedSeconds: 0, openItems: 1, entries: [] }), internalGithubConnection: async () => (connected ? connection : null) }) } });
	};

	await check("memory: a handoff finds its comment past the first hundred, and edits it rather than posting a second", async () => {
		const marker = "<!-- windlass-item:i_memory -->";
		const comments = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, user: { login: "person" }, body: "Discussion" }));
		comments.push({ id: 101, user: { login: "memory[bot]" }, body: `${marker}\nAn earlier verdict` });
		let posted = 0;
		let edited = 0;
		// The client's one door to GitHub, private to it: replaced here for the case, and put back after.
		const call = (app as unknown as { call: unknown }).call;
		Object.assign(app, {
			call: async (request: { path: string; method?: string; query?: { page?: number } }) => {
				if (request.path.endsWith("/comments") && request.method === "POST") posted += 1;
				else if (request.path.includes("/issues/comments/") && request.method === "PATCH") edited += 1;
				else if (request.path.endsWith("/comments")) {
					const from = ((request.query?.page ?? 1) - 1) * 100;
					return { status: 200, body: comments.slice(from, from + 100), next: from + 100 < comments.length };
				} else throw new Error(`no such call in memory: ${request.path}`);
				return { status: 200, body: {}, next: false };
			},
		});
		try {
			const m = machine();
			m.send({ kind: "start" });
			m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
			m.send({ kind: "published", webhooks: false, head: HEAD, pr: { number: 1, url: "local" }, openItems: 1 });
			const handed = m.send({ kind: "ci_read", webhooks: false, prHead: null, head: HEAD, reading: { kind: "read", head: HEAD, runs: [{ name: "build", app: "ci", state: "passed", conclusion: "success", url: "", summary: "", jobId: null }], logs: [], truncated: false }, mergeable: true, openItems: 1 });
			const handoff = { ...(handed.effects.find((effect) => effect.kind === "handoff") as object), reviewDone: true } as unknown as { key: string };
			const actor = await itemActor(m.item);
			withGithub(actor, true);
			await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `handoff:${handoff.key}`, JSON.stringify(handoff));
			actor.c.scheduledFire = { id: "handoff", scheduledAt: Date.now(), firedAt: Date.now() };
			await actions.internalDue(actor.c);
			await actor.drain();
			assert(posted === 0 && edited === 1, `posted ${posted}, edited ${edited}`);
			return "the comment at 101 was edited; nothing was posted";
		} finally {
			Object.assign(app, { call });
		}
	});

	await check("memory: CI that cannot be reached at all still ends in the person's question when its time is up", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		const pushed = m.send({ kind: "published", webhooks: false, head: HEAD, pr: { number: 1, url: "local" }, openItems: 1 });
		const poll = pushed.effects.find((effect) => effect.kind === "poll_ci") as { key: string; at: number };
		const actor = await itemActor(m.item);
		// The person's GitHub connection is gone: no reading can be had at all.
		withGithub(actor, false);
		const real = Date.now;
		Date.now = () => T + 91 * 60_000;
		try {
			await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `poll_ci:${poll.key}`, JSON.stringify(poll));
			actor.c.scheduledFire = { id: "poll", scheduledAt: poll.at, firedAt: Date.now() };
			await actions.internalDue(actor.c);
			await actor.drain();
		} finally {
			Date.now = real;
		}
		const item = (actor.c.vars as { stored: { item: Item } }).stored.item;
		assert(item.question?.kind === "ci_timeout", `the item is ${item.state}${item.wait ? ` (${item.wait.sentence})` : ""}`);
		return item.question.text;
	});

	await check("memory: a push to the pull request after its handover, read by the poll, makes its verdict not verified", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		m.send({ kind: "published", webhooks: false, head: HEAD, pr: { number: 1, url: "local" }, openItems: 1 });
		const review = m.send({ kind: "ci_read", webhooks: false, head: HEAD, reading: { kind: "read", head: HEAD, runs: [{ name: "build", app: "ci", state: "passed", conclusion: "success", url: "", summary: "", jobId: null }], truncated: false, logs: [] }, mergeable: true, prHead: HEAD, openItems: 1 });
		const poll = review.effects.find((effect) => effect.kind === "poll_pr") as { key: string; at: number };
		assert(m.item.state === "review" && poll, `the item is ${m.item.state}`);
		const actor = await itemActor(m.item);
		withGithub(actor, true);
		// Someone pushes to the pull request's branch after the handover: GitHub's pull request is at another commit.
		const moved = "b".repeat(40);
		const { pull, pages } = app;
		const ciPaths: string[] = [];
		Object.assign(app, {
			pages: async ({ path }: { path: string }) => {
				ciPaths.push(path);
				return { items: [], truncated: false };
			},
			pull: async () => ({ number: 1, url: "local", state: "open", mergeable: true, title: "T", body: "", head: "work", headSha: moved, base: "main", requestedReviewers: ["u"] }),
		});
		try {
			await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `poll_pr:${poll.key}`, JSON.stringify(poll));
			actor.c.scheduledFire = { id: "poll", scheduledAt: poll.at, firedAt: Date.now() };
			await actions.internalDue(actor.c);
			await actor.drain();
		} finally {
			Object.assign(app, { pull, pages });
		}
		const stored = (actor.c.vars as { stored: { item: Item; meta: { verdict: { result: string } | null } } }).stored;
		const verdicts = actor.raw.prepare("SELECT json_extract(data, '$.result') AS result, json_extract(data, '$.moved') AS moved FROM verdicts").all() as Array<{ result: string; moved: string | null }>;
		assert(ciPaths.filter((path) => path.endsWith(`/commits/${HEAD}/check-runs`)).length === 1, "the replacement verdict did not read CI once for the pushed commit");
		assert(stored.item.state === "review" && stored.meta.verdict?.result === "unverified" && verdicts.length === 1 && verdicts[0]?.result === "unverified" && verdicts[0].moved === moved, `the item is ${stored.item.state}, its summary ${stored.meta.verdict?.result}; verdicts ${JSON.stringify(verdicts)}`);
		return "the verdict became not verified when the pull request moved, in place of the pass";
	});

	/** The user actor's turn queue over a database in memory, with sessions a, b and c of items, and one of the person's own. */
	const queue = async (limits: Partial<typeof config.factory>) => {
		const memory = memoryDb();
		const { db } = memory;
		const previous = { ...config.factory };
		Object.assign(config.factory, limits);
		for (const table of ITEM_TABLES) await db.execute(table);
		const session = (id: string, item: boolean) => ({ id, status: "idle", sandbox: "none", place: { kind: "hosted" }, ...(item ? { item: { id: `i_${id}` } } : {}) });
		const sessions = new Map([...["a", "b", "c"].map((id) => [id, session(id, true)] as const), ["own", session("own", false)] as const]);
		const grants: string[] = [];
		let grantFails = false;
		const jobs: Promise<unknown>[] = [];
		const c = {
			db,
			key: ["u"],
			conn: { params: serviceParams() },
			log: { warn: () => undefined, error: () => undefined },
			broadcast: () => undefined,
			keepAwake<P>(promise: Promise<P>) {
				jobs.push(promise);
				return promise;
			},
			schedule: { at: async () => "alarm", cancel: async () => true },
			vars: { tokenGen: 0, items: await loadItems(db as never), machines: new Map<string, { name: string; since: number; status: string; sandboxes: unknown[] }>(), sessions, usage: new UsageBook({ dailySeconds: 100_000, holdSeconds: 60, maxKept: 20 }), profile: null },
			client: () => ({
				agentSession: { get: ([, id]: string[]) => ({ internalGrant: async () => (grantFails ? Promise.reject(new Error("the reply was lost")) : void grants.push(id as string)) }) },
				workItem: { get: () => ({ internalFact: async () => undefined }) },
			}),
		};
		return {
			c,
			db,
			grants,
			failOnce: memory.failOnce,
			loseGrants: (lost: boolean) => void (grantFails = lost),
			request: (id: string) => itemActions.internalRequestTurn(c as never, { sessionId: id, itemId: `i_${id}`, key: `i_${id}:1:1:1`, title: id, startsRun: true }),
			release: (id: string, slot: string) => itemActions.internalTurnDone(c as never, { sessionId: id, key: `i_${id}:1:1:1`, slot }),
			wake: async () => {
				c.vars.items = await loadItems(db as never);
				queueChanged(c as never);
				await drained(jobs);
			},
			close: () => {
				Object.assign(config.factory, previous);
				memory.raw.close();
			},
		};
	};

	await check("memory: a daily token wait keeps an admitted slot and the midnight schedule grants the next", async () => {
		const clock = Date.now;
		const midnight = (Math.floor(clock() / 86_400_000) + 1) * 86_400_000;
		let now = midnight - 1000;
		Date.now = () => now;
		try {
			const q = await queue({ dailyTokens: 100 });
			try {
				const admitted = await q.request("a");
				assert(admitted.granted, "first turn did not start");
				q.c.vars.usage.noteModelTokens(now, 110);
				assert(!(await q.request("b")).granted, "a new turn started after the cap");
				assert(q.c.vars.items.slots.has(admitted.slot), "crossing the cap cancelled the running turn");
				await q.release("a", admitted.slot);
				const fire = q.c.vars.items.queueAt;
				assert(fire?.at === midnight && !q.grants.includes("b"), "the next turn did not wait for the UTC reset");
				now = midnight;
				await itemActions.internalTurnQueue({ ...q.c, scheduledFire: { id: fire.id, scheduledAt: midnight, firedAt: now } } as never);
				assert(q.grants.includes("b"), "the midnight schedule did not grant the waiting turn");
				return "held its slot, then waited through 23:59:59 and started at 00:00:00 UTC";
			} finally { q.close(); }
		} finally { Date.now = clock; }
	});
	await check("memory: a waiting turn that is given the freed slot survives a stop between the two writes, and its grant is sent on wake", async () => {
		const q = await queue({ factoryTurns: 1 });
		try {
			const a = await q.request("a");
			const b = await q.request("b");
			assert(a.granted && !b.granted, "a has the slot and b waits");
			q.failOnce((sql) => sql.startsWith("INSERT OR REPLACE INTO turn_slot"));
			await q.release("a", (a as { slot: string }).slot).catch(() => undefined);
			await q.wake();
			const { requests, slots } = q.c.vars.items;
			assert(q.grants.includes("b") && slots.size === 1 && requests.size === 0, `after the wake: ${requests.size} requests, ${slots.size} slots, grants to ${q.grants.join(",") || "nobody"}`);
			return "b's request stayed until its slot was written, and b was told on wake";
		} finally {
			q.close();
		}
	});

	await check("memory: a grant whose reply is lost keeps its slot, and is told again rather than given to another", async () => {
		const q = await queue({ factoryTurns: 1 });
		try {
			const a = await q.request("a");
			const b = await q.request("b");
			assert(a.granted && !b.granted, "a has the slot and b waits");
			q.loseGrants(true);
			await q.release("a", (a as { slot: string }).slot);
			const held = [...q.c.vars.items.slots.values()];
			q.loseGrants(false);
			// Nothing else is waiting: only the wake itself can tell b again.
			await q.wake();
			const told = q.grants.includes("b");
			const c = await q.request("c");
			assert(held.length === 1 && held[0]?.session === "b" && told && !c.granted, `slots after the lost reply: ${held.map((one) => one.session).join(",")}; b told on wake ${told}; c granted ${c.granted}`);
			return "b kept its slot through the lost reply and was told again on wake; c waited";
		} finally {
			q.close();
		}
	});
	await check("memory: a creation tried again under its key with another body is refused, even when the first never reached the index", async () => {
		const q = await queue({});
		const { issueUserToken } = await import("../server/src/tokens.js");
		const profile = { uid: "u", email: null, demo: false };
		(q.c.conn as { params: unknown }).params = { token: issueUserToken(profile, 0) };
		const items = config.items;
		config.items = true;
		let made: Item | null = null;
		let lost = true;
		(q.c as { client: unknown }).client = () => ({
			workItem: {
				create: async (_key: unknown, { input }: { input: { item: Item } }) => {
					if (made) throw Object.assign(new Error("exists"), { group: "actor", code: "duplicate_key" });
					made = input.item;
				},
				get: () => ({
					internalSummary: async () => {
						// The first attempt's answer is lost after its item was made, before the index has it.
						if (lost) {
							lost = false;
							throw new Error("the reply was lost");
						}
						// The live feed groups by repository and source (item-pages.ts, `itemFeed`).
						return { id: made?.id, title: made?.task.title, place: made?.place, createdAt: T, revision: 0, state: "draft", source: "web", repository: { provider: "github", id: 1, owner: "u", name: "r", branch: "main", private: true, url: "" } };
					},
				}),
			},
		});
		const makeSession = async (_c: unknown, _profile: unknown, _input: unknown, _submission: unknown, ids: { sessionId: string }) => {
			const summary = { id: ids.sessionId, place: { kind: "hosted" }, repository: { provider: "github", id: 1, owner: "u", name: "r", branch: "main", private: true, url: "" } };
			q.c.vars.sessions.set(ids.sessionId, summary as never);
			return summary;
		};
		const file = (title: string) => itemActions.createItem(q.c as never, { title, body: "Ordinary work.", repository: { id: 1 }, profile: "fake" as never, idempotencyKey: "same-key" }, makeSession as never);
		try {
			await file("Original").catch(() => undefined);
			q.c.vars.items = await loadItems(q.db as never);
			const other = await file("Replacement").then((summary) => `taken as “${summary.title}”`, (error: { code?: string }) => error.code);
			const same = await file("Original").then((summary) => summary.title, (error: { code?: string }) => error.code);
			assert(other === "idempotency_key_reused" && same === "Original", `another body: ${other}; the same body again: ${same}`);
			return "another body refused with idempotency_key_reused; the same body again answered with its item";
		} finally {
			config.items = items;
			q.close();
		}
	});

	await check("memory: two admissions in a row grant no more new hosted sandboxes than the person's limit", async () => {
		const q = await queue({ factoryTurns: 5, runningTurns: 6, hostedRunning: 1 });
		try {
			const a = await q.request("a");
			const b = await q.request("b");
			assert(a.granted && !b.granted, `a granted ${a.granted}, b granted ${b.granted}, with one hosted sandbox allowed`);
			return "the second waited: the first's slot counts as a running sandbox before its session says so";
		} finally {
			q.close();
		}
	});

	await check("memory: machine items share the person's turn ceiling even while hosted capacity is full", async () => {
		const q = await queue({ factoryTurns: 4, runningTurns: 3, hostedRunning: 1 });
		try {
			q.c.vars.machines.set("m", { name: "Test machine", since: 0, status: "online", sandboxes: [] });
			Object.assign(q.c.vars.sessions.get("a")!, { place: { kind: "machine", machineId: "m" } });
			Object.assign(q.c.vars.sessions.get("own")!, { status: "running", sandbox: "running" });
			q.c.vars.sessions.set("other", { ...q.c.vars.sessions.get("own")!, id: "other" });
			const first = await q.request("a");
			assert(first.granted, "two hosted sandboxes held the machine back");
			Object.assign(q.c.vars.sessions.get("b")!, { place: { kind: "machine", machineId: "m" } });
			const second = await q.request("b");
			const reason = [...q.c.vars.items.requests.values()][0]?.wait?.sentence;
			assert(!second.granted && reason?.includes("3 running turns; 3 are running"), `unexpected admission: ${reason}`);
			return reason;
		} finally {
			q.close();
		}
	});

	await check("memory: cancelling while the runner attaches prevents a late release from queuing another attempt", async () => {
		const q = await queue({});
		try {
			q.c.vars.machines.set("m", { name: "Test machine", since: 0, status: "online", sandboxes: [] });
			Object.assign(q.c.vars.sessions.get("a")!, { place: { kind: "machine", machineId: "m" } });
			const grant = await q.request("a");
			assert(grant.granted, "expected an attaching turn");
			const delivery = { sessionId: "a", key: "i_a:1:1:1" };
			await itemActions.internalWithdrawTurn(q.c as never, delivery);
			await itemActions.internalTurnDone(q.c as never, { ...delivery, slot: grant.slot, machineWait: { at: Date.now(), startsRun: true } });
			await q.wake();
			assert(!q.c.vars.items.slots.size && !q.c.vars.items.requests.size, "cancelled delivery survived its withdrawal");
			return "no request or slot after wake";
		} finally {
			q.close();
		}
	});

	await check("memory: an item's hosted time is its lifetime's, kept past the ledger's last days, and stops the turn that would go over", async () => {
		const m = machine();
		m.item.budget.hostedSeconds = 100;
		m.send({ kind: "start" });
		m.send({ kind: "turn_started" });
		// The first turn's 80 s leave the ledger's window before the second's 30 s are counted: the ledger alone would say 30.
		const reads = [[{ hold: "h_first", session: "s", seconds: 80 }], [{ hold: "h_second", session: "s", seconds: 30 }]];
		const actor = await itemActor(m.item, { facts: async () => ({ entries: reads.shift() ?? [], openItems: 1 }) });
		const failing = { turn: 1, state: "unresolved", run: { turn: 1, at: T, seq: 1, checks: [{ name: "test", command: "npm test", whose: "user", required: true, status: "failed", exitCode: 1, durationMs: 1, sentBack: 3, output: "expected 3" }] }, unrun: [], changedAfter: false };
		// Two different checks fail, so the second failure is no repeat of the first and the budget is what decides.
		const ended = (turn: string, name: string) => ({ kind: "turn_ended", at: Date.now(), key: turn, outcome: "unresolved", verified: { ...failing, run: { ...failing.run, checks: [{ ...failing.run.checks[0], name }] } }, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		const item = () => (actor.c.vars as { stored: { item: Item } }).stored.item;
		await actions.internalFact(actor.c, ended(currentKey(item()) as string, "test"));
		await actions.internalFact(actor.c, { kind: "turn_started", at: Date.now(), key: currentKey(item()) });
		await actions.internalFact(actor.c, ended(currentKey(item()) as string, "lint"));
		await actor.drain();
		assert(item().spent.hostedSeconds === 110 && item().question?.kind === "budget", `spent ${item().spent.hostedSeconds} s; the item is ${item().state}${item().question ? `, asking “${item().question?.text}”` : ""}`);
		return `110 s counted; ${item().question?.text}`;
	});

	await check("memory: a hold is counted once, however late an older answer of the user comes back", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_started" });
		// The second answer is older than the first, and lists one hold fewer; the third is as the first.
		const reads = [
			[{ hold: "h_one", session: "s", seconds: 50 }, { hold: "h_two", session: "s", seconds: 20 }],
			[{ hold: "h_one", session: "s", seconds: 50 }],
			[{ hold: "h_one", session: "s", seconds: 50 }, { hold: "h_two", session: "s", seconds: 20 }],
		];
		const actor = await itemActor(m.item, { facts: async () => ({ entries: reads.shift() ?? [], openItems: 1 }) });
		const failing = { turn: 1, state: "unresolved", run: { turn: 1, at: T, seq: 1, checks: [{ name: "test", command: "npm test", whose: "user", required: true, status: "failed", exitCode: 1, durationMs: 1, sentBack: 3, output: "expected 3" }] }, unrun: [], changedAfter: false };
		const ended = (turn: string, name: string) => ({ kind: "turn_ended", at: Date.now(), key: turn, outcome: "unresolved", verified: { ...failing, run: { ...failing.run, checks: [{ ...failing.run.checks[0], name }] } }, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		const item = () => (actor.c.vars as { stored: { item: Item } }).stored.item;
		for (const name of ["test", "lint", "build"]) {
			await actions.internalFact(actor.c, ended(currentKey(item()) as string, name));
			if (item().question === null) await actions.internalFact(actor.c, { kind: "turn_started", at: Date.now(), key: currentKey(item()) });
		}
		await actor.drain();
		assert(reads.length === 0 && item().spent.hostedSeconds === 70, `spent ${item().spent.hostedSeconds} s after ${3 - reads.length} answers`);
		return "70 s, not 90";
	});

	await check("memory: a cancel stored while the push looked up its user's facts pushes nothing", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		const publish = m.item.run?.step.kind === "publish" ? { kind: "publish", key: currentKey(m.item) } : null;
		assert(publish, "the item is not at its push");
		let actor: Awaited<ReturnType<typeof itemActor>> | null = null;
		actor = await itemActor(m.item, {
			facts: async () => {
				if (actor) await actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" });
				return { entries: [], openItems: 1 };
			},
		});
		await actor.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `publish:${publish.key}`, JSON.stringify(publish));
		actor.c.scheduledFire = { id: "now", scheduledAt: T, firedAt: T };
		await actions.internalDue(actor.c);
		await actor.drain();
		const state = (actor.c.vars as { stored: { item: Item } }).stored.item.state;
		assert(state === "cancelled" && actor.publishes.length === 0, `the item is ${state}; pushes: ${actor.publishes.length}`);
		return "cancelled, nothing pushed";
	});

	await check("memory: an effect found unwanted under a decision whose write then fails is kept for the item read again", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_ended", outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		const publish = m.item.run?.step.kind === "publish" ? { kind: "publish", key: currentKey(m.item) } : null;
		assert(publish, "the item is not at its push");
		// The push looks up its user's facts; meanwhile a cancel is decided, and its write is held open and then fails.
		let memory: Awaited<ReturnType<typeof itemActor>> | null = null;
		let release = () => undefined as void;
		let cancelling: Promise<string> | null = null;
		memory = await itemActor(m.item, {
			facts: async () => {
				if (memory && cancelling === null) {
					const actor = memory;
					release = actor.holdWrites();
					actor.failOnce((sql) => sql.startsWith("UPDATE item SET revision"));
					cancelling = actions.internalAct(actor.c, { action: { kind: "cancel" }, by: "person:u" }).then(() => "stored", () => "failed");
				}
				return { entries: [], openItems: 1 };
			},
		});
		await memory.db.execute("INSERT INTO effects VALUES (?, ?, 0, 0)", `publish:${publish.key}`, JSON.stringify(publish));
		const item = () => (memory.c.vars as { stored: { item: Item } }).stored.item;
		memory.c.scheduledFire = { id: "now", scheduledAt: T, firedAt: T };
		const firing = actions.internalDue(memory.c);
		await new Promise((done) => setTimeout(done, 50));
		const decided = item().state;
		release();
		const cancelled: string = await ((cancelling as Promise<string> | null) ?? "never started");
		await firing;
		await memory.drain();
		assert(decided === "cancelled", `the cancel was not decided during the lookup: ${decided}`);
		const left = memory.raw.prepare("SELECT COUNT(*) AS n FROM effects WHERE id LIKE 'publish:%'").get() as { n: number };
		assert(cancelled === "failed" && item().state !== "cancelled" && (left.n === 1 || memory.publishes.length === 1), `the cancel ${cancelled}; the item is ${item().state}; publish rows ${left.n}, pushes ${memory.publishes.length}`);
		return `the cancel's write failed; the push is ${memory.publishes.length === 1 ? "done" : "still stored"}`;
	});

	await check("memory: sandbox time settled after the last turn reaches the item when it next reads its user", async () => {
		const m = machine();
		m.send({ kind: "start" });
		m.send({ kind: "turn_started" });
		// The turn ends before its last stretch is settled; the push that follows reads it.
		const reads = [[], [{ hold: "h_final", session: "s", seconds: 28 }]];
		const actor = await itemActor(m.item, { facts: async () => ({ entries: reads.shift() ?? [{ hold: "h_final", session: "s", seconds: 28 }], openItems: 1 }) });
		await actions.internalFact(actor.c, { kind: "turn_ended", at: Date.now(), key: currentKey(m.item), outcome: "succeeded", verified: null, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
		await actor.drain();
		const page = await actions.internalView(actor.c);
		assert(page.spent.hostedSeconds === 28 && page.pullRequest !== null, `the item shows ${page.spent.hostedSeconds} s, pull request ${page.pullRequest ? "open" : "none"}`);
		return "28 s on the item after its push";
	});

	await check("memory: an API token stops working the moment its owner is locked out", async () => {
		const q = await queue({});
		const items = config.items;
		const demo = config.access.demo;
		config.items = true;
		try {
			const { createApiToken } = await import("../server/src/api-tokens.js");
			q.c.vars.profile = { uid: "u", email: null, demo: true } as never;
			const { secret } = await createApiToken(q.db as never, "u", { name: "script", scopes: ["items:read"] }, T);
			(q.c.conn as { params: unknown }).params = { token: (await import("../server/src/tokens.js")).issueServiceToken("api") };
			(config.access as { demo: boolean }).demo = true;
			const before = await itemActions.internalApiItem(q.c as never, { token: secret, id: "i_none" }).then(() => "read", (error: { code?: string }) => error.code);
			(config.access as { demo: boolean }).demo = false;
			const after = await itemActions.internalApiItem(q.c as never, { token: secret, id: "i_none" }).then(() => "read", (error: { code?: string }) => error.code);
			assert(before === "item_not_found" && after === "invalid_token", `with the demo on: ${before}; with it off: ${after}`);
			return "the demo user's token reached the item lookup while the demo was on, and was refused once it was off";
		} finally {
			(config.access as { demo: boolean }).demo = demo;
			config.items = items;
			q.close();
		}
	});
}

function checkHandoff(pull: StandinPull, view: ItemView) {
	const verdict = view.verdicts.at(-1)!;
	const posts = standin.requests.filter((call) => call.method === "POST" && call.path.endsWith(`/pulls/${pull.number}/requested_reviewers`));
	assert(posts.length === 1 && pull.requestedReviewers.join() === "ada", `expected one review request for ada, got ${posts.length} calls, ${pull.requestedReviewers}`);
	const own = pull.comments.filter((one) => one.user.login === `${standin.slug}[bot]`);
	assert(own.length === 1, `expected one platform comment, got ${own.length}`);
	const comment = own[0]!;
	assert(comment.body.startsWith(`<!-- windlass-item:${view.id} -->\n\n**Windlass at ${verdict.head.slice(0, 7)}: ${verdictWords(verdict, null).split(".", 1)[0]}**`), "the comment is missing the marker or the current verdict");
	return comment;
}

await memoryChecks();
// All selected memory and per-user limit checks have run.
if (only.length > 0 && only.every(name => name.startsWith("memory") || name.startsWith("user-limits"))) {
	await standin.stop();
	console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

async function machineChecks(): Promise<void> {
	const server = new Server();
	// Its machine also offers a signed-in Claude Code, played by the fake ACP agent (fixtures/acp-agent).
	const runner = new StandInRunner(API, ENDPOINT, { claude: true });
	try {
		const { user, client, auth } = await world(server, standin, { WLP_MACHINES: "1", WLP_FACTORY_REVIEWER: "on", WLP_PUBLIC_URL: API, WLP_FACTORY_HOSTED_RUNNING: "1", WLP_FACTORY_ITEM_HOSTED_SECONDS: "1" });
		await runner.pair(user);
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		const task = { mode: "single" as const, repository: { id: harbor.id }, title: "On my machine", body: "Write a short program.", place };
		await check("machine: only a paired machine with an available profile can take an item", async () => {
			await refused(() => user.createItem({ ...task, place: { kind: "machine", machineId: "m_0123456789abcdef" } }), "machine_not_found");
			await refused(() => user.createItem(task), "machine_not_connected");
			runner.fake.report.docker = { ok: false, reason: "Docker is stopped." };
			await runner.connectControl();
			await waitFor("the Docker report", async () => (await user.machines())[0]?.warnings.some(w => w.kind === "docker"), 10_000);
			return await refused(() => user.createItem(task), "bad_profile");
		});
		runner.fake.report.docker = { ok: true };
		if (!runner.control) await runner.connectControl();
		runner.report();
		await waitFor("available machine profiles", async () => (await user.machines())[0]?.profiles.some(p => p.available), 15_000);

		await check("machine: the owner policy gates personal and item launches", async () => {
			const profile = "docker-windlass-sandbox";
			const waiting = await user.createSession({ place, profile });
			runner.fake.report.allowedProfiles = ["docker-hardened"];
			runner.report();
			try {
				const machine = await waitFor("the owner policy in the Machines page", async () => {
					const row = (await user.machines())[0];
					return row?.allowedProfiles?.length === 1 && row;
				}, 5_000);
				const denied = machine.profiles.find(p => p.id === profile);
				assert(denied?.available === false && denied.unavailableReason?.includes("--allow-profile " + profile), "missing refusal in the launch picker");
				assert(machine.profiles.some(p => p.id === "docker-hardened" && p.available), "hardened unavailable");
				for (const launch of [() => user.createSession({ place, profile }), () => user.createItem({ ...task, profile })]) {
					const message = await refused(launch, "profile_unavailable");
					assert(message.includes(denied.unavailableReason!), message);
				}
				const creates = runner.creates;
				const session = client.agentSession.get([auth.profile.uid, waiting.id], { params: { token: auth.token } });
				await session.prompt({ text: "Write the primes" });
				const ended = await waitFor("the pending session’s first turn", async () =>
					(await session.snapshot()).timeline.find(item => item.kind === "turn.ended"), 20_000);
				assert(ended.outcome === "error" && ended.message?.includes(denied.unavailableReason!) && runner.creates === creates,
					"a session opened before revocation reached the runner or missed the refusal");
				return denied.unavailableReason!;
			} finally {
				delete runner.fake.report.allowedProfiles;
				runner.report();
				await waitFor("legacy report to offer both profiles", async () => {
					const row = (await user.machines())[0];
					return row?.allowedProfiles?.length === 2 && row.profiles.filter(p => p.available).length === 2;
				}, 5_000);
				await user.deleteSession(waiting.id);
			}
		});

		await check("machine: a generated title applies to a personal session and leaves an item's title with its builder", async () => {
			const prompt = "Read the repo (session title)";
			const personal = await user.createSession({ place, profile: "docker-hardened" });
			const session = (id: string) => client.agentSession.get([auth.profile.uid, id], { params: { token: auth.token } });
			await session(personal.id).prompt({ text: prompt });
			const item = await user.createItem({ ...task, title: "Inspect the harbor", body: prompt, start: true });
			try {
				const titles = await Promise.all([personal.id, item.sessionId].map(id => waitFor("the session to finish its turn", async () => {
					const page = await session(id).snapshot();
					return page.timeline.some(i => i.kind === "windlass") && page.timeline.some(i => i.kind === "turn.ended") && page.summary.title;
				}, 30_000)));
				titles.push((await user.item(item.id)).title);
				assert(titles[0] === "Inspect the files" && titles[1] === item.title && titles[2] === item.title, titles.join(" / "));
				return titles.join(" / ");
			} finally {
				await user.actOnItem({ id: item.id, action: { kind: "cancel" } });
				await user.deleteSession(personal.id);
			}
		});

		await check("machine: a machine turn and a hosted turn overlap with one hosted slot, and machine review costs zero hosted seconds", async () => {
			await user.saveRepositoryDefaults({ repositoryId: harbor.id, screenshots: true });
			const token = (await user.createApiToken({ name: "machine", scopes: ["items:create"] })).secret;
			const filed = await api("/api/items", { method: "POST", body: JSON.stringify({ ...task, profile: "docker-hardened", body: "Write a program (slow).", start: true }), token, key: "machine-slot" });
			assert(filed.status === 201, JSON.stringify(filed.body));
			const item = filed.body as unknown as ItemSummary;
			assert(item.place.kind === "machine" && item.place.machineId === place.machineId, "item lost its machine");
			await untilItem(user, item.id, "the running machine turn", view => view.run?.step.turn === "started");
			const hosted = await user.createItem({ ...task, title: "Beside the machine", place: { kind: "hosted" }, start: true });
			await untilItem(user, hosted.id, "the running hosted turn", view => view.run?.step.turn === "started");
			assert((await user.item(item.id)).run?.step.turn === "started", "hosted turn waited for the machine's slot");
			const pushed = await untilItem(user, item.id, "the machine's pull request", view => !!view.pullRequest);
			setCi(harbor, standin.pulls.find(p => p.repository === harbor.id && p.number === pushed.pullRequest!.number)!.head, "success");
			const review = await untilItem(user, item.id, "review", view => view.state === "review", CI_WAIT_MS);
			assert([...runner.boxes.values()].some(box => box.sessionId === item.sessionId && box.profile === "docker-hardened"), "runner did not serve the requested profile");
			const open = runner.opens.get(item.sessionId);
			assert(JSON.stringify(open?.hostTools ?? []).includes("Screenshots are unavailable in this sandbox"), "an unflagged runner offered screenshots to an opted-in builder");
			assert(open?.approval === "full" && open.attended === false && open.unattended === "deny", "the hardened container was not opened in unattended full mode");
			assert(review.verdicts.at(-1)?.attestedBy === `machine:${place.machineId}` && review.spent.turns === 1 && review.spent.hostedSeconds === 0, JSON.stringify(review.spent));
			return "overlapping turns, one machine-attested verdict, zero hosted seconds";
		});

		await check("machine: a Claude Code item runs in the hardened container without asking, publishes the platform's commit and CI decides", async () => {
			const hosted = await refused(() => user.createItem({ ...task, place: undefined, harness: "claude" }), "bad_input");
			const planFirst = await refused(() => user.createItem({ ...task, mode: "orchestrate", harness: "claude" }), "bad_input");
			const unknown = await refused(() => user.createItem({ ...task, harness: "nonesuch" as never }), "bad_input");
			const sent = runner.acpInput.length;
			// "itemwork": the fake agent asks before an edit and before a test command, then reports its tokens.
			const item = await user.createItem({ ...task, title: "Claude on my machine", body: "Fix the program (itemwork).", harness: "claude", start: true });
			assert(item.agent?.harness === "claude" && item.agent.model === "default" && item.agent.tokens === "not_reported", JSON.stringify(item.agent));
			const builder = (await user.listSessions()).find(s => s.id === item.sessionId);
			assert(builder?.harness === "claude" && builder.profile === "docker-hardened" && builder.mode === "bypassPermissions", JSON.stringify(builder && { harness: builder.harness, profile: builder.profile, mode: builder.mode }));
			const pushed = await untilItem(user, item.id, "the Claude Code item's pull request", view => !!view.pullRequest);
			const frames = runner.acpInput.slice(sent).join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
			const mode = frames.find(f => f.method === "session/set_mode" || (f.method === "session/set_config_option" && f.params?.configId === "mode"));
			const answers = frames.filter(f => f.method === undefined && f.result?.outcome).map(f => f.result.outcome.optionId);
			const prompt = frames.find(f => f.method === "session/prompt")?.params?.prompt?.[0]?.text ?? "";
			assert((mode?.params?.modeId ?? mode?.params?.value) === "bypassPermissions", "the item's agent was not put in bypassPermissions: " + JSON.stringify(mode));
			assert(answers.join() === "allow-once,allow-once", "the edit and the test command were not allowed once: " + answers.join());
			assert(prompt.includes("Fix the program (itemwork)."), "the item's text did not reach the agent");
			const pull = standin.pulls.find(p => p.repository === harbor.id && p.number === pushed.pullRequest!.number)!;
			setCi(harbor, pull.head, "success");
			const review = await untilItem(user, item.id, "the Claude Code item in review", view => view.state === "review", CI_WAIT_MS);
			assert(review.agent?.tokens === "subscription" && review.agent.reportedTokens === 33_500 && review.spent.tokens === 0 && review.spent.turns === 1, JSON.stringify({ agent: review.agent, spent: review.spent }));
			// The stand-in runner has no git, so its pushed head is no commit id and no check run is posted on a machine here:
			// the check's words for this item are factory-check's ("the windlass/verified summary says CI decides …").
			assert(review.verdicts.at(-1)?.result === "pass" || review.verdict?.ci === "passed", "CI green did not decide the verdict: " + JSON.stringify(review.verdict));
			// A Windlass item's model is the item's own choice from the account's list.
			const windlass = await user.createItem({ ...task, title: "Windlass on a chosen model", model: "gpt-6-luna" });
			const windlassSession = (await user.listSessions()).find(s => s.id === windlass.sessionId);
			assert(windlass.agent?.harness === "windlass" && windlass.agent.model === "gpt-6-luna" && windlassSession?.model === "gpt-6-luna", JSON.stringify(windlass.agent));
			await refused(() => user.createItem({ ...task, model: "gpt-nonesuch" }), "bad_model");
			await user.actOnItem({ id: windlass.id, action: { kind: "cancel" } });
			return `refused hosted (${hosted}), Plan first (${planFirst}), unknown (${unknown}); bypassPermissions, two allow-once answers, 33,500 tokens reported, CI decides`;
		});

		await check("machine: a Claude Code item is filed only where it is known to be signed in, and its turn checks again", async () => {
			const reported = async (signIn: "token" | "none" | "unknown") => {
				runner.fake.report.harnesses = [{ id: "claude", adapter: "claude-agent-acp 0.109.0", image: "sha256:fake", signIn }];
				runner.report();
				await waitFor(`the machine reports Claude Code ${signIn}`, async () => (await user.machines())[0]?.harnesses?.find(h => h.id === "claude")?.signIn === signIn, 15_000);
			};
			try {
				await reported("unknown");
				const unknown = await refused(() => user.createItem({ ...task, title: "Claude, sign-in unknown", harness: "claude" }), "harness_signed_out");
				assert(/could not say whether Claude Code is signed in/.test(unknown), unknown);
				await reported("token");
				const draft = await user.createItem({ ...task, title: "Claude, signed out before its turn", body: "Fix the program (itemwork).", harness: "claude" });
				await reported("none");
				const sent = runner.acpInput.length;
				await user.actOnItem({ id: draft.id, action: { kind: "start" } });
				const asked = await untilItem(user, draft.id, "the sign-in question", view => view.question?.kind === "turn_refused");
				assert(/Claude Code on “Test machine” is not signed in\. Run windlass-runner login claude there\./.test(asked.question!.text), asked.question!.text);
				assert(!runner.acpInput.slice(sent).join("").includes("session/prompt"), "the signed-out item's turn reached the agent");
				assert(asked.spent.tokens === 0 && asked.agent?.tokens === "not_reported", JSON.stringify({ spent: asked.spent, agent: asked.agent }));
				await user.actOnItem({ id: draft.id, action: { kind: "cancel" } });
				return `refused at filing (${unknown}); paused at its turn (${asked.question!.text})`;
			} finally {
				await reported("token");
			}
		});

		await check("machine: an item's effort is one its agent offers, and its turns run at it, for Windlass and Claude Code", async () => {
			const options = { defaultModel: "default", models: [{ id: "default", name: null, efforts: ["default", "low", "medium", "high", "max"] }, { id: "sonnet", name: "Sonnet", efforts: [] }], checkedAt: Date.now(), modes: [] };
			const harnesses = runner.fake.report.harnesses;
			runner.fake.report.harnesses = [{ id: "claude", adapter: "claude-agent-acp 0.109.0", image: "sha256:fake", signIn: "token", options, optionsDigest: optionsDigest(options), optionsCheckedAt: options.checkedAt }];
			runner.report();
			try {
				await waitFor("the reported Claude Code options", async () => (await user.machines())[0]?.harnesses?.[0]?.optionsDigest === optionsDigest(options), 15_000);
				// Unknown efforts are refused, for each agent: not one it reported, or one for a model that takes none.
				const refusals: string[] = [];
				for (const [what, input] of [
					["Claude Code, not offered", { harness: "claude", effort: "ultra" }],
					["Claude Code, a model whose efforts come on selection", { harness: "claude", model: "sonnet", effort: "ultra" }],
					["Windlass, not offered", { model: "gpt-6.1-sol", effort: "ultra" }],
					["not text", { effort: 7 }],
				] as const) {
					try {
						refusals.push(await refused(() => user.createItem({ ...task, ...input } as never), "bad_effort"));
					} catch (error) {
						throw new Error(`${what}: ${(error as Error).message}`);
					}
				}
				// Claude Code: the effort goes to the adapter before the item's prompt.
				const sent = runner.acpInput.length;
				const claude = await user.createItem({ ...task, title: "Claude at high effort", body: "Fix the program (itemwork).", harness: "claude", effort: "high", start: true });
				assert(claude.agent?.effort === "high", JSON.stringify(claude.agent));
				const frames = await waitFor("the Claude Code item's prompt", async () => {
					const all = runner.acpInput.slice(sent).join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
					return all.some(f => f.method === "session/prompt") ? all : null;
				}, 60_000);
				const prompt = frames.findIndex(f => f.method === "session/prompt");
				const effort = frames.findIndex(f => f.method === "session/set_config_option" && f.params?.configId === "effort" && f.params?.value === "high");
				assert(effort >= 0 && effort < prompt, "the effort was not set before the item's prompt: " + JSON.stringify(frames.map(f => f.method + (f.params?.configId ? ":" + f.params.configId + "=" + f.params.value : ""))));
				await user.actOnItem({ id: claude.id, action: { kind: "cancel" } });
				// Windlass: the item's turn is given the effort.
				const windlass = await user.createItem({ ...task, title: "Windlass at xhigh effort", model: "gpt-6.1-sol", effort: "xhigh", start: true });
				assert(windlass.agent?.harness === "windlass" && windlass.agent.effort === "xhigh", JSON.stringify(windlass.agent));
				const session = client.agentSession.get([auth.profile.uid, windlass.sessionId], { params: { token: auth.token } });
				const asked = await waitFor("the Windlass item's prompt", async () => (await session.snapshot()).timeline.find(e => e.kind === "user"), 60_000);
				assert(asked.kind === "user" && asked.effort === "xhigh" && asked.model === "gpt-6.1-sol", JSON.stringify(asked));
				await user.actOnItem({ id: windlass.id, action: { kind: "cancel" } });
				// Left out: the agent's default.
				const plain = await user.createItem({ ...task, title: "Windlass at its default effort" });
				assert(plain.agent?.effort === undefined, JSON.stringify(plain.agent));
				await user.actOnItem({ id: plain.id, action: { kind: "cancel" } });
				return `refused ${refusals.length} unknown efforts (${refusals[0]}); Claude Code set effort high before its prompt; Windlass's turn ran at xhigh`;
			} finally {
				runner.fake.report.harnesses = harnesses;
				runner.report();
			}
		});

		await check("machine: offline at launch waits without spend and resumes to review", async () => {
			await runner.setOffline(true);
			await waitFor("offline in the index", async () => (await user.machines())[0]?.status === "offline", 15_000);
			const item = await user.createItem({ ...task, profile: "e2b", start: true });
			const waiting = await untilItem(user, item.id, "machine wait", view => view.wait?.reason === "machine");
			assert(waiting.wait?.sentence === 'Waiting for your machine "Test machine" to come back online.' && Object.values(waiting.spent).every(n => n === 0), JSON.stringify(waiting));
			await runner.setOffline(false);
			const pushed = await untilItem(user, item.id, "push after reconnection", view => !!view.pullRequest);
			setCi(harbor, standin.pulls.find(p => p.repository === harbor.id && p.number === pushed.pullRequest!.number)!.head, "success");
			const review = await untilItem(user, item.id, "review after reconnection", view => view.state === "review", CI_WAIT_MS);
			assert([...runner.boxes.values()].some(box => box.sessionId === item.sessionId && box.profile === "docker-windlass-sandbox"), "missing fallback to the machine's first available profile");
			assert(review.reviewerSessionId === null && review.review?.state === "off" && review.reviews.length === 0, "a machine item admitted a second reviewer");
			assert(review.spent.turns === 1 && review.spent.hostedSeconds === 0, JSON.stringify(review.spent));
			return waiting.wait.sentence;
		});

		await check("machine: an unanswered session attach waits, and removal asks what to hand over", async () => {
			const pushed = await user.createItem({ ...task, start: true });
			await untilItem(user, pushed.id, "a pushed commit", view => !!view.pullRequest);
			runner.attachMode = "ignore";
			const waiting = await user.createItem({ ...task, start: true });
			const view = await untilItem(user, waiting.id, "the unanswered attach", v => v.wait?.reason === "machine");
			assert(view.wait?.sentence === 'Waiting for your machine "Test machine" to come back online.' && Object.values(view.spent).every(n => n === 0), JSON.stringify(view.spent));
			await user.removeMachine({ machineId: place.machineId, removeSandboxes: false });
			for (const [id, expected] of [[waiting.id, ["give_up"]], [pushed.id, ["hand_over", "give_up"]]] as const) {
				const asked = await untilItem(user, id, "a removal question", v => v.question?.kind === "machine_removed");
				assert(asked.wait?.reason === "person" && asked.wait.retryAt === null && asked.question?.choices.map(c => c.id).join() === expected.join(), JSON.stringify(asked.question));
				const action = expected[0];
				const result = await user.actOnItem({ id, action: { kind: "answer", question: asked.question.id, choice: action } });
				if (action === "give_up") assert(result.state === "failed", result.state);
				else await untilItem(user, id, "handover of the pushed commit", v => v.state === "review");
			}
			return "unanswered attach spent nothing; gave up before push, handed over after push";
		});
	} finally {
		await runner.setOffline(true);
		await server.stop();
		server.remove();
	}
}

/**
 * A Plan-first feature whose subtask runs Claude Code on a machine: its own world, with the default
 * item limits (the machine checks' one hosted second per item leaves no plan valid) and the feature
 * git fixture, so the hosted planner files a plan and approval opens the feature branch.
 */
async function subtaskAgentChecks(): Promise<void> {
	const server = new Server();
	const runner = new StandInRunner(API, ENDPOINT, { claude: true });
	try {
		const { user } = await world(server, standin, { WLP_MACHINES: "1", WLP_PUBLIC_URL: API, WLP_FEATURE_TEST_GIT: join(server.storage, "git") });
		// A feature places a subtask only where at least 5 GiB of disk is free (placement.ts).
		runner.fake.report.freeDiskBytes = 20 * 2 ** 30;
		await runner.pair(user);
		await runner.connectControl();
		runner.report();
		await waitFor("available machine profiles", async () => (await user.machines())[0]?.profiles.some(p => p.available), 15_000);
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		await check("machine: a Plan-first plan with mixed agents is approved only with the owner's confirmation, and its Claude Code child starts on its own model", async () => {
			const options = { defaultModel: "default", models: [{ id: "default", name: null, efforts: [] }, { id: "sonnet", name: "Sonnet", efforts: ["low"] }], checkedAt: Date.now(), modes: [] };
			const harnesses = runner.fake.report.harnesses;
			runner.fake.report.harnesses = [{ id: "claude", adapter: "claude-agent-acp 0.109.0", image: "sha256:fake", signIn: "token", options, optionsDigest: optionsDigest(options), optionsCheckedAt: options.checkedAt }];
			runner.report();
			let feature: ItemSummary | undefined;
			try {
				await waitFor("the reported Claude Code options", async () => (await user.machines())[0]?.harnesses?.[0]?.optionsDigest === optionsDigest(options), 15_000);
				await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "build", command: "true" }] });
				// The repository starts with a pull-request-only workflow; the orchestrator checks may have made it run on push already.
				if (!standin.fileOn(harbor, "main", ".github/workflows/build.yml")?.includes("on: [push]"))
					standin.commit(harbor, "main", { ".github/workflows/build.yml": "on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{run: 'true'}]\n" }, "Run build on push");
				const machine = (await user.machines()).find(m => m.machineId === place.machineId)!;
				// The planner (Windlass, hosted) files its plan; the owner moves the first subtask to Claude Code on Sonnet on the machine.
				const filed = await user.createItem({ repository: { id: harbor.id }, title: "Mixed agents", body: "Index and search documents.", mode: "orchestrate", start: true });
				feature = filed;
				const proposal = await untilItem(user, filed.id, "the planner's proposal", v => v.plan?.status === "proposed" && v.question?.kind === "plan_approval");
				const plan = structuredClone(proposal.plan!);
				plan.subtasks[0] = { ...plan.subtasks[0]!, place: { prefer: machineLabel(machine), reason: "Claude Code is signed in there" }, agent: { harness: "claude", model: "sonnet", effort: "low" } };
				// What the place does not offer is refused at approval with the reason: a model its catalog does not list.
				const offPlan = structuredClone(plan);
				offPlan.subtasks[0]!.agent = { harness: "claude", model: "opus" };
				const off = await user.actOnItem({ id: filed.id, action: { kind: "edit_plan", version: proposal.plan!.version, plan: offPlan } });
				const notOffered = await refused(() => user.actOnItem({ id: filed.id, action: { kind: "approve_plan", version: off.plan!.version, agents: [plan.subtasks[0]!.key] } }), "bad_input");
				assert(/Claude Code: That model is not offered/.test(notOffered), notOffered);
				const edited = await user.actOnItem({ id: filed.id, action: { kind: "edit_plan", version: off.plan!.version, plan } });
				assert(/works without asking/.test(edited.question?.text ?? ""), "the approval text does not name the agent that works without asking: " + edited.question?.text);
				// The planner's choice of an agent that works without asking is never approved without the owner naming it.
				const unconfirmed = await refused(() => user.actOnItem({ id: filed.id, action: { kind: "approve_plan", version: edited.plan!.version } }), "bad_input");
				assert(/confirm that it runs Claude Code, which works without asking/.test(unconfirmed), unconfirmed);
				const sent = runner.acpInput.length;
				await user.actOnItem({ id: filed.id, action: { kind: "approve_plan", version: edited.plan!.version, agents: [plan.subtasks[0]!.key] } });
				const running = await untilItem(user, filed.id, "the first child", v => v.children?.length === 1, 60_000);
				// The index keeps no agent: the child's own page has it.
				const child = await user.item(running.children![0]!.id);
				assert(child.agent?.harness === "claude" && child.agent.model === "sonnet" && child.agent.effort === "low" && child.placement?.harness === "claude", JSON.stringify({ agent: child.agent, placement: child.placement }));
				const builder = (await user.listSessions()).find(s => s.id === child.sessionId);
				assert(builder?.harness === "claude" && builder.model === "sonnet" && builder.profile === "docker-hardened" && builder.mode === "bypassPermissions", JSON.stringify(builder && { harness: builder.harness, model: builder.model, profile: builder.profile, mode: builder.mode }));
				// Its first turn runs on Claude Code: the effort, then the subtask's brief as the prompt.
				const frames = await waitFor("the Claude Code child's prompt", async () => {
					const all = runner.acpInput.slice(sent).join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
					return all.some(f => f.method === "session/prompt") ? all : null;
				}, 60_000);
				const prompt = frames.find(f => f.method === "session/prompt")?.params?.prompt?.[0]?.text ?? "";
				assert(prompt.includes(plan.subtasks[0]!.brief), "the subtask's brief did not reach Claude Code");
				assert(frames.some(f => f.method === "session/set_config_option" && f.params?.configId === "effort" && f.params?.value === "low"), "the subtask's effort was not set");
				return `approval refused without the owner's confirmation ("${unconfirmed}"); child on Claude Code ${builder.model} in ${builder.profile}`;
			} finally {
				if (feature) await user.actOnItem({ id: feature.id, action: { kind: "cancel" } }).catch(() => undefined);
				runner.fake.report.harnesses = harnesses;
				runner.report();
			}
		});

	} finally {
		await runner.setOffline(true);
		await server.stop();
		server.remove();
	}
}

if (!only.length || only.some(prefix => prefix.startsWith("machine"))) await machineChecks();
if (!only.length || only.some(prefix => prefix.startsWith("machine"))) await subtaskAgentChecks();
if (only.length && only.every(prefix => prefix.startsWith("machine"))) {
	await standin.stop();
	process.exit(failed ? 1 : 0);
}

const main = new Server();
try {
	// Room for every sandbox these items leave running: the cap on them has a check of its own (factory-check.ts, `admit`).
	const { client, auth, user } = await world(main, standin, { WLP_FACTORY_HOSTED_RUNNING: "20", WLP_FAKE_DELAY_MS: "25" });

	let token = "";
	let first: ItemSummary | null = null;
	await check("api: a token is shown once and kept as a digest; items filed with it are one per Idempotency-Key, and the key with another body is refused", async () => {
		const made = await user.createApiToken({ name: "script", scopes: ["items:create", "items:read"] });
		token = made.secret;
		assert(/^wlp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token), "the token is not shaped as one");
		const listed = await user.apiTokens();
		assert(listed.length === 1 && !JSON.stringify(listed).includes(token.slice(-43)), "the token's value is in the list");
		const body = { mode: "single", repository: { id: harbor.id }, title: "Write a short program", body: "Add a small program to the repository.", acceptance: ["It runs", "Keep <!-- windlass-item:fake --> and @everyone inert"], start: true };
		assert((await api("/api/items", { method: "POST", body: JSON.stringify(body) })).status === 401, "no token was taken");
		// A token shaped right that names no user: the same refusal as a wrong one, at once, with nothing logged as an error.
		const logged = main.text.length;
		const stranger = await api("/api/items/i_0123456789abcdef", { token: `wlp_u_00000000000000000000.${"B".repeat(43)}` });
		assert(stranger.status === 401 && stranger.body.code === "invalid_token" && !main.text.slice(logged).includes("api.failed"), `a token of no user answered ${stranger.status} ${JSON.stringify(stranger.body)}`);
		const one = await api("/api/items", { method: "POST", body: JSON.stringify(body), token, key: "k-1" });
		const two = await api("/api/items", { method: "POST", body: JSON.stringify(body), token, key: "k-1" });
		assert(one.status === 201 && two.status === 201 && one.body.id === two.body.id, `the two answers were ${one.status} ${String(one.body.id)} and ${two.status} ${String(two.body.id)}`);
		const other = await api("/api/items", { method: "POST", body: JSON.stringify({ ...body, title: "Another" }), token, key: "k-1" });
		assert(other.status === 409 && other.body.code === "idempotency_key_reused", `another body with the key answered ${other.status} ${JSON.stringify(other.body)}`);
		const items = await user.listItems();
		assert(items.length === 1, `the user has ${items.length} items`);
		first = items[0] as ItemSummary;
		const read = await api(`/api/items/${first.id}`, { token });
		assert(read.status === 200 && read.body.id === first.id, `reading it answered ${read.status}`);
		const narrow = (await user.createApiToken({ name: "read only", scopes: ["items:read"] })).secret;
		assert((await api("/api/items", { method: "POST", body: JSON.stringify(body), token: narrow, key: "k-2" })).status === 401, "a token without items:create filed an item");
		const sessions = await user.listSessions();
		const session = sessions.find((one) => one.item?.id === first?.id);
		assert(session !== undefined && session.id === first.sessionId, "the item's session is not in the sessions' index");
		await refused(() => client.agentSession.get([auth.profile.uid, session.id], { params: { token: auth.token } }).prompt({ text: "hello" }), "item_session");
		const kept = await refused(() => user.deleteSession(session.id), "item_session");
		assert(kept.includes("“Write a short program”"), `the refusal says: ${kept}`);
		return `${first.id}, session ${first.sessionId}; two tokens, the list holds no value`;
	});

	await check("on: with WLP_ITEMS=1 platform info says items are offered", async () => {
		const info = (await (await fetch(`${API}/platform/info`)).json()) as PlatformInfo;
		assert(info.items?.reviewer === false && info.items.orchestrate === true, `platform info has items: ${JSON.stringify(info.items)}`);
		return "orchestration enabled, reviewer disabled";
	});

	await check("ci: implement, gate, publish, CI with the stand-in's check runs, handoff with a verdict", async () => {
		assert(first, "no item");
		const id = first.id;
		const published = await untilItem(user, id, "the push", (view) => view.pullRequest !== null, 60_000);
		const pull = standin.pulls.find((one) => one.repository === harbor.id && one.number === published.pullRequest?.number);
		assert(pull, "the stand-in has no such pull request");
		const decoy = { id: -1, body: `<!-- windlass-item:${id} -->`, user: { login: "ada" } };
		pull.comments.push(decoy);
		setCi(harbor, pull.head, "success");
		const handed = await untilItem(user, id, "the handoff", (view) => view.state === "review", CI_WAIT_MS);
		const verdict = handed.verdicts.at(-1);
		assert(verdict && verdict.ci.state === "passed" && handed.verdict?.result === verdict.result, `the verdict is ${JSON.stringify(verdict)}`);
		assert(verdict.said.ci === "CI passed (1 check)." && verdict.said.flags.length === verdict.flags.length, `the verdict says ${JSON.stringify(verdict.said)}`);
		await waitFor("the verdict comment", () => pull.comments.length === 2, 10_000);
		const comment = checkHandoff(pull, handed);
		assert(decoy.body === `<!-- windlass-item:${id} -->` && comment.body.includes("- It runs") && comment.body.includes("\\@everyone") && !comment.body.includes("<!-- windlass-item:fake"), "outside text or another person's marked comment changed the handoff");
		assert(comment.body.includes("CI passed \\(1 check\\)"), "the comment omits the verdict's CI sentence");
		assert(pull.title === "Write a short program" || pull.title.length > 0, "the pull request has no title");
		return `#${pull.number} from ${pull.head}; verdict ${verdict.result}, CI ${verdict.ci.state}; ${said(handed).slice(-3).join(" / ")}`;
	});

	await check("ci: on a repository with no checks, CI that passes on the pushed commit makes it ready for review", async () => {
		await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [] });
		// No word here may choose the fake layer's recording in which checks run ("check", "verify"): its others run none.
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "A short note", body: "Add a short note to the repository.", start: true });
		const published = await untilItem(user, item.id, "the push", (view) => view.pullRequest !== null, 60_000);
		const pull = standin.pulls.find((one) => one.repository === harbor.id && one.number === published.pullRequest?.number);
		assert(pull, "the stand-in has no such pull request");
		setCi(harbor, pull.head, "success");
		const handed = await untilItem(user, item.id, "the handoff", (view) => view.state === "review", CI_WAIT_MS);
		const verdict = handed.verdicts.at(-1);
		const words = said(handed).find((line) => /^(Ready for review|Needs a look|Not verified|Failing)\./.test(line)) ?? "";
		assert(verdict?.gate.state === "none_set" && verdict.gate.required.length === 0, `the gate recorded ${verdict?.gate.state} with ${verdict?.gate.required.length} checks of the user's`);
		assert(verdict.result === "pass" && words.startsWith("Ready for review.") && said(handed).includes("No checks are set for this repository: the work is pushed for CI to verify."), `${verdict.result}: “${words}”`);
		return words;
	});

	await check("person: a prompt in a session of the person's own is not held back by factory work", async () => {
		const own = await user.createSession({ profile: (await user.listSessions())[0]?.profile ?? ("fake" as never), title: "Mine" });
		const handle = client.agentSession.get([auth.profile.uid, own.id], { params: { token: auth.token } });
		const answer = await handle.prompt({ text: "Write a short program" });
		return `turn ${answer.turn} started`;
	});

	await check("gate: a required check that fails sends the agent back once, and the same failure again stops at once with a question", async () => {
		// "build" in the check's name makes the fake layer replay a longer command in the fix turn, which names the check: long enough to look at it running.
		await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "build", command: "npm run fail" }] });
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Fix the light", body: "Make the light work.", start: true });
		// The fix turn is delivered the moment the first turn ends, while that turn still settles its sandbox time: watched from the user's side meanwhile.
		const samples: Array<{ held: number; kept: boolean }> = [];
		let watching = true;
		const watcher = (async () => {
			while (watching) {
				const [sessions, usage] = await Promise.all([user.listSessions(), user.usage()]).catch(() => [null, null] as const);
				const session = sessions?.find((one) => one.item?.id === item.id);
				if (session && usage && session.turns === 2 && session.status === "running") {
					samples.push({ held: usage.today.find((row) => row.sessionId === session.id)?.heldSeconds ?? 0, kept: usage.kept.some((one) => one.sessionId === session.id) });
				}
				await sleep(50);
			}
		})();
		const asked = await untilItem(user, item.id, "the question", (view) => view.question !== null, 90_000).finally(() => {
			watching = false;
		});
		await watcher;
		const sentBack = said(asked).filter((line) => line.startsWith("The checks failed")).length;
		assert(asked.question?.kind === "rounds" && /same failure/.test(asked.question.text) && sentBack === 2, `${stateOf(asked)}; ${said(asked).join(" / ")}`);
		assert(asked.run?.rounds.gate === 1 && asked.run.caps.gate === 2, `gate rounds: ${asked.run?.rounds.gate} of ${asked.run?.caps.gate}`);
		// The next turn's hold and place survive the end of the turn before it, and its time is counted.
		assert(samples.length > 0, "the fix turn was never seen running");
		assert(samples.every((sample) => sample.held > 0 && sample.kept), `while the fix turn ran: ${JSON.stringify(samples.slice(0, 5))}`);
		const counted = (await user.usage()).today.find((row) => row.sessionId === item.sessionId);
		assert(counted !== undefined && counted.seconds + counted.heldSeconds > 0, `the session's time today: ${JSON.stringify(counted)}`);
		await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [] });
		const cancelled = await user.actOnItem({ id: item.id, action: { kind: "cancel" } });
		await refused(() => user.actOnItem({ id: item.id, action: { kind: "start" } }), "item_conflict");
		return `${asked.question.text} (choices ${asked.question.choices.map((one) => one.id).join(", ")}); the fix turn held time in all ${samples.length} samples, ${counted.seconds} s counted, ${counted.heldSeconds} s held; then ${cancelled.state}`;
	});

	await check("ci: a failing CI gets a fix turn, and the same CI failure again stops at once with a question", async () => {
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Tighten the bolts", body: "Make the bolts tight.", start: true });
		const pushed = await untilItem(user, item.id, "the push", (view) => view.pullRequest !== null, 60_000);
		const pull = standin.pulls.find((one) => one.repository === harbor.id && one.number === pushed.pullRequest?.number);
		assert(pull, "no pull request");
		setCi(harbor, pull.head, "failure");
		const asked = await untilItem(user, item.id, "the question", (view) => view.question !== null, CI_WAIT_MS * 2);
		const fixes = said(asked).filter((line) => line.startsWith("CI failed")).length;
		assert(asked.question?.kind === "rounds" && /same failure/.test(asked.question.text) && fixes === 2 && asked.run?.rounds.ci === 1, `${stateOf(asked)}; ${said(asked).join(" / ")}`);
		return `${fixes} CI failures, ${asked.run.rounds.ci} fix round; ${asked.question.text}`;
	});

	await check("ask: the builder asks its person, the item waits with the agent's words apart, and the answer is the next turn's message", async () => {
		// "(ask)" makes the fake agent call ask_person once, with a direction override in its question.
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Store the readings", body: "Keep the readings somewhere. (ask)", start: true });
		const asked = await untilItem(user, item.id, "the agent's question", (view) => view.question !== null, 90_000);
		const question = asked.question;
		assert(question?.kind === "agent_ask" && question.choices.map((one) => one.id).join() === "reply,give_up", stateOf(asked));
		assert(question.asked?.text === "Which store should the readings go in? Reply in one word." && question.asked.options.join() === "SQLite,Postgres", `the agent's words: ${JSON.stringify(question.asked)}`);
		assert(!question.text.includes("SQLite") && !said(asked).some((line) => line.includes("Which store")) && asked.pullRequest === null && asked.run?.step.kind === "implement", `${stateOf(asked)}; ${said(asked).join(" / ")}`);
		const session = client.agentSession.get([auth.profile.uid, item.sessionId], { params: { token: auth.token } });
		const first = (await session.snapshot()).timeline;
		const opened = first.find((e) => e.kind === "windlass" && e.event.type === "fake.session_open");
		const tools = opened?.kind === "windlass" ? ((opened.event.data?.params as { _meta: { windlass: { hostTools: { name: string; effect: string }[] } } })._meta.windlass.hostTools) : [];
		assert(tools.some((tool) => tool.name === "ask_person" && tool.effect === "read"), `offered ${tools.map((tool) => tool.name).join(", ")}`);
		const settled = first.find((e) => e.kind === "windlass" && e.event.type === "tool.settled" && e.event.data?.callId === "call_ask_person");
		assert(settled?.kind === "windlass" && String(settled.event.data?.output).startsWith("Recorded as a question to the person."), "the agent was not told its question was recorded");
		await refused(() => user.actOnItem({ id: item.id, action: { kind: "answer", question: question.id, choice: "reply", note: "  " } }), "bad_input");
		await user.actOnItem({ id: item.id, action: { kind: "answer", question: question.id, choice: "reply", note: "Postgres, please." } });
		const pushed = await untilItem(user, item.id, "the push after the answer", (view) => view.pullRequest !== null || view.question !== null, 90_000);
		assert(pushed.pullRequest !== null, stateOf(pushed));
		const prompts = (await session.snapshot()).timeline.flatMap((e) => (e.kind === "user" ? [e] : []));
		const resumed = prompts.find((e) => e.turn === 2);
		assert(resumed && resumed.text.includes("The person answered your question:") && resumed.text.includes("Postgres, please.") && !resumed.text.includes("(ask)"), `turn 2's prompt: ${JSON.stringify(resumed?.text)}`);
		await user.actOnItem({ id: item.id, action: { kind: "cancel" } });
		return `${question.text} “${question.asked.text}”; answered, then #${pushed.pullRequest?.number}`;
	});

	await check("handoff: a refused review and comment are in the item's log and leave it handed over", async () => {
		const item = (await user.listItems()).find((one) => one.title === "Tighten the bolts");
		assert(item?.question, "no failing CI question");
		const ada = standin.users.get("ada")!;
		standin.users.delete("ada");
		standin.commentFault = "refuse";
		try {
			await user.actOnItem({ id: item.id, action: { kind: "answer", question: item.question.id, choice: "hand_over" } });
			const handed = await untilItem(user, item.id, "both GitHub refusals in the item log", (view) => said(view).includes("GitHub refused the review request (422).") && said(view).includes("Could not post the verdict comment (GitHub 403). The platform will try again."), 10_000);
			assert(handed.state === "review" && handed.verdict?.result === "fail", "GitHub's refusal lost the handoff");
			return "review refused (422), comment refused (403), failing verdict retained";
		} finally {
			standin.users.set("ada", ada);
			standin.commentFault = null;
		}
	});

	await check("sleep: an item waiting on its CI schedule while the server is stopped and started again proceeds when the time comes", async () => {
		await user.saveRepositoryDefaults({ repositoryId: harbor.id, screenshots: true });
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Across a restart", body: "Add a small program to the repository. (report) (screenshot)", start: true });
		const pushed = await untilItem(user, item.id, "the push", (view) => view.pullRequest !== null && view.wait?.reason === "ci", 60_000);
		const pull = standin.pulls.find((one) => one.repository === harbor.id && one.number === pushed.pullRequest?.number);
		assert(pull, "no pull request");
		assert(pushed.report?.title === "Report of turn 1", "the item did not store the report filed through the host tool");
		assert(pushed.report.screenshots.length === 0, "a deployment without a bucket kept an image");
		const timeline = (await client.agentSession.get([auth.profile.uid, pushed.sessionId], { params: { token: auth.token } }).snapshot()).timeline;
		assert(JSON.stringify(timeline).includes("your report was filed without them"), "the agent was not told the report was filed without screenshots");
		assert(pull.body.startsWith("What the fake agent did.") && !pull.body.includes("notes/turn-1.md"), "the first publish must use the description and omit look_at");
		await main.stop();
		setCi(harbor, pull.head, "success");
		standin.commentFault = "lose_reply";
		await main.start({ ...standin.env(), WLP_FACTORY_HOSTED_RUNNING: "20", WLP_FAKE_DELAY_MS: "25" });
		const handed = await untilItem(user, item.id, "the handoff after the restart", (view) => view.state === "review", CI_WAIT_MS);
		try {
			await waitFor("GitHub to store the comment before losing its reply", () => pull.comments.length === 1, 10_000);
			await main.stop("SIGKILL");
		} finally {
			standin.commentFault = null;
		}
		const original = checkHandoff(pull, handed);
		assert(handed.review?.state === "off" && !handed.reviews.length && handed.reviewerSessionId === null && handed.spent.turns === 1, "reviewer-off item must hand over after its builder alone");
		const blocks = handed.report?.blocks;
		assert(blocks?.length === 2 && blocks[0].kind === "text" && blocks[0].heading === "What it did" && blocks[0].text === "What the fake agent did." && blocks[1].kind === "text" && blocks[1].heading === "Where to look" && blocks[1].text === "notes/turn-1.md", "the reviewed page lost the filed blocks after restart");
		assert(original.body.includes("### What it did\n\nWhat the fake agent did.") && original.body.includes("### Where to look\n\nnotes/turn-1.md"), "the marked comment is missing the builder’s report");
		const edits = () => standin.requests.filter((call) => call.method === "PATCH" && call.path.endsWith(`/issues/comments/${original.id}`) && call.status === 200).length;
		await main.start({ ...standin.env(), WLP_FACTORY_HOSTED_RUNNING: "20", WLP_FAKE_DELAY_MS: "25" });
		await waitFor("the replay to write its comment", () => edits() > 0 || pull.comments.length > 1, 60_000);
		assert(edits() === 1 && pull.comments.length === 1, `replay made ${pull.comments.length} comments and ${edits()} edits`);
		checkHandoff(pull, handed);
		// Make the verdict visibly different even on the fake layer, whose head is a branch name.
		const ci = harbor.ci.get(pull.head)!;
		ci.statuses = [{ context: "lint", state: "success" }];
		await user.actOnItem({ id: item.id, action: { kind: "send_back", note: "Write a second short program." } });
		const second = await untilItem(user, item.id, "the second handoff", (view) => view.state === "review" && view.verdicts.length === 2, CI_WAIT_MS);
		await waitFor("the second handoff to edit the same comment", () => edits() === 2, 10_000);
		const updated = checkHandoff(pull, second);
		assert(second.report === null && !updated.body.includes("What the fake agent did"), "the second run shows the first report");
		assert(pull.title === item.title && pull.body.startsWith("Add a small program to the repository. (report)") && !pull.body.includes("What the fake agent did"), "the second publish kept the previous report’s PR title or description");
		assert(updated.id === original.id && updated.body.includes("CI passed \\(2 checks\\)"), "the second verdict did not replace the first on the same comment");
		const fired = main.text.match(/\[wlp\] schedule\.fired action=internalDue item=[^\n]*/g) ?? [];
		assert(fired.length > 0, "no firing of the item's schedule was logged");
		return `waited "${pushed.wait?.sentence}", then ${handed.state} with CI ${handed.verdicts.at(-1)?.ci.state}; ${fired.at(-1)}`;
	});

	await check("deploy: SIGTERM during an implement turn, a restart, and the step is tried again as attempt 2 with the 'you were interrupted' message", async () => {
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Slow work", body: "A long build (slow).", start: true });
		await untilItem(user, item.id, "the turn to start", (view) => view.run?.step.turn === "started", 60_000);
		await main.stop();
		await main.start({ ...standin.env(), WLP_FACTORY_HOSTED_RUNNING: "20", WLP_FAKE_DELAY_MS: "25" });
		const again = await untilItem(user, item.id, "attempt 2", (view) => (view.run?.step.attempt ?? 0) >= 2, 90_000);
		const session = client.agentSession.get([auth.profile.uid, item.sessionId], { params: { token: auth.token } });
		// Attempt 2 is delivered, then waits for its slot: the session's timeline has it once the turn is taken.
		let prompts: string[] = [];
		await waitFor("the attempt's prompt in the session", async () => {
			prompts = (await session.snapshot()).timeline.filter((entry) => entry.kind === "user").map((entry) => (entry.kind === "user" ? entry.text : ""));
			return prompts.some((text) => text.startsWith("You were interrupted"));
		}, 60_000, 400).catch(() => {
			throw new Error(`the session was told ${JSON.stringify(prompts)}`);
		});
		return `step ${again.run?.step.kind} attempt ${again.run?.step.attempt}; ${said(again).filter((line) => /cut off|tried again/.test(line)).join(" / ")}`;
	});
	await check("creation: a killed server and a lost client reply each leave one item per key", async () => {
		const secret = (await user.createApiToken({ name: "creation replay", scopes: ["items:create", "items:read"] })).secret;
		for (const fault of ["kill", "lost reply"]) {
			const title = `Replay creation after ${fault}`;
			const request = { method: "POST", token: secret, key: title, body: JSON.stringify({ repository: { id: harbor.id }, title, body: "File this item.", start: false }) };
			if (fault === "kill") {
				const accepted = await api("/api/items", request);
				assert(accepted.status === 201, "creation was not accepted");
				await main.stop("SIGKILL");
				await main.start({ ...standin.env(), WLP_FACTORY_HOSTED_RUNNING: "20", WLP_FAKE_DELAY_MS: "25" });
			} else {
				const lost = new Error("reply lost in transit");
				const transport: typeof fetch = async (input, init) => {
					const response = await fetch(input, init);
					assert(response.status === 201, "creation was not accepted");
					await response.arrayBuffer();
					throw lost;
				};
				const error = await api("/api/items", { ...request, transport }).catch((error) => error);
				assert(error === lost, "the first reply reached the client");
			}
			const replay = await api("/api/items", request);
			const matches = (await user.listItems()).filter((one) => one.title === title);
			assert(replay.status === 201 && matches.length === 1 && matches[0]?.id === replay.body.id, `${fault}: replay returned ${replay.status}, ${matches.length} items`);
		}
		return "one item for each replay";
	});
} finally {
	await main.stop();
	main.remove();
}

// With one factory turn: the second item waits with the sentence, and starts when the first's turn ends.
const narrow = new Server();
try {
	const dir = join(narrow.storage, "fake-bucket");
	const signing = randomBytes(32);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=";
	// The fake checkout starts at aaaaaaa; the later publish receipt names this commit.
	const publishedHead = "b".repeat(40);
	const { user, client, auth } = await world(narrow, standin, { WLP_FAKE_REVIEW_HEAD: publishedHead, WLP_FAKE_BACKUP_DIR: dir, WLP_FAKE_BUCKET_SIGNING_SECRET: signing.toString("hex"), WLP_FAKE_ATTACHMENT_PNG: png, WLP_FACTORY_TURNS: "1", WLP_FACTORY_RUNNING_TURNS: "2", WLP_FAKE_DELAY_MS: "50" });
	await check("capacity: with one factory turn a second item waits with the sentence, and starts when the first turn ends", async () => {
		const a = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "First (slow)", body: "A long build (slow).", start: true });
		await untilItem(user, a.id, "the first turn", (view) => view.run?.step.turn === "started", 60_000);
		const b = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Second", body: "Write a short program.", start: true });
		const waiting = await untilItem(user, b.id, "the wait", (view) => view.state === "waiting" && view.wait?.reason === "capacity", 30_000);
		assert(waiting.wait && /Waiting for one of your 1 factory turns; 1 are running \(“First \(slow\)”\)\./.test(waiting.wait.sentence), `it says ${waiting.wait?.sentence}`);
		const started = await untilItem(user, b.id, "the second turn", (view) => view.run?.step.turn === "started" || view.run?.step.kind !== "implement", 120_000);
		return `${waiting.wait.sentence} → ${started.state}`;
	});
	await check("screenshots: the item serves the builder’s PNG to its owner and links GitHub to the page", async () => {
		await user.saveRepositoryDefaults({ repositoryId: harbor.id, screenshots: true });
		const item = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Screenshot", body: "Change the home page. (report) (screenshot)", start: true });
		const view = await untilItem(user, item.id, "the report and push", v => !!v.report && !!v.pullRequest);
		const shot = view.report!.screenshots[0];
		assert(shot?.width === 1 && shot.height === 1 && shot.state === "kept" && view.report!.blocks.some(b => b.kind === "screenshot" && b.attachment === shot.id), "the item did not retain the verified PNG");
		assert(view.head === publishedHead && view.report!.head === publishedHead && shot.head === publishedHead, "the builder screenshot did not receive the pushed commit");
		const [link] = await user.itemAttachmentLinks(item.id);
		assert(link?.id === shot.id && Math.abs(link.expiresAt - Date.now() - 600_000) < 10_000, "the owner did not receive a ten-minute link");
		const store = new StandInObjectStore({ dir, secret: signing });
		const got = store.use(link.url, "GET");
		assert(got.status === 200 && got.headers?.get("content-type") === "image/png" && got.body?.equals(Buffer.from(png, "base64")), "the link did not serve the original PNG");
		const url = `${API}/api/items/${item.id}/attachments/${shot.id}`;
		const get = (url: string, token: string) => fetch(url, { headers: { authorization: "Bearer " + token }, redirect: "manual" });
		const limited = await user.createApiToken({ name: "create only", scopes: ["items:create"] });
		assert((await get(url, limited.secret)).status === 403, "a token without items:read was not refused with 403");
		const allowed = await user.createApiToken({ name: "read only", scopes: ["items:read"] });
		const redirect = await get(url, allowed.secret);
		assert(redirect.status === 302 && redirect.headers.get("cache-control") === "no-store" && redirect.headers.get("referrer-policy") === "no-referrer", "the private redirect was not returned");
		assert(store.use(redirect.headers.get("location") ?? "", "GET").status === 200, "the API redirect is unusable");
		assert((await get(url.replace(shot.id, "a_0000000000000000"), allowed.secret)).status === 404, "an unknown attachment was visible");
		const pull = standin.pulls.find(one => one.repository === harbor.id && one.number === view.pullRequest!.number)!;
		setCi(harbor, publishedHead, "success");
		await waitFor("the screenshot comment", () => pull.comments.length > 0, CI_WAIT_MS);
		const body = pull.comments[0].body;
		assert(body.includes(`1 screenshot on the item's page: ${ORIGIN}/items/${item.id} (opens for the item's owner only)`) && !/!\[|X-Amz-|wlp-stand-in/.test(body), "GitHub did not receive just the item page link");
		const snapshot = await client.agentSession.get([auth.profile.uid, item.sessionId], { params: { token: auth.token } }).snapshot();
		assert(!/wlp-stand-in:\/\/|X-Amz-/i.test(JSON.stringify([view, snapshot.timeline]) + narrow.text), "a signed link appeared in stored output or the server log");
		return "PNG, signed-in action, scoped redirect, and page-only GitHub comment";
	});
} finally {
	await narrow.stop();
	narrow.remove();
}

// With the day's allowance used: an item waits until 00:00 UTC.
const spent = new Server();
try {
	const { user } = await world(spent, standin, { WLP_DAILY_SANDBOX_SECONDS: "60", WLP_USAGE_HOLD_SECONDS: "60", WLP_FAKE_DELAY_MS: "50" });
	await check("allowance: with the day's sandbox time used, an item waits for 00:00 UTC, saying so", async () => {
		const tomorrow = (view: ItemView) => view.wait?.reason === "capacity" && /00:00 UTC/.test(view.wait.sentence);
		// The first item's turn holds the whole day's minute, or, where a turn needs more to start, waits itself.
		const a = await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Uses the day", body: "A long build (slow).", start: true });
		const first = await untilItem(user, a.id, "the first turn", (view) => view.run?.step.turn === "started" || tomorrow(view), 60_000);
		const b = tomorrow(first) ? null : await user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Waits for tomorrow", body: "Write a short program.", start: true });
		const waiting = b === null ? first : await untilItem(user, b.id, "the wait", tomorrow, 30_000);
		const midnight = Math.ceil(Date.now() / 86_400_000) * 86_400_000;
		assert(waiting.wait?.retryAt === midnight, `it is tried again at ${waiting.wait?.retryAt}, not ${midnight}`);
		return waiting.wait.sentence;
	});
} finally {
	await spent.stop();
	spent.remove();
}

// With the switch off (WLP_ITEMS unset, the default): the routes are unknown, the actions refused, and platform info says nothing of items.
const off = new Server();
try {
	const { user } = await world(off, standin, { WLP_ITEMS: "" });
	await check("off: with WLP_ITEMS unset the routes are unknown, every item and API token action is refused, the limits are still answered, and platform info has no items", async () => {
		const info = (await (await fetch(`${API}/platform/info`)).json()) as { items?: unknown };
		assert(info.items === undefined, `platform info has items: ${JSON.stringify(info.items)}`);
		// A token-shaped value: an unknown route answers before any token is looked at.
		const shaped = `wlp_u_0123456789abcdef0123.${"A".repeat(43)}`;
		const post = await api("/api/items", { method: "POST", body: "{}", token: shaped, key: "k" });
		const get = await api("/api/items/i_0123456789abcdef", { token: shaped });
		assert(post.status === 404 && post.body.code === "not_found" && get.status === 404 && get.body.code === "not_found", `the routes answered ${post.status} ${JSON.stringify(post.body)} and ${get.status} ${JSON.stringify(get.body)}`);
		const said = await refused(() => user.listItems(), "items_off");
		// The limits are still answered: the ceiling on running agents holds for a person's own agents too.
		const limits = await user.factoryLimits();
		assert(typeof limits.runningTurns === "number" && limits.runningTurns > 0, `the limits answered ${JSON.stringify(limits)}`);
		await refused(() => user.apiTokens(), "items_off");
		await refused(() => user.createApiToken({ name: "script", scopes: ["items:read"] }), "items_off");
		await refused(() => user.revokeApiToken("tok_0123456789abcdef"), "items_off");
		await refused(() => user.createItem({ mode: "single", repository: { id: harbor.id }, title: "Off", body: "Nothing.", start: true }), "items_off");
		await refused(() => user.item("i_0123456789abcdef"), "items_off");
		await refused(() => user.actOnItem({ id: "i_0123456789abcdef", action: { kind: "cancel" } }), "items_off");
		const sessions = await user.listSessions();
		assert(sessions.every((one) => !one.item), "a session of an item was made with the switch off");
		return `routes 404 not_found; actions refused: “${said}”; platform info without items`;
	});
} finally {
	await off.stop();
	off.remove();
	await standin.stop();
}

if (output.length > 0) console.log(output.join("\n"));
console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
