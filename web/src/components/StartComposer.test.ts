// @vitest-environment jsdom
/**
 * The start composer against the mock: what pressing Enter sends, what each picker changes, what it
 * starts on, and what it keeps across the visit to GitHub.
 */
import type { AuthResult, CreateSessionInput, GithubId, MachineSummary, PromptInput } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionApi, UserApi } from "../api/client";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { NewAgent } from "../screens/NewAgent";
import { AppProvider } from "../state/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ada: AuthResult = { token: "mock:chatgpt:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } };
const demo: AuthResult = { token: "mock:demo:demo_1:", profile: { uid: "demo_1", email: null, demo: true } };

let host: HTMLElement;
let root: Root | null;
let client: MockClient;
/** What was sent: each agent created, and each prompt, in order. */
let created: CreateSessionInput[];
let prompted: PromptInput[];

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = null;
	created = [];
	prompted = [];
	history.replaceState(null, "", "/new");
	sessionStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
});

/** Lets the mock answer, in steps: what one answer renders can ask the next. */
async function settle(steps = 12): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2))));
}

/**
 * A mock whose user calls are recorded; `machines` changes the machines the user is told of. With
 * `machines`, the mock also launches Claude Code on a model those machines report, as the server does
 * once runners report their models: it leaves the model out of what it hands on.
 */
