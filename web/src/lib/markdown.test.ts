// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { reasoningTitle, renderMarkdown } from "./markdown";

describe("the assistant's Markdown", () => {
	it("renders prose, code and lists", () => {
		const html = renderMarkdown("Fixed. `add` in `src/add.ts` returned `a - b`.\n\n- one\n- **two**\n\n```ts\nconst a = 1 < 2\n```");
		expect(html).toContain("<code>src/add.ts</code>");
		expect(html).toContain("<li><strong>two</strong></li>");
		expect(html).toContain("<pre><code");
		expect(html).toContain("const a = 1 &lt; 2");
	});

	it("removes anything that could run or load", () => {
		const html = renderMarkdown(
			['<script>alert(1)</script>', '<img src="https://example.com/x.png" onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>', "[y](javascript:alert(2))", '<iframe src="https://example.com"></iframe>', '<p style="position:fixed" onclick="alert(3)">z</p>', "<form><input name=q></form>", "![alt](https://example.com/track.gif)"].join("\n\n"),
		);
		expect(html).not.toMatch(/<script|<img|<iframe|<form|onerror|onclick|javascript:|style=/i);
		expect(html).not.toMatch(/<input(?![^>]*type="checkbox")/i);
		expect(html).toContain("z");
	});

	it("opens links in a new tab without a referrer", () => {
		const html = renderMarkdown("[docs](https://example.com/docs)");
		expect(html).toContain('href="https://example.com/docs"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});

	it("keeps a task list's checkboxes, switched off", () => {
		const html = renderMarkdown("- [x] done\n- [ ] not yet");
		expect(html.match(/<input/g)).toHaveLength(2);
		expect(html).not.toMatch(/<input(?![^>]*disabled)/);
	});

	it("handles text that is still arriving", () => {
		expect(renderMarkdown("Half a `code span and **bold")).toContain("Half a");
		expect(renderMarkdown("```ts\nconst unfinished =")).toContain("const unfinished =");
		expect(renderMarkdown("")).toBe("");
	});
});

describe("a reasoning summary's title", () => {
	it("is its first heading, without the markup", () => {
		expect(reasoningTitle("**Locating the test**\n\nI should find where `add` is defined.")).toBe("Locating the test");
		expect(reasoningTitle("\n## Plan\nsteps")).toBe("Plan");
		expect(reasoningTitle("")).toBe("");
	});
});
