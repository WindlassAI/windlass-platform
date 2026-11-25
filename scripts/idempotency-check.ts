/**
 * A message that reaches the platform twice, through the real actors on fake sandboxes: what a repeat
 * does without a key (two messages, two turns, two agents: as it always was), and that with the key
 * of its submission (`PromptInput.idempotencyKey`, `CreateSessionInput.idempotencyKey`) it is taken
 * once and answered as the first attempt was (docs/architecture.md, "A message sent twice").
 *
 *   cd server && npx tsx ../scripts/idempotency-check.ts
 *
 * It starts a server of its own on fresh state, on OS-assigned ports, so it runs beside a development server and beside the end-to-end suite. No model is
 * called and nothing leaves the machine.
 *
 * What it holds to: a key is a string of 1 to 255 characters, and anything else is refused, not read
 * as no key; a repeat while the turn runs, after it ended, of a steered message, at the same moment
 * as the first attempt, after the actor slept and after the server was killed under a running turn, is
 * answered as the first was and adds nothing; a first attempt that was refused leaves its key unused;
 * a key that comes with another message is refused; a session remembers the keys of its newest
 * messages and no more; one call that RivetKit's own client sends twice is one message; and
 * `createSession` goes by the same rules.
 *
 * How RivetKit is made to send one call twice. Its client sends an action again, by itself, when the
 * engine answers that the response was lost on its way from the actor (`guard.tunnel_response_closed`
 * and its like: what a caller gets when the tunnel to the actor's server breaks under a request).
 * Here the client is given a `fetch` that lets the call through to the engine, waits until the actor
 * has answered, throws that answer away and answers in those words instead, once. The loss is played;
 * the second delivery is RivetKit's own, 25 ms later.
 */

import { loginHttp } from "./login-http.js";
import { localListeners, portFree } from "./check-listeners.js";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../server/src/client.js";
import { type AuthResult, MAX_REMEMBERED_SUBMISSIONS, type SessionSnapshot, type SessionSummary, type TimelineItem } from "../server/src/contract.js";

