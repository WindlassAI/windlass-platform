// cd server && npx tsx ../scripts/harness-check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { generatedSessionTitle, type AcpUpdate, type CreateItemInput } from "../server/src/contract.js";
import type { RunTurnInput, SandboxHandle, SandboxLayer } from "../server/src/sandbox/api.js";
import { markTurnSandbox, type ProcessEnd, type StartOptions } from "../server/src/sandbox/provider.js";
import { SecretRedactor } from "../server/src/repo-secrets.js";
import { modeSelection, optionsOf } from "../server/src/sandbox/acp-options.js";
import { FakeAcpAgent } from "./acp-agent-fake.js";

// Compile this consumer along with the server so changes to the wire contract cannot undo narrowing.
function typedField(update: AcpUpdate): string | undefined {
	if (update.sessionUpdate === "plan") return update.entries[0]?.content;
	if (update.sessionUpdate === "tool_call") return update.toolCallId;
	if (update.sessionUpdate === "current_mode_update") return update.currentModeId;
}
const itemHasHarness: "harness" extends keyof CreateItemInput ? true : false = true;
assert.equal(itemHasHarness, true);
assert.equal(typedField({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "low", status: "pending" }] }), "Read");

// ask_person (agent-publish.ts): which harness and which turn is offered it, how it is declared, and what a call comes to.
{
	const { ASK_AGAIN, ASK_LIMITS, ASK_NONE_LEFT, ASK_TAKEN, ASK_TOOL, askPerson, platformTools } = await import("../server/src/agent-publish.js");
	const { turnHostTools, hostToolsMeta } = await import("../server/src/sandbox/turn.js");
	const { capabilitiesOf } = await import("../server/src/sandbox/harness.js");
	assert.ok(capabilitiesOf("windlass").platformTools.includes(ASK_TOOL), "Windlass can be given ask_person");
	for (const acp of ["claude", "opencode"] as const) assert.equal(capabilitiesOf(acp).platformTools.length, 0, `${acp} is given no platform tool, ask_person neither`);
	const builder = platformTools({ publish: false, report: true, push: true, ask: true }, 60_000);
	const declared = builder.find(tool => tool.name === ASK_TOOL);
	assert.ok(declared && declared.effect === "read" && declared.untrustedResult === false && declared.timeoutSeconds === 30, "ask_person is declared read, its result trusted, 30 s");
	assert.ok(declared.description.split(". ")[0]!.length <= 160, "ask_person's first sentence fits Windlass's list");
	for (const [who, offer] of [["planner", { plan: true, publish: false, report: true, push: false, ask: true }], ["reviewer", { review: true, publish: false, report: false, push: false, ask: true }], ["a person's session", { publish: true, report: false, push: true, ask: true }], ["a builder without the flag", { publish: false, report: true, push: true }]] as const) {
		assert.ok(!platformTools(offer, 60_000).some(tool => tool.name === ASK_TOOL), `${who} is not offered ask_person`);
	}
	const call = () => "";
	assert.deepEqual([...turnHostTools({ onReport: call, onAsk: call, onPush: call, onFetchBase: call } as never).keys()], ["report", ASK_TOOL, "push", "fetch_base"]);
	assert.ok(hostToolsMeta(turnHostTools({ onReport: call, onAsk: call } as never)).hostTools.some(tool => tool.name === ASK_TOOL), "a builder's turn declares ask_person");
	for (const [who, input] of [["planner", { onPlan: call, onReport: call, onAsk: call }], ["reviewer", { onReview: call, onAsk: call }], ["no report", { onAsk: call, onPush: call, onFetchBase: call }], ["publish", { onPublish: call, onReport: call, onAsk: call }]] as const) {
		const tools = turnHostTools(input as never);
		assert.ok(!tools.has(ASK_TOOL) && !hostToolsMeta(tools).hostTools.some(tool => tool.name === ASK_TOOL), `${who}: ask_person is not mapped`);
	}

	const redactor = new SecretRedactor([{ name: "STORE_TOKEN", value: "s3cr3t-value-123" }]);
	const fresh = { already: false, left: 3 };
	const taken = askPerson({ question: "Use\u0000 the ‮right‬ store?​ With s3cr3t-value-123 in it.\n\n\n\nSay which.", options: ["SQLite", " SQLite ", "Post⁦gres"] }, fresh, redactor);
	assert.equal(taken.told, ASK_TAKEN);
	assert.ok(taken.asked && !/[\u0000‮‬​⁦]/.test(taken.asked.text + taken.asked.options.join("")), "NUL, bidi and zero-width characters are taken out");
	assert.ok(!taken.asked.text.includes("s3cr3t-value-123") && !taken.said.includes("s3cr3t-value-123"), "a saved secret is taken out");
	assert.equal(taken.asked.text.split("\n").filter(line => line === "").length, 1, "runs of blank lines are one");
	assert.deepEqual(taken.asked.options, ["SQLite", "Postgres"], "options are one line each, without repeats");
	// A secret split by an invisible character is still taken out, and hidden text never reaches an option.
	const split = askPerson({ question: "Is s3cr\u200b3t-value-123 the key? And s3cr\u{e0041}3t-value-123?", options: ["Postgres\u{e0049}\u{e0067}\u{e006e}", "My\u00adSQL\ufe0f"] }, fresh, redactor);
	assert.ok(split.asked && !split.asked.text.includes("s3cr3t-value-123"), "a split secret is redacted");
	assert.deepEqual(split.asked?.options, ["Postgres", "MySQL"], "tag characters, soft hyphens and variation selectors are stripped");
	assert.deepEqual(askPerson({ question: "Again?" }, { already: true, left: 3 }, redactor), { asked: null, told: ASK_AGAIN, said: "The agent asked a second question in one turn, and was told to end its turn." });
	assert.equal(askPerson({ question: "One more?" }, { already: false, left: 0 }, redactor).told, ASK_NONE_LEFT);
	assert.equal(askPerson({ question: "One more?" }, { already: false, left: 0 }, redactor).asked, null);
	const long = askPerson({ question: "x".repeat(ASK_LIMITS.questionChars + 1) }, fresh, redactor);
	assert.ok(long.asked === null && long.told.includes(`${ASK_LIMITS.questionChars + 1} characters long and the limit is ${ASK_LIMITS.questionChars}`), long.told);
	assert.ok(askPerson({ question: "x".repeat(ASK_LIMITS.questionChars) }, fresh, redactor).asked !== null, "a question at the limit is taken");
	for (const given of [{}, { question: 7 }, { question: " ‮ " }, { question: "Which?", options: "SQLite" }, { question: "Which?", options: ["a", "b", "c", "d", "e"] }, { question: "Which?", options: ["x".repeat(ASK_LIMITS.optionChars + 1)] }, { question: "Which?", options: [3] }]) {
		assert.equal(askPerson(given, fresh, redactor).asked, null, `refused: ${JSON.stringify(given)}`);
	}
	console.log("ok  ask_person: Windlass builders only, declared read, one per turn, three per run, cleaned and capped");
}

