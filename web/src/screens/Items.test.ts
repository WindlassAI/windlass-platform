// @vitest-environment jsdom
/**
 * The form that files a work item: "Where it runs" is offered where the deployment has work items and
 * machines and the user has one, and the place chosen is what the request carries (`CreateItemInput.place`).
 */
import type { AuthResult, CreateItemInput } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient, type MockMachineState } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { NewItemDialog } from "./Items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
/** What the form asked the server to file, in order. */
let sent: CreateItemInput[];

/** Lets the mock answer: in steps, so that what one answer renders can ask the next. */
async function wait(steps = 6): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
}

/** Signs in to a mock whose machines stand as `machine` says, and keeps what `createItem` is asked. */
async function start(machine: MockMachineState): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173", machine });
	const begun = client.login.start();
	await vi.advanceTimersByTimeAsync(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	await vi.advanceTimersByTimeAsync(1000);
	const auth: AuthResult = await finished;
	saveAuth("mock", auth);
	const user = client.user.bind(client);
	(client as { user: (auth: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		return { ...api, createItem: (input: CreateItemInput) => (sent.push(input), api.createItem(input)) };
	};
	act(() => root.render(createElement(AppProvider, { client, children: createElement(NewItemDialog, { repositoryId: 7101, name: "acme/harbor", base: "main", onClose: () => undefined }) })));
	await wait();
}

const text = () => host.textContent ?? "";
const legend = () => [...host.querySelectorAll("legend")].find((one) => one.textContent === "Where it runs") ?? null;
const radio = (value: string) => host.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement | null;

function typeTitle(value: string): void {
	const input = host.querySelector("input.input") as HTMLInputElement;
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function file(): Promise<void> {
	await act(async () => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
	await wait();
}

beforeEach(() => {
	vi.useFakeTimers();
	// jsdom has no <dialog> of its own that opens.
	HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
		this.removeAttribute("open");
	};
	sent = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	vi.useRealTimers();
});

describe("filing a work item", () => {
	it("runs on this platform unless a machine is chosen, and then says what that means and sends the machine", async () => {
		await start("full");
		expect(legend()).not.toBeNull();
		expect(host.querySelector(".sandbox-chosen-name")?.textContent).toBe("This platform");
		// The usable machines can be chosen, an offline one too.
		expect(radio("m_nas")?.disabled).toBe(false);
		expect(radio("m_workshop")?.disabled).toBe(false);
		typeTitle("Cache the station list");
		await file();
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toHaveProperty("place");

		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		sent = [];
		await start("full");
		act(() => radio("m_nas")?.click());
		expect(host.querySelector(".sandbox-chosen-name")?.textContent).toBe("nas");
		expect(text()).toContain("It runs without asking on “nas”, inside its container, and costs no hosted time. If the machine is away, the item waits until it is back.");
		expect(text()).toContain("It starts as soon as “nas” is online and has a free slot; until then it waits, and says for what.");
		typeTitle("Cache the station list");
		await file();
		expect(sent[0]?.place).toEqual({ kind: "machine", machineId: "m_nas" });
		// The server picks the machine's sandbox: the form names none.
		expect(sent[0]?.profile).toBeUndefined();
	});

	it.each([["orchestrate", "Plan first"], ["single", "Quick"]])("files the chosen %s mode", async (mode, label) => {
		await start("none");
		expect(radio("orchestrate")?.checked).toBe(true);
		expect(radio(mode)?.parentElement?.textContent).toBe(label);
		act(() => radio(mode)!.click());
		typeTitle("Make the export available");
		await file();
		expect(sent[0]?.mode).toBe(mode);
	});

	it("files the model and effort chosen for the item's agent, offering only the efforts its model takes", async () => {
		const choose = (label: string, value: string) => {
			const select = [...host.querySelectorAll("label")].find((one) => one.textContent === label)?.control as HTMLSelectElement;
			act(() => {
				Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
		};
		const efforts = () => [...((([...host.querySelectorAll("label")].find((one) => one.textContent === "Effort")?.control as HTMLSelectElement | null)?.options) ?? [])].map((one) => one.value);
		await start("online");
		// Windlass on this platform: the account's models, and the efforts of the chosen one.
		expect(efforts()).toEqual(["", "low", "medium", "high", "xhigh"]);
		choose("Model", "gpt-6-luna");
		expect(efforts()).toEqual(["", "low", "medium"]);
		choose("Effort", "medium");
		typeTitle("Cache the station list");
		await file();
		expect(sent[0]).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
		// Claude Code on the machine: the models its runner reported, where only some take an effort.
		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		sent = [];
		await start("online");
		act(() => radio("m_nas")?.click());
		act(() => radio("claude")?.click());
		await wait();
		expect(efforts()).toEqual([]);
		expect(text()).toContain("This model takes no reasoning effort.");
		choose("Model", "opus");
		expect(efforts()).toEqual(["", "low", "high", "max"]);
		choose("Effort", "high");
		typeTitle("Cache the station list");
		await file();
		expect(sent[0]).toMatchObject({ harness: "claude", model: "opus", effort: "high", mode: "single" });
	});

	it("says an offline machine makes the item wait", async () => {
		await start("full");
		act(() => radio("m_workshop")?.click());
		expect(text()).toMatch(/“workshop” is offline since .+, so the item waits until it is back\./);
		expect(text()).toContain("through the web proxy");
		expect(text()).not.toContain("can reach the machine's network");
	});

	it("lists a machine with an old runner, or no usable sandbox, without letting it be chosen", async () => {
		await start("outdated");
		expect(radio("m_nas")?.disabled).toBe(true);
		expect(text()).toContain("Its runner is 0.1.0; the platform needs 0.2.0 or later. Update it on the machine.");
		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		await start("docker");
		expect(radio("m_nas")?.disabled).toBe(true);
		expect(text()).toContain("None of the sandboxes its runner reported can be used now.");
	});

	it("offers only the hosted place and shows which agents need a Settings key", async () => {
		await start("off");
		expect(radio("platform")?.checked).toBe(true);
		expect(radio("m_nas")).toBeNull();
		expect(radio("claude")?.disabled).toBe(true);
		expect(text()).toContain("It runs on a hosted sandbox.");
		act(() => root.unmount());
		host.replaceChildren();
		root = createRoot(host);
		client.dispose();
		await start("none");
		expect(radio("platform")?.checked).toBe(true);
		expect(radio("m_nas")).toBeNull();
		expect(radio("claude")?.disabled).toBe(true);
	});
});
