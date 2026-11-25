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

const ada: AuthResult = { token: "mock:user:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } };

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

it.each(["/machines", "/settings"])("shows the Settings key upgrade on %s for runner 0.3.8", async path => {
	history.replaceState(null, "", path);
	client = createMockClient({ pace:0, machine:"online" });
	const user = client.user.bind(client);
	const [machine] = await user(ada).machines();
	vi.spyOn(client, "user").mockImplementation(auth => ({ ...user(auth), machines:async () => [
		{ ...machine!, runnerVersion:"0.3.8", harnesses:machine!.harnesses?.map(({keyRelay: _, ...h}) => h) },
	] }));
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root.render(createElement(AppProvider, { client, children:createElement(App) })));
	await settle();
	expect(host.textContent).toContain("Update the machine software to use your API keys here");
});

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

	it("shows the one-line install first, and the Docker commands under Other ways", async () => {
		history.replaceState(null, "", "/machines");
		client = createMockClient({ pace: 0, origin: "http://localhost:5173" });
		saveAuth("mock", ada);
		root = createRoot(host);
		act(() => root.render(createElement(AppProvider, { client, children: createElement(App) })));
		await settle();
		act(() => button("Add a machine")?.click());
		const commands = [...document.body.querySelectorAll<HTMLElement>(".machine-dialog .machine-command pre")];
		expect(commands[0]?.textContent).toBe("curl -fsSL http://localhost:5173/install.sh | sh");
		const other = document.body.querySelector<HTMLDetailsElement>("details.machine-other-ways");
		expect(other?.open).toBe(false);
		expect(other?.querySelector("summary")?.textContent).toBe("Other ways");
		expect(commands.slice(1).map((pre) => pre.closest("details") === other)).toEqual([true, true]);
		expect(commands[1]?.textContent).toContain(" setup --platform http://localhost:5173");
		expect(commands[2]?.textContent).toContain("docker run -d --name windlass-runner");
	});

	it("is refused by the mock, as by the platform, without the person's word", async () => {
		client = createMockClient({ pace: 0 });
		const user = client.user(ada);
		await user.claimMachine({ code: "WXYZ-1211" });
		await expect(user.confirmMachine({ code: "WXYZ-1211" } as { code: string; keyConfirmed: true })).rejects.toMatchObject({ reason: "key_not_confirmed" });
		root = createRoot(host);
	});
});

it("chooses whose credential an agent uses where the machine's sign-in and a Settings key both could", async () => {
	history.replaceState(null, "", "/machines");
	client = createMockClient({ pace: 0, machine: "sources", keys: true });
	saveAuth("mock", ada);
	root = createRoot(host);
	act(() => root.render(createElement(AppProvider, { client, children: createElement(App) })));
	await settle();
	const choice = host.querySelector('[role="radiogroup"][aria-labelledby]:has(label[data-source="key"])') as HTMLElement;
	expect(choice.textContent).toContain("Use this Mac's Claude subscription");
	expect(choice.querySelector<HTMLInputElement>('label[data-source="machine"] input')?.checked).toBe(true);
	await act(async () => choice.querySelector<HTMLInputElement>('label[data-source="key"] input')!.click());
	await settle();
	const [mac] = await client.user(ada).machines();
	expect(mac!.harnesses?.find((h) => h.id === "claude")).toMatchObject({ source: "key", platformKeys: ["anthropic"], method: "api-key" });
	expect(choice.querySelector<HTMLInputElement>('label[data-source="key"] input')?.checked).toBe(true);
	const codex = [...host.querySelectorAll<HTMLElement>(".machine-agent")].find(row => row.textContent?.includes("this Mac's ChatGPT plan"))!;
	await act(async () => codex.querySelector<HTMLInputElement>('label[data-source="key"] input')!.click());
	await settle();
	expect(codex.textContent).toContain("Use this Mac's ChatGPT plan");
});
