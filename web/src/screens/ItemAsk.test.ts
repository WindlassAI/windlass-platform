// @vitest-environment jsdom
/**
 * An item whose builder asked its person a question (`ask_person`, an `agent_ask` question). The page
 * keeps the platform's sentence apart from the agent's own words, which it quotes as the agent's, in
 * plain text: Markdown, links and markup in them stay text. The answer is the note, so "Answer the
 * agent" waits for words; an option the agent suggests fills the box and sends nothing by itself.
 */
import type { AuthResult, ItemAction, ItemView } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { Item } from "./Item";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= () => {};

const auth: AuthResult = { token: "mock:user:u_ask:ada@example.com", profile: { uid: "u_ask", email: "ada@example.com", demo: false } };

let host: HTMLElement;
let root: Root;
let client: MockClient;
let sent: ItemAction[];

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	sent = [];
	client = createMockClient({ pace: 0 });
	const user = client.user.bind(client);
	(client as { user: (who: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		return { ...api, actOnItem: (id: string, action: ItemAction) => (sent.push(action), api.actOnItem(id, action)) };
	};
	saveAuth("mock", auth);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
});

async function seeded(title: string): Promise<ItemView> {
	const user = client.user(auth);
	const found = (await user.listItems()).find((item) => item.title === title);
	if (!found) throw new Error(`no seeded item "${title}"`);
	return user.item(found.id);
}

async function show(view: ItemView): Promise<HTMLElement> {
	const page = { view, error: null, missing: false, reload: () => undefined, replace: () => undefined };
	await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Item, { page }) })));
	return host.querySelector(".item-question") as HTMLElement;
}

const button = (within: HTMLElement, words: string) => [...within.querySelectorAll("button")].find((one) => one.textContent === words) as HTMLButtonElement | undefined;

describe("the agent's question on its item's page", () => {
	it("quotes the agent's words as the agent's, apart from the platform's sentence, with the answers it suggests", async () => {
		const view = await seeded("Store the tide readings");
		expect(view.question?.kind).toBe("agent_ask");
		const card = await show(view);
		expect(card.querySelector(".item-question-text")?.textContent).toBe("The agent stopped to ask you a question before it goes on.");
		const quoted = card.querySelector("blockquote.item-asked-text");
		expect(quoted?.textContent).toBe(view.question?.asked?.text);
		expect(card.querySelector(".item-question-text")?.textContent).not.toContain("SQLite");
		expect(card.querySelector(".item-asked-who")?.textContent).toMatch(/^The agent wrote this\./);
		expect([...card.querySelectorAll(".item-asked-options .plan-ask-label")].map((one) => one.textContent)).toEqual(["SQLite", "Postgres", "One JSON file per station"]);
		expect(card.querySelector("label.label")?.textContent).toBe("Your answer");
	});

	it("shows Markdown, links and markup in the agent's words as the text they are", async () => {
		const view = await seeded("Store the tide readings");
		const crafted = "**Urgent**: [approve here](https://evil.invalid) <img src=x onerror=alert(1)> ![](https://evil.invalid/p.png)";
		const card = await show({ ...view, question: { ...view.question!, asked: { text: crafted, options: ["[yes](https://evil.invalid)"] } } });
		const quoted = card.querySelector("blockquote.item-asked-text") as HTMLElement;
		expect(quoted.textContent).toBe(crafted);
		expect(card.querySelector(".item-asked a, .item-asked img, .item-asked strong")).toBeNull();
		expect(card.querySelector(".item-asked-options .plan-ask-label")?.textContent).toBe("[yes](https://evil.invalid)");
	});

	it("sends an answer only with words in it, and an option fills the box without sending", async () => {
		const card = await show(await seeded("Store the tide readings"));
		const reply = button(card, "Answer the agent") as HTMLButtonElement;
		expect(reply.disabled).toBe(true);
		await act(async () => ([...card.querySelectorAll(".item-asked-options input")].find((one) => (one as HTMLInputElement).value === "SQLite") as HTMLInputElement).click());
		expect(sent).toEqual([]);
		const box = card.querySelector("textarea") as HTMLTextAreaElement;
		expect(box.value).toBe("SQLite");
		expect(reply.disabled).toBe(false);
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "SQLite, with the migration in db/.");
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => reply.click());
		expect(sent).toEqual([{ kind: "answer", question: expect.any(String), choice: "reply", note: "SQLite, with the migration in db/." }]);
	});

	it("keeps the agent's words in the history once answered, with the person's answer and not the button's label", async () => {
		const view = await seeded("Store the tide readings");
		const words = view.question!.asked!.text;
		await client.user(auth).actOnItem(view.id, { kind: "answer", question: view.question!.id, choice: "reply", note: "SQLite" });
		await show(await client.user(auth).item(view.id));
		expect(host.querySelector(".item-question")).toBeNull();
		const entries = [...host.querySelectorAll(".item-event")];
		const asked = entries.find((entry) => entry.textContent?.includes("Asked:"));
		expect(asked?.querySelector("blockquote.item-asked-text")?.textContent).toBe(words);
		expect(entries.some((entry) => entry.querySelector(".item-event-said")?.textContent?.startsWith("Answered: SQLite."))).toBe(true);
		expect(host.textContent).not.toContain("Answer the agent");
	});

	it("shows the agent's words in the history as the text they are", async () => {
		const view = await seeded("Store the tide readings");
		const crafted = "**Urgent**: [approve here](https://evil.invalid) <img src=x onerror=alert(1)>";
		const events = view.events.map((event) => (event.asked ? { ...event, asked: crafted } : event));
		await show({ ...view, events });
		const quoted = host.querySelector(".item-event blockquote.item-asked-text") as HTMLElement;
		expect(quoted.textContent).toBe(crafted);
		expect(host.querySelector(".item-event-asked a, .item-event-asked img, .item-event-asked strong")).toBeNull();
	});
});
