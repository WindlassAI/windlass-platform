// @vitest-environment jsdom
/** What is kept in the tab across the visit to GitHub, for the start composer's way back. */
import { beforeEach, describe, expect, it } from "vitest";
import { takeLaunchDraft } from "./github";

const DRAFT_KEY = "wlp.new-agent.draft";

beforeEach(() => sessionStorage.clear());

describe("the start composer's draft across the visit to GitHub", () => {
	it("gives back the task and every choice made, the place, the agent and the mode included, once", () => {
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: "Add a health check", repoUrl: "", profile: "docker-hardened", model: "gpt-6-luna", effort: "low", place: "m_nas", harness: "claude", mode: "plan" }));
		expect(takeLaunchDraft()).toEqual({ prompt: "Add a health check", repoUrl: "", profile: "docker-hardened", model: "gpt-6-luna", effort: "low", place: "m_nas", harness: "claude", mode: "plan", kind: null, criteria: "" });
		expect(takeLaunchDraft()).toBeNull();
	});

	it("reads a choice not made as none, and what is not a string as nothing", () => {
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: 7, place: "", harness: null, mode: ["ask"] }));
		expect(takeLaunchDraft()).toEqual({ prompt: "", repoUrl: "", profile: null, model: "", effort: "", place: null, harness: null, mode: null, kind: null, criteria: "" });
	});

	it("gives back a work item being filed: the switch on Work item, and its acceptance criteria", () => {
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: "Add a health check", kind: "item", itemMode: "single", criteria: "It answers 200." }));
		expect(takeLaunchDraft()).toMatchObject({ prompt: "Add a health check", kind: "item", itemMode: "single", criteria: "It answers 200." });
		sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ kind: "form" }));
		expect(takeLaunchDraft()?.kind).toBeNull();
	});
});
