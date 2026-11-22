import type { AcpUpdate, LiveDelta, TimelineItem, WindlassEvent } from "@contract";
import { describe, expect, it } from "vitest";
import { unaskedNote } from "../../../server/src/personal-servers";
import { acpFixture } from "../api/acp-fixtures";
import { acpRunToFeed, isLive, runToFeed, splitRuns, withSummary, type AcpFeedEntry, type AcpFixture, type FeedEntry } from "../api/feed";
import { FIXTURES, fixture } from "../api/fixtures";
import {
	applyDelta,
	applyItem,
	emptyView,
	fromSnapshot,
	sessionUsage,
	toolBlocks,
	type Block,
	type ChecksBlock,
	type ErrorBlock,
	type NoticeBlock,
	type SessionView,
	type TextBlock,
	type ToolBlock,
	type TurnView,
} from "./timeline";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A fixture as a session's clients would receive it: one turn per recorded run (an ACP run gets its ending). */
function feedOf(name: string): FeedEntry[] {
	const feed: FeedEntry[] = [];
	let seq = 0;
	splitRuns(withSummary(fixture(name))).forEach((events, index) => {
		const entries = runToFeed(events, { turn: index + 1, afterSeq: seq, at: 1_000_000 + index * 60_000 });
		for (const entry of entries) if ("item" in entry) seq = entry.item.seq;
		feed.push(...entries);
	});
	return feed;
}

function apply(view: SessionView, entry: FeedEntry): SessionView {
	return "item" in entry ? applyItem(view, entry.item) : applyDelta(view, entry.delta);
}

function reduce(feed: FeedEntry[], from: SessionView = emptyView()): SessionView {
	return feed.reduce(apply, from);
}

const viewOf = (name: string) => reduce(feedOf(name));

/** The view without what depends on how it was built (block IDs, and `at`, which a delta does not carry). */
function shape(view: SessionView) {
	return {
		...view,
		nextId: 0,
		turns: view.turns.map((turn) => ({ ...turn, blocks: turn.blocks.map((block) => ({ ...block, id: "", at: null })) })),
	};
}

const turn = (view: SessionView, number = 1): TurnView => {
	const found = view.turns.find((candidate) => candidate.turn === number);
	if (!found) throw new Error(`no turn ${number}`);
	return found;
};
const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);
const texts = (blocks: Block[]) => blocks.filter((block): block is TextBlock => block.kind === "text");
const eventsOfType = (name: string, type: string): WindlassEvent[] => fixture(name).filter((event) => event.type === type);
const data = (event: WindlassEvent) => (event.data ?? event) as Record<string, unknown>;

const NAMES = Object.keys(FIXTURES);

// ---------------------------------------------------------------------------------------------
// Every fixture
// ---------------------------------------------------------------------------------------------

