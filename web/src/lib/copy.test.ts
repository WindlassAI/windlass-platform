// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeText, copyText, splitDiff, toolCopyLabels, toolInputText, toolOutputText } from "./copy";
import { parseDiff } from "./diff";
import { renderMarkdown } from "./markdown";
import type { ToolBlock } from "./timeline";

function tool(name: string, input: unknown, extra: Partial<ToolBlock> = {}): ToolBlock {
	return {
		kind: "tool",
		id: "t",
		at: 0,
		messageId: "m",
		callId: "c",
		name,
		inputText: typeof input === "string" ? input : JSON.stringify(input),
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
		...extra,
	};
}

const TWO_FILES = `diff --git a/src/add.ts b/src/add.ts
index 3b1f0c2..9d2e7aa 100644
--- a/src/add.ts
+++ b/src/add.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number) {
-  return a - b
+  return a + b
 }
diff --git a/made.txt b/made.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/made.txt
@@ -0,0 +1 @@
+hello
`;

describe("what a tool call's controls copy", () => {
	it("copies a command alone, as it would be typed, even when the call has other arguments", () => {
		expect(toolInputText(tool("shell", { command: "bun test src/add.test.ts" }))).toBe("bun test src/add.test.ts");
		expect(toolInputText(tool("shell", { command: "make build", timeout: 60 }))).toBe("make build");
	});

	it("copies other input as the input part shows it", () => {
		expect(toolInputText(tool("read", { path: "src/add.ts" }))).toBe("src/add.ts");
		expect(toolInputText(tool("edit", { path: "src/add.ts", old: "a - b", new: "a + b" }))).toBe(
			"path: src/add.ts\nold: a - b\nnew: a + b",
		);
		// Arguments still being written are not JSON yet: they are copied as they stand.
		expect(toolInputText(tool("shell", '{"command": "bun te', { state: "input" }))).toBe('{"command": "bun te');
	});

	it("copies all of the output, the output so far while a call runs, and an edit's patch when it shows one", () => {
		const long = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
		expect(toolOutputText(tool("shell", { command: "seq" }, { output: long }))).toBe(long);
		expect(toolOutputText(tool("shell", { command: "make" }, { state: "running", progress: "building…\n" }))).toBe(
			"building…\n",
		);
		expect(
			toolOutputText(tool("edit", { path: "src/add.ts" }, { output: "edited", display: { diff: TWO_FILES } })),
		).toBe(TWO_FILES);
		// A "diff" the diff view cannot read is not what the body shows: the output is.
		expect(toolOutputText(tool("edit", { path: "x" }, { output: "edited", display: { diff: "not a diff" } }))).toBe(
			"edited",
		);
		expect(toolOutputText(tool("shell", { command: "true" }))).toBe("");
	});

	it("names each control by what it copies", () => {
		expect(toolCopyLabels(tool("shell", { command: "ls" }))).toEqual({
			input: "Copy the command of this shell call",
			output: "Copy the output of this shell call",
		});
		expect(toolCopyLabels(tool("edit", { path: "a" }, { display: { diff: TWO_FILES } }))).toEqual({
			input: "Copy the input of this edit call",
			output: "Copy the diff of this edit call",
		});
	});
});

describe("a diff cut into files", () => {
	it("gives one patch per file, in the order the diff view lists them, each ending with a newline", () => {
		const parts = splitDiff(TWO_FILES);
		expect(parts).toHaveLength(parseDiff(TWO_FILES).length);
		expect(parts[0]).toBe(TWO_FILES.slice(0, TWO_FILES.indexOf("diff --git a/made.txt")));
		expect(parts[1]).toBe(TWO_FILES.slice(TWO_FILES.indexOf("diff --git a/made.txt")));
		expect(parts.join("")).toBe(TWO_FILES);
		// Each part is a diff of its own file.
		expect(parseDiff(parts[1] ?? "").map(file => file.path)).toEqual(["made.txt"]);
	});

	it("cuts a plain `diff -u` at each file's header, and not at changed lines that look like one", () => {
		const one = "--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n-a\n+b\n same\n";
		const two = "--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n--- old dashes\n+++ new dashes\n";
		expect(splitDiff(one + two)).toEqual([one, two]);
	});

	it("does not cut a git diff at a changed line that reads like a file's first line", () => {
		const tricky =
			"diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n-diff --git a/x b/x\n+--- a/x\n context\n";
		expect(splitDiff(tricky)).toEqual([tricky]);
	});
});

describe("the text of a code block", () => {
	it("is the code as written, without the renderer's last newline and with its characters unescaped", () => {
		const holder = document.createElement("div");
		holder.innerHTML = renderMarkdown("Run:\n\n```ts\nif (a < b && c > d) {\n  return '<ok>'\n}\n```\n");
		const pre = holder.querySelector("pre");
		expect(pre).not.toBeNull();
		expect(codeText(pre as HTMLElement)).toBe("if (a < b && c > d) {\n  return '<ok>'\n}");
	});
});

describe("putting text on the clipboard", () => {
	const writeText = vi.fn<(text: string) => Promise<void>>();
	const execCommand = vi.fn<(command: string) => boolean>();
	let copiedFromArea: string[] = [];

	beforeEach(() => {
		writeText.mockReset();
		execCommand.mockReset();
		copiedFromArea = [];
		// What the fallback copies is whatever is selected in its text area when it asks.
		execCommand.mockImplementation(() => {
			const area = document.activeElement;
			if (area instanceof HTMLTextAreaElement)
				copiedFromArea.push(area.value.slice(area.selectionStart, area.selectionEnd));
			return true;
		});
		Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
	});
	afterEach(() => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		document.body.innerHTML = "";
	});

	it("uses the Clipboard API when there is one", async () => {
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		writeText.mockResolvedValue(undefined);
		expect(await copyText("hello")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("hello");
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("copies from a selected text area where there is no Clipboard API (plain http), and leaves nothing behind", async () => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		const button = document.createElement("button");
		document.body.append(button);
		button.focus();
		expect(await copyText("line one\nline two", button)).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(copiedFromArea).toEqual(["line one\nline two"]);
		expect(document.querySelector("textarea")).toBeNull();
		// The focus goes back to the control that asked.
		expect(document.activeElement).toBe(button);
	});

	it("falls back when the Clipboard API refuses", async () => {
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		writeText.mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
		expect(await copyText("x")).toBe(true);
		expect(copiedFromArea).toEqual(["x"]);
	});

	it("says so when both ways are refused", async () => {
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
		execCommand.mockImplementation(() => false);
		expect(await copyText("x")).toBe(false);
		execCommand.mockImplementation(() => {
			throw new Error("not supported");
		});
		expect(await copyText("x")).toBe(false);
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("puts its text area inside an open dialog, since everything outside a modal one is inert", async () => {
		const dialog = document.createElement("dialog");
		const button = document.createElement("button");
		dialog.append(button);
		document.body.append(dialog);
		let parent: Element | null = null;
		execCommand.mockImplementation(() => {
			parent = document.querySelector("textarea")?.parentElement ?? null;
			return true;
		});
		expect(await copyText("in a dialog", button)).toBe(true);
		expect(parent).toBe(dialog);
	});

	it("gives back the text the reader had selected", async () => {
		const paragraph = document.createElement("p");
		paragraph.textContent = "selected words";
		document.body.append(paragraph);
		const selection = document.getSelection();
		selection?.selectAllChildren(paragraph);
		await copyText("something else");
		expect(document.getSelection()?.toString()).toBe("selected words");
	});
});
