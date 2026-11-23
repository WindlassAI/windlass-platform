// @vitest-environment jsdom
/**
 * The primitives: where a popover goes, and a menu's keys, filter, submenus, focus and Escape, on a
 * wide screen (a popover) and on a phone (a bottom sheet).
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuSpec } from "./Menu";
import { agentBadge, Pill } from "./Pill";
import { place } from "./position";
import { Sheet } from "./Sheet";
import { Tooltip } from "./Tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("place", () => {
	const viewport = { width: 1000, height: 800 };
	const options = { side: "bottom" as const, align: "start" as const, offset: 6, padding: 8, maxHeight: 360 };

	it("opens below its anchor, start-aligned, capped at its max height", () => {
		expect(place({ x: 100, y: 100, width: 80, height: 30 }, { width: 300, height: 500 }, viewport, options)).toEqual({ x: 100, y: 136, side: "bottom", maxHeight: 360, origin: "top left" });
	});

	it("flips above when the room below is short and above is larger", () => {
		const placed = place({ x: 100, y: 700, width: 80, height: 30 }, { width: 300, height: 200 }, viewport, options);
		expect(placed.side).toBe("top");
		expect(placed.y).toBe(700 - 6 - 200);
		expect(placed.origin).toBe("bottom left");
	});

	it("shifts along the edge to stay on screen, and caps its height at the room it has", () => {
		const placed = place({ x: 900, y: 500, width: 80, height: 30 }, { width: 300, height: 600 }, viewport, { ...options, maxHeight: undefined });
		expect(placed.x).toBe(1000 - 300 - 8);
		// More room above (494) than below (256): it flips, and takes the room above.
		expect(placed.side).toBe("top");
		expect(placed.maxHeight).toBe(486);
	});

	it("puts a submenu to the right, or to the left where the right has no room", () => {
		expect(place({ x: 100, y: 200, width: 300, height: 32 }, { width: 200, height: 160 }, viewport, { ...options, side: "right" }).x).toBe(406);
		const left = place({ x: 700, y: 200, width: 280, height: 32 }, { width: 200, height: 160 }, viewport, { ...options, side: "right" });
		expect(left.side).toBe("left");
		expect(left.x).toBe(700 - 6 - 200);
	});
});

let host: HTMLElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	delete (window as { matchMedia?: unknown }).matchMedia;
});

/** A phone's width, as matchMedia says it. */
function phone(): void {
	(window as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} });
}

