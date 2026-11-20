// ACP v1 fixture for @agentclientprotocol/claude-agent-acp 0.109.0. C2a fixes the
// advertised subset so the stand-in behaves the same on every machine.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelEfforts, scenarios, scriptFor } from "./scenarios.mjs";

const initialize = {
	protocolVersion: 1,
	agentCapabilities: {
		loadSession: true,
		promptCapabilities: { image: true, embeddedContext: true },
		mcpCapabilities: { http: true, sse: true, acp: true },
		sessionCapabilities: { options: {}, resume: {}, close: {}, list: {}, fork: {}, additionalDirectories: {} },
	},
	_meta: { steering: { supported: true } },
	authMethods: [{
		id: "claude-login", name: "Log in with Claude", description: "Run `claude /login` in the terminal",
		type: "terminal", args: ["--cli"],
	}],
};

const availableModes = [
	{ id: "default", name: "Manual", description: "Ask before using tools." },
	{ id: "acceptEdits", name: "Accept edits", description: "Allow file edits." },
	{ id: "plan", name: "Plan", description: "Plan the work before editing." },
	{ id: "auto", name: "Auto", description: "Automatically assess tool permissions." },
	{ id: "bypassPermissions", name: "Bypass permissions", description: "Run tools without permission prompts." },
];

function config(id, name, category, values, currentValue) {
	return {
		id, name, category, type: "select", currentValue,
		options: values.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
	};
}

function choices(session) {
	return {
		modes: { currentModeId: session.mode, availableModes },
		configOptions: [
			config("model", "Model", "model", Object.keys(modelEfforts), session.model),
			config("effort", "Effort", "thought_level", modelEfforts[session.model], session.effort),
		],
	};
}

