import { describe, expect, it } from "vitest";
import { runToFeed, splitRuns, withSummary } from "../api/feed";
import { fixture } from "../api/fixtures";
import { applyDelta, applyItem, emptyView, type Block, type ReasoningBlock, type TextBlock, type ToolBlock, type TurnView } from "./timeline";
import { joinsWork, liveStep, summarizeWork, turnRows } from "./workGroups";

let next = 0;
const tool = (name: string, input: Record<string, unknown>, patch: Partial<ToolBlock> = {}): ToolBlock => ({
	kind: "tool",
	id: `b${++next}`,
	at: null,
	messageId: "a1",
	callId: `c${next}`,
	name,
	inputText: JSON.stringify(input),
	state: "done",
	interrupted: false,
	outcome: "success",
	effect: null,
	sandboxed: null,
	startedAt: null,
	durationMs: 100,
	progress: null,
	output: null,
	display: null,
	truncated: null,
	refusal: null,
	question: null,
	answer: null,
	stopRequested: false,
	stoppedByUser: false,
	subagent: null,
	...patch,
});
const text = (words: string, streaming = false): TextBlock => ({ kind: "text", id: `b${++next}`, at: null, messageId: "a1", text: words, streaming });
const thought = (words: string, streaming = false): ReasoningBlock => ({ kind: "reasoning", id: `b${++next}`, at: null, messageId: "a1", text: words, streaming });
const read = (path: string, patch: Partial<ToolBlock> = {}) => tool("read", { path }, patch);
const shell = (command: string, patch: Partial<ToolBlock> = {}) => tool("shell", { command }, patch);

const shape = (blocks: Block[]) => turnRows(blocks).map((row) => (row.kind === "work" ? row.blocks.map((block) => block.id) : row.block.id));

describe("rows of work", () => {
	it("folds the settled calls between two things the agent said into one row, with the reasoning among them", () => {
		const blocks = [text("Looking."), thought("**Where**"), read("a.ts"), read("b.ts"), text("Found it."), shell("bun test")];
		const [said, why, a, b, found, test] = blocks.map((block) => block.id);
		expect(shape(blocks)).toEqual([said, [why, a, b], found, test]);
		// Keyed by its first block, so that it stays open as calls join it.
		expect(turnRows(blocks)[1]).toMatchObject({ kind: "work", id: `work-${why}` });
	});

	it("leaves a single call, and reasoning with no calls, as they are", () => {
		const blocks = [thought("**A**"), read("a.ts"), text("Done."), thought("**B**"), thought("**C**")];
		expect(turnRows(blocks).every((row) => row.kind === "block")).toBe(true);
		expect(turnRows(blocks).map((row) => (row.kind === "block" ? row.index : -1))).toEqual([0, 1, 2, 3, 4]);
	});

	it("keeps out every call the reader has to see: running, waiting, asking, answered, refused, subagents and the platform's own tools", () => {
		const standalone = [
			read("a.ts", { state: "running" }),
			read("a.ts", { state: "input" }),
			read("a.ts", { state: "queued" }),
			read("a.ts", { state: "asking" }),
			read("a.ts", { state: "refused" }),
			shell("curl example.com", { question: { title: "Allow network?", subject: "curl", details: [], choices: [] } }),
			shell("curl example.com", { answer: { choice: "allow", approve: true, note: null, by: "user", platformText: null, remembers: null } }),
			shell("rm -rf /", { state: "failed", refusal: { reason: "policy", needs: [], text: "Refused." } }),
			tool("subagent", { task: "Look" }, { subagent: { spawnId: "s", sessionId: "x", background: false, state: "completed", detail: null, startedAt: null, durationMs: null, usage: null, work: emptyView() } }),
			tool("push", { message: "Fix" }),
			tool("fetch_base", {}),
			thought("**Still**", true),
		];
		for (const block of standalone) expect(joinsWork(block)).toBe(false);
		// And the one a question is open about now.
		const asked = read("a.ts");
		expect(joinsWork(asked, (block) => block.id === asked.id)).toBe(false);
		// A failed call is folded with the rest: the row says how many failed.
		expect(joinsWork(shell("bun test", { state: "failed", outcome: "error" }))).toBe(true);
	});

	it("ends a row at a running call, so that it is drawn on its own and joins the row once it settles", () => {
		const a = read("a.ts");
		const b = read("b.ts");
		const running = shell("bun run build", { state: "running" });
		expect(shape([a, b, running])).toEqual([[a.id, b.id], running.id]);
		expect(shape([a, b, { ...running, state: "done" }])).toEqual([[a.id, b.id, running.id]]);
	});
});