const render = (node: ReactNode) => act(() => root.render(node));
const key = (target: Element, name: string) => act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
const trigger = () => host.querySelector("button") as HTMLButtonElement;
const rows = () => [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')] as HTMLElement[];
const highlighted = () => document.querySelector("[data-highlighted]")?.getAttribute("data-value");
const list = () => document.querySelector('.ui-menu-list[role="menu"]') as HTMLElement;

/** A menu of models in two groups; the second Windlass model has efforts in a submenu, the third cannot be chosen. */
function models(chosen: string[], current = "sonnet", effort = "high"): MenuSpec {
	const pick = (id: string) => () => void chosen.push(id);
	return {
		label: "Agent and model",
		hints: { right: "effort" },
		groups: [
			{ id: "claude", label: "Claude Code", note: "signed in", items: [{ id: "opus", label: "Opus 5.5", description: "Most capable", checked: current === "opus", onSelect: pick("opus") }, { id: "sonnet", label: "Sonnet 5.5", checked: current === "sonnet", onSelect: pick("sonnet") }] },
			{
				id: "windlass",
				label: "Windlass",
				items: [
					{ id: "sol", label: "GPT-6.1 Sol", checked: current === "sol", onSelect: pick("sol"), submenu: { label: "Effort for GPT-6.1 Sol", groups: [{ id: "efforts", items: ["low", "high", "max"].map((name) => ({ id: name, label: name, checked: name === effort, onSelect: pick(`sol:${name}`) })) }] } },
					{ id: "luna", label: "GPT-6 Luna", disabled: true, description: "Not on this machine" },
					{ id: "brisk", label: "GPT-6 Brisk", checked: current === "brisk", onSelect: pick("brisk") },
				],
			},
		],
	};
}

function showMenu(spec: MenuSpec) {
	render(createElement(Menu, { spec, trigger: (props) => createElement(Pill, { ...props, children: "Sonnet 5.5" }) }));
}

describe("a menu on a wide screen", () => {
	it("opens on its trigger with the chosen row highlighted, moves with the arrows past rows that cannot be chosen, and chooses with Enter", () => {
		const chosen: string[] = [];
		showMenu(models(chosen));
		act(() => trigger().click());
		expect(trigger().getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(list());
		expect(highlighted()).toBe("sonnet");
		expect(list().getAttribute("aria-activedescendant")).toBe(document.querySelector("[data-highlighted]")?.id);
		key(list(), "ArrowDown");
		expect(highlighted()).toBe("sol");
		key(list(), "ArrowDown");
		// Luna cannot be chosen: the keys pass it.
		expect(highlighted()).toBe("brisk");
		key(list(), "ArrowDown");
		expect(highlighted()).toBe("opus");
		key(list(), "End");
		expect(highlighted()).toBe("brisk");
		key(list(), "Enter");
		expect(chosen).toEqual(["brisk"]);
		expect(document.querySelector(".ui-pop")).toBeNull();
		expect(document.activeElement).toBe(trigger());
	});

	it("groups its rows under their headers, marks the chosen one, and shows its keys at its foot", () => {
		showMenu(models([]));
		act(() => trigger().click());
		expect([...document.querySelectorAll(".ui-menu-group-label")].map((label) => label.textContent)).toEqual(["Claude Codesigned in", "Windlass"]);
		expect(rows().find((row) => row.getAttribute("aria-checked") === "true")?.dataset.value).toBe("sonnet");
		expect(document.querySelector(".ui-menu-hints")?.textContent).toContain("effort");
	});

	it("closes on Escape and gives focus back to its trigger", () => {
		showMenu(models([]));
		act(() => trigger().focus());
		key(trigger(), "ArrowDown");
		expect(document.querySelector(".ui-pop")).not.toBeNull();
		key(list(), "Escape");
		expect(document.querySelector(".ui-pop")).toBeNull();
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger());
	});

	it("closes on a press outside it", () => {
		showMenu(models([]));
		act(() => trigger().click());
		act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(document.querySelector(".ui-pop")).toBeNull();
	});

	it("opens a row's submenu with →, chooses in it, and comes back with ←", () => {
		const chosen: string[] = [];
		showMenu(models(chosen, "sol"));
		act(() => trigger().click());
		expect(highlighted()).toBe("sol");
		key(list(), "ArrowRight");
		const sub = document.querySelector(".ui-pop-sub .ui-menu-list") as HTMLElement;
		expect(sub).not.toBeNull();
		expect(document.activeElement).toBe(sub);
		expect(sub.querySelector("[data-highlighted]")?.getAttribute("data-value")).toBe("high");
		key(sub, "ArrowLeft");
		expect(document.querySelector(".ui-pop-sub")).toBeNull();
		expect(document.activeElement).toBe(list());
		key(list(), "ArrowRight");
		const again = document.querySelector(".ui-pop-sub .ui-menu-list") as HTMLElement;
		key(again, "ArrowUp");
		key(again, "Enter");
		expect(chosen).toEqual(["sol:low"]);
		expect(document.querySelector(".ui-pop")).toBeNull();
		expect(document.activeElement).toBe(trigger());
	});

	it("jumps to the row that starts with what is typed", () => {
		showMenu(models([]));
		act(() => trigger().click());
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		key(list(), "o");
		expect(highlighted()).toBe("opus");
		// Typed together, the letters are one word: "gpt-6 b" is Brisk, after the first that starts "g".
		now += 1000;
		for (const letter of "gpt-6 b") key(list(), letter);
		expect(highlighted()).toBe("brisk");
		// Later, a letter starts again.
		now += 1000;
		key(list(), "g");
		expect(highlighted()).toBe("sol");
	});

	it("filters its rows as one types, marks the letters that match, and chooses the first left with Enter", () => {
		const chosen: string[] = [];
		const spec = models(chosen);
		showMenu({ ...spec, filter: { placeholder: "Filter models" } });
		act(() => trigger().click());
		const input = document.querySelector(".ui-menu-filter-input") as HTMLInputElement;
		expect(document.activeElement).toBe(input);
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "son");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(rows().map((row) => row.dataset.value)).toEqual(["sonnet"]);
		expect(document.querySelector(".ui-mark")?.textContent).toBe("Son");
		expect(input.getAttribute("aria-activedescendant")).toBe(rows()[0]?.id);
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "zzz");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(document.querySelector(".ui-menu-empty")?.textContent).toBe("Nothing matches “zzz”.");
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "gpt");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		key(input, "Enter");
		expect(chosen).toEqual(["sol"]);
	});
});

