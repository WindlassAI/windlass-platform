// @vitest-environment jsdom
/**
 * Adding a machine: the confirm step shows the machine key's fingerprint, and Connect stays off until
 * the person says the runner's terminal shows the same one.
 */
import type { AuthResult } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { App } from "../App";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });
// jsdom has no modal dialogs.
HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
HTMLDialogElement.prototype.close ??= function () { this.open = false; };
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;

const ada: AuthResult = { token: "mock:chatgpt:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } };

let host: HTMLElement;
let root: Root;
let client: MockClient;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	sessionStorage.clear();
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
});

async function settle(steps = 14): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2))));
}

const button = (name: string) => [...document.body.querySelectorAll("button")].find((one) => one.textContent?.trim() === name) as HTMLButtonElement | undefined;

describe("adding a machine", () => {
	it("shows the machine key and connects only once the person says their terminal shows the same", async () => {
		history.replaceState(null, "", "/machines");
		client = createMockClient({ pace: 0, origin: "http://localhost:5173" });
		saveAuth("mock", ada);
		root = createRoot(host);
		act(() => root.render(createElement(AppProvider, { client, children: createElement(App) })));
		await settle();
		act(() => button("Add a machine")?.click());
		act(() => button("Enter the code")?.click());
		const field = document.body.querySelector<HTMLInputElement>("input.machine-code");
		expect(field).not.toBeNull();
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "WXYZ-1210");
			field!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Check code")?.click());
		await settle(40);
		expect(document.body.querySelector(".machine-key-value")?.textContent).toBe("K7Q2M-XR4TD");
		expect(document.body.textContent).toContain("The runner's terminal shows the same machine key");
		const connect = button("Connect");
		expect(connect?.disabled).toBe(true);
		const box = document.body.querySelector<HTMLInputElement>(".machine-key input.check-input");
		act(() => box?.click());
		expect(button("Connect")?.disabled).toBe(false);
		const before = (await client.user(ada).machines()).length;
		act(() => button("Connect")?.click());
		await settle(80);
		expect((await client.user(ada).machines()).length).toBe(before + 1);
	});

	it("is refused by the mock, as by the platform, without the person's word", async () => {
		client = createMockClient({ pace: 0 });
		const user = client.user(ada);
		await user.claimMachine({ code: "WXYZ-1211" });
		await expect(user.confirmMachine({ code: "WXYZ-1211" } as { code: string; keyConfirmed: true })).rejects.toMatchObject({ reason: "key_not_confirmed" });
		root = createRoot(host);
	});
});
