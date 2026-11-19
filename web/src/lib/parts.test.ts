import { describe, expect, it } from "vitest";
import { schedule } from "../api/feed";
import { fixture } from "../api/fixtures";
import { parseDiff } from "./diff";
import { compact, countdown, duration, percent, relativeTime, shortId } from "./format";
import { parseRoute } from "./router";
import type { ToolBlock } from "./timeline";
import { formatInput, summarizeTool } from "./toolSummary";

const tool = (patch: Partial<ToolBlock>): ToolBlock => ({
	kind: "tool",
	id: "b1",
	at: null,
	messageId: "a1",
	callId: "c1",
	name: "read",
	inputText: "",
	state: "done",
	interrupted: false,
	outcome: "success",
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
	subagent: null,
	...patch,
});

describe("the one-line reading of a tool call", () => {
	it("names the path of a read and its size", () => {
		expect(summarizeTool(tool({ inputText: '{"path":"src/cart.js"}', display: { path: "src/cart.js", lines: 13, totalLines: 13 } }))).toEqual({ target: "src/cart.js", facts: ["13 lines"], exitCode: null });
	});

	it("names the command of a shell call and its exit code", () => {
		expect(summarizeTool(tool({ name: "shell", inputText: '{"command":"bun test"}', display: { exitCode: 1, signal: null } }))).toEqual({ target: "bun test", facts: ["exit 1"], exitCode: 1 });
	});

	it("counts the lines an edit added and removed", () => {
		const display = { path: "src/add.ts", diff: "--- a/src/add.ts\n+++ b/src/add.ts\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b\n+  return a + b\n }" };
		expect(summarizeTool(tool({ name: "edit", inputText: '{"path":"src/add.ts","old_string":"a","new_string":"b"}', display })).facts).toEqual(["+1 -1"]);
	});

	it("reads a grep's pattern, where it looked and what it found", () => {
		expect(summarizeTool(tool({ name: "grep", inputText: '{"pattern":"add\\\\(","path":"src"}', display: { matches: 4, files: 3 } }))).toMatchObject({ target: "add\\( in src", facts: ["4 matches", "3 files"] });
	});

	it("reads what it can from arguments that are still streaming in", () => {
		expect(summarizeTool(tool({ name: "shell", state: "input", inputText: '{"command":"bun run bu' })).target).toBe("bun run bu");
		expect(summarizeTool(tool({ name: "read", state: "input", inputText: '{"pa' })).target).toBe("");
		expect(summarizeTool(tool({ name: "write", state: "input", inputText: '{"path":"a\\"b.ts","content":"x' })).target).toBe('a"b.ts');
	});

	it("falls back to the first string of an unknown tool's arguments", () => {
		expect(summarizeTool(tool({ name: "fetch_page", inputText: '{"limit":3,"address":"https://example.com"}' })).target).toBe("https://example.com");
		expect(summarizeTool(tool({ name: "noop", inputText: "{}" })).target).toBe("");
	});

	it("shows a single argument bare and several as a list", () => {
		expect(formatInput(tool({ name: "shell", inputText: '{"command":"ls -la"}' }))).toBe("ls -la");
		expect(formatInput(tool({ name: "write", inputText: '{"path":"a.ts","content":"one\\ntwo"}' }))).toBe("path: a.ts\ncontent:\n  one\n  two");
		expect(formatInput(tool({ inputText: '{"pa' }))).toBe('{"pa');
	});
});

