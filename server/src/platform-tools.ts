/**
 * The platform's tools for every agent, in one place: which a turn is offered, what each is declared
 * as, how a call is run and answered, and which of them may be served from inside the sandbox.
 *
 * The tools themselves are defined in agent-publish.ts (names, descriptions, schemas, limits and the
 * checks of `ask_person` and a publish), with the reviewer's `file_review` in factory/reviewer-task.ts.
 * Their handlers are the turn's callbacks (`RunTurnInput.onReport`, `onAsk`, ...), which the session
 * builds once for any agent (actors/agent-session.ts). This file maps one onto the other, and each
 * agent reaches the same map by one of two transports:
 *
 *   host tools   Windlass declares them beside its own tools (`_meta.windlass.hostTools`) and sends each
 *                call as `_windlass/host_call` on the engine's connection (sandbox/turn.ts). Every tool.
 *   MCP over ACP The agent is handed one MCP server, `windlass_platform`, declared `"type": "acp"` in
 *                `session/new`: each MCP request comes back as an `mcp/message` request on the same ACP
 *                connection, and this file answers it (`PlatformMcpServer`). Claude Code's adapter takes
 *                such a server itself; OpenCode's and Codex's harness images run `wlp-acp-mcp`, which
 *                serves it the same way (Codex's on the one URL its requirements.toml allows). Only the
 *                tools `reach` does not mark "host".
 *
 * Which tools go over MCP, and why that is safe. Windlass's host tools are called by the model through
 * Windlass. An MCP server is reached, in the end, through an endpoint inside the container (127.0.0.1, with a
 * bearer token held in the agent's memory; OpenCode also has its own API there, without a password), so any
 * process there may be able to call it: the repository's setup script, a test, a command the agent was
 * talked into running. A tool served that way must be one whose worst call by such a process is bounded:
 *
 *   report      text for the person, taken as a claim and never as the verdict (whether the work is
 *               ready is decided from the checks and CI). A rogue call can file a wrong report, which the
 *               agent's own later call replaces, and which the person reads labelled as the agent's.
 *   ask_person  one question, with the limits Windlass's has (one per turn, its length and options,
 *               the same cleaning), the answer coming from the person as the next turn's message.
 *   request_secret asks the person to supply a missing variable. The request names the sandbox as its
 *               source and says where the value would be saved. Only the person's separate action
 *               can save it and grant the next turn access.
 *   push        commits the workspace and pushes it to the session's own branch, which the platform names
 *               (a call that names another is refused, and nothing in a call chooses the ref, a force or a
 *               lease), with a token that never enters the container, under a lease that replaces only the
 *               platform's own last push. A rogue call pushes what any process could already have put in
 *               the workspace to the session's branch, never over a commit anyone else pushed there; at
 *               most `MCP_LIMITS.push` a turn.
 *   fetch_base  fetches the base, and the session's branch, into `origin/*` with a read-only token, and
 *               changes neither the working tree nor a local branch; at most `MCP_LIMITS.fetch_base` a turn.
 *   publish     opens or updates a pull request under the person's name, so over MCP every call is put to
 *               the person (`reach` "asked"): never unasked, never "for this session" (agent-session.ts,
 *               `agentPublish`). A rogue call reaches a question the person answers, which says the call
 *               may not be the agent's.
 *
 * The tool replies carry no credentials and are sent only while the turn runs. The timeline says of every push, fetch and
 * publish that came over MCP that any process in the sandbox may have made it (agent-publish.ts,
 * `MCP_CALL_WORDS`). This is the exposure Windlass already has where it does not sandbox commands
 * ("Docker, hardened"), whose commands can write on the engine's own connection (docs/known-limitations.md).
 * A reviewer may file once over MCP. Only a Windlass review filed over its own channel, from its command sandbox, can approve an auto-merge (factory/autonomy.ts).
 *
 * Why Windlass keeps host tools for these as well. Windlass 0.6.0 takes no MCP server from the client
 * (`session/new`'s `mcpServers` are ignored, its `mcpCapabilities` say neither http nor sse), and an MCP
 * tool's result is a taint source there: from then on what can send data out asks again, and in an
 * item's unattended turn is refused. A host tool declared `read` with a trusted result runs in every
 * approval mode, after taint, on every profile including "Docker, hardened". So Windlass reaches the
 * same handlers by host tools; only the transport differs.
 */

