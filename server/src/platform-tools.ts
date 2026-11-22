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
 *                such a server itself; OpenCode's harness image runs `wlp-acp-mcp`, which serves it the
 *                same way. Only the tools `reach` marks "sandbox".
 *
 * Why only some tools go over MCP. Windlass's host tools are called by the model through Windlass. An MCP
 * server is reached, in the end, through an endpoint inside the container (127.0.0.1, with a bearer token
 * held in the agent's memory), so any process there may be able to call it: the repository's setup script,
 * a test, a command the agent was talked into running. A tool served that way must be one whose worst call
 * by such a process is harmless:
 *
 *   report      text for the person, taken as a claim and never as the verdict (whether the work is
 *               ready is decided from the checks and CI). A rogue call can file a wrong report, which the
 *               agent's own later call replaces, and which the person reads labelled as the agent's.
 *   ask_person  one question, with the limits Windlass's has (one per turn, `ASK_LIMITS.perRun` per run,
 *               the same cleaning), the answer coming from the person as the next turn's message.
 *
 * Neither grants anything: no credential, no push, no change outside the platform's own records of the
 * turn, and a call is answered only while the turn runs. The rest stay host tools until what they need
 * holds there too (`reach`).
 *
 * Why Windlass keeps host tools for these two as well. Windlass 0.6.0 takes no MCP server from the client
 * (`session/new`'s `mcpServers` are ignored, its `mcpCapabilities` say neither http nor sse), and an MCP
 * tool's result is a taint source there: from then on what can send data out asks again, and in an
 * item's unattended turn is refused. A host tool declared `read` with a trusted result runs in every
 * approval mode, after taint, on every profile including "Docker, hardened". So Windlass reaches the
 * same handlers by host tools; only the transport differs.
 */

import { REVIEW_TOOL } from "./factory/reviewer-task.js";
import { ASK_TOOL, FETCH_BASE_TOOL, PUBLISH_SERVER, PUBLISH_TOOL, PUSH_TOOL, REPORT_TOOL, callArguments, platformTools, type HostToolDeclaration } from "./agent-publish.js";
import { config } from "./config.js";
import type { RunTurnInput, TurnPublishRequest } from "./sandbox/api.js";

export const PLAN_TOOL = "file_plan";

/** One of the platform's tools. */
export type PlatformTool = typeof PUBLISH_TOOL | typeof REPORT_TOOL | typeof ASK_TOOL | typeof PUSH_TOOL | typeof FETCH_BASE_TOOL | typeof REVIEW_TOOL | typeof PLAN_TOOL;

/** What decides and does a call: the agent is told what it resolves with. */
export type PlatformToolHandler = (call: TurnPublishRequest, signal: AbortSignal) => string | Promise<string>;

/**
 * Where a tool may be served from. "sandbox": safe to call from any process in the container, so it may
 * be served over MCP. "host": only where the model alone can call it (Windlass's host tools). What each
 * host tool would need before it could move:
 *
 *   publish      opens a pull request under the person's name. Today it asks the person inside the call,
 *                and a session may let it run unasked only where commands cannot make the call
 *                (`publishUnaskedProblem`). Over MCP every call could be a command's: it would have to
 *                ask every time, never "for this session", as it already does where Windlass does not
 *                sandbox commands.
 *   push         pushes the session's branch with the platform's token, under a lease on the platform's
 *                own last push. The token never leaves the platform and the branch is the platform's to
 *                name, so a command's call gains little; but a push is outward-facing, and every call would
 *                need the same branch and lease checks, a rate limit per turn, and a line in the timeline
 *                that says a process of the sandbox may have made it.
 *   fetch_base   reads the base into the workspace with a token the platform holds. Harmless as a read,
 *                but it writes refs in the workspace a command did not ask for; it would need a limit per
 *                turn and the same token handling (the token never enters the sandbox).
 *   file_plan    the planner's plan becomes subtasks the owner approves. A rogue plan would reach the
 *                owner's approval as the planner's; the planner runs only on Windlass today.
 *   file_review  the reviewer's verdict, read as a review of the change: a rogue filing could pass or
 *                block a pull request. It stays where only the model files it.
 */
export const TOOL_REACH: Readonly<Record<PlatformTool, "sandbox" | "host">> = Object.freeze({
	[REPORT_TOOL]: "sandbox",
	[ASK_TOOL]: "sandbox",
	[PUBLISH_TOOL]: "host",
	[PUSH_TOOL]: "host",
	[FETCH_BASE_TOOL]: "host",
	[PLAN_TOOL]: "host",
	[REVIEW_TOOL]: "host",
});

/** The tools that can be served over MCP, in the order they are listed. */
export const SANDBOX_TOOLS = Object.freeze((Object.keys(TOOL_REACH) as PlatformTool[]).filter(tool => TOOL_REACH[tool] === "sandbox"));

/** What the agent is told when the platform's own handling of a call of one of its tools failed. */
export const CALL_NOT_HANDLED = "The platform could not handle this call. Tell the user; do not try another way to do it.";
/** A call that came when the turn it was made in is over. */
export const CALL_AFTER_TURN = "The turn this call was made in has ended, so the platform did nothing with it.";
/** A call of a tool this turn was not given. */
export const CALL_UNKNOWN = "This session has no such tool of the platform's.";

/**
 * The tools a turn is offered, by the callbacks it was given: the planner's `file_plan` alone, the
 * reviewer's `file_review` alone, or `publish` in a person's session and `report` (with `ask_person`
 * for a builder) in an item's, with `push` and `fetch_base` beside either. With `reach` "sandbox",
 * only those that may be served from inside the sandbox.
 */
export function turnPlatformTools(input: RunTurnInput, reach: "host" | "sandbox" = "host"): Map<PlatformTool, PlatformToolHandler> {
	const tools = new Map<PlatformTool, PlatformToolHandler>();
	if (input.onPlan) tools.set(PLAN_TOOL, input.onPlan);
	else if (input.onReview) tools.set(REVIEW_TOOL, input.onReview);
	else {
		if (input.onPublish) tools.set(PUBLISH_TOOL, input.onPublish);
		else if (input.onReport) {
			tools.set(REPORT_TOOL, input.onReport);
			if (input.onAsk) tools.set(ASK_TOOL, input.onAsk);
		}
		if (input.onPush && input.onFetchBase) {
			tools.set(PUSH_TOOL, input.onPush);
			tools.set(FETCH_BASE_TOOL, input.onFetchBase);
		}
	}
	if (reach === "sandbox") for (const tool of tools.keys()) if (TOOL_REACH[tool] !== "sandbox") tools.delete(tool);
	return tools;
}

/** The declarations of a turn's tools (agent-publish.ts, `platformTools`). */
export function platformToolDeclarations(tools: ReadonlyMap<string, unknown>, options: { screenshots?: boolean; crossRepo?: boolean } = {}): HostToolDeclaration[] {
	const plan = tools.has(PLAN_TOOL);
	return platformTools({
		plan, ...(options.crossRepo && plan && { crossRepo: true }),
		publish: tools.has(PUBLISH_TOOL), report: tools.has(REPORT_TOOL), push: tools.has(PUSH_TOOL),
		review: tools.has(REVIEW_TOOL), ask: tools.has(ASK_TOOL), screenshots: options.screenshots,
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
 * it. A call is run by the same handler a Windlass host call is (`runPlatformTool`).
 */
export class PlatformMcpServer {
	private readonly listed: Array<Record<string, unknown>>;
	constructor(private readonly tools: ReadonlyMap<string, PlatformToolHandler>, declarations: HostToolDeclaration[], private readonly live: () => boolean) {
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
				return { result: { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: { listChanged: false } }, serverInfo: { name: PUBLISH_SERVER, version: "1" }, ttlMs: 0, cacheScope: "private" } };
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
				const call: TurnPublishRequest = { messageId: "", callId: typeof params.requestId === "string" ? params.requestId : "", arguments: callArguments(inner.arguments) };
				const done = await runPlatformTool(handler, call, signal);
				return text(done.output, !done.ok);
			}
			default:
				return mcpError(-32601, "Method not found");
		}
	}
}