describe("the diff parser", () => {
	const text = [
		"diff --git a/src/add.ts b/src/add.ts",
		"index 3b1f0c2..9d2e7aa 100644",
		"--- a/src/add.ts",
		"+++ b/src/add.ts",
		"@@ -1,3 +1,3 @@",
		" export function add(a: number, b: number) {",
		"-  return a - b",
		"+  return a + b",
		" }",
		"@@ -10,2 +10,3 @@ export function sub() {",
		" a",
		"+--- not a header",
		" b",
		"diff --git a/made.txt b/made.txt",
		"new file mode 100644",
		"index 0000000..ce01362",
		"--- /dev/null",
		"+++ b/made.txt",
		"@@ -0,0 +1 @@",
		"+hello",
		"\\ No newline at end of file",
		"diff --git a/logo.png b/logo.png",
		"index 1111111..2222222 100644",
		"Binary files a/logo.png and b/logo.png differ",
		"",
	].join("\n");
	const files = parseDiff(text);

	it("splits files and counts their lines", () => {
		expect(files.map((file) => [file.path, file.status, file.added, file.removed, file.hunks.length, file.binary])).toEqual([
			["src/add.ts", "modified", 2, 1, 2, false],
			["made.txt", "added", 1, 0, 1, false],
			["logo.png", "modified", 0, 0, 0, true],
		]);
	});

	it("numbers lines on both sides", () => {
		expect(files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldNumber, line.newNumber])).toEqual([
			["context", 1, 1],
			["remove", 2, null],
			["add", null, 2],
			["context", 3, 3],
		]);
		expect(files[0]?.hunks[1]?.lines.map((line) => [line.kind, line.oldNumber, line.newNumber, line.text])).toEqual([
			["context", 10, 10, "a"],
			["add", null, 11, "--- not a header"],
			["context", 11, 12, "b"],
		]);
		expect(files[1]?.hunks[0]?.lines.at(-1)).toMatchObject({ kind: "meta", text: "No newline at end of file" });
	});

	it("gives nothing for text that is not a diff", () => {
		expect(parseDiff("")).toEqual([]);
		expect(parseDiff("fatal: not a git repository")).toEqual([]);
	});
});

describe("formatting", () => {
	it("writes durations the way the terminal interface does", () => {
		expect([10, 999, 1000, 4284, 9420, 20_000, 135_000, 3_725_000].map(duration)).toEqual(["10ms", "999ms", "1s", "4.3s", "9.4s", "20s", "2m 15s", "1h 2m"]);
	});

	it("shortens token counts", () => {
		expect([0, 999, 4500, 5659, 45_879, 272_000, 1_250_000].map(compact)).toEqual(["0", "999", "4.5k", "5.7k", "45.9k", "272k", "1.3M"]);
		expect([0.784, 0, 1, null].map(percent)).toEqual(["78%", "0%", "100%", "–"]);
	});

	it("says how long ago", () => {
		const now = Date.UTC(2026, 10, 14, 12);
		expect([0, 42_000, 5 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map((ago) => relativeTime(now - ago, now))).toEqual(["now", "42s ago", "5m ago", "3h ago", "2d ago"]);
		expect(relativeTime(now - 90 * 86_400_000, now)).toMatch(/2026$/);
	});

	it("counts down and shortens IDs", () => {
		expect([600_000, 59_001, 0, -5].map(countdown)).toEqual(["10:00", "1:00", "0:00", "0:00"]);
		expect(shortId("ses_4b8aa56e35abff8a79333beb")).toBe("ses_4b8aa56e…333beb");
		expect(shortId("ses_demo")).toBe("ses_demo");
	});
});

describe("routes", () => {
	it("reads the screen from the address", () => {
		expect(parseRoute("/")).toEqual({ name: "home" });
		expect(parseRoute("/new")).toEqual({ name: "new" });
		expect(parseRoute("/signin/")).toEqual({ name: "signin" });
		expect(parseRoute("/agents/add-test")).toEqual({ name: "session", id: "add-test" });
		expect(parseRoute("/agents/a%20b")).toEqual({ name: "session", id: "a b" });
		expect(parseRoute("/agents")).toEqual({ name: "notfound" });
		expect(parseRoute("/agents/a/b")).toEqual({ name: "notfound" });
		expect(parseRoute("/nowhere")).toEqual({ name: "notfound" });
	});
});

describe("the playback schedule", () => {
	it("keeps a recording's own timing and spreads the streaming events between the durable ones", () => {
		const events = fixture("demo-two-parallel-tool-calls");
		const offsets = schedule(events);
		expect(offsets).toHaveLength(events.length);
		expect(offsets[0]).toBe(0);
		for (let index = 1; index < offsets.length; index++) expect(offsets[index]).toBeGreaterThan(offsets[index - 1] as number);
		const durable = events.map((event, index) => [event, offsets[index] as number] as const).filter(([event]) => typeof event.time === "number");
		const first = durable[0]?.[0].time as number;
		const last = durable.at(-1) as (typeof durable)[number];
		// Within the minimum gaps added, the whole run takes as long as it was recorded to take.
		expect(last[1]).toBeGreaterThanOrEqual((last[0].time as number) - first);
		expect(last[1]).toBeLessThan((last[0].time as number) - first + 60 * events.length);
	});

	it("makes a recording made at full speed watchable", () => {
		const offsets = schedule(fixture("real-scripted-bwrap"));
		expect(offsets.at(-1)).toBeGreaterThan(1500);
	});
});
