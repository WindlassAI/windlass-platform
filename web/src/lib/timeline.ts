/**
 * The timeline reducer: a pure fold from a session's stored timeline (`TimelineItem`) and its live
 * streaming output (`LiveDelta`) to the view the session screen draws.
 *
 * Rules it keeps:
 * - A stored item is applied once: an item whose `seq` is not above the last one applied is ignored,
 *   and a jump in `seq` sets `gap`, which tells the caller to take a fresh snapshot.
 * - Streaming text, reasoning and tool input are provisional. The durable event that ends each one
 *   (`text.ended`, `reasoning.ended`, `tool.called`) carries the whole value and replaces what the
 *   deltas built, so nothing is ever shown twice.
 * - A tool call is keyed by (messageId, callId): providers reuse call IDs from one step to the next.
 * - `tool.progress` replaces the previous progress text of its call; it is not appended.
 * - A run of the repository's setup command is two stored items with one id, and between them the
 *   platform's `setup.output` deltas, each appended; the ending item's output replaces what they built.
 *
 * Nothing here touches the DOM, the clock or the network.
 */
import { SETUP_OUTPUT_CHARS, type LiveDelta, type SessionSnapshot, type TimelineItem, type TurnOutcome, type TurnUsage, type WindlassEvent } from "@contract";

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

export type ToolState =
	/** The model is still writing the call's arguments. */
	| "input"
	/** Called, not yet started (waiting for its turn or for the approval layer). */
	| "queued"
	/** A question was put to the user. */
	| "asking"
	| "running"
	| "done"
	| "failed"
	/** Never ran: the approval layer said no, or nobody was there to say yes. */
	| "refused";

/** One answer a question offered, as `approval.requested` recorded it. */
export interface ToolQuestionChoice {
	id: string;
	label: string;
	approve: boolean;
	remembers: string | null;
}

/** The question a call put to the user (`approval.requested`): what it showed, word for word. */
export interface ToolQuestion {
	title: string;
	subject: string;
	details: string[];
	choices: ToolQuestionChoice[];
}

/** How a question was settled (`approval.answered`). */
export interface ToolAnswer {
	choice: string;
	approve: boolean;
	note: string | null;
	/** "platform": nobody answered in time and the platform declined on the user's behalf. */
	by: "user" | "platform";
	/** The platform's own line about it, when it declined. */
	platformText: string | null;
	/** What the choice remembers, from the question's choices; null when nothing. */
	remembers: string | null;
}

export interface ToolRefusal {
	reason: "policy" | "unattended";
	/** What the call needed, as phrases: "running a command without the sandbox". */
	needs: string[];
	/** One sentence fit to show. */
	text: string;
}

interface BlockBase {
	/** Stable across updates; unique within the view. */
	id: string;
	at: number | null;
}

export interface UserBlock extends BlockBase {
	kind: "user";
	text: string;
	model: string;
	effort: string | null;
	/** Sent while the turn was running: the model reads it at its next step. */
	steer: boolean;
}

export interface PlatformBlock extends BlockBase {
	kind: "platform";
	level: "info" | "warn" | "error";
	text: string;
}

export interface ReasoningBlock extends BlockBase {
	kind: "reasoning";
	messageId: string;
	text: string;
	streaming: boolean;
}

export interface TextBlock extends BlockBase {
	kind: "text";
	messageId: string;
	text: string;
	streaming: boolean;
}

export interface ToolBlock extends BlockBase {
	kind: "tool";
	messageId: string;
	callId: string;
	name: string;
	/** The argument text as the model wrote it: JSON, partial while `state` is "input". */
	inputText: string;
	state: ToolState;
	/** The call ended because the turn was stopped or cut off, not because of what it did. */
	interrupted: boolean;
	outcome: "success" | "error" | "not_started" | "effect_unknown" | null;
	effect: string | null;
	/** `true`: ran in Windlass's own sandbox. `false`: ran without it. `null`: not recorded. */
	sandboxed: boolean | null;
	startedAt: number | null;
	durationMs: number | null;
	/** Output so far while the call runs. */
	progress: string | null;
	/** The final output, as the model read it. */
	output: string | null;
	display: Record<string, unknown> | null;
	truncated: { originalBytes: number; originalLines: number } | null;
	refusal: ToolRefusal | null;
	/** The question this call put to the user, if it asked one. */
	question: ToolQuestion | null;
	/** How that question was settled, once it was. */
	answer: ToolAnswer | null;
	/** The user asked for this one call to stop (`tool.cancel_requested`) and it has not settled yet. */
	stopRequested: boolean;
	/** The call settled after the user stopped it: it ended because of them, not because it failed. */
	stoppedByUser: boolean;
}

