// @vitest-environment jsdom
/**
 * Claude Code's sign-in from the page, against the mock (api/mock.ts, `claude-signed-out`: "nas" offers
 * Claude Code and nobody signed it in; `online`: it is signed in). The button is on each line that says
 * it is not signed in: the Machines page, the start composer's agent picker, a Claude Code agent's page.
 * The flow: Sign in asks for the link, the code is checked here before it is sent, Finish with the
 * mock's code (`mock-approval`) signs the machine in, Cancel ends it, and a failure says its sentence.
 */
import type { AuthResult } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserApi } from "../api/client";
import { createMockClient, type MockClient, type MockMachineState } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { Machines } from "../screens/Machines";
import { NewAgent } from "../screens/NewAgent";
import { Session, useSessionMachine } from "../screens/Session";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The longest code the server takes (server/src/runner/protocol.ts, `approvalCode`). */
const MAX_CODE_CHARS = 2048;
const auth: AuthResult = { token: "mock:chatgpt:u_signin:ada@example.com", profile: { uid: "u_signin", email: "ada@example.com", demo: false } };

let host: HTMLElement;
let root: Root;
let client: MockClient;
/** The sign-in calls the page made, in order, with what they sent. */
let calls: Array<{ call: string; input: unknown }>;

async function settle(steps = 12): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2))));
}

/** A mock whose machines stand as `machine` says, with its sign-in calls recorded. */
function mock(machine: MockMachineState, change?: (api: UserApi) => Partial<UserApi>): MockClient {
	calls = [];
	const made = createMockClient({ pace: 0, origin: "http://localhost:5173", machine });
	const user = made.user.bind(made);
	(made as { user: (auth: AuthResult) => UserApi }).user = (who) => {
		const api = user(who);
		const recorded: UserApi = {
			...api,
			startClaudeLogin: (input) => (calls.push({ call: "start", input }), api.startClaudeLogin(input)),
			finishClaudeLogin: (input) => (calls.push({ call: "finish", input }), api.finishClaudeLogin(input)),
			cancelClaudeLogin: (input) => (calls.push({ call: "cancel", input }), api.cancelClaudeLogin(input)),
		};
		return { ...recorded, ...change?.(recorded) };
	};
	return made;
}

async function render(made: MockClient, page: () => ReturnType<typeof createElement>, address = "/"): Promise<void> {
	// jsdom lays nothing out, and scrolls nothing.
	Element.prototype.scrollTo ??= function scrollTo() {};
	client = made;
	history.replaceState(null, "", address);
	saveAuth("mock", auth);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(createElement(AppProvider, { client, children: page() })));
	await settle();
}

const machinesPage = (machine: MockMachineState, change?: (api: UserApi) => Partial<UserApi>) => render(mock(machine, change), () => createElement(Machines, { adding: false }), "/machines");

function AgentPage({ id }: { id: string }) {
	const state = useSession(id);
	return createElement(Session, { sessionId: id, state, machine: useSessionMachine(state.summary?.place) });
}

/** Opens the new agent's page on no repository, and chooses nas and its agent picker. */
async function composer(machine: MockMachineState): Promise<void> {
	await render(mock(machine), () => createElement(NewAgent), "/new");
	const chip = (name: string) => host.querySelector(`[data-picker="${name}"]`) as HTMLButtonElement;
	const pop = () => document.querySelector(".ui-pop") as HTMLElement;
	act(() => chip("repo").click());
	act(() => ([...pop().querySelectorAll("button")].find((button) => button.textContent === "No repository") as HTMLButtonElement).click());
	await settle();
	act(() => chip("repo").click());
	act(() => chip("where").click());
	act(() => (pop().querySelector('[data-value="m_nas"]') as HTMLElement).click());
	// The agent's menu stays open, with Claude Code's sign-in at its head where it is needed.
	act(() => chip("agent").click());
}

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.dispose();
	saveAuth("mock", null);
	vi.restoreAllMocks();
});

