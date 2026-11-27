// @vitest-environment jsdom
/**
 * Blocked network requests: a turn's `network.blocked` row in the timeline (one per turn, replaced in
 * place by a newer revision, the hosted platform lines it lists left out) and the item page's Network
 * block. Each kind of `allow` says what can be done: the repository's button, the machine's settings
 * with its hint folded, the deployment's operator, or a quiet reason.
 */
import type { BlockedHost, BlockedNetwork, HostAllowed, NetworkBlockedItem, TimelineItem } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyItem, blockedRequests, emptyView, shownBlocks, turnNetwork, type SessionView } from "../lib/timeline";
import { BlockedNetworkLine } from "./SidePanel";
import { Turn } from "./Blocks";
import { ItemNetwork } from "./ItemNetwork";
import { InteractiveProvider, type Interactive, type QuestionFlow } from "./Question";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const at = Date.UTC(2026, 10, 23, 16, 0);
const entry = (patch: Partial<BlockedHost>): BlockedHost => ({
	host: "example.com",
	port: 443,
	reason: "unlisted",
	allow: "repository",
	firstAt: at,
	lastAt: at,
	count: 1,
	...patch,
});
const repository = entry({ host: "registry.yarnpkg.com", port: null, count: 6 });
const machine = entry({
	host: "api.segment.io",
	port: 443,
	reason: "machine_policy",
	allow: "machine",
	machineNames: ["studio-mac"],
	count: 4,
});
const metadata = entry({ host: "169.254.169.254", port: 80, reason: "private", allow: "never", count: 2 });
const lan = entry({ host: "10.0.3.7", port: 5432, reason: "private", allow: "never" });
const provider = entry({ host: "smtp.mailgun.org", port: 25, reason: "provider", allow: "never" });
const operator = entry({ host: "fonts.gstatic.com", port: null, allow: "deployment" });

const row = (seq: number, revision: number, network: BlockedNetwork, turn = 1): NetworkBlockedItem => ({
	seq,
	at,
	turn,
	kind: "network.blocked",
	revision,
	...network,
});
const user: TimelineItem = { seq: 1, at, turn: 1, kind: "user", text: "Install it", model: "m", effort: null };
const hostLine = (seq: number, name: string): TimelineItem => ({
	seq,
	at,
	turn: 1,
	kind: "platform",
	level: "warn",
	text: `A command in this sandbox could not reach ${name}.`,
	code: "host_blocked",
	host: name,
	repository: true,
});
const fold = (items: TimelineItem[]): SessionView => items.reduce(applyItem, emptyView());

const flow = { question: null } as unknown as QuestionFlow;
function interactive(
	allowHost: Interactive["allowHost"] = vi.fn(
		async (): Promise<HostAllowed> => ({ network: {} as HostAllowed["network"], applied: true }),
	),
): Interactive {
	return { flow, stopCall: null, allowHost, repositoryId: 7101 };
}
const renderTurn = (view: SessionView, value: Interactive = interactive()) =>
	act(() =>
		root.render(createElement(InteractiveProvider, { value, children: createElement(Turn, { turn: view.turns[0]! }) })),
	);
const buttons = () => [...host.querySelectorAll("button")];
const named = (text: string) => buttons().find(button => button.textContent?.includes(text));
const destinations = () => [...host.querySelectorAll(".blocked-dest")].map(node => node.textContent);