describe("a menu on a phone", () => {
	it("opens as a bottom sheet, pushes a submenu into it with the way back, and closes on Escape with focus back on the trigger", () => {
		phone();
		const chosen: string[] = [];
		showMenu(models(chosen, "sol"));
		act(() => trigger().click());
		const sheet = document.querySelector('.ui-sheet[role="dialog"]') as HTMLElement;
		expect(sheet).not.toBeNull();
		expect(sheet.getAttribute("aria-modal")).toBe("true");
		expect(sheet.querySelector(".ui-sheet-title")?.textContent).toBe("Agent and model");
		expect(document.querySelector(".ui-pop")).toBeNull();
		expect(document.querySelector(".ui-menu-hints")).toBeNull();
		// The row is chosen by tapping it; its chevron opens its submenu.
		act(() => (sheet.querySelector('[data-value="sol"] .ui-item-push') as HTMLButtonElement).click());
		expect(sheet.querySelector(".ui-sheet-title")?.textContent).toBe("Effort for GPT-6.1 Sol");
		expect(sheet.querySelector(".ui-sheet-back")?.textContent).toBe("Agent and model");
		act(() => (sheet.querySelector(".ui-sheet-back") as HTMLButtonElement).click());
		expect(sheet.querySelector(".ui-sheet-title")?.textContent).toBe("Agent and model");
		key(sheet.querySelector(".ui-menu-list") as HTMLElement, "Escape");
		expect(document.querySelector(".ui-sheet")).toBeNull();
		expect(document.activeElement).toBe(trigger());
	});

	it("chooses a row by tapping it, and closes with Done", () => {
		phone();
		const chosen: string[] = [];
		showMenu(models(chosen));
		act(() => trigger().click());
		act(() => (document.querySelector('[data-value="opus"]') as HTMLElement).click());
		expect(chosen).toEqual(["opus"]);
		expect(document.querySelector(".ui-sheet")).toBeNull();
		act(() => trigger().click());
		act(() => (document.querySelector(".ui-sheet-done") as HTMLButtonElement).click());
		expect(document.querySelector(".ui-sheet")).toBeNull();
	});
});

describe("a sheet", () => {
	it("keeps focus inside it", () => {
		render(createElement(Sheet, { open: true, onClose() {}, title: "Settings", children: createElement("button", { type: "button" }, "Only") }));
		const buttons = [...document.querySelectorAll(".ui-sheet button")] as HTMLButtonElement[];
		const last = buttons[buttons.length - 1] as HTMLButtonElement;
		act(() => last.focus());
		key(last, "Tab");
		expect(document.activeElement).toBe(buttons[0]);
	});
});

describe("a tooltip", () => {
	it("shows on keyboard focus and describes its control while it shows", () => {
		render(createElement(Tooltip, { content: "Setup command and secrets", children: createElement("button", { type: "button" }, "+") }));
		const button = host.querySelector("button") as HTMLButtonElement;
		// jsdom has no :focus-visible; the focus a key gives is what shows it.
		const matches = Element.prototype.matches;
		Element.prototype.matches = function (this: Element, selector: string) {
			return selector === ":focus-visible" ? true : matches.call(this, selector);
		} as typeof matches;
		try {
			act(() => button.focus());
		} finally {
			Element.prototype.matches = matches;
		}
		const tip = document.querySelector('[role="tooltip"]') as HTMLElement;
		expect(tip.textContent).toBe("Setup command and secrets");
		expect(button.getAttribute("aria-describedby")).toBe(tip.id);
		act(() => button.blur());
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
	});
});

describe("agent badges", () => {
	it("gives each agent its own badge, by its id or its name", () => {
		const badges = ["windlass", "claude", "opencode", "codex"].map(agentBadge);
		expect(badges).toEqual(["W", "CC", "OC", "C"]);
		expect(new Set(badges).size).toBe(badges.length);
		expect(agentBadge("Claude Code")).toBe("CC");
	});
});
