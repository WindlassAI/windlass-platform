import type { AcpContent, AcpUpdate } from "../contract.js";
import { NO_REDACTION, RedactingStream, type Redactor } from "../repo-secrets.js";
import { configChoices, modeSelection, object, objects, optionsOf, text, type Fields } from "./acp-options.js";
import { AcpConnection, AcpError, LineSplitter, MethodNotFound } from "./acp.js";
import { SandboxUserError, type RunTurnInput, type RunTurnResult, type SandboxHandle } from "./api.js";
import type { Harness, HarnessCapabilities } from "./harness.js";
import { type AcpProfile, machineLoginMessage } from "./harnesses.js";
import { isTurnSandbox, type SandboxProcess } from "./provider.js";

export const ACP_CAPABILITIES: HarnessCapabilities = Object.freeze({
	events: "acp", resume: "resume", steer: true, cancelCall: false, questions: true,
	platformTools: Object.freeze([]), restrictedReview: false, userServers: "none", projectServerApproval: false,
	checks: "none", envLists: false, sessionHome: false, usage: "context", models: "harness",
	signIn: "machine", backups: false, stepLimit: false, demo: false,
});

function unsupported(input: RunTurnInput): string | undefined {
	if (input.checks?.length) return "checks";
	if (input.servers?.length) return "servers";
	if (input.secrets && (Object.keys(input.secrets.env).length || input.secrets.withholdEnv.length || input.secrets.passEnv.length)) return "saved environment variables";
	if (input.reportScreenshots) return "report screenshots";
	return (["script", "maxSteps", "onEvent", "onUnasked", "onServerQuestion", "onServerApproved", "onServers", "onPublish", "onReport", "onReview", "onPush", "onFetchBase"] as const)
		.find(key => input[key] !== undefined);
}