function promptText(prompt) {
	return (prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

export class FixturePeer {
	constructor(say, table, stateDir = process.env.WLP_FAKE_ACP_STATE ?? "/tmp") {
		this.say = say;
		this.table = table;
		this.stateDir = stateDir;
		this.buffer = "";
		this.sessions = new Map();
		this.turns = new Map();
		this.permissions = new Map();
	}

	input(chunk) {
		this.buffer += chunk;
		if (this.reading) return;
		this.reading = true;
		try {
			let at;
			while ((at = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, at);
				this.buffer = this.buffer.slice(at + 1);
				if (line.trim()) this.handle(JSON.parse(line));
			}
		} finally {
			this.reading = false;
		}
	}

	send(message) {
		this.say(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
	}

	save(sessionId, session) {
		mkdirSync(this.stateDir, { recursive: true });
		const file = join(this.stateDir, `wlp-fake-acp-${sessionId}.json`);
		const temp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temp, JSON.stringify(session), { mode: 0o600 });
		renameSync(temp, file);
		this.sessions.set(sessionId, session);
	}

	resume(sessionId) {
		if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(sessionId)) return;
		try {
			const file = join(this.stateDir, `wlp-fake-acp-${sessionId}.json`);
			return JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}

	handle({ method, id, params = {}, result, error }) {
		if (!method) {
			const turn = this.permissions.get(id);
			if (turn) {
				this.permissions.delete(id);
				const answer = result?.outcome;
				if (error || (answer?.outcome !== "selected" && answer?.outcome !== "cancelled")) {
					this.finish(turn, { error: { code: -32603, message: "Permission request failed" } });
				} else {
					this.advance(turn, answer);
				}
			}
			return;
		}
		const reply = (value) => { if (id !== undefined) this.send({ id, result: value }); };
		const fail = (code, message) => { if (id !== undefined) this.send({ id, error: { code, message } }); };
		const { sessionId } = params;
		const unknown = () => fail(-32002, "Resource not found");
		if (method === "initialize") return reply(initialize);
		if (method === "session/options") return reply(choices({ mode: "default", model: "default", effort: "default" }));
		if (method === "session/new") {
			const key = randomUUID();
			const session = { mode: "default", model: "default", effort: "default", resumes: 0 };
			this.save(key, session);
			return reply({ sessionId: key, ...choices(session) });
		}
		if (method === "session/resume") {
			const session = this.resume(sessionId);
			if (!session) return unknown();
			this.save(sessionId, { ...session, resumes: session.resumes + 1 });
			return reply({ sessionId, ...choices(session) });
		}

		const session = this.sessions.get(sessionId);
		const running = this.turns.get(sessionId);
		switch (method) {
			case "session/set_mode":
				if (!session) return unknown();
				if (!availableModes.some((mode) => mode.id === params.modeId)) return fail(-32602, "Unknown mode");
				this.save(sessionId, { ...session, mode: params.modeId });
				this.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
				return reply({});
			case "session/set_config_option": {
				if (!session) return unknown();
				const option = choices(session).configOptions.find((item) => item.id === params.configId);
				if (!option?.options.some((item) => item.value === params.value)) return fail(-32602, "Unknown option or value");
				const next = { ...session, [option.id]: params.value };
				if (option.id === "model" && session.model !== params.value) next.effort = "default";
				this.save(sessionId, next);
				return reply({ configOptions: choices(next).configOptions });
			}
			case "session/prompt": {
				if (!session) return unknown();
				if (running) return fail(-32600, "A prompt is already running");
				const turn = { sessionId, id, script: scriptFor(promptText(params.prompt), this.table) };
				this.turns.set(sessionId, turn);
				return this.advance(turn);
			}
			case "_session/steering":
				if (!session) return unknown();
				if (!running?.steer) return fail(-32600, "No prompt waiting for steering");
				reply({ outcome: running.steer === true ? "injected" : running.steer });
				running.steer = false;
				return this.advance(running, promptText(params.prompt));
			case "session/cancel":
			case "session/close":
				if (!session) return unknown();
				if (running) this.finish(running, { result: { stopReason: "cancelled" } });
				if (method === "session/close") this.sessions.delete(sessionId);
				return reply({});
			default:
				return fail(-32601, `Method not found: ${method}`);
		}
	}

	update(sessionId, update) {
		this.send({ method: "session/update", params: { sessionId, update } });
	}

	advance(turn, answer) {
		while (this.turns.get(turn.sessionId) === turn) {
			const { done, value } = turn.script.next(answer);
			answer = undefined;
			if (done) return this.finish(turn, value?.error ? value : { result: { stopReason: value ?? "end_turn" } });
			if (value.sessionUpdate) {
				if (value.sessionUpdate === "current_mode_update") this.save(turn.sessionId, { ...this.sessions.get(turn.sessionId), mode: value.currentModeId });
				this.update(turn.sessionId, value);
			} else if (value.line) {
				this.say(value.line + "\n");
			} else if (value.delay) {
				turn.timer = setTimeout(() => this.advance(turn), value.delay);
				return;
			} else if (value.permission) {
				turn.permissionId = value.requestId ?? randomUUID();
				this.permissions.set(turn.permissionId, turn);
				this.send({ id: turn.permissionId, method: "session/request_permission", params: { sessionId: turn.sessionId, ...value.permission } });
				return;
			} else if (value.steer) {
				turn.steer = value.steer;
				return;
			}
		}
	}

	finish(turn, response) {
		clearTimeout(turn.timer);
		this.permissions.delete(turn.permissionId);
		this.turns.delete(turn.sessionId);
		this.send({ id: turn.id, ...response });
	}

	stop() {
		for (const turn of this.turns.values()) clearTimeout(turn.timer);
		this.turns.clear();
		this.permissions.clear();
		this.sessions.clear();
		this.buffer = "";
	}
}

if (import.meta.main) {
	const agent = new FixturePeer((line) => process.stdout.write(line), scenarios);
	process.stdin.setEncoding("utf8").on("data", (chunk) => agent.input(chunk)).on("end", () => agent.stop());
}
