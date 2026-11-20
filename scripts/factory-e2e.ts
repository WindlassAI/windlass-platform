/**
 * End-to-end check of the software factory's spine (Plans "software factory", slice 1): work items
 * through the real actors (`user`, `workItem`, `agentSession`) on the fake sandbox layer, with GitHub
 * played by scripts/github-standin.ts. Run with:
 *
 *   cd server && ../scripts/locked.sh factory-e2e.ts
 *
 * It starts its own servers on fresh state, on ports of its own (engine 6620, which also takes 6621
 * and 6630; HTTP 6645), and stops each by its PID. The fake layer replays recorded turns (its words
 * choose them, sandbox-fake.ts): a user's check whose command says "fail" fails, every other passes,
 * and a turn always leaves files to push. CI is set on the stand-in per branch; the factory polls it
 * every minute (github/ci.ts `CI_POLLING`), so a check that waits for CI takes a minute or more.
 *
 *   FACTORY_ONLY=api,ci   run only the sections whose names start with one of these
 *
 * Prints one PASS/FAIL/SKIP line per check and exits 1 if any failed.
 */

import { checkPort } from "./ports.js";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthResult, ItemSummary, ItemView } from "../server/src/contract.js";
import { createClient, type Registry } from "../server/src/client.js";
import { GithubStandin, type StandinRepository, type StandinPull } from "./github-standin.js";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../server");
const ENGINE_PORT = checkPort(6620);
const HTTP_PORT = checkPort(6645);
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
const harbor = standin.addRepository({ owner: "ada", name: "harbor", private: true, installation });
standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read" };

// The actions the factory's schedules fire are looked up by name when they fire: each must be registered under that name.
await check("schedules: every action the factory schedules is registered under the name it is scheduled by", async () => {
	process.env.WLP_SECRET ??= randomBytes(24).toString("hex");
	process.env.WLP_SANDBOX = "fake";
	const { workItem, DUE_ACTION } = await import("../server/src/actors/work-item.js");
	const { user } = await import("../server/src/actors/user.js");
	const { QUEUE_ACTION } = await import("../server/src/actors/user-items.js");
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	const { OUTBOX_ACTION } = await import("../server/src/actors/session-inbox.js");
	const missing = [
		[workItem, DUE_ACTION, "workItem"],
		[user, QUEUE_ACTION, "user"],
		[agentSession, OUTBOX_ACTION, "agentSession"],
	].filter(([definition, name]) => typeof ((definition as { config: { actions: Record<string, unknown> } }).config.actions[name as string]) !== "function");
	assert(missing.length === 0, `not registered: ${missing.map(([, name, actor]) => `${actor}.${name}`).join(", ")}`);
	return `${DUE_ACTION}, ${QUEUE_ACTION}, ${OUTBOX_ACTION}`;
});

function checkHandoff(pull: StandinPull, view: ItemView) {
	const verdict = view.verdicts.at(-1)!;
	const posts = standin.requests.filter((call) => call.method === "POST" && call.path.endsWith(`/pulls/${pull.number}/requested_reviewers`));
	assert(posts.length === 1 && pull.requestedReviewers.join() === "ada", `expected one review request for ada, got ${posts.length} calls, ${pull.requestedReviewers}`);
	const own = pull.comments.filter((one) => one.user.login === `${standin.slug}[bot]`);
	assert(own.length === 1, `expected one platform comment, got ${own.length}`);
	const comment = own[0]!;
	assert(comment.body.startsWith(`<!-- windlass-item:${view.id} -->\n\n**Windlass verdict at ${verdict.head.slice(0, 7)}: ${verdict.result}**`), "the comment is missing the marker or the current verdict");
	return comment;
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

	await check("api: a machine place is refused with a sentence", async () => {
		const answer = await api("/api/items", { method: "POST", body: JSON.stringify({ repository: { id: harbor.id }, title: "On my machine", body: "x", place: { kind: "machine", machineId: "m_0123456789abcdef" } }), token, key: "k-3" });
		assert(answer.status === 400 && answer.body.code === "bad_input" && /machines?/.test(String(answer.body.message)), `answered ${answer.status} ${JSON.stringify(answer.body)}`);
		return String(answer.body.message);
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
		// The hold race (finding 3): the next turn's hold and place survive the end of the turn before it, and its time is counted.
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
		const item = await user.createItem({ repository: { id: harbor.id }, title: "Across a restart", body: "Add a small program to the repository.", start: true });
		const pushed = await untilItem(user, item.id, "the push", (view) => view.pullRequest !== null && view.wait?.reason === "ci", 60_000);
		const pull = standin.pulls.find((one) => one.repository === harbor.id && one.number === pushed.pullRequest?.number);
		assert(pull, "no pull request");
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
	const { user } = await world(narrow, standin, { WLP_FACTORY_TURNS: "1", WLP_FACTORY_RUNNING_TURNS: "2", WLP_FAKE_DELAY_MS: "50" });
	await check("capacity: with one factory turn a second item waits with the sentence, and starts when the first turn ends", async () => {
		const a = await user.createItem({ repository: { id: harbor.id }, title: "First (slow)", body: "A long build (slow).", start: true });
		await untilItem(user, a.id, "the first turn", (view) => view.run?.step.turn === "started", 60_000);
		const b = await user.createItem({ repository: { id: harbor.id }, title: "Second", body: "Write a short program.", start: true });
		const waiting = await untilItem(user, b.id, "the wait", (view) => view.state === "waiting" && view.wait?.reason === "capacity", 30_000);
		assert(waiting.wait && /Waiting for one of your 1 factory turns; 1 are running \(“First \(slow\)”\)\./.test(waiting.wait.sentence), `it says ${waiting.wait?.sentence}`);
		const started = await untilItem(user, b.id, "the second turn", (view) => view.run?.step.turn === "started" || view.run?.step.kind !== "implement", 120_000);
		return `${waiting.wait.sentence} → ${started.state}`;
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
