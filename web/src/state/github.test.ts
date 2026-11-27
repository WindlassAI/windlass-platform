// @vitest-environment jsdom
/** What is kept in the tab across the visit to GitHub, for the start composer's way back. */
import { beforeEach, describe, expect, it } from "vitest";
import { githubMessageHash, relayGithubReturn, takeLaunchDraft } from "./github";

const DRAFT_KEY = "wlp.new-agent.draft";

beforeEach(() => sessionStorage.clear());

describe("the start composer's draft across the visit to GitHub", () => {
	it("gives back the task and every choice made, the place, the agent and the mode included, once", () => {
		sessionStorage.setItem(
			DRAFT_KEY,
			JSON.stringify({
				prompt: "Add a health check",
				repoUrl: "",
				profile: "docker-hardened",
				model: "gpt-6-luna",
				effort: "low",
				place: "m_nas",
				harness: "claude",
				mode: "plan",
			}),
		);
		expect(takeLaunchDraft()).toEqual({
			prompt: "Add a health check",
			repoUrl: "",
			profile: "docker-hardened",
			model: "gpt-6-luna",
			effort: "low",
			place: "m_nas",
			harness: "claude",
			mode: "plan",
			kind: null,
			criteria: "",
		});
		expect(takeLaunchDraft()).toBeNull();
	});

	it("reads a choice not made as none, and what is not a string as nothing", () => {
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: 7, place: "", harness: null, mode: ["ask"] }));
		expect(takeLaunchDraft()).toEqual({
			prompt: "",
			repoUrl: "",
			profile: null,
			model: "",
			effort: "",
			place: null,
			harness: null,
			mode: null,
			kind: null,
			criteria: "",
		});
	});

	it("gives back a work item being filed: the switch on Work item, and its acceptance criteria", () => {
		sessionStorage.setItem(
			DRAFT_KEY,
			JSON.stringify({ prompt: "Add a health check", kind: "item", itemMode: "single", criteria: "It answers 200." }),
		);
		expect(takeLaunchDraft()).toMatchObject({
			prompt: "Add a health check",
			kind: "item",
			itemMode: "single",
			criteria: "It answers 200.",
		});
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ kind: "form" }));
		expect(takeLaunchDraft()?.kind).toBeNull();
	});
});

describe("the popup that connects GitHub", () => {
	/** A real window of this origin (an iframe's), with `opener` as given. */
	function windowWith(opener: unknown): Window {
		const frame = document.createElement("iframe");
		document.body.append(frame);
		const made = frame.contentWindow as Window;
		Object.defineProperty(made, "opener", { value: opener, configurable: true });
		return made;
	}
	const message = (patch: Partial<Pick<MessageEvent, "origin" | "source" | "data">> = {}) => ({
		origin: location.origin,
		source: windowWith(window),
		data: { type: "wlp.github.return", hash: "#github=t.1" },
		...patch,
	});

	it("takes the fragment only from this origin, from a window this page opened, of that shape", () => {
		expect(githubMessageHash(message())).toBe("#github=t.1");
		expect(githubMessageHash(message({ data: { type: "wlp.github.return", hash: "#github-error=denied" } }))).toBe(
			"#github-error=denied",
		);
		// Another origin, a window someone else opened, none at all, or another shape: ignored.
		expect(githubMessageHash(message({ origin: "https://evil.example" }))).toBeNull();
		expect(githubMessageHash(message({ source: windowWith(null) }))).toBeNull();
		expect(githubMessageHash(message({ source: null }))).toBeNull();
		expect(githubMessageHash(message({ data: { type: "other", hash: "#github=t.1" } }))).toBeNull();
		expect(githubMessageHash(message({ data: { type: "wlp.github.return", hash: "#something-else" } }))).toBeNull();
		expect(githubMessageHash(message({ data: "#github=t.1" }))).toBeNull();
	});

	it("in the popup, hands the fragment to its opener at this origin only, takes it out of the address and closes", () => {
		const posted: Array<[unknown, string]> = [];
		const opener = {
			location: { origin: location.origin },
			postMessage: (data: unknown, origin: string) => posted.push([data, origin]),
		};
		let closed = false;
		const replaced: string[] = [];
		const self = {
			location: { hash: "#github=t.2", origin: location.origin, pathname: "/", search: "" },
			opener,
			history: { replaceState: (_: unknown, __: string, url: string) => replaced.push(url) },
			close: () => (closed = true),
		} as unknown as Window;
		expect(relayGithubReturn(self)).toBe(true);
		expect(posted).toEqual([[{ type: "wlp.github.return", hash: "#github=t.2" }, location.origin]]);
		expect(replaced).toEqual(["/"]);
		expect(closed).toBe(true);
	});

	it("does nothing without a return in the address, or without an opener of this origin: the page finishes it itself", () => {
		const posted: unknown[] = [];
		const page = (hash: string, opener: unknown) =>
			({
				location: { hash, origin: location.origin, pathname: "/", search: "" },
				opener,
				history: { replaceState: () => undefined },
				close: () => undefined,
			}) as unknown as Window;
		const ours = { location: { origin: location.origin }, postMessage: (data: unknown) => posted.push(data) };
		const theirs = {
			get location(): never {
				throw new DOMException("Blocked a frame with another origin", "SecurityError");
			},
			postMessage: (data: unknown) => posted.push(data),
		};
		expect(relayGithubReturn(page("", ours))).toBe(false);
		expect(relayGithubReturn(page("#github=t.3", null))).toBe(false);
		expect(relayGithubReturn(page("#github=t.3", theirs))).toBe(false);
		expect(posted).toEqual([]);
	});
});
