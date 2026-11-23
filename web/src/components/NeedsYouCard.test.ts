// @vitest-environment jsdom
/**
 * The home page's "Needs you" card (NeedsYouCard.tsx), read from the mock's seeds: an item's line is the
 * Factory list's line, so a plan to approve says it waits for approval rather than printing its figures,
 * and an agent's question shows the first line of the agent's own words.
 */
import type { ItemSummary } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { NeedsYouCard, needLine } from "./NeedsYouCard";

const auth = { token: "mock:chatgpt:u_needs:ada@example.com", profile: { uid: "u_needs", email: "ada@example.com", demo: false } };

let items: ItemSummary[] = [];

beforeAll(async () => {
	const mock = createMockClient({ pace: 0 });
	items = await mock.user(auth).listItems();
	mock.dispose();
});

function card(only: ItemSummary[]) {
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(createElement(NeedsYouCard, { sessions: [], items: only, now: Date.now() }));
	return host;
}

describe("the Needs you card", () => {
	it("says a plan waits for approval, not the plan's figures", () => {
		const asking = items.find((one) => one.question);
		expect(asking).toBeDefined();
		const text = "index. Build the search index at release — 2,400,000 tokens, 6 turns, 5400 active seconds";
		const item: ItemSummary = { ...asking!, question: { ...asking!.question!, kind: "plan_approval", text } };
		const host = card([item]);
		const line = host.querySelector(".needs-what");
		expect(line?.textContent).toBe("Its plan waits for your approval.");
		expect(line?.closest(".long-text")).not.toBeNull();
		expect(line?.getAttribute("style")).toContain("--lines:2");
		expect(host.textContent).not.toContain(text);
	});

	it("shows the first line of an agent's own question", () => {
		const item = items.find((one) => one.question?.kind === "agent_ask" && one.question.asked);
		expect(item).toBeDefined();
		const first = item!.question!.asked!.text.trim().split("\n")[0]!.trim();
		expect(needLine(item!)).toBe(first);
		expect(card([item!]).querySelector(".needs-what")?.textContent).toBe(first);
	});
});