describe("every fixture", () => {
	it("is found", () => {
		expect(NAMES).toHaveLength(14);
	});

	describe.each(NAMES)("%s", (name) => {
		const feed = feedOf(name);
		const view = reduce(feed);

		it("leaves nothing open when its turns have ended", () => {
			expect(view.gap).toBe(false);
			expect(view.turns.length).toBe(splitRuns(fixture(name)).length);
			for (const one of view.turns) {
				expect(one.end).not.toBeNull();
				for (const block of one.blocks) {
					if (block.kind === "text" || block.kind === "reasoning") expect(block.streaming).toBe(false);
					if (block.kind === "tool") expect(["done", "failed", "refused"]).toContain(block.state);
					if (block.kind === "checks") expect(block.state).not.toBe("running");
				}
			}
		});

		it("shows each piece of text, reasoning and each tool call exactly once", () => {
			const blocks = view.turns.flatMap((one) => one.blocks);
			expect(texts(blocks).map((block) => block.text)).toEqual(eventsOfType(name, "text.ended").map((event) => data(event).text));
			expect(blocks.filter((block) => block.kind === "reasoning").map((block) => (block.kind === "reasoning" ? block.text : ""))).toEqual(eventsOfType(name, "reasoning.ended").map((event) => data(event).text));
			const called = eventsOfType(name, "tool.called");
			const tools = blocks.filter((block): block is ToolBlock => block.kind === "tool");
			expect(tools.map((block) => [block.name, block.inputText])).toEqual(called.map((event) => [data(event).name, data(event).input]));
		});

		it("pairs every tool call with its own result", () => {
			const settled = new Map(eventsOfType(name, "tool.settled").map((event) => [`${String(data(event).messageId)}/${String(data(event).callId)}`, data(event)]));
			const tools = view.turns.flatMap(toolBlocks);
			expect(tools).toHaveLength(settled.size);
			for (const block of tools) {
				const result = settled.get(`${block.messageId}/${block.callId}`);
				expect(result).toBeDefined();
				expect(block.output).toBe(result?.output);
				expect(block.outcome).toBe(result?.outcome);
				expect(block.progress).toBeNull();
			}
		});

		it("ends up the same whether or not the streaming deltas were seen", () => {
			const storedOnly = reduce(feed.filter((entry) => "item" in entry));
			expect(shape(view)).toEqual(shape(storedOnly));
		});

		it("can be picked up from a snapshot at any point", () => {
			// At every position: the stored timeline so far plus the deltas since the last durable event.
			const timeline: TimelineItem[] = [];
			let pending: LiveDelta[] = [];
			let live = emptyView();
			feed.forEach((entry, index) => {
				live = apply(live, entry);
				if ("item" in entry) {
					timeline.push(entry.item);
					if (entry.item.kind === "turn.ended" || (entry.item.kind === "windlass" && typeof entry.item.event.seq === "number")) pending = [];
				} else pending.push(entry.delta);
				if (index % 5 !== 0) return;
				const joined = fromSnapshot({ timeline: [...timeline], pending: [...pending], windlassSessionId: null });
				// Text streamed before the last durable event is not in `pending`; a late joiner sees it once its
				// durable event arrives. Everything the two views have in common must agree by the end.
				expect(shape(reduce(feed.slice(index + 1), joined))).toEqual(shape(view));
			});
		});

		it("records one model call per step that reported usage", () => {
			const steps = fixture(name).filter((event) => (event.type === "step.ended" || event.type === "step.failed") && data(event).usage !== null);
			expect(view.calls).toHaveLength(steps.length);
			expect(view.calls.map((call) => call.inputTokens)).toEqual(steps.map((event) => (data(event).usage as { inputTokens: number }).inputTokens));
		});

		it("never produces a streaming event as a stored item", () => {
			for (const entry of feed) if ("item" in entry && entry.item.kind === "windlass") expect(isLive(entry.item.event)).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------------------------
// What each scenario looks like
// ---------------------------------------------------------------------------------------------

describe("find and fix a failing test", () => {
	const view = viewOf("demo-find-and-fix-a-failing-test");
	const blocks = turn(view).blocks;
	const tools = toolBlocks(turn(view));

	it("lays the turn out in the order things happened", () => {
		expect(kinds(blocks)).toEqual(["user", "reasoning", "text", "tool", "tool", "tool", "text", "tool", "tool", "text"]);
		expect(blocks[0]).toMatchObject({ kind: "user", text: "The add test is failing. Find out why and fix it." });
		expect(blocks[1]).toMatchObject({ kind: "reasoning", streaming: false });
		expect(blocks.at(-1)).toMatchObject({ kind: "text", streaming: false });
	});

	it("keeps calls with a reused call ID apart, one per step", () => {
		// `call_1` is used in four different steps.
		expect(tools.map((block) => `${block.messageId}/${block.callId} ${block.name}`)).toEqual(["a1/call_1 grep", "a1/call_2 shell", "a2/call_1 read", "a3/call_1 edit", "a4/call_1 shell"]);
		expect(new Set(tools.map((block) => block.id)).size).toBe(5);
	});

	it("reads each call's state, result and duration", () => {
		const [grep, failing, read, edit, passing] = tools;
		expect(grep).toMatchObject({ state: "done", outcome: "success", effect: "read", durationMs: 220, display: { matches: 4, files: 3 } });
		expect(grep?.output).toContain("src/add.ts:1:export function add");
		// A command that exits non-zero is a failed call, with the duration Windlass measured.
		expect(failing).toMatchObject({ state: "failed", outcome: "error", interrupted: false, durationMs: 612, display: { exitCode: 1 } });
		expect(failing?.output).toContain("[Exit code 1]");
		expect(read).toMatchObject({ state: "done", display: { path: "src/add.ts", lines: 3 } });
		expect(edit).toMatchObject({ state: "done", effect: "write" });
		expect(passing).toMatchObject({ state: "done", durationMs: 540, display: { exitCode: 0 } });
	});

	it("adds the steps' tokens up to what the turn reported", () => {
		expect(view.calls).toHaveLength(5);
		expect(view.calls[0]).toMatchObject({ turn: 1, messageId: "a1", inputTokens: 8214, cachedInputTokens: 0, failed: false });
		expect(view.calls[4]).toMatchObject({ inputTokens: 9410, cachedInputTokens: 9216 });
		expect(turn(view).usage).toEqual({ inputTokens: 44746, cachedInputTokens: 35072, outputTokens: 396, reasoningTokens: 64 });
		expect(sessionUsage(view)).toEqual(turn(view).end?.usage);
	});

	it("ends with the summary of the turn", () => {
		expect(turn(view).end).toMatchObject({ outcome: "succeeded", steps: 5, durationMs: 10648, cachedShare: 0.784 });
		expect(turn(view).steps).toBe(5);
	});
});

describe("two parallel tool calls", () => {
	const feed = feedOf("demo-two-parallel-tool-calls");

	it("runs both at once and gives each its own result, though they settle out of order", () => {
		const settledAt = feed.findIndex((entry) => "item" in entry && entry.item.kind === "windlass" && entry.item.event.type === "tool.settled");
		const during = toolBlocks(turn(reduce(feed.slice(0, settledAt))));
		expect(during.map((block) => [block.callId, block.state])).toEqual([
			["call_1", "running"],
			["call_2", "running"],
		]);

		// call_2 settles first.
		const afterFirst = toolBlocks(turn(reduce(feed.slice(0, settledAt + 1))));
		expect(afterFirst.map((block) => [block.callId, block.state, block.output])).toEqual([
			["call_1", "running", null],
			["call_2", "done", "export const b = 2"],
		]);

		const done = toolBlocks(turn(reduce(feed)));
		expect(done.map((block) => [block.callId, block.inputText, block.output])).toEqual([
			["call_1", '{"path":"a.ts"}', "export const a = 1"],
			["call_2", '{"path":"b.ts"}', "export const b = 2"],
		]);
	});

	it("builds each call's input from its own deltas", () => {
		const firstCalled = feed.findIndex((entry) => "item" in entry && entry.item.kind === "windlass" && entry.item.event.type === "tool.called");
		// Two of the three input deltas of call_1 have arrived.
		const partial = toolBlocks(turn(reduce(feed.slice(0, firstCalled - 1))));
		expect(partial).toHaveLength(1);
		expect(partial[0]).toMatchObject({ callId: "call_1", name: "read", state: "input", inputText: '{"path":"a' });
	});
});

describe("streaming", () => {
	const feed = feedOf("demo-a-long-build-command");
	const indexOf = (type: string, nth = 0) => {
		let seen = 0;
		return feed.findIndex((entry) => {
			const event = "item" in entry ? (entry.item.kind === "windlass" ? entry.item.event : null) : entry.delta.event;
			return event?.type === type && seen++ === nth;
		});
	};

	it("streams text into one block and settles it in place", () => {
		const afterTwoDeltas = reduce(feed.slice(0, indexOf("text.delta", 1) + 1));
		const streaming = texts(turn(afterTwoDeltas).blocks);
		expect(streaming).toHaveLength(1);
		expect(streaming[0]?.streaming).toBe(true);
		expect("Running the build and the test suite.".startsWith(streaming[0]?.text ?? "?")).toBe(true);

		const ended = reduce(feed.slice(0, indexOf("text.ended") + 1));
		const settled = texts(turn(ended).blocks);
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({ id: streaming[0]?.id, streaming: false, text: "Running the build and the test suite." });
	});

	it("replaces a running call's progress rather than appending to it", () => {
		const third = reduce(feed.slice(0, indexOf("tool.progress", 2) + 1));
		const [call] = toolBlocks(turn(third));
		expect(call).toMatchObject({ state: "running", output: null });
		expect(call?.progress).toBe("$ tsc -p tsconfig.build.json\n$ bun build src/index.ts --outdir dist\n  dist/index.js  412.08 KB");

		const [done] = toolBlocks(turn(reduce(feed)));
		expect(done).toMatchObject({ state: "done", progress: null, durationMs: 9420, truncated: { originalLines: 4210, originalBytes: 312044 } });
		expect(done?.output).toContain("214 pass");
	});

	it("does not copy more than it changes", () => {
		const before = reduce(feed.slice(0, indexOf("tool.progress", 2)));
		const after = apply(before, feed[indexOf("tool.progress", 2)] as FeedEntry);
		expect(after).not.toBe(before);
		// The text block before the call is the same object: only the call was replaced.
		expect(turn(after).blocks[1]).toBe(turn(before).blocks[1]);
		expect(turn(after).blocks[2]).not.toBe(turn(before).blocks[2]);
	});
});

describe("a turn stopped while a tool is running", () => {
	const view = viewOf("demo-cancel-while-one-tool-is-running");

	it("marks the call as stopped, not as a failure of its own", () => {
		const [call] = toolBlocks(turn(view));
		expect(call).toMatchObject({ state: "failed", outcome: "error", interrupted: true, output: "Stopped by the user after 4 s. Output so far:\n12 pass\n" });
	});

	it("says it once: no error block, no stop marker, an interrupted ending", () => {
		expect(kinds(turn(view).blocks)).toEqual(["user", "tool"]);
		expect(turn(view).interruptRequested).toBe(true);
		expect(turn(view).end).toMatchObject({ outcome: "interrupted", steps: 1 });
	});

	it("still counts the model call that was cut short", () => {
		expect(view.calls).toEqual([{ turn: 1, messageId: "a1", inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10, failed: true }]);
	});
});

describe("a step the provider failed", () => {
	it("shows a usage limit as one readable error", () => {
		const view = viewOf("demo-a-non-retryable-error-usage-limit");
		const errors = turn(view).blocks.filter((block): block is ErrorBlock => block.kind === "error");
		// `step.failed` and `execution.failed` carry the same message; it is shown once.
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ title: "The usage limit is reached", message: "Usage limit reached; it resets in 3 hours.", detail: "HTTP 429" });
		expect(turn(view).end).toMatchObject({ outcome: "failed", usage: null });
		expect(view.calls).toHaveLength(0);
	});

	it("shows a rejected sign-in the same way", () => {
		const view = viewOf("demo-a-non-retryable-error-authentication");
		const errors = turn(view).blocks.filter((block): block is ErrorBlock => block.kind === "error");
		expect(errors).toEqual([expect.objectContaining({ title: "The ChatGPT sign-in was not accepted", message: "Signed out: sign in again to continue.", detail: "HTTP 401" })]);
	});

	it("shows an access token the platform handed in, and Windlass could not use, in words for the reader", () => {
		// What a `windlass acp` started with WINDLASS_ACCESS_TOKEN_FILE recorded when the token in the file ran out in the middle of a turn.
		const file = "/home/agent/.local/share/windlass/access-token-0123456789ab.json";
		const events: WindlassEvent[] = [
			{ type: "execution.started", v: 1, data: { executionId: "exe_1" }, sessionId: "ses_1", seq: 1, time: 1 },
			{ type: "step.started", v: 1, data: { messageId: "m1", model: "gpt-6.1-sol", attempt: 1 }, sessionId: "ses_1", seq: 2, time: 2 },
			{
				type: "step.failed",
				v: 1,
				data: {
					messageId: "m1",
					error: {
						kind: "provider",
						error: {
							kind: "auth",
							retryable: false,
							message: `no usable access token: The access token handed in through WINDLASS_ACCESS_TOKEN_FILE expired at 2026-11-14T20:00:22.352Z (${file}). Hand in a new token: write the output of \`windlass login token\`, run where the sign-in is saved, to that file.`,
							status: null,
							code: null,
							retryAfterMs: null,
							requestId: null,
						},
					},
					usage: null,
				},
				sessionId: "ses_1",
				seq: 3,
				time: 3,
			},
			{ type: "execution.failed", v: 1, data: { executionId: "exe_1", message: "Signed out: the access token handed in through WINDLASS_ACCESS_TOKEN_FILE was rejected or cannot be used. Hand in a new token to continue." }, sessionId: "ses_1", seq: 4, time: 4 },
		];
		const view = reduce(runToFeed(events, { turn: 1, afterSeq: 0, at: 1_000_000 }));
		const errors = turn(view).blocks.filter((block): block is ErrorBlock => block.kind === "error");
		// One error, not two, and nothing of the variable, the file or the instruction to hand in a token.
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ title: "The access token of this turn could not be used", detail: null });
		expect(errors[0]?.message).toMatch(/short-lived access token of your ChatGPT sign-in/);
		expect(JSON.stringify(errors)).not.toMatch(/WINDLASS_ACCESS_TOKEN_FILE|access-token-|Hand in/);
	});
});

describe("a refused call", () => {
	const view = viewOf("real-scripted-hardened");
	const [call] = toolBlocks(turn(view));

	it("is refused, with the reason in words", () => {
		expect(call).toMatchObject({ name: "shell", state: "refused", outcome: "error", interrupted: false, durationMs: null, startedAt: null });
		expect(call?.refusal).toEqual({
			reason: "unattended",
			needs: ["running a command without the sandbox"],
			text: "Not run: it needed approval for running a command without the sandbox, and nobody was there to give it.",
		});
		expect(call?.output).toContain("Not run");
	});

	it("carries the notice Windlass printed about the sandbox", () => {
		const notice = turn(view).blocks.find((block): block is NoticeBlock => block.kind === "notice");
		expect(notice).toMatchObject({ noticeKind: "sandbox_unavailable", title: "Windlass's own sandbox is not available" });
		expect(notice?.text).toContain("AppArmor");
	});

	it("still ends as a finished turn, with no token counts", () => {
		expect(turn(view).end).toMatchObject({ outcome: "succeeded", steps: 2, usage: null, cachedShare: null });
		expect(view.calls).toHaveLength(0);
		expect(view.windlassSessionId).toBe("ses_4b8aa56e35abff8a79333beb");
	});
});

describe("a sandboxed call", () => {
	const view = viewOf("real-scripted-bwrap");

	it("is marked as having run in Windlass's sandbox", () => {
		const [call] = toolBlocks(turn(view));
		expect(call).toMatchObject({ state: "done", sandboxed: true, effect: "exec", durationMs: 44 });
		expect(call?.output).toContain("NET_BLOCKED");
	});

	it("lists the files the turn changed", () => {
		expect(turn(view).changedFiles).toEqual(["made.txt"]);
	});
});

describe("the project's checks", () => {
	const view = viewOf("demo-the-checks-fail-the-model-fixes-the-code-and-they-pass");
	const checks = turn(view).blocks.filter((block): block is ChecksBlock => block.kind === "checks");

	it("shows both runs, the failing one with what the model was told", () => {
		expect(checks.map((block) => [block.run, block.state, block.names])).toEqual([
			[1, "failed", ["test"]],
			[2, "passed", ["test"]],
		]);
		expect(checks[0]?.results).toEqual([{ name: "test", command: "bun test", status: "failed", exitCode: 1, durationMs: 0 }]);
		expect(checks[0]?.report).toContain("Checks run by the harness after your changes: 1 failed.");
		expect(checks[1]?.report).toBeNull();
	});

	it("puts each run where it happened, between the model's steps", () => {
		expect(kinds(turn(view).blocks)).toEqual(["user", "tool", "text", "checks", "tool", "text", "checks"]);
	});
});

describe("two turns in one session", () => {
	const view = viewOf("demo-two-turns-in-one-session");

	it("keeps the turns apart", () => {
		expect(view.turns.map((one) => one.turn)).toEqual([1, 2]);
		expect(view.turns.map((one) => kinds(one.blocks))).toEqual([
			["user", "text"],
			["user", "text"],
		]);
		expect(view.turns.map((one) => texts(one.blocks)[0]?.text)).toEqual(["2", "4"]);
		expect((turn(view, 2).blocks[0] as { text: string }).text).toBe("And 2 + 2?");
	});

	it("adds the session's tokens across turns", () => {
		expect(sessionUsage(view)).toEqual({ inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 100, reasoningTokens: 20 });
		expect(view.calls.map((call) => call.turn)).toEqual([1, 2]);
	});
});

// ---------------------------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------------------------

describe("stored items", () => {
	const feed = feedOf("demo-several-steps-in-one-turn");
	const items = feed.flatMap((entry) => ("item" in entry ? [entry.item] : []));

	it("are applied once: a repeat changes nothing", () => {
		const view = items.slice(0, 8).reduce(applyItem, emptyView());
		const again = applyItem(view, items[7] as TimelineItem);
		expect(again).toBe(view);
		expect(items.slice(0, 8).reduce(applyItem, view)).toBe(view);
	});

	it("flag a gap in the numbering, and a snapshot clears it", () => {
		const view = [...items.slice(0, 5), ...items.slice(7, 9)].reduce(applyItem, emptyView());
		expect(view.gap).toBe(true);
		expect(view.lastSeq).toBe(items[8]?.seq);
		expect(fromSnapshot({ timeline: items, pending: [], windlassSessionId: "ses_demo" }).gap).toBe(false);
	});

	it("do not flag a gap when the first item seen is not the first of the session", () => {
		expect(items.slice(4).reduce(applyItem, emptyView()).gap).toBe(false);
	});
});

describe("a turn the platform ended", () => {
	it("closes whatever was still open", () => {
		const feed = feedOf("demo-a-long-build-command");
		const cut = feed.findIndex((entry) => "delta" in entry && entry.delta.event.type === "tool.progress") + 3;
		const open = reduce(feed.slice(0, cut));
		expect(toolBlocks(turn(open))[0]?.state).toBe("running");

		const ended = applyItem(open, { seq: open.lastSeq + 1, at: 5, turn: 1, kind: "turn.ended", outcome: "error", verified: { turn: 1, state: "failed", run: null, unrun: [], changedAfter: false }, exitCode: null, steps: null, durationMs: 4000, usage: null, cachedShare: null, message: "The sandbox stopped responding." });
		const [call] = toolBlocks(turn(ended));
		expect(call).toMatchObject({ state: "failed", interrupted: true, progress: null });
		// What it had printed is kept as its output.
		expect(call?.output).toContain("$ tsc -p tsconfig.build.json");
		expect(turn(ended).end).toMatchObject({ outcome: "error", message: "The sandbox stopped responding." });
	});

	it("shows the platform's own lines", () => {
		let view = applyItem(emptyView(), { seq: 1, at: 1, turn: 1, kind: "user", text: "go", model: "gpt-test", effort: "low" });
		view = applyItem(view, { seq: 2, at: 2, turn: 1, kind: "platform", level: "info", text: "Creating sandbox" });
		expect(turn(view).blocks).toMatchObject([
			{ kind: "user", text: "go", effort: "low" },
			{ kind: "platform", level: "info", text: "Creating sandbox" },
		]);
	});
});

describe("events the reducer does not show", () => {
	it("are ignored without breaking the fold", () => {
		const unknown: TimelineItem = { seq: 1, at: 1, turn: 1, kind: "windlass", event: { type: "some.future.event", v: 1, seq: 1, time: 1, data: { anything: true } } };
		const view = applyItem(emptyView(), unknown);
		expect(view.lastSeq).toBe(1);
		expect(view.turns).toEqual([]);
	});

	it("includes a delta for a call that was never called", () => {
		const view = applyDelta(emptyView(), { turn: 1, event: { type: "tool.progress", messageId: "a1", callId: "nope", text: "x" } });
		expect(view.turns.flatMap((one) => one.blocks)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// Interactive turns: questions, steering, stopping one call
// ---------------------------------------------------------------------------------------------

/** Gives the stored items of a feed the platform's dense numbering again, after items were added or removed. */
function renumber(feed: FeedEntry[]): FeedEntry[] {
	let seq = 0;
	return feed.map((entry) => ("item" in entry ? { item: { ...entry.item, seq: ++seq } } : entry));
}

const isEvent = (type: string, match: (data: Record<string, unknown>) => boolean = () => true) => (entry: FeedEntry) => "item" in entry && entry.item.kind === "windlass" && entry.item.event.type === type && match(data(entry.item.event));

function insertBefore(feed: FeedEntry[], at: (entry: FeedEntry) => boolean, ...items: Array<DistributiveOmit<TimelineItem, "seq">>): FeedEntry[] {
	const index = feed.findIndex(at);
	if (index < 0) throw new Error("no such entry");
	return renumber([...feed.slice(0, index), ...items.map((item) => ({ item: { ...item, seq: 0 } as TimelineItem })), ...feed.slice(index)]);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const withEvent = (feed: FeedEntry[], at: (entry: FeedEntry) => boolean, change: (event: WindlassEvent) => WindlassEvent): FeedEntry[] =>
	feed.map((entry) => (at(entry) && "item" in entry && entry.item.kind === "windlass" ? { item: { ...entry.item, event: change(entry.item.event) } } : entry));

const QUESTION = {
	title: "Allow network access for this command?",
	subject: "curl -sI --max-time 10 https://example.com | head -n 3",
	details: ["With network access the command can send anything it can read to any host."],
	choices: [
		{ id: "once", label: "Allow once", approve: true, remembers: null },
		{ id: "session", label: "Allow for this session", approve: true, remembers: "network for sandboxed commands, for the rest of this session" },
		{ id: "deny", label: "Don't allow", approve: false, remembers: null },
	],
};

describe("a question that was allowed once (acp-approval-approved)", () => {
	const feed = feedOf("acp-approval-approved");
	const view = reduce(feed);
	const [call, slow] = toolBlocks(turn(view));

	it("keeps the question as it was asked, and the answer as history", () => {
		expect(call).toMatchObject({ callId: "c1", state: "done", outcome: "success", sandboxed: true, refusal: null, question: QUESTION });
		expect(call?.answer).toEqual({ choice: "once", approve: true, note: null, by: "user", platformText: null, remembers: null });
		expect(slow).toMatchObject({ callId: "c2", state: "done", question: null, answer: null });
	});

	it("goes from asking to queued to running to done", () => {
		const states = feed.map((_, index) => toolBlocks(turn(reduce(feed.slice(0, index + 1))))[0]?.state ?? null);
		const changes = states.filter((state, index) => state !== null && state !== states[index - 1]);
		expect(changes).toEqual(["input", "queued", "asking", "queued", "running", "done"]);
		const asking = reduce(feed.slice(0, feed.findIndex(isEvent("approval.requested")) + 1));
		expect(toolBlocks(turn(asking))[0]).toMatchObject({ state: "asking", answer: null, question: QUESTION });
	});

	it("tells the taint once, as a notice with Windlass's sentence", () => {
		const notices = turn(view).blocks.filter((block): block is NoticeBlock => block.kind === "notice");
		expect(notices).toEqual([expect.objectContaining({ noticeKind: "taint", text: "Content from a command that ran with network access is in this conversation and may contain instructions aimed at the model." })]);
		expect(view.tainted).toBe(true);
		// Said again (a replay, a fork), it adds nothing.
		const taint = feed.find(isEvent("taint.noticed")) as { item: TimelineItem };
		const again = applyItem(view, { ...taint.item, seq: view.lastSeq + 1 });
		expect(turn(again).blocks.filter((block) => block.kind === "notice")).toHaveLength(1);
	});

	it("shows nothing for the inbox: the steered message is the platform's own user item", () => {
		expect(kinds(turn(view).blocks)).toEqual(["user", "reasoning", "text", "tool", "notice", "text", "tool", "text"]);
		const withoutInbox = reduce(renumber(feed.filter((entry) => !("item" in entry && entry.item.kind === "windlass" && entry.item.event.type.startsWith("inbox.")))));
		expect(shape(withoutInbox).turns).toEqual(shape(view).turns);
	});

	it("is the same for a client that joined while the question was pending", () => {
		const asked = feed.findIndex(isEvent("approval.requested"));
		const timeline = feed.slice(0, asked + 1).flatMap((entry) => ("item" in entry ? [entry.item] : []));
		const joined = fromSnapshot({ timeline, pending: [], windlassSessionId: "ses_f089a4831330295cd5a72af2" });
		expect(toolBlocks(turn(joined))[0]).toMatchObject({ state: "asking", question: QUESTION, answer: null });
		expect(shape(reduce(feed.slice(asked + 1), joined))).toEqual(shape(view));
	});
});

describe("a question that was declined with a note (acp-approval-denied)", () => {
	const view = viewOf("acp-approval-denied");
	const [call, slow] = toolBlocks(turn(view));

	it("reads as declined by the user, with their note, not as a failure", () => {
		expect(call).toMatchObject({ state: "refused", outcome: "error", interrupted: false, durationMs: null, startedAt: null, refusal: null });
		expect(call?.answer).toEqual({ choice: "deny", approve: false, note: "not now", by: "user", platformText: null, remembers: null });
		expect(call?.output).toBe("Not run: the user declined this call. Their note: not now");
		expect(slow).toMatchObject({ state: "done" });
	});

	it("brings no taint: nothing ran with the network", () => {
		expect(turn(view).blocks.some((block) => block.kind === "notice")).toBe(false);
		expect(view.tainted).toBe(false);
	});
});

describe("a question the platform allowed itself", () => {
	const PLATFORM = "The platform allowed this itself: the tool only hands the agent's request to the platform, which decides it.";
	const feed = insertBefore(feedOf("acp-approval-approved"), isEvent("approval.answered"), {
		at: 2,
		turn: 1,
		kind: "platform",
		level: "info",
		text: PLATFORM,
		code: "question_allowed",
		call: { messageId: "msg_ccc3d07ef64d513915fcbeb9", callId: "c1" },
	});
	const view = reduce(feed);

	it("reads as the platform's answer, said once, with the call, and the call runs", () => {
		const [call] = toolBlocks(turn(view));
		expect(call).toMatchObject({ state: "done", answer: { choice: "once", approve: true, by: "platform", platformText: PLATFORM } });
		expect(turn(view).blocks.some((block) => block.kind === "platform")).toBe(false);
		expect(turn(view).platformAnswer).toBeNull();
	});
});

describe("a call of a tool of the user's own MCP server that runs without asking", () => {
	// The session's line for it (server/src/personal-servers.ts), marked as the platform's answer to that call.
	const line = unaskedNote("tracker");
	const view = reduce(insertBefore(feedOf("acp-approval-approved"), isEvent("approval.answered"), { at: 2, turn: 1, kind: "platform", level: "info", text: line, code: "question_allowed", call: { messageId: "msg_ccc3d07ef64d513915fcbeb9", callId: "c1" } }));

	it("shows the call as run, and says under it that it was allowed for the user and why", () => {
		const [call] = toolBlocks(turn(view));
		expect(call).toMatchObject({ state: "done", answer: { choice: "once", approve: true, by: "platform", platformText: line } });
		expect(line).toContain('your MCP server "tracker"');
		expect(turn(view).blocks.some((block) => block.kind === "platform")).toBe(false);
	});
});

describe("a question the platform declined because nobody answered", () => {
	const PLATFORM = "Nobody answered within 10 minutes, so the platform declined the call.";
	const feed = withEvent(
		insertBefore(feedOf("acp-approval-denied"), isEvent("approval.answered"), {
			at: 2,
			turn: 1,
			kind: "platform",
			level: "warn",
			text: PLATFORM,
			code: "question_expired",
			call: { messageId: "msg_70b5940bc69860eec4950c57", callId: "c1" },
		}),
		isEvent("approval.answered"),
		(event) => ({ ...event, data: { ...event.data, note: null } }),
	);
	const view = reduce(feed);

	it("reads as the platform's decision, said once, with the call", () => {
		const [call] = toolBlocks(turn(view));
		expect(call).toMatchObject({ state: "refused", answer: { choice: "deny", approve: false, note: null, by: "platform", platformText: PLATFORM } });
		expect(turn(view).blocks.some((block) => block.kind === "platform")).toBe(false);
		expect(turn(view).platformAnswer).toBeNull();
	});

	it("leaves the platform's other lines alone", () => {
		const other = insertBefore(feedOf("acp-approval-denied"), isEvent("approval.answered"), { at: 2, turn: 1, kind: "platform", level: "info", text: "Resuming the paused sandbox" });
		const reduced = reduce(other);
		expect(turn(reduced).blocks.filter((block) => block.kind === "platform")).toHaveLength(1);
		expect(toolBlocks(turn(reduced))[0]?.answer?.by).toBe("user");
	});
});

describe("a steer inside a turn", () => {
	const feed = insertBefore(feedOf("acp-approval-approved"), isEvent("inbox.enqueued", (fields) => contentText(fields) === "Also, keep it short."), { at: 3, turn: 1, kind: "user", text: "Also, keep it short.", model: "gpt-6.1-sol", effort: null, steer: true });
	const view = reduce(feed);

	it("is shown in the turn where it was sent, marked as a steer", () => {
		const users = turn(view).blocks.filter((block) => block.kind === "user");
		expect(users).toMatchObject([
			{ steer: false, text: "Fetch the response headers of example.com" },
			{ steer: true, text: "Also, keep it short.", effort: null },
		]);
		expect(view.turns).toHaveLength(1);
		// After the call it was sent during, before the answer it shaped.
		expect(kinds(turn(view).blocks)).toEqual(["user", "reasoning", "text", "tool", "notice", "text", "tool", "user", "text"]);
	});
});

describe("a call the user stopped", () => {
	const base = feedOf("demo-a-long-build-command");
	const progress = base.findIndex((entry) => "delta" in entry && entry.delta.event.type === "tool.progress") + 3;
	const cancel: TimelineItem = { seq: 0, at: 4, turn: 1, kind: "windlass", event: { type: "tool.cancel_requested", v: 1, seq: 99, time: 4, data: { messageId: "a1", callId: "call_1" } } };
	const feed = withEvent(
		renumber([...base.slice(0, progress), { item: cancel }, ...base.slice(progress)]),
		isEvent("tool.settled"),
		(event) => ({ ...event, data: { ...event.data, outcome: "error", output: "$ tsc -p tsconfig.build.json\n[Stopped by the user after 3 s]", display: { exitCode: null, signal: "SIGTERM", durationMs: 3000 } } }),
	);

	it("is being stopped until it settles", () => {
		const stopping = reduce(feed.slice(0, progress + 2));
		expect(toolBlocks(turn(stopping))[0]).toMatchObject({ state: "running", stopRequested: true, stoppedByUser: false });
	});

	it("then reads as stopped by the user, not as failed, and the turn goes on", () => {
		const view = reduce(feed);
		expect(toolBlocks(turn(view))[0]).toMatchObject({ state: "failed", interrupted: true, stoppedByUser: true, stopRequested: false, outcome: "error" });
		expect(turn(view).interruptRequested).toBe(false);
		expect(turn(view).end).toMatchObject({ outcome: "succeeded" });
	});

	it("that finished anyway is simply done", () => {
		const finished = renumber([...base.slice(0, progress), { item: cancel }, ...base.slice(progress)]);
		expect(toolBlocks(turn(reduce(finished)))[0]).toMatchObject({ state: "done", stoppedByUser: false, stopRequested: false });
	});
});

describe("a run of the repository's setup command", () => {
	const item = { turn: 1, kind: "setup" as const, id: "su_1", command: "npm ci", limitMs: 600_000 };
	const started: TimelineItem = { ...item, seq: 1, at: 1_000, state: "started", exitCode: null, durationMs: null, output: "", truncated: false };
	const printed = (text: string): LiveDelta => ({ turn: 1, event: { type: "setup.output", id: "su_1", text } });
	const running = [printed("added 3 packages\n"), printed("done\n")].reduce(applyDelta, applyItem(emptyView(), started));
	const block = (view: SessionView) => view.turns[0]?.blocks.filter((one) => one.kind === "setup") ?? [];

	it("is one block that shows what it printed while it runs", () => {
		expect(block(running)).toHaveLength(1);
		expect(block(running)[0]).toMatchObject({ state: "running", command: "npm ci", output: "added 3 packages\ndone\n", truncated: false });
	});

	it("ends as its ending item says, with the output that item kept", () => {
		const ended = applyItem(running, { ...item, seq: 2, at: 3_000, state: "failed", exitCode: 3, durationMs: 2_000, output: "npm error\n", truncated: true });
		expect(block(ended)).toHaveLength(1);
		expect(block(ended)[0]).toMatchObject({ state: "failed", exitCode: 3, durationMs: 2_000, output: "npm error\n", truncated: true });
		// Output that arrives late adds nothing to a run that has ended.
		expect(block(applyDelta(ended, printed("late\n")))[0]).toMatchObject({ output: "npm error\n" });
	});

	it("that has no ending item when its turn ends was cut off", () => {
		const ended = applyItem(running, { seq: 2, at: 3_000, turn: 1, kind: "turn.ended", outcome: "interrupted", verified: { turn: 1, state: "stopped", run: null, unrun: [], changedAfter: false }, exitCode: null, steps: null, durationMs: 2_000, usage: null, cachedShare: null, message: null });
		expect(block(ended)[0]).toMatchObject({ state: "cut_off" });
	});
});

describe("subagents (a real turn of Windlass 0.3.0 over ACP: acp-subagents)", () => {
	const feed = feedOf("acp-subagents");
	const subagents = (view: SessionView) => toolBlocks(turn(view)).filter((block) => block.name === "subagent");
	const ended = subagents(reduce(feed));

	it("are the calls that started them, each with how it ended and Windlass's sentence about it", () => {
		expect(ended.map((call) => [call.subagent?.state, call.subagent?.background, call.subagent?.detail])).toEqual([
			["completed", false, "It finished."],
			["failed", false, "It failed: The request was rejected: the input is too long for this model."],
			["stopped", false, "It was stopped before it finished: the user stopped this call."],
			["completed", true, "It finished."],
		]);
		expect(ended[2]).toMatchObject({ state: "failed", stoppedByUser: true });
		expect(ended.every((call) => call.subagent !== null && call.subagent.durationMs !== null && /^ses_/.test(call.subagent.sessionId))).toBe(true);
	});

	it("fold what each did into a view of its own: its calls, its words and its error, none of them in the session's own", () => {
		const work = ended.map((call) => turn(call.subagent!.work).blocks);
		expect(work[0]?.map((block) => block.kind)).toEqual(["tool", "text"]);
		expect(work[0]?.[0]).toMatchObject({ name: "glob", state: "done" });
		expect((work[0]?.[1] as TextBlock).text).toMatch(/^There are no test files yet/);
		expect(work[1]?.map((block) => block.kind)).toEqual(["error"]);
		expect((work[1]?.[0] as ErrorBlock).message).toBe("The request was rejected: the input is too long for this model.");
		expect(work[3]?.map((block) => block.kind)).toEqual(["tool", "text"]);
		expect(toolBlocks(turn(reduce(feed))).map((block) => block.name)).toEqual(["subagent", "subagent", "subagent", "subagent"]);
	});

	it("run until their work ends, a background one after its call has returned", () => {
		const returned = feed.findIndex((entry) => "item" in entry && entry.item.kind === "windlass" && entry.item.event.type === "tool.settled" && (entry.item.event.data as { callId?: string }).callId === "b1");
		const [, , , background] = subagents(reduce(feed.slice(0, returned + 1)));
		expect(background).toMatchObject({ state: "done" });
		expect(background?.subagent?.state).toBe("running");
	});

	it("that are still running when their turn ends were cut off, and so is what they had open", () => {
		const opened = feed.findIndex((entry) => "item" in entry && entry.item.kind === "windlass" && entry.item.event.type === "child.event" && (entry.item.event.event as { type?: string }).type === "tool.started");
		const running = reduce(feed.slice(0, opened + 1));
		const cut = applyItem(running, { seq: running.lastSeq + 1, at: 2_000_000, turn: 1, kind: "turn.ended", outcome: "interrupted", verified: { turn: 1, state: "stopped", run: null, unrun: [], changedAfter: false }, exitCode: null, steps: null, durationMs: 1_000, usage: null, cachedShare: null, message: null });
		const [call] = subagents(cut);
		expect(call?.subagent?.state).toBe("cut_off");
		expect(turn(call!.subagent!.work).blocks[0]).toMatchObject({ kind: "tool", state: "failed", interrupted: true });
	});
});

function contentText(fields: Record<string, unknown>): string {
	const content = fields.content;
	return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
}

// ---------------------------------------------------------------------------------------------
// A harness spoken to through ACP (Claude Code)
// ---------------------------------------------------------------------------------------------

describe("an ACP turn", () => {
	const acpReduce = (feed: AcpFeedEntry[], from: SessionView = emptyView()) => feed.reduce((view, entry) => ("item" in entry ? applyItem(view, entry.item) : applyDelta(view, entry.delta)), from);
	const acpView = (name: string) => acpReduce(acpRunToFeed(acpFixture(name)));
	const blocksOf = (view: SessionView) => turn(view).blocks.filter((block) => block.kind !== "user");

	it("folds the plain scenario into one reasoning block and one text block", () => {
		const view = acpView("acp-claude-plain");
		const blocks = blocksOf(view);
		expect(kinds(blocks)).toEqual(["reasoning", "text"]);
		expect(blocks.map((block) => (block.kind === "reasoning" || block.kind === "text" ? [block.text, block.streaming] : null))).toEqual([
			["I'll inspect the files.", false],
			["The files are ready.", false],
		]);
		expect(turn(view).end).toMatchObject({ outcome: "succeeded", verified: null, context: null });
	});

	it("gives the tools scenario two tool blocks in their end states, with the edit's diff kept", () => {
		const view = acpView("acp-claude-tools");
		const tools = toolBlocks(turn(view));
		expect(tools.map((block) => [block.messageId, block.name, block.target, block.state, block.outcome, block.output])).toEqual([
			["acp", "shell", "pwd", "done", "success", "/workspace"],
			["acp", "edit", "README.md", "failed", "error", ""],
		]);
		const diff = tools[1]?.display?.diff;
		expect(typeof diff).toBe("string");
		expect(String(diff).split("\n")).toEqual(expect.arrayContaining(["--- a/README.md", "+++ b/README.md", "-Draft", "+Ready"]));
		expect(texts(blocksOf(view)).map((block) => block.text)).toEqual(["The edit failed."]);
	});

	it("shows live chunks and then their stored run once, not twice, from the feed and from a snapshot taken midway", () => {
		const feed = acpRunToFeed(acpFixture("acp-claude-plain"));
		expect(feed.filter((entry) => "delta" in entry)).toHaveLength(8);
		// Midway through the answer: the thinking is stored, the answer is the snapshot's pending delta so far.
		const cut = feed.findIndex((entry) => "delta" in entry && "acp" in entry.delta && entry.delta.acp.sessionUpdate === "agent_message_chunk") + 2;
		const stored = feed.slice(0, cut).flatMap((entry) => ("item" in entry ? [entry.item] : []));
		const sofar: LiveDelta = { turn: 1, messageKey: "acp-1-2", acp: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The files " } } };
		const midway = fromSnapshot({ timeline: stored, pending: [sofar], windlassSessionId: null });
		expect(texts(blocksOf(midway)).map((block) => [block.text, block.streaming])).toEqual([["The files ", true]]);
		const after = acpReduce(feed.slice(cut), midway);
		expect(texts(blocksOf(after)).map((block) => [block.text, block.streaming])).toEqual([["The files are ready.", false]]);
		expect(shape(after).turns).toEqual(shape(acpReduce(feed)).turns);
	});

	it("keeps one plan per turn, updated in place, and the context's fill from usage", () => {
		const plan = blocksOf(acpView("acp-claude-plan"));
		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatchObject({ kind: "plan", entries: [{ content: "Read the file", status: "completed" }, { content: "Make the edit", status: "completed" }, { content: "Check the result", status: "completed" }] });
		const usage = acpView("acp-claude-usage");
		expect(usage.context).toEqual({ used: 41000, size: 200000, cost: { amount: 0.38, currency: "USD" } });
		expect(turn(usage).end?.context).toEqual({ used: 41000, size: 200000, cost: { amount: 0.38, currency: "USD" } });
	});

	it("clears a plan that an empty plan update empties, in its turn only", () => {
		// What claude-agent-acp 0.109.0 sent with Claude Code's task tools: one turn left its last task in
		// progress, and the next turn's adapter process, which never saw the tasks, sent an empty plan.
		const step = (statuses: string[]): AcpUpdate => ({ sessionUpdate: "plan", entries: statuses.map((status, index) => ({ content: `Task ${index + 1}`, priority: "medium", status })) });
		const first: AcpFixture = { scenario: "tasks", prompt: "start", stopReason: "end_turn", updates: [step(["in_progress", "pending"]), step(["completed", "in_progress"])] };
		const second: AcpFixture = { scenario: "tasks", prompt: "go on", stopReason: "end_turn", updates: [step([])] };
		const one = acpRunToFeed(first);
		const lastSeq = one.flatMap((entry) => ("item" in entry ? [entry.item.seq] : [])).at(-1);
		const view = acpReduce([...one, ...acpRunToFeed(second, { turn: 2, afterSeq: lastSeq })]);
		const plans = (number: number) => view.turns.find((candidate) => candidate.turn === number)?.blocks.filter((block) => block.kind === "plan");
		expect(plans(1)).toMatchObject([{ entries: [{ status: "completed" }, { status: "in_progress" }] }]);
		expect(plans(2)).toEqual([]);
		// In the same turn the empty update takes the checklist away.
		const cleared = acpReduce(acpRunToFeed({ ...first, updates: [...first.updates, step([])] }));
		expect(blocksOf(cleared).filter((block) => block.kind === "plan")).toEqual([]);
	});

	it("folds updates it does not show, and kinds it has never heard of, into nothing, between the ones it does", () => {
		const plain = acpFixture("acp-claude-plain");
		// Wire data is not trusted to match the type: these come as they would off the socket.
		const unknown = ([
			{ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the conversation" }] },
			{ sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" },
			{ sessionUpdate: "config_option_update", configOptions: [{ id: "model", category: "model", type: "select" }] },
			{ sessionUpdate: "session_info_update", title: "Inspect the files" },
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "plain" } },
			{ sessionUpdate: "a_kind_from_next_year", whatever: { nested: [1, 2, 3] } },
			// Malformed: a call update that names no call, a plan without its entries.
			{ sessionUpdate: "tool_call_update" },
			{ sessionUpdate: "plan" },
		] as unknown[]) as AcpUpdate[];
		const mixed: AcpFixture = { ...plain, updates: [...plain.updates.slice(0, 3), ...unknown, ...plain.updates.slice(3)] };
		const view = acpReduce(acpRunToFeed(mixed));
		expect(kinds(blocksOf(view))).toEqual(["reasoning", "text"]);
		expect(shape(view).turns[0]?.blocks).toEqual(shape(acpView("acp-claude-plain")).turns[0]?.blocks);
		for (const update of unknown) {
			const before = acpView("acp-claude-plain");
			expect(applyDelta(before, { turn: 1, messageKey: "acp-9", acp: update })).toBe(before);
			expect(applyItem(before, { seq: before.lastSeq + 1, at: 0, turn: 1, kind: "acp", update }).turns).toEqual(before.turns);
		}
	});
});
