// @vitest-environment jsdom
/**
 * The session page draws by its agent's capabilities (`SessionSummary.capabilities`), never by the agent's
 * name. Here the records are swapped: Claude Code is given Windlass's flags and Windlass an ACP agent's, and
 * each page follows the flags it was sent. An agent added later needs no screen edited.
 */
import type { AuthResult, HarnessId, SessionCapabilities, SessionSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";
import { Session } from "./Session";

vi.mock("../../../server/src/sandbox/harnesses.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../../server/src/sandbox/harnesses.js")>();
	const swapped = (id: HarnessId | undefined): SessionCapabilities => {
		const windlass = id === undefined || id === "windlass";
		// Each agent gets the other's record: what the page draws must follow.
		return windlass ? real.sessionCapabilities("claude") : { ...real.sessionCapabilities("windlass"), planMode: true, models: "harness" };
	};
	return { ...real, sessionCapabilities: swapped };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
let auth: AuthResult;

async function wait(steps = 6): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => { vi.advanceTimersByTime(400); });
}

async function until(ready: () => boolean, steps = 60): Promise<void> {
	for (let step = 0; step < steps && !ready(); step++) await wait(1);
	expect(ready()).toBe(true);
}

function Page({ id }: { id: string }) {
	return createElement(Session, { sessionId: id, state: useSession(id) });
}

async function open(pick: (sessions: SessionSummary[]) => SessionSummary | undefined): Promise<SessionSummary> {
	client = createMockClient({ origin: "http://localhost:5173", machine: "online" });
	const begun = client.login.start();
	vi.advanceTimersByTime(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	vi.advanceTimersByTime(1000);
	auth = await finished;
	saveAuth("mock", auth);
	const listed = client.user(auth).listSessions();
	vi.advanceTimersByTime(1000);
	const found = pick(await listed);
	expect(found).toBeDefined();
	const session = found as SessionSummary;
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Page, { id: session.id }) })));
	await wait();
	return session;
}

beforeEach(() => {
	vi.useFakeTimers();
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

describe("a session page drawn by its agent's flags", () => {
	it("gives Claude Code, sent Windlass's flags, the per-call token counts in place of the context, Plan mode and a call's stop", async () => {
		const summary = await open((sessions) => sessions.find((one) => one.id === "nas-claude"));
		expect(summary.capabilities.cancelCall).toBe(true);
		expect(host.querySelector("[data-usage=tokens] .cache-calls")).not.toBeNull();
		expect(host.querySelector("[data-usage=context]")).toBeNull();
		expect(host.textContent).toContain("Plan mode");
		// A running call has its own stop, as the flag says it can be stopped.
		await act(async () => void client.session(auth, "nas-claude").prompt({ text: "Read the README again and run the tests." }));
		const second = () => host.querySelectorAll(".turn")[1] as HTMLElement | undefined;
		await until(() => second()?.querySelector(".tool-running") != null);
		expect(second()?.querySelector(".tool-stop, .tool-stoppable")).not.toBeNull();
	}, 30_000);

	it("gives Windlass, sent Claude Code's flags, the context in place of per-call tokens, no secrets and no Plan mode", async () => {
		// One on a repository, whose saved secrets its panel would list for an agent they are handed to.
		const summary = await open((sessions) => sessions.find((one) => (one.harness ?? "windlass") === "windlass" && one.item === undefined && one.turns > 0 && one.repository));
		expect(summary.capabilities.usage).toBe("context");
		expect(host.querySelector("[data-usage=context]")).not.toBeNull();
		expect(host.querySelector(".cache-calls")).toBeNull();
		expect(host.querySelector("#panel-secrets")).toBeNull();
		expect(host.textContent).not.toContain("Plan mode");
	});
});