describe("what a row of work says", () => {
	it("counts files once, commands and searches by the call, in the order they came", () => {
		const summary = summarizeWork([read("a.ts"), tool("grep", { pattern: "x", path: "src" }), read("b.ts"), read("a.ts"), tool("edit", { path: "a.ts" }), tool("write", { path: "a.ts" }), shell("bun test", { durationMs: 2400 })]);
		expect(summary).toEqual({ text: "Read 2 files, searched once, changed 1 file and ran 1 command", calls: 7, failed: 0, durationMs: 3000 });
		expect(summarizeWork([tool("glob", { pattern: "*" }), tool("grep", { pattern: "y" }), tool("search", { query: "z" })]).text).toBe("Searched 3 times");
		expect(summarizeWork([tool("fetch", { url: "https://example.com" }), tool("fetch", { url: "https://example.org" })]).text).toBe("Fetched 2 pages");
	});

	it("spells out four kinds at most, and past that three and the rest counted", () => {
		const summary = summarizeWork([read("a.ts"), shell("ls"), tool("edit", { path: "a.ts" }), tool("fetch", { url: "u" }), tool("harbor.lookup", { id: 1 }), tool("harbor.lookup", { id: 2 })]);
		expect(summary.text).toBe("Read 1 file, ran 1 command, changed 1 file and 3 more calls");
	});

	it("counts a call that failed or a command that exited non-zero, and leaves out a time nobody reported", () => {
		const summary = summarizeWork([shell("bun test", { state: "failed", display: { exitCode: 1 } }), shell("bun lint", { display: { exitCode: 2 } }), shell("ls", { display: { exitCode: 0 }, durationMs: null })]);
		expect(summary).toMatchObject({ text: "Ran 3 commands", failed: 2, durationMs: 200 });
		expect(summarizeWork([read("a.ts", { durationMs: null })]).durationMs).toBeNull();
	});
});

describe("what the agent does now", () => {
	const live = (blocks: Block[], end: TurnView["end"] = null): TurnView => ({ turn: 1, blocks, steps: 3, stepOpen: false, interruptRequested: false, changedFiles: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, end, platformAnswer: null });

	it("says the running call and what it acts on, or that it thinks, writes or prepares a call", () => {
		expect(liveStep(live([read("a.ts"), shell("bun run build", { state: "running" })]))).toEqual({ words: "running", target: "bun run build" });
		expect(liveStep(live([read("src/a.ts", { state: "running" })]))).toEqual({ words: "reading", target: "src/a.ts" });
		expect(liveStep(live([tool("harbor.lookup", { query: "tide" }, { state: "running" })]))).toEqual({ words: "calling harbor.lookup", target: "tide" });
		expect(liveStep(live([tool("harbor.lookup", { id: 1 }, { state: "running" })]))).toEqual({ words: "calling harbor.lookup", target: null });
		expect(liveStep(live([text("Hm"), thought("…", true)]))).toEqual({ words: "thinking", target: null });
		expect(liveStep(live([text("Fixing", true)]))).toEqual({ words: "writing", target: null });
		expect(liveStep(live([shell("", { state: "input", inputText: '{"comm' })]))).toEqual({ words: "preparing a call", target: null });
	});

	it("says nothing more than working between steps, while a question waits, and once the turn ended", () => {
		expect(liveStep(live([read("a.ts")]))).toBeNull();
		expect(liveStep(live([shell("curl", { state: "asking" })]))).toBeNull();
		expect(liveStep(null)).toBeNull();
		expect(liveStep(live([shell("bun test", { state: "running" })], { at: 1, outcome: "succeeded", exitCode: null, steps: 1, durationMs: 1, usage: null, cachedShare: null, message: null, verified: null }))).toBeNull();
	});
});

describe("a recorded turn", () => {
	it("folds the find-and-fix run into its three runs of calls between what the agent said", () => {
		const events = splitRuns(withSummary(fixture("demo-find-and-fix-a-failing-test")))[0] ?? [];
		const view = runToFeed(events, { turn: 1, afterSeq: 0, at: 1_000_000 }).reduce((built, entry) => ("item" in entry ? applyItem(built, entry.item) : applyDelta(built, entry.delta)), emptyView());
		const blocks = view.turns[0]?.blocks ?? [];
		const rows = turnRows(blocks);
		const works = rows.filter((row) => row.kind === "work");
		expect(works.map((row) => summarizeWork(row.blocks).text)).toEqual(["Searched once, ran 1 command and read 1 file", "Changed 1 file and ran 1 command"]);
	});
});
