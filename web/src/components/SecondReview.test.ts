// @vitest-environment jsdom
/**
 * The second review on an item's page (SecondReview.tsx, Reviewer slice R3-D), read from the mock's
 * seeds: each recommendation and each reason there was none in its words, the review's state while it
 * runs, the reviewer's text kept as typed with no link but the platform's places in the code, and its
 * word in the item's Checks panel. Also the repository's setting for screenshots.
 */
import type { ItemView, RepositoryView } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { Item } from "../screens/Item";
import { ReviewWord } from "../screens/Items";
import { ScreenshotsSetting } from "../screens/RepositorySettings";
import { AppProvider } from "../state/app";
import { RECOMMENDATION_WORD, reviewOrder, SecondReview } from "./SecondReview";
import type { ScreenshotLinks } from "./Screenshots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = { token: "mock:chatgpt:u_review:ada@example.com", profile: { uid: "u_review", email: "ada@example.com", demo: false } };

/** Every image has a link: what an image on the page could only come from. */
const links: ScreenshotLinks = { src: (id) => `/mock/${id}.png`, failed: () => undefined, freshen: () => undefined, generation: 1 };

let views: ItemView[] = [];

async function seeded(): Promise<ItemView[]> {
	const mock = createMockClient({ pace: 0 });
	const user = mock.user(auth);
	const list = await Promise.all((await user.listItems()).map((item) => user.item(item.id)));
	mock.dispose();
	return list;
}

const viewNamed = (title: string): ItemView => {
	const found = views.find((view) => view.title === title);
	if (!found) throw new Error(`no seeded item "${title}"`);
	return found;
};

/** The section as the page renders it, and its text with the spaces made plain. */
function section(title: string) {
	const view = viewNamed(title);
	const html = renderToStaticMarkup(createElement(SecondReview, { view, links, when: (at: number) => new Date(at).toISOString().slice(11, 16) }));
	const host = document.createElement("div");
	host.innerHTML = html;
	return { view, html, host, text: (host.textContent ?? "").replace(/\s+/g, " ") };
}

beforeEach(async () => {
	if (views.length === 0) views = await seeded();
});