export interface CheckResult {
	name: string;
	command: string;
	status: string;
	exitCode: number | null;
	durationMs: number;
}

export interface ChecksBlock extends BlockBase {
	kind: "checks";
	run: number;
	names: string[];
	state: "running" | "passed" | "failed" | "error";
	results: CheckResult[];
	/** What the harness told the model about the failing checks, when it did. */
	report: string | null;
	/** Set for "error": why the run produced no results. */
	message: string | null;
}

export interface NoticeBlock extends BlockBase {
	kind: "notice";
	noticeKind: string;
	title: string;
	text: string;
}

export interface ErrorBlock extends BlockBase {
	kind: "error";
	title: string;
	message: string;
	/** Small print: HTTP status, provider code, request ID. */
	detail: string | null;
}

/** A quiet line about what Windlass did around the model's work. */
export interface NoteBlock extends BlockBase {
	kind: "note";
	tone: "dim" | "warn";
	text: string;
}

/** A run of the repository's setup command in the session's new sandbox, by the platform and before the agent started there. */
export interface SetupBlock extends BlockBase {
	kind: "setup";
	setupId: string;
	command: string;
	/** "cut_off": the turn ended and nothing said how the run did; the server stopped under it. */
	state: "running" | "succeeded" | "failed" | "timed_out" | "stopped" | "cut_off";
	exitCode: number | null;
	durationMs: number | null;
	/** How long it may run before the platform stops it. */
	limitMs: number;
	/** What it printed: so far while it runs, then the end of it as the platform kept it. */
	output: string;
	/** True when it printed more than `output` holds. */
	truncated: boolean;
}

export type Block = UserBlock | PlatformBlock | ReasoningBlock | TextBlock | ToolBlock | ChecksBlock | NoticeBlock | ErrorBlock | NoteBlock | SetupBlock;

export interface TurnEnd {
	at: number;
	outcome: TurnOutcome;
	exitCode: number | null;
	steps: number | null;
	durationMs: number;
	usage: TurnUsage | null;
	cachedShare: number | null;
	message: string | null;
}

export interface TurnView {
	turn: number;
	blocks: Block[];
	/** Model calls started in this turn. */
	steps: number;
	interruptRequested: boolean;
	/** `verification.status` of the execution's ending: what "done" rests on. */
	verification: string | null;
	/** Files the turn changed, from `workspace.changes`. */
	changedFiles: string[] | null;
	/** Tokens of the turn's finished model calls, added up as they end. */
	usage: TurnUsage;
	end: TurnEnd | null;
	/**
	 * The platform said it declined a question nobody answered, and the call's `approval.answered` has
	 * not arrived yet: the key of that call and the platform's words.
	 */
	platformDecline: { key: string; text: string } | null;
}

/** One model call, for the cache-per-call chart. */
export interface ModelCall {
	turn: number;
	messageId: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	/** The call ended without completing (`step.failed`, `step.refused`). */
	failed: boolean;
}

export interface SessionView {
	/** The platform `seq` of the last stored item applied. */
	lastSeq: number;
	/** A stored item arrived out of sequence: items were lost, take a fresh snapshot. */
	gap: boolean;
	turns: TurnView[];
	/** Every model call that reported usage, oldest first. */
	calls: ModelCall[];
	windlassSessionId: string | null;
	cwd: string | null;
	/** Windlass said once that untrusted content is in the conversation (`taint.noticed`). */
	tainted: boolean;
	nextId: number;
}

export const ZERO_USAGE: TurnUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

