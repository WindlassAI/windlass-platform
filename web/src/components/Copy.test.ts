// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextBlock, TurnView, UserBlock } from "../lib/timeline";
import { Turn } from "./Blocks";
import { COPIED_MS, CopyButton, FAILED_MS } from "./Copy";
import { DiffView } from "./DiffView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

const render = (element: Parameters<Root["render"]>[0]) => act(() => root.render(element));
const button = (label: string) => {
	const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!found) throw new Error(`no button "${label}" in ${host.innerHTML}`);
	return found;
};
const press = (label: string) => act(async () => button(label).click());
const announced = (label: string) => button(label).parentElement?.querySelector('[role="status"]')?.textContent;

describe("the copy control", () => {
	it("copies its text, shows a check for a moment and says so to a screen reader", async () => {
		vi.useFakeTimers();
		render(createElement(CopyButton, { text: "bun test", label: "Copy the command" }));
		expect(announced("Copy the command")).toBe("");
		expect(button("Copy the command").title).toBe("Copy the command");

		await press("Copy the command");
		expect(writeText).toHaveBeenCalledWith("bun test");
		expect(button("Copy the command").parentElement?.className).toContain("copy-copied");
		expect(announced("Copy the command")).toBe("Copied");

		act(() => vi.advanceTimersByTime(COPIED_MS));
		expect(button("Copy the command").parentElement?.className).toContain("copy-idle");
		expect(announced("Copy the command")).toBe("");
	});

	it("says in a few words when the clipboard is refused, instead of pretending", async () => {
		vi.useFakeTimers();
		writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
		Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
		render(createElement(CopyButton, { text: "x", label: "Copy it" }));

		await press("Copy it");
		expect(button("Copy it").parentElement?.className).toContain("copy-failed");
		expect(host.querySelector(".copy-note")?.textContent).toBe("Couldn't copy");
		expect(announced("Copy it")).toBe("Could not copy: the browser refused the clipboard");

		// The words stay longer than the check does: they have to be read.
		act(() => vi.advanceTimersByTime(COPIED_MS));
		expect(host.querySelector(".copy-note")).not.toBeNull();
		act(() => vi.advanceTimersByTime(FAILED_MS - COPIED_MS));
		expect(host.querySelector(".copy-note")).toBeNull();
	});

	it("starts the moment again when pressed again before the check has gone", async () => {
		vi.useFakeTimers();
		render(createElement(CopyButton, { text: "x", label: "Copy it" }));
		await press("Copy it");
		act(() => vi.advanceTimersByTime(COPIED_MS - 100));
		await press("Copy it");
		act(() => vi.advanceTimersByTime(COPIED_MS - 100));
		expect(button("Copy it").parentElement?.className).toContain("copy-copied");
	});

	it("reads text given as a function when it is pressed", async () => {
		let text = "first";
		render(createElement(CopyButton, { text: () => text, label: "Copy it" }));
		text = "second";
		await press("Copy it");
		expect(writeText).toHaveBeenCalledWith("second");
	});
});

const user = (text: string): UserBlock => ({
	kind: "user",
	id: "u",
	at: 0,
	text,
	model: "gpt",
	effort: null,
	steer: false,
});
const answer = (text: string, streaming = false): TextBlock => ({
	kind: "text",
	id: "a",
	at: 0,
	messageId: "m",
	text,
	streaming,
});
const turnOf = (...blocks: TurnView["blocks"]): TurnView => ({
	turn: 1,
	blocks,
	steps: 1,
	stepOpen: false,
	interruptRequested: false,
	changedFiles: null,
	usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
	end: null,
	platformAnswer: null,
});

describe("copying in the conversation", () => {
	const MARKDOWN = "Changed **`add`**:\n\n```ts\nreturn a + b\n```\n\nThen:\n\n```sh\nbun test\n```\n";

	it("copies a prompt as it was sent", async () => {
		render(createElement(Turn, { turn: turnOf(user("Fix  the\ntests")) }));
		await press("Copy this prompt");
		expect(writeText).toHaveBeenCalledWith("Fix  the\ntests");
	});

	it("copies an answer as the Markdown it was written in, and each code block as its code", async () => {
		render(createElement(Turn, { turn: turnOf(answer(MARKDOWN)) }));
		await press("Copy this answer as Markdown");
		expect(writeText).toHaveBeenLastCalledWith(MARKDOWN);
		await press("Copy code block 1 of 2");
		expect(writeText).toHaveBeenLastCalledWith("return a + b");
		await press("Copy code block 2 of 2");
		expect(writeText).toHaveBeenLastCalledWith("bun test");
		// The controls sit beside the code, which reads as it did: one box per block, the code untouched.
		expect(host.querySelectorAll(".code-block > pre")).toHaveLength(2);
		expect(host.querySelector(".prose")?.textContent).toContain("return a + b");
	});

	it("while an answer streams, copies what has arrived when pressed, and adds code controls once it is whole", async () => {
		render(createElement(Turn, { turn: turnOf(answer("Changed **`add`**:\n\n```ts\nreturn a", true)) }));
		expect(host.querySelectorAll(".code-copy")).toHaveLength(0);
		const control = button("Copy this answer as Markdown");

		render(
			createElement(Turn, { turn: turnOf(answer("Changed **`add`**:\n\n```ts\nreturn a + b\n```\n\nThen", true)) }),
		);
		// The same control, not a new one: it is not rebuilt with every chunk.
		expect(button("Copy this answer as Markdown")).toBe(control);
		await press("Copy this answer as Markdown");
		expect(writeText).toHaveBeenLastCalledWith("Changed **`add`**:\n\n```ts\nreturn a + b\n```\n\nThen");
		expect(control.parentElement?.className).toContain("copy-copied");

		render(createElement(Turn, { turn: turnOf(answer(MARKDOWN, false)) }));
		expect(host.querySelectorAll(".code-copy")).toHaveLength(2);
	});
});

describe("copying in the diff view", () => {
	const ONE = "diff --git a/src/add.ts b/src/add.ts\n--- a/src/add.ts\n+++ b/src/add.ts\n@@ -1 +1 @@\n-a - b\n+a + b\n";
	const TWO =
		"diff --git a/made.txt b/made.txt\nnew file mode 100644\n--- /dev/null\n+++ b/made.txt\n@@ -0,0 +1 @@\n+hello\n";

	it("copies each file's part of the diff, and the whole of it", async () => {
		render(createElement(DiffView, { diff: ONE + TWO }));
		await press("Copy the diff of made.txt");
		expect(writeText).toHaveBeenLastCalledWith(TWO);
		await press("Copy the diff of src/add.ts");
		expect(writeText).toHaveBeenLastCalledWith(ONE);
		await press("Copy the whole diff");
		expect(writeText).toHaveBeenLastCalledWith(ONE + TWO);
	});

	it("offers one control for a diff of one file: the file's, which copies the same", () => {
		render(createElement(DiffView, { diff: ONE }));
		expect(host.querySelectorAll(".copy-button")).toHaveLength(1);
		expect(button("Copy the diff of src/add.ts")).toBeTruthy();
	});
});
