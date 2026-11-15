/**
 * The question about a project's MCP server, against a real Windlass. Run with:
 *
 *   cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/mcp-check.ts
 *
 * It makes sandboxes on local Docker, puts the small repository of fixtures/mcp-repo into their
 * workspaces (a `.windlass/config.json` that names the server "harbor", and the server itself, which
 * needs nothing but the image's Python), and runs real turns through the sandbox layer with a scripted
 * model (WINDLASS_ACP_SCRIPT): the engine, its configuration, its approvals and the server's process
 * are Windlass's own, and no model is called. It shows
 *
 *   - that Windlass reports the server as waiting before the prompt goes, with its command and the
 *     file that defines it, and that nothing of the turn has run when the question is put;
 *   - that "not now" leaves it stopped and the model is told so when it tries the server;
 *   - that approving starts it, that the model's first request of that turn has its tools, and that
 *     the model calls one in that turn and in a later message, without being asked again;
 *   - that the server reaches what the platform's question says it reaches: the network and Windlass's
 *     data directory, where a command the agent runs in Windlass's sandbox reaches neither;
 *   - that a changed definition is asked about again;
 *   - that a definition which reads a variable that is not set is named in the question, and reported
 *     with Windlass's own sentence when it is approved all the same;
 *   - where an approval is remembered on Docker (the user's data volume, so the user's other sessions);
 *   - that a turn stopped under the question ends without having started;
 *   - and, with a stand-in for the engine, what the layer does with a server reported while the turn
 *     runs, beside a tool call's question, and with a definition that changes under its question.
 *
 * No sign-in is made or used, nothing is sent anywhere but the one connection the server's `reach`
 * tool tries (1.1.1.1:53, as sandbox-check.ts probes the network), and everything created here is
 * removed at the end. The file put into Windlass's data directory to stand for a turn's access token
 * holds the word "placeholder" and no token.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProfileId, WindlassEvent } from "../server/src/contract.js";
import type { RunTurnResult, ScriptedModel, TurnQuestion, TurnServerOutcome, TurnServerQuestion, Windlass } from "../server/src/sandbox/api.js";
import { DATA_DIR, IMAGE, LABEL_ARG, docker, randomId } from "../server/src/sandbox/docker.js";
import { createSandboxLayer } from "../server/src/sandbox/index.js";
import type { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { variablesRead } from "../server/src/sandbox/turn.js";
import { DockerWindlass } from "../server/src/sandbox/windlass.js";
import { serverApprovedNote, serverNotNowNote, serverQuestionWords } from "../server/src/server-question.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(root, "fixtures/mcp-repo");
const layer = createSandboxLayer({ signIns: "memory", tokenNetwork: "none" });
const run = randomId(3);
const uid = `mcp-${run}`;
const uidOther = `mcp-${run}-b`;
const created = new Set<string>();
let failures = 0;
let passes = 0;

function expect(name: string, ok: boolean, detail = ""): boolean {
	const text = detail.trim().replace(/\s*\n\s*/g, " | ");
	if (ok) passes += 1;
	else failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? `  ${ok ? `(${text})` : text}` : ok ? "" : "  condition not met"}`);
	return ok;
}
function info(text: string): void {
	console.log(`      ${text}`);
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		expect(`${name}: unexpected error`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}

// ---------------------------------------------------------------------------------------------
// Sandboxes, the fixture, and turns
// ---------------------------------------------------------------------------------------------

function fixtureFiles(directory = FIXTURE): Array<{ path: string; content: string }> {
	return readdirSync(directory).flatMap((name) => {
		const full = join(directory, name);
		return statSync(full).isDirectory() ? fixtureFiles(full) : [{ path: relative(FIXTURE, full), content: readFileSync(full, "utf8") }];
	});
}

/** A sandbox whose workspace holds the fixture repository. */
async function sandbox(user: string, profile: SandboxProfileId, sessionId: string): Promise<DockerSandboxHandle> {
	await layer.logins.ensureUserVolume(user);
	const id = await layer.sandboxes.create({ uid: user, sessionId, profile });
	created.add(id);
	const handle = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
	for (const file of fixtureFiles()) await handle.writeTextFile(`/workspace/${file.path}`, file.content);
	return handle;
}

/** Replaces the definition of "harbor" in the workspace's `.windlass/config.json`. */
async function define(handle: DockerSandboxHandle, definition: Record<string, unknown>): Promise<void> {
	await handle.writeTextFile("/workspace/.windlass/config.json", `${JSON.stringify({ mcp: { servers: { harbor: definition } } }, null, 2)}\n`);
}

type Item = Record<string, unknown>;
const call = (callId: string, name: string, input: Record<string, unknown>): Item[] => [
	{ type: "tool_call", callId, name, input },
	{ type: "finish", reason: "tool_calls" },
];
const mcp = (callId: string, tool: string, args: Record<string, unknown> = {}) => call(callId, "mcp_call", { server: "harbor", tool, arguments: args });
const say = (text: string): Item[] => [
	{ type: "text", text },
	{ type: "finish", reason: "stop" },
];
/** A scripted model: one list per model call, and spare answers for a call the script did not plan. */
const scripted = (...responses: Item[][]): ScriptedModel => ({ responses: [...responses, say("Nothing more to do."), say("Nothing more to do.")] });

interface Asked {
	question: TurnServerQuestion;
	/** How many events of the turn had arrived when the question was put, and whether Windlass had begun to work on the prompt. */
	eventsBefore: number;
	executionBegan: boolean;
}
interface TurnRun {
	result: RunTurnResult;
	events: WindlassEvent[];
	asked: Asked[];
	outcomes: Array<{ question: TurnServerQuestion; outcome: TurnServerOutcome }>;
	toolQuestions: TurnQuestion[];
}
interface TurnOptions {
	windlassSessionId?: string;
	/** The answer to a server's question; without it nobody can be asked about servers. */
	server?: (question: TurnServerQuestion, signal: AbortSignal) => boolean | Promise<boolean>;
	/** The answer to a tool call's question. Default "once". */
	tool?: (question: TurnQuestion) => string | Promise<string>;
	signal?: AbortSignal;
	windlass?: Windlass;
	/** Filled with the outcomes as they arrive, for an answer that has to wait for one. */
	outcomes?: TurnRun["outcomes"];
}

async function turn(handle: DockerSandboxHandle, prompt: string, script: ScriptedModel, options: TurnOptions = {}): Promise<TurnRun> {
	const events: WindlassEvent[] = [];
	const asked: Asked[] = [];
	const outcomes: TurnRun["outcomes"] = options.outcomes ?? [];
	const toolQuestions: TurnQuestion[] = [];
	const answerServer = options.server;
	const result = await (options.windlass ?? layer.windlass).runTurn(handle, {
		prompt,
		script,
		windlassSessionId: options.windlassSessionId,
		signal: options.signal,
		onEvent: (event) => events.push(event),
		onQuestion: async (question) => {
			toolQuestions.push(question);
			return { choice: options.tool ? await options.tool(question) : "once" };
		},
		onServerQuestion:
			answerServer === undefined
				? undefined
				: async (question, signal) => {
						asked.push({ question, eventsBefore: events.length, executionBegan: events.some((event) => event.type === "execution.started") });
						return answerServer(question, signal);
					},
		onServerApproved: (question, outcome) => outcomes.push({ question, outcome }),
	});
	return { result, events, asked, outcomes, toolQuestions };
}

const dataOf = (event: WindlassEvent | undefined) => (event?.data ?? {}) as Record<string, unknown>;
const settled = (found: TurnRun, callId: string) => found.events.find((event) => event.type === "tool.settled" && dataOf(event).callId === callId);
const outputOf = (found: TurnRun, callId: string) => String(dataOf(settled(found, callId)).output ?? "");
/** How Windlass itself says an MCP call ended: "result", "refused", ... (`display.mcp.outcome`). */
const mcpOutcome = (found: TurnRun, callId: string) => (dataOf(settled(found, callId)).display as { mcp?: { outcome?: string } } | undefined)?.mcp?.outcome ?? "none";
const outcomeOf = (found: TurnRun) => (found.result.summary as { outcome?: string } | null)?.outcome;
/** The list of tools Windlass appends for the model, when it did so before the turn's first model call. */
const toolsBeforeFirstStep = (found: TurnRun): string | null => {
	const firstStep = found.events.findIndex((event) => event.type === "step.started");
	const appended = found.events.findIndex((event) => event.type === "instruction.appended" && dataOf(event).source === "mcp");
	return appended >= 0 && firstStep >= 0 && appended < firstStep ? String(dataOf(found.events[appended]).text ?? "") : null;
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// A stand-in for the engine: a server reported while the turn runs
// ---------------------------------------------------------------------------------------------

/**
 * Speaks enough of the protocol for one turn. It says no server waits before the prompt. Once the
 * prompt has come it reports "harbor" as waiting (`_windlass/mcp_changed`) and, a moment later, asks
 * about a tool call (`session/request_permission`). The first approval finds nothing waiting, as when
 * the definition changed after the question was put, and names the definition that waits now; the
 * second starts the server, which says it runs with three tools. The turn ends when the call was
 * answered and the server runs.
 */
const STAND_IN = String.raw`
import { createInterface } from "node:readline";
const session = "ses_standin000000000000";
let seq = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const event = (type, data) => send({ method: "_windlass/event", params: { sessionId: session, event: { type, v: 1, data, seq: ++seq, time: Date.now(), sessionId: session } } });
const argv = (flag) => ["python3", "tools/harbor_mcp.py", flag];
const server = (state, flag, extra = {}) => ({ name: "harbor", state, transport: "stdio", target: argv(flag).join(" "), argv: argv(flag), tools: null, hiddenTools: 0, error: null, retryInMs: null, origin: "project", file: "/workspace/.windlass/config.json", question: null, ...extra });
const waiting = (fingerprint, flag) => server("awaiting_approval", flag, { question: { fingerprint, subject: argv(flag).join(" "), details: [] } });
const changed = (servers) => send({ method: "_windlass/mcp_changed", params: { sessionId: session, available: true, servers } });
let prompt = null;
let approvals = 0;
let answered = false;
let running = false;
const finish = () => {
  if (!answered || !running || prompt === null) return;
  event("step.ended", { messageId: "m1", usage: null });
  event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } });
  send({ id: prompt, result: { stopReason: "end_turn", _meta: { windlass: { executionId: "exe_1", outcome: "succeeded" } } } });
  prompt = null;
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { windlass: { notifications: ["_windlass/event", "_windlass/mcp_changed"] } } } } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: session } });
  else if (message.method === "_windlass/mcp") send({ id: message.id, result: { sessionId: session, available: true, servers: [] } });
  else if (message.method === "session/prompt") {
    prompt = message.id;
    event("execution.started", { executionId: "exe_1" });
    event("step.started", { messageId: "m1", attempt: 1, model: "stand-in" });
    changed([waiting("aaaaaaaaaaaaaaaa", "--old")]);
    const question = { title: "Allow network access for this command?", subject: "curl -sI https://example.com", details: [], choices: [{ id: "once", label: "Allow once", approve: true, remembers: null }, { id: "deny", label: "Decline", approve: false, remembers: null }] };
    setTimeout(() => send({ id: "ask-1", method: "session/request_permission", params: { sessionId: session, toolCall: { toolCallId: "m1/c1" }, options: [], _meta: { windlass: { approval: { messageId: "m1", callId: "c1", question } } } } }), 300);
  } else if (message.method === "_windlass/mcp_approve") {
    approvals += 1;
    if (approvals === 1) send({ id: message.id, result: { approved: false, servers: [waiting("bbbbbbbbbbbbbbbb", "--new")] } });
    else {
      changed([server("starting", "--new")]);
      send({ id: message.id, result: { approved: true, servers: [server("starting", "--new")] } });
      setTimeout(() => {
        changed([server("running", "--new", { tools: 3 })]);
        running = true;
        finish();
      }, 400);
    }
  } else if (message.id === "ask-1" && message.method === undefined) {
    answered = true;
    finish();
  } else if (message.method === "session/close") send({ id: message.id, result: {} });
  else if (message.id !== undefined && message.method !== undefined) send({ id: message.id, error: { code: -32601, message: "method not found: " + message.method } });
}).on("close", () => process.exit(0));
`;

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const image = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
	if (image.code !== 0) {
		console.log(`The sandbox image ${IMAGE} is missing. Build it: sandbox/build.sh`);
		process.exitCode = 1;
		return;
	}
	info(`Windlass in the image: ${(await layer.windlass.version()) ?? "unknown"}; run ${run}`);

	await section("what the layer reads of a definition", async () => {
		const file = JSON.stringify({ mcp: { servers: { harbor: { command: "x", env: { A: "${ONE}-${TWO}", B: "${ONE}", C: 7 }, headers: { Authorization: "Bearer ${THREE}" } }, other: { command: "y", env: { D: "${FOUR}" } } } } });
		expect("the variables a definition reads are its own `${NAME}`s, each once, in order", JSON.stringify(variablesRead(file, "harbor")) === JSON.stringify(["ONE", "TWO", "THREE"]), JSON.stringify(variablesRead(file, "harbor")));
		expect("a file that is not what Windlass reads gives none", [variablesRead("not json", "harbor"), variablesRead("[]", "harbor"), variablesRead(file, "absent"), variablesRead('{"mcp":{"servers":{"harbor":"x"}}}', "harbor")].every((names) => names.length === 0));
	});

	let sessionId: string | undefined;
	let approvedPrint = "";
	const strict = layer.sandboxes.profile("docker-windlass-sandbox");
	const context = { profile: strict, demo: true, dataInSandbox: layer.sandboxes.sessionsLiveInSandbox };

	await section("docker-windlass-sandbox: the question, and both answers", async () => {
		const handle = await sandbox(uid, "docker-windlass-sandbox", "mcp-strict");

		// Nobody can be asked: the layer asks Windlass nothing, and the server stays stopped.
		const unasked = await turn(handle, "Which berth is free for Ada?", scripted(mcp("u1", "berth", { ship: "Ada" }), say("The server waits for you.")));
		sessionId = unasked.result.windlassSessionId ?? undefined;
		expect("without anyone to ask, the server stays stopped and the model is told it waits", outcomeOf(unasked) === "succeeded" && unasked.asked.length === 0 && mcpOutcome(unasked, "u1") === "refused", outputOf(unasked, "u1"));

		// "Not now".
		const declined = await turn(handle, "Which berth is free for Ada?", scripted(mcp("d1", "berth", { ship: "Ada" }), say("The server waits for you.")), { windlassSessionId: sessionId, server: () => false });
		const first = declined.asked[0];
		expect("Windlass reports the server as waiting, and the question is put once", declined.asked.length === 1 && first !== undefined, `${declined.asked.length} question(s)`);
		if (first === undefined) return;
		expect(
			"the question has the command, each argument its own, and the file that defines it",
			first.question.name === "harbor" && JSON.stringify(first.question.argv) === JSON.stringify(["python3", "tools/harbor_mcp.py"]) && first.question.url === null && first.question.file === "/workspace/.windlass/config.json" && /^[0-9a-f]{16}$/.test(first.question.fingerprint),
			JSON.stringify(first.question),
		);
		expect("it is put before the prompt goes: Windlass has not begun the turn, and the turn waits for the answer", first.question.holdsTurn === true && !first.executionBegan, `${first.eventsBefore} event(s) before it, none of an execution`);
		expect("no variable is reported for a definition that reads none", first.question.unset.length === 0);
		const words = serverQuestionWords(first.question, context);
		info(`the question as a demo session on this profile reads it: ${words.title}`);
		info(`  ${words.subject}`);
		for (const detail of words.details) info(`  ${detail}`);
		expect('"not now" leaves it stopped: Windlass refuses the call and tells the model the server waits for the user', outcomeOf(declined) === "succeeded" && declined.outcomes.length === 0 && mcpOutcome(declined, "d1") === "refused", outputOf(declined, "d1"));
		expect("the model's first request has no tools of the server", toolsBeforeFirstStep(declined) === null);
		info(`the timeline's line: ${serverNotNowNote(first.question)}`);

		// Approved: asked again by the next turn, started, and callable in that turn.
		const approved = await turn(handle, "Which berth is free for Ada?", scripted(mcp("a1", "berth", { ship: "Ada" }), say("Berth 4.")), { windlassSessionId: sessionId, server: () => true });
		const again = approved.asked[0];
		expect("a server left stopped is asked about again by the next turn, as the same definition", approved.asked.length === 1 && again?.question.fingerprint === first.question.fingerprint, `fingerprint ${again?.question.fingerprint}`);
		const outcome = approved.outcomes[0]?.outcome;
		expect("approving starts it through Windlass: it runs, with its two tools", approved.outcomes.length === 1 && outcome?.state === "running" && outcome.tools === 2, JSON.stringify(outcome));
		if (again && outcome) info(`the timeline's line: ${serverApprovedNote(again.question, outcome).text}`);
		const told = toolsBeforeFirstStep(approved);
		expect("the model's first request of that turn has the server's tools", told !== null && told.includes("harbor (2 tools)") && told.includes("- berth:"), told?.split("\n").slice(-4, -1).join(" | ") ?? "no list of tools before the first model call");
		expect("the model calls a tool of the server in that turn", outcomeOf(approved) === "succeeded" && mcpOutcome(approved, "a1") === "result" && outputOf(approved, "a1").includes("Berth 4 is free for Ada."), outputOf(approved, "a1").split("\n").at(-1));
		expect("in this profile Windlass asks before each call of an MCP tool, through the question the platform already puts", approved.toolQuestions.length === 1 && approved.toolQuestions[0]?.title === "Allow the MCP tool harbor/berth?", approved.toolQuestions[0]?.title);
		approvedPrint = first.question.fingerprint;

		// A later message: not asked again, and the tool is there.
		await handle.run(`printf placeholder > ${DATA_DIR}/access-token-mcp-check.json`);
		const later = await turn(
			handle,
			"And what can the server reach?",
			scripted(mcp("l1", "reach"), call("l2", "shell", { command: `if timeout 4 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null; then echo NET_OK; else echo NET_BLOCKED; fi; ls ${DATA_DIR} >/dev/null 2>&1 && echo DATA_READABLE || echo DATA_HIDDEN` }), say("Done.")),
			{ windlassSessionId: sessionId, server: () => true },
		);
		expect("a later message does not ask again: Windlass remembers the approval", later.asked.length === 0 && later.outcomes.length === 0);
		expect("and the model calls the server's tool in it", outcomeOf(later) === "succeeded" && mcpOutcome(later, "l1") === "result", outputOf(later, "l1").split("\n").slice(1).join(" | "));
		const reach = outputOf(later, "l1");
		const command = outputOf(later, "l2");
		expect(
			"the server uses the network and reads Windlass's data directory, where a turn's access token file is",
			reach.includes("network: reachable") && reach.includes("data directory: readable") && reach.includes("access token file: present"),
			reach.split("\n").slice(1, 4).join(" | "),
		);
		expect("a command the agent runs in the same turn has no network and cannot see that directory", command.includes("NET_BLOCKED") && command.includes("DATA_HIDDEN"), command.trim().split("\n").join(" | "));
		await handle.run(`rm -f ${DATA_DIR}/access-token-mcp-check.json`);
	});

	await section("docker-windlass-sandbox: a changed definition, and a variable that is not set", async () => {
		const handle = (await layer.sandboxes.connect([...created][0] ?? "")) as DockerSandboxHandle;

		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py", "--berths", "12 or more"] });
		const changed = await turn(handle, "Which berth is free for Bea?", scripted(mcp("c1", "berth", { ship: "Bea" }), say("Berth 4.")), { windlassSessionId: sessionId, server: () => true });
		const asked = changed.asked[0]?.question;
		expect(
			"a changed definition is asked about again, with the new command",
			changed.asked.length === 1 && asked !== undefined && asked.fingerprint !== approvedPrint && JSON.stringify(asked.argv) === JSON.stringify(["python3", "tools/harbor_mcp.py", "--berths", "12 or more"]),
			asked ? `${serverQuestionWords(asked, context).subject} (fingerprint ${asked.fingerprint}, before ${approvedPrint})` : "no question",
		);
		expect("and starts once approved", changed.outcomes[0]?.outcome.state === "running" && mcpOutcome(changed, "c1") === "result", JSON.stringify(changed.outcomes[0]?.outcome));

		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py"], env: { HARBOR_NOTE: "${HARBOR_TOKEN}" } });
		const unset = await turn(handle, "Which berth is free for Cy?", scripted(mcp("e1", "berth", { ship: "Cy" }), say("The server did not start.")), { windlassSessionId: sessionId, server: () => true });
		const needs = unset.asked[0]?.question;
		expect("a definition that reads a variable which is not set says which, before the answer", unset.asked.length === 1 && JSON.stringify(needs?.unset) === JSON.stringify(["HARBOR_TOKEN"]), needs ? (serverQuestionWords(needs, context).details.at(-1) ?? "") : "no question");
		const failed = unset.outcomes[0]?.outcome;
		expect("approved all the same, it does not start, and Windlass says why", failed?.state === "failed" && failed.reason.includes("HARBOR_TOKEN"), failed?.state === "failed" ? failed.reason : JSON.stringify(failed));
		if (needs && failed) info(`the timeline's line: ${serverApprovedNote(needs, failed).text}`);
		expect("the model is told the server is not running, and the turn goes on", outcomeOf(unset) === "succeeded" && mcpOutcome(unset, "e1") === "refused", outputOf(unset, "e1"));

		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py"], env: { HARBOR_NOTE: "${HOME}" } });
		const set = await turn(handle, "And what can the server reach?", scripted(mcp("s1", "reach"), say("Done.")), { windlassSessionId: sessionId, server: () => true });
		expect(
			"a variable that is set in the sandbox is not reported, and the server starts with its value",
			set.asked.length === 1 && set.asked[0]?.question.unset.length === 0 && set.outcomes[0]?.outcome.state === "running" && outputOf(set, "s1").includes("HARBOR_NOTE: /home/agent"),
			outputOf(set, "s1").split("\n").at(-1),
		);
	});

	await section("where an approval is remembered on Docker", async () => {
		const first = (await layer.sandboxes.connect([...created][0] ?? "")) as DockerSandboxHandle;
		const kept = await first.run(`grep -l 'mcp-server:harbor:${approvedPrint}' ${DATA_DIR}/approvals/*.json | wc -l; grep -h '"workspace"' ${DATA_DIR}/approvals/*.json | sort -u`);
		expect("Windlass keeps it in its data directory, for the project directory /workspace and that definition", kept.stdout.trim().startsWith("1") && kept.stdout.includes('"/workspace"'), kept.stdout.trim().split("\n").join(" | "));
		const mounts = await docker(["container", "inspect", "--format", "{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}", first.container]);
		expect("which on Docker is the user's volume, not the session's container", mounts.stdout.trim() === `wlp-user-${uid}:${DATA_DIR}`, mounts.stdout.trim());

		const second = await sandbox(uid, "docker-windlass-sandbox", "mcp-second");
		const same = await turn(second, "Which berth is free for Dee?", scripted(mcp("o1", "berth", { ship: "Dee" }), say("Berth 4.")), { server: () => false });
		expect("so another session of the same user, with the same definition, is not asked and has the server", same.asked.length === 0 && mcpOutcome(same, "o1") === "result", outputOf(same, "o1").split("\n").at(-1));

		const stranger = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-other-user");
		const other = await turn(stranger, "Which berth is free for Eli?", scripted(mcp("x1", "berth", { ship: "Eli" }), say("The server waits for you.")), { server: () => false });
		expect("and another user's session is asked", other.asked.length === 1 && mcpOutcome(other, "x1") === "refused");
	});

	await section("docker-hardened: the same question where commands are not sandboxed", async () => {
		const handle = await sandbox(uidOther, "docker-hardened", "mcp-hardened");
		const found = await turn(
			handle,
			"What can the server reach?",
			scripted(mcp("h1", "reach"), call("h2", "shell", { command: `if timeout 4 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null; then echo NET_OK; else echo NET_BLOCKED; fi; ls ${DATA_DIR} >/dev/null 2>&1 && echo DATA_READABLE || echo DATA_HIDDEN` }), say("Done.")),
			{ server: () => true },
		);
		const asked = found.asked[0]?.question;
		expect("the question is put before the prompt here too, and approving starts the server", found.asked.length === 1 && asked?.holdsTurn === true && found.outcomes[0]?.outcome.state === "running", JSON.stringify(found.outcomes[0]?.outcome));
		if (asked) for (const detail of serverQuestionWords(asked, { profile: layer.sandboxes.profile("docker-hardened"), demo: true, dataInSandbox: false }).details) info(`  ${detail}`);
		expect("Windlass runs the first MCP call without asking in this profile", found.toolQuestions.every((question) => question.callId !== "h1") && mcpOutcome(found, "h1") === "result");
		// What the server returned is content Windlass does not control: from there on it asks before a command it cannot sandbox, in this profile too.
		const afterwards = found.toolQuestions.find((question) => question.callId === "h2");
		expect("and asks before the command that follows the server's answer, which it does not trust", found.toolQuestions.length === 1 && afterwards !== undefined, afterwards ? `${afterwards.title} ${afterwards.details.join(" ")}` : `${found.toolQuestions.length} question(s)`);
		const reach = outputOf(found, "h1");
		const command = outputOf(found, "h2");
		expect("the server and the agent's commands reach the same here: the network and the data directory", reach.includes("network: reachable") && reach.includes("data directory: readable") && command.includes("NET_OK") && command.includes("DATA_READABLE"), `${reach.split("\n").slice(1, 3).join(" | ")}; command: ${command.trim().split("\n").join(" | ")}`);
	});

	await section("a turn stopped under the question", async () => {
		const handle = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-stopped");
		await define(handle, { command: "python3", args: ["tools/harbor_mcp.py", "--stopped"] });
		const controller = new AbortController();
		let withdrawn = false;
		const stopped = await turn(handle, "Which berth is free?", scripted(say("Never said.")), {
			signal: controller.signal,
			server: (_question, signal) =>
				new Promise<boolean>(() => {
					signal.addEventListener("abort", () => (withdrawn = true), { once: true });
					setTimeout(() => controller.abort(), 300);
				}),
		});
		expect(
			"stopping the turn withdraws the question, and the turn ends without Windlass having begun it",
			stopped.asked.length === 1 && withdrawn && stopped.result.aborted && stopped.result.failure === null && !stopped.events.some((event) => event.type === "execution.started") && stopped.outcomes.length === 0,
			`aborted ${stopped.result.aborted}, ${stopped.events.length} event(s), none of an execution`,
		);
		const leftovers = await handle.run("wlp-run tags-of windlass | wc -l");
		expect("and no Windlass is left running in the sandbox", leftovers.stdout.trim() === "0", leftovers.stdout.trim());
	});

	await section("a server reported while the turn runs (a stand-in for the engine)", async () => {
		const handle = await sandbox(uidOther, "docker-windlass-sandbox", "mcp-stand-in");
		await handle.writeTextFile("/tmp/mcp-stand-in.mjs", STAND_IN);
		const windlass = new DockerWindlass(layer.tokens, { engineCommand: ["node", "/tmp/mcp-stand-in.mjs"] });
		let toolAsked: () => void = () => {};
		const whenToolAsked = new Promise<void>((resolve) => (toolAsked = resolve));
		/** What was open when: "server:<fingerprint>" and "call". */
		const order: string[] = [];
		let bothOpen = false;
		let serverOpen = false;
		const outcomes: TurnRun["outcomes"] = [];
		const found = await turn(handle, "x", scripted(say("unused")), {
			windlass,
			outcomes,
			server: async (question) => {
				order.push(`server:${question.fingerprint}`);
				serverOpen = true;
				// The first is answered only once the call's question is open as well.
				if (order.length === 1) await whenToolAsked;
				serverOpen = false;
				return true;
			},
			tool: async () => {
				order.push("call");
				bothOpen = serverOpen;
				toolAsked();
				// Answered after the server runs.
				for (let waited = 0; waited < 5000 && outcomes.length < 2; waited += 50) await wait(50);
				return "once";
			},
		});
		expect("the server's question is put while the turn runs and does not hold it", found.asked[0]?.question.holdsTurn === false && found.asked[0]?.executionBegan === true, JSON.stringify(found.asked[0]?.question));
		expect("a tool call's question arrives while it is open: the layer hands both over, for the session to put in order", bothOpen && order[0] === "server:aaaaaaaaaaaaaaaa" && order[1] === "call", order.join(", "));
		expect(
			"an approval that finds the definition changed starts nothing, and the new definition is asked about",
			found.outcomes[0]?.outcome.state === "changed" && order[2] === "server:bbbbbbbbbbbbbbbb" && JSON.stringify(found.asked[1]?.question.argv) === JSON.stringify(["python3", "tools/harbor_mcp.py", "--new"]),
			`${JSON.stringify(found.outcomes[0]?.outcome)}; then ${order[2]}`,
		);
		const ran = found.outcomes[1];
		expect("the second approval starts it, and what the server says of itself is reported", ran?.outcome.state === "running" && ran.outcome.tools === 3, JSON.stringify(ran?.outcome));
		if (ran) info(`the timeline's line: ${serverApprovedNote(ran.question, ran.outcome).text}`);
		expect("the turn ends as the engine said", outcomeOf(found) === "succeeded" && found.result.failure === null, `${outcomeOf(found)} ${found.result.failure?.message ?? ""}`);
	});

	await section("cleanup", async () => {
		for (const id of created) await layer.sandboxes.destroy(id);
		for (const user of [uid, uidOther]) await docker(["volume", "rm", "-f", `wlp-user-${user}`, `wlp-auth-${user}`]);
		const containers = await docker(["ps", "-a", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Names}}"]);
		const volumes = await docker(["volume", "ls", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Name}}"]);
		const mine = [...containers.stdout.split("\n"), ...volumes.stdout.split("\n")].filter((name) => name.includes(run) || [...created].some((id) => name === `wlp-session-${id}`));
		expect("nothing this run created is left", mine.length === 0, mine.join(", ") || "no containers or volumes of this run");
	});

	console.log(`\n${failures === 0 ? "ALL PASSED" : "FAILED"}: ${passes} passed, ${failures} failed`);
	if (failures > 0) process.exitCode = 1;
}

await main();