export function emptyView(): SessionView {
	return { lastSeq: 0, gap: false, turns: [], calls: [], windlassSessionId: null, cwd: null, tainted: false, nextId: 1 };
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/** The view of a snapshot: the stored timeline, then the streaming state of the turn in progress. */
export function fromSnapshot(snapshot: Pick<SessionSnapshot, "timeline" | "pending" | "windlassSessionId">): SessionView {
	let view = emptyView();
	for (const item of snapshot.timeline) view = applyItem(view, item);
	for (const delta of snapshot.pending) view = applyDelta(view, delta);
	if (snapshot.windlassSessionId !== null && view.windlassSessionId === null) view = { ...view, windlassSessionId: snapshot.windlassSessionId };
	// A snapshot is whole by definition, whatever numbering its first item has.
	return view.gap ? { ...view, gap: false } : view;
}

/** Applies one stored timeline entry. */
export function applyItem(view: SessionView, item: TimelineItem): SessionView {
	if (item.seq <= view.lastSeq) return view;
	const gap = view.gap || (view.lastSeq > 0 && item.seq !== view.lastSeq + 1);
	const draft = new Draft({ ...view, lastSeq: item.seq, gap });
	switch (item.kind) {
		case "user":
			draft.push(item.turn, { kind: "user", at: item.at, text: item.text, model: item.model, effort: item.effort, steer: item.steer === true });
			break;
		case "platform": {
			// The platform declining a question nobody answered is told once, with the call's answer. Its
			// line carries a code and names the call, so nothing rests on its wording.
			if (item.code === "question_expired" && item.call) draft.patchTurn(item.turn, { platformDecline: { key: callKey(item.call), text: item.text } });
			else draft.push(item.turn, { kind: "platform", at: item.at, level: item.level, text: item.text });
			break;
		}
		case "windlass":
			applyEvent(draft, item.turn, item.event, typeof item.event.time === "number" ? item.event.time : item.at);
			break;
		case "setup": {
			const running = draft.find(item.turn, isSetup(item.id));
			if (item.state === "started") {
				if (!running) draft.push(item.turn, { kind: "setup", at: item.at, setupId: item.id, command: item.command, state: "running", exitCode: null, durationMs: null, limitMs: item.limitMs, output: "", truncated: false });
				break;
			}
			const ended = { state: item.state, exitCode: item.exitCode, durationMs: item.durationMs, output: item.output, truncated: item.truncated };
			if (running) draft.replace(item.turn, running, ended);
			else draft.push(item.turn, { kind: "setup", at: item.at, setupId: item.id, command: item.command, limitMs: item.limitMs, ...ended });
			break;
		}
		case "turn.ended":
			endTurn(draft, item);
			break;
	}
	return draft.view;
}

/** Applies one piece of streaming output. */
export function applyDelta(view: SessionView, delta: LiveDelta): SessionView {
	const draft = new Draft(view);
	applyEvent(draft, delta.turn, delta.event, null);
	return draft.view;
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
	};
}

/** A turn's tokens: what its ending reported, or what its model calls add up to while it runs. */
export function turnUsage(turn: TurnView): TurnUsage {
	return turn.end?.usage ?? turn.usage;
}

export function sessionUsage(view: SessionView): TurnUsage {
	return view.turns.reduce((sum, turn) => addUsage(sum, turnUsage(turn)), ZERO_USAGE);
}

export function lastTurn(view: SessionView): TurnView | null {
	return view.turns.at(-1) ?? null;
}

/** Share of input tokens read from the cache, 0..1, or null when there was no input. */
export function cachedShare(usage: TurnUsage): number | null {
	return usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : null;
}

export function toolBlocks(turn: TurnView): ToolBlock[] {
	return turn.blocks.filter((block): block is ToolBlock => block.kind === "tool");
}

// ---------------------------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------------------------

type NewBlock<B extends Block = Block> = B extends Block ? Omit<B, "id"> : never;

/**
 * Copy-on-write access to a view: every change replaces the view, the turn and the block it touches
 * and shares the rest, so a caller can compare references to see what changed.
 */
class Draft {
	view: SessionView;
	constructor(view: SessionView) {
		this.view = view;
	}

	set(patch: Partial<SessionView>): void {
		this.view = { ...this.view, ...patch };
	}

	turn(number: number): TurnView {
		const found = this.view.turns.find((turn) => turn.turn === number);
		if (found) return found;
		const created: TurnView = { turn: number, blocks: [], steps: 0, interruptRequested: false, verification: null, changedFiles: null, usage: ZERO_USAGE, end: null, platformDecline: null };
		const turns = [...this.view.turns, created].sort((a, b) => a.turn - b.turn);
		this.view = { ...this.view, turns };
		return created;
	}

	patchTurn(number: number, patch: Partial<TurnView>): void {
		const current = this.turn(number);
		this.view = { ...this.view, turns: this.view.turns.map((turn) => (turn === current ? { ...turn, ...patch } : turn)) };
	}