import { REVIEW_TOOL } from "./factory/reviewer-task.js";
import { SECRET_TOOL, ASK_TOOL, FETCH_BASE_TOOL, PUBLISH_SERVER, PUBLISH_TOOL, PUSH_TOOL, REPORT_TOOL, callArguments, platformTools, type HostToolDeclaration } from "./agent-publish.js";
import { config } from "./config.js";
import type { RunTurnInput, TurnPublishRequest } from "./sandbox/api.js";

export const PLAN_REVIEW_TOOL = "file_plan_review";
export const PLAN_TOOL = "file_plan";

/** One of the platform's tools. */
export type PlatformTool = typeof PUBLISH_TOOL | typeof REPORT_TOOL | typeof SECRET_TOOL | typeof ASK_TOOL | typeof PUSH_TOOL | typeof FETCH_BASE_TOOL | typeof REVIEW_TOOL | typeof PLAN_TOOL | typeof PLAN_REVIEW_TOOL;

/** What decides and does a call: the agent is told what it resolves with. */
export type PlatformToolHandler = (call: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;

/**
 * Where a tool may be served from. "sandbox": its worst call by any process in the container is bounded
 * (above), so it may be served over MCP. "asked": served over MCP only because its handler puts every call
 * that came that way to the person (`TurnPublishRequest.via`). "host": only where the model alone can call
 * it (Windlass's host tools):
 *
 *   file_plan    the planner's plan becomes subtasks the owner approves. A rogue plan would reach the
 *                owner's approval as the planner's; the planner runs only on Windlass today.
 *   file_plan_review    the plan critic can approve a plan for automatic execution.
 */
export const TOOL_REACH: Readonly<Record<PlatformTool, "sandbox" | "asked" | "host">> = Object.freeze({
	[REPORT_TOOL]: "sandbox",
	[ASK_TOOL]: "sandbox",
	[SECRET_TOOL]: "sandbox",
	[PUBLISH_TOOL]: "asked",
	[PUSH_TOOL]: "sandbox",
	[FETCH_BASE_TOOL]: "sandbox",
	[PLAN_TOOL]: "host",
	[PLAN_REVIEW_TOOL]: "host",
	[REVIEW_TOOL]: "sandbox",
});

/** The tools that can be served over MCP, in the order they are listed. */
export const MCP_TOOLS = Object.freeze((Object.keys(TOOL_REACH) as PlatformTool[]).filter(tool => TOOL_REACH[tool] !== "host"));

/**
 * How many calls of a tool one turn may make over MCP. Each push and fetch mints a GitHub token and runs
 * Git in the sandbox, and any process there can make the call: a turn's worth is enough for an agent that
 * pushes after each piece of work, and bounds what a rogue process can make the platform do.
 */
export const MCP_LIMITS: Readonly<Partial<Record<PlatformTool, number>>> = Object.freeze({ [PUSH_TOOL]: 5, [FETCH_BASE_TOOL]: 3, [REVIEW_TOOL]: 1 });

/** What the agent is told of a call over its turn's limit (`MCP_LIMITS`), and the timeline's line. */
export function overLimit(tool: PlatformTool, limit: number): { told: string; said: string } {
	const times = `${limit} time${limit === 1 ? "" : "s"}`;
	const [verb, done] = tool === PUSH_TOOL ? ["push", "Not pushed"] : tool === FETCH_BASE_TOOL ? ["fetch the base", "Not fetched"] : [`call ${tool}`, "Not done"];
	return {
		told: `${done}. One turn may ${verb} at most ${times}, and this turn has. The work stays in the workspace as it is; do not try another way to ${verb}.`,
		said: `A call over MCP asked to ${verb} after this turn had done so ${times}, the most one turn may, so the platform refused it. Any process in the sandbox may have made the call, not only the agent.`,
	};
}

/** What the agent is told when the platform's own handling of a call of one of its tools failed. */
export const CALL_NOT_HANDLED = "The platform could not handle this call. Tell the user; do not try another way to do it.";
/** A call that came when the turn it was made in is over. */
export const CALL_AFTER_TURN = "The turn this call was made in has ended, so the platform did nothing with it.";
/** A call whose id an earlier call of the turn had (`PlatformMcpServer`). */
export const CALL_REPEATED = "This call was already made in this turn, so the platform did not run it again.";
/** A call of a tool this turn was not given. */
export const CALL_UNKNOWN = "This session has no such tool of the platform's.";

/**
 * The tools a turn is offered, by the callbacks it was given: the planner's `file_plan` alone, the
 * reviewer's `file_review` alone, or `publish` in a person's session and `report` (with `ask_person`
 * for a builder) in an item's, with `push` and `fetch_base` beside either. With `reach` "sandbox",
 * only those that may be served over MCP (`MCP_TOOLS`).
 */
export function turnPlatformTools(input: RunTurnInput, reach: "host" | "sandbox" = "host"): Map<PlatformTool, PlatformToolHandler> {
	const tools = new Map<PlatformTool, PlatformToolHandler>();
	if (input.onPlanReview) tools.set(PLAN_REVIEW_TOOL, input.onPlanReview);
	else if (input.onPlan) tools.set(PLAN_TOOL, input.onPlan);
	else if (input.onReview) tools.set(REVIEW_TOOL, input.onReview);
	else {
		if (input.onPublish) tools.set(PUBLISH_TOOL, input.onPublish);
		else if (input.onReport) {
			tools.set(REPORT_TOOL, input.onReport);
			if (input.onAsk) tools.set(ASK_TOOL, input.onAsk);
		}
		if (input.onRequestSecret) tools.set(SECRET_TOOL, input.onRequestSecret);
		if (input.onPush && input.onFetchBase) {
			tools.set(PUSH_TOOL, input.onPush);
			tools.set(FETCH_BASE_TOOL, input.onFetchBase);
		}
	}
	if (reach === "sandbox") for (const tool of tools.keys()) if (TOOL_REACH[tool] === "host") tools.delete(tool);
	return tools;
}

/** The declarations of a turn's tools (agent-publish.ts, `platformTools`). */
export function platformToolDeclarations(tools: ReadonlyMap<string, unknown>, options: { screenshots?: boolean; crossRepo?: boolean; mcp?: boolean } = {}): HostToolDeclaration[] {
	const plan = tools.has(PLAN_TOOL);
	return platformTools({
		planReview: tools.has(PLAN_REVIEW_TOOL), plan, ...(options.crossRepo && plan && { crossRepo: true }),
		publish: tools.has(PUBLISH_TOOL), report: tools.has(REPORT_TOOL), push: tools.has(PUSH_TOOL),
		review: tools.has(REVIEW_TOOL), ask: tools.has(ASK_TOOL), secret: tools.has(SECRET_TOOL), screenshots: options.screenshots,
		...(options.mcp && { mcp: { pushes: MCP_LIMITS[PUSH_TOOL] ?? 0, fetches: MCP_LIMITS[FETCH_BASE_TOOL] ?? 0 } }),
	}, config.questionTimeoutMs).filter(tool => tools.has(tool.name));
}

/**
 * One call, run by its handler: what the agent is told, and whether it is an error. Never rejects; a
 * handler that fails, or answers nothing, is the platform's failure, which the agent is told of.
 */
export async function runPlatformTool(handler: PlatformToolHandler, call: TurnPublishRequest, signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
	try {
		const text = await handler(call, signal);
		return { ok: true, output: typeof text === "string" && text !== "" ? text : CALL_NOT_HANDLED };
	} catch {
		return { ok: false, output: CALL_NOT_HANDLED };
	}
}

// ---------------------------------------------------------------------------------------------
// MCP over ACP
// ---------------------------------------------------------------------------------------------

/** The MCP revision of the binding (the ACP SDK's MCP-over-ACP, which Claude Code's adapter speaks). */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
/** The server's id on the connection. Fixed, so that Claude Code's managed policy can allow exactly its endpoint (sandbox/harness/claude/managed-settings.json). */
export const PLATFORM_MCP_SERVER_ID = "windlass-platform";
/** The server as a session declares it: the name the model sees its tools under (`mcp__windlass_platform__report`, `windlass_platform_report`). */
export const PLATFORM_MCP_SERVER = Object.freeze({ type: "acp", name: PUBLISH_SERVER, serverId: PLATFORM_MCP_SERVER_ID });

/** An inner MCP outcome, as an `mcp/message` response carries it. */
export type McpOutcome = { result: Record<string, unknown> } | { error: { code: number; message: string } };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const mcpError = (code: number, message: string): McpOutcome => ({ error: { code, message } });

/**
 * The platform's MCP server for one turn, answering the `mcp/message` requests of the agent's
 * connection. `live` says whether a call may run now: while the turn's prompt runs, and never after.
 * Listing is answered whenever the connection asks, since an agent lists a session's tools as it opens
 * it. A call is run by the same handler a Windlass host call is (`runPlatformTool`), marked as having
 * come over MCP (`TurnPublishRequest.via`); one past its tool's limit for the turn (`MCP_LIMITS`) reaches
 * no handler, and `onRefused` is given the timeline's line for it. Calls are counted as the platform's step
 * limit counts tool calls (sandbox/platform-steps.ts): each call once, by its id, whatever came of it, over
 * every prompt of the turn (one server serves the whole turn, the platform's follow-ups after its checks
 * included). Each is a step as well: a refused one still counts against the turn's step limit.
 */
export class PlatformMcpServer {
	private readonly listed: Array<Record<string, unknown>>;
	private readonly calls = new Map<string, number>();
	private readonly counted = new Set<string>();
	constructor(private readonly tools: ReadonlyMap<string, PlatformToolHandler>, declarations: HostToolDeclaration[], private readonly live: () => boolean, private readonly onRefused?: (said: string) => void) {
		// Claude Code defers MCP tools behind its tool search unless a tool says to load it at once: these are few and short, and the agent is to know them.
		this.listed = declarations.filter(tool => tools.has(tool.name)).map(tool => ({
			name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			_meta: { "anthropic/alwaysLoad": true },
		}));
	}

	get size() { return this.listed.length; }

	/** One `mcp/message` request's params. Resolves with the outcome the response carries; never rejects. */
	async handle(params: Record<string, unknown>, signal: AbortSignal): Promise<McpOutcome> {
		if (params.serverId !== PLATFORM_MCP_SERVER_ID) return mcpError(-32602, "No such server on this connection.");
		const inner = isObject(params.params) ? params.params : {};
		const meta = isObject(inner._meta) ? inner._meta : {};
		if (meta[META_VERSION] !== MCP_PROTOCOL_VERSION) return mcpError(-32022, "Unsupported protocol version");
		switch (params.method) {
			case "server/discover":
				// `resultType`: Codex 0.171's MCP client takes a discover result only with it.
				return { result: { resultType: "complete", supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: { listChanged: false } }, serverInfo: { name: PUBLISH_SERVER, version: "1" }, ttlMs: 0, cacheScope: "private" } };
			case "ping":
				return { result: {} };
			case "tools/list":
				return { result: { tools: this.listed } };
			case "tools/call": {
				const name = typeof inner.name === "string" ? inner.name : "";
				const text = (output: string, isError: boolean) => ({ result: { content: [{ type: "text", text: output }], isError } });
				const handler = this.tools.get(name);
				if (!this.live() || signal.aborted) return text(CALL_AFTER_TURN, true);
				if (!handler) return text(CALL_UNKNOWN, true);
				// Counted before the handler runs, whatever comes of the call: the limit bounds what a process can make the platform do.
				// Once per call id, as a step is. A request sent again with an id already seen is not run again: replaying one
				// id must not get past the limit.
				const id = typeof params.requestId === "string" && params.requestId !== "" ? params.requestId : null;
				if (id !== null && this.counted.has(id)) return text(CALL_REPEATED, true);
				if (id !== null) this.counted.add(id);
				const made = (this.calls.get(name) ?? 0) + 1;
				this.calls.set(name, made);
				const limit = MCP_LIMITS[name as PlatformTool];
				if (limit !== undefined && made > limit) {
					const refused = overLimit(name as PlatformTool, limit);
					try { this.onRefused?.(refused.said); } catch { /* A listener's failure must not change the answer. */ }
					return text(refused.told, true);
				}
				const call: TurnPublishRequest = { messageId: "", callId: typeof params.requestId === "string" ? params.requestId : "", arguments: callArguments(inner.arguments), via: "mcp" };
				const done = await runPlatformTool(handler, call, signal);
				return text(done.output, !done.ok);
			}
			default:
				return mcpError(-32601, "Method not found");
		}
	}
}
