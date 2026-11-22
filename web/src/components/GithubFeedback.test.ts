// @vitest-environment jsdom
/**
 * "From GitHub" on an item's page (GithubFeedback.tsx, G4), read from the mock's seeds: each batch's state
 * in its word and the server's reason, open batches first, who, when, file and line, the earlier commit
 * named, the only links each entry's own https address on GitHub, the text kept as typed, and feedback
 * from people without write access shown as a count alone.
 */
import type { FeedbackEntry, ItemView } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { GithubFeedback } from "./GithubFeedback";

const auth = { token: "mock:chatgpt:u_feedback:ada@example.com", profile: { uid: "u_feedback", email: "ada@example.com", demo: false } };

let views: ItemView[] = [];

beforeEach(async () => {
	if (views.length > 0) return;
	const mock = createMockClient({ pace: 0 });
	const user = mock.user(auth);
	views = await Promise.all((await user.listItems()).map((item) => user.item(item.id)));
	mock.dispose();
});

const viewNamed = (title: string): ItemView => {
	const found = views.find((view) => view.title === title);
	if (!found) throw new Error(`no seeded item "${title}"`);
	return found;
};

function section(view: ItemView) {
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(createElement(GithubFeedback, { view, when: (at: number) => new Date(at).toISOString().slice(11, 16) }));
	const batches = [...host.querySelectorAll(".gh-batch")].map((one) => ({
		state: one.getAttribute("data-state"),
		word: one.querySelector(".gh-state")?.textContent,
		reason: one.querySelector(".gh-reason")?.textContent,
		hidden: one.closest("[hidden]") !== null,
	}));
	return { host, batches, text: (host.textContent ?? "").replace(/\s+/g, " ") };
}

describe("the From GitHub section", () => {
	it("is left out when the item has no feedback", () => {
		expect(section(viewNamed("Show the upload's checksum in the log")).host.innerHTML).not.toBe("");
		expect(section(viewNamed("Bump the TLS library")).host.innerHTML).toBe("");
	});

	it("puts open batches first, says each state in a word and the server's reason, and folds the oldest settled ones", () => {
		const { batches } = section(viewNamed("Show the tide station's local time"));
		expect(batches.map((one) => [one.word, one.hidden])).toEqual([["Needs you", false], ["Taken", false], ["Taken", false], ["Taken", true]]);
		expect(batches[0]?.reason).toBe("Answer it above, under It asks you.");
		expect(batches.slice(1).map((one) => one.reason)).toEqual(["Sent to the agent in run 4.", "Sent to the agent in run 3.", "Sent to the agent in run 2."]);
		const streamed = section(viewNamed("Stream large artefacts instead of buffering them"));
		expect(streamed.batches.map((one) => [one.word, one.reason])).toEqual([
			["Held", "Sent once this run's CI has finished, before the handoff."],
			["Taken", "Sent to the agent in run 3."],
			["Not taken", "The same feedback was taken in run 2."],
			["Taken", "Sent to the agent in run 2."],
		]);
		expect(streamed.text).toContain("Show 1 earlier batch");
	});

	it("names who wrote each entry, their access, the kind, the file and line, and an earlier commit", () => {
		const { host } = section(viewNamed("Stream large artefacts instead of buffering them"));
		const entries = [...host.querySelectorAll(".gh-entry")].map((one) => ({
			who: one.querySelector(".gh-who")?.textContent,
			meta: [...one.querySelectorAll(".gh-meta > span")].map((span) => span.textContent),
			where: one.querySelector(".gh-where")?.textContent ?? null,
		}));
		expect(entries[0]).toEqual({ who: "@jonas", meta: ["write access", "Line comment", expect.stringMatching(/^\d\d:\d\d$/)], where: expect.stringMatching(/^src\/upload\/stream\.ts:57at [0-9a-f]{7}$/) });
		expect(entries[2]?.where).toMatch(/^src\/upload\/progress\.ts:23on an earlier commit, [0-9a-f]{7}$/);
		expect(entries.find((one) => one.who === "@ada")?.meta[0]).toBe("you");
	});

	it("counts feedback from people without write access, and shows none of it", () => {
		const { host, batches } = section(viewNamed("Show the upload's checksum in the log"));
		expect(batches.map((one) => one.word)).toEqual(["Waiting", "Not taken"]);
		expect(host.querySelector(".gh-counted")?.textContent?.replace(/\s+/g, " ")).toBe("Counted only2 reviews or comments from people without write access. Not shown here, not sent to the agent, and not answered on GitHub.");
	});

	it("links only to each entry's own https address, and keeps the text as typed", () => {
		const base = viewNamed("Cache the parsed station file");
		const entry: FeedbackEntry = { ...base.feedback.batches[0]!.entries[0]!, body: "[click](https://evil.example) <img src=x onerror=alert(1)> **bold**", url: "javascript:alert(1)" };
		const view = { ...base, feedback: { notTaken: 0, batches: [{ ...base.feedback.batches[0]!, entries: [entry] }] } };
		const { host } = section(view);
		expect(host.querySelectorAll("a")).toHaveLength(0);
		expect(host.querySelector("img")).toBeNull();
		expect(host.querySelector(".gh-quote")?.textContent).toBe("[click](https://evil.example) <img src=x onerror=alert(1)> **bold**");
		const links = [...section(base).host.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]);
		expect(links).toHaveLength(3);
		for (const [href, target, rel] of links) {
			expect(href).toMatch(/^https:\/\/github\.com\/ada\/tide-tables\/pull\/51#(pullrequestreview-|discussion_r)\d+$/);
			expect([target, rel]).toEqual(["_blank", "noreferrer noopener"]);
		}
	});
});