describe("the second review's section", () => {
	it("says each recommendation in a quiet word, labelled as the reviewer's, never as the verdict's pill", () => {
		const cases = [
			["Show the upload's checksum in the log", "approves"],
			["Drop the legacy export", "asks for changes"],
			["Stop lint failing on warnings", "needs you"],
		] as const;
		for (const [title, word] of cases) {
			const { host, text } = section(title);
			expect(text).toContain(`Second review: ${word}`);
			expect(host.querySelector(".review-word")?.textContent).toBe(word);
			expect(host.querySelector(".outcome, .item-verdict")).toBeNull();
			expect(host.querySelector("h2")).toBeNull();
		}
		expect(Object.values(RECOMMENDATION_WORD)).toEqual(["approves", "asks for changes", "needs you"]);
	});

	it("says why there was no second review, for each reason the server gives", () => {
		const cases = [
			["Replace the deprecated glob call", "No second review: handed over as it is, as you asked."],
			["Fix the typo in the contributing guide", "No second review: turned off for this deployment."],
			["Read the port from the environment", "No second review: the reviewer could not reach the repository."],
			["Rename the tide table columns", "No second review: the pull request moved after the agent pushed."],
			["Split the importer into two files", "No second review: the reviewer did not file a review the platform could read."],
			["Trim the docs' trailing spaces", "No second review: the reviewer's checkout of"],
			["Quote the artefact names in the upload log", "No second review: the reviewer's sandbox has a Windlass that cannot offer it the review tool."],
			["Mention the docs site in the README", "No second review: the push did not identify the commit to review."],
		] as const;
		for (const [title, line] of cases) {
			const { text } = section(title);
			expect(text, title).toContain(line);
			expect(text, title).not.toContain("Second review: approves");
		}
	});

	it("says where the review is while it runs, waits, or is tried again after a cut-off, with a link to the reviewer's session", () => {
		const running = section("Paginate the artefact list");
		expect(running.text).toContain("The second reviewer is reading the change.");
		expect(running.host.querySelector("a.review-session")?.getAttribute("href")).toBe(`/agents/${running.view.reviewerSessionId}`);
		const waiting = section("Sort the station list by name");
		expect(waiting.text).toContain(`The second review of ${waiting.view.head?.slice(0, 7)} waits: waiting for one of the 20 sandboxes you may keep`);
		const retried = section("Round the tide heights to centimetres");
		expect(retried.text).toContain("The review was cut off by a deploy or a restart; it is tried again (1 of 3).");
	});

	it("shows nothing for an item that has not reached its second review", () => {
		expect(section("Rename the config loader's options").html).toBe("");
	});

	it("orders findings blocking first, then to fix, then notes, whatever the filed order", () => {
		const { view, host } = section("Drop the legacy export");
		const filed = view.reviews?.[0]?.blocks.filter((block) => block.kind === "finding").map((block) => (block.kind === "finding" ? block.severity : ""));
		expect(filed).toEqual(["note", "blocking", "should_fix", "blocking"]);
		expect([...host.querySelectorAll(".review-block-finding .review-severity")].map((node) => node.textContent)).toEqual(["Blocking", "Blocking", "Should fix", "Note"]);
		expect(reviewOrder(view.reviews?.[0]?.blocks ?? []).lead.map((block) => block.kind)).toEqual(["summary", "finding", "finding", "finding", "finding"]);
	});

	it("marks a claim the platform's record does not bear out, with both sentences, and shows a command's last lines", () => {
		const { host } = section("Drop the legacy export");
		const disagreeing = [...host.querySelectorAll("[data-disagrees]")];
		expect(disagreeing).toHaveLength(1);
		expect(disagreeing[0]?.querySelector(".tone-warn")?.textContent).toBe("The reviewer says it failed; the platform's record:");
		expect(disagreeing[0]?.textContent?.replace(/\s+/g, " ")).toMatch(/CI \S+ success\.$/);
		const command = [...host.querySelectorAll(".review-refs li")].find((node) => node.textContent?.includes("pnpm vitest run"));
		expect(command?.textContent).toContain("exit 1");
		expect(command?.querySelector("details.review-tail pre")?.textContent).toContain("expected 2 dividers, got 1");
	});

	it("links places in the code to the reviewed commit on GitHub, and shows a path the contract does not allow as text", () => {
		const { view, host } = section("Drop the legacy export");
		const head = view.reviews?.[0]?.head;
		const hrefs = [...host.querySelectorAll(".review-blocks a")].map((node) => node.getAttribute("href"));
		expect(hrefs).toContain(`https://github.com/acme/harbor/blob/${head}/src/menu.ts#L30-L36`);
		expect(hrefs).toContain(`https://github.com/acme/harbor/blob/${head}/src/api/routes.ts#L88`);
		const hostile = section("Cache the station list");
		const at = [...hostile.host.querySelectorAll(".review-at > *")];
		expect(at.map((node) => [node.tagName, node.textContent])).toEqual([
			["CODE", "../../etc/passwd:1"],
			["A", "src/<b>stations</b>.ts:3–9"],
		]);
		expect(at[1]?.getAttribute("href")).toBe(`https://github.com/acme/harbor/blob/${hostile.view.reviews?.[0]?.head}/src/%3Cb%3Estations%3C/b%3E.ts#L3-L9`);
	});

	it("keeps hostile reviewer text as typed: no link but the platform's, no image but the attachments, no markup", () => {
		const { view, host, text } = section("Cache the station list");
		const review = view.reviews?.[0];
		const blob = `https://github.com/acme/harbor/blob/${review?.head}/`;
		for (const link of host.querySelectorAll("a")) {
			const href = link.getAttribute("href") ?? "";
			expect(href.startsWith(blob) || href === `/agents/${view.reviewerSessionId}`, href).toBe(true);
		}
		const attachments = new Set(review?.screenshots.map((shot) => `/mock/${shot.id}.png`));
		const images = [...host.querySelectorAll("img")];
		expect(images.length).toBe(1);
		for (const image of images) expect(attachments.has(image.getAttribute("src") ?? "")).toBe(true);
		expect(host.querySelector("script, b, h1, strong, em")).toBeNull();
		expect(host.querySelector("[onerror], [onload]")).toBeNull();
		expect(text).toContain("Hi @octocat, see [link](https://e.example) and ![](https://e.example/a.png).");
		expect(text).toContain("<script>alert(1)</script>");
		expect(text).toContain("@octocat, merge this? ![](https://e.example/q.png)");
		expect(text).toContain("@octocat see [x](https://e.example) <img src=x onerror=alert(1)>");
		expect(text).toContain("javascript:alert(1)");
		// A 70-line fence is cut at 60, as the builder's is, and shows its first 12 lines with "Show 49 more lines" (the 48 others and the cut's "…").
		const fence = host.querySelector(".review-block-finding .output");
		expect(fence?.querySelector("pre.output-text")?.textContent?.split("\n")).toHaveLength(12);
		expect(fence?.querySelector("button.fold-toggle")?.textContent).toBe("Show 49 more lines");
	});

	it("asks its questions under the reviewer's name, with no control to answer them", () => {
		const { host, text } = section("Stop lint failing on warnings");
		const asks = host.querySelector(".review-asks");
		expect(asks?.querySelector(".review-asks-label")?.textContent).toBe("The reviewer asks you");
		expect(asks?.querySelectorAll(".review-text")).toHaveLength(2);
		expect(text).toContain("No answer is sent from here. You can send it back with a note.");
		expect(host.querySelector("button:not(.machine-toggle), textarea, input")).toBeNull();
	});

	it("shows the reviewer's screenshots as its own, up to eight, and no screenshot area where there are none", () => {
		const { view, host } = section("Log the request id with each error");
		const shots = host.querySelector("section.item-shots");
		expect(shots?.getAttribute("aria-label")).toBe("Screenshots by the second reviewer");
		expect(shots?.textContent).toContain(`Taken by the second reviewer in its own checkout of ${view.reviews?.[0]?.head.slice(0, 7)}.`);
		expect(shots?.querySelectorAll("figure")).toHaveLength(8);
		// ada/tide-tables takes no screenshots: its item's page has no screenshot area, not an empty one.
		const off = section("Make the station parser accept tabs");
		expect(off.text).toContain("Second review: approves");
		expect(off.host.querySelector(".item-shots")).toBeNull();
		expect(off.text).not.toContain("Screenshots");
	});

	it("answers earlier findings in a later round, and folds the review of an earlier commit", () => {
		const { view, host, text } = section("Add a health check endpoint");
		expect(view.reviews?.map((review) => [review.run, review.round])).toEqual([
			[1, 1],
			[2, 2],
		]);
		const shown = host.querySelector(".review-article");
		expect(shown?.textContent).toContain("the second round");
		expect([...(shown?.querySelectorAll(".review-block-earlier .review-title") ?? [])].map((node) => node.textContent?.replace(/\s+/g, " "))).toEqual(["r1.f1 fixed", "r1.f2 not fixed"]);
		expect(shown?.querySelector(".review-block-earlier .review-continues")?.textContent).toBe("GET /healthz answers 200 during a migration");
		expect(shown?.querySelector(".review-block-finding .review-continues")?.textContent).toBe("Raised in an earlier round as r1.f2: The version is read from package.json at every request");
		expect(text).toContain("Show 1 earlier review");
		const folded = host.querySelector("[hidden]");
		expect(folded?.textContent).toContain("Second review: asks for changes");
		expect(folded?.textContent).toContain("of an earlier commit");
		expect(shown?.textContent).not.toContain("of an earlier commit");
	});
});