	push(number: number, block: NewBlock): void {
		const turn = this.turn(number);
		const id = `b${this.view.nextId}`;
		this.view = { ...this.view, nextId: this.view.nextId + 1 };
		this.patchTurn(number, { blocks: [...turn.blocks, { ...block, id } as Block] });
	}

	/** The last block of the turn that matches, if any. */
	find<B extends Block>(number: number, match: (block: Block) => block is B): B | undefined {
		return this.turn(number).blocks.findLast(match);
	}

	replace<B extends Block>(number: number, block: B, patch: Partial<B>): void {
		const turn = this.turn(number);
		this.patchTurn(number, { blocks: turn.blocks.map((candidate) => (candidate === block ? ({ ...block, ...patch } as Block) : candidate)) });
	}

	mapBlocks(number: number, map: (block: Block) => Block): void {
		const turn = this.turn(number);
		let changed = false;
		const blocks = turn.blocks.map((block) => {
			const next = map(block);
			if (next !== block) changed = true;
			return next;
		});
		if (changed) this.patchTurn(number, { blocks });
	}
}

const isStreamingText = (messageId: string) => (block: Block): block is TextBlock => block.kind === "text" && block.messageId === messageId && block.streaming;
const isStreamingReasoning = (messageId: string) => (block: Block): block is ReasoningBlock => block.kind === "reasoning" && block.messageId === messageId && block.streaming;
const isCall = (messageId: string, callId: string) => (block: Block): block is ToolBlock => block.kind === "tool" && block.messageId === messageId && block.callId === callId;
const isChecksRun = (run: number) => (block: Block): block is ChecksBlock => block.kind === "checks" && block.run === run;
const isSetup = (id: string) => (block: Block): block is SetupBlock => block.kind === "setup" && block.setupId === id;

function newTool(messageId: string, callId: string, name: string, at: number | null): NewBlock<ToolBlock> {
	return {
		kind: "tool",
		at,
		messageId,
		callId,
		name,
		inputText: "",
		state: "input",
		interrupted: false,
		outcome: null,
		effect: null,
		sandboxed: null,
		startedAt: null,
		durationMs: null,
		progress: null,
		output: null,
		display: null,
		truncated: null,
		refusal: null,
		question: null,
		answer: null,
		stopRequested: false,
		stoppedByUser: false,
	};
}

/** Identifies a call within a turn. */
export function callKey(call: { messageId: string; callId: string }): string {
	return `${call.messageId}/${call.callId}`;
}

/** The fields of an event: `data` for a durable one, the event itself for an ephemeral one. */
function fields(event: WindlassEvent): Record<string, unknown> {
	return isRecord(event.data) ? event.data : event;
}

