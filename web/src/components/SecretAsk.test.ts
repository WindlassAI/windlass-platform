// @vitest-environment jsdom
/**
 * The agent's request for a secret: its reason is the agent's own text and is shown as text, never as
 * Markdown or HTML; the value goes to `onAdd` only, and nothing of it is left in the page, the browser's
 * storage or the address once it was sent, nor in an error. The timeline's line shows the same request
 * without a field, and the session's store keeps it open until a turn starts.
 */
import type { SessionSummary, TimelineItem } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyItem, emptyView, type SessionView } from "../lib/timeline";
import { secretRequestAfter } from "../state/sessionStore";
import { Turn } from "./Blocks";
import { InteractiveProvider, type Interactive, type QuestionFlow } from "./Question";
import { SecretAsk, withoutValue, type SecretAskProps } from "./SecretAsk";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
	localStorage.clear();
	sessionStorage.clear();
});

const VALUE = "re_live_5f2c9a81d0b74e3a";
const WHY = 'Needed for the test. <img src=x onerror="alert(1)"> **bold** [click](https://evil.example/steal) <b>now</b>';
const request = { name: "RESEND_API_KEY", why: WHY };

function render(patch: Partial<SecretAskProps> = {}) {
	const props: SecretAskProps = { request, repository: "acme/harbor", onAdd: vi.fn(async () => undefined), onWithout: vi.fn(async () => undefined), ...patch };
	act(() => root.render(createElement(SecretAsk, props)));
	return props;
}

const field = () => host.querySelector<HTMLInputElement>("input")!;
const button = (text: string) => [...host.querySelectorAll("button")].find((one) => one.textContent?.includes(text));
function type(value: string) {
	const input = field();
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
/** Everything of the page and the browser the value could be left in. */
const traces = () => [host.innerHTML, ...[...host.querySelectorAll("input")].map((input) => input.value), JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), location.href].join("\n");

describe("the reason", () => {
	it("is the agent's text, quoted as text: no element, link or emphasis is made of it", () => {
		render();
		const quote = host.querySelector("blockquote")!;
		expect(quote.textContent).toBe(WHY);
		expect(host.querySelector("img")).toBeNull();
		expect(host.querySelector("a")).toBeNull();
		expect(host.querySelector("strong, b, em")).toBeNull();
		expect(host.textContent).toContain("in the agent's own words");
	});

	it("names the secret in monospace and says where it is saved", () => {
		render();
		expect(host.querySelector("code.secret-ask-name")?.textContent).toBe("RESEND_API_KEY");
		expect(host.textContent).toContain("Saved for repository acme/harbor");
		act(() => root.render(createElement(SecretAsk, { request, repository: null, onAdd: async () => undefined, onWithout: async () => undefined })));
		expect(host.textContent).toContain("Saved for your account");
	});
});

describe("the value", () => {
	it("is a password field the browser does not fill, with a toggle that shows it", () => {
		render();
		const input = field();
		expect(input.type).toBe("password");
		expect(input.autocomplete).toBe("off");
		expect(input.getAttribute("name")).toBeNull();
		act(() => button("Show")!.click());
		expect(field().type).toBe("text");
		act(() => button("Hide")!.click());
		expect(field().type).toBe("password");
	});

	it("is needed for Add and continue", () => {
		render();
		expect(button("Add and continue")!.disabled).toBe(true);
		type(VALUE);
		expect(button("Add and continue")!.disabled).toBe(false);
	});

	it("goes to onAdd only, and nothing of it is left once it was sent", async () => {
		let finish: () => void = () => undefined;
		const onAdd = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		render({ onAdd });
		type(VALUE);
		await act(async () => button("Add and continue")!.click());
		expect(onAdd).toHaveBeenCalledWith(VALUE);
		// Emptied while it is being saved, not only after.
		expect(field().value).toBe("");
		expect(field().type).toBe("password");
		expect(traces()).not.toContain(VALUE);
		await act(async () => finish());
		expect(host.textContent).toContain("RESEND_API_KEY saved; the agent continues.");
		expect(host.querySelector("input")).toBeNull();
		expect(traces()).not.toContain(VALUE);
	});

	it("is taken out of an error, and the field is empty after one", async () => {
		const onAdd = vi.fn(async (value: string) => {
			throw new Error(`The value ${value} was refused.`);
		});
		render({ onAdd });
		type(VALUE);
		await act(async () => button("Add and continue")!.click());
		const alert = host.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("The value [the value] was refused.");
		expect(field().value).toBe("");
		expect(button("Add and continue")!.disabled).toBe(true);
		expect(traces()).not.toContain(VALUE);
		expect(withoutValue("plain", VALUE)).toBe("plain");
		expect(withoutValue("A shorter one could not be taken out.", "short")).toBe("A shorter one could not be taken out.");
	});

	it("is not sent by the other answers, and Give up is only offered when asked for", async () => {
		const props = render();
		expect(button("Give up")).toBeUndefined();
		type(VALUE);
		await act(async () => button("Continue without it")!.click());
		expect(props.onWithout).toHaveBeenCalledWith();
		expect(props.onAdd).not.toHaveBeenCalled();
		const onGiveUp = vi.fn(async () => undefined);
		render({ onGiveUp });
		await act(async () => button("Give up")!.click());
		expect(onGiveUp).toHaveBeenCalledTimes(1);
	});
});

const at = Date.UTC(2026, 10, 23, 22, 0);
const user: TimelineItem = { seq: 1, at, turn: 1, kind: "user", text: "Email the notes", model: "m", effort: null };
const asked: TimelineItem = { seq: 2, at, turn: 1, kind: "platform", level: "info", text: "The agent requested RESEND_API_KEY.", secretRequest: { id: "1", ...request } };

describe("the timeline's line", () => {
	const flow = { question: null } as unknown as QuestionFlow;
	const renderTurn = (value: Interactive) => {
		const view: SessionView = [user, asked].reduce(applyItem, emptyView());
		act(() => root.render(createElement(InteractiveProvider, { value, children: createElement(Turn, { turn: view.turns[0]! }) })));
	};

	it("quotes the reason as text and asks for no value", () => {
		renderTurn({ flow, stopCall: null, secretRequestId: "1" });
		const quote = host.querySelector(".system-secret blockquote");
		expect(quote?.textContent).toBe(WHY);
		expect(host.querySelector(".system-secret a, .system-secret img, .system-secret input")).toBeNull();
		expect(host.textContent).toContain("above the field below");
	});

	it("sends an item's builder to the item's page", () => {
		renderTurn({ flow, stopCall: null, secretRequestId: null, itemId: "it_1" });
		expect(host.querySelector<HTMLAnchorElement>(".system-secret a")?.textContent).toBe("Answer on the item's page");
	});
});

describe("the session's open request", () => {
	const summary = {} as SessionSummary;
	it("opens with its line, stays through a steer and closes when a turn starts", () => {
		const open = secretRequestAfter(null, asked, summary);
		expect(open).toEqual({ id: "1", name: "RESEND_API_KEY", why: WHY });
		expect(secretRequestAfter(open, { ...user, seq: 3, steer: true }, summary)).toBe(open);
		expect(secretRequestAfter(open, { ...user, seq: 3, turn: 2 }, summary)).toBeNull();
	});

	it("is never open in an item's builder, which asks on the item", () => {
		expect(secretRequestAfter(null, asked, { item: { id: "it_1", role: "builder" } } as SessionSummary)).toBeNull();
	});
});
