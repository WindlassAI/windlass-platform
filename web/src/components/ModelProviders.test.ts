// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { ModelProviders } from "./ModelProviders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
HTMLDialogElement.prototype.close ??= function () { this.open = false; };

it("adds, checks, replaces and removes a provider key", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:user:u_keys:ada@example.com", profile: { uid: "u_keys", email: "ada@example.com", demo: false } };
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 2)))); };
	const row = (provider: string) => host.querySelector<HTMLElement>(`[data-provider="${provider}"]`)!;
	const state = (provider: string) => row(provider).querySelector(".machine-used")?.textContent;
	const press = async (scope: ParentNode, label: string) => {
		const button = [...scope.querySelectorAll("button")].find((one) => one.textContent?.startsWith(label));
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
		await settle();
	};
	const enter = async (key: string) => {
		const input = document.querySelector<HTMLInputElement>("dialog input")!;
		expect(input.type).toBe("password");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, key);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await press(document.querySelector("dialog")!, "Save key");
	};
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(ModelProviders) })));
		await settle();
		expect(host.querySelectorAll(".provider-row")).toHaveLength(4);
		expect(state("openai")).toBe("no key");

		await press(row("openai"), "Add key");
		await enter("not-a-key");
		expect(document.querySelector("dialog [role=alert]")?.textContent).toMatch(/format does not match/);
		await enter("sk-proj-abcdefghijklmnop1234");
		expect(document.querySelector("dialog")).toBeNull();
		expect(state("openai")).toBe("connected");
		expect(row("openai").textContent).toContain("…1234");
		expect(row("openai").textContent).toContain("1 model");
		expect(host.textContent).not.toContain("abcdefghijklmnop");

		await press(row("openai"), "Check");
		expect(row("openai").textContent).toContain("checked");

		await press(row("openai"), "Replace");
		expect(document.querySelector<HTMLInputElement>("dialog input")!.value).toBe("");
		await enter("sk-proj-zyxwvutsrqponmlk9876");
		expect(row("openai").textContent).toContain("…9876");
		expect((await client.user(auth).modelProviders()).map((one) => one.last4)).toEqual(["9876"]);

		await press(row("openai"), "Remove");
		expect(document.querySelector("dialog")?.textContent).toMatch(/blocks new requests.*already running may finish/i);
		await press(document.querySelector("dialog")!, "Keep it");
		expect(row("openai").textContent).toContain("…9876");
		await press(row("openai"), "Remove");
		await press(document.querySelector("dialog")!, "Remove key");
		expect(state("openai")).toBe("no key");
		expect(await client.user(auth).modelProviders()).toEqual([]);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
}, 15_000);
