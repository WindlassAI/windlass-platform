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

it.each([true, false])("keeps the session on cancel and signs out with revoke API tokens set to %s", async (revokeApiTokens) => {
	const client = createMockClient({ pace: 0 });
	const login = async () => {
		const { url, redirectPrefix } = await client.login.start();
		return client.login.finish(redirectPrefix + "?code=settings&state=" + new URL(url).searchParams.get("state"));
	};
	const auth = await login();
	const before = await client.user(auth).apiTokens();
	expect(before.length).toBeGreaterThan(0);
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
		const checkbox = () => document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
		expect(checkbox()?.labels?.[0]?.textContent).toContain("Also revoke all API tokens");
		expect(checkbox().checked).toBe(true);
		expect(document.querySelector("dialog")?.textContent).toMatch(/paired machines keep working/i);
		expect(document.querySelector('dialog a[href="/machines"]')?.textContent).toBe("Machines");
		await act(async () => checkbox().click());
		await click("Cancel", document);
		expect(await client.user(auth).apiTokens()).toEqual(before);
		expect(loadAuth("mock")).toEqual(auth);
		await click("Sign out everywhere");
		expect(checkbox().checked).toBe(true);
		if (!revokeApiTokens) await act(async () => checkbox().click());
		await click("Sign out everywhere", document.querySelector("dialog")!);
		expect(loadAuth("mock")).toBeNull();
		expect(host.textContent).toBe("Signed out");
		await expect(client.user(auth).me()).rejects.toMatchObject({ code: "unauthorized" });
		expect(await client.user(await login()).apiTokens()).toEqual(revokeApiTokens ? [] : before);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
}, 15_000);

it("says where the last agent started, with its agent and mode, and forgets it", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:chatgpt:u_last:ada@example.com", profile: { uid: "u_last", email: "ada@example.com", demo: false } };
	await client.user(auth).createSession({ place: { kind: "machine", machineId: "m_nas" }, harness: "claude", profile: "docker-hardened", mode: "plan" });
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => {
		for (let step = 0; step < 12; step++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2))));
	};
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		await settle();
		const line = () => host.querySelector('[data-testid="last-start"]')?.textContent ?? "";
		expect(line()).toContain("Claude Code");
		expect(line()).toContain("Plan");
		expect(line()).toMatch(/nas/i);
		const forget = Array.from(host.querySelectorAll("button")).find((one) => one.textContent === "Forget");
		await act(async () => forget!.click());
		await settle();
		expect(line()).toBe("Nothing remembered yet");
		expect((await client.user(auth).account()).lastStart).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
}, 15_000);