async function permission(params: Fields, input: RunTurnInput, signal: AbortSignal, name: string) {
	const tool = object(params.toolCall);
	const options = objects(params.options);
	const fallback = options.find(o => o.kind === "reject_once");
	let chosen = fallback?.optionId;
	if (input.onQuestion && !signal.aborted) {
		const title = text(tool.title);
		const content = objects(tool.content).map(block => object(block.content ?? block)).find(block => block.type === "text");
		const answer = await input.onQuestion({
			messageId: "acp", callId: text(tool.toolCallId), title, subject: text(content?.text) || title, details: [], subagent: null,
			choices: options.map(o => ({
				id: text(o.optionId), label: text(o.name), approve: text(o.kind).startsWith("allow"),
				remembers: o.kind === "allow_always" ? `for this conversation, as ${name} keeps it` : null,
			})),
		}, signal).catch(() => null);
		chosen = answer?.note ? fallback?.optionId : options.find(o => o.optionId === answer?.choice)?.optionId ?? fallback?.optionId;
	}
	return { outcome: !signal.aborted && typeof chosen === "string" ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" } };
}

/** Keep unrecognized payloads without promising the typed fields of a known update. */
function isKnownUpdate(raw: Fields): raw is Exclude<AcpUpdate, { sessionUpdate: "unknown" }> {
	const content = (value: unknown) => typeof object(value).type === "string";
	const strings = (value: unknown, ...keys: string[]) => keys.every(key => typeof object(value)[key] === "string");
	const optionalStrings = (...keys: string[]) => keys.every(key => raw[key] === undefined || typeof raw[key] === "string");
	switch (raw.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
		case "user_message_chunk":
			return content(raw.content);
		case "tool_call":
		case "tool_call_update":
			return typeof raw.toolCallId === "string" && optionalStrings("title", "kind", "status")
				&& (raw.content === undefined || (Array.isArray(raw.content) && raw.content.every(content)));
		case "plan":
			return Array.isArray(raw.entries) && raw.entries.every(entry => strings(entry, "content", "priority", "status"));
		case "available_commands_update":
			return Array.isArray(raw.availableCommands) && raw.availableCommands.every(command => strings(command, "name", "description"));
		case "current_mode_update": return typeof raw.currentModeId === "string";
		case "config_option_update": return Array.isArray(raw.configOptions);
		case "session_info_update": return optionalStrings("title", "updatedAt");
		case "usage_update":
			return typeof raw.used === "number" && typeof raw.size === "number"
				&& (raw.cost == null || (typeof object(raw.cost).amount === "number" && strings(raw.cost, "currency")));
		case "notice":
		case "compaction_update":
			return true;
		default: return false;
	}
}

/** Only a definite refusal to inject can safely be submitted again as a normal prompt. */
export class AcpPromptRequired extends SandboxUserError {
	constructor() { super("The turn ended just as the message arrived."); }
}

/** Redact text even when one saved value arrives split across ACP chunks. */
function updateStream(redactor: Redactor, emit: (update: AcpUpdate) => void) {
	const stream = new RedactingStream(redactor);
	let previous: Extract<AcpUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }> | null = null;
	const tools = new Map<string, { display: RedactingStream; raw: RedactingStream }>();
	function flushMessage() {
		const rest = stream.flush();
		if (previous && rest) emit({ ...previous, content: { type: "text", text: rest } });
		previous = null;
	}
	function redactBlock(block: AcpContent, tail: RedactingStream): AcpContent {
		const nested = block.type === "content";
		const body = nested ? object(block.content) : block;
		if (body.type !== "text" || typeof body.text !== "string") return block;
		const safe = { ...body, type: "text", text: tail.push(body.text) };
		return nested ? { ...block, content: safe } : safe;
	}
	// Claude can repeat its display text in rawOutput. Keep each copy continuous across updates.
	function toolOutput(update: Extract<AcpUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>) {
		const id = update.toolCallId;
		const tails = tools.get(id) ?? { display: new RedactingStream(redactor), raw: new RedactingStream(redactor) };
		const clean = { ...update };
		if (update.content) clean.content = update.content.map(block => redactBlock(block, tails.display));
		if (typeof update.rawOutput === "string") clean.rawOutput = tails.raw.push(update.rawOutput);
		if (Array.isArray(update.rawOutput)) clean.rawOutput = update.rawOutput.map(block =>
			typeof object(block).type === "string" ? redactBlock(block, tails.raw) : block);
		emit(clean);
		if (tails.display.hasTail || tails.raw.hasTail) tools.set(id, tails);
		else tools.delete(id);
	}
	return {
		flush() {
			flushMessage();
			for (const [toolCallId, { display, raw }] of tools) {
				emit({
					sessionUpdate: "tool_call_update", toolCallId,
					...(display.hasTail && { content: [{ type: "content", content: { type: "text", text: display.flush() } }] }),
					...(raw.hasTail && { rawOutput: raw.flush() }),
				});
			}
			tools.clear();
		},
		push(update: AcpUpdate) {
			const content = object(update.content);
			if (previous?.sessionUpdate !== update.sessionUpdate) flushMessage();
			if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && content.type === "text" && typeof content.text === "string") {
				previous = update;
				const safe = stream.push(content.text);
				if (safe) emit({ ...update, content: { ...content, type: "text", text: safe } });
			} else {
				flushMessage();
				if (redactor.active && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) toolOutput(update);
				else emit(update);
			}
		},
	};
}

