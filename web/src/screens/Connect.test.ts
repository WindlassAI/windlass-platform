// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { href, parseRoute, returnAfterSignIn, takeReturnAfterSignIn } from "../lib/router";
import { AppProvider } from "../state/app";
import { Connect } from "./Connect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(code: string | undefined) {
	const client = createMockClient({ pace: 0 });
	const auth = {
		token: "mock:user:u_connect:ada@example.com",
		profile: { uid: "u_connect", email: "ada@example.com", demo: false },
	};
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const screen = createElement(Connect, { code, theme: "light", onToggleTheme() {} });
	await act(async () => root.render(createElement(AppProvider, { client, children: screen })));
	const press = async (label: string) => {
		const button = [...host.querySelectorAll("button")].find(one => one.textContent === label);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
		for (let i = 0; i < 4; i++) await act(async () => void (await new Promise(r => setTimeout(r, 120))));
	};
	return {
		host,
		client,
		auth,
		press,
		done() {
			act(() => root.unmount());
			host.remove();
			client.dispose();
			localStorage.clear();
		},
	};
}

it("shows the terminal's code and approves it for the signed-in account", async () => {
	const page = await render("kq2m-8xf4");
	try {
		expect(page.host.querySelector(".connect-code")?.textContent).toBe("KQ2M-8XF4");
		expect(page.host.textContent).toContain("ada@example.com");
		await page.press("Approve");
		expect(page.host.querySelector("[role=status]")?.textContent).toMatch(/Approved\. Go back to your terminal/);
		expect(page.host.querySelector(".connect-card button")).toBeNull();
	} finally {
		page.done();
	}
});

it("denies a code, and explains a link without one", async () => {
	const denied = await render("KQ2M-8XF4");
	try {
		await denied.press("Deny");
		expect(denied.host.textContent).toContain("Nothing was connected");
		expect((await denied.client.user(denied.auth).modelPlans()).plans).toEqual([]);
	} finally {
		denied.done();
	}
	const missing = await render(undefined);
	try {
		expect(missing.host.textContent).toContain("npx @windlassai/cli connect claude");
		expect(missing.host.querySelector(".connect-card button")).toBeNull();
	} finally {
		missing.done();
	}
});

it("keeps the connect page and its code across sign-in, once", () => {
	expect(parseRoute("/connect", "?code=KQ2M-8XF4")).toEqual({ name: "connect", code: "KQ2M-8XF4" });
	expect(href({ name: "connect", code: "KQ2M-8XF4" })).toBe("/connect?code=KQ2M-8XF4");
	history.replaceState(null, "", "/connect?code=KQ2M-8XF4");
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toEqual({ name: "connect", code: "KQ2M-8XF4" });
	expect(takeReturnAfterSignIn()).toBeNull();
	// Only the connect page is taken back to.
	history.replaceState(null, "", "/settings");
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toBeNull();
});
