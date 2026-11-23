/**
 * A step limit for an agent whose engine has none the platform can set (Claude Code, OpenCode, Codex:
 * `HarnessCapabilities.steps` "platform"). Windlass stops itself at `_meta["windlass/maxSteps"]`; for these
 * agents the platform counts. A step is one tool call: each `tool_call` update with a call id not seen in
 * the turn, over every prompt of the turn (the platform's follow-ups after its checks included). The turn
 * may make `limit` of them; when the agent starts one more, the platform sends `session/cancel`, and the
 * turn ends unresolved with a note, as a Windlass turn at its limit does (`RunTurnResult.acp.stepLimit`).
 * What the agent counted is `turn.ended.steps` either way.
 */

export class StepCounter {
	private readonly calls = new Set<string>();
	/** Set once the turn went past its limit. */
	reached = false;

	constructor(readonly limit: number | undefined) {}

	/** One ACP update of the turn: true the moment it is a call past the limit, and only then. */
	count(update: { sessionUpdate?: unknown; toolCallId?: unknown }): boolean {
		if (update.sessionUpdate !== "tool_call" || typeof update.toolCallId !== "string" || this.calls.has(update.toolCallId)) return false;
		this.calls.add(update.toolCallId);
		if (this.reached || this.limit === undefined || this.calls.size <= this.limit) return false;
		this.reached = true;
		return true;
	}

	get steps(): number { return this.calls.size; }
}

/** The timeline's note when the platform stopped a turn at its step limit. */
export const stepLimitNote = (agent: string, limit: number) =>
	`${agent} started more than ${limit} tool calls in this turn, its step limit, so the platform stopped the turn. It ends unresolved; the next turn can carry on from here.`;
