// @vitest-environment jsdom
/**
 * "Publish pull request" in the session's bar is never a silent press. With the side panel hidden and the
 * panel still reading what there is to publish (on a machine that read goes through its runner, and takes
 * seconds), the button says it is reading, and the dialog opens by itself once the read arrives. Where the
 * dialog cannot open, the button says why, in a popover of its own.
 */
import type { AuthResult, PublishState, SessionSummary } from "@contract";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";
import { setPanelHidden } from "../state/sessionChrome";
import { Session, SessionCrumb } from "./Session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
HTMLDialogElement.prototype.close ??= function () { this.open = false; };
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

let host: HTMLElement;
let root: Root;
let client: MockClient;
/** The panel's reads of the publish state, held until the test lets each go. */
let held: Array<() => void>;
let hold: boolean;

function Page({ id }: { id: string }) {
	const state = useSession(id);
	return createElement(Fragment, null, createElement(SessionCrumb, { title: state.summary?.title ?? null, status: state.summary?.status ?? null, summary: state.summary }), createElement(Session, { sessionId: id, state }));
}

async function wait(steps = 6): Promise<void> {
	for (let step = 0; step < steps; step++) await act(async () => void vi.advanceTimersByTime(400));
}

async function open(pick: (session: SessionSummary) => boolean): Promise<{ auth: AuthResult; session: SessionSummary }> {
	client = createMockClient({ origin: "http://localhost:5173", machine: "online" });
	const begun = client.login.start();
	vi.advanceTimersByTime(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	vi.advanceTimersByTime(1000);
	const auth = await finished;
	saveAuth("mock", auth);
	const listed = client.user(auth).listSessions();
	vi.advanceTimersByTime(1000);
	const session = (await listed).find(pick);
	expect(session).toBeDefined();
	// The panel's reads wait while `hold` is on.
	const real = client.session.bind(client);
	(client as { session: typeof client.session }).session = (who, id) => {
		const api = real(who, id);
		return {
			...api,
			publishState: () =>
				hold
					? new Promise<PublishState>((resolve, reject) => held.push(() => void api.publishState().then(resolve, reject)))
					: api.publishState(),
		};
	};
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Page, { id: session!.id }) })));
	await wait();
	return { auth, session: session! };
}

const publish = () => [...host.querySelectorAll<HTMLButtonElement>(".bar-button")].find((button) => button.textContent?.includes("Publish pull request") || button.textContent?.includes("Reading changes"));

beforeEach(() => {
	vi.useFakeTimers();
	Element.prototype.scrollTo ??= function scrollTo() {};
	Element.prototype.scrollIntoView ??= function scrollIntoView() {};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	held = [];
	hold = false;
	setPanelHidden(true);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client?.dispose();
	saveAuth("mock", null);
	setPanelHidden(false);
	vi.useRealTimers();
});

it("says it is reading while the panel is hidden and its state still loading, then opens the dialog", async () => {
	hold = true;
	await open((session) => session.repository !== undefined && session.repository !== null && !session.pullRequest && session.status === "idle" && !session.item);
	// The panel's first read has not come back.
	expect(held.length).toBeGreaterThan(0);
	expect(host.querySelector(".session-panel-hidden")).not.toBeNull();
	act(() => publish()?.click());
	expect(publish()?.textContent).toBe("Reading changes…");
	expect(publish()?.getAttribute("aria-busy")).toBe("true");
	expect(document.querySelector("dialog[open]")).toBeNull();
	// The read arrives: the dialog opens by itself, and the button is itself again.
	hold = false;
	for (const release of held.splice(0)) release();
	await wait();
	expect(document.querySelector("dialog[open]")).not.toBeNull();
	// Not inside the hidden panel, whose display: none would hide it too.
	expect(document.querySelector("dialog[open]")?.closest(".panel")).toBeNull();
	expect(publish()?.textContent).toBe("Publish pull request");
});

it("says why at the button when nothing can be pushed, and opens the panel's section from there", async () => {
	await open((session) => session.repository !== undefined && session.repository !== null && !session.pullRequest && session.status === "idle" && !session.item);
	// The workspace as the panel last read it: nothing can be pushed now.
	hold = false;
	const real = client.session.bind(client);
	(client as { session: typeof client.session }).session = (who, id) => {
		const api = real(who, id);
		return { ...api, publishState: async () => ({ ...(await api.publishState()), blocked: "The workspace cannot be read while its machine is offline." }) };
	};
	await act(async () => (host.querySelector<HTMLButtonElement>(`[aria-label="Read the pull request's state again"]`))?.click());
	await wait();
	act(() => publish()?.click());
	await wait(1);
	const why = document.querySelector(".bar-publish-why");
	expect(why?.textContent).toContain("The workspace cannot be read while its machine is offline.");
	expect(why?.textContent).toContain("Open the pull request section");
	expect(document.querySelector("dialog[open]")).toBeNull();
	// From there, the hidden panel is shown.
	act(() => [...(why?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Open the pull request section")?.click());
	await wait(1);
	expect(host.querySelector(".session-panel-hidden")).toBeNull();
	expect(document.querySelector(".bar-publish-why")).toBeNull();
});
