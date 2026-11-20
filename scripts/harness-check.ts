// cd server && npx tsx ../scripts/harness-check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FakeAcpAgent } from "./acp-agent-fake.js";

const fixture = fileURLToPath(new URL("../fixtures/acp-agent/agent.mjs", import.meta.url));
const openParams = { cwd: "/workspace", mcpServers: [] };
const block = (text: string) => [{ type: "text", text }];
const ok = (name: string) => console.log(`ok  ${name}`);

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
			sessionCapabilities: { resume: {}, close: {}, list: {}, fork: {}, additionalDirectories: {} },
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
	assert.deepEqual(modes.availableModes.map((m: { id: string }) => m.id), ["default", "acceptEdits", "plan", "bypassPermissions"]);
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
	for (let i = 0; i < 5; i++) await client.chunk(sessionId);
	await client.ended(plain);
	ok("plain delivers three thoughts and five message chunks in order");

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
	assert.equal(await client.chunk(sessionId), value);
	const call = await update("tool_call");
	const output = await update("tool_call_update");
	assert.equal(output.toolCallId, call.toolCallId);
	assert.deepEqual(output.content, [{ type: "content", content: { type: "text", text: value } }]);
	await client.ended(secret);
	ok("secret echoes the exact value in a message chunk and in tool output");
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
} finally {
	rmSync(state, { recursive: true, force: true });
}
