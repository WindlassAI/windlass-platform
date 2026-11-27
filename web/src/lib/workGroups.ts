/**
 * How a turn's blocks are drawn: what the agent said stands on its own, and the calls it made
 * between two things it said are gathered into one row of work, folded, that says in a line what
 * they did ("Read 4 files, searched twice and ran 1 command"). The row opens to show each call.
 *
 * A call is gathered only once it has settled, and only when nothing about it needs the reader: a
 * call that runs, waits or asks stands alone, as does one that put a question to the user (its answer
 * is shown under it), one the approval layer refused, a subagent, and a call of the platform's own
 * tools (a push, a fetch of the base, a pull request). Finished reasoning is gathered with the calls
 * around it. Anything else (text, the user's words, checks, notices, errors, the platform's lines)
 * ends a group. A group of one call is drawn as that call.
 *
 * Nothing here touches the DOM, the clock or the network.
 */
import type { Block, ReasoningBlock, ToolBlock, TurnView } from "./timeline";
import { summarizeTool } from "./toolSummary";

export type WorkBlock = ToolBlock | ReasoningBlock;

export type TurnRow =
	| { kind: "block"; block: Block; index: number }
	| { kind: "work"; id: string; blocks: WorkBlock[] };

/** The platform's own tools: what they did (a push, a pull request) is said on their own row. */
const PLATFORM_TOOLS = new Set(["push", "fetch_base", "publish", "report"]);

const SETTLED = new Set<ToolBlock["state"]>(["done", "failed"]);

/** Whether a block can be folded into a row of work. `asking`: the call a question is open about now. */
export function joinsWork(block: Block, asking: ((block: ToolBlock) => boolean) | null = null): block is WorkBlock {
	if (block.kind === "reasoning") return !block.streaming;
	if (block.kind !== "tool") return false;
	if (!SETTLED.has(block.state) || block.subagent !== null || PLATFORM_TOOLS.has(block.name)) return false;
	if (block.question !== null || block.answer !== null || block.refusal !== null) return false;
	return !(asking?.(block) ?? false);
}

/**
 * A turn's blocks as rows: runs of work folded into one row each, everything else as it was. Each
 * row of work is keyed by its first block, so that it keeps whether it is open as the run grows.
 */
export function turnRows(blocks: Block[], asking: ((block: ToolBlock) => boolean) | null = null): TurnRow[] {
	const rows: TurnRow[] = [];
	let run: { block: WorkBlock; index: number }[] = [];
	const flush = () => {
		const calls = run.filter(entry => entry.block.kind === "tool").length;
		// A run with fewer than two calls is not worth a fold: its blocks are drawn as they are.
		if (calls >= 2) rows.push({ kind: "work", id: `work-${run[0]!.block.id}`, blocks: run.map(entry => entry.block) });
		else for (const entry of run) rows.push({ kind: "block", block: entry.block, index: entry.index });
		run = [];
	};
	blocks.forEach((block, index) => {
		if (joinsWork(block, asking)) run.push({ block, index });
		else {
			flush();
			rows.push({ kind: "block", block, index });
		}
	});
	flush();
	return rows;
}

type Kind = "read" | "change" | "run" | "search" | "fetch" | "other";

const KIND_OF: Record<string, Kind> = {
	read: "read",
	edit: "change",
	write: "change",
	delete: "change",
	move: "change",
	shell: "run",
	grep: "search",
	glob: "search",
	search: "search",
	fetch: "fetch",
};

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

const PHRASE: Record<Kind, (calls: number, targets: number) => string> = {
	read: (_, targets) => `read ${files(targets)}`,
	change: (_, targets) => `changed ${files(targets)}`,
	run: calls => `ran ${calls} ${calls === 1 ? "command" : "commands"}`,
	search: calls => `searched ${times(calls)}`,
	fetch: calls => `fetched ${calls} ${calls === 1 ? "page" : "pages"}`,
	other: calls => `called ${calls} ${calls === 1 ? "tool" : "tools"}`,
};

/** At most this many phrases are spelled out; past that, one fewer, and the rest counted. */
const PHRASES = 4;

export interface WorkSummary {
	/** One sentence: "Read 4 files, searched twice and ran 1 command". */
	text: string;
	calls: number;
	failed: number;
	/** The calls' own time, added up; null when none reported one. */
	durationMs: number | null;
}

/** The sentence and figures of a row of work. Files are counted once however often they were read or changed. */
export function summarizeWork(blocks: WorkBlock[]): WorkSummary {
	const kinds = new Map<Kind, { calls: number; targets: Set<string> }>();
	let calls = 0;
	let failed = 0;
	let durationMs: number | null = null;
	for (const block of blocks) {
		if (block.kind !== "tool") continue;
		calls++;
		if (block.state === "failed" || (typeof block.display?.exitCode === "number" && block.display.exitCode !== 0))
			failed++;
		if (block.durationMs !== null) durationMs = (durationMs ?? 0) + block.durationMs;
		const kind = KIND_OF[block.name] ?? "other";
		const entry = kinds.get(kind) ?? { calls: 0, targets: new Set<string>() };
		entry.calls++;
		entry.targets.add(summarizeTool(block).target || `${block.messageId}/${block.callId}`);
		kinds.set(kind, entry);
	}
	const phrases = [...kinds].map(([kind, entry]) => PHRASE[kind](entry.calls, entry.targets.size));
	const shown = phrases.length > PHRASES ? phrases.slice(0, PHRASES - 1) : phrases;
	const rest = [...kinds].slice(shown.length).reduce((sum, [, entry]) => sum + entry.calls, 0);
	const parts = rest > 0 ? [...shown, `${rest} more ${rest === 1 ? "call" : "calls"}`] : shown;
	const sentence =
		parts.length === 0
			? "thought"
			: parts.length === 1
				? parts[0]!
				: `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
	return { text: sentence.charAt(0).toUpperCase() + sentence.slice(1), calls, failed, durationMs };
}

const DOING: Record<Kind, string> = {
	read: "reading",
	change: "changing",
	run: "running",
	search: "searching",
	fetch: "fetching",
	other: "calling",
};

/**
 * What the agent is doing now, in a few words, from the last thing its live turn has: the call that
 * runs and what it acts on, or that it thinks or writes. Null when nothing says more than "working".
 */
export function liveStep(turn: TurnView | null): { words: string; target: string | null } | null {
	if (!turn || turn.end !== null) return null;
	for (let index = turn.blocks.length - 1; index >= 0; index--) {
		const block = turn.blocks[index]!;
		if (block.kind === "tool") {
			if (block.state === "running") {
				if (block.subagent) return { words: "waiting on a subagent", target: null };
				const target = summarizeTool(block).target;
				const kind = KIND_OF[block.name] ?? "other";
				// Arguments with no string to name them by are not worth a line: the call's row has them.
				return {
					words: kind === "other" ? `calling ${block.name || "a tool"}` : DOING[kind],
					target: target && !target.startsWith("{") ? target : null,
				};
			}
			if (block.state === "input" || block.state === "queued") return { words: "preparing a call", target: null };
			if (block.state === "asking") return null;
			return null;
		}
		if (block.kind === "reasoning") return block.streaming ? { words: "thinking", target: null } : null;
		if (block.kind === "text") return block.streaming ? { words: "writing", target: null } : null;
		if (block.kind === "user") return null;
	}
	return null;
}