describe("the turn's network.blocked row", () => {
	it("is one block per turn, which a newer revision with the same seq replaces and an older one does not", () => {
		let view = fold([user, row(2, 1, { hosts: [repository], overflow: 0 })]);
		expect(turnNetwork(view.turns[0]!)).toMatchObject({ seq: 2, revision: 1, hosts: [{ count: 6 }] });
		view = applyItem(view, row(2, 3, { hosts: [{ ...repository, count: 9 }, machine], overflow: 2 }));
		const network = turnNetwork(view.turns[0]!)!;
		expect(network).toMatchObject({ seq: 2, revision: 3, overflow: 2 });
		expect(blockedRequests(network)).toBe(9 + 4 + 2);
		expect(view.turns[0]!.blocks.filter(block => block.kind === "network")).toHaveLength(1);
		expect(view.lastSeq).toBe(2);
		expect(view.gap).toBe(false);
		// An older or equal revision, as a late event, changes nothing.
		expect(applyItem(view, row(2, 2, { hosts: [], overflow: 0 }))).toBe(view);
		expect(applyItem(view, row(2, 3, { hosts: [], overflow: 0 }))).toBe(view);
	});

	it("leaves out a hosted platform line about a host it lists, and keeps one it does not", () => {
		const view = fold([
			user,
			hostLine(2, "registry.yarnpkg.com"),
			hostLine(3, "cdn.example.org"),
			row(4, 1, { hosts: [repository], overflow: 0 }),
		]);
		const shown = shownBlocks(view.turns[0]!.blocks);
		expect(
			shown.filter(block => block.kind === "platform").map(block => block.kind === "platform" && block.blocked?.host),
		).toEqual(["cdn.example.org"]);
		// A turn without the row (an older server's) keeps every line.
		const older = fold([user, hostLine(2, "registry.yarnpkg.com")]);
		expect(shownBlocks(older.turns[0]!.blocks)).toBe(older.turns[0]!.blocks);
		renderTurn(view);
		expect(host.querySelectorAll('button[aria-label="Allow registry.yarnpkg.com for this repository"]')).toHaveLength(
			1,
		);
		expect(host.querySelectorAll('button[aria-label="Allow cdn.example.org for this repository"]')).toHaveLength(1);
	});

	it("offers Allow for this repository on a repository host, names a hosted lookup without a port, and sends the host", async () => {
		const allowHost = vi.fn(
			async (): Promise<HostAllowed> => ({ network: {} as HostAllowed["network"], applied: true }),
		);
		renderTurn(fold([user, row(2, 1, { hosts: [repository], overflow: 0 })]), interactive(allowHost));
		expect(host.querySelector("section.blocked")?.id).toBe("network-2");
		expect(host.querySelector(".system-text")?.textContent).toBe(
			"Blocked network requests: 6 requests to 1 destination",
		);
		expect(destinations()).toEqual(["registry.yarnpkg.com"]);
		await act(async () => named("Allow for this repository")!.click());
		expect(allowHost).toHaveBeenCalledWith("registry.yarnpkg.com");
		expect(host.textContent).toContain("registry.yarnpkg.com is allowed. This sandbox reaches it now.");
		expect(host.querySelector('a[href*="network"]')?.textContent).toBe("Network list");
	});

	it("says a machine's settings refused a host, with the --egress-domains hint folded", () => {
		renderTurn(fold([user, row(2, 1, { hosts: [machine], overflow: 0 })]));
		expect(destinations()).toEqual(["api.segment.io:443"]);
		expect(host.textContent).toContain("Blocked by machine studio-mac's settings");
		expect(named("Allow")).toBeUndefined();
		const toggle = named("How to allow")!;
		const hint = document.getElementById(toggle.getAttribute("aria-controls")!)!;
		expect(hint.hidden).toBe(true);
		expect(hint.textContent).toBe(
			"Its owner adds api.segment.io to --egress-domains when starting the runner on studio-mac.",
		);
		act(() => toggle.click());
		expect(hint.hidden).toBe(false);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
	});

	it("gives a quiet reason for what can never be allowed here, and says who can for the deployment's", () => {
		renderTurn(fold([user, row(2, 1, { hosts: [metadata, lan, provider], overflow: 0 })]));
		const why = [...host.querySelectorAll(".blocked-why")].map(node => node.textContent);
		expect(why).toEqual(["cloud metadata", "private address", "provider policy"]);
		expect(named("Allow")).toBeUndefined();
		expect(host.querySelector('a[href*="network"]')).toBeNull();
		renderTurn(
			fold([
				user,
				row(2, 1, {
					hosts: [operator, entry({ host: null, port: null, reason: "malformed", allow: "never" })],
					overflow: 0,
				}),
			]),
		);
		expect([...host.querySelectorAll(".blocked-why")].map(node => node.textContent)).toEqual([
			"only the deployment's operator can allow it",
			"could not be read",
		]);
		expect(destinations()).toEqual(["fonts.gstatic.com", "malformed destination"]);
	});

	it("folds after three destinations, those that can be allowed first, and counts the ones past the kept 50", () => {
		renderTurn(
			fold([user, row(2, 1, { hosts: [metadata, lan, provider, machine, repository, operator], overflow: 17 })]),
		);
		expect(destinations()).toEqual(["registry.yarnpkg.com", "api.segment.io:443", "fonts.gstatic.com"]);
		const more = named("Show 3 more")!;
		expect(more.getAttribute("aria-expanded")).toBe("false");
		act(() => more.click());
		expect(destinations()).toHaveLength(6);
		expect(host.querySelector(".system-text")?.textContent).toBe(
			"Blocked network requests: 32 requests to 6 destinations and others",
		);
		expect(host.querySelector(".blocked-overflow")?.textContent).toBe(
			"17 more requests to destinations past the first 50 kept are counted, not listed.",
		);
	});

	it("draws a newer revision in place, live", () => {
		let view = fold([user, row(2, 1, { hosts: [repository], overflow: 0 })]);
		renderTurn(view);
		expect(host.querySelectorAll("section.blocked")).toHaveLength(1);
		view = applyItem(view, row(2, 2, { hosts: [{ ...repository, count: 8 }, machine], overflow: 0 }));
		renderTurn(view);
		expect(host.querySelectorAll("section.blocked")).toHaveLength(1);
		expect(destinations()).toEqual(["registry.yarnpkg.com", "api.segment.io:443"]);
		expect(host.querySelector(".system-text")?.textContent).toBe(
			"Blocked network requests: 12 requests to 2 destinations",
		);
	});
});