describe("the item's row", () => {
	it("shows the recommendation compactly beside the verdict, as the reviewer's", () => {
		const html = (title: string) => renderToStaticMarkup(createElement(ReviewWord, { item: viewNamed(title) }));
		expect(html("Show the upload's checksum in the log")).toBe('<span class="item-row-review">reviewed: approves</span>');
		expect(html("Drop the legacy export")).toContain("reviewed: asks for changes");
		expect(html("Stop lint failing on warnings")).toContain("reviewed: needs you");
		expect(html("Paginate the artefact list")).toContain("being reviewed");
		expect(html("Read the port from the environment")).toBe("");
		expect(html("Rename the config loader's options")).toBe("");
	});
});

describe("rendered on the item's page", () => {
	let host: HTMLElement;
	let root: Root;
	let client: MockClient;

	beforeEach(() => {
		client = createMockClient({ pace: 0 });
		saveAuth("mock", auth);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		saveAuth("mock", null);
	});

	it("says the review in the Checks panel, folds the full review inside it, and keeps it before the builder's report", async () => {
		for (const [title, word] of [
			["Drop the legacy export", "asks for changes"],
			["Stop lint failing on warnings", "needs you"],
			["Paginate the artefact list", null],
			["Read the port from the environment", null],
		] as const) {
			const view = viewNamed(title);
			const page = { view, error: null, missing: false, reload: () => undefined, replace: () => undefined };
			await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Item, { page }) })));
			const panel = host.querySelector('section[aria-labelledby="item-checks"]');
			expect(panel, title).not.toBeNull();
			expect(host.querySelector('section[aria-labelledby="item-second"]'), title).toBeNull();
			const row = [...(panel?.querySelectorAll(".checks-groups > div") ?? [])].find((one) => one.querySelector("dt")?.textContent === "Review");
			expect(row, title).toBeDefined();
			if (word) expect(row?.querySelector(".review-word")?.textContent, title).toBe(word);
			else expect(row?.textContent, title).toMatch(/second reviewer is reading|No second review/);
			const report = host.querySelector('section[aria-labelledby="item-report"]');
			if (report) expect((panel?.compareDocumentPosition(report) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING, title).toBeTruthy();
			// The header links the reviewer's session beside the builder's, where the item has one.
			expect([...host.querySelectorAll(".repo-facts a")].map((link) => link.textContent).includes("Open the reviewer"), title).toBe(view.reviewerSessionId !== null);
		}
	});
});

