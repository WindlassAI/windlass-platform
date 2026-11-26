// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "../api/mock";
import { lastAppHref, rememberAppPage } from "../lib/router";
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

it.each([false, true])("shows linked identities and protects the last sign-in method (Google configured: %s)", async google => {
	const client = createMockClient({ pace: 0 });
	const github = await client.login.start("github");
	const auth = await client.login.finish(github.url);
	const info = await client.info();
	vi.spyOn(client, "info").mockResolvedValue({
		...info, googleLogin: google ? true : undefined,
		github: { slug: "windlass", url: google ? "https://github.example.test" : "https://github.com" },
	});
	if (google) {
		const link = await client.login.start("google", auth);
		await client.login.finish(link.url, auth);
	}
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		const rows = Array.from(host.querySelectorAll('[aria-label="Sign-in methods"] li'));
		expect(rows.map(row => row.querySelector(".provider-name")?.textContent)).toEqual(google ? ["GitHub", "Google"] : ["GitHub"]);
		const githubRow = rows[0]!;
		expect(githubRow.textContent).toContain("@ada");
		expect(githubRow.textContent).not.toContain("github.com");
		const unlink = githubRow.querySelector("button")!;
		if (google) {
			expect(githubRow.textContent).toContain("github.example.test");
			expect(rows[1]?.textContent).toContain("ada@example.com");
			await act(async () => unlink.click());
			expect(host.querySelector("dialog")?.textContent).toContain("Unlink GitHub?");
			await act(async () => host.querySelector<HTMLButtonElement>("dialog [data-autofocus]")!.click());
			expect(await client.user(auth).linkedLogins()).toHaveLength(2);
			await act(async () => unlink.click());
			await act(async () => host.querySelector<HTMLButtonElement>("dialog .button-danger")!.click());
			expect(host.querySelector("dialog")).toBeNull();
			expect(githubRow.textContent).toContain("not linked");
			expect(githubRow.textContent).not.toContain("@ada");
			expect(githubRow.querySelector("button")?.getAttribute("aria-label")).toBe("Link GitHub");
		}
		const lastAction = rows.at(-1)!.querySelector("button")!;
		expect(lastAction.disabled).toBe(true);
		expect(document.getElementById(lastAction.getAttribute("aria-describedby")!)?.textContent).toMatch(/link another sign-in method/i);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
});

it("refuses a pending GitHub sign-in and lists only Google after the GitHub App is removed", async () => {
	const configured = createMockClient({ pace: 0 });
	const pending = await configured.login.start("github");
	configured.dispose();
	const client = createMockClient({ pace: 0, github: false });
	await expect(client.login.finish(pending.url)).rejects.toMatchObject({ reason: "invalid_callback" });
	const login = await client.login.start("google");
	saveAuth("mock", await client.login.finish(login.url));
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		const names = host.querySelectorAll('[aria-label="Sign-in methods"] .provider-name');
		expect(Array.from(names, row => row.textContent)).toEqual(["Google"]);
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
});

it("says where the last agent started, with its agent and mode, and forgets it", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:user:u_last:ada@example.com", profile: { uid: "u_last", email: "ada@example.com", demo: false } };
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
		expect(line()).not.toContain("Claude Code");
		expect(host.textContent).toContain("Nothing remembered yet");
		expect((await client.user(auth).account()).lastStart).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		localStorage.clear();
	}
}, 15_000);

it("saves an interactive machine and profile underneath the last launch, then reports its removal", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:user:u_start:ada@example.com", profile: { uid: "u_start", email: "ada@example.com", demo: false } };
	const user = client.user(auth);
	await user.createSession({ profile: "docker-hardened" });
	saveAuth("mock", auth);
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => void await new Promise(r => setTimeout(r, 2))); };
	const field = (label: string) => [...host.querySelectorAll<HTMLSelectElement>(".defaults-group:first-child select")].find(s => s.labels?.[0]?.textContent === label)!;
	const choose = async (label: string, value: string) => {
		await act(async () => { const s = field(label); s.value = value; s.dispatchEvent(new Event("change", { bubbles: true })); });
		await settle();
	};
	const line = () => host.querySelector('[data-testid="last-start"]')!.textContent;
	try {
		await act(async () => root.render(createElement(AppProvider, { client, children: createElement(Settings) })));
		await settle();
		await choose("Where", "m_nas");
		await choose("Machine profile", "docker-hardened");
		expect((await user.account()).defaults.startPlace).toEqual({ kind: "machine", machineId: "m_nas", profile: "docker-hardened" });
		expect(line()).toMatch(/Hosted.*last launch/);
		await act(async () => host.querySelector<HTMLButtonElement>(".defaults-start-forget")!.click());
		await settle();
		expect(line()).toMatch(/nas.*account default/);
		await act(async () => { await user.removeMachine({ machineId: "m_nas", removeSandboxes: false }); });
		await settle();
		expect(line()).toMatch(/Hosted.*deployment default/);
		expect(host.querySelector(".defaults-start")?.textContent).toContain("no longer paired");
		await choose("Where", "");
		expect((await user.account()).defaults.startPlace).toBeUndefined();
	} finally {
		act(() => root.unmount()); host.remove(); client.dispose(); localStorage.clear();
	}
});