describe("the side panel's line", () => {
	it("counts the current turn's blocked requests and leads to its row; nothing without one", () => {
		const second: TimelineItem = { ...user, seq: 3, turn: 2 };
		act(() =>
			root.render(
				createElement(BlockedNetworkLine, {
					view: fold([
						user,
						row(2, 1, { hosts: [repository], overflow: 0 }),
						second,
						row(4, 1, { hosts: [machine], overflow: 1 }, 2),
					]),
				}),
			),
		);
		expect(host.textContent).toBe("5 blocked network requests in turn 2Show");
		expect(host.querySelector("a")?.getAttribute("href")).toBe("#network-4");
		act(() =>
			root.render(
				createElement(BlockedNetworkLine, {
					view: fold([user, row(2, 1, { hosts: [repository], overflow: 0 }), second]),
				}),
			),
		);
		expect(host.textContent).toBe("");
	});
});

describe("the item's Network block", () => {
	const now = at + 50 * 60_000;
	const network: BlockedNetwork = { hosts: [metadata, repository, machine, provider, operator], overflow: 5 };

	it("is not drawn when nothing was blocked, or by a server that does not say", () => {
		act(() => root.render(createElement(ItemNetwork, { network: undefined, context: null, now })));
		expect(host.innerHTML).toBe("");
		act(() => root.render(createElement(ItemNetwork, { network: { hosts: [], overflow: 0 }, context: null, now })));
		expect(host.innerHTML).toBe("");
	});

	it("rolls up the counts, the top destinations and the actions allowed", async () => {
		const allow = vi.fn(async (): Promise<HostAllowed> => ({ network: {} as HostAllowed["network"], applied: false }));
		act(() => root.render(createElement(ItemNetwork, { network, context: { allow, repositoryId: 7101 }, now })));
		expect(host.querySelector("h2")?.textContent).toBe("Network");
		expect(host.querySelector(".usage-lede")?.textContent).toContain(
			"Blocked: 19 requests to 5 destinations and others",
		);
		expect(destinations()).toEqual(["registry.yarnpkg.com", "api.segment.io:443", "fonts.gstatic.com"]);
		expect(named("Show 2 more")).toBeDefined();
		expect(host.querySelector(".blocked-facts time")?.textContent).toBe("50m ago");
		await act(async () => named("Allow for this repository")!.click());
		expect(allow).toHaveBeenCalledWith("registry.yarnpkg.com");
		expect(host.textContent).toContain("registry.yarnpkg.com is allowed. It applies from the next turn.");
	});

	it("offers no button where no repository can be named for a host", () => {
		act(() => root.render(createElement(ItemNetwork, { network, context: null, now })));
		expect(named("Allow")).toBeUndefined();
		expect(host.textContent).toContain("the repository's network list can allow it");
		expect(host.textContent).toContain("Allow a host in the network settings of the repository that needs it.");
	});
});
