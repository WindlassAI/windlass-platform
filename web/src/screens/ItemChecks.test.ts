// @vitest-environment jsdom
/**
 * The Checks panel of an item's page (ItemChecks.tsx), read from the mock's seeds: its first line ("Ready to merge" or
 * what is open), CI folded to one line when every check passed and failed first otherwise, the cancelled sentence, the
 * review's blocking findings as rows that unfold, and the open GitHub comments with their authors.
 */
import type { ItemView } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { checksSummary, ciState, ItemChecks, openLine, sortedRuns } from "./ItemChecks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = {
	token: "mock:user:u_checks:ada@example.com",
	profile: { uid: "u_checks", email: "ada@example.com", demo: false },
};
const links = {
	src: (id: string) => `/mock/${id}.png`,
	failed: () => undefined,
	freshen: () => undefined,
	generation: 1,
};

let views: ItemView[] = [];

beforeEach(async () => {
	if (views.length > 0) return;
	const mock = createMockClient({ pace: 0 });
	const user = mock.user(auth);
	views = await Promise.all((await user.listItems()).map(item => user.item(item.id)));
	mock.dispose();
});

const viewNamed = (title: string): ItemView => {
	const found = views.find(view => view.title === title);
	if (!found) throw new Error(`no seeded item "${title}"`);
	return found;
};

describe("what the panel's first line says", () => {
	it("says Ready to merge only when nothing is open and the verdict is a pass", () => {
		expect(checksSummary(viewNamed("Show the build number in the footer"))).toMatchObject({ open: [], ready: true });
		// Approved, but a comment on GitHub waits.
		const waiting = checksSummary(viewNamed("Show the upload's checksum in the log"));
		expect(waiting.ready).toBe(false);
		expect(openLine(waiting.open)).toBe("1 open: 1 comment on GitHub");
	});

	it("counts failed and cancelled CI checks, blocking findings and comments", () => {
		expect(openLine(checksSummary(viewNamed("Replace the deprecated glob call")).open)).toBe(
			"1 open: 1 failed CI check",
		);
		expect(openLine(checksSummary(viewNamed("Speed up the station import")).open)).toBe(
			"2 open: 2 cancelled CI checks",
		);
		expect(openLine(checksSummary(viewNamed("Drop the legacy export")).open)).toBe(
			"5 open: 1 thing to look at, 2 blocking findings, 2 comments on GitHub",
		);
		expect(openLine(checksSummary(viewNamed("Stop lint failing on warnings")).open)).toContain(
			"2 questions from the reviewer",
		);
	});

	it("names the second review as open while it runs", () => {
		const running = checksSummary(viewNamed("Paginate the artefact list"));
		expect(running.reviewing).toBe(true);
		expect(running.open.map(one => one.words)).toContain("the second review");
	});
});

describe("CI's rows", () => {
	it("sorts failed first, then running, cancelled, skipped, passed", () => {
		const runs = ["success", "cancelled", "", "failure", "skipped", "not_run"].map((conclusion, index) => ({
			name: `c${index}`,
			app: "github-actions",
			conclusion,
			url: "https://github.com/a/b/actions/runs/1",
		}));
		expect(sortedRuns(runs).map(run => ciState(run.conclusion))).toEqual([
			"failed",
			"failed",
			"running",
			"cancelled",
			"skipped",
			"passed",
		]);
	});
});

describe("the panel on the page", () => {
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

	async function render(title: string) {
		const view = viewNamed(title);
		await act(async () =>
			root.render(
				createElement(AppProvider, {
					client,
					children: createElement(ItemChecks, {
						view,
						links,
						when: (at: number) => new Date(at).toISOString().slice(11, 16),
					}),
				}),
			),
		);
		const row = (label: string) =>
			[...host.querySelectorAll(".checks-groups > div")].find(one => one.querySelector("dt")?.textContent === label) as
				| HTMLElement
				| undefined;
		return { view, row, summary: host.querySelector(".checks-summary")?.textContent ?? "" };
	}

	it("folds CI to one line when every check passed", async () => {
		const { row, summary } = await render("Show the build number in the footer");
		expect(summary).toBe("Ready to merge");
		const ci = row("CI")!;
		expect(ci.querySelector(".checks-head")?.textContent).toContain("18 checks passed");
		expect(ci.querySelector(".checks-rows")?.hasAttribute("hidden")).toBe(true);
		act(() => (ci.querySelector("button.fold-toggle") as HTMLButtonElement).click());
		expect(ci.querySelector(".checks-rows")?.hasAttribute("hidden")).toBe(false);
		expect(ci.querySelectorAll(".checks-row")).toHaveLength(18);
	});

	it("shows a failed check first, with its link, and the cancelled ones with the server's sentence", async () => {
		const failed = (await render("Replace the deprecated glob call")).row("CI")!;
		const first = failed.querySelector(".checks-row");
		expect(first?.textContent).toContain("lint");
		expect(first?.textContent).toContain("failed");
		expect(first?.querySelector("a")?.getAttribute("href")).toBe("https://github.com/acme/harbor/actions/runs/9120");
		const cancelled = (await render("Speed up the station import")).row("CI")!;
		expect(cancelled.textContent).toContain(
			"CI did not finish: 2 checks were cancelled (e2e (chromium), e2e (firefox)); nothing failed.",
		);
		expect([...cancelled.querySelectorAll(".checks-row")].slice(0, 2).map(one => one.textContent)).toEqual([
			"e2e (chromium)cancelled",
			"e2e (firefox)cancelled",
		]);
	});

	it("lists the review's blocking findings as rows that unfold, and the open comments with their authors", async () => {
		const { row } = await render("Drop the legacy export");
		const review = row("Review")!;
		expect(review.querySelector(".review-word")?.textContent).toBe("asks for changes");
		const findings = [...review.querySelectorAll(".checks-finding")];
		expect(findings.map(one => one.querySelector(".checks-finding-title")?.textContent)).toEqual([
			"The menu's divider went with the export entry",
			"The settings page keeps the export's heading",
		]);
		const body = findings[0]?.querySelector(".checks-finding-body");
		expect(body?.hasAttribute("hidden")).toBe(true);
		act(() => (findings[0]?.querySelector("button") as HTMLButtonElement).click());
		expect(body?.hasAttribute("hidden")).toBe(false);
		expect(body?.querySelector("a")?.getAttribute("href")).toMatch(
			/^https:\/\/github\.com\/acme\/harbor\/blob\/[0-9a-f]{40}\/src\/menu\.ts#L30-L36$/,
		);
		const github = row("GitHub")!;
		expect([...github.querySelectorAll(".checks-comment .gh-who")].map(one => one.textContent)).toEqual([
			"@ada",
			"@jonas",
		]);
		expect(github.querySelector(".checks-head")?.textContent).toContain("2 open comments");
	});
});
