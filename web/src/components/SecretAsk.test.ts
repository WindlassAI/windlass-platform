// @vitest-environment jsdom
/**
 * The agent's request for a secret: its reason is the agent's own text and is shown as text, never as
 * Markdown or HTML; the value goes to `onAdd` only, and nothing of it is left in the page, the browser's
 * storage or the address once it was sent, nor in an error. The timeline's line shows the same request
 * without a field, and the session's store keeps it open until a turn starts.
 */
import type { AuthResult, SessionSummary, TimelineItem } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { loadAuth, saveAuth } from "../lib/authStore";
import { applyItem, emptyView, type SessionView } from "../lib/timeline";
import { AppProvider } from "../state/app";
import { Item, useItem } from "../screens/Item";
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
const NOTICE = "This request came from inside the agent's sandbox; a program there, not only the agent, could have made it.\nIf supplied, this will be saved for this repository with agent scope. <b>**not bold**</b>";

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

	it("is apart from the platform's notice, which is shown as the platform's text, a line each", () => {
		render({ request: { ...request, notice: NOTICE } });
		const notice = host.querySelector<HTMLElement>(".secret-notice")!;
		expect(notice.getAttribute("role")).toBe("note");
		expect(notice.querySelector(".secret-notice-who")?.textContent).toBe("From the platform");
		expect([...notice.querySelectorAll(".secret-notice-line")].map((line) => line.textContent)).toEqual(NOTICE.split("\n"));
		// Not Markdown, not HTML, not inside the agent's quoted words, and the reason holds none of it.
		expect(notice.querySelector("b, strong, em, a")).toBeNull();
		expect(notice.closest("blockquote, figure")).toBeNull();
		expect(host.querySelector("blockquote")!.textContent).toBe(WHY);
		expect(host.querySelector(".secret-ask-why")!.textContent).not.toContain("inside the agent's sandbox");
		expect(notice.classList.contains("secret-notice-account")).toBe(false);
	});

	it("has no notice box when the request has none (an older server)", () => {
		render();
		expect(host.querySelector(".secret-notice")).toBeNull();
	});

	it("names the secret in monospace and says where it is saved", () => {
		render();
		expect(host.querySelector("code.secret-ask-name")?.textContent).toBe("RESEND_API_KEY");
		expect(host.textContent).toContain("Saved for repository acme/harbor");
		expect(host.querySelector(".secret-ask-account")).toBeNull();
		act(() => root.render(createElement(SecretAsk, { request: { ...request, notice: "Through the host connection.\nIf supplied, this will be saved for your account: every agent of yours will have it." }, repository: null, onAdd: async () => undefined, onWithout: async () => undefined })));
		// For the account, the furthest a value reaches: said as a warning, the notice marked as one too.
		const account = host.querySelector(".secret-ask-account.callout-warn");
		expect(account?.textContent).toContain("Saved for your account, not one repository.");
		expect(account?.textContent).toContain("Every agent of yours can read it");
		expect(field().getAttribute("aria-describedby")).toContain(account!.id);
		expect(host.querySelector(".secret-notice.secret-notice-account")).not.toBeNull();
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
		expect(button("Add it and continue")!.disabled).toBe(true);
		type(VALUE);
		expect(button("Add it and continue")!.disabled).toBe(false);
	});

	it("goes to onAdd only, and nothing of it is left once it was sent", async () => {
		let finish: () => void = () => undefined;
		const onAdd = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		render({ onAdd });
		type(VALUE);
		await act(async () => button("Add it and continue")!.click());
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
		await act(async () => button("Add it and continue")!.click());
		const alert = host.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("The value [the value] was refused.");
		expect(field().value).toBe("");
		expect(button("Add it and continue")!.disabled).toBe(true);
		expect(traces()).not.toContain(VALUE);
		expect(withoutValue("plain", VALUE)).toBe("plain");
		expect(withoutValue("A shorter one could not be taken out.", "short")).toBe("A shorter one could not be taken out.");
	});

	it("shows a carried error from the start, as the card of a reopened request does", () => {
		render({ failure: "RESEND_API_KEY already exists for this repository." });
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("already exists for this repository");
		expect(field().value).toBe("");
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
const asked: TimelineItem = { seq: 2, at, turn: 1, kind: "platform", level: "info", text: `A secret was requested for RESEND_API_KEY.\n${NOTICE}`, secretRequest: { id: "1", ...request, notice: NOTICE } };

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

	it("shows the platform's notice once, apart from the reason, and not as Markdown", () => {
		renderTurn({ flow, stopCall: null, secretRequestId: "1", repositoryId: 7101 });
		expect(host.querySelector(".system-text")?.textContent).toBe("A secret was requested for RESEND_API_KEY.");
		const notice = host.querySelector(".system-secret .secret-notice")!;
		expect([...notice.querySelectorAll(".secret-notice-line")].map((line) => line.textContent)).toEqual(NOTICE.split("\n"));
		expect(notice.querySelector("b, strong")).toBeNull();
		expect(notice.closest("blockquote")).toBeNull();
		expect(host.textContent!.split("inside the agent's sandbox").length).toBe(2);
		expect(notice.classList.contains("secret-notice-account")).toBe(false);
	});

	it("marks the notice of a session with no repository, whose value would be the account's", () => {
		renderTurn({ flow, stopCall: null, secretRequestId: "1", repositoryId: null });
		expect(host.querySelector(".system-secret .secret-notice-account")).not.toBeNull();
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
		expect(open).toEqual({ id: "1", name: "RESEND_API_KEY", why: WHY, notice: NOTICE });
		expect(secretRequestAfter(open, { ...user, seq: 3, steer: true }, summary)).toBe(open);
		expect(secretRequestAfter(open, { ...user, seq: 3, turn: 2 }, summary)).toBeNull();
	});

	it("is never open in an item's builder, which asks on the item", () => {
		expect(secretRequestAfter(null, asked, { item: { id: "it_1", role: "builder" } } as SessionSummary)).toBeNull();
	});
});