function applyEvent(draft: Draft, turn: number, event: WindlassEvent, at: number | null): void {
	const data = fields(event);
	if (typeof event.sessionId === "string" && draft.view.windlassSessionId === null) draft.set({ windlassSessionId: event.sessionId });

	switch (event.type) {
		// ---- streaming -------------------------------------------------------------------------
		case "text.delta": {
			const messageId = str(data.messageId);
			const open = draft.find(turn, isStreamingText(messageId));
			if (open) draft.replace(turn, open, { text: open.text + str(data.text) });
			else draft.push(turn, { kind: "text", at, messageId, text: str(data.text), streaming: true });
			return;
		}
		case "reasoning.delta": {
			const messageId = str(data.messageId);
			const open = draft.find(turn, isStreamingReasoning(messageId));
			if (open) draft.replace(turn, open, { text: open.text + str(data.text) });
			else draft.push(turn, { kind: "reasoning", at, messageId, text: str(data.text), streaming: true });
			return;
		}
		case "tool.input.delta": {
			const messageId = str(data.messageId);
			const callId = str(data.callId);
			const call = draft.find(turn, isCall(messageId, callId));
			// Deltas after the durable call (a replayed `pending`) have nothing left to add.
			if (call && call.state !== "input") return;
			if (call) draft.replace(turn, call, { inputText: call.inputText + str(data.input), name: str(data.name) || call.name });
			else draft.push(turn, { ...newTool(messageId, callId, str(data.name), at), inputText: str(data.input) });
			return;
		}
		case "tool.progress": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (call && call.output === null) draft.replace(turn, call, { progress: str(data.text) });
			return;
		}
		// The platform's own: what a run of the repository's setup command printed since the delta before.
		case "setup.output": {
			const run = draft.find(turn, isSetup(str(data.id)));
			// One that arrives after the run's ending item has nothing to add: that item carries the output.
			if (!run || run.state !== "running") return;
			const output = run.output + str(data.text);
			const over = output.length > SETUP_OUTPUT_CHARS;
			draft.replace(turn, run, { output: over ? output.slice(-SETUP_OUTPUT_CHARS) : output, truncated: run.truncated || over });
			return;
		}

		// ---- model output ----------------------------------------------------------------------
		case "text.ended": {
			const messageId = str(data.messageId);
			const open = draft.find(turn, isStreamingText(messageId));
			if (open) draft.replace(turn, open, { text: str(data.text), streaming: false });
			else draft.push(turn, { kind: "text", at, messageId, text: str(data.text), streaming: false });
			return;
		}
		case "reasoning.ended": {
			const messageId = str(data.messageId);
			const open = draft.find(turn, isStreamingReasoning(messageId));
			if (open) draft.replace(turn, open, { text: str(data.text), streaming: false });
			else draft.push(turn, { kind: "reasoning", at, messageId, text: str(data.text), streaming: false });
			return;
		}

		// ---- tools -----------------------------------------------------------------------------
		case "tool.called": {
			const messageId = str(data.messageId);
			const callId = str(data.callId);
			const call = draft.find(turn, isCall(messageId, callId));
			const patch = { name: str(data.name), inputText: str(data.input), state: "queued" as const };
			if (call) draft.replace(turn, call, call.state === "input" ? patch : { name: patch.name, inputText: patch.inputText });
			else draft.push(turn, { ...newTool(messageId, callId, patch.name, at), ...patch });
			return;
		}
		case "tool.started": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (!call) return;
			const run = isRecord(data.run) ? data.run : null;
			draft.replace(turn, call, {
				state: "running",
				startedAt: at,
				effect: typeof data.effect === "string" ? data.effect : null,
				sandboxed: run === null || !("sandbox" in run) ? null : run.sandbox !== null,
			});
			return;
		}
		case "approval.requested": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (call) draft.replace(turn, call, { state: "asking", question: readQuestion(data.question) });
			return;
		}
		case "approval.answered": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (!call) return;
			const approve = data.approve === true;
			const choice = str(data.choice);
			const pending = draft.turn(turn).platformDecline;
			const byPlatform = !approve && pending !== null && pending.key === callKey(call);
			if (pending !== null && pending.key === callKey(call)) draft.patchTurn(turn, { platformDecline: null });
			const note = typeof data.note === "string" && data.note.trim() !== "" ? data.note.trim() : null;
			const answer: ToolAnswer = {
				choice,
				approve,
				note,
				by: byPlatform ? "platform" : "user",
				platformText: byPlatform ? pending.text : null,
				remembers: call.question?.choices.find((candidate) => candidate.id === choice)?.remembers ?? null,
			};
			draft.replace(turn, call, approve ? { state: "queued", answer } : { answer });
			return;
		}
		case "tool.cancel_requested": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (call && call.output === null) draft.replace(turn, call, { stopRequested: true });
			return;
		}
		case "approval.denied": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (call) draft.replace(turn, call, { refusal: describeRefusal(data) });
			return;
		}
		case "tool.settled": {
			const call = draft.find(turn, isCall(str(data.messageId), str(data.callId)));
			if (!call) return;
			const outcome = oneOf(data.outcome, ["success", "error", "not_started", "effect_unknown"] as const) ?? "error";
			const display = isRecord(data.display) ? data.display : null;
			const declined = call.answer !== null && !call.answer.approve;
			const refused = call.refusal !== null || declined || outcome === "not_started";
			// A call the user stopped that still ended on its own terms (a read cannot stop midway) is just done.
			const stoppedByUser = call.stopRequested && !refused && outcome !== "success";
			const reported = display !== null && typeof display.durationMs === "number" ? display.durationMs : null;
			const measured = at !== null && call.startedAt !== null ? Math.max(0, at - call.startedAt) : null;
			const truncation = isRecord(data.truncation) ? data.truncation : null;
			draft.replace(turn, call, {
				state: refused ? "refused" : outcome === "success" ? "done" : "failed",
				outcome,
				// A call settled after a stop was asked for (of the turn, or of this call) ended because of the stop.
				interrupted: !refused && outcome !== "success" && (draft.turn(turn).interruptRequested || stoppedByUser),
				stopRequested: false,
				stoppedByUser,
				output: str(data.output),
				progress: null,
				display,
				durationMs: refused ? null : (reported ?? measured),
				truncated: truncation === null ? null : { originalBytes: num(truncation.originalBytes), originalLines: num(truncation.originalLines) },
			});
			return;
		}

		// ---- steps -----------------------------------------------------------------------------
		case "step.started":
			draft.patchTurn(turn, { steps: draft.turn(turn).steps + 1 });
			return;
		case "step.ended":
			closeStreams(draft, turn, str(data.messageId));
			recordCall(draft, turn, str(data.messageId), data.usage, false);
			return;
		case "step.failed": {
			closeStreams(draft, turn, str(data.messageId));
			recordCall(draft, turn, str(data.messageId), data.usage, true);
			const error = isRecord(data.error) ? data.error : {};
			// An interrupted step is not an error to read: the turn's ending says it was stopped.
			if (error.kind === "interrupted") return;
			draft.push(turn, { kind: "error", at, ...describeStepError(error) });
			return;
		}
		case "step.refused":
			closeStreams(draft, turn, str(data.messageId));
			recordCall(draft, turn, str(data.messageId), data.usage, true);
			draft.push(turn, { kind: "error", at, title: "The provider refused to answer", message: str(data.message) || "It gave no reason.", detail: null });
			return;
		case "retry.scheduled": {
			const error = isRecord(data.error) ? data.error : {};
			const wait = num(data.delayMs);
			draft.push(turn, {
				kind: "note",
				at,
				tone: "warn",
				text: `${PROVIDER_ERROR_TITLES[str(error.kind)] ?? "The model call failed"}; trying again${wait >= 1000 ? ` in ${Math.round(wait / 1000)}s` : ""} (attempt ${num(data.attempt)}).`,
			});
			return;
		}

		// ---- execution -------------------------------------------------------------------------
		case "session.created":
			draft.set({ cwd: typeof data.cwd === "string" ? data.cwd : draft.view.cwd });
			return;
		case "execution.interrupt_requested":
			draft.patchTurn(turn, { interruptRequested: true });
			return;
		case "execution.succeeded":
		case "turn.ended": {
			const verification = isRecord(data.verification) ? data.verification : null;
			if (verification !== null) draft.patchTurn(turn, { verification: str(verification.status) || null });
			return;
		}
		case "execution.failed": {
			const handedIn = aboutHandedIn(str(data.message));
			const message = handedIn ? HANDED_IN_ERROR.message : str(data.message);
			const said = draft.turn(turn).blocks.some((block) => block.kind === "error" && block.message === message);
			if (said) return;
			const title = handedIn ? HANDED_IN_ERROR.title : data.cause === "approval" ? "Stopped: a call needed approval and nobody was there to give it" : "Windlass gave up on this turn";
			draft.push(turn, { kind: "error", at, title, message, detail: null });
			return;
		}
		case "synthetic.appended": {
			const origin = str(data.origin);
			// The stop marker repeats what the turn's ending says.
			if (origin === "interrupt") return;
			const text = contentText(data.content);
			if (origin === "check_report") {
				const checks = draft.find(turn, (block): block is ChecksBlock => block.kind === "checks");
				if (checks) draft.replace(turn, checks, { report: text });
				return;
			}
			draft.push(turn, { kind: "note", at, tone: "dim", text: firstLine(text) || `Windlass added a note (${origin}).` });
			return;
		}

		// ---- verification ----------------------------------------------------------------------
		case "checks.started":
			draft.push(turn, { kind: "checks", at, run: num(data.run), names: strings(data.checks), state: "running", results: [], report: null, message: null });
			return;
		case "checks.finished": {
			const evidence = isRecord(data.evidence) ? data.evidence : {};
			const results = (Array.isArray(evidence.checks) ? evidence.checks : []).filter(isRecord).map(
				(check): CheckResult => ({
					name: str(check.name),
					command: str(check.command),
					status: str(check.status),
					exitCode: typeof check.exitCode === "number" ? check.exitCode : null,
					durationMs: num(check.durationMs),
				}),
			);
			const state = results.every((result) => result.status === "passed") ? "passed" : "failed";
			const checks = draft.find(turn, isChecksRun(num(data.run)));
			if (checks) draft.replace(turn, checks, { state, results });
			else draft.push(turn, { kind: "checks", at, run: num(data.run), names: results.map((result) => result.name), state, results, report: null, message: null });
			return;
		}
		case "checks.failed": {
			const error = isRecord(data.error) ? data.error : {};
			const message = error.kind === "interrupted" ? "The checks were stopped before they finished." : describeStepError(error).message;
			const checks = draft.find(turn, isChecksRun(num(data.run)));
			if (checks) draft.replace(turn, checks, { state: "error", message });
			else draft.push(turn, { kind: "checks", at, run: num(data.run), names: [], state: "error", results: [], report: null, message });
			return;
		}

		// ---- stored ephemeral events -----------------------------------------------------------
		case "notice":
			draft.push(turn, { kind: "notice", at, noticeKind: str(data.kind), title: NOTICE_TITLES[str(data.kind)] ?? "Notice", text: str(data.message) });
			return;
		case "taint.noticed":
			// Windlass tells the user once; a repeat (a fork, a replay) adds nothing.
			if (draft.view.tainted) return;
			draft.set({ tainted: true });
			draft.push(turn, { kind: "notice", at, noticeKind: "taint", title: "Untrusted content is in this conversation", text: str(data.text) });
			return;
		case "taint.cleared":
			draft.set({ tainted: false });
			return;
		case "workspace.changes":
			draft.patchTurn(turn, { changedFiles: strings(data.files) });
			return;
		case "compaction.ended":
			draft.push(turn, { kind: "note", at, tone: "dim", text: "Earlier history was summarised to make room." });
			return;
		case "compaction.failed":
			draft.push(turn, { kind: "note", at, tone: "warn", text: "Summarising earlier history failed." });
			return;

		// Everything else (the inbox, the frozen prefix, snapshots, hooks, `cli.summary`, whose content
		// the platform's own `turn.ended` carries) changes nothing the conversation shows.
		default:
			return;
	}
}

