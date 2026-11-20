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

import { StandInObjectStore } from "../server/src/bucket/stand-in.js";
import { verdictWords } from "../server/src/factory/verdict.js";
import { localListeners } from "./check-listeners.js";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthResult, ItemSummary, ItemView } from "../server/src/contract.js";
import { createClient, type Registry } from "../server/src/client.js";
import { StandInRunner } from "./runner-standin.js";
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
		const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: SERVER_DIR, env: full, stdio: ["ignore", "pipe", "pipe"] });
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

/** One server with a GitHub stand-in, a demo user connected to it as "ada", and a repository. */
async function world(server: Server, standin: GithubStandin, env: Record<string, string> = {}) {
	await server.start({ ...standin.env(), ...env });
	const client: Client = createClient<Registry>({ endpoint: ENDPOINT, headers: { Origin: ORIGIN } });
	const auth: AuthResult = await client.login.getOrCreate([`a_${randomBytes(8).toString("hex")}`]).demo();
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
const harbor = standin.addRepository({ owner: "ada", name: "harbor", private: true, installation, files: { "README.md": "# harbor\n", "notes.txt": "Review notes.\n" } });
standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read" };

if (!only.length || only.some(name => name.startsWith("reviewer"))) {
	const server = new Server();
	try {
		const head = "a".repeat(40);
		setCi(harbor, head, "success");
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=";
		const { config } = await import("../server/src/config.js");
		const { client, user, auth } = await world(server, standin, { WLP_SECRET: config.secret.toString(), WLP_FACTORY_REVIEWER: "on", WLP_FAKE_REVIEW_HEAD: head, WLP_FAKE_BACKUP_DIR: join(server.storage, "shots"), WLP_FAKE_BUCKET_SIGNING_SECRET: randomBytes(32).toString("hex"), WLP_FAKE_ATTACHMENT_PNG: png, WLP_IDLE_SUSPEND_MS: "1000" });
		await check("reviewer: actual turn offer, independent filing, head, comment, ownership and both ledgers", async () => {
			const profile = "docker-windlass-sandbox";
			await user.saveRepositorySecret({ repositoryId: harbor.id, profile, name: "BUILD_ONLY", scope: "agent", value: "fixture-builder-only-value" });
			await user.saveRepositorySecret({ repositoryId: harbor.id, profile, name: "SETUP_ONLY", scope: "setup", value: "fixture-setup-only-value" });
			await user.saveAccountSecret({ profile, name: "ACCOUNT_ONLY", scope: "agent", value: "fixture-account-only-value" });
			await user.savePersonalServer({ name: "builder-notes", definition: { command: "cat" } });
			await user.saveRepositoryChecks({ repositoryId: harbor.id, checks: [{ name: "build", command: "true" }] });
			await user.saveRepositorySetup({ repositoryId: harbor.id, command: "true" });
			const item = await user.createItem({ repository: { id: harbor.id }, title: "Review the homepage", body: "Change the homepage. (report) (review-files) (lookup-limit)", start: true });
			const view = await untilItem(user, item.id, "the second review handoff", v => v.state === "review", CI_WAIT_MS);
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
		await check("reviewer: networked commands hand over with the profile reason", async () => {
			const item = await user.createItem({ repository: { id: harbor.id }, profile: "docker-hardened", title: "Networked profile", body: "Change the homepage.", start: true });
			const view = await untilItem(user, item.id, "the handoff without a reviewer", v => v.state === "review", CI_WAIT_MS);
			assert(view.reviewerSessionId === null && !view.reviews.length && view.review?.state === "off" && view.reviewNone?.includes("commands would run with the network"), "networked commands admitted a reviewer");
			return view.reviewNone ?? undefined;
		});
		await check("reviewer: repository screenshot opt-out reaches both agents", async () => {
			await user.saveRepositoryDefaults({ repositoryId: harbor.id, screenshots: false });
			const item = await user.createItem({ repository: { id: harbor.id }, title: "Review without pictures", body: "Change the homepage. (report) (screenshot) (try-disabled-shot)", start: true });
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Review the pushed commit", body: "Change the homepage.", start: true });
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
	const { workItem, REPORTS_TABLE, REVIEWS_TABLE } = await import("../server/src/actors/work-item.js");
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
		await db.execute(REPORTS_TABLE);
		await db.execute(REVIEWS_TABLE);
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
		let calls = 0;
		const jobs: Promise<unknown>[] = [];
		const c = {
			key: ["u", "s"],
			db,
			log: { warn: () => undefined },
			client: () => ({ user: { get: () => ({ internalTurnDone: async () => (calls += 1) === 1 ? Promise.reject(new Error("not now")) : undefined }) } }),
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
		assert(left.n === 0 && calls === 2, `rows left ${left.n}, sends ${calls}`);
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
			vars: { items: await loadItems(db as never), machines: new Map<string, { name: string; since: number; status: string; sandboxes: unknown[] }>(), sessions, usage: new UsageBook({ dailySeconds: 100_000, holdSeconds: 60, maxKept: 20 }), profile: null },
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
		(q.c.conn as { params: unknown }).params = { token: issueUserToken(profile) };
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
						return { id: made?.id, title: made?.task.title, place: made?.place, createdAt: T, revision: 0 };
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
		const failing = { turn: 1, state: "unresolved", run: { turn: 1, at: T, checks: [{ name: "test", command: "npm test", whose: "user", required: true, status: "failed", exitCode: 1, durationMs: 1, sentBack: 3, output: "expected 3" }] }, unrun: [], replaced: false, changedAfter: false };
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
		const failing = { turn: 1, state: "unresolved", run: { turn: 1, at: T, checks: [{ name: "test", command: "npm test", whose: "user", required: true, status: "failed", exitCode: 1, durationMs: 1, sentBack: 3, output: "expected 3" }] }, unrun: [], replaced: false, changedAfter: false };
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
// The in-memory cases alone need no server: FACTORY_ONLY=memory stops here.
if (only.length > 0 && only.every((name) => name.startsWith("memory"))) {
	await standin.stop();
	console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

async function machineChecks(): Promise<void> {
	const server = new Server();
	const runner = new StandInRunner(API, ENDPOINT);
	try {
		const { user } = await world(server, standin, { WLP_MACHINES: "1", WLP_FACTORY_REVIEWER: "on", WLP_PUBLIC_URL: API, WLP_FACTORY_HOSTED_RUNNING: "1", WLP_FACTORY_ITEM_HOSTED_SECONDS: "1" });
		await runner.pair(user);
		const place = { kind: "machine" as const, machineId: runner.id.machineId };
		const task = { repository: { id: harbor.id }, title: "On my machine", body: "Write a short program.", place };
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

		await check("machine: a machine turn and a hosted turn overlap with one hosted slot, and machine review costs zero hosted seconds", async () => {
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
			assert(open?.approval === "full" && open.attended === false && open.unattended === "deny", "the hardened container was not opened in unattended full mode");
			assert(review.verdicts.at(-1)?.attestedBy === `machine:${place.machineId}` && review.spent.turns === 1 && review.spent.hostedSeconds === 0, JSON.stringify(review.spent));
			return "overlapping turns, one machine-attested verdict, zero hosted seconds";
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

if (!only.length || only.some(prefix => prefix.startsWith("machine"))) await machineChecks();
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
		const body = { repository: { id: harbor.id }, title: "Write a short program", body: "Add a small program to the repository.", acceptance: ["It runs", "Keep <!-- windlass-item:fake --> and @everyone inert"], start: true };
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
		const info = (await (await fetch(`${API}/platform/info`)).json()) as { items?: unknown };
		assert(info.items === true, `platform info has items: ${JSON.stringify(info.items)}`);
		return "items: true";
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "A short note", body: "Add a short note to the repository.", start: true });
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Fix the light", body: "Make the light work.", start: true });
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Tighten the bolts", body: "Make the bolts tight.", start: true });
		const pushed = await untilItem(user, item.id, "the push", (view) => view.pullRequest !== null, 60_000);
		const pull = standin.pulls.find((one) => one.repository === harbor.id && one.number === pushed.pullRequest?.number);
		assert(pull, "no pull request");
		setCi(harbor, pull.head, "failure");
		const asked = await untilItem(user, item.id, "the question", (view) => view.question !== null, CI_WAIT_MS * 2);
		const fixes = said(asked).filter((line) => line.startsWith("CI failed")).length;
		assert(asked.question?.kind === "rounds" && /same failure/.test(asked.question.text) && fixes === 2 && asked.run?.rounds.ci === 1, `${stateOf(asked)}; ${said(asked).join(" / ")}`);
		return `${fixes} CI failures, ${asked.run.rounds.ci} fix round; ${asked.question.text}`;
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Across a restart", body: "Add a small program to the repository. (report) (screenshot)", start: true });
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
		assert(original.body.includes("What the fake agent did\\.") && original.body.includes("notes/turn-1\\.md"), "the marked comment is missing the builder’s report");
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Slow work", body: "A long build (slow).", start: true });
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
	const { user, client, auth } = await world(narrow, standin, { WLP_FAKE_BACKUP_DIR: dir, WLP_FAKE_BUCKET_SIGNING_SECRET: signing.toString("hex"), WLP_FAKE_ATTACHMENT_PNG: png, WLP_FACTORY_TURNS: "1", WLP_FACTORY_RUNNING_TURNS: "2", WLP_FAKE_DELAY_MS: "50" });
	await check("capacity: with one factory turn a second item waits with the sentence, and starts when the first turn ends", async () => {
		const a = await user.createItem({ repository: { id: harbor.id }, title: "First (slow)", body: "A long build (slow).", start: true });
		await untilItem(user, a.id, "the first turn", (view) => view.run?.step.turn === "started", 60_000);
		const b = await user.createItem({ repository: { id: harbor.id }, title: "Second", body: "Write a short program.", start: true });
		const waiting = await untilItem(user, b.id, "the wait", (view) => view.state === "waiting" && view.wait?.reason === "capacity", 30_000);
		assert(waiting.wait && /Waiting for one of your 1 factory turns; 1 are running \(“First \(slow\)”\)\./.test(waiting.wait.sentence), `it says ${waiting.wait?.sentence}`);
		const started = await untilItem(user, b.id, "the second turn", (view) => view.run?.step.turn === "started" || view.run?.step.kind !== "implement", 120_000);
		return `${waiting.wait.sentence} → ${started.state}`;
	});
	await check("screenshots: the item serves the builder’s PNG to its owner and links GitHub to the page", async () => {
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Screenshot", body: "Change the home page. (report) (screenshot)", start: true });
		const view = await untilItem(user, item.id, "the report and push", v => !!v.report && !!v.pullRequest);
		const shot = view.report!.screenshots[0];
		assert(shot?.width === 1 && shot.height === 1 && shot.state === "kept" && view.report!.blocks.some(b => b.kind === "screenshot" && b.attachment === shot.id), "the item did not retain the verified PNG");
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
		setCi(harbor, pull.head, "success");
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
		const a = await user.createItem({ repository: { id: harbor.id }, title: "Uses the day", body: "A long build (slow).", start: true });
		const first = await untilItem(user, a.id, "the first turn", (view) => view.run?.step.turn === "started" || tomorrow(view), 60_000);
		const b = tomorrow(first) ? null : await user.createItem({ repository: { id: harbor.id }, title: "Waits for tomorrow", body: "Write a short program.", start: true });
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
		await refused(() => user.createItem({ repository: { id: harbor.id }, title: "Off", body: "Nothing.", start: true }), "items_off");
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