async function waitForExit(run: SandboxProcess, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([run.ended, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
	finally { clearTimeout(timer); }
}

export class AcpHarness implements Harness {
	readonly id;
	constructor(private readonly profile: AcpProfile, private readonly machine: string) { this.id = profile.id; }

	async capabilities() { return ACP_CAPABILITIES; }

	async runTurn(handle: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		const profile = this.profile;
		const acp: NonNullable<RunTurnResult["acp"]> = { stopReason: null, usage: null, models: null };
		const result: RunTurnResult = { exitCode: null, aborted: false, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: null, acp };
		const refused = unsupported(input);
		if (refused) {
			result.failure = { reason: "engine", message: `This turn asked ${profile.name} for ${refused}, which it does not take here.` };
			return result;
		}
		const redactor = input.secrets?.redactor ?? NO_REDACTION;
		const questions = new AbortController();
		const stream = updateStream(redactor, update => input.onAcpUpdate?.(update));
		const stderr = new RedactingStream(redactor);
		const keepError = (piece: string) => { result.stderrTail = (result.stderrTail + piece).slice(-4096); };
		let run: SandboxProcess | undefined;
		let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
		let phase: "setup" | "running" | "ended" = "setup";
		let configs = optionsOf([]);
		let modes = modeSelection(null, []);
		const readConfigs = (raw: unknown, freshSession = false) => {
			configs = optionsOf(raw, acp.models ?? input.harnessModels, freshSession);
			acp.models = configs.list;
		};
		const rpc = new AcpConnection(line => run?.write(line + "\n") ?? false, {
			notification: (method, params) => {
				if (phase === "ended" || method !== "session/update" || !result.windlassSessionId || params.sessionId !== result.windlassSessionId) return;
				const update = object(params.update);
				if (typeof update.sessionUpdate !== "string") return;
				if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && typeof update.size === "number") {
					const cost = object(update.cost);
					acp.usage = { used: update.used, size: update.size, cost: typeof cost.amount === "number" && typeof cost.currency === "string" ? { amount: cost.amount, currency: cost.currency } : null };
				}
				if (update.sessionUpdate === "config_option_update") {
					readConfigs(update.configOptions);
					if (modes.select) {
						modes = modeSelection(null, update.configOptions);
						if (modes.current) input.onAcpModes?.(modes.current, modes.modes);
					}
				}
				stream.push(isKnownUpdate(update) ? update : { ...update, sessionUpdate: "unknown", originalSessionUpdate: update.sessionUpdate });
			},
			request: async (method, params, withdrawn) => {
				if (method !== "session/request_permission") throw new MethodNotFound(method);
				if (phase !== "running" || params.sessionId !== result.windlassSessionId) return { outcome: { outcome: "cancelled" } };
				return permission(params, input, AbortSignal.any([questions.signal, withdrawn]), profile.name);
			},
		}, "", value => redactor.deep(value));
		const cancel = () => {
			questions.abort();
			if (phase === "running") {
				rpc.notify("session/cancel", { sessionId: result.windlassSessionId });
				cancelDeadline = setTimeout(() => rpc.end("The agent did not answer the stop request."), 10_000);
			} else rpc.end("The turn was stopped.");
		};
		try {
			if (!isTurnSandbox(handle) || !profile.profiles.includes(handle.profile)) throw new Error(`${profile.name} requires a supported machine sandbox.`);
			if (input.signal?.aborted) return { ...result, aborted: true };
			input.signal?.addEventListener("abort", cancel, { once: true });
			await handle.stopLeftovers(profile.leftovers);
			if (input.signal?.aborted) return { ...result, aborted: true };
			const lines = new LineSplitter(line => rpc.receive(line));
			run = handle.start(profile.command, { cwd: handle.cwd, env: {}, onStdout: chunk => lines.push(chunk), onStderr: chunk => keepError(stderr.push(chunk)) });
			void run.ended.then(end => {
				lines.flush();
				rpc.end(end.error?.message || `${profile.name} exited before answering (exit ${end.code ?? end.signal}).`);
			});
			const request = (method: string, params: Fields, onResult?: (value: Fields) => void) => rpc.request<Fields>(method, params, { timeoutMs: 60_000, onResult });
			const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "windlass-platform", version: "0" } });
			if (init.protocolVersion !== 1) throw new Error(`${profile.name} does not speak ACP v1.`);
			const caps = object(init.agentCapabilities);
			const canSteer = object(object(init._meta).steering).supported === true;
			const settings = { cwd: handle.cwd, mcpServers: [] };
			const prior = input.windlassSessionId;
			// Enable updates synchronously at the open reply. Replay preceding a load reply is
			// ignored, while updates in the very same stdout read after that reply are live.
			const accept = (previous?: string) => (opened: Fields) => {
				result.windlassSessionId = previous ?? text(opened.sessionId);
				modes = modeSelection(opened.modes, opened.configOptions);
				readConfigs(opened.configOptions, !previous);
			};
			if (prior) {
				const method = object(caps.sessionCapabilities).resume != null ? "session/resume" : caps.loadSession === true ? "session/load" : null;
				result.resumed = false;
				if (method) {
					try {
						await request(method, { ...settings, sessionId: prior }, accept(prior));
						result.resumed = true;
					} catch (error) {
						if (!(error instanceof AcpError) || error.code === 0 || profile.signedOutCodes.includes(error.code)) throw error;
					}
				}
			}
			if (!result.windlassSessionId) await request("session/new", settings, accept());
			const sessionId = result.windlassSessionId;
			if (!sessionId) throw new Error(`${profile.name} returned no session id.`);
			const requested = input.mode ?? (modes.select ? modes.current : "auto");
			const chosen = modes.modes.some(m => m.id === requested) ? requested : modes.current;
			if (!chosen) throw new Error(`${profile.name} did not report its current mode.`);
			if (modes.select) {
				const reply = await request("session/set_config_option", { sessionId, configId: modes.select.id, value: chosen });
				readConfigs(reply.configOptions);
				modes = modeSelection(null, reply.configOptions);
				if (!modes.current || !modes.modes.some(m => m.id === modes.current)) throw new Error(`${profile.name} did not acknowledge its mode.`);
				input.onAcpModes?.(modes.current, modes.modes, modes.current === requested ? undefined : requested);
			} else {
				input.onAcpModes?.(chosen, modes.modes, chosen === requested ? undefined : requested);
				await request("session/set_mode", { sessionId, modeId: chosen });
			}
			const priorModel = text(configs.model?.currentValue);
			const priorEffort = text(configs.effort?.currentValue);
			const select = (option: Fields, value: string) => request("session/set_config_option", { sessionId, configId: option.id, value }, set => {
				readConfigs(set.configOptions);
			});
			if (input.model) {
				if (configs.model && configChoices(configs.model).some(choice => choice.id === input.model))
					await select(configs.model, input.model);
				else if (input.model !== "default")
					throw new Error(`${profile.name} does not offer model “${input.model}” here.`);
			}
			// Model selection can change or remove the effort select altogether.
			const changed = priorModel !== text(configs.model?.currentValue);
			const effort = input.effort ?? (changed ? priorEffort : undefined);
			if (effort) {
				if (configs.effort && configChoices(configs.effort).some(choice => choice.id === effort)) {
					if (input.effort) await select(configs.effort, effort);
				} else if (changed || input.model) {
					const option = configs.effort;
					if (option && option.currentValue !== "default" && configChoices(option).some(choice => choice.id === "default"))
						await select(option, "default");
					input.onEffortFallback?.(text(configs.effort?.currentValue) || null);
				} else {
					throw new Error(`${profile.name} does not offer effort “${effort}” here.`);
				}
			}
			const prompt = (value: string) => ({ sessionId, prompt: [{ type: "text", text: value }] });
			phase = "running";
			const answer = rpc.request<Fields>("session/prompt", prompt(input.prompt), { onResult: () => { phase = "ended"; } });
			input.onControl?.({
				steer: async value => {
					if (phase !== "running" || !canSteer || input.signal?.aborted) throw new AcpPromptRequired();
					const reply = await request(profile.steering, { ...prompt(value), _meta: { steering: { idleBehavior: "promptRequired" } } });
					if (reply?.outcome !== "injected") throw new AcpPromptRequired();
				},
				cancelCall: async () => ({ stopped: false, message: `${profile.name} cannot stop one call; stop the turn instead.` }),
			});
			acp.stopReason = text((await answer).stopReason) || null;
		} catch (error) {
			if (!input.signal?.aborted) {
				const signedOut = error instanceof AcpError && profile.signedOutCodes.includes(error.code);
				const said = error instanceof Error ? error.message : String(error);
				const invalid = phase === "running" && error instanceof AcpError && error.code === -32602;
				const reason = signedOut ? "harness_signed_out" : invalid ? "invalid_request" : "engine";
				result.failure = { reason, message: redactor.text(signedOut ? `${said} ${machineLoginMessage(profile, this.machine)}` : said) };
				result.timedOut = error instanceof AcpError && error.reason === "timeout";
			}
		} finally {
			clearTimeout(cancelDeadline);
			input.signal?.removeEventListener("abort", cancel);
			phase = "ended";
			questions.abort();
			stream.flush();
			if (run && isTurnSandbox(handle)) {
				run.closeStdin();
				let end = run.hasEnded || !input.signal?.aborted || acp.stopReason ? await waitForExit(run, 2000) : null;
				for (const sig of ["TERM", "KILL"] as const) {
					if (end) break;
					await run.signal(sig, "all");
					end = await waitForExit(run, 2000);
				}
				if (!end) run.killClient();
				result.exitCode = end?.code ?? null;
				if (!result.failure && !input.signal?.aborted && (!end || end.code !== 0)) result.failure = { reason: "engine", message: redactor.text(end?.error?.message || `${profile.name} ended unexpectedly.`) };
				try { await handle.sweep(run.tag); }
				catch (error) {
					if (!result.failure && !input.signal?.aborted) result.failure = { reason: "engine", message: redactor.text(error instanceof Error ? error.message : String(error)) };
				}
			}
			rpc.end("The turn has ended.");
			keepError(stderr.flush());
			result.aborted = input.signal?.aborted ?? false;
		}
		return result;
	}
}