describe("a save the server refuses as secret_exists", () => {
	let client: MockClient;
	afterEach(() => {
		client.dispose();
		saveAuth("mock", null);
		vi.useRealTimers();
	});
	const wait = async (steps = 8) => {
		for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
	};

	it("shows the server's message, reads the item again, and answers the reopened question's new id on a retry", async () => {
		vi.useFakeTimers();
		client = createMockClient({ origin: "http://localhost:5173" });
		const begun = client.login.start();
		await vi.advanceTimersByTimeAsync(1000);
		const { redirectPrefix, url } = await begun;
		const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
		await vi.advanceTimersByTimeAsync(1000);
		const auth: AuthResult = await finished;
		saveAuth("mock", auth);
		const user = client.user(auth);
		const listing = user.listItems();
		await vi.advanceTimersByTimeAsync(1000);
		const listed = (await listing).find((item) => item.question?.kind === "secret_needed")!;
		const reading = user.item(listed.id);
		await vi.advanceTimersByTimeAsync(1000);
		const before = (await reading).question!;
		expect(before.secret?.notice).toContain("inside the agent's sandbox");
		function Screen() {
			return createElement(Item, { page: useItem(listed.id) });
		}
		act(() => root.render(createElement(AppProvider, { client, children: createElement(Screen) })));
		await wait();
		expect(host.querySelector(".item-question .secret-notice")?.textContent).toContain("inside the agent's sandbox");

		// Saved under Secrets since the agent asked.
		const saving = user.saveRepositorySecret(7101, "docker-windlass-sandbox", { name: "RESEND_API_KEY", value: "re_other_0e9d1c2b3a4f", scope: "agent" });
		await vi.advanceTimersByTimeAsync(1000);
		await saving;
		type(VALUE);
		await act(async () => button("Add it and continue")!.click());
		await wait();
		const alert = host.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("RESEND_API_KEY already exists for this repository");
		expect(traces()).not.toContain(VALUE);
		expect(field().value).toBe("");
		const rereading = user.item(listed.id);
		await vi.advanceTimersByTimeAsync(1000);
		const reopened = (await rereading).question!;
		expect(reopened.kind).toBe("secret_needed");
		expect(reopened.id).not.toBe(before.id);

		// Taken out of Secrets again: the retry answers the new question, which the old id could not.
		const removing = user.deleteRepositorySecret(7101, "docker-windlass-sandbox", "RESEND_API_KEY");
		await vi.advanceTimersByTimeAsync(1000);
		await removing;
		type(VALUE);
		await act(async () => button("Add it and continue")!.click());
		await wait();
		expect(host.textContent).toContain("RESEND_API_KEY saved; the agent continues.");
		expect(host.querySelector('[role="alert"]')).toBeNull();
		const after = user.item(listed.id);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await after).question).toBeNull();
		expect(traces()).not.toContain(VALUE);
		expect(loadAuth("mock")).not.toBeNull();
	});
});
