// @vitest-environment jsdom
import type { PlanProvider } from "@contract";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { href, parseRoute, returnAfterSignIn, takeReturnAfterSignIn } from "../lib/router";
import { AppProvider } from "../state/app";
import { Connect } from "./Connect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(code: string | undefined, plan: PlanProvider | undefined) {
	const client = createMockClient({ pace: 0 });
	const auth = {
		token: "mock:user:u_connect:ada@example.com",
		profile: { uid: "u_connect", email: "ada@example.com", demo: false },
	};
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const screen = createElement(Connect, { code, plan, theme: "light", onToggleTheme() {} });
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
	const page = await render("kq2m-8xf4", "anthropic");
	try {
		expect(page.host.querySelector(".connect-code")?.textContent).toBe("KQ2M-8XF4");
		expect(page.host.textContent).toContain("ada@example.com");
		expect(page.host.querySelector("h1")?.textContent).toBe("Connect your Claude plan from a terminal?");
		await page.press("Approve");
		expect(page.host.querySelector("[role=status]")?.textContent).toMatch(/Approved\. Go back to your terminal/);
		expect(page.host.textContent).toContain("claude setup-token");
		expect(page.host.querySelector(".connect-card button")).toBeNull();
	} finally {
		page.done();
	}
});

it("names the ChatGPT plan and approves its code for it", async () => {
	const page = await render("KQ2M-8XF4", "openai");
	try {
		expect(page.host.querySelector("h1")?.textContent).toBe("Connect your ChatGPT plan from a terminal?");
		await page.press("Approve");
		expect(page.host.querySelector("[role=status]")?.textContent).toContain("signs in with ChatGPT through Windlass");
		await act(async () => void (await new Promise(r => setTimeout(r, 3_200))));
		expect(await page.client.user(page.auth).chatgpt()).toMatchObject({ connected: true });
	} finally {
		page.done();
	}
});

it("denies a code, and explains a link without one", async () => {
	const denied = await render("KQ2M-8XF4", "anthropic");
	try {
		await denied.press("Deny");
		expect(denied.host.textContent).toContain("Nothing was connected");
		expect((await denied.client.user(denied.auth).modelPlans()).plans).toEqual([]);
	} finally {
		denied.done();
	}
	for (const [code, plan] of [
		[undefined, "anthropic"],
		["KQ2M-8XF4", undefined],
	] as const) {
		const missing = await render(code, plan);
		try {
			expect(missing.host.textContent).toContain("npx @windlassai/cli connect claude");
			expect(missing.host.textContent).toContain("npx @windlassai/cli connect codex");
			expect(missing.host.querySelector(".connect-card button")).toBeNull();
		} finally {
			missing.done();
		}
	}
});

it("keeps the connect page, its code and its plan across sign-in, once", () => {
	const route = { name: "connect", code: "KQ2M-8XF4", plan: "openai" } as const;
	expect(parseRoute("/connect", "?code=KQ2M-8XF4&plan=openai")).toEqual(route);
	expect(parseRoute("/connect", "?code=KQ2M-8XF4&plan=gemini")).toEqual({ name: "connect", code: "KQ2M-8XF4" });
	expect(href(route)).toBe("/connect?code=KQ2M-8XF4&plan=openai");
	history.replaceState(null, "", "/connect?code=KQ2M-8XF4&plan=openai");
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toEqual(route);
	expect(takeReturnAfterSignIn()).toBeNull();
	// Only the connect page is taken back to.
	history.replaceState(null, "", "/settings");
	returnAfterSignIn();
	expect(takeReturnAfterSignIn()).toBeNull();
});