function mock(machines?: (list: MachineSummary[]) => MachineSummary[]): MockClient {
	const made = createMockClient({ pace: 0, origin: "http://localhost:5173" });
	const user = made.user.bind(made);
	const session = made.session.bind(made);
	(made as { user: (auth: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		return {
			...api,
			createSession: (input: CreateSessionInput) => (created.push(input), api.createSession(machines && input.harness === "claude" ? { ...input, model: undefined } : input)),
			...(machines
				? {
						machines: async () => machines(await api.machines()),
						watch: (events: Parameters<UserApi["watch"]>[0]) => api.watch({ ...events, onMachines: events.onMachines ? (list: MachineSummary[]) => events.onMachines?.(machines(list)) : undefined }),
					}
				: {}),
		};
	};
	(made as { session: (auth: AuthResult, id: string) => SessionApi }).session = (who, id) => {
		const api = session(who, id);
		return { ...api, prompt: (input: PromptInput) => (prompted.push(input), api.prompt(input)) };
	};
	return made;
}

/** Signs in and shows the new agent's page, as `/new` or a repository's `/new` does. */
async function show(options: { who?: AuthResult; repositoryId?: number; machines?: (list: MachineSummary[]) => MachineSummary[]; before?(client: MockClient): Promise<void> } = {}): Promise<void> {
	client = mock(options.machines);
	saveAuth("mock", options.who ?? ada);
	await options.before?.(client);
	root ??= createRoot(host);
	act(() => root?.render(createElement(AppProvider, { client, children: createElement(NewAgent, { repositoryId: options.repositoryId as GithubId | undefined }) })));
	await settle();
}

const field = () => host.querySelector(".start textarea") as HTMLTextAreaElement;

/** Types into a field as a browser does, so that React sees the change. */
function write(text: string, into: HTMLTextAreaElement | HTMLInputElement = field()): void {
	act(() => {
		const prototype = into instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(into, text);
		into.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Enter in the task's field. */
async function enter(): Promise<void> {
	await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	await settle();
}

/**
 * The pill of a picker, by the name the chip it replaced had: where it runs and its sandbox are one
 * pill now ("on" and "sandbox"), and its value is what the pill shows.
 */
const PICKERS: Record<string, string> = { repo: "repo", on: "where", sandbox: "where", agent: "agent", mode: "mode", criteria: "criteria", setup: "setup" };
const pill = (label: string) => host.querySelector(`[data-picker="${PICKERS[label] ?? label}"]`) as HTMLButtonElement | null;
const value = (label: string) => (label === "sandbox" ? pill(label)?.dataset.sandbox : pill(label)?.dataset.value) ?? null;
/** Opens the pill's picker. */
const open = (label: string) => act(() => (pill(label) as HTMLButtonElement).click());
/** The open picker: a menu or a small form, drawn at the end of the page. */
const pop = () => document.querySelector(".ui-pop") as HTMLElement;
/** Chooses the row of this value in the open menu. */
const pick = (value: string) => act(() => (pop().querySelector(`[data-value="${value}"]`) as HTMLElement).click());
/** Opens a row's submenu as the keyboard does (→ on the highlighted row), and chooses in it. */
function pickIn(row: string, value: string): void {
	act(() => void pop().querySelector(`[data-value="${row}"]`)?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
	act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
	act(() => (document.querySelector(`.ui-pop-sub [data-value="${value}"]`) as HTMLElement).click());
}
/** Chooses a mode in the mode's menu, by its name. */
function mode(name: string): void {
	open("mode");
	const option = [...pop().querySelectorAll('[role="menuitemradio"]')].find((candidate) => candidate.querySelector(".ui-item-label")?.textContent === name) as HTMLElement;
	act(() => option.click());
}
/** A button in the open picker, by its words. */
const press = (words: string) => act(() => ([...pop().querySelectorAll("button")].find((button) => button.textContent === words) as HTMLButtonElement).click());
/** Chooses in the launch button's menu, by its words. */
async function launchMenu(words: string): Promise<void> {
	act(() => (host.querySelector(".ui-split-more") as HTMLButtonElement).click());
	await act(async () => ([...pop().querySelectorAll('[role="menuitem"]')].find((row) => row.querySelector(".ui-item-label")?.textContent === words) as HTMLElement).click());
}

describe("the start composer", () => {
	it("starts an agent with the defaults when a task is typed and Enter pressed, and opens it", async () => {
		await show();
		// The newest agent was launched on acme/harbor, whose saved defaults are the hardened container and the second model.
		expect(value("repo")).toBe("acme/harbor @ main");
		write("Run the tests and fix what fails");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ repository: { id: 7101, branch: "main" }, profile: "docker-hardened", model: "gpt-6-luna", mode: "full" });
		expect(created[0]?.place).toBeUndefined();
		expect(created[0]?.harness).toBeUndefined();
		expect(prompted).toEqual([expect.objectContaining({ text: "Run the tests and fix what fails" })]);
		expect(prompted[0]?.effort).toBeUndefined();
		expect(location.pathname).toMatch(/^\/agents\/[0-9a-f]+$/);
	});

	it("does nothing on Enter with an empty task, and creates without a prompt from the line under it", async () => {
		await show();
		await enter();
		expect(created).toHaveLength(0);
		await launchMenu("Create without a prompt");
		await settle();
		expect(created).toHaveLength(1);
		expect(created[0]?.title).toBeUndefined();
		expect(prompted).toHaveLength(0);
	});

	it("sends no title: the server names the agent from its first prompt, without the secrets saved", async () => {
		await show();
		write("\n  Add the tests command to the README  \nThen run them, and say what passed.");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]).not.toHaveProperty("title");
		expect(prompted[0]?.text).toBe("Add the tests command to the README  \nThen run them, and say what passed.");
	});
});

describe("the start composer where it offers no switch", () => {
	it("starts an agent even when a work item was being filed elsewhere before the visit to GitHub", async () => {
		sessionStorage.setItem("wlp.new-agent.draft", JSON.stringify({ prompt: "Add a health check", kind: "item", criteria: "It answers 200." }));
		await show();
		expect(field().value).toBe("Add a health check");
		expect(host.querySelector(".start-kind")).toBeNull();
		expect(pill("agent")).not.toBeNull();
		expect(pill("criteria")).toBeNull();
	});
});

describe("each picker of the start composer", () => {
	it("sends no repository, chosen in the repository's picker", async () => {
		await show();
		open("repo");
		press("No repository");
		expect(value("repo")).toBe("none");
		write("Look around");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]?.repository).toBeUndefined();
		expect(created[0]?.repoUrl).toBeUndefined();
	});

	it("sends a pasted address", async () => {
		await show();
		open("repo");
		press("Paste an address");
		write("https://example.com/acme/pier.git", pop().querySelector('input[type="url"]') as HTMLInputElement);
		expect(value("repo")).toBe("example.com/acme/pier");
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ repoUrl: "https://example.com/acme/pier.git" });
		expect(created[0]?.repository).toBeUndefined();
	});

	it("sends the setup command changed beside the repository's picker, and offers its secrets there", async () => {
		await show();
		open("setup");
		await settle();
		const setup = pop().querySelector("textarea.setup-input") as HTMLTextAreaElement;
		expect(setup.value).toBe("npm ci");
		expect([...pop().querySelectorAll("button")].some((button) => button.textContent === "Manage…")).toBe(true);
		write("pnpm install", setup);
		write("Look around");
		await enter();
		expect(created[0]?.setupCommand).toBe("pnpm install");
	});

	it("sends the place chosen, with that machine's sandbox", async () => {
		await show();
		expect(value("on")).toBe("Hosted");
		open("on");
		pick("m_nas");
		expect(value("on")).toContain("nas");
		write("Run the tests on my machine");
		await enter();
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened" });
	});

	it("sends Claude Code chosen on a machine that offers it, in the hardened container on its own default model", async () => {
		await show();
		open("on");
		pick("m_nas");
		await settle();
		open("agent");
		pick("claude:default");
		// nas's runner reported Claude Code's models: the adapter's default, by the name it gives it.
		expect(value("agent")).toBe("Claude Code · Default (recommended)");
		open("agent");
		expect(pop().textContent).toContain("The models “nas”'s runner reported for Claude Code.");
		open("agent");
		expect(value("mode")).toBe("Auto");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude", profile: "docker-hardened", place: { kind: "machine", machineId: "m_nas" }, mode: "auto" });
		expect(created[0]?.model).toBeUndefined();
	});

	it("sends the model chosen with the agent, and the effort with its first prompt", async () => {
		await show();
		open("agent");
		pickIn("windlass:gpt-6.1-sol", "low");
		expect(value("agent")).toBe("Windlass · gpt-6.1-sol · low");
		write("Fix the flaky test");
		await enter();
		expect(created[0]?.model).toBe("gpt-6.1-sol");
		expect(prompted[0]?.effort).toBe("low");
	});

	/** The machines, each of whose Claude Code reports these options. */
	const reporting = (options: { models: Array<{ id: string; name: string | null; efforts: string[] }>; defaultModel: string }) => (list: MachineSummary[]) =>
		list.map((machine) => ({ ...machine, harnesses: machine.harnesses?.map((harness) => ({ ...harness, optionsDigest: undefined, options: { ...options, modes: [], checkedAt: 1 } })) }));
	/** The agent picker's rows of Claude Code's models: each as shown (its "default" tag after it), and whether it is chosen. */
	const modelRows = () => [...pop().querySelectorAll('[data-value^="claude:"]')].map((row) => [`${row.querySelector(".ui-item-label")?.textContent}${row.querySelector(".ui-tag") ? " default" : ""}`, row.getAttribute("aria-checked") === "true"]);

	it("offers Claude Code's models and efforts as its machine's runner reported them, and sends the ones chosen", async () => {
		const models = [
			{ id: "opus", name: "Opus", efforts: ["low", "high"] },
			{ id: "sonnet", name: "Sonnet", efforts: ["low", "high"] },
			{ id: "haiku", name: null, efforts: [] },
		];
		await show({ machines: reporting({ models, defaultModel: "opus" }) });
		open("on");
		pick("m_nas");
		open("agent");
		pick("claude:opus");
		open("agent");
		// By the names the adapter gave them, its id where it gave none.
		expect(modelRows()).toEqual([
			["Opus default", true],
			["Sonnet", false],
			["haiku", false],
		]);
		pickIn("claude:sonnet", "high");
		expect(value("agent")).toBe("Claude Code · Sonnet · high");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude", model: "sonnet" });
		expect(prompted[0]?.effort).toBe("high");
	});

	it("starts Claude Code on the default its runner reported, not the first model listed, and sends no model for it", async () => {
		const models = [
			{ id: "haiku", name: "Haiku", efforts: [] },
			{ id: "opus", name: "Opus", efforts: ["low", "high"] },
		];
		await show({ machines: reporting({ models, defaultModel: "opus" }) });
		open("on");
		pick("m_nas");
		open("agent");
		pick("claude:opus");
		expect(value("agent")).toBe("Claude Code · Opus (default)");
		open("agent");
		expect(modelRows()).toEqual([
			["Haiku", false],
			["Opus default", true],
		]);
		// Away and back: the default chosen again is still the adapter's own, and its efforts are offered.
		pick("claude:haiku");
		expect(value("agent")).toBe("Claude Code · Haiku");
		open("agent");
		pickIn("claude:opus", "high");
		expect(value("agent")).toBe("Claude Code · Opus (default) · high");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude" });
		expect(created[0]?.model).toBeUndefined();
		expect(prompted[0]?.effort).toBe("high");
	});

	it("sends the mode chosen", async () => {
		await show();
		expect(value("mode")).toBe("Full");
		mode("Ask");
		expect(value("mode")).toBe("Ask");
		write("Fix the flaky test");
		await enter();
		expect(created[0]?.mode).toBe("ask");
	});

	it("sends the sandbox chosen, and offers its saved default back", async () => {
		await show();
		expect(value("sandbox")).toContain("Docker, hardened");
		open("sandbox");
		pickIn("platform", "docker-windlass-sandbox");
		expect(value("sandbox")).toContain("Docker + Windlass sandbox");
		expect(pill("sandbox")?.classList.contains("ui-pill-changed")).toBe(true);
		open("sandbox");
		expect(pop().textContent).toContain("Back to the default (acme/harbor's: Docker, hardened)");
		write("Fix the flaky test");
		await enter();
		expect(created[0]).toMatchObject({ profile: "docker-windlass-sandbox", mode: "auto" });
	});
});