it("saves a machine agent and profile and hides machine choices for Hosted", async () => {
	const client = createMockClient({ pace: 0 });
	const auth = { token: "mock:user:u_places:ada@example.com", profile: { uid: "u_places", email: "ada@example.com", demo: false } };
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
		await select("Where", "m_nas");
		await select("Agent", "claude");
		await select("Machine profile", "docker-hardened");
		await select("If unavailable", "hosted");
		expect((await client.user(auth).account()).defaults).toMatchObject({ place: { machine: "m_nas" }, harness: "claude", machineProfile: "docker-hardened", placeFallback: "hosted" });
		await select("Where", "hosted");
		expect(field("Machine profile")).toBeUndefined();
		expect((await client.user(auth).account()).defaults.place).toBe("hosted");
	} finally {
		act(() => root.unmount()); host.remove(); client.dispose(); localStorage.clear();
	}
});

describe("Integrations in Settings", () => {
	async function open(client: ReturnType<typeof createMockClient>, hash = "", strict = false) {
		const { url, redirectPrefix } = await client.login.start();
		const auth = await client.login.finish(redirectPrefix + "?code=linear&state=" + new URL(url).searchParams.get("state"));
		saveAuth("mock", auth);
		history.replaceState(null, "", "/settings" + hash);
		const host = document.body.appendChild(document.createElement("div"));
		const root = createRoot(host);
		const settings = createElement(AppProvider, { client, children: createElement(Settings) });
		await act(async () => root.render(strict ? createElement(StrictMode, null, settings) : settings));
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
		expect(section(first.host).textContent).not.toContain("windlass-quick");
		expect(section(first.host).textContent).toContain("Connect Linear…");
		// Begin leaves the account disconnected until Settings redeems the ticket.
		const assign = vi.fn();
		vi.stubGlobal("location", { assign, origin: "http://localhost", pathname: "/settings", search: "?mock=1", hash: "" });
		await press(section(first.host), "Connect Linear…");
		await first.settle();
		vi.unstubAllGlobals();
		const landing = new URL(assign.mock.calls[0]![0]);
		expect(landing.origin + landing.pathname).toBe("http://localhost/settings");
		expect(landing.search).toBe("?mock=1");
		expect(landing.hash).toMatch(/^#linear=.+$/);
		expect(await client.user(first.auth).linear()).toEqual({ state: "disconnected" });
		first.close();

		const second = await open(createMockClient({ pace: 0 }), landing.hash);
		expect(location.hash).toBe("");
		expect(section(second.host).textContent).toContain("Linear is connected.");
		expect(section(second.host).querySelector("details:not([open])")?.textContent).toContain("windlass-quick");
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
		const confirmed = window.confirm;
		window.confirm = () => true;
		await press(section(third.host), "Disconnect…");
		window.confirm = confirmed;
		await third.settle();
		expect(section(third.host).textContent).toContain("Connect Linear…");
		third.close();
	}, 15_000);

	it("says what went wrong on a failed return from Linear, and shows nothing where the deployment has no Linear", async () => {
		const failed = await open(createMockClient({ pace: 0 }), "#linear-error=access_denied");
		expect(section(failed.host).querySelector("[role='alert']")?.textContent).toContain("Linear was not given access");
		expect(location.hash).toBe("");
		failed.close();
		const invalid = await open(createMockClient({ pace: 0 }), "#linear=invalid");
		expect(location.hash).toBe("");
		expect(section(invalid.host).querySelector("[role='alert']")?.textContent).toContain("Connect Linear again");
		expect(section(invalid.host).textContent).toContain("Connect Linear…");
		invalid.close();
		const off = await open(createMockClient({ pace: 0, linear: false }));
		expect(section(off.host)).toBeNull();
		off.close();
	}, 15_000);

	const slack = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-testid='slack-settings']")!;

	it("completes a Slack install, changes a channel’s repository, refuses read-only access, and removes the mapping", async () => {
		const client = createMockClient({ pace: 0 });
		const first = await open(client);
		expect(slack(first.host).textContent).toContain("Connect Slack…");
		const landing = await client.user(first.auth).slackConnect({ origin: location.origin });
		first.close();
		const screen = await open(client, new URL(landing.url).hash, true);
		try {
			const card = slack(screen.host);
			expect(location.hash).toBe("");
			expect(card.textContent).toContain("Acme Engineering");
			expect(card.textContent).toContain("Not linked");
			expect(card.querySelector('option[value="7105"]')).toBeNull(); // read-only
			const channel = card.querySelector<HTMLSelectElement>('[aria-label="Slack channel"]')!;
			expect(Array.from(channel.options, o => o.text)).toEqual(["Choose a channel", "#harbor-engineering", "#docs-triage"]);
			expect(card.textContent).not.toContain("C08HARB01");
			await choose(channel, "C08HARB01");
			await choose(card.querySelector('[aria-label="Repository"]')!, "7101");
			await press(card, "Map channel");
			await screen.settle();
			expect(card.querySelector('[aria-label="Mapped channels"]')?.textContent).toContain("acme/harbor");
			await press(card, "Change mapping for harbor-engineering");
			await choose(card.querySelector('[aria-label="Repository"]')!, "7102");
			await press(card, "Map channel");
			await screen.settle();
			await expect(client.user(screen.auth).saveSlackMapping({ channelId: "C08HARB01", repositoryId: 7105 })).rejects.toThrow("write access");
			expect(card.querySelectorAll('[aria-label="Mapped channels"] li')).toHaveLength(1);
			expect(card.querySelector('[aria-label="Mapped channels"]')?.textContent).toContain("ada/tide-tables");
			await press(card, "Remove mapping for harbor-engineering");
			await screen.settle();
			expect(card.querySelector('[aria-label="Mapped channels"] li')).toBeNull();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
			try { await press(card, "Disconnect…"); } finally { confirm.mockRestore(); }
			await screen.settle();
			expect(card.textContent).toContain("No workspace connected");
		} finally { screen.close(); client.dispose(); }
	});

	it("scrubs private Slack links and lets a member confirm and unlink without installing a workspace", async () => {
		const client = createMockClient({ pace: 0 });
		const fragment = "#slack-link=" + client.mockSlackLinkTicket();
		history.replaceState(null, "", "/settings?mock=1" + fragment);
		rememberAppPage();
		expect(lastAppHref()).toBe("/settings?mock=1");
		const scroll = vi.fn();
		const previousScroll = HTMLElement.prototype.scrollIntoView;
		HTMLElement.prototype.scrollIntoView = scroll;
		const screen = await open(client, fragment, true);
		try {
			const card = slack(screen.host);
			expect(location.hash).toBe("");
			expect(card.textContent).toContain("Not linked");
			expect(card.innerHTML).not.toContain(fragment.split("=")[1]!);
			expect(scroll.mock.contexts).toEqual([card]);
			expect(document.activeElement?.textContent).toBe("Link Slack identity");
			await press(card, "Link Slack identity");
			await screen.settle();
			expect(card.textContent).toContain("Acme Engineering");
			expect(card.textContent).not.toContain("T08ACME01");
			expect(card.textContent).toContain("No workspace connected");
			await press(card, "Unlink Slack identity in Acme Engineering");
			await screen.settle();
			expect(card.textContent).toContain("Not linked");
		} finally { HTMLElement.prototype.scrollIntoView = previousScroll; screen.close(); client.dispose(); }
	});

	it("explains Slack callback failure without echoing tickets and hides Slack when off", async () => {
		for (const [hash, message] of [["#slack-error=denied", "Slack was not given access"], ["#slack=invalid-ticket", "Connect Slack again"]] as const) {
			const client = createMockClient({ pace: 0 });
			const screen = await open(client, hash);
			try {
				expect(location.hash).toBe("");
				expect(slack(screen.host).querySelector('[role="alert"]')?.textContent).toContain(message);
				expect(screen.host.innerHTML).not.toContain("invalid-ticket");
			} finally { screen.close(); client.dispose(); }
		}
		for (const options of [{ slack: false }, { items: "off" }] as const) {
			const client = createMockClient({ pace: 0, ...options });
			const screen = await open(client, "?mock=1#slack-link=private-proof");
			try {
				expect(location.hash).toBe("");
				expect(location.search).toBe("?mock=1");
				expect(slack(screen.host)).toBeNull();
			} finally { screen.close(); client.dispose(); }
		}
	});
});