// Claude Code's task tools keep their list in the adapter's process, which lives one turn: a task finished
// in a later turn never reached the plan. Its TodoWrite list sends the whole list with every change.
const claudeWrapper = readFileSync(new URL("../sandbox/harness/claude/wlp-claude-acp", import.meta.url), "utf8");
assert.match(claudeWrapper, /^export CLAUDE_CODE_ENABLE_TASKS=false$/m, "wlp-claude-acp must keep Claude Code on its TodoWrite list");

const fixture = fileURLToPath(new URL("../fixtures/acp-agent/agent.mjs", import.meta.url));
const openParams = { cwd: "/workspace", mcpServers: [] };
const block = (text: string) => [{ type: "text", text }];
const ok = (name: string) => console.log(`ok  ${name}`);

const capture = new URL("../fixtures/opencode/handshake.jsonl", import.meta.url);
const [init, opened] = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line).result);
assert.equal(init.agentInfo.version, "1.19.6");
assert.equal(opened.modes, undefined);
const capturedModes = modeSelection(opened.modes, opened.configOptions);
assert.deepEqual(capturedModes.modes.map(m => m.id), ["build", "plan"]);
assert.equal(capturedModes.current, "build");
const catalog = optionsOf(opened.configOptions).list;
assert.ok(catalog && catalog.models.some(m => m.id === catalog.defaultModel && m.id.startsWith("openai/")));

class Client {
	private readonly lines: AsyncIterator<string>;
	private nextId = 1;
	constructor(input: Readable, private readonly write: (line: string) => void) {
		this.lines = createInterface({ input })[Symbol.asyncIterator]();
	}
	send(fields: object) { this.write(JSON.stringify({ jsonrpc: "2.0", ...fields }) + "\n"); }
	request(method: string, params: object) {
		const id = this.nextId++;
		this.send({ method, id, params });
		return id;
	}
	prompt(sessionId: string, text: string) {
		return this.request("session/prompt", { sessionId, prompt: block(text) });
	}
	async line() {
		let timer: NodeJS.Timeout | undefined;
		try {
			const next = await Promise.race([this.lines.next(), new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Timed out waiting for the next ACP line")), 5000);
			})]);
			assert(!next.done, "agent closed stdout before answering");
			return next.value as string;
		} finally {
			clearTimeout(timer);
		}
	}
	async frame() {
		const frame = JSON.parse(await this.line());
		assert.equal(frame.jsonrpc, "2.0");
		return frame;
	}
	async result(id: number) {
		const frame = await this.frame();
		assert.equal(frame.id, id, JSON.stringify(frame));
		assert(!frame.error, JSON.stringify(frame.error));
		assert(Object.hasOwn(frame, "result"));
		return frame.result;
	}
	async update(sessionId: string, kind: string) {
		const frame = await this.frame();
		assert.equal(frame.method, "session/update");
		assert.equal(frame.id, undefined);
		assert.equal(frame.params.sessionId, sessionId);
		assert.equal(frame.params.update.sessionUpdate, kind);
		return frame.params.update;
	}
	async chunk(sessionId: string, kind = "agent_message_chunk") {
		const { content } = await this.update(sessionId, kind);
		assert.equal(content.type, "text");
		assert(typeof content.text === "string" && content.text.length > 0);
		return content.text as string;
	}
	async ended(id: number, stopReason = "end_turn") {
		assert.deepEqual(await this.result(id), { stopReason });
	}
	async error(id: number, code: number, message: string) {
		assert.deepEqual(await this.frame(), { jsonrpc: "2.0", id, error: { code, message } });
	}
}

async function withProcess<T>(stateDir: string, run: (client: Client) => Promise<T>) {
	const child = spawn(process.execPath, [fixture], {
		env: { ...process.env, WLP_FAKE_ACP_STATE: stateDir }, stdio: ["pipe", "pipe", "inherit"],
	});
	const closed = once(child, "close");
	try {
		return await run(new Client(child.stdout, (line) => child.stdin.write(line)));
	} finally {
		child.kill("SIGKILL"); // This child PID only, including when an assertion or timeout fires.
		await closed;
	}
}