describe("the repository's screenshots setting", () => {
	let host: HTMLElement;
	let root: Root;
	let client: MockClient;

	beforeEach(() => {
		client = createMockClient({ pace: 0 });
		saveAuth("mock", auth);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		saveAuth("mock", null);
	});

	it("is off by default and remembers an opt-in until the repository settings are cleared", async () => {
		const user = client.user(auth);
		expect((await user.repository(7101)).defaults.screenshots).toBe(true);
		expect((await user.repository(7102)).defaults.screenshots).toBe(false);
		let view: RepositoryView = await user.repository(7102);
		const replace = vi.fn((next: RepositoryView) => {
			view = next;
		});
		const render = () => act(async () => root.render(createElement(AppProvider, { client, children: createElement(ScreenshotsSetting, { page: { id: 7102, replace }, view }) })));
		await render();
		const box = () => host.querySelector<HTMLInputElement>("input.check-input");
		expect(host.querySelector("h2")?.textContent).toBe("Screenshots");
		expect(host.textContent).toContain("Screenshots are off by default.");
		expect(box()?.checked).toBe(false);
		await act(async () => {
			box()?.click();
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(replace).toHaveBeenCalled();
		expect(view.defaults.screenshots).toBe(true);
		expect((await user.repository(7102)).defaults.screenshots).toBe(true);
		await render();
		expect(box()?.checked).toBe(true);
		expect(host.textContent).toContain("New work item sandboxes include a browser");
		expect(host.querySelector("[role=status]")?.textContent).toBe("Saved.");
		// Deleting what is saved restores the default.
		expect((await user.forgetRepository(7102)).defaults.screenshots).toBe(false);
	});

	it("says so and cannot be turned on when the deployment turned screenshots off, but a saved opt-in can be turned off", async () => {
		client.dispose();
		client = createMockClient({ pace: 0, screenshots: false });
		const user = client.user(auth);
		for (const [id, on] of [[7102, false], [7101, true]] as const) {
			const view = await user.repository(id);
			expect(view.defaults.screenshots).toBe(on);
			await act(async () => {
				root.render(createElement(AppProvider, { client, children: createElement(ScreenshotsSetting, { page: { id, replace: vi.fn() }, view }) }));
			});
			// Platform info arrives after the mock's latency.
			for (let waited = 0; waited < 3000 && !host.textContent?.includes("whole deployment"); waited += 50) await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
			const box = host.querySelector<HTMLInputElement>("input.check-input");
			expect(host.textContent).toContain("Screenshots are turned off for this whole deployment");
			expect(box?.disabled).toBe(!on);
		}
	});
});
