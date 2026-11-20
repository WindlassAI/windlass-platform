// @vitest-environment jsdom
/**
 * The mock's Claude Code agent on "nas" (api/mock.ts, `nas-claude`): its page draws the turn in the
 * platform's own blocks and leaves out what Claude Code does not do. The composer offers only the
 * pickers the harness gave a choice for, and a call has no stop button of its own.
 */
import type { AuthResult, ModelList } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { Composer } from "../components/Composer";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";
import { Session, SessionCrumb } from "./Session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
let auth: AuthResult;

async function wait(steps = 6): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
}

/** Waits until `ready` holds, a step of the mock's time at once, for at most `steps` steps. */
async function until(ready: () => boolean, steps = 60): Promise<void> {
	for (let step = 0; step < steps && !ready(); step++) await wait(1);
	expect(ready()).toBe(true);
}

function Page({ id }: { id: string }) {
	return createElement(Session, { sessionId: id, state: useSession(id) });
}

async function open(id: string): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173" });
	const begun = client.login.start();
	await vi.advanceTimersByTimeAsync(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	await vi.advanceTimersByTimeAsync(1000);
	auth = await finished;
	saveAuth("mock", auth);
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Page, { id }) })));
	await wait();
}

beforeEach(() => {
	vi.useFakeTimers();
	// jsdom lays nothing out, and scrolls nothing.
	Element.prototype.scrollTo ??= function scrollTo() {};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client?.dispose();
	saveAuth("mock", null);
	vi.useRealTimers();
});

const pickers = () => [...host.querySelectorAll(".composer-selects .mini-select > span")].map((label) => label.textContent);
const text = () => host.textContent ?? "";

describe("a Claude Code agent's page", () => {
	it("shows its turn in the platform's blocks: the plan, the calls with the edit's diff, the context instead of tokens", async () => {
		await open("nas-claude");
		const turn = host.querySelector(".turn") as HTMLElement;
		expect(turn.querySelector(".block-plan")).not.toBeNull();
		expect([...turn.querySelectorAll(".tool-name")].map((name) => name.textContent)).toEqual(["read", "edit", "shell"]);
		expect([...turn.querySelectorAll(".tool-target")].map((target) => target.textContent)).toEqual(["README.md", "README.md", "npm test"]);
		// The edit's diff, counted as Windlass's edits are.
		expect(turn.querySelectorAll(".tool")[1]?.querySelector(".tool-facts")?.textContent).toContain("+4 -0");
		expect(turn.querySelector(".turn-end")?.textContent).toContain("context 41% used");
		expect(turn.querySelector(".turn-end")?.textContent).toContain("$0.38 so far");
		expect(turn.querySelector(".turn-end")?.textContent).not.toContain("no token counts were reported");
		// The side panel: the context and the cost; no token table, no cache chart.
		expect(host.querySelector("#panel-context")?.closest("section")?.textContent).toContain("41% used");
		expect(host.querySelector("#panel-tokens")).toBeNull();
		expect(host.querySelector("#panel-cache")).toBeNull();
	});

	it("has no effort picker, since Claude Code offered no thought_level, and the model picker its models", async () => {
		await open("nas-claude");
		expect(pickers()).toEqual(["model"]);
		expect([...host.querySelectorAll(".composer-selects option")].map((option) => option.textContent)).toEqual(["default", "opus", "haiku"]);
	});

	it("draws no stop button on a running call, and puts Claude Code's question under the call it is about, without a note", async () => {
		await open("nas-claude");
		await act(async () => void client.session(auth, "nas-claude").prompt({ text: "Read the README again and run the tests." }));
		const second = () => host.querySelectorAll(".turn")[1] as HTMLElement | undefined;
		await until(() => second()?.querySelector(".tool-running") != null);
		expect(second()?.querySelector(".tool-stop")).toBeNull();
		expect(second()?.querySelector(".tool-stoppable")).toBeNull();
		await until(() => second()?.querySelector(".tool .q-inline, .tool .q") != null);
		const asked = second()?.querySelector(".tool .q") as HTMLElement;
		expect(asked.closest(".tool")?.querySelector(".tool-name")?.textContent).toBe("shell");
		expect([...asked.querySelectorAll(".q-choice")].map((choice) => choice.textContent)).toEqual(expect.arrayContaining(["Yes", "No"]));
		expect(asked.textContent).not.toContain("add a note");
		await act(async () => (asked.querySelector(".q-choice") as HTMLButtonElement).click());
		await until(() => second()?.querySelector(".turn-end") != null);
		expect(second()?.querySelector(".tool-stop")).toBeNull();
	});
});

describe("the composer of a Claude Code agent", () => {
	const list = (efforts: string[]): ModelList => ({ source: "harness", defaultModel: "default", fetchedAt: null, models: [{ id: "default", name: null, efforts }] });
	const show = (models: ModelList, harness: string | null) => act(() => root.render(createElement(Composer, { status: "idle", online: true, models, model: "default", harness, onSend: async () => undefined, onStop: async () => undefined })));

	it("draws the effort picker only when the harness offered a thought_level, and the model picker only with a choice", () => {
		show(list([]), "Claude Code");
		expect(pickers()).toEqual([]);
		expect(text()).toContain("Claude Code's default model");
		show(list(["low", "medium", "high"]), "Claude Code");
		expect(pickers()).toEqual(["effort"]);
		// Windlass's composer is as it was: both pickers, whatever the list.
		show(list([]), null);
		expect(pickers()).toEqual(["model", "effort"]);
	});

	it("labels the agent with its harness beside the machine's name", () => {
		act(() => root.render(createElement(SessionCrumb, { title: "Add the test command", status: "idle", place: { kind: "machine", machineId: "m_nas" }, machine: null, harness: "claude" })));
		expect(host.querySelector(".crumb-place")?.textContent).toBe("Claude Code on your machine");
		act(() => root.render(createElement(SessionCrumb, { title: "Add the test command", status: "idle", place: { kind: "machine", machineId: "m_nas" }, machine: { name: "nas" } as never, harness: "claude" })));
		expect(host.querySelector(".crumb-place")?.textContent).toBe("Claude Code on “nas”");
		act(() => root.render(createElement(SessionCrumb, { title: "Run the tests", status: "idle", place: { kind: "machine", machineId: "m_nas" }, machine: { name: "nas" } as never })));
		expect(host.querySelector(".crumb-place")?.textContent).toBe("On nas");
	});
});