async function initialize(client: Client) {
	const result = await client.result(client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
	assert.deepEqual(result, {
		protocolVersion: 1,
		agentCapabilities: {
			loadSession: true, promptCapabilities: { image: true, embeddedContext: true },
			mcpCapabilities: { http: true, sse: true, acp: true },
			sessionCapabilities: { options: {}, resume: {}, close: {}, list: {}, fork: {}, additionalDirectories: {} },
		},
		_meta: { steering: { supported: true } },
		authMethods: [{ id: "claude-login", name: "Log in with Claude", description: "Run `claude /login` in the terminal", type: "terminal", args: ["--cli"] }],
	});
}

type Option = { id: string; category: string; type: string; currentValue: string; options: { value: string }[] };
function checkChoices(options: Option[], model: string, effort: string) {
	assert.deepEqual(options.map((o) => [o.id, o.category, o.type, o.currentValue]), [
		["model", "model", "select", model], ["effort", "thought_level", "select", effort],
	]);
	assert.deepEqual(options[0].options.map((o) => o.value), ["default", "sonnet", "opus"]);
	assert(options[1].options.some((o) => o.value === "high"));
}

async function configure(client: Client) {
	await initialize(client);
	const { sessionId, modes, configOptions } = await client.result(client.request("session/new", openParams));
	assert(typeof sessionId === "string" && sessionId);
	assert.equal(modes.currentModeId, "default");
	assert.deepEqual(modes.availableModes.map((m: { id: string }) => m.id), ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
	checkChoices(configOptions, "default", "default");
	const set = client.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
	assert.equal((await client.update(sessionId, "current_mode_update")).currentModeId, "bypassPermissions");
	assert.deepEqual(await client.result(set), {});
	for (const [configId, value] of [["model", "opus"], ["effort", "high"]]) {
		const result = await client.result(client.request("session/set_config_option", { sessionId, configId, value }));
		checkChoices(result.configOptions, "opus", configId === "effort" ? "high" : "default");
	}
	return sessionId;
}

async function ask(client: Client, sessionId: string) {
	const prompt = client.prompt(sessionId, "Please ask me.");
	const request = await client.frame();
	assert.equal(request.method, "session/request_permission");
	assert(request.id != null);
	const { toolCall, options } = request.params;
	assert.equal(request.params.sessionId, sessionId);
	assert(toolCall.toolCallId && toolCall.title);
	assert.deepEqual(options.map((o: { kind: string }) => o.kind), ["allow_once", "allow_always", "reject_once", "reject_always"]);
	assert(options.every((o: { optionId: string; name: string }) => o.optionId && o.name));
	return { prompt, id: request.id, options: options as { optionId: string; kind: string }[] };
}

async function checkPermissions(client: Client, sessionId: string) {
	const selected = await ask(client, sessionId);
	const optionId = selected.options.find((option) => option.kind === "allow_once")!.optionId;
	const allow = { outcome: { outcome: "selected", optionId } };
	client.send({ id: selected.id, result: allow });
	assert((await client.chunk(sessionId)).includes(optionId));
	await client.ended(selected.prompt);

	const withdrawn = await ask(client, sessionId);
	client.send({ id: withdrawn.id, result: { outcome: { outcome: "cancelled" } } });
	await client.ended(withdrawn.prompt, "cancelled");

	const stopped = await ask(client, sessionId);
	client.send({ method: "session/cancel", params: { sessionId } });
	await client.ended(stopped.prompt, "cancelled");
	const next = await ask(client, sessionId);
	assert.notEqual(next.id, stopped.id);
	client.send({ id: stopped.id, result: allow }); // Late answer from the stopped turn.
	const deny = next.options.find((option) => option.kind === "reject_once")!.optionId;
	client.send({ id: next.id, result: { outcome: { outcome: "selected", optionId: deny } } });
	assert((await client.chunk(sessionId)).includes(deny));
	await client.ended(next.prompt);
	ok("ask offers four choices, continues on selection, withdraws on cancellation and ignores a late answer");
}

async function checkScenarios(client: Client, sessionId: string) {
	const prompt = (word: string) => client.prompt(sessionId, word);
	const update = (kind: string) => client.update(sessionId, kind);
	const plain = prompt("Please run (plain).");
	for (let i = 0; i < 3; i++) await client.chunk(sessionId, "agent_thought_chunk");
	const info = await update("session_info_update");
	assert.equal(info.title, "Inspect the files");
	for (let i = 0; i < 5; i++) await client.chunk(sessionId);
	await client.ended(plain);
	ok("plain delivers three thoughts and five message chunks in order");

	assert.deepEqual({
		personal: generatedSessionTitle(info, {}),
		typed: generatedSessionTitle(info, { typed: true }),
		builder: generatedSessionTitle(info, { item: { role: "builder" } }),
		reviewer: generatedSessionTitle(info, { item: { role: "reviewer" } }),
	}, { personal: "Inspect the files", typed: undefined, builder: undefined, reviewer: undefined });
	ok("only an unnamed personal session adopts the fixture title");

	const tools = prompt("tools");
	const execute = await update("tool_call");
	assert(execute.toolCallId && execute.title);
	assert.equal(execute.kind, "execute");
	assert.equal(execute.status, "pending");
	const running = await update("tool_call_update");
	assert.equal(running.toolCallId, execute.toolCallId);
	assert.equal(running.status, "in_progress");
	assert.deepEqual(running.content, [{ type: "content", content: { type: "text", text: "/workspace" } }]);
	const completed = await update("tool_call_update");
	assert.equal(completed.toolCallId, execute.toolCallId);
	assert.equal(completed.status, "completed");
	const edit = await update("tool_call");
	assert(edit.toolCallId && edit.toolCallId !== execute.toolCallId);
	assert.equal(edit.kind, "edit");
	assert.deepEqual(edit.content, [{ type: "diff", path: "/workspace/README.md", oldText: "Draft", newText: "Ready" }]);
	const failed = await update("tool_call_update");
	assert.equal(failed.toolCallId, edit.toolCallId);
	assert.equal(failed.status, "failed");
	await client.chunk(sessionId);
	await client.ended(tools);
	ok("tools streams execute output, completes the command and reports a failed edit with a diff");

	await checkPermissions(client, sessionId);
	const plan = prompt("plan");
	let tasks: string[] | undefined;
	for (const statuses of [["in_progress", "pending", "pending"], ["completed", "in_progress", "pending"], ["completed", "completed", "in_progress"], ["completed", "completed", "completed"]]) {
		const { entries } = await update("plan");
		const names = entries.map((e: { content: string }) => e.content);
		assert.deepEqual(names, tasks ?? names);
		assert(names.every(Boolean) && new Set(names).size === 3);
		tasks = names;
		assert.deepEqual(entries.map((e: { status: string }) => e.status), statuses);
	}
	await client.ended(plan);
	ok("plan changes the status of the same three entries");
	const usage = prompt("usage");
	assert.deepEqual(await update("usage_update"), { sessionUpdate: "usage_update", used: 41000, size: 200000, cost: { amount: 0.38, currency: "USD" } });
	await client.ended(usage);
	ok("usage reports context size, tokens used and USD cost");

	const start = performance.now();
	const slow = prompt("slow");
	await client.chunk(sessionId);
	await client.chunk(sessionId);
	assert(performance.now() - start >= 550, "expected two 300 ms steps");
	client.send({ method: "session/cancel", params: { sessionId } });
	await client.ended(slow, "cancelled");
	await sleep(350); // A stray third update or duplicate reply would precede the next turn.
	ok("slow spaces updates and session/cancel stops the active turn");

	const steer = prompt("steer");
	await client.chunk(sessionId, "agent_thought_chunk");
	const followUp = "Use the second file instead.";
	const injected = client.request("_session/steering", { sessionId, prompt: block(followUp) });
	assert.deepEqual(await client.result(injected), { outcome: "injected" });
	assert.equal(await client.chunk(sessionId), followUp);
	await client.ended(steer);
	ok("steer waits for a follow-up and echoes it on the original turn");

	await client.ended(prompt("refuse"), "refusal");
	await client.ended(prompt("maxtokens"), "max_tokens");
	await client.error(prompt("signedout"), -32000, "Authentication required");
	ok("refuse, maxtokens and signedout return their distinct wire results");

	const garbage = prompt("garbage");
	const stray = await client.line();
	assert.throws(() => JSON.parse(stray), SyntaxError);
	await client.chunk(sessionId);
	await client.ended(garbage);
	ok("garbage emits one non-JSON line before the update and the turn still completes");

	const value = "fake.A9+/=:_value";
	const secret = prompt("secret:" + value);
	assert((await update("session_info_update")).title.includes(value));
	assert.equal(await client.chunk(sessionId), value);
	const call = await update("tool_call");
	const output = await update("tool_call_update");
	assert.equal(output.toolCallId, call.toolCallId);
	assert.deepEqual(output.content, [{ type: "content", content: { type: "text", text: value } }]);
	await client.ended(secret);
	ok("secret echoes the exact value in a message chunk and in tool output");
}

/** The real client with a fixture process. Adjust individual wire replies to exercise negotiation. */
async function clientCheck(state: string) {
	const { harnessOf } = await import("../server/src/sandbox/harness.js");
	const machine = { machine: { name: "Bench" } } as SandboxLayer;
	const harness = harnessOf(machine, "claude");
	assert.equal(harnessOf(machine, "opencode").id, "opencode");
	assert.equal(harnessOf(machine, "codex").id, "codex");
	assert.throws(() => harnessOf({} as SandboxLayer, "codex"), /Codex runs only on a machine/);
	assert.throws(() => harnessOf({} as SandboxLayer, "opencode"), /OpenCode runs only on a machine/);
	assert.throws(() => harnessOf({} as SandboxLayer, "claude"), /only on a machine/);
	const secret = "value-held-only-for-redaction";
	const redactor = new SecretRedactor([{ name: "FIXTURE", value: secret }]);
	const secrets = { env: {}, withholdEnv: [], passEnv: [], redactor };
	const input = { prompt: "secret:" + secret, secrets };
	const guards: Partial<RunTurnInput>[] = [
		{ checks: [{ name: "check", command: "true" }] }, { servers: [{ name: "user", definition: {} }] },
		{ secrets: { ...secrets, env: { FIXTURE: secret } } }, { secrets: { ...secrets, withholdEnv: ["FIXTURE"] } }, { secrets: { ...secrets, passEnv: ["FIXTURE"] } },
		{ script: { responses: [] } }, { maxSteps: 0 }, { reportScreenshots: true },
		{ onEvent() {} }, { onUnasked() {} }, { onServerApproved() {} }, { onServers() {} },
		{ onServerQuestion: async () => false }, { onPublish: async () => "" }, { onReport: () => "" },
		{ onReview: async () => "" }, { onPush: async () => "" }, { onFetchBase: async () => "" },
	];
	for (const guard of guards) {
		const result = await harness.runTurn({} as SandboxHandle, { ...input, ...guard });
		assert.equal(result.failure?.reason, "engine");
		assert.match(result.failure.message, /^This turn asked Claude Code for .+, which it does not take here\.$/);
	}
	ok(`all ${guards.length} unsupported inputs are refused before the sandbox is touched`);

	let variant: "normal" | "load" | "wrong-version" | "without-auto" | "adapter-default" | "config-modes" | "codex-signed-out" = "normal";
	const configMode = (currentValue: string) => ({ id: "agent-mode", category: "mode", type: "select", currentValue,
		options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan", description: "Plan only" }] });
	let duringShutdown: (() => void) | undefined;
	const methods: string[] = [];
	const answers: unknown[] = [];
	const updates: AcpUpdate[] = [];
	const sandbox = {
		profile: "docker-hardened", cwd: "/workspace",
		async stopLeftovers(name: string) { assert.equal(name, variant === "codex-signed-out" ? "codex" : "claude-agent-acp"); return 0; },
		async sweep(tag: string) { assert.equal(tag, "fixture"); return 0; },
		start(argv: string[], opts: StartOptions) {
			assert.deepEqual(argv, [variant === "codex-signed-out" ? "wlp-codex-acp" : "wlp-claude-acp"]);
			assert.deepEqual(opts.env, {});
			assert.equal(opts.secretEnv, undefined);
			assert.equal(opts.cwd, "/workspace");
			let finish!: (end: ProcessEnd) => void;
			const ended = new Promise<ProcessEnd>(resolve => { finish = resolve; });
			const emit = (frame: unknown) => opts.onStdout!(JSON.stringify(frame) + "\n");
			let lastSessionId: string | undefined;
			const agent = new FakeAcpAgent(line => {
				const frame = JSON.parse(line);
				lastSessionId = frame.result?.sessionId ?? lastSessionId;
				if (frame.result?.agentCapabilities) {
					if (variant === "load") delete frame.result.agentCapabilities.sessionCapabilities.resume;
					if (variant === "wrong-version") frame.result.protocolVersion = 2;
				}
				if (frame.result?.modes && variant === "load") frame.result.modes.availableModes = [
					{ id: "plan", name: "Plan on this machine", description: "A description from the load reply." },
					{ id: "auto", name: "Automatic" },
				];
				if (frame.result?.modes && variant === "without-auto") {
					frame.result.modes.availableModes = frame.result.modes.availableModes.filter((m: { id: string }) => m.id !== "auto");
					frame.result.modes.currentModeId = "plan";
				}
				if (variant === "adapter-default" && frame.result?.modes) frame.result.configOptions = [
					{ id: "model", category: "model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus" }] },
				];
				if (frame.result?.modes && variant === "config-modes") {
					delete frame.result.modes;
					frame.result.configOptions.push(configMode("build"));
				}
				const update = frame.params?.update;
				if (update?.sessionUpdate === "agent_message_chunk" && update.content.text === secret) {
					for (const part of [secret.slice(0, 8), secret.slice(8)]) {
						update.content.text = part;
						emit(frame);
					}
				} else if (update?.sessionUpdate === "tool_call_update" && update.content?.[0]?.content.text === secret) {
					const part = (id: string, text: string, status: string) => emit({ ...frame, params: { ...frame.params, update: {
						...update, toolCallId: id, status, rawOutput: [{ type: "text", text }], content: [{ type: "content", content: { type: "text", text } }],
					} } });
					part("first", "before " + secret.slice(0, 8), "in_progress");
					part("other", "other output", "completed");
					part("first", secret.slice(8) + " after", "completed");
					part("unfinished", "ordinary " + secret.slice(0, 3), "in_progress");
				} else emit(frame);
				if (frame.result?.stopReason) emit({ method: "session/update", params: {
					sessionId: lastSessionId, update: { sessionUpdate: "notice", text: "after prompt reply" },
				} });
				if (variant === "load" && frame.result?.sessionId) emit({ method: "session/update", params: {
					sessionId: frame.result.sessionId, update: { sessionUpdate: "notice", text: "after load" },
				} });
			}, state);
			return {
				tag: "fixture", ended, hasEnded: false,
				write(line: string) {
					const frame = JSON.parse(line);
					methods.push(frame.method);
					if (frame.method === undefined && frame.result?.outcome) answers.push(frame.result.outcome);
					if (variant === "codex-signed-out") {
						if (frame.method === "initialize") {
							assert.equal(frame.params.clientCapabilities.auth._meta.gateway, true);
							emit({jsonrpc:"2.0",id:frame.id,result:{protocolVersion:1}});
						} else if (frame.method === "providers/set") emit({jsonrpc:"2.0",id:frame.id,result:{}});
						else if (frame.method === "session/new") emit({jsonrpc:"2.0",id:frame.id,error:{code:-32000,message:"Authentication required"}});
						else throw Error("Unexpected Codex method " + frame.method);
						return true;
					}
					if (variant === "config-modes" && frame.method === "session/set_config_option") {
						assert.equal(frame.params.configId, "agent-mode");
						emit({ jsonrpc: "2.0", id: frame.id, result: { configOptions: [configMode(frame.params.value)] } });
						return true;
					}
					if (frame.method === "session/load") {
						emit({ method: "session/update", params: { sessionId: frame.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old transcript" } } } });
						frame.method = "session/resume";
					}
					if (frame.method === "session/prompt") {
						opts.onStderr!(secret.slice(0, 8));
						opts.onStderr!(secret.slice(8));
					}
					agent.input(JSON.stringify(frame) + "\n");
					return true;
				},
				closeStdin() { duringShutdown?.(); agent.stop(); finish({ code: 0, signal: null, error: null }); },
			};
		},
	};
	markTurnSandbox(sandbox);
	const handle = sandbox as unknown as SandboxHandle;
	const { turnRefusal, limitObservation } = await import("../server/src/provider-refusal.js");
	const limitUpdates: AcpUpdate[] = [];
	const limited = await harness.runTurn(handle, { prompt: "claudelimit", onAcpUpdate: u => limitUpdates.push(u) });
	const quota = await harness.runTurn(handle, { prompt: "codexlimit" });
	const observed = limitUpdates.find(u => u.sessionUpdate === "usage_update")?.rateLimit;
	let warned = false;
	let control: Parameters<NonNullable<RunTurnInput["onControl"]>>[0] | undefined;
	const duringWarning = await harness.runTurn(handle, { prompt: "warning", onControl: c => { control = c; },
		onAcpUpdate: u => { if (u.sessionUpdate === "usage_update") {
			warned = u.rateLimit?.status === "allowed_warning" && u.fiveHourUsedPct === 93;
			queueMicrotask(() => { void control!.steer("finish the original turn"); });
		} } });
	const checks = {
		"5c.3 Claude refusal and rejected event": turnRefusal("error", limited, null)?.resetsAt === 1900000000000 && limited.failure?.reason === "usage_limit" && observed?.status === "rejected",
		"5c.4 Codex quota fixture": turnRefusal("error", quota, null)?.kind === "quota_exhausted",
		"5c.6 warning keeps the original prompt running": warned && duringWarning.failure === null && duringWarning.acp?.stopReason === "end_turn",
		"5c.8 no canaries in outgoing usage updates or turn results": !JSON.stringify([limitUpdates, limited, quota]).includes("canary"),
	};
	for (const [name, passed] of Object.entries(checks)) console.log(passed ? "PASS" : "FAIL", name);
	assert(Object.values(checks).every(Boolean), "provider routing fixtures");
	const { observeUsage } = await import("../server/src/provider-usage.js");
	for (const [result, until] of [[limited, 1900000000000 + 60_000], [quota, 1 + 900_000]] as const) {
		const reading = limitObservation(turnRefusal("error", result, null), 1);
		assert.ok(reading);
		const stored = observeUsage({ account: { key: "fixture", harness: harness.id, state: "ok", limitedUntil: null, windows: [] },
			backoff: 0, lastRefusal: -1, lastSuccess: -1 }, reading);
		assert.equal(stored.account.state, "limited");
		assert.equal(stored.account.limitedUntil, until);
		assert.doesNotMatch(JSON.stringify(stored), /canary/);
	}
	methods.length = 0;
	let lateSteer: Promise<void> | undefined;
	const marks: string[] = [];
	const first = await harness.runTurn(handle, { ...input, onStartMark: point => marks.push(point), onControl: c => { duringShutdown = () => { lateSteer = assert.rejects(c.steer("late"), /turn ended/i); }; }, onAcpUpdate: u => updates.push(u) });
	assert.equal(first.failure, null);
	// The start's points, once each, in order (start-times.ts).
	assert.deepEqual(marks, ["process", "initialized", "prompted", "output"]);
	ok("an ACP turn tells its start's points in order");
	assert.equal(first.acp?.stopReason, "end_turn");
	assert.equal(first.stderrTail, redactor.text(secret));
	assert(!JSON.stringify(updates).includes(secret));
	assert(updates.some(u => u.sessionUpdate === "agent_message_chunk" && JSON.stringify(u.content).includes(redactor.text(secret))));
	ok("redaction spans ACP chunks and stderr writes without passing secret environment to the agent");

	assert(lateSteer);
	await lateSteer;
	duringShutdown = undefined;
	assert(!methods.includes("_session/steering"));
	assert(!updates.some(u => u.text === "after prompt reply"));
	const outputOf = (id: string) => updates.flatMap(u => u.sessionUpdate === "tool_call_update" && u.toolCallId === id
		? (u.content ?? []).map(block => "content" in block ? (block.content as { text: string }).text : block.text) : []).join("");
	assert.equal(outputOf("first"), "before " + redactor.text(secret) + " after");
	const rawText = updates.flatMap(u => u.toolCallId === "first" && Array.isArray(u.rawOutput)
		? u.rawOutput.map(block => block.text) : []).join("");
	assert.equal(rawText, "before " + redactor.text(secret) + " after");
	assert.equal(outputOf("other"), "other output");
	assert.equal(outputOf("unfinished"), "ordinary " + secret.slice(0, 3));
	ok("late steering sends no request and interleaved tool output redacts and flushes per call");

	variant = "load";
	updates.length = 0;
	let loadModes: unknown;
	const loaded = await harness.runTurn(handle, {
		prompt: "ask", mode: "plan", windlassSessionId: first.windlassSessionId!,
		onAcpModes: (id, offered) => { loadModes = { id, offered }; },
		onAcpUpdate: u => updates.push(u),
	});
	assert.equal(loaded.resumed, true);
	assert(methods.includes("session/load"));
	assert(!JSON.stringify(updates).includes("old transcript"));
	assert(updates.some(update => update.text === "after load"));
	assert(JSON.stringify(updates).includes("Permission answered: reject."));
	ok("load suppresses replay and unattended permission uses reject_once");
	assert.deepEqual(loadModes, { id: "plan", offered: [
		{ id: "plan", name: "Plan on this machine", description: "A description from the load reply." },
		{ id: "auto", name: "Automatic", description: null },
	] });
	assert(updates.some(u => u.sessionUpdate === "current_mode_update" && u.currentModeId === "plan"));
	ok("session/load uses the chosen mode and preserves the adapter’s current order, labels and optional descriptions");

	for (const effort of ["high", undefined]) {
		const prior = await harness.runTurn(handle, { prompt: "plain", model: "opus", effort: "high" });
		assert.equal(prior.failure, null);
		const defaults: (string | null)[] = [];
		const switched = await harness.runTurn(handle, {
			prompt: "plain", windlassSessionId: prior.windlassSessionId!, model: "sonnet", effort,
			onEffortFallback: fallback => defaults.push(fallback),
		});
		assert.equal(switched.failure, null, "a stale effort must not fail the new model's turn");
		assert.deepEqual(defaults, ["default"]);
		assert.deepEqual(switched.acp?.models?.models.find(m => m.id === "sonnet")?.efforts, ["default", "low"]);
	}
	ok("changing models drops an unsupported requested or inherited effort and the prompt succeeds");

	variant = "adapter-default";
	methods.length = 0;
	const implicit = await harness.runTurn(handle, { prompt: "plain", model: "default" });
	assert.equal(implicit.failure, null);
	assert.equal(implicit.acp?.models?.defaultModel, "opus");
	assert(!methods.includes("session/set_config_option"));
	const unavailable = await harness.runTurn(handle, { prompt: "plain", effort: "high" });
	assert.match(unavailable.failure?.message ?? "", /does not offer effort/);
	ok("the first prompt uses the adapter's default and an unsupported effort is refused");

	// A work item's turn: nobody answers it, so it runs in the mode that never asks, and allows what the agent still asks.
	{
		const { CLAUDE, OPENCODE } = await import("../server/src/sandbox/harnesses.js");
		const { initialSessionModes } = await import("../server/src/sandbox/profiles.js");
		assert.equal(initialSessionModes("docker-hardened", "claude", true).mode, "bypassPermissions");
		assert.equal(initialSessionModes("docker-hardened", "claude", true, [{ id: "default", name: "Manual", description: null }]).mode, "bypassPermissions");
		assert.equal(initialSessionModes("docker-hardened", "opencode", true).mode, "build");
		assert.equal(initialSessionModes("docker-hardened", "claude", false).mode, "auto");
		assert.deepEqual([CLAUDE.itemMode, OPENCODE.itemMode], ["bypassPermissions", "build"]);
		answers.length = 0;
		methods.length = 0;
		const chosen: string[] = [];
		const item = await harness.runTurn(handle, { prompt: "itemwork", mode: CLAUDE.itemMode, unattended: true, onAcpModes: id => { chosen.push(id); } });
		assert.equal(item.failure, null, JSON.stringify(item.failure));
		assert.deepEqual(chosen, ["bypassPermissions"]);
		assert.deepEqual(answers, [{ outcome: "selected", optionId: "allow-once" }, { outcome: "selected", optionId: "allow-once" }]);
		assert(!JSON.stringify(answers).includes("reject"));
		assert.deepEqual(item.acp?.tokens, { inputTokens: 1000 + 30000 + 2000, cachedInputTokens: 30000, outputTokens: 400 + 100, reasoningTokens: 100 });
		ok("an item's turn starts in the mode that never asks and allows the edit and the test command it is still asked about");
		answers.length = 0;
		const watched = await harness.runTurn(handle, { prompt: "itemwork" });
		assert.deepEqual(answers.map(a => (a as { optionId: string }).optionId), ["reject", "reject"]);
		assert.equal(watched.acp?.tokens?.inputTokens, 33000);
		ok("a person's turn without a question handler still rejects, and reports the same tokens");
		const refused = await harness.runTurn(handle, { prompt: "itemwork", mode: "noSuchMode", unattended: true });
		assert.match(refused.failure?.message ?? "", /does not offer the mode “noSuchMode”.*never asks/);
		assert(!methods.slice(methods.lastIndexOf("initialize")).includes("session/prompt"));
		ok("an item's turn does not start in another mode when its own is not offered");
		const { promptUsage } = await import("../server/src/sandbox/acp-harness.js");
		assert.equal(promptUsage(undefined), null);
		assert.equal(promptUsage({ totalTokens: 5 }), null);
		assert.deepEqual(promptUsage({ inputTokens: 7, outputTokens: 3, cachedReadTokens: -1 }), { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 0 });
		const limitedStart = await harness.runTurn(handle, { prompt: "warning", onControl: c => { control = c; },
			onAcpUpdate: u => { if (u.sessionUpdate === "usage_update") queueMicrotask(() => { void control!.steer("finish"); }); } });
		assert.equal(limitedStart.acp?.fiveHourAtStart, 93);
		ok("prompt usage is read defensively and the 5h window is kept from the turn's first update");
	}

	variant = "without-auto";
	for (const mode of [undefined, "unavailable"]) {
		const opened: string[] = [];
		updates.length = 0;
		const result = await harness.runTurn(handle, { prompt: "plain", mode,
			onAcpModes: (chosen, offered, fallback) => {
				assert.deepEqual(offered.map(m => m.id), ["default", "acceptEdits", "plan", "bypassPermissions"]);
				opened.push(chosen, fallback ?? "");
			},
			onAcpUpdate: u => updates.push(u),
		});
		assert.equal(result.failure, null);
		assert(updates.some(u => u.sessionUpdate === "current_mode_update" && u.currentModeId === "plan"), JSON.stringify(updates));
		assert.deepEqual(opened, ["plan", mode ?? "auto"]);
	}
	ok("absent auto and an unavailable requested mode both select the advertised current mode and report one fallback");
	variant = "config-modes";
	for (const mode of [undefined, "plan"]) {
		methods.length = 0;
		const selected: string[] = [];
		const turn = await harness.runTurn(handle, { prompt: "plain", mode, windlassSessionId: first.windlassSessionId!,
			onAcpModes: (id, choices) => {
				assert.equal(choices[1]?.description, "Plan only");
				selected.push(id);
			} });
		assert.equal(turn.failure, null);
		assert.deepEqual(selected, [mode ?? "build"]);
		assert(methods.includes("session/set_config_option"));
		assert(!methods.includes("session/set_mode"));
	}
	ok("config-only modes use the reported current mode and reapply a saved mode on resume");
	variant = "wrong-version";
	methods.length = 0;
	const wrongVersion = await harness.runTurn(handle, { prompt: "plain" });
	assert.match(wrongVersion.failure?.message ?? "", /ACP v1/);
	assert(!methods.includes("session/prompt"));
	ok("wrong protocol version prevents prompting");
	variant = "codex-signed-out";
	const codex = await harnessOf(machine, "codex").runTurn(handle,{prompt:"signed out"});
	assert.equal(codex.failure?.reason,"harness_signed_out");
	assert.match(codex.failure.message,/Bench.*Run windlass-runner login codex/);
	ok("Codex -32000 names the machine and its terminal sign-in command");

	// Codex is not offered for work items: filing one is refused, an unattended turn never starts, and nothing is allowed in its name.
	{
		const { CODEX, CLAUDE, OPENCODE, itemHarnessProblem } = await import("../server/src/sandbox/harnesses.js");
		const { permission } = await import("../server/src/sandbox/acp-harness.js");
		assert.equal(itemHarnessProblem("codex"), "Work items run Windlass, Claude Code or OpenCode for now. Start a Codex session instead.");
		assert.deepEqual([itemHarnessProblem("windlass"), itemHarnessProblem("claude"), itemHarnessProblem("opencode")], [null, null, null]);
		assert.equal(CODEX.items, false);
		assert.equal(CODEX.itemTokens, "subscription");
		assert.notEqual(CODEX.itemMode, "agent-full-access");
		methods.length = 0;
		const unattended = await harnessOf(machine, "codex").runTurn(handle, { prompt: "itemwork", unattended: true });
		assert.equal(unattended.failure?.message, itemHarnessProblem("codex"));
		assert.deepEqual(methods, [], "no Codex process is started for an unattended turn");
		const params = { sessionId: "s", toolCall: { toolCallId: "t", title: "Run tests" }, options: [
			{ optionId: "allow-once", kind: "allow_once", name: "Allow" }, { optionId: "always", kind: "allow_always", name: "Always" },
			{ optionId: "reject", kind: "reject_once", name: "Reject" },
		] };
		let asked = 0;
		const onQuestion = async () => { asked++; return { choice: "allow-once" }; };
		const answer = async (profile: typeof CODEX, input: Partial<RunTurnInput>) =>
			(await permission(params, { prompt: "x", ...input } as RunTurnInput, new AbortController().signal, profile)).outcome;
		assert.deepEqual(await answer(CODEX, { unattended: true }), { outcome: "selected", optionId: "reject" });
		assert.deepEqual(await answer(CODEX, { unattended: true, onQuestion: onQuestion as RunTurnInput["onQuestion"] }), { outcome: "selected", optionId: "reject" });
		assert.equal(asked, 0, "an unattended Codex request is not put to anyone");
		assert.deepEqual(await answer({ ...CLAUDE, items: false }, { unattended: true }), { outcome: "selected", optionId: "reject" });
		assert.deepEqual(await answer(OPENCODE, { unattended: true }), { outcome: "selected", optionId: "allow-once" });
		assert.deepEqual(await answer(CODEX, { onQuestion: onQuestion as RunTurnInput["onQuestion"] }), { outcome: "selected", optionId: "allow-once" });
		assert.equal(asked, 1);
	}
	ok("Codex is refused for work items, its unattended turn never starts, and item auto-approval never answers for it");
}

const state = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), ".fake-acp-check-"));
try {
	const id = await withProcess(state, async (client) => {
		const sessionId = await configure(client);
		ok("initialize, new, set_mode and set_config_option");
		await checkScenarios(client, sessionId);
		return sessionId;
	});
	await withProcess(state, async (client) => {
		await initialize(client);
		const params = { ...openParams, sessionId: id };
		const result = await client.result(client.request("session/resume", params));
		assert.equal(result.sessionId, id);
		assert.equal(result.modes.currentModeId, "bypassPermissions");
		checkChoices(result.configOptions, "opus", "high");
		await client.ended(client.prompt(id, "refuse"), "refusal");
		await client.error(client.request("session/resume", { ...params, sessionId: "00000000-0000-0000-0000-000000000000" }), -32002, "Resource not found");
		ok("a second process resumes the configured session, runs a turn and rejects an unknown ID");
	});

	const output = new PassThrough();
	const agent = new FakeAcpAgent((line) => output.write(line), state);
	try {
		const client = new Client(output, (line) => { agent.input(line.slice(0, 5)); agent.input(line.slice(5)); });
		const sessionId = await configure(client);
		const prompt = client.prompt(sessionId, "usage");
		assert.equal((await client.update(sessionId, "usage_update")).used, 41000);
		await client.ended(prompt);
		ok("the in-process stand-in accepts fragmented input and plays the shared usage scenario");
	} finally {
		agent.stop();
		output.end();
	}
	await clientCheck(state);
} finally {
	rmSync(state, { recursive: true, force: true });
}
