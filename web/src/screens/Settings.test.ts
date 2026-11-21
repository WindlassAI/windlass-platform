// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { loadAuth, saveAuth } from "../lib/authStore";
import { AppProvider, useApp } from "../state/app";
import { Settings } from "./Settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
HTMLDialogElement.prototype.close ??= function () { this.open = false; };

it("keeps the session on cancel and signs out this browser after confirming everywhere", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:demo:u_settings:", profile: { uid: "u_settings", email: null, demo: true } };
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const Screen = () => useApp().auth ? createElement(Settings) : createElement("p", null, "Signed out");
	const click = async (label: string, container: ParentNode = host) => {
		const button = Array.from(container.querySelectorAll("button")).find(one => one.textContent === label);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
	};
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Screen) })));
		await click("Sign out everywhere");
		await click("Cancel", document);
		expect(loadAuth("mock")).toEqual(auth);
		await click("Sign out everywhere");
		await click("Sign out everywhere", document.querySelector("dialog")!);
		expect(loadAuth("mock")).toBeNull();
		expect(host.textContent).toBe("Signed out");
		await expect(client.user(auth).me()).rejects.toMatchObject({ code: "unauthorized" });
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
}, 15_000);
