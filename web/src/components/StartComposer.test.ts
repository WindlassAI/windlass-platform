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

/** The chip with this label, and its value as shown. */
const chip = (label: string) => [...host.querySelectorAll(".start-chips .mini-select")].find((select) => select.firstElementChild?.textContent === label) as HTMLElement | undefined;
const value = (label: string) => chip(label)?.querySelector("button")?.textContent ?? null;
/** Opens the chip's picker. */
const open = (label: string) => act(() => (chip(label)?.querySelector("button") as HTMLButtonElement).click());
const pop = () => host.querySelector(".start-pop") as HTMLElement;
/** Chooses the radio of this value in the open picker. */
const pick = (value: string) => act(() => (pop().querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement).click());
/** Chooses a mode in the mode's own list. */
function mode(name: string): void {
	open("mode");
	const option = [...host.querySelectorAll(".mode-option")].find((candidate) => candidate.querySelector(".mode-option-name")?.textContent === name) as HTMLElement;
	act(() => option.click());
}
/** A link-styled button in the open picker, by its words. */
const press = (words: string) => act(() => ([...pop().querySelectorAll("button")].find((button) => button.textContent === words) as HTMLButtonElement).click());

describe("the start composer", () => {
	it("starts an agent with the defaults when a task is typed and Enter pressed, and opens it", async () => {
		await show();
		// The newest agent was launched on acme/harbor, whose saved defaults are the hardened container and the second model.
		expect(value("repo")).toBe("acme/harbor @ main");
		write("Run the tests and fix what fails");
		await enter();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ repository: { id: 7101, branch: "main" }, profile: "docker-hardened", model: "gpt-6-luna", mode: "full", title: "Run the tests and fix what fails" });
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
		await act(async () => ([...host.querySelectorAll(".start-foot button")].find((button) => button.textContent === "Create without a prompt") as HTMLButtonElement).click());
		await settle();
		expect(created).toHaveLength(1);
		expect(created[0]?.title).toBeUndefined();
		expect(prompted).toHaveLength(0);
	});

	it("names the agent after the task's first line", async () => {
		await show();
		write("\n  Add the tests command to the README  \nThen run them, and say what passed.");
		await enter();
		expect(created[0]?.title).toBe("Add the tests command to the README");
		expect(prompted[0]?.text).toBe("Add the tests command to the README  \nThen run them, and say what passed.");
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

	it("sends the setup command changed in the repository's picker, and offers its secrets there", async () => {
		await show();
		open("repo");
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
		expect(value("on")).toBe("this platform");
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
		open("agent");
		pick("claude");
		expect(value("agent")).toBe("Claude Code · default model");
		expect(pop().textContent).toContain("“nas”'s runner reports Claude Code's models once it has checked.");
		expect(value("mode")).toBe("Auto");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude", profile: "docker-hardened", place: { kind: "machine", machineId: "m_nas" }, mode: "auto" });
		expect(created[0]?.model).toBeUndefined();
	});

	it("sends the model chosen with the agent, and the effort with its first prompt", async () => {
		await show();
		open("agent");
		pick("gpt-6.1-sol");
		pick("low");
		expect(value("agent")).toBe("Windlass · gpt-6.1-sol · low");
		write("Fix the flaky test");
		await enter();
		expect(created[0]?.model).toBe("gpt-6.1-sol");
		expect(prompted[0]?.effort).toBe("low");
	});

	it("offers Claude Code's models and efforts as its machine's runner reported them, and sends the ones chosen", async () => {
		const reported = { models: [{ id: "opus", name: "Opus", efforts: ["low", "high"] }, { id: "haiku", name: null, efforts: [] }], modes: [], checkedAt: 1 };
		await show({ machines: (list) => list.map((machine) => ({ ...machine, harnesses: machine.harnesses?.map((harness) => ({ ...harness, options: reported })) })) });
		open("on");
		pick("m_nas");
		open("agent");
		pick("claude");
		pick("opus");
		pick("high");
		expect(value("agent")).toBe("Claude Code · opus · high");
		write("Add the test command to the README");
		await enter();
		expect(created[0]).toMatchObject({ harness: "claude", model: "opus" });
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
		pick("docker-windlass-sandbox");
		expect(value("sandbox")).toContain("Docker + Windlass sandbox");
		expect(chip("sandbox")?.parentElement?.classList.contains("start-chip-changed")).toBe(true);
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

	it("puts a choice made here before every default", async () => {
		await show({ repositoryId: 7101 });
		open("agent");
		pick("gpt-6-brisk");
		open("sandbox");
		pick("docker-windlass-sandbox");
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
		expect(created[0]).toMatchObject({ place: { kind: "machine", machineId: "m_nas" }, mode: "ask", title: "Add a health check" });
	});
});
