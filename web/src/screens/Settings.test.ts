// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

it("saves a machine agent and profile and hides machine choices for Hosted", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:chatgpt:u_places:ada@example.com", profile: { uid: "u_places", email: "ada@example.com", demo: false } };
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => void await new Promise(r => setTimeout(r, 2))); };
	const field = (name: string) => [...host.querySelectorAll<HTMLSelectElement>("fieldset select")].find(el => el.labels?.[0]?.textContent === name);
	const select = async (name: string, value: string) => {
		await act(async () => { const el = field(name)!; el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
		await settle();
	};
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		await settle();
		expect(field("Agent")).toBeUndefined();
		await select("Place", "m_nas");
		await select("Agent", "claude");
		await select("Machine profile", "docker-hardened");
		await select("If unavailable", "hosted");
		expect((await client.user(auth).account()).defaults).toMatchObject({ place: { machine: "m_nas" }, harness: "claude", machineProfile: "docker-hardened", placeFallback: "hosted" });
		await select("Place", "hosted");
		expect(field("Machine profile")).toBeUndefined();
		expect((await client.user(auth).account()).defaults.place).toBe("hosted");
	} finally {
		act(() => root.unmount()); host.remove(); client.dispose(); localStorage.clear();
	}
});

describe("Linear in Settings", () => {
	async function open(client: ReturnType<typeof createMockClient>, hash = "") {
		const { url, redirectPrefix } = await client.login.start();
		const auth = await client.login.finish(redirectPrefix + "?code=linear&state=" + new URL(url).searchParams.get("state"));
		saveAuth("mock", auth);
		history.replaceState(null, "", "/settings" + hash);
		const host = document.body.appendChild(document.createElement("div"));
		const root = createRoot(host);
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5)))); };
		await settle();
		return { host, root, auth, settle, close: () => { act(() => root.unmount()); host.remove(); } };
	}
	const section = (host: HTMLElement) => host.querySelector("[data-testid='linear-settings']") as HTMLElement;
	const choose = async (select: HTMLSelectElement, value: string) => {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
	};
	const press = async (scope: ParentNode, label: string) => {
		const button = Array.from(scope.querySelectorAll("button")).find((one) => one.textContent === label || one.getAttribute("aria-label") === label);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
	};

	afterEach(() => { localStorage.clear(); history.replaceState(null, "", "/"); });

	it("offers Connect, then shows unmapped teams, a saved mapping, and keeps it on reload", async () => {
		const client = createMockClient({ pace: 0 });
		const first = await open(client);
		expect(section(first.host).textContent).toContain("writes nothing back to Linear");
		expect(section(first.host).textContent).toContain("Connect Linear…");
		// Connecting: the mock sends the browser back with #linear=connected.
		const assign = vi.fn();
		vi.stubGlobal("location", { assign, origin: "http://localhost", pathname: "/settings", search: "", hash: "" });
		await press(section(first.host), "Connect Linear…");
		await first.settle();
		vi.unstubAllGlobals();
		expect(assign).toHaveBeenCalledWith("http://localhost/settings#linear=connected");
		first.close();

		const second = await open(client, "#linear=connected");
		expect(section(second.host).textContent).toContain("Linear is connected.");
		expect(section(second.host).querySelector("[data-testid='linear-workspace']")?.textContent).toContain("Connected to Acme as Ada Lovelace");
		expect(section(second.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("not mapped");
		const [team, repository] = Array.from(section(second.host).querySelectorAll("select"));
		const save = Array.from(section(second.host).querySelectorAll("button")).find((one) => one.textContent === "Map team") as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		await choose(team as HTMLSelectElement, "team-eng");
		await choose(repository as HTMLSelectElement, "7101");
		await press(section(second.host), "Map team");
		await second.settle();
		expect(section(second.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("→ acme/harbor");
		expect(section(second.host).querySelector("[data-testid='linear-team-DES']")?.textContent).toContain("not mapped");
		second.close();

		// A reload: a new client, the same account.
		const third = await open(createMockClient({ pace: 0 }));
		expect(section(third.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("→ acme/harbor");
		await press(section(third.host), "Remove the mapping of Engineering");
		await third.settle();
		expect(section(third.host).querySelector("[data-testid='linear-team-ENG']")?.textContent).toContain("not mapped");
		third.close();
	}, 15_000);

	it("says what went wrong on a failed return from Linear, and shows nothing where the deployment has no Linear", async () => {
		const failed = await open(createMockClient({ pace: 0 }), "#linear-error=access_denied");
		expect(section(failed.host).querySelector("[role='alert']")?.textContent).toContain("Linear was not given access");
		expect(location.hash).toBe("");
		failed.close();
		const off = await open(createMockClient({ pace: 0, linear: false }));
		expect(section(off.host)).toBeNull();
		off.close();
	}, 15_000);
});