function closeStreams(draft: Draft, turn: number, messageId: string): void {
	draft.mapBlocks(turn, (block) => ((block.kind === "text" || block.kind === "reasoning") && block.messageId === messageId && block.streaming ? { ...block, streaming: false } : block));
}

function recordCall(draft: Draft, turn: number, messageId: string, usage: unknown, failed: boolean): void {
	if (!isRecord(usage)) return;
	const call: ModelCall = {
		turn,
		messageId,
		inputTokens: num(usage.inputTokens),
		cachedInputTokens: num(usage.cachedInputTokens),
		outputTokens: num(usage.outputTokens),
		reasoningTokens: num(usage.reasoningTokens),
		failed,
	};
	draft.set({ calls: [...draft.view.calls, call] });
	draft.patchTurn(turn, { usage: addUsage(draft.turn(turn).usage, call) });
}

function endTurn(draft: Draft, item: Extract<TimelineItem, { kind: "turn.ended" }>): void {
	// Whatever is still open when the turn ends will never be closed by an event: close it here.
	draft.mapBlocks(item.turn, (block) => {
		if ((block.kind === "text" || block.kind === "reasoning") && block.streaming) return { ...block, streaming: false };
		if (block.kind === "tool" && (block.state === "input" || block.state === "queued" || block.state === "asking" || block.state === "running")) {
			return { ...block, state: "failed", interrupted: true, stopRequested: false, progress: null, output: block.output ?? block.progress };
		}
		if (block.kind === "checks" && block.state === "running") return { ...block, state: "error", message: "The checks did not finish." };
		if (block.kind === "setup" && block.state === "running") return { ...block, state: "cut_off" };
		return block;
	});
	draft.patchTurn(item.turn, {
		platformDecline: null,
		end: {
			at: item.at,
			outcome: item.outcome,
			exitCode: item.exitCode,
			steps: item.steps,
			durationMs: item.durationMs,
			usage: item.usage,
			cachedShare: item.cachedShare,
			message: item.message,
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const NOTICE_TITLES: Record<string, string> = {
	sandbox_unavailable: "Windlass's own sandbox is not available",
	approval_ignored: "A project file asked for a looser approval policy and was not followed",
	checks_not_run: "The project's checks were not run",
	no_closing_answer: "The model ended without a closing answer",
};

const PROVIDER_ERROR_TITLES: Record<string, string> = {
	rate_limit: "The provider is rate limiting",
	provider_internal: "The provider had an internal error",
	transport: "The connection to the provider failed",
	incomplete_stream: "The provider's answer was cut off",
	auth: "The ChatGPT sign-in was not accepted",
	usage_limit: "The usage limit is reached",
	content_policy: "The provider's content policy blocked the request",
	invalid_request: "The provider rejected the request",
	context_overflow: "The conversation no longer fits the model's context",
};

/**
 * A session's Windlass does not hold the ChatGPT sign-in: the platform hands each turn a short-lived
 * access token in a file. When Windlass cannot use it, its own words are for whoever handed the token
 * in (they name the variable WINDLASS_ACCESS_TOKEN_FILE and the file, and say to hand in a new token),
 * which is the platform and not the reader. The turn's ending says what the reader can do.
 */
const aboutHandedIn = (message: string) => message.includes("WINDLASS_ACCESS_TOKEN_FILE");
const HANDED_IN_ERROR = {
	title: "The access token of this turn could not be used",
	message: "Windlass runs on a short-lived access token of your ChatGPT sign-in, which the platform hands it. That token was rejected, or it ran out before the platform replaced it.",
};

function describeStepError(error: Record<string, unknown>): { title: string; message: string; detail: string | null } {
	if (error.kind === "provider" && isRecord(error.error)) {
		const provider = error.error;
		const detail = [typeof provider.status === "number" ? `HTTP ${provider.status}` : null, typeof provider.code === "string" ? provider.code : null, typeof provider.requestId === "string" ? `request ${provider.requestId}` : null]
			.filter((part): part is string => part !== null)
			.join(" · ");
		if (aboutHandedIn(str(provider.message))) return { ...HANDED_IN_ERROR, detail: detail || null };
		return { title: PROVIDER_ERROR_TITLES[str(provider.kind)] ?? "The model call failed", message: str(provider.message) || "The provider gave no message.", detail: detail || null };
	}
	if (error.kind === "crashed") return { title: "Windlass was cut off", message: "The process running this step stopped before the step finished.", detail: null };
	if (error.kind === "internal") return { title: "Windlass hit an internal error", message: str(error.message) || "No message was recorded.", detail: null };
	return { title: "The step did not complete", message: str(error.message) || "No reason was recorded.", detail: null };
}

/** Windlass's own phrases for what a call needed (`describeNeed` in its approval layer). */
function describeNeed(need: Record<string, unknown>): string {
	switch (need.kind) {
		case "exec-sandboxed":
			return "running a command";
		case "exec-unsandboxed":
			return "running a command without the sandbox";
		case "sandbox-network":
			return "network access for this command";
		case "sandbox-write":
			return `this command writing to ${str(need.path)}`;
		case "write":
			return typeof need.path === "string" ? `writing ${need.path}` : "writing files";
		case "read-hidden":
			return `reading ${str(need.path)}`;
		case "records":
			return "changing Windlass's own records";
		default:
			return typeof need.tool === "string" ? `using ${need.tool}` : "this call";
	}
}

function describeRefusal(data: Record<string, unknown>): ToolRefusal {
	const reason = data.reason === "unattended" ? "unattended" : "policy";
	const needs = (Array.isArray(data.needs) ? data.needs : []).filter(isRecord).map(describeNeed);
	const agentRefusal = isRecord(data.refusal) && typeof data.refusal.text === "string" ? data.refusal.text : null;
	let text: string;
	if (agentRefusal !== null) text = agentRefusal;
	else if (reason === "unattended") text = `Not run: it needed approval${needs.length > 0 ? ` for ${list(needs)}` : ""}, and nobody was there to give it.`;
	else text = `Not run: the approval policy does not allow ${needs.length > 0 ? list(needs) : "this call"}.`;
	if (data.stop === true) text += " The turn was ended because of it.";
	return { reason, needs, text };
}

function list(parts: string[]): string {
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function readQuestion(value: unknown): ToolQuestion | null {
	if (!isRecord(value)) return null;
	const choices = (Array.isArray(value.choices) ? value.choices : []).filter(isRecord).map(
		(choice): ToolQuestionChoice => ({
			id: str(choice.id),
			label: str(choice.label) || str(choice.id),
			approve: choice.approve === true,
			remembers: typeof choice.remembers === "string" && choice.remembers !== "" ? choice.remembers : null,
		}),
	);
	return { title: str(value.title), subject: str(value.subject), details: strings(value.details), choices };
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.map((part) => (part.type === "text" ? str(part.text) : ""))
		.join("");
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0]?.trim() ?? "";
}

// ---------------------------------------------------------------------------------------------
// Reading untyped event fields
// ---------------------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : null;
}