// The page and what is open over it: a picker is drawn at the end of the page.
const signInButton = () => [...document.querySelectorAll(".claude-signin button")].find((button) => button.textContent === "Sign in") as HTMLButtonElement | undefined;
const panel = () => document.querySelector(".claude-signin-panel") as HTMLElement | null;
const field = () => panel()?.querySelector("input") as HTMLInputElement;
const press = async (words: string) => {
	const button = [...document.querySelectorAll("button")].find((one) => one.textContent === words) as HTMLButtonElement | undefined;
	expect(button, words).toBeDefined();
	await act(async () => button?.click());
	await settle();
};
/** Types into the code field as React sees it. */
const paste = (text: string) =>
	act(() => {
		const input = field();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
const text = () => document.body.textContent ?? "";
const sent = (call: string) => calls.filter((one) => one.call === call);

describe("the Sign in button", () => {
	it("is on the Machines page's line where Claude Code is not signed in, with the command as the other way, and not where it is", async () => {
		await machinesPage("claude-signed-out");
		expect(signInButton()).toBeDefined();
		const line = signInButton()?.closest(".claude-signin") as HTMLElement;
		expect(line.closest(".machine-notes")).not.toBeNull();
		expect(line.textContent).toContain("Claude Code: not signed in.");
		// The command is the second way, folded away under the line.
		const or = [...line.querySelectorAll("button")].find((button) => button.textContent === "or run this on the machine") as HTMLButtonElement;
		expect(or.getAttribute("aria-expanded")).toBe("false");
		expect((line.querySelector(".claude-signin-command") as HTMLElement).hidden).toBe(true);
		act(() => or.click());
		expect((line.querySelector(".claude-signin-command") as HTMLElement).hidden).toBe(false);
		expect(line.querySelector("pre")?.textContent).toBe("docker exec -it windlass-runner windlass-runner login claude");
		// The details no longer repeat the command.
		expect(host.querySelectorAll(".machine-details pre")).toHaveLength(0);

		// Signed in: no button, and no line.
		act(() => root.unmount());
		host.remove();
		client.dispose();
		await machinesPage("online");
		expect(text()).toContain("Claude Code signed in");
		expect(signInButton()).toBeUndefined();
		expect(host.querySelector(".claude-signin")).toBeNull();
	});

	it("is in the start composer's agent picker for Claude Code on a machine where it is not signed in, and not where it is", async () => {
		await composer("claude-signed-out");
		const pick = document.querySelector(".ui-pop .ui-menu-header") as HTMLElement;
		expect(pick.querySelector(".claude-signin")?.textContent).toContain("Claude Code: not signed in on “nas”.");
		expect(signInButton()).toBeDefined();
		act(() => root.unmount());
		host.remove();
		client.dispose();
		await composer("online");
		expect(document.querySelector('.ui-pop [data-value^="claude:"]')).not.toBeNull();
		expect(signInButton()).toBeUndefined();
		expect(text()).not.toContain("not signed in");
	});

	it("is on a Claude Code agent's page when its machine is not signed in, and not when it is", async () => {
		await render(mock("claude-signed-out"), () => createElement(AgentPage, { id: "nas-claude" }), "/agents/nas-claude");
		const banner = host.querySelector(".session-signin") as HTMLElement;
		expect(banner.textContent).toContain("Claude Code: not signed in on “nas”, so this agent cannot run a turn.");
		expect(signInButton()).toBeDefined();
		act(() => root.unmount());
		host.remove();
		client.dispose();
		await render(mock("online"), () => createElement(AgentPage, { id: "nas-claude" }), "/agents/nas-claude");
		expect(host.querySelector(".turn")).not.toBeNull();
		expect(host.querySelector(".session-signin")).toBeNull();
		expect(signInButton()).toBeUndefined();
	});
});

describe("signing Claude Code in from the page", () => {
	it("opens the panel with Anthropic's link in a new tab, the code field and how long the sign-in lasts", async () => {
		await machinesPage("claude-signed-out");
		await press("Sign in");
		expect(sent("start")).toEqual([{ call: "start", input: { machineId: "m_nas" } }]);
		const link = panel()?.querySelector("a") as HTMLAnchorElement;
		expect(link.textContent).toBe("Open Anthropic to authorize");
		expect(link.href).toBe("https://claude.example.invalid/authorize");
		expect(link.target).toBe("_blank");
		expect(link.rel.split(" ")).toContain("noopener");
		expect(document.activeElement).toBe(link);
		expect(panel()?.textContent).toContain("Paste the code Anthropic shows");
		expect(panel()?.textContent).toMatch(/The sign-in lasts 10 minutes, until \d\d:\d\d\./);
		expect(panel()?.textContent).toContain("Your token is created on your machine and the runner never sends it to the platform.");
		expect(signInButton()).toBeUndefined();
	});

	it("refuses a token, an empty code and an overlong one here, and sends none of them", async () => {
		await machinesPage("claude-signed-out");
		await press("Sign in");
		const problem = () => panel()?.querySelector('[role="alert"]')?.textContent ?? null;

		await press("Finish");
		expect(problem()).toBe("Paste the code Anthropic shows after you authorize.");
		paste("   \n ");
		await press("Finish");
		expect(problem()).toBe("Paste the code Anthropic shows after you authorize.");

		paste("  sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789  ");
		await press("Finish");
		expect(problem()).toContain("That is a Claude token, not the code. Do not paste the token");
		// The token does not stay in the page.
		expect(field().value).toBe("");
		expect(field().getAttribute("aria-invalid")).toBe("true");

		paste("a".repeat(MAX_CODE_CHARS + 1));
		await press("Finish");
		expect(problem()).toBe("That is longer than any code from Anthropic. Paste only the code it shows.");

		// Enter in the field is Finish too, and refused the same way.
		paste("sk-ant-api03-xyz");
		act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		await settle();
		expect(problem()).toContain("That is a Claude token");

		expect(sent("finish")).toEqual([]);
		// The link still works: the sign-in was not ended.
		expect(panel()?.querySelector("a")?.textContent).toBe("Open Anthropic to authorize");
	});

	it("signs the machine in with the mock's code: the line says so, the list follows, and the panel is closed", async () => {
		await machinesPage("claude-signed-out");
		await press("Sign in");
		paste("  mock-approval ");
		await press("Finish");
		expect(sent("finish")).toEqual([{ call: "finish", input: { machineId: "m_nas", code: "mock-approval" } }]);
		expect(panel()).toBeNull();
		expect(document.querySelector(".claude-signin-done")?.textContent).toBe("Claude Code: signed in");
		// The machine's own line, from the list the mock sent on.
		expect(host.querySelector(".agent-meta")?.textContent).toContain("Claude Code signed in");
		expect(text()).not.toContain("not signed in");
		expect(signInButton()).toBeUndefined();
	});

	it("says it is working while Finish waits, as a wrong code can take about twenty seconds", async () => {
		let release: () => void = () => undefined;
		await machinesPage("claude-signed-out", (api) => ({
			finishClaudeLogin: (input) => new Promise((resolve, reject) => (release = () => void api.finishClaudeLogin(input).then(resolve, reject))),
		}));
		await press("Sign in");
		paste("mock-approval");
		await press("Finish");
		expect(panel()?.textContent).toContain("This can take up to about 20 seconds: a wrong code makes Claude Code wait before it fails.");
		expect(([...(panel()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Finishing…") as HTMLButtonElement).disabled).toBe(true);
		await act(async () => release());
		await settle();
		expect(host.querySelector(".claude-signin-done")).not.toBeNull();
	});

	it("cancels with cancelClaudeLogin and closes the panel", async () => {
		await machinesPage("claude-signed-out");
		await press("Sign in");
		paste("half a code");
		await press("Cancel");
		expect(sent("cancel")).toEqual([{ call: "cancel", input: { machineId: "m_nas" } }]);
		expect(panel()).toBeNull();
		expect(signInButton()).toBeDefined();
		// A new start is taken: nothing is pending on the machine any more.
		await press("Sign in");
		expect(panel()?.querySelector("a")).not.toBeNull();
		expect(field().value).toBe("");
	});

	it("shows the runner's sentence when the code fails, and lets it start again or cancel", async () => {
		await machinesPage("claude-signed-out");
		await press("Sign in");
		paste("not-the-code");
		await press("Finish");
		expect(panel()?.querySelector('[role="alert"]')?.textContent).toBe("The mock approval code is mock-approval.");
		expect(panel()?.querySelector("input")).toBeNull();
		await press("Start again");
		expect(sent("start")).toHaveLength(2);
		expect(panel()?.querySelector("a")?.textContent).toBe("Open Anthropic to authorize");
		paste("mock-approval");
		await press("Finish");
		expect(host.querySelector(".claude-signin-done")).not.toBeNull();
	});

	it("shows a refusal to start, such as the rate limit, in its own sentence", async () => {
		await machinesPage("claude-signed-out");
		// Twelve calls in ten minutes are the limit: twelve here, then the button's is refused.
		const user = client.user(auth);
		for (let call = 0; call < 12; call++) await user.cancelClaudeLogin({ machineId: "m_nas" });
		await press("Sign in");
		expect(panel()?.querySelector('[role="alert"]')?.textContent).toBe("Too many Claude sign-in requests.");
		await press("Cancel");
		expect(panel()).toBeNull();
		expect(text()).toContain("Too many Claude sign-in requests.");
	});

	it("keeps a pending sign-in when the composer's picker closes and opens again", async () => {
		await composer("claude-signed-out");
		await press("Sign in");
		const url = panel()?.querySelector("a")?.getAttribute("href");
		const agentChip = () => host.querySelector('[data-picker="agent"]') as HTMLButtonElement;
		act(() => agentChip().click());
		expect(document.querySelector(".ui-pop")).toBeNull();
		act(() => agentChip().click());
		expect(panel()?.querySelector("a")?.getAttribute("href")).toBe(url);
		expect(sent("start")).toHaveLength(1);
		// Enter finishes the sign-in, and does not start the agent.
		paste("mock-approval");
		act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		await settle();
		expect(sent("finish")).toHaveLength(1);
		expect(document.querySelector(".claude-signin-done")?.textContent).toBe("Claude Code: signed in");
		expect(location.pathname).toBe("/new");
	});
});
