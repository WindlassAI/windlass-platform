/** A session chooses its harness once. Its capabilities govern turn inputs, sign-in and storage. */
import { ASK_TOOL, FETCH_BASE_TOOL, PUBLISH_TOOL, PUSH_TOOL, REPORT_TOOL } from "../agent-publish.js";
import { REVIEW_TOOL } from "../factory/reviewer-task.js";
import type { RunTurnInput, RunTurnResult, SandboxHandle, SandboxLayer, Windlass } from "./api.js";
import type { HarnessId } from "../contract.js";
import { ACP_CAPABILITIES, AcpHarness } from "./acp-harness.js";
import { machineHarnesses } from "./harnesses.js";

export type { HarnessId } from "../contract.js";

/** One of the platform's tools (agent-publish.ts, and the reviewer's `file_review`). */
export type PlatformTool = typeof PUBLISH_TOOL | typeof REPORT_TOOL | typeof ASK_TOOL | typeof PUSH_TOOL | typeof FETCH_BASE_TOOL | typeof REVIEW_TOOL;

export interface HarnessCapabilities {
	/** What the timeline stores for its turns. */
	events: "windlass" | "acp";
	/** How the next turn continues the conversation: Windlass's resolve and resume, ACP's resume, ACP's load, or not at all. */
	resume: "windlass" | "resume" | "load" | "none";
	/** A message sent into a running turn. */
	steer: boolean;
	/** Stopping one tool call of a running turn. */
	cancelCall: boolean;
	/** Questions to whoever has the session open. */
	questions: boolean;
	/** Which of the platform's tools this harness can be given. Empty: none, and the person publishes from the side panel. */
	platformTools: readonly PlatformTool[];
	/** The reviewer's restricted session: no subagents, an agent profile of the platform's, required checks, host tools. */
	restrictedReview: boolean;
	/** How the user's own MCP servers reach it. */
	userServers: "config-file" | "session-new" | "none";
	/** Whether a project's own MCP servers wait for the person's approval before they start. */
	projectServerApproval: boolean;
	/** The user's saved checks, run before the turn is called done. */
	checks: "required" | "none";
	/** Named variables withheld from commands, and credential-looking ones passed to them (`withholdEnv`, `passEnv`). */
	envLists: boolean;
	/** A home of the session's own for its commands. */
	sessionHome: boolean;
	/** What a turn reports of its use: token counts, the context's fill, or nothing. */
	usage: "tokens" | "context" | "none";
	/** Where the models a prompt may name come from: the account's plan, or the harness's own list. */
	models: "account" | "harness";
	/** Whose sign-in a turn runs on: the user's ChatGPT sign-in handed in per turn, or one kept on the machine. */
	signIn: "chatgpt" | "machine";
	/** Whether its session is copied out of a sandbox that may be lost (`SandboxLayer.backups`). */
	backups: boolean;
	/** A step limit per turn (`RunTurnInput.maxSteps`). */
	stepLimit: boolean;
	/** A scripted model for a demo session (`Windlass.demoScript`). */
	demo: boolean;
}

export interface Harness {
	readonly id: HarnessId;
	/** What this sandbox's harness can do. Asked before each turn; it starts no session. */
	capabilities(sandbox: SandboxHandle): Promise<HarnessCapabilities>;
	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult>;
}

const WINDLASS_CAPABILITIES: HarnessCapabilities = Object.freeze({
	events: "windlass",
	resume: "windlass",
	steer: true,
	cancelCall: true,
	questions: true,
	platformTools: Object.freeze([PUBLISH_TOOL, REPORT_TOOL, ASK_TOOL, PUSH_TOOL, FETCH_BASE_TOOL, REVIEW_TOOL] as const),
	restrictedReview: true,
	userServers: "config-file",
	projectServerApproval: true,
	checks: "required",
	envLists: true,
	sessionHome: true,
	usage: "tokens",
	models: "account",
	signIn: "chatgpt",
	backups: true,
	stepLimit: true,
	demo: true,
});

/** Launch and admission decisions precede the sandbox. Neither harness runs a capability probe. */
export function capabilitiesOf(id: HarnessId = "windlass"): HarnessCapabilities {
	return id === "windlass" ? WINDLASS_CAPABILITIES : ACP_CAPABILITIES;
}

/** The layer's Windlass, unchanged. */
export class WindlassHarness implements Harness {
	readonly id = "windlass" as const;

	constructor(private readonly windlass: Windlass) {}

	async capabilities(_sandbox: SandboxHandle): Promise<HarnessCapabilities> {
		return WINDLASS_CAPABILITIES;
	}

	runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		return this.windlass.runTurn(sandbox, input);
	}
}

/** Select a harness only where the platform can start its sandbox. */
export function harnessOf(layer: SandboxLayer, id: HarnessId): Harness {
	if (id === "windlass") return new WindlassHarness(layer.windlass);
	const profile = machineHarnesses[id];
	if (!profile) throw new Error(`Unknown harness: ${id}`);
	if (!layer.machine) throw new Error(`${profile.name} runs only on a machine of yours.`);
	return new AcpHarness(profile, layer.machine.name);
}
