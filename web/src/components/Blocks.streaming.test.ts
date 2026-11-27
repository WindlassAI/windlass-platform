// @vitest-environment jsdom
import { act, createElement, memo } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TextBlock, TurnView } from "../lib/timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The copy control, counted: how often the answer's control renders while the answer grows.
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./Copy", async importOriginal => {
	const actual = await importOriginal<typeof import("./Copy")>();
	return {
		...actual,
		CopyButton: memo(function CountedCopy({ label }: { label: string }) {
			if (label === "Copy this answer as Markdown") renders.count++;
			return null;
		}),
	};
});

const { Turn } = await import("./Blocks");

const turnOf = (text: string, streaming: boolean): TurnView => ({
	turn: 1,
	blocks: [{ kind: "text", id: "a", at: 0, messageId: "m", text, streaming } satisfies TextBlock],
	steps: 1,
	stepOpen: false,
	interruptRequested: false,
	changedFiles: null,
	usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
	end: null,
	platformAnswer: null,
});

describe("an answer that streams", () => {
	it("re-renders its text once per chunk, and its copy control not at all", () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		const text = "Running the tests now.\n\n```sh\nbun test\n```\n\nAll of them pass, and the build is clean.";
		act(() => root.render(createElement(Turn, { turn: turnOf(text.slice(0, 10), true) })));
		const prose = host.querySelector(".prose");
		expect(prose).not.toBeNull();
		const changes: MutationRecord[] = [];
		const observer = new MutationObserver(records => changes.push(...records));
		observer.observe(prose as Element, { childList: true, subtree: true });

		const chunks = [20, 40, 60, text.length];
		for (const end of chunks) act(() => root.render(createElement(Turn, { turn: turnOf(text.slice(0, end), true) })));
		changes.push(...observer.takeRecords());
		observer.disconnect();

		expect(renders.count).toBe(1);
		// One replacement of the HTML per chunk, as before: nothing else touches the text while it streams.
		expect(changes.filter(record => record.target === prose)).toHaveLength(chunks.length);
		expect(host.querySelector(".code-block")).toBeNull();
		act(() => root.unmount());
	});
});