describe("what the start composer starts on", () => {
	/** An agent of the user's launched on no repository, on "nas", in the hardened container, on the second model and in Ask: the newest of all. */
	const lastOnNas = async (mock: MockClient) => {
		await mock.user(ada).createSession({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened", model: "gpt-6-brisk", mode: "ask" });
	};

	it("goes by the newest agent where nothing is saved: its repository (none), its place, its sandbox, its model and its mode", async () => {
		await show({ before: lastOnNas });
		created = [];
		expect(value("repo")).toBe("none");
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened", model: "gpt-6-brisk", mode: "ask" });
	});

	it("puts the account's saved default before the newest agent's, and the repository's before the account's", async () => {
		await show({ before: async (mock) => (await lastOnNas(mock), void (await mock.user(ada).saveAccountDefaults({ model: "gpt-6.1-sol", profile: "docker-windlass-sandbox" }))) });
		created = [];
		write("Look around");
		await enter();
		// The account's: on nas its Windlass sandbox and the first model; the newest agent's place and mode stand, as nothing is saved for them.
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-windlass-sandbox", model: "gpt-6.1-sol" });
		act(() => root?.unmount());
		root = null;
		client.dispose();
		created = [];
		// Opened from acme/harbor's page: its saved defaults come first.
		await show({ repositoryId: 7101, before: async (mock) => void (await mock.user(ada).saveAccountDefaults({ model: "gpt-6.1-sol", profile: "docker-windlass-sandbox" })) });
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ repository: { id: 7101 }, profile: "docker-hardened", model: "gpt-6-luna" });
	});

	/** Claude Code on "nas" in Plan, started and then deleted: only the server's memory of it is left. */
	const claudeOnNasDeleted = async (mock: MockClient) => {
		const user = mock.user(ada);
		const made = await user.createSession({ place: { kind: "machine", machineId: "m_nas" }, harness: "claude", profile: "docker-hardened", mode: "plan" });
		await user.deleteSession(made.id);
	};

	it("starts where the last agent started, with its agent and mode, after that agent is deleted", async () => {
		await show({ before: claudeOnNasDeleted });
		created = [];
		expect(value("on")).toContain("nas");
		expect(value("agent")).toContain("Claude Code");
		expect(value("mode")).toBe("Plan");
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, harness: "claude", profile: "docker-hardened", mode: "plan" });
	});

	it("falls back to a hosted Windlass agent when the last machine is gone, and says why", async () => {
		await show({ before: claudeOnNasDeleted, machines: (list) => list.filter((machine) => machine.machineId !== "m_nas") });
		created = [];
		expect(value("on")).toBe("Hosted");
		expect(value("agent")).toContain("Windlass");
		expect(pill("on")?.classList.contains("ui-pill-warn")).toBe(true);
		open("agent");
		expect(pop().textContent).toContain("Your last agent was Claude Code, which runs only on a machine of yours, so this one is Windlass.");
		act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		write("Look around");
		await enter();
		expect(created[0]?.place).toBeUndefined();
		expect(created[0]?.harness).toBeUndefined();
	});

	it("puts a choice made here before every default", async () => {
		await show({ repositoryId: 7101 });
		open("agent");
		pick("windlass:gpt-6-brisk");
		open("sandbox");
		pickIn("platform", "docker-windlass-sandbox");
		write("Look around");
		await enter();
		expect(created[0]).toMatchObject({ profile: "docker-windlass-sandbox", model: "gpt-6-brisk" });
	});
});

describe("the start composer and the visit to GitHub", () => {
	it("keeps the task and every choice, the mode included, across connecting GitHub", async () => {
		await show({ who: demo });
		write("Add a health check");
		open("on");
		pick("m_nas");
		mode("Ask");
		open("repo");
		expect(value("repo")).toBe("none");
		// The browser leaves for GitHub here; jsdom stays, with what was kept for the way back.
		press("Connect GitHub");
		await settle();
		expect(JSON.parse(sessionStorage.getItem("wlp.new-agent.draft") ?? "null")).toMatchObject({ prompt: "Add a health check", place: "m_nas", mode: "ask" });
		// Back from GitHub: the page loads again.
		act(() => root?.unmount());
		root = null;
		client.dispose();
		await show({ who: demo });
		expect(field().value).toBe("Add a health check");
		expect(value("on")).toContain("nas");
		expect(value("mode")).toBe("Ask");
		await enter();
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, mode: "ask" });
	});
});
