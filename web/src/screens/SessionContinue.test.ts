// @vitest-environment jsdom
/**
 * "Continue in a new PR" in the side panel's pull request section: its dialog offers the repository's
 * default branch, and "Stack on #N" only where the agent's work is on GitHub; the new agent opens, and
 * the two agents link to each other in the panel ("continued from", "continued in") and in the list.
 */
import type { AuthResult, SessionSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { stackChoice } from "../components/ContinueSession";
import { continuedIn } from "../lib/continued";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";
import { Session } from "./Session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function () {
	this.open = true;
};
HTMLDialogElement.prototype.close ??= function () {
	this.open = false;
};
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	addEventListener() {},
	removeEventListener() {},
	addListener() {},
	removeListener() {},
	onchange: null,
	dispatchEvent: () => false,
})) as typeof window.matchMedia;

let host: HTMLElement;
let root: Root;
let client: MockClient;
let auth: AuthResult;

function Page({ id }: { id: string }) {
	return createElement(Session, { sessionId: id, state: useSession(id) });
}

async function wait(steps = 8): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void vi.advanceTimersByTime(400));
}

async function signIn(): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173", machine: "online" });
	const begun = client.login.start();
	vi.advanceTimersByTime(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	vi.advanceTimersByTime(1000);
	auth = await finished;
	saveAuth("mock", auth);
}

async function sessions(): Promise<SessionSummary[]> {
	const listed = client.user(auth).listSessions();
	vi.advanceTimersByTime(1000);
	return await listed;
}

async function show(id: string): Promise<void> {
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Page, { id, key: id }) })));
	await wait();
}

const ownOnRepository = (session: SessionSummary) =>
	!!session.repository && session.status === "idle" && !session.item && !session.readiness;

const button = () =>
	[...host.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Continue in a new PR");
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
const choices = () =>
	[...(dialog()?.querySelectorAll<HTMLLabelElement>(".continue-choice") ?? [])].map(
		label => label.querySelector("strong")?.textContent,
	);
/** The side panel's value for a label of its Agent section. */
const fact = (label: string) =>
	[...host.querySelectorAll("#details dt")].find(dt => dt.textContent === label)?.nextElementSibling ?? null;

beforeEach(() => {
	vi.useFakeTimers();
	Element.prototype.scrollTo ??= function scrollTo() {};
	Element.prototype.scrollIntoView ??= function scrollIntoView() {};
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

it("offers only the default branch before anything is pushed, and opens the new agent with a link back", async () => {
	await signIn();
	const parent = (await sessions()).find(session => ownOnRepository(session) && !session.pullRequest);
	expect(parent).toBeDefined();
	await show(parent!.id);
	expect(button()).toBeDefined();
	act(() => button()!.click());
	await wait();
	expect(dialog()?.textContent).toContain("Continue in a new PR");
	expect(choices()).toEqual([expect.stringMatching(/^Start from \S+$/)]);
	expect(choices()[0]).not.toBe("Start from the default branch");
	const go = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Continue");
	await act(async () => go!.click());
	await wait();
	expect(dialog()).toBeNull();
	const made = (await sessions()).find(session => session.continuedFrom?.id === parent!.id);
	expect(made).toBeDefined();
	expect(window.location.pathname).toContain(made!.id);
	expect(made!.model).toBe(parent!.model);
	expect(made!.harness).toBe(parent!.harness);
	expect(made!.profile).toBe(parent!.profile);
	expect(made!.pullRequest).toBeNull();
	expect(made!.continuedFrom).toEqual({ id: parent!.id, title: parent!.title });

	// The new agent's panel links back; the first one's lists the new one.
	await show(made!.id);
	expect(fact("continued from")?.textContent).toBe(parent!.title);
	expect(fact("continued from")?.querySelector("a")?.getAttribute("href")).toContain(parent!.id);
	await show(parent!.id);
	expect(fact("continued in")?.textContent).toBe(made!.title);
	expect(fact("continued from")).toBeNull();
});

it("offers to stack on an open pull request, and starts the new agent from its branch", async () => {
	await signIn();
	const parent = (await sessions()).find(
		session =>
			ownOnRepository(session) && (session.pullRequest?.state === "open" || session.pullRequest?.state === "draft"),
	);
	expect(parent).toBeDefined();
	await show(parent!.id);
	act(() => button()!.click());
	await wait();
	expect(choices()).toEqual([expect.stringMatching(/^Start from /), `Stack on #${parent!.pullRequest!.number}`]);
	const radios = [...dialog()!.querySelectorAll<HTMLInputElement>("input[type=radio]")];
	expect(radios[0]?.checked).toBe(true);
	act(() => radios[1]?.click());
	const go = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Continue");
	await act(async () => go!.click());
	await wait();
	const made = (await sessions()).find(session => session.continuedFrom?.id === parent!.id);
	expect(made?.repository?.branch).toBe(parent!.pullRequest!.branch);
});

it("refuses while the agent works, and says so at the button", async () => {
	await signIn();
	const parent = (await sessions()).find(ownOnRepository);
	await show(parent!.id);
	const user = client.user(auth);
	const turn = client.session(auth, parent!.id).prompt({ text: "Write a short program" });
	await wait(1);
	await turn;
	await wait(1);
	expect(button()?.disabled).toBe(true);
	expect(button()?.title).toBe("Available when this turn ends.");
	const refused = user.continueSession({ id: parent!.id }).catch((error: { reason?: string }) => error.reason);
	await wait(2);
	expect(await refused).toBe("turn_running");
});

it("the stack choice and the list of continuing agents follow the server's rules", () => {
	const pull = { number: 4, branch: "windlass/a", state: "open" } as SessionSummary["pullRequest"] & object;
	expect(stackChoice(pull, null)).toEqual({ branch: "windlass/a", pull: 4 });
	expect(stackChoice({ ...pull, state: "merged" }, null)).toBeNull();
	expect(stackChoice({ ...pull, state: "merged" }, { branch: "windlass/b", pushed: "abc" })).toEqual({
		branch: "windlass/b",
		pull: null,
	});
	expect(stackChoice(null, { branch: "windlass/b", pushed: null })).toBeNull();
	const at = (id: string, createdAt: number, from?: string) =>
		({ id, createdAt, ...(from && { continuedFrom: { id: from, title: "x" } }) }) as SessionSummary;
	expect(continuedIn([at("c", 3, "a"), at("b", 2, "a"), at("d", 1, "z"), at("a", 0)], "a").map(one => one.id)).toEqual([
		"b",
		"c",
	]);
});