// The client's own log lines about refusals are not this check's output.
process.env.RIVET_LOG_LEVEL ??= "silent";
const { createClient } = await import("../server/src/client.js");

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../server");
const { engine: ENGINE_PORT, http: [HTTP_PORT] } = await localListeners();
const ENDPOINT = `http://127.0.0.1:${ENGINE_PORT}`;
const API = `http://127.0.0.1:${HTTP_PORT}`;
const PROFILE = "docker-windlass-sandbox" as const;
/** The ceiling on a person's hosted agents working at once that this check's cases assume: its server is started with it (WLP_FACTORY_HOSTED_RUNNING). */
const RUNNING_CEILING = 3;
/** A prompt whose turn runs one command for a while: long enough to send a second message into. */
const LONG = "Run the long build and report its progress (slow)";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const plain = (value: unknown) => JSON.stringify(value);

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `\n      ${detail}` : ""}`);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30_000, everyMs = 40): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(everyMs);
	}
}

/** What a call was answered with: its value, or the code it was refused with. */
async function outcome<T>(call: Promise<T>): Promise<{ value: T } | { code: string }> {
	try {
		return { value: await call };
	} catch (error) {
		return { code: String((error as { code?: unknown }).code ?? (error as { message?: unknown }).message ?? error) };
	}
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

const storage = mkdtempSync(join(tmpdir(), "wlp-idempotency-"));
/** The same for every start: a token signed before a restart is good after it. */
const secret = randomBytes(24).toString("hex");
let child: ChildProcess | null = null;
let output = "";

async function startServer(): Promise<void> {
	const env: Record<string, string | undefined> = {
		...process.env,
		WLP_DEMO: "1",
		WLP_SANDBOX: "fake",
		WLP_SECRET: secret,
		RIVETKIT_STORAGE_PATH: storage,
		RIVET_RUN_ENGINE_PORT: String(ENGINE_PORT),
		WLP_HTTP_PORT: String(HTTP_PORT),
		WLP_FAKE_DELAY_MS: "15",
		WLP_DAILY_SANDBOX_SECONDS: "unlimited",
		// The refusal at RUNNING_CEILING busy sessions is checked: a person's ceiling, WLP_FACTORY_HOSTED_RUNNING, is set to it here.
		WLP_FACTORY_HOSTED_RUNNING: String(RUNNING_CEILING),
		WLP_MAX_KEPT_SANDBOXES: "unlimited",
	};
	// The local engine asks for no token; one in the shell this is run from is some other engine's.
	for (const name of ["RIVET_ADMIN_TOKEN", "WLP_PUBLIC_ENDPOINT", "RIVET_ENDPOINT", "RIVET_ENGINE", "PORT"]) delete env[name];
	const started = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	child = started;
	const keep = (chunk: Buffer) => {
		output += chunk.toString("utf8");
	};
	started.stdout?.on("data", keep);
	started.stderr?.on("data", keep);
	started.on("exit", () => {
		if (child === started) child = null;
	});
	await waitFor(
		"the server to answer",
		async () => {
			if (!child) throw new Error(`the server exited while starting:\n${output.slice(-1500)}`);
			try {
				return (await fetch(`${API}/platform/info`)).ok;
			} catch {
				return false;
			}
		},
		120_000,
		400,
	);
}

/** Stops the server: as a deploy does, or with `signal` SIGKILL as a crash does, with no chance to write anything. */
async function stopServer(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
	const running = child;
	if (running) {
		running.kill(signal);
		await waitFor("the server to exit", async () => child === null, 40_000, 100).catch(() => running.kill("SIGKILL"));
	}
	await sleep(300);
	// The engine is the server's child: it must not outlive it and keep the port.
	try {
		const runtime = JSON.parse(readFileSync(join(storage, ".rivetkit", "var", "engine", "runtime.json"), "utf8")) as { pid?: number };
		if (typeof runtime.pid === "number") process.kill(runtime.pid, "SIGKILL");
	} catch {
		// No engine left.
	}
	await waitFor("the server's ports to be free", async () => (await portFree(ENGINE_PORT)) && (await portFree(HTTP_PORT)), 20_000, 200);
}

/** Puts an actor to sleep through the engine's control plane, whatever it is doing. */
async function forceSleep(name: "agentSession" | "user", key: string): Promise<void> {
	const headers = { Authorization: "Bearer default", "Content-Type": "application/json" };
	const list = (await (await fetch(`${ENDPOINT}/actors?namespace=default&name=${name}`, { headers })).json()) as { actors: Array<{ actor_id: string; key: string }> };
	const record = list.actors.find((entry) => entry.key.includes(key));
	if (!record) throw new Error(`the control plane does not list the actor ${name} ${key}`);
	const slept = await fetch(`${ENDPOINT}/actors/${record.actor_id}/sleep?namespace=default`, { method: "POST", headers, body: "{}" });
	if (!slept.ok) throw new Error(`the control plane refused the sleep: ${slept.status}`);
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

type UserItem = Extract<TimelineItem, { kind: "user" }>;
type Answer = { turn: number; steered: boolean };
/** The inputs as this check sends them: with the key, which a server from before it does not know. */
type Prompt = { text: string; idempotencyKey?: unknown };

/** The action whose next answer is lost on its way, once; null when none is. */
let lose: string | null = null;
/** How often each action was sent while an answer of its was to be lost. */
const sent = new Map<string, number>();

/** `fetch`, except that the next answer to the action `lose` names never arrives: the caller is told so in the engine's words. */
const lossy: typeof fetch = async (input, init) => {
	const request = new Request(input, init);
	const action = /\/action\/([A-Za-z]+)$/.exec(new URL(request.url).pathname)?.[1];
	if (action !== undefined && request.method === "POST") sent.set(action, (sent.get(action) ?? 0) + 1);
	const response = await fetch(request);
	if (action === undefined || action !== lose || request.method !== "POST") return response;
	lose = null;
	// The actor has run the action by now; what it answered goes nowhere.
	await response.arrayBuffer();
	return new Response(JSON.stringify({ group: "guard", code: "tunnel_response_closed", message: "The response was lost on its way from the actor." }), { status: 503, headers: { "content-type": "application/json" } });
};

async function main(): Promise<void> {
	const client = createClient<Registry>({ endpoint: ENDPOINT, fetch: lossy });
	const signIn = async (): Promise<AuthResult> => loginHttp(API).demo();
	// The HTTP routes can answer before the local engine has opened actor storage under load.
	const auth = await waitFor("the login service to become reachable", () => signIn().catch(() => false as const), 90_000, 500);
	const { uid } = auth.profile;
	const params = { token: auth.token };
	const user = client.user.getOrCreate([uid], { params });
	const create = (input: Record<string, unknown> = {}): Promise<SessionSummary> => user.createSession({ profile: PROFILE, ...input } as never);
	const sessionOf = (id: string, as: AuthResult = auth) => {
		const handle = client.agentSession.get([as.profile.uid, id], { params: { token: as.token } });
		return {
			prompt: (input: Prompt): Promise<Answer> => handle.prompt(input as never),
			snapshot: (): Promise<SessionSnapshot> => handle.snapshot(),
			stop: (): Promise<void> => handle.stop(),
		};
	};
	const userItems = (snapshot: SessionSnapshot): UserItem[] => snapshot.timeline.filter((item): item is UserItem => item.kind === "user");
	const turnsEnded = (snapshot: SessionSnapshot): number => snapshot.timeline.filter((item) => item.kind === "turn.ended").length;
	const idle = async (session: ReturnType<typeof sessionOf>, turns: number): Promise<SessionSnapshot> =>
		waitFor(`turn ${turns} to end`, async () => {
			const now = await session.snapshot().catch(() => undefined);
			return now && now.summary.status === "idle" && turnsEnded(now) >= turns ? now : undefined;
		});
	const running = async (session: ReturnType<typeof sessionOf>): Promise<void> => {
		await waitFor("the turn to run", async () => (await session.snapshot()).summary.status === "running");
	};
	/** What a session came to: its user messages, the turns it counts and the turns that ended. */
	const shape = (snapshot: SessionSnapshot): string => `${userItems(snapshot).length} user message(s), ${snapshot.summary.turns} turn(s), ${turnsEnded(snapshot)} ended`;

	// --- without a key: as it always was ----------------------------------------------------------

	{
		const session = sessionOf((await create()).id);
		const first = await session.prompt({ text: LONG });
		await running(session);
		const second = await session.prompt({ text: LONG });
		const after = await idle(session, 1);
		expect(
			"without a key, the same prompt again while its turn runs is a second message in that turn",
			plain(first) === plain({ turn: 1, steered: false }) && plain(second) === plain({ turn: 1, steered: true }) && userItems(after).length === 2 && userItems(after)[1]?.steer === true,
			`answers ${plain(first)} and ${plain(second)}; ${shape(after)}`,
		);
		const third = await session.prompt({ text: LONG });
		const later = await idle(session, 2);
		expect("without a key, the same prompt again after its turn ended starts a second turn", third.turn === 2 && third.steered === false && later.summary.turns === 2, `answer ${plain(third)}; ${shape(later)}`);
		const before = (await user.listSessions()).length;
		const [one, two] = [await create({ title: "Twice" }), await create({ title: "Twice" })];
		expect("without a key, createSession again makes a second agent", one.id !== two.id && (await user.listSessions()).length === before + 2, `${one.id} and ${two.id}`);
	}

	// --- with a key: a prompt ---------------------------------------------------------------------

	const kept = sessionOf((await create()).id);
	const key = randomUUID();
	{
		const first = await kept.prompt({ text: LONG, idempotencyKey: key });
		await running(kept);
		const whileRunning = await outcome(kept.prompt({ text: LONG, idempotencyKey: key }));
		const ended = await idle(kept, 1);
		const afterwards = await outcome(kept.prompt({ text: LONG, idempotencyKey: key }));
		await sleep(400);
		const after = await kept.snapshot();
		const same = plain(whileRunning) === plain({ value: first }) && plain(afterwards) === plain({ value: first });
		expect(
			"with one key, the prompt again while its turn runs and again after it ended is answered as the first was: one message, one turn",
			same && userItems(after).length === 1 && after.summary.turns === 1 && after.summary.status === "idle" && after.timeline.length === ended.timeline.length,
			`answers ${plain(first)}, ${plain(whileRunning)}, ${plain(afterwards)}; ${shape(after)}`,
		);
		expect("the key is not in what a client reads of the timeline", !plain(after).includes(key));
	}

	{
		const session = sessionOf((await create()).id);
		await session.prompt({ text: LONG });
		await running(session);
		const steer = randomUUID();
		const first = await outcome(session.prompt({ text: "Also say how long it took", idempotencyKey: steer }));
		const second = await outcome(session.prompt({ text: "Also say how long it took", idempotencyKey: steer }));
		await idle(session, 1);
		const third = await outcome(session.prompt({ text: "Also say how long it took", idempotencyKey: steer }));
		await sleep(400);
		const after = await session.snapshot();
		expect(
			"a steered message again, while the turn runs and after it ended, stays one message and starts nothing",
			plain(first) === plain({ value: { turn: 1, steered: true } }) && plain(second) === plain(first) && plain(third) === plain(first) && userItems(after).length === 2 && after.summary.turns === 1 && after.summary.status === "idle",
			`answers ${plain(first)}, ${plain(second)}, ${plain(third)}; ${shape(after)}`,
		);
	}

	{
		const session = sessionOf((await create()).id);
		const both = randomUUID();
		const answers = await Promise.all([outcome(session.prompt({ text: "Explore the workspace", idempotencyKey: both })), outcome(session.prompt({ text: "Explore the workspace", idempotencyKey: both })), outcome(session.prompt({ text: "Explore the workspace", idempotencyKey: both }))]);
		const after = await idle(session, 1);
		expect(
			"three attempts of one submission at the same moment end as one: the same answer, one message, one turn",
			answers.every((answer) => plain(answer) === plain({ value: { turn: 1, steered: false } })) && userItems(after).length === 1 && after.summary.turns === 1,
			`answers ${answers.map(plain).join(", ")}; ${shape(after)}`,
		);
	}

	// --- refusals ---------------------------------------------------------------------------------

	{
		const session = sessionOf((await create()).id);
		const before = await session.snapshot();
		const answers: string[] = [];
		for (const bad of ["", "k".repeat(256), 7, { key: "x" }, true]) answers.push(plain(await outcome(session.prompt({ text: "Explore the workspace", idempotencyKey: bad }))));
		const after = await session.snapshot();
		expect(
			"a key that is empty, longer than 255 characters or no string is refused, and nothing is started",
			answers.every((answer) => answer === plain({ code: "bad_idempotency_key" })) && after.timeline.length === before.timeline.length && after.summary.turns === 0,
			`answers ${answers.join(", ")}; ${shape(after)}`,
		);
		// Counted in characters, as JSON Schema's maxLength counts: 255 of them are a key, whatever their bytes.
		const longest = "é".repeat(255);
		const taken = await outcome(session.prompt({ text: "Explore the workspace", idempotencyKey: longest }));
		const none = await outcome(sessionOf((await create()).id).prompt({ text: "Explore the workspace", idempotencyKey: null }));
		expect("a key of 255 characters is one, and null is no key", plain(taken) === plain({ value: { turn: 1, steered: false } }) && plain(none) === plain({ value: { turn: 1, steered: false } }), `answers ${plain(taken)} and ${plain(none)}`);
		await idle(session, 1);
		const other = await outcome(session.prompt({ text: "Something else entirely", idempotencyKey: longest }));
		const again = await outcome(session.prompt({ text: "Explore the workspace", idempotencyKey: longest }));
		const end = await session.snapshot();
		expect(
			"a key that comes with another message is refused by a code of its own, and stays the first message's",
			plain(other) === plain({ code: "idempotency_key_reused" }) && plain(again) === plain({ value: { turn: 1, steered: false } }) && userItems(end).length === 1 && end.summary.turns === 1,
			`answers ${plain(other)} and ${plain(again)}; ${shape(end)}`,
		);
	}

	{
		// A user of its own, so that its running agents are the only ones counted.
		const other = await signIn();
		const theirs = client.user.getOrCreate([other.profile.uid], { params: { token: other.token } });
		const sessions: Array<ReturnType<typeof sessionOf>> = [];
		for (let index = 0; index <= RUNNING_CEILING; index += 1) sessions.push(sessionOf((await theirs.createSession({ profile: PROFILE })).id, other));
		for (const session of sessions.slice(0, RUNNING_CEILING)) await session.prompt({ text: LONG });
		const last = sessions[RUNNING_CEILING]!;
		const retried = randomUUID();
		const refused = await outcome(last.prompt({ text: "Explore the workspace", idempotencyKey: retried }));
		const nothing = await last.snapshot();
		await sessions[0]!.stop();
		await idle(sessions[0]!, 1);
		const taken = await outcome(last.prompt({ text: "Explore the workspace", idempotencyKey: retried }));
		const once = await outcome(last.prompt({ text: "Explore the workspace", idempotencyKey: retried }));
		const after = await idle(last, 1);
		expect(
			"a first attempt that was refused by a limit leaves its key unused: the same key is a new try, and from then on a repeat",
			plain(refused) === plain({ code: "too_many_running" }) && nothing.timeline.length === 0 && plain(taken) === plain({ value: { turn: 1, steered: false } }) && plain(once) === plain(taken) && userItems(after).length === 1 && after.summary.turns === 1,
			`answers ${plain(refused)}, ${plain(taken)}, ${plain(once)}; ${shape(after)}`,
		);
		for (const session of sessions.slice(1, RUNNING_CEILING)) await session.stop().catch(() => undefined);
	}

	{
		// The fake layer fails here as a sandbox that cannot be made fails a real turn: after the turn was accepted.
		const session = sessionOf((await create()).id);
		const failing = randomUUID();
		const first = await outcome(session.prompt({ text: "Explore the workspace (throw)", idempotencyKey: failing }));
		const ended = await idle(session, 1);
		const again = await outcome(session.prompt({ text: "Explore the workspace (throw)", idempotencyKey: failing }));
		await sleep(300);
		const after = await session.snapshot();
		const last = ended.timeline.at(-1);
		expect(
			"a turn that was accepted and then could not be run has used its key: the repeat is answered as before and starts nothing",
			plain(first) === plain({ value: { turn: 1, steered: false } }) && last?.kind === "turn.ended" && last.outcome === "error" && plain(again) === plain(first) && userItems(after).length === 1 && after.summary.turns === 1,
			`answers ${plain(first)} and ${plain(again)}; the turn ended as ${last?.kind === "turn.ended" ? last.outcome : "?"}; ${shape(after)}`,
		);
	}

	// --- an actor's sleep -------------------------------------------------------------------------

	{
		const before = await kept.snapshot();
		await forceSleep("agentSession", before.summary.id);
		await sleep(2_500);
		const answer = await outcome(kept.prompt({ text: LONG, idempotencyKey: key }));
		const after = await kept.snapshot();
		expect(
			"a key outlives its actor's sleep: the prompt again is answered as before and adds nothing",
			plain(answer) === plain({ value: { turn: 1, steered: false } }) && plain(after.timeline) === plain(before.timeline) && after.summary.turns === 1,
			`answer ${plain(answer)}; ${shape(after)}`,
		);
	}

	// --- how many keys a session remembers ----------------------------------------------------------

	{
		const session = sessionOf((await create()).id);
		const keys = Array.from({ length: MAX_REMEMBERED_SUBMISSIONS + 1 }, () => randomUUID());
		await session.prompt({ text: LONG, idempotencyKey: keys[0] });
		await running(session);
		for (const [index, steer] of keys.slice(1).entries()) await session.prompt({ text: `Note ${index + 1}`, idempotencyKey: steer });
		const before = userItems(await session.snapshot()).length;
		// The newest are remembered: each again is answered as before. The one before them is forgotten, and comes as a new message.
		const newest = await outcome(session.prompt({ text: `Note ${MAX_REMEMBERED_SUBMISSIONS}`, idempotencyKey: keys[MAX_REMEMBERED_SUBMISSIONS] }));
		const oldestKept = await outcome(session.prompt({ text: "Note 1", idempotencyKey: keys[1] }));
		const between = userItems(await session.snapshot()).length;
		const forgotten = await outcome(session.prompt({ text: LONG, idempotencyKey: keys[0] }));
		const after = await session.snapshot();
		expect(
			`a session remembers the keys of its newest ${MAX_REMEMBERED_SUBMISSIONS} messages: an older key is forgotten, and a prompt with it is a new message`,
			before === MAX_REMEMBERED_SUBMISSIONS + 1 && plain(newest) === plain({ value: { turn: 1, steered: true } }) && plain(oldestKept) === plain(newest) && between === before && plain(forgotten) === plain({ value: { turn: 1, steered: true } }) && userItems(after).length === before + 1,
			`${before} messages with a key each; the newest and the oldest of the last ${MAX_REMEMBERED_SUBMISSIONS} again: ${plain(newest)}, ${plain(oldestKept)}, ${between - before} added; the first one's key again: ${plain(forgotten)}, ${userItems(after).length - between} added`,
		);
		await session.stop().catch(() => undefined);
		await idle(session, 1);
	}

	// --- a server that is killed ----------------------------------------------------------------------

	{
		// A message steered into a turn is stored with its key when it is taken, not when the turn next writes the session.
		const session = sessionOf((await create()).id);
		const started = randomUUID();
		const steered = randomUUID();
		await session.prompt({ text: LONG, idempotencyKey: started });
		await running(session);
		const first = await outcome(session.prompt({ text: "Also say how long it took", idempotencyKey: steered }));
		await sleep(400);
		await stopServer("SIGKILL");
		await startServer();
		const cut = await idle(session, 1);
		const again = [await outcome(session.prompt({ text: "Also say how long it took", idempotencyKey: steered })), await outcome(session.prompt({ text: LONG, idempotencyKey: started }))];
		await sleep(300);
		const after = await session.snapshot();
		const last = cut.timeline.at(-1);
		expect(
			"the keys of a turn's messages outlive a server that is killed under the turn: each again is answered as before, and nothing is started",
			plain(first) === plain({ value: { turn: 1, steered: true } }) && plain(again[0]) === plain(first) && plain(again[1]) === plain({ value: { turn: 1, steered: false } }) && userItems(after).length === 2 && after.summary.turns === 1 && after.timeline.length === cut.timeline.length,
			`before the kill ${plain(first)}; after it ${plain(again[0])} and ${plain(again[1])}; the turn ended as ${last?.kind === "turn.ended" ? last.outcome : "?"}; ${shape(after)}`,
		);
	}

	// --- one call, sent twice by RivetKit ---------------------------------------------------------

	{
		/** One call of the client's whose first answer is lost: what the caller got, and how often RivetKit sent it. */
		const lost = async <T,>(action: string, call: () => Promise<T>): Promise<{ answer: { value: T } | { code: string }; deliveries: number }> => {
			sent.delete(action);
			lose = action;
			const answer = await outcome(call());
			return { answer, deliveries: sent.get(action) ?? 0 };
		};

		const plainSession = sessionOf((await create()).id);
		const unkeyed = await lost("prompt", () => plainSession.prompt({ text: LONG }));
		const plainAfter = await idle(plainSession, 1);
		// What the second delivery finds depends on how far the first has come: a turn still starting refuses it, a running one takes it as a second message.
		const mended = "code" in unkeyed.answer ? unkeyed.answer.code === "steer_unavailable" : unkeyed.answer.value.steered === true;
		expect(
			"without a key, one prompt that RivetKit sends twice is answered as the second delivery fared: a refusal for a prompt that was taken, or a second message",
			unkeyed.deliveries === 2 && mended && plainAfter.summary.turns === 1,
			`${unkeyed.deliveries} deliveries of one call; answer ${plain(unkeyed.answer)}; ${shape(plainAfter)}`,
		);

		const keyedSession = sessionOf((await create()).id);
		const keyed = await lost("prompt", () => keyedSession.prompt({ text: LONG, idempotencyKey: randomUUID() }));
		const keyedAfter = await idle(keyedSession, 1);
		expect(
			"with a key, one prompt that RivetKit sends twice is one message, answered as the first delivery was",
			keyed.deliveries === 2 && plain(keyed.answer) === plain({ value: { turn: 1, steered: false } }) && userItems(keyedAfter).length === 1 && keyedAfter.summary.turns === 1,
			`${keyed.deliveries} deliveries of one call; answer ${plain(keyed.answer)}; ${shape(keyedAfter)}`,
		);

		const before = (await user.listSessions()).length;
		const twice = await lost("createSession", () => create({ title: "Sent once" }));
		const made = (await user.listSessions()).length - before;
		expect("without a key, one createSession that RivetKit sends twice makes two agents", twice.deliveries === 2 && made === 2, `${twice.deliveries} deliveries of one call; ${made} agent(s) made`);
		const once = await lost("createSession", () => create({ title: "Sent once", idempotencyKey: randomUUID() }));
		const kept = (await user.listSessions()).length - before - made;
		expect("with a key, one createSession that RivetKit sends twice makes one agent", once.deliveries === 2 && kept === 1 && "value" in once.answer, `${once.deliveries} deliveries of one call; ${kept} agent(s) made`);
	}

	// --- createSession ----------------------------------------------------------------------------

	{
		const before = (await user.listSessions()).length;
		const made = randomUUID();
		const first = await outcome(create({ title: "Once", idempotencyKey: made }));
		const second = await outcome(create({ title: "Once", idempotencyKey: made }));
		const count = (await user.listSessions()).length;
		expect(
			"with one key, createSession again answers with the agent the first attempt made",
			"value" in first && "value" in second && first.value.id === second.value.id && count === before + 1,
			`${"value" in first ? first.value.id : plain(first)} and ${"value" in second ? second.value.id : plain(second)}; ${count - before} agent(s) made`,
		);
		const both = randomUUID();
		const together = await Promise.all([outcome(create({ title: "Together", idempotencyKey: both })), outcome(create({ title: "Together", idempotencyKey: both })), outcome(create({ title: "Together", idempotencyKey: both }))]);
		const ids = new Set(together.map((answer) => ("value" in answer ? answer.value.id : plain(answer))));
		expect("three attempts of one createSession at the same moment make one agent", ids.size === 1 && (await user.listSessions()).length === count + 1, `${[...ids].join(", ")}; ${(await user.listSessions()).length - count} agent(s) made`);
		const other = await outcome(create({ title: "Another", idempotencyKey: made }));
		const bad = [plain(await outcome(create({ idempotencyKey: "" }))), plain(await outcome(create({ idempotencyKey: "k".repeat(256) }))), plain(await outcome(create({ idempotencyKey: 7 })))];
		expect(
			"createSession refuses a key that comes with another agent, and a key that is none",
			plain(other) === plain({ code: "idempotency_key_reused" }) && bad.every((answer) => answer === plain({ code: "bad_idempotency_key" })) && (await user.listSessions()).length === count + 1,
			`answers ${plain(other)}, ${bad.join(", ")}`,
		);
		const retried = randomUUID();
		const refused = await outcome(create({ profile: "nope", idempotencyKey: retried }));
		const taken = await outcome(create({ idempotencyKey: retried }));
		expect("a createSession that was refused leaves its key unused", plain(refused) === plain({ code: "bad_profile" }) && "value" in taken, `answers ${plain(refused)} and ${"value" in taken ? taken.value.id : plain(taken)}`);
		// The key is the user's actor's to keep: it outlives that actor's sleep, and goes with the agent it made.
		await forceSleep("user", uid);
		await sleep(2_500);
		const woken = await outcome(create({ title: "Once", idempotencyKey: made }));
		expect("a createSession's key outlives the user's actor's sleep", "value" in woken && "value" in first && woken.value.id === first.value.id, "value" in woken ? woken.value.id : plain(woken));
		if ("value" in first) await user.deleteSession(first.value.id);
		const anew = await outcome(create({ title: "Once", idempotencyKey: made }));
		expect("once its agent is deleted a createSession's key is forgotten: the same key makes a new agent", "value" in anew && "value" in first && anew.value.id !== first.value.id, "value" in anew ? anew.value.id : plain(anew));
	}

	const unhandled = output.split("\n").filter((line) => line.includes("unhandled promise rejection"));
	expect("no unhandled promise rejections in the server", unhandled.length === 0, unhandled[0] ?? "");
	expect("no key is in the server's output", !output.includes(key));
}

try {
	await startServer();
	await main();
} catch (error) {
	failed += 1;
	console.log(`FAIL  the run stopped early\n      ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
	await stopServer().catch(() => undefined);
	if (failed === 0 && process.env.WLP_CHECK_KEEP !== "1") rmSync(storage, { recursive: true, force: true });
	else console.log(`\nthe server's state is kept in ${storage}`);
}
console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
