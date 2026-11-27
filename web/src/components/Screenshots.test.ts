// @vitest-environment jsdom
/**
 * The screenshots on an item's page (Screenshots.tsx): each image with its stored size, its caption as
 * text, its links asked once and again once on a failure, and the full-size view.
 */
import type { ItemAttachment, ReviewBlock } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentLink } from "../api/client";
import { ReviewBlocks } from "./ReviewBlocks";
import { COULD_NOT_LOAD, removedLine, Screenshots, useAttachmentLinks } from "./Screenshots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
	// jsdom has no <dialog> of its own that opens.
	HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
		this.removeAttribute("open");
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const HEAD = "8c76c0007d0f1e2a3b4c5d6e7f8091a2b3c4d5e6";
const shot = (id: string, more: Partial<ItemAttachment> = {}): ItemAttachment => ({
	id,
	by: "builder",
	sessionId: "s_1",
	head: HEAD,
	width: 1280,
	height: 800,
	bytes: 80_000,
	sha256: "0".repeat(64),
	caption: `The page ${id}`,
	shows: "after",
	page: "/settings",
	state: "kept",
	...more,
});
const linksOf = (shots: ItemAttachment[], round = 1): AttachmentLink[] =>
	shots
		.filter(one => one.state === "kept")
		.map(one => ({
			id: one.id,
			url: `https://store.example/${one.id}.png?sig=${round}`,
			expiresAt: Date.now() + 600_000,
		}));

/** The screenshots as the item's page shows them, with links asked of `ask`. */
function Page({ ask, shots, days }: { ask: () => Promise<AttachmentLink[]>; shots: ItemAttachment[]; days?: number }) {
	const links = useAttachmentLinks(
		ask,
		shots
			.filter(one => one.state === "kept")
			.map(one => one.id)
			.join(","),
	);
	return createElement(Screenshots, { by: "builder", head: shots[0]?.head ?? null, shots, links, days });
}

async function show(shots: ItemAttachment[], ask = vi.fn(async () => linksOf(shots)), days?: number) {
	await act(async () => root.render(createElement(Page, { ask, shots, days })));
	return ask;
}
const fail = (img: Element) => act(async () => void img.dispatchEvent(new Event("error")));

describe("an item's screenshots", () => {
	it("shows each image at its stored size, without a referrer, with its caption as alt and under it, and who took it", async () => {
		const ask = await show([shot("a_1"), shot("a_2", { shows: "before", page: null, width: 390, height: 844 })]);
		expect(ask).toHaveBeenCalledTimes(1);
		const images = [...host.querySelectorAll("img")];
		expect(
			images.map(img => [
				img.getAttribute("src"),
				img.getAttribute("width"),
				img.getAttribute("height"),
				img.getAttribute("referrerpolicy"),
				img.getAttribute("alt"),
				img.getAttribute("loading"),
				img.getAttribute("decoding"),
			]),
		).toEqual([
			["https://store.example/a_1.png?sig=1", "1280", "800", "no-referrer", "The page a_1", "lazy", "async"],
			["https://store.example/a_2.png?sig=1", "390", "844", "no-referrer", "The page a_2", "lazy", "async"],
		]);
		const text = host.textContent ?? "";
		expect(text).toContain("Screenshots");
		expect(text).toContain("Filed by the builder for commit 8c76c00.");
		const captions = [...host.querySelectorAll("figcaption")].map(one => one.textContent);
		expect(captions).toEqual(["The page a_1after1280 × 800/settings", "The page a_2before390 × 844"]);
	});

	it("identifies a builder filing waiting for its published commit", async () => {
		await show([shot("a_1", { head: null })]);
		expect(host.textContent).toContain("Filed by the builder. No published commit recorded yet.");
	});

	it("keeps an agent's caption and page as typed: no link, no image, no markup", async () => {
		const hostile = "See [x](https://e.example) and <b>this</b> ![](https://e.example/a.png)";
		await show([shot("a_1", { caption: hostile, page: "javascript:alert(1)" })]);
		expect(host.querySelector("a")).toBeNull();
		expect(host.querySelector("b")).toBeNull();
		expect(host.querySelectorAll("img")).toHaveLength(1);
		expect(host.querySelector("figcaption")?.textContent).toContain(hostile);
		expect(host.querySelector(".item-shot-page")?.textContent).toBe("javascript:alert(1)");
		expect(host.querySelector("img")?.getAttribute("alt")).toBe(hostile);
	});

	it("asks for the links once more when an image fails, and says it could not be loaded when it fails again", async () => {
		const shots = [shot("a_1"), shot("a_2")];
		let round = 0;
		const ask = await show(
			shots,
			vi.fn(async () => linksOf(shots, ++round)),
		);
		expect(ask).toHaveBeenCalledTimes(1);
		await fail(host.querySelectorAll("img")[0] as Element);
		expect(ask).toHaveBeenCalledTimes(2);
		// The new links are tried: the image is made again with its new address.
		expect(host.querySelector("img")?.getAttribute("src")).toBe("https://store.example/a_1.png?sig=2");
		await fail(host.querySelectorAll("img")[0] as Element);
		expect(ask).toHaveBeenCalledTimes(2);
		const figures = [...host.querySelectorAll("figure")];
		expect(figures[0]?.textContent).toContain(COULD_NOT_LOAD);
		expect(figures[0]?.querySelector("img")).toBeNull();
		// The other one is still shown.
		expect(figures[1]?.querySelector("img")?.getAttribute("src")).toBe("https://store.example/a_2.png?sig=2");
	});

	it("says it could not be loaded when the platform gives no link for it, or the links cannot be had", async () => {
		await show(
			[shot("a_1"), shot("a_2")],
			vi.fn(async () => linksOf([shot("a_2")])),
		);
		expect(host.querySelectorAll("figure")[0]?.textContent).toContain(COULD_NOT_LOAD);
		expect(host.querySelectorAll("img")).toHaveLength(1);
		await show(
			[shot("a_3")],
			vi.fn(async () => Promise.reject(new Error("offline"))),
		);
		expect(host.textContent).toContain(COULD_NOT_LOAD);
	});

	it("opens one full size in a dialog, at its own pixel size, and closes it with Escape", async () => {
		const ask = await show([shot("a_1", { width: 1280, height: 6000, caption: "The whole page" })]);
		expect(document.querySelector("dialog")).toBeNull();
		await act(async () => (host.querySelector("button.item-shot-open") as HTMLButtonElement).click());
		const dialog = document.querySelector("dialog");
		expect(dialog?.hasAttribute("open")).toBe(true);
		expect(dialog?.querySelector(".dialog-lede")?.textContent).toContain("The whole page");
		const full = dialog?.querySelector(".item-shot-full img");
		expect([full?.getAttribute("width"), full?.getAttribute("height"), full?.getAttribute("referrerpolicy")]).toEqual([
			"1280",
			"6000",
			"no-referrer",
		]);
		// Fresh links: nothing more is asked.
		expect(ask).toHaveBeenCalledTimes(1);
		// Escape reaches a <dialog> as its `cancel` event.
		await act(async () => void dialog?.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(document.querySelector("dialog")).toBeNull();
	});

	it("asks again before the full-size view when the links are about to expire", async () => {
		const shots = [shot("a_1")];
		const ask = await show(
			shots,
			vi.fn(async () => linksOf(shots).map(link => ({ ...link, expiresAt: Date.now() + 10_000 }))),
		);
		await act(async () => (host.querySelector("button.item-shot-open") as HTMLButtonElement).click());
		expect(ask).toHaveBeenCalledTimes(2);
	});

	it("shows nothing when none were filed, one line when all were removed, and says so of one removed among others", async () => {
		const ask = await show([]);
		expect(host.innerHTML).toBe("");
		expect(ask).not.toHaveBeenCalled();

		const none = await show([shot("a_1", { state: "removed" }), shot("a_2", { state: "removed" })]);
		expect(none).not.toHaveBeenCalled();
		expect(host.textContent).toBe(`Screenshots${removedLine()}`);
		expect(removedLine()).toBe("The screenshots of this item were removed after it ended.");
		await show(
			[shot("a_1", { state: "removed" })],
			vi.fn(async () => []),
			180,
		);
		expect(host.textContent).toContain("The screenshots of this item were removed 180 days after it ended.");

		await show([shot("a_1"), shot("a_2", { state: "removed" })]);
		expect(host.querySelectorAll("img")).toHaveLength(1);
		expect(host.querySelectorAll("figure")[1]?.textContent).toContain("This screenshot was removed.");
	});
});

describe("a report's screenshot blocks", () => {
	it("are gathered under the other blocks, in the order filed, and no longer say they are not shown", async () => {
		const shots = [shot("a_1"), shot("a_2")];
		const blocks: ReviewBlock[] = [
			{ kind: "text", heading: "What it did", text: "Moved the menu.", refs: [] },
			{ kind: "screenshot", attachment: "a_2" },
			{ kind: "screenshot", attachment: "a_1" },
			{ kind: "screenshot", attachment: "a_unknown" },
		];
		const ask = async () => linksOf(shots);
		function Report() {
			const links = useAttachmentLinks(ask, "a_1,a_2");
			return createElement(ReviewBlocks, {
				blocks,
				records: [],
				verdict: null,
				author: "The agent",
				screenshots: { shots, links },
			});
		}
		await act(async () => root.render(createElement(Report)));
		expect(host.textContent).not.toContain("not shown");
		expect(host.querySelectorAll("dl > div")).toHaveLength(1);
		const group = host.querySelector("dl + .item-shots");
		expect([...(group?.querySelectorAll("img") ?? [])].map(img => img.getAttribute("alt"))).toEqual([
			"The page a_2",
			"The page a_1",
		]);
	});
});
